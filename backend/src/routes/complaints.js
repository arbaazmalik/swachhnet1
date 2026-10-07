const router  = require('express').Router();
const multer  = require('multer');
const { v4: uuidv4 } = require('uuid');
const axios   = require('axios');
const fs = require('fs');
const path = require('path');
const { ImageKit } = require('@imagekit/nodejs');
const mongoose = require('mongoose');

const Complaint    = require('../models/Complaint');
const Worker       = require('../models/Worker');
const Ward         = require('../models/Ward');
const { authenticate, authorize } = require('../middleware/auth');
const { awardPoints }             = require('../services/gamificationService');
const { notifyAuthorities }       = require('../services/notificationService');
const { notifyCitizen }           = require('../services/notificationService');
const { queueAIClassification }   = require('../jobs/aiQueue');
const logger = require('../utils/logger');
const { ok, fail } = require('../utils/response');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const imagekit = (process.env.IMAGEKIT_PUBLIC_KEY && process.env.IMAGEKIT_PRIVATE_KEY && process.env.IMAGEKIT_URL_ENDPOINT)
  ? new ImageKit({
      publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
      privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
      urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT,
    })
  : null;

const PRIORITY_MAP = {
  burning_waste: 3, illegal_dumping: 3,
  full_dustbin: 2, overflowing_bin: 2,
  missed_collection: 1, stray_animal_waste: 1, other: 1,
};

const SORT_MAP = {
  newest: { createdAt: -1, priority: -1 },
  oldest: { createdAt: 1, priority: 1 },
  priority_high: { priority: -1, createdAt: -1 },
  priority_low: { priority: 1, createdAt: -1 },
};

const {
  emitComplaintCreated,
  emitComplaintStatusChanged,
  emitComplaintAssigned,
  emitComplaintUpdated,
} = require('../services/socketService');

function resolveWardScope(req, requestedWardId) {
  if (requestedWardId && !mongoose.isValidObjectId(requestedWardId)) {
    return { error: { status: 400, message: 'Invalid ward_id' } };
  }

  if (req.user.role === 'authority') {
    const ownWardId = req.user.wardId ? String(req.user.wardId) : null;
    if (!ownWardId) {
      return { error: { status: 403, message: 'Authority account is not assigned to any ward.' } };
    }
    if (requestedWardId && String(requestedWardId) !== ownWardId) {
      return { error: { status: 403, message: 'Authority users can only access their assigned ward.' } };
    }
    return { wardId: ownWardId };
  }

  if (req.user.role === 'admin') {
    return { wardId: requestedWardId || undefined };
  }

  return { wardId: undefined };
}

async function uploadToStorage(buffer, mimetype) {
  const uploadsDir = path.resolve(__dirname, '../../uploads/complaints');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const filename = `${uuidv4()}.jpg`;
  const outPath = path.join(uploadsDir, filename);

  if (imagekit) {
    try {
      const uploadRes = await imagekit.upload({
        file: buffer.toString('base64'),
        fileName: filename,
        folder: process.env.IMAGEKIT_FOLDER || '/swachhanet/complaints',
        useUniqueFileName: false,
        tags: ['complaint-image'],
      });
      return uploadRes.url;
    } catch (err) {
      logger.warn(`ImageKit upload failed, falling back to local storage: ${err.message}`);
    }
  }

  fs.writeFileSync(outPath, buffer);
  return `/uploads/complaints/${filename}`;
}

async function reverseGeocode(lat, lng) {
  const latitude = Number(lat);
  const longitude = Number(lng);
  try {
    if (!process.env.GMAPS_API_KEY || process.env.GMAPS_API_KEY === 'your_google_maps_key') {
      return `Lat: ${latitude.toFixed(5)}, Lng: ${longitude.toFixed(5)}`;
    }
    const res = await axios.get(
      `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latitude},${longitude}&key=${process.env.GMAPS_API_KEY}`
    );
    return res.data.results[0]?.formatted_address || `Lat: ${latitude.toFixed(5)}, Lng: ${longitude.toFixed(5)}`;
  } catch { return `Lat: ${latitude.toFixed(5)}, Lng: ${longitude.toFixed(5)}`; }
}

// POST /complaints
router.post('/', authenticate, upload.single('image'), async (req, res, next) => {
  try {
    const { issue_type, lat, lng, description } = req.body;
    if (!issue_type || lat === undefined || lng === undefined) return fail(res, 400, 'issue_type, lat, lng required');
    if (Number.isNaN(Number(lat)) || Number.isNaN(Number(lng))) return fail(res, 400, 'lat/lng must be valid numbers');

    let imageUrl = null;
    if (req.file) imageUrl = await uploadToStorage(req.file.buffer, req.file.mimetype);

    const address  = await reverseGeocode(lat, lng);
    const priority = PRIORITY_MAP[issue_type] || 1;

    let wardId = req.user.wardId;

    // Auto-detect ward from coordinates if not in user profile
    if (!wardId) {
      const ward = await Ward.findOne({
        boundary: {
          $geoIntersects: {
            $geometry: { type: 'Point', coordinates: [parseFloat(lng), parseFloat(lat)] }
          }
        }
      }).select('_id').lean();
      if (ward) wardId = ward._id;
      else logger.warn(`Complaint [${issue_type}] at ${lat},${lng} is NOT within any recognized ward boundary.`);
    }

    const complaint = await Complaint.create({
      userId:    req.user._id,
      wardId,
      issueType: issue_type,
      priority,
      imageUrl,
      classificationStatus: imageUrl ? 'pending' : 'completed',
      location:  { type: 'Point', coordinates: [parseFloat(lng), parseFloat(lat)] },
      address,
      description: description || '',
    });

    if (imageUrl) {
      try {
        await queueAIClassification({ complaintId: complaint._id.toString(), imageUrl });
      } catch (err) {
        logger.warn(`AI queue unavailable for complaint ${complaint._id}: ${err.message}`);
      }
    }
    await awardPoints(req.user._id, 'complaint_submitted');
    if (priority >= 3) await notifyAuthorities(complaint);
    
    emitComplaintCreated(complaint);

    logger.info(`New complaint [${issue_type}] by ${req.user._id}`);
    return ok(res, { complaint }, 'Complaint submitted', 201);
  } catch (err) { next(err); }
});

// GET /complaints
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { status, issue_type, priority, start_date, end_date, page = 1, limit = 20, ward_id, sort = 'priority_high' } = req.query;
    const filter = {};

    if (!SORT_MAP[sort]) return fail(res, 400, 'Invalid sort option');

    if (req.user.role === 'citizen') filter.userId = req.user._id;
    else {
      const scope = resolveWardScope(req, ward_id);
      if (scope.error) return fail(res, scope.error.status, scope.error.message);
      if (scope.wardId) filter.wardId = scope.wardId;
    }

    if (status)     filter.status    = status;
    if (issue_type) filter.issueType = issue_type;
    if (priority)   filter.priority  = Number(priority);
    if (start_date || end_date) {
      filter.createdAt = {};
      if (start_date) filter.createdAt.$gte = new Date(start_date);
      if (end_date)   filter.createdAt.$lte = new Date(end_date);
    }

    const skip  = (page - 1) * limit;
    const [data, total] = await Promise.all([
      Complaint.find(filter)
        .populate('userId', 'name')
        .populate('wardId', 'name city')
        .sort(SORT_MAP[sort])
        .skip(skip).limit(Number(limit)).lean(),
      Complaint.countDocuments(filter),
    ]);

    const payload = {
      data,
      meta: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) },
    };
    return ok(res, payload, 'Complaints fetched');
  } catch (err) { next(err); }
});

// GET /complaints/:id
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 400, 'Invalid complaint id');

    const baseFilter = { _id: req.params.id };
    if (req.user.role === 'citizen') baseFilter.userId = req.user._id;
    if (req.user.role === 'authority' && req.user.wardId) baseFilter.wardId = req.user.wardId;

    const complaint = await Complaint.findOne(baseFilter)
      .populate('userId', 'name phone')
      .populate('wardId', 'name city')
      .populate('assignments.workerId', 'name phone')
      .lean();
    if (!complaint) return fail(res, 404, 'Complaint not found');
    return ok(res, complaint, 'Complaint fetched');
  } catch (err) { next(err); }
});

// PUT /complaints/:id/status
router.put('/:id/status', authenticate, authorize('authority', 'admin'), async (req, res, next) => {
  try {
    const { status, rejection_note } = req.body;
    const valid = ['pending','assigned','in_progress','resolved','rejected'];
    if (!valid.includes(status)) return fail(res, 400, 'Invalid status');
    if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 400, 'Invalid complaint id');

    const update = { status, rejectionNote: rejection_note || undefined };
    if (status === 'resolved') update.resolvedAt = new Date();

    const complaint = await Complaint.findOneAndUpdate(
      req.user.role === 'authority' && req.user.wardId
        ? { _id: req.params.id, wardId: req.user.wardId }
        : { _id: req.params.id },
      update,
      { new: true }
    );
    if (!complaint) return fail(res, 404, 'Complaint not found');
    await notifyCitizen(
      complaint.userId,
      `Complaint ${status.replace('_', ' ')}`,
      `Your complaint status is now "${status.replace('_', ' ')}".`,
      { complaintId: complaint._id, status }
    );
    emitComplaintStatusChanged(complaint);
    return ok(res, { complaint }, 'Complaint status updated');
  } catch (err) { next(err); }
});

// POST /complaints/:id/assign
router.post('/:id/assign', authenticate, authorize('authority', 'admin'), async (req, res, next) => {
  try {
    const { worker_id, notes } = req.body;
    if (!worker_id) return fail(res, 400, 'worker_id required');
    if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 400, 'Invalid complaint id');
    if (!mongoose.isValidObjectId(worker_id)) return fail(res, 400, 'Invalid worker_id');

    const worker = await Worker.findById(worker_id);
    if (!worker) return fail(res, 404, 'Worker not found');
    if (req.user.role === 'authority' && req.user.wardId && worker.wardId && String(worker.wardId) !== String(req.user.wardId)) {
      return fail(res, 403, 'Worker does not belong to your ward');
    }

    // Attach wardId to worker if missing
    if (req.user.wardId && !worker.wardId) {
      worker.wardId = req.user.wardId;
    }
    worker.status = 'busy';
    if (!worker.assignedTasks) worker.assignedTasks = [];
    if (!worker.assignedTasks.includes(req.params.id)) {
      worker.assignedTasks.push(req.params.id);
    }
    await worker.save();

    const complaint = await Complaint.findOneAndUpdate(
      req.user.role === 'authority' && req.user.wardId
        ? { _id: req.params.id, wardId: req.user.wardId }
        : { _id: req.params.id },
      {
        status: 'assigned',
        $push: {
          assignments: {
            workerId:   worker_id,
            assignedBy: req.user._id,
            notes:      notes || undefined,
          },
        },
      },
      { new: true }
    );
    if (!complaint) return fail(res, 404, 'Complaint not found');
    await notifyCitizen(
      complaint.userId,
      'Complaint assigned',
      'Your complaint has been assigned to a field worker.',
      { complaintId: complaint._id, workerId: worker_id }
    );
    emitComplaintAssigned(complaint, worker);
    return ok(res, { complaint, worker }, 'Worker assigned successfully', 201);
  } catch (err) { next(err); }
});

// POST /complaints/:id/upvote
router.post('/:id/upvote', authenticate, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 400, 'Invalid complaint id');
    const filter = { _id: req.params.id };
    if (req.user.role === 'citizen') filter.userId = req.user._id;
    const c = await Complaint.findOneAndUpdate(filter, { $inc: { upvotes: 1 } }, { new: true });
    if (!c) return fail(res, 404, 'Complaint not found');
    const payload = { id: c._id, upvotes: c.upvotes };
    return ok(res, payload, 'Upvoted');
  } catch (err) { next(err); }
});

module.exports = router;
