const express = require('express');
const request = require('supertest');

const mockComplaintFind = jest.fn();
const mockUserFindOne = jest.fn();

jest.mock('../../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.user = req.mockUser || { role: 'citizen', _id: '507f1f77bcf86cd799439001' };
    next();
  },
  authorize: (...roles) => (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ success: false, data: null, message: 'Insufficient permissions' });
    }
    next();
  },
}));

jest.mock('../../models/Complaint', () => ({
  find: (...args) => mockComplaintFind(...args),
  findOne: (...args) => mockComplaintFind(...args),
  findOneAndUpdate: jest.fn(),
  create: jest.fn(),
  countDocuments: jest.fn().mockResolvedValue(0),
}));

jest.mock('../../services/notificationService', () => ({
  notifyAuthorities: jest.fn(),
  notifyCitizen: jest.fn(),
}));

jest.mock('../../jobs/aiQueue', () => ({
  queueAIClassification: jest.fn(),
}));

jest.mock('../../services/gamificationService', () => ({
  awardPoints: jest.fn(),
}));

const complaintRoutes = require('../complaints');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const role = req.headers['x-test-role'];
    const wardId = req.headers['x-test-ward-id'];
    req.mockUser = {
      _id: '507f1f77bcf86cd799439001',
      role: role || 'citizen',
      wardId: wardId !== 'none' ? (wardId || undefined) : undefined,
    };
    next();
  });
  app.use('/api/v1/complaints', complaintRoutes);
  app.use((err, _req, res, _next) => {
    res.status(500).json({ success: false, data: null, message: err.message });
  });
  return app;
}

function createQueryChain(result) {
  return {
    populate: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(result),
  };
}

describe('Security & Ward Scope Isolation Tests', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
    mockComplaintFind.mockReset();
  });

  test('Test 1: Authority with Ward A requests Ward A data -> 200 with Ward A scope', async () => {
    mockComplaintFind.mockReturnValueOnce(createQueryChain([]));

    const res = await request(app)
      .get('/api/v1/complaints?ward_id=507f1f77bcf86cd799439011')
      .set('x-test-role', 'authority')
      .set('x-test-ward-id', '507f1f77bcf86cd799439011');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockComplaintFind).toHaveBeenCalledWith(expect.objectContaining({
      wardId: '507f1f77bcf86cd799439011',
    }));
  });

  test('Test 2: Authority with Ward A requests Ward B data -> 403 Forbidden', async () => {
    const res = await request(app)
      .get('/api/v1/complaints?ward_id=507f1f77bcf86cd799439099')
      .set('x-test-role', 'authority')
      .set('x-test-ward-id', '507f1f77bcf86cd799439011');

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain('Authority users can only access their assigned ward');
  });

  test('Test 3: Authority with no ward assignment -> 403 Forbidden', async () => {
    const res = await request(app)
      .get('/api/v1/complaints')
      .set('x-test-role', 'authority')
      .set('x-test-ward-id', 'none');

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain('Authority account is not assigned to a ward');
  });

  test('Test 4: Admin without ward restriction -> system-wide access', async () => {
    mockComplaintFind.mockReturnValueOnce(createQueryChain([]));

    const res = await request(app)
      .get('/api/v1/complaints')
      .set('x-test-role', 'admin')
      .set('x-test-ward-id', 'none');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockComplaintFind).toHaveBeenCalledWith(expect.not.objectContaining({ wardId: expect.anything() }));
  });

  test('Test 5: Citizen attempting authority update API -> 403 Forbidden', async () => {
    const res = await request(app)
      .put('/api/v1/complaints/507f1f77bcf86cd799439011/status')
      .set('x-test-role', 'citizen')
      .send({ status: 'resolved' });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain('Insufficient permissions');
  });

  test('Test 6: Worker attempting authority assign API -> 403 Forbidden', async () => {
    const res = await request(app)
      .post('/api/v1/complaints/507f1f77bcf86cd799439011/assign')
      .set('x-test-role', 'worker')
      .send({ worker_id: '507f1f77bcf86cd799439022' });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain('Insufficient permissions');
  });
});
