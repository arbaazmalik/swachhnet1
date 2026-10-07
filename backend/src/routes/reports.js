const router   = require('express').Router();
const Complaint = require('../models/Complaint');
const Worker    = require('../models/Worker');
const Gamification = require('../models/Gamification');
const { authenticate, authorize } = require('../middleware/auth');
const { ok } = require('../utils/response');
const { resolveWardScope } = require('../utils/wardScope');


// GET /reports/dashboard
router.get('/dashboard', authenticate, authorize('authority', 'admin'), async (req, res, next) => {
  try {
    const { period = 'today', ward_id } = req.query;
    const scope = resolveWardScope(req, ward_id);
    if (scope.error) {
      return res.status(scope.error.status).json({ success: false, data: null, message: scope.error.message });
    }
    const wardId = scope.wardId;
    const intervalMap = { today: 1, week: 7, month: 30 };
    const days = intervalMap[period] || 1;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const baseFilter = wardId ? { wardId } : {};

    const [allComplaints, trend, byType, byStatus] = await Promise.all([
      Complaint.find(baseFilter).lean(),

      // 7-day daily trend
      Complaint.aggregate([
        { $match: { ...baseFilter, createdAt: { $gte: new Date(Date.now() - 7*24*60*60*1000) } } },
        { $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          total:    { $sum: 1 },
          resolved: { $sum: { $cond: [{ $eq: ['$status','resolved'] }, 1, 0] } },
        }},
        { $sort: { _id: 1 } },
        { $project: { date: '$_id', total: 1, resolved: 1, _id: 0 } },
      ]),

      // By issue type
      Complaint.aggregate([
        { $match: baseFilter },
        { $group: {
          _id: '$issueType',
          count:    { $sum: 1 },
          resolved: { $sum: { $cond: [{ $eq: ['$status','resolved'] }, 1, 0] } },
        }},
        { $project: { issue_type: '$_id', count: 1, resolved: 1, _id: 0 } },
        { $sort: { count: -1 } },
      ]),

      // By status
      Complaint.aggregate([
        { $match: baseFilter },
        { $group: { _id: '$status', count: { $sum: 1 } } },
        { $project: { status: '$_id', count: 1, _id: 0 } },
      ]),
    ]);

    const total    = allComplaints.length;
    const resolved = allComplaints.filter(c => c.status === 'resolved');
    const resolvedToday = allComplaints.filter(c =>
      c.status === 'resolved' && new Date(c.resolvedAt) >= since
    ).length;

    const urgentOpen  = allComplaints.filter(c => c.status === 'pending' && c.priority === 3).length;
    const inProgress  = allComplaints.filter(c => c.status === 'in_progress').length;
    const newCount    = allComplaints.filter(c => new Date(c.createdAt) >= since).length;
    const resRate     = total > 0 ? Math.round((resolved.length / total) * 100 * 10) / 10 : 0;

    const resHours = resolved
      .filter(c => c.resolvedAt)
      .map(c => (new Date(c.resolvedAt) - new Date(c.createdAt)) / 3600000);
    const avgResHours = resHours.length > 0
      ? Math.round((resHours.reduce((a, b) => a + b, 0) / resHours.length) * 10) / 10
      : null;

    const payload = {
      summary: {
        urgent_open:       urgentOpen,
        in_progress:       inProgress,
        resolved_today:    resolvedToday,
        new_complaints:    newCount,
        resolution_rate:   resRate,
        avg_resolution_hours: avgResHours,
      },
      trend,
      by_type:   byType,
      by_status: byStatus,
    };
    return ok(res, payload, 'Dashboard report fetched');
  } catch (err) { next(err); }
});

// GET /reports/export — CSV
router.get('/export', authenticate, authorize('authority', 'admin'), async (req, res, next) => {
  try {
    const { start_date, end_date, ward_id } = req.query;
    const filter = {};
    const scope = resolveWardScope(req, ward_id);
    if (scope.error) {
      return res.status(scope.error.status).json({ success: false, data: null, message: scope.error.message });
    }
    if (scope.wardId) filter.wardId = scope.wardId;
    if (start_date || end_date) {
      filter.createdAt = {};
      if (start_date) filter.createdAt.$gte = new Date(start_date);
      if (end_date)   filter.createdAt.$lte = new Date(end_date);
    }

    const complaints = await Complaint.find(filter)
      .populate('userId', 'name phone')
      .populate('wardId', 'name city')
      .sort({ createdAt: -1 }).limit(10000).lean();

    const headers = ['id','issueType','status','priority','lat','lng','address','createdAt','resolvedAt','reporter','wardName','wasteType','confidence'];
    const rows = complaints.map(c => [
      c._id, c.issueType, c.status, c.priority,
      c.location?.coordinates?.[1], c.location?.coordinates?.[0],
      c.address, c.createdAt, c.resolvedAt,
      c.userId?.name, c.wardId?.name,
      c.aiResult?.wasteType, c.aiResult?.confidence,
    ].map(v => JSON.stringify(v ?? '')).join(','));

    const csv = [headers.join(','), ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=complaints_${Date.now()}.csv`);
    res.send(csv);
  } catch (err) { next(err); }
});

// GET /reports/citizen-participation
router.get('/citizen-participation', authenticate, authorize('authority', 'admin'), async (req, res, next) => {
  try {
    const scope = resolveWardScope(req, req.query.ward_id);
    if (scope.error) {
      return res.status(scope.error.status).json({ success: false, data: null, message: scope.error.message });
    }
    const wardId = scope.wardId;
    const since  = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const filter = { createdAt: { $gte: since } };
    if (wardId) filter.wardId = wardId;

    const [agg, gamStats] = await Promise.all([
      Complaint.aggregate([
        { $match: filter },
        { $group: { _id: null, total: { $sum: 1 }, reporters: { $addToSet: '$userId' } } },
      ]),
      Gamification.aggregate([
        { $group: { _id: null, avgPoints: { $avg: '$totalPoints' }, engaged: { $sum: { $cond: [{ $gte: ['$level', 3] }, 1, 0] } } } },
      ]),
    ]);

    const payload = {
      active_reporters:  agg[0]?.reporters?.length || 0,
      total_complaints:  agg[0]?.total || 0,
      avg_citizen_points: Math.round(gamStats[0]?.avgPoints || 0),
      engaged_users:     gamStats[0]?.engaged || 0,
    };
    return ok(res, payload, 'Citizen participation report fetched');
  } catch (err) { next(err); }
});

module.exports = router;
