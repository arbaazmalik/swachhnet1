const express = require('express');
const request = require('supertest');

const mockHotspotFind = jest.fn();
const mockHotspotDeleteMany = jest.fn();
const mockHotspotInsertMany = jest.fn();
const mockComplaintFind = jest.fn();

jest.mock('../../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.user = req.mockUser || { role: 'admin', wardId: '507f1f77bcf86cd799439011' };
    next();
  },
  authorize: () => (req, _res, next) => next(),
}));

jest.mock('../../services/aiService', () => ({
  predictWaste: jest.fn(),
  detectHotspots: jest.fn(),
  predictTrend: jest.fn(),
}));

jest.mock('../../models/Hotspot', () => ({
  find: (...args) => mockHotspotFind(...args),
  deleteMany: (...args) => mockHotspotDeleteMany(...args),
  insertMany: (...args) => mockHotspotInsertMany(...args),
}));

jest.mock('../../models/Complaint', () => ({
  find: (...args) => mockComplaintFind(...args),
}));

const aiService = require('../../services/aiService');
const aiRoutes = require('../ai');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const role = req.headers['x-test-role'];
    const wardId = req.headers['x-test-ward-id'];
    req.mockUser = {
      role: role || 'admin',
      wardId: wardId || '507f1f77bcf86cd799439011',
    };
    next();
  });
  app.use('/api/v1/ai', aiRoutes);
  app.use((err, _req, res, _next) => {
    res.status(500).json({ success: false, data: null, message: err.message });
  });
  return app;
}

function createHotspotQueryChain(result) {
  return {
    populate: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(result),
  };
}

function createComplaintQueryChain(result) {
  return {
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(result),
  };
}

describe('AI routes', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
    mockHotspotFind.mockReset();
    mockHotspotDeleteMany.mockReset();
    mockHotspotInsertMany.mockReset();
    mockComplaintFind.mockReset();
  });

  test('POST /predict-waste returns 400 when image is missing', async () => {
    const res = await request(app).post('/api/v1/ai/predict-waste').field('x', 'y');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('Image required');
    expect(aiService.predictWaste).not.toHaveBeenCalled();
  });

  test('POST /predict-waste returns 400 for unsupported mime type', async () => {
    const res = await request(app)
      .post('/api/v1/ai/predict-waste')
      .attach('image', Buffer.from('not-an-image'), { filename: 'bad.gif', contentType: 'image/gif' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain('Unsupported file type');
    expect(aiService.predictWaste).not.toHaveBeenCalled();
  });

  test('POST /predict-waste returns 400 when image exceeds 5MB', async () => {
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 1);

    const res = await request(app)
      .post('/api/v1/ai/predict-waste')
      .attach('image', oversized, { filename: 'large.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('Image size exceeds 5MB');
    expect(aiService.predictWaste).not.toHaveBeenCalled();
  });

  test('POST /predict-waste accepts image field and returns service response', async () => {
    aiService.predictWaste.mockResolvedValue({ class: 'plastic', waste_type: 'plastic', confidence: 0.98, is_confident: true, probabilities: {} });

    const res = await request(app)
      .post('/api/v1/ai/predict-waste')
      .attach('image', Buffer.from([1, 2, 3]), { filename: 'ok.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.class).toBe('plastic');
    expect(aiService.predictWaste).toHaveBeenCalledTimes(1);
  });

  test('POST /predict-waste accepts file field and returns service response', async () => {
    aiService.predictWaste.mockResolvedValue({ class: 'wet', waste_type: 'wet', confidence: 0.93, is_confident: true, probabilities: {} });

    const res = await request(app)
      .post('/api/v1/ai/predict-waste')
      .attach('file', Buffer.from([1, 2, 3]), { filename: 'ok.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.class).toBe('wet');
    expect(aiService.predictWaste).toHaveBeenCalledTimes(1);
  });

  test('POST /predict-waste maps ECONNREFUSED to 503', async () => {
    aiService.predictWaste.mockRejectedValue({ code: 'ECONNREFUSED' });

    const res = await request(app)
      .post('/api/v1/ai/predict-waste')
      .attach('image', Buffer.from([1, 2, 3]), { filename: 'ok.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('AIML service unavailable');
  });

  test('POST /predict-waste forwards non-connection errors to error middleware', async () => {
    aiService.predictWaste.mockRejectedValue(new Error('upstream failed'));

    const res = await request(app)
      .post('/api/v1/ai/predict-waste')
      .attach('image', Buffer.from([1, 2, 3]), { filename: 'ok.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('upstream failed');
  });

  test('POST /classify maps prediction to legacy shape', async () => {
    aiService.predictWaste.mockResolvedValue({
      class: 'dry',
      waste_type: 'dry',
      confidence: 0.88,
      is_confident: true,
      probabilities: { dry: 0.88 },
      model_version: 'aiml-v2',
    });

    const res = await request(app)
      .post('/api/v1/ai/classify')
      .attach('image', Buffer.from([1, 2, 3]), { filename: 'ok.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.result).toEqual({
      label: 'dry',
      confidence: 0.88,
      reliable: true,
      all_scores: { dry: 0.88 },
      model_version: 'aiml-v2',
    });
  });

  test('POST /classify maps ECONNREFUSED to 503', async () => {
    aiService.predictWaste.mockRejectedValue({ code: 'ECONNREFUSED' });

    const res = await request(app)
      .post('/api/v1/ai/classify')
      .attach('image', Buffer.from([1, 2, 3]), { filename: 'ok.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('AIML service unavailable');
  });

  test('POST /detect-hotspot maps ECONNREFUSED to 503', async () => {
    aiService.detectHotspots.mockRejectedValue({ code: 'ECONNREFUSED' });

    const res = await request(app)
      .post('/api/v1/ai/detect-hotspot')
      .send({ coordinates: [{ lat: 12.9, long: 77.5 }] });

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('AIML service unavailable');
  });

  test('POST /predict-trend maps ECONNREFUSED to 503', async () => {
    aiService.predictTrend.mockRejectedValue({ code: 'ECONNREFUSED' });

    const res = await request(app)
      .post('/api/v1/ai/predict-trend')
      .send({ historical_data: [{ date: '2026-03-01', value: 10 }], forecast_days: 7 });

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('AIML service unavailable');
  });

  test('GET /hotspots returns stored hotspot data for authority ward scope', async () => {
    const hotspotDocs = [{
      _id: '507f1f77bcf86cd799439111',
      wardId: { _id: '507f1f77bcf86cd799439011', name: 'Ward 14', city: 'Pune' },
      centroid: { coordinates: [73.8575, 18.5207] },
      complaintCount: 4,
      severityScore: 2.8,
      dominantType: 'illegal_dumping',
      periodDays: 7,
      createdAt: '2026-03-27T12:00:00.000Z',
    }];

    mockHotspotFind.mockReturnValueOnce(createHotspotQueryChain(hotspotDocs));

    const res = await request(app)
      .get('/api/v1/ai/hotspots?days=7')
      .set('x-test-role', 'authority')
      .set('x-test-ward-id', '507f1f77bcf86cd799439011');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.hotspots).toHaveLength(1);
    expect(res.body.data.hotspots[0]).toMatchObject({
      ward_id: '507f1f77bcf86cd799439011',
      ward_name: 'Ward 14',
      complaint_count: 4,
      severity_score: 2.8,
      dominant_type: 'illegal_dumping',
    });
    expect(mockHotspotFind).toHaveBeenCalledWith({ wardId: '507f1f77bcf86cd799439011', periodDays: 7 });
  });

  test('GET /hotspots rejects cross-ward access for authority users', async () => {
    const res = await request(app)
      .get('/api/v1/ai/hotspots?ward_id=507f1f77bcf86cd799439099')
      .set('x-test-role', 'authority')
      .set('x-test-ward-id', '507f1f77bcf86cd799439011');

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('Authority users can only access their assigned ward');
    expect(mockHotspotFind).not.toHaveBeenCalled();
  });

  test('POST /hotspots/refresh regenerates hotspots and assigns cluster ward for admin-wide refresh', async () => {
    mockComplaintFind.mockReturnValueOnce(createComplaintQueryChain([
      {
        wardId: '507f1f77bcf86cd799439021',
        location: { coordinates: [73.8571, 18.5201] },
        issueType: 'illegal_dumping',
        priority: 3,
      },
      {
        wardId: '507f1f77bcf86cd799439021',
        location: { coordinates: [73.8572, 18.5202] },
        issueType: 'illegal_dumping',
        priority: 2,
      },
      {
        wardId: '507f1f77bcf86cd799439021',
        location: { coordinates: [73.8573, 18.5203] },
        issueType: 'overflowing_bin',
        priority: 3,
      },
    ]));
    aiService.detectHotspots.mockResolvedValue({
      clusters: [{
        center: { lat: 18.5202, long: 73.8572 },
        count: 3,
        points: [
          { lat: 18.5201, long: 73.8571, priority: 3, issue_type: 'illegal_dumping', ward_id: '507f1f77bcf86cd799439021' },
          { lat: 18.5202, long: 73.8572, priority: 2, issue_type: 'illegal_dumping', ward_id: '507f1f77bcf86cd799439021' },
          { lat: 18.5203, long: 73.8573, priority: 3, issue_type: 'overflowing_bin', ward_id: '507f1f77bcf86cd799439021' },
        ],
      }],
    });
    mockHotspotDeleteMany.mockResolvedValue({ acknowledged: true });
    mockHotspotInsertMany.mockResolvedValue([]);
    mockHotspotFind.mockReturnValue(createHotspotQueryChain([
      {
        _id: '507f1f77bcf86cd799439222',
        wardId: { _id: '507f1f77bcf86cd799439021', name: 'Ward 21', city: 'Pune' },
        centroid: { coordinates: [73.8572, 18.5202] },
        complaintCount: 3,
        severityScore: 2.9,
        dominantType: 'illegal_dumping',
        periodDays: 14,
        createdAt: '2026-03-27T12:00:00.000Z',
      },
    ]));

    const res = await request(app)
      .post('/api/v1/ai/hotspots/refresh')
      .set('x-test-role', 'admin')
      .send({ days: 14 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockComplaintFind).toHaveBeenCalledWith(expect.objectContaining({
      status: { $in: ['pending', 'assigned', 'in_progress'] },
      createdAt: expect.any(Object),
    }));
    expect(mockHotspotDeleteMany).toHaveBeenCalledWith({ periodDays: 14 });
    expect(mockHotspotInsertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        wardId: '507f1f77bcf86cd799439021',
        complaintCount: 3,
        dominantType: 'illegal_dumping',
        periodDays: 14,
      }),
    ]);
    expect(res.body.data.hotspots[0].ward_id).toBe('507f1f77bcf86cd799439021');
  });

  test('POST /hotspots/refresh clears stale hotspot records when no active complaints exist', async () => {
    mockComplaintFind.mockReturnValueOnce(createComplaintQueryChain([]));
    mockHotspotDeleteMany.mockResolvedValue({ acknowledged: true });
    mockHotspotFind.mockReturnValueOnce(createHotspotQueryChain([]));

    const res = await request(app)
      .post('/api/v1/ai/hotspots/refresh')
      .set('x-test-role', 'authority')
      .set('x-test-ward-id', '507f1f77bcf86cd799439011')
      .send({ days: 7 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockHotspotDeleteMany).toHaveBeenCalledWith({
      wardId: '507f1f77bcf86cd799439011',
      periodDays: 7,
    });
    expect(res.body.data.hotspots).toEqual([]);
  });
});
