const router = require('express').Router();
const axios  = require('axios');
const { authenticate } = require('../middleware/auth');
const { setEx, get }   = require('../config/redis');
const Complaint = require('../models/Complaint');
const { ok, fail } = require('../utils/response');

// GET /map/centers
router.get('/centers', authenticate, async (req, res, next) => {
  try {
    const { lat, lng, radius = 5000, type } = req.query;
    if (!lat || !lng) return fail(res, 400, 'lat and lng are required');

    const apiKey = process.env.GMAPS_API_KEY;
    if (!apiKey || apiKey === 'your_google_maps_key') {
      return ok(res, { centers: [], isLive: false }, 'Google Places API key is not configured.');
    }

    const cacheKey = `map:centers:${lat}:${lng}:${radius}:${type || 'all'}`;
    const cached   = await get(cacheKey);
    if (cached) return ok(res, cached, 'Centers fetched');

    const typeMap = {
      recycling: 'recycling center',
      scrap:     'scrap dealer',
      ewaste:    'e-waste collection',
      organic:   'compost facility',
    };
    const keyword = typeMap[type] || 'waste management recycling';

    let gmapsRes;
    try {
      gmapsRes = await axios.get('https://maps.googleapis.com/maps/api/place/nearbysearch/json', {
        params: { location: `${lat},${lng}`, radius, keyword, key: apiKey },
        timeout: 10000,
      });
    } catch (err) {
      return ok(res, { centers: [], isLive: false, error: err.message }, 'Google Places API unavailable.');
    }

    const centers = (gmapsRes.data?.results || []).map(p => ({
      id:       p.place_id,
      name:     p.name,
      lat:      p.geometry.location.lat,
      lng:      p.geometry.location.lng,
      address:  p.vicinity,
      rating:   p.rating,
      open_now: p.opening_hours?.open_now,
      types:    p.types,
    }));

    const response = { centers, isLive: true };
    await setEx(cacheKey, 3600, response);
    return ok(res, response, 'Centers fetched');
  } catch (err) { next(err); }
});

// GET /map/bins
router.get('/bins', authenticate, async (req, res, next) => {
  try {
    const { ward_id } = req.query;
    const filter = { status: { $in: ['pending', 'assigned', 'in_progress'] }, 'location.coordinates': { $exists: true } };
    
    if (req.user.role === 'authority' || req.user.role === 'admin') {
      const { resolveWardScope } = require('../utils/wardScope');
      const scope = resolveWardScope(req, ward_id);
      if (scope.error) return fail(res, scope.error.status, scope.error.message);
      if (scope.wardId) filter.wardId = scope.wardId;
    } else if (ward_id) {
      filter.wardId = ward_id;
    }

    const recent = await Complaint.find(filter)
      .select('location issueType priority updatedAt address')
      .sort({ updatedAt: -1 })
      .limit(50)
      .lean();

    const bins = recent.map((c, idx) => ({
      id: String(c._id || idx),
      lat: c.location.coordinates[1],
      lng: c.location.coordinates[0],
      fill_percent: Math.min(100, 30 + (c.priority || 1) * 20),
      type: c.issueType,
      address: c.address || 'Unspecified location',
      source: 'complaint-derived',
    }));
    return ok(res, { bins }, 'Bins fetched');
  } catch (err) { next(err); }
});

module.exports = router;
