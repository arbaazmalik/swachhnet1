const router = require('express').Router();
const Worker = require('../models/Worker');
const { authenticate, authorize } = require('../middleware/auth');
const { ok, fail } = require('../utils/response');
const { resolveWardScope } = require('../utils/wardScope');
const { emitRealtimeEvent } = require('../services/socketService');


// GET /workers
router.get('/', authenticate, authorize('authority', 'admin'), async (req, res, next) => {
  try {
    const { status, ward_id } = req.query;
    const filter = {};
    const scope = resolveWardScope(req, ward_id);
    if (scope.error) return fail(res, scope.error.status, scope.error.message);
    if (scope.wardId) filter.wardId = scope.wardId;
    if (status)          filter.status  = status;

    const workers = await Worker.find(filter)
      .populate('wardId', 'name')
      .sort({ name: 1 })
      .lean();

    return ok(res, { workers }, 'Workers fetched');
  } catch (err) { next(err); }
});

// GET /workers/:id
router.get('/:id', authenticate, authorize('authority', 'admin'), async (req, res, next) => {
  try {
    const worker = await Worker.findById(req.params.id).populate('wardId', 'name city').lean();
    if (!worker) return fail(res, 404, 'Worker not found');
    return ok(res, worker, 'Worker fetched');
  } catch (err) { next(err); }
});

// PUT /workers/:id/status
router.put('/:id/status', authenticate, authorize('authority', 'admin', 'worker'), async (req, res, next) => {
  try {
    const { status, lat, lng } = req.body;
    const update = { status };
    if (lat && lng) update.currentLocation = { type: 'Point', coordinates: [parseFloat(lng), parseFloat(lat)] };

    const worker = await Worker.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!worker) return fail(res, 404, 'Worker not found');
    emitRealtimeEvent({ event: 'worker.status_changed', data: worker, wardId: worker.wardId });
    return ok(res, worker, 'Worker status updated');
  } catch (err) { next(err); }
});

// POST /workers/demo
router.post('/demo', authenticate, authorize('authority', 'admin'), async (req, res, next) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return fail(res, 403, 'Demo worker creation is disabled in production.');
    }
    const demoEmployeeId = 'DEMO-WORKER-001';
    const baseFilter = { employeeId: demoEmployeeId };
    const filter = req.user.wardId ? { ...baseFilter, wardId: req.user.wardId } : baseFilter;

    let worker = await Worker.findOne(filter);
    if (!worker) {
      worker = await Worker.create({
        name: 'Demo Worker',
        phone: '+919900000001',
        employeeId: demoEmployeeId,
        zone: 'Demo Zone',
        wardId: req.user.wardId || undefined,
        status: 'available',
      });
    } else if (worker.status !== 'available') {
      worker.status = 'available';
      await worker.save();
    }

    return ok(res, { worker }, 'Demo worker ready', 201);
  } catch (err) { next(err); }
});

module.exports = router;
