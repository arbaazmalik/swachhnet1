const router = require('express').Router();
const Worker = require('../models/Worker');
const Complaint = require('../models/Complaint');
const { authenticate, authorize } = require('../middleware/auth');
const { findBestWorker } = require('../services/workforceService');
const { ok, fail } = require('../utils/response');
const logger = require('../utils/logger');
const { resolveWardScope } = require('../utils/wardScope');
const { emitRealtimeEvent } = require('../services/socketService');

// POST /workforce - Add a new worker
router.post('/', authenticate, authorize('authority', 'admin'), async (req, res, next) => {
  try {
    const { name, phone, employeeId, zone, role, lat, lng, wardId } = req.body;
    
    if (!name || !role) return fail(res, 400, 'Name and role are required');

    const scope = resolveWardScope(req, wardId);
    if (scope.error) return fail(res, scope.error.status, scope.error.message);

    const worker = await Worker.create({
      name,
      phone,
      employeeId,
      zone,
      role,
      wardId: scope.wardId || wardId,
      currentLocation: {
        type: 'Point',
        coordinates: [parseFloat(lng) || 0, parseFloat(lat) || 0]
      },
      status: 'available'
    });

    return ok(res, { worker }, 'Worker added to workforce', 201);
  } catch (err) { next(err); }
});

// GET /workforce - List all workers with status
router.get('/', authenticate, authorize('authority', 'admin'), async (req, res, next) => {
  try {
    const { role, status, ward_id } = req.query;
    const filter = {};
    const scope = resolveWardScope(req, ward_id);
    if (scope.error) return fail(res, scope.error.status, scope.error.message);

    if (scope.wardId) filter.wardId = scope.wardId;
    if (role) filter.role = role;
    if (status) filter.status = status;

    const workers = await Worker.find(filter)
      .populate('wardId', 'name')
      .populate('assignedTasks', 'issueType status priority')
      .sort({ name: 1 })
      .lean();

    return ok(res, { workers }, 'Workforce fetched');
  } catch (err) { next(err); }
});

// PATCH /workforce/assign - Smart Auto-Assignment
router.patch('/assign', authenticate, authorize('authority', 'admin'), async (req, res, next) => {
  try {
    const { complaint_id } = req.body;
    if (!complaint_id) return fail(res, 400, 'complaint_id is required');

    const complaint = await Complaint.findById(complaint_id);
    if (!complaint) return fail(res, 404, 'Complaint not found');
    if (complaint.status !== 'pending') return fail(res, 400, 'Complaint is already assigned or resolved');

    if (req.user.role === 'authority') {
      if (!req.user.wardId) return fail(res, 403, 'Authority account is not assigned to a ward.');
      if (complaint.wardId && String(complaint.wardId) !== String(req.user.wardId)) {
        return fail(res, 403, 'Authority users can only access their assigned ward');
      }
    }

    const bestWorker = await findBestWorker(complaint);
    if (!bestWorker) {
      logger.info(`No available worker found for complaint ${complaint_id}`);
      return fail(res, 404, 'No available workers found nearby');
    }

    // Perform assignment
    await Promise.all([
      Complaint.findByIdAndUpdate(complaint_id, {
        status: 'assigned',
        $push: {
          assignments: {
            workerId: bestWorker._id,
            assignedBy: req.user._id,
            notes: 'Auto-assigned by Workforce Smart Logic'
          }
        }
      }),
      Worker.findByIdAndUpdate(bestWorker._id, {
        status: 'busy',
        $push: { assignedTasks: complaint_id },
        lastActiveAt: new Date()
      })
    ]);

    logger.info(`Complaint ${complaint_id} smart-assigned to worker ${bestWorker.name} (Dist: ${bestWorker.distance.toFixed(2)}km)`);
    
    emitRealtimeEvent({ event: 'complaint.assigned', data: { complaintId: complaint._id, workerId: bestWorker._id }, wardId: complaint.wardId, userId: complaint.userId });
    emitRealtimeEvent({ event: 'worker.status_changed', data: { workerId: bestWorker._id, status: 'busy' }, wardId: bestWorker.wardId });

    return ok(res, { worker: bestWorker }, `Smart assigned to ${bestWorker.name} (${bestWorker.distance.toFixed(2)}km away)`);
  } catch (err) { next(err); }
});

// PATCH /workforce/:id/location - Update worker location dynamically
router.patch('/:id/location', authenticate, async (req, res, next) => {
  try {
    const { lat, lng } = req.body;
    if (lat === undefined || lng === undefined) return fail(res, 400, 'lat and lng required');

    const worker = await Worker.findByIdAndUpdate(req.params.id, {
      currentLocation: { type: 'Point', coordinates: [parseFloat(lng), parseFloat(lat)] },
      lastActiveAt: new Date()
    }, { new: true });

    if (!worker) return fail(res, 404, 'Worker not found');

    emitRealtimeEvent({ event: 'worker.location_updated', data: { workerId: worker._id, location: worker.currentLocation }, wardId: worker.wardId });

    return ok(res, { worker }, 'Location updated');
  } catch (err) { next(err); }
});

module.exports = router;
