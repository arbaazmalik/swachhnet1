const router = require('express').Router();
const multer = require('multer');
const Hotspot = require('../models/Hotspot');
const Complaint = require('../models/Complaint');
const mongoose = require('mongoose');
const { authenticate, authorize } = require('../middleware/auth');
const aiService = require('../services/aiService');
const { createNotification } = require('../services/notificationService');
const { findBestWorker } = require('../services/workforceService');
const User = require('../models/User');
const { resolveWardScope } = require('../utils/wardScope');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/jpg', 'image/bmp']);

function sendSuccess(res, data, message = 'OK', status = 200) {
  return res.status(status).json({ success: true, data, message });
}

function sendFail(res, status, message) {
  return res.status(status).json({ success: false, data: null, message });
}

function buildHotspotDeleteFilter(wardId, days) {
  return wardId ? { wardId, periodDays: days } : { periodDays: days };
}

function parseDays(daysRaw, fallback = 7) {
  const parsed = Number(daysRaw);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(90, Math.round(parsed));
}

function normalizeHotspotDoc(h) {
  const lat = h?.centroid?.coordinates?.[1] ?? null;
  const lng = h?.centroid?.coordinates?.[0] ?? null;
  return {
    id: String(h._id),
    ward_id: h.wardId?._id ? String(h.wardId._id) : (h.wardId ? String(h.wardId) : null),
    ward_name: h.wardId?.name || null,
    city: h.wardId?.city || null,
    centroid_lat: lat,
    centroid_lng: lng,
    complaint_count: Number(h.complaintCount || 0),
    severity_score: Number(h.severityScore || 0),
    level: h.level || 'low',
    trend: h.trend || 'stable',
    dominant_type: h.dominantType || 'other',
    peak_time: h.peakTime || 'Unknown',
    predicted_count: Number(h.predictedCount || 0),
    recommended_action: h.recommendedAction || 'Monitor area',
    period_days: Number(h.periodDays || 7),
    createdAt: h.createdAt,
  };
}

function computeSeverityScore(count, avgPriority) {
  const raw = (count / 4) + (avgPriority * 0.55);
  return Math.max(0.5, Math.min(3, Number(raw.toFixed(2))));
}

function getLevel(score) {
  if (score >= 2.5) return 'critical';
  if (score >= 2.0) return 'high';
  if (score >= 1.2) return 'medium';
  return 'low';
}

function analyzePeakTime(points) {
  const hours = points.map(p => new Date(p.createdAt).getHours());
  if (!hours.length) return 'Unknown';
  const counts = {};
  hours.forEach(h => counts[h] = (counts[h] || 0) + 1);
  const peakIdx = Object.entries(counts).sort((a,b) => b[1] - a[1])[0][0];
  const h = parseInt(peakIdx);
  if (h >= 5 && h < 12) return 'Morning (5AM - 12PM)';
  if (h >= 12 && h < 17) return 'Afternoon (12PM - 5PM)';
  if (h >= 17 && h < 22) return 'Evening (5PM - 10PM)';
  return 'Night (10PM - 5AM)';
}

function dominantIssueType(points = []) {
  const counts = {};
  for (const p of points) {
    const key = (p?.issue_type || p?.issueType || 'other').toString();
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'other';
}

function dominantWardId(points = []) {
  const counts = {};
  for (const p of points) {
    const wid = p?.ward_id || (p?.wardId?._id ? String(p.wardId._id) : (p?.wardId ? String(p.wardId) : null));
    if (!wid) continue;
    counts[wid] = (counts[wid] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

// Using centralized resolveWardScope helper from ../utils/wardScope

async function generateHotspotsFromComplaints({ wardId, days, persist = true }) {
  const since = new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000);
  const filter = {
    createdAt: { $gte: since },
    status: { $in: ['pending', 'assigned', 'in_progress'] },
    'location.coordinates': { $exists: true },
  };
  if (wardId) filter.wardId = wardId;

  const complaints = await Complaint.find(filter)
    .select('wardId location issueType priority')
    .lean();

  if (!complaints.length) {
    if (persist) {
      await Hotspot.deleteMany(buildHotspotDeleteFilter(wardId, days));
    }
    return [];
  }

  const coordinates = complaints
    .filter(c => Array.isArray(c.location?.coordinates) && c.location.coordinates.length === 2)
    .map(c => ({
      lat: c.location.coordinates[1],
      long: c.location.coordinates[0],
      issue_type: c.issueType || 'other',
      priority: Number(c.priority || 1),
      ward_id: c.wardId ? String(c.wardId) : null,
    }));

  if (!coordinates.length) {
    if (persist) {
      await Hotspot.deleteMany(buildHotspotDeleteFilter(wardId, days));
    }
    return [];
  }

  const detection = await aiService.detectHotspots(coordinates);
  const clusters = Array.isArray(detection?.clusters) ? detection.clusters : [];

  // Fetch previous hotspots for trend detection
  const prevFilter = buildHotspotDeleteFilter(wardId, days);
  const rawPrev = await Hotspot.find(prevFilter);
  const prevHotspots = (rawPrev && typeof rawPrev.lean === 'function') ? await rawPrev.lean() : (Array.isArray(rawPrev) ? rawPrev : []);

  const docs = await Promise.all(clusters.map(async (cluster) => {
    const points = Array.isArray(cluster.points) ? cluster.points : [];
    // The points from aiService might not have createdAt, so we map them back to complaints if needed
    // But for now we'll use the original complaints that formed this cluster
    const clusterCentroid = [Number(cluster.center?.long || 0), Number(cluster.center?.lat || 0)];
    
    // Find complaints belonging to this cluster (rough approximation for temporal analysis)
    const clusterComplaints = complaints.filter(c => {
      const dist = Math.sqrt(Math.pow(c.location.coordinates[0] - clusterCentroid[0], 2) + Math.pow(c.location.coordinates[1] - clusterCentroid[1], 2));
      return dist < 0.005; // ~500m radius
    });

    const count = Number(cluster.count || clusterComplaints.length || 0);
    const avgPriority = clusterComplaints.length
      ? clusterComplaints.reduce((s, p) => s + Number(p.priority || 1), 0) / clusterComplaints.length
      : 1;
    const clusterWardId = wardId || dominantWardId(clusterComplaints);
    const score = computeSeverityScore(count, avgPriority);
    const level = getLevel(score);

    // Trend Detection
    let trend = 'stable';
    const nearestPrev = prevHotspots.find(h => {
      const d = Math.sqrt(Math.pow(h.centroid.coordinates[0] - clusterCentroid[0], 2) + Math.pow(h.centroid.coordinates[1] - clusterCentroid[1], 2));
      return d < 0.002; // Close match
    });
    if (nearestPrev) {
      if (count > nearestPrev.complaintCount * 1.2) trend = 'increasing';
      else if (count < nearestPrev.complaintCount * 0.8) trend = 'decreasing';
    } else if (count >= 3) {
      trend = 'increasing'; // New emerging hotspot
    }

    // Workforce Recommendation
    let recommendedAction = 'Monitor area';
    if (level === 'critical' || level === 'high') {
      const bestWorker = await findBestWorker({ location: { type: 'Point', coordinates: clusterCentroid }, wardId: clusterWardId });
      if (bestWorker) recommendedAction = `Deploy ${bestWorker.name} (${bestWorker.role}) immediately`;
      else recommendedAction = 'Urgent: Dispatch emergency cleaning crew';
    }

    const doc = {
      wardId: clusterWardId || undefined,
      centroid: { type: 'Point', coordinates: clusterCentroid },
      complaintCount: count,
      severityScore: score,
      level,
      trend,
      dominantType: dominantIssueType(clusterComplaints),
      peakTime: analyzePeakTime(clusterComplaints),
      predictedCount: Math.round(count * (trend === 'increasing' ? 1.3 : trend === 'decreasing' ? 0.7 : 1.0)),
      recommendedAction,
      periodDays: days,
    };

    // Automated Alerting
    if (level === 'critical' && persist) {
      const authorities = await User.find({
        role: { $in: ['authority', 'admin'] },
        $or: [{ wardId: clusterWardId }, { wardId: { $exists: false } }],
      }).select('_id').lean();
      
      await Promise.all(authorities.map(a => 
        createNotification(a._id, '🚨 Critical Hotspot Detected', `Waste accumulation hotspot identified at ${clusterCentroid[1].toFixed(4)}, ${clusterCentroid[0].toFixed(4)}. Action: ${recommendedAction}`, 'complaint_update', { centroid: clusterCentroid })
      ));
    }

    return doc;
  }));

  const filteredDocs = docs.filter(d => Number.isFinite(d.centroid.coordinates[0]) && Number.isFinite(d.centroid.coordinates[1]));

  if (!filteredDocs.length) {
    if (persist) {
      await Hotspot.deleteMany(buildHotspotDeleteFilter(wardId, days));
    }
    return [];
  }

  if (persist) {
    await Hotspot.deleteMany(buildHotspotDeleteFilter(wardId, days));
    await Hotspot.insertMany(filteredDocs);
  }

  return filteredDocs;
}

function extractUploadedFile(req) {
  if (req.file) return req.file;
  if (Array.isArray(req.files) && req.files.length > 0) return req.files[0];
  return null;
}

function uploadImage(req, res, next) {
  return upload.any()(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return sendFail(res, 400, 'Image size exceeds 5MB');
      return sendFail(res, 400, err.message);
    }
    return next(err);
  });
}

function mapToLegacyClassification(payload) {
  return {
    label: payload.class,
    confidence: payload.confidence,
    reliable: payload.is_confident,
    all_scores: payload.probabilities,
    model_version: payload.model_version || 'aiml-v1',
  };
}

async function predictWasteHandler(req, res, next) {
  try {
    const file = extractUploadedFile(req);
    if (!file) return sendFail(res, 400, 'Image required');
    if (!ALLOWED_IMAGE_MIME.has(file.mimetype)) {
      return sendFail(res, 400, `Unsupported file type: ${file.mimetype}`);
    }
    const result = await aiService.predictWaste(file.buffer, file.mimetype, file.originalname);
    return sendSuccess(res, result, 'Waste prediction completed');
  } catch (err) {
    if (err.code === 'ECONNREFUSED') return sendFail(res, 503, 'AIML service unavailable');
    return next(err);
  }
}

async function detectHotspotHandler(req, res, next) {
  try {
    const { coordinates } = req.body;
    if (!Array.isArray(coordinates) || coordinates.length === 0) {
      return sendFail(res, 400, 'Array of coordinates required');
    }

    const result = await aiService.detectHotspots(coordinates);
    return sendSuccess(res, result, 'Hotspot detection completed');
  } catch (err) {
    if (err.code === 'ECONNREFUSED') return sendFail(res, 503, 'AIML service unavailable');
    return next(err);
  }
}

async function predictTrendHandler(req, res, next) {
  try {
    const { historical_data, forecast_days } = req.body;
    if (!Array.isArray(historical_data) || historical_data.length === 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INSUFFICIENT_DATA',
          message: 'Array of historical_data required and must not be empty.',
        }
      });
    }

    const result = await aiService.predictTrend(historical_data, forecast_days);
    return sendSuccess(res, result, 'Trend prediction completed');
  } catch (err) {
    if (err.code === 'ECONNREFUSED') return sendFail(res, 503, 'AIML service unavailable');
    if (err.response && (err.response.status === 400 || err.response.status === 422)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INSUFFICIENT_DATA',
          message: err.response.data?.detail || 'Not enough historical data for a reliable forecast.',
        }
      });
    }
    return next(err);
  }
}

// Legacy classify route used by citizen report flow (no auth required — UX helper only)
router.post('/classify', uploadImage, async (req, res, next) => {
  try {
    const file = extractUploadedFile(req);
    if (!file) return sendFail(res, 400, 'Image required');
    if (!ALLOWED_IMAGE_MIME.has(file.mimetype)) {
      return sendFail(res, 400, `Unsupported file type: ${file.mimetype}`);
    }
    const prediction = await aiService.predictWaste(file.buffer, file.mimetype, file.originalname);
    return sendSuccess(res, { result: mapToLegacyClassification(prediction) }, 'Classification completed');
  } catch (err) {
    if (err.code === 'ECONNREFUSED') return sendFail(res, 503, 'AIML service unavailable');
    return next(err);
  }
});

// Required AI endpoints
router.post('/predict-waste', uploadImage, predictWasteHandler);
router.post('/detect-hotspot', detectHotspotHandler);
router.post('/predict-trend', predictTrendHandler);

// Compatibility aliases
router.post('/v2/predict-waste', uploadImage, predictWasteHandler);
router.post('/v2/detect-hotspot', detectHotspotHandler);
router.post('/v2/predict-trend', predictTrendHandler);

// Existing data-backed analytics endpoints
router.get('/hotspots', authenticate, authorize('authority', 'admin'), async (req, res, next) => {
  try {
    const days = parseDays(req.query.days, 7);
    const refresh = String(req.query.refresh || '').toLowerCase() === 'true';
    const requestedWardId = req.query.ward_id;
    const scope = resolveWardScope(req, requestedWardId);
    if (scope.error) {
      return sendFail(res, scope.error.status, scope.error.message);
    }
    const wardId = scope.wardId;

    let hotspotsDocs = await Hotspot.find({
      ...(wardId ? { wardId } : {}),
      periodDays: days,
    })
      .populate('wardId', 'name city')
      .sort({ severityScore: -1 })
      .limit(50)
      .lean();

    if (refresh || hotspotsDocs.length === 0) {
      await generateHotspotsFromComplaints({ wardId, days, persist: true });
      hotspotsDocs = await Hotspot.find({
        ...(wardId ? { wardId } : {}),
        periodDays: days,
      })
        .populate('wardId', 'name city')
        .sort({ severityScore: -1 })
        .limit(50)
        .lean();
    }

    const hotspots = hotspotsDocs.map(normalizeHotspotDoc);
    return sendSuccess(res, { hotspots, days }, 'Hotspots fetched');
  } catch (err) {
    return next(err);
  }
});

router.post('/hotspots/refresh', authenticate, authorize('authority', 'admin'), async (req, res, next) => {
  try {
    const days = parseDays(req.body?.days, 7);
    const requestedWardId = req.body?.ward_id;
    const scope = resolveWardScope(req, requestedWardId);
    if (scope.error) {
      return sendFail(res, scope.error.status, scope.error.message);
    }
    const wardId = scope.wardId;

    await generateHotspotsFromComplaints({ wardId, days, persist: true });
    const hotspotsDocs = await Hotspot.find({
      ...(wardId ? { wardId } : {}),
      periodDays: days,
    })
      .populate('wardId', 'name city')
      .sort({ severityScore: -1 })
      .limit(50)
      .lean();

    const hotspots = hotspotsDocs.map(normalizeHotspotDoc);
    return sendSuccess(res, { hotspots, days }, 'Hotspots refreshed');
  } catch (err) {
    return next(err);
  }
});



router.get('/heatmap', authenticate, async (req, res, next) => {
  try {
    const { ward_id, days = 30 } = req.query;
    const since = new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000);
    const filter = { createdAt: { $gte: since }, 'location.coordinates': { $exists: true } };
    if (ward_id) filter.wardId = ward_id;

    const complaints = await Complaint.find(filter).select('location priority issueType').lean();
    const points = complaints.map(c => ({
      lat: c.location.coordinates[1],
      lng: c.location.coordinates[0],
      weight: c.priority,
      issue_type: c.issueType,
    }));

    return sendSuccess(res, { points }, 'Heatmap data fetched');
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
