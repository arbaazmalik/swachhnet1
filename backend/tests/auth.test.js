const request = require('supertest');
const app = require('../src/server');
const User = require('../src/models/User');
const { mongoose } = require('../src/config/database');

describe('Auth API Endpoints', () => {
  let testUser = {
    name: 'Test User',
    phone: '1234567890',
    password: 'password123',
    role: 'citizen'
  };

  beforeAll(async () => {
    await User.deleteMany({ phone: { $regex: '1234567890' } });
  });

  afterAll(async () => {
    await User.deleteMany({ phone: { $regex: '1234567890' } });
  });

  test('POST /api/v1/auth/register should register a new user', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send(testUser);
    
    expect(res.statusCode).toEqual(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.phone).toContain('1234567890');
  });

  test('POST /api/v1/auth/register should fail for duplicate phone', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send(testUser);
    
    expect(res.statusCode).toEqual(409);
    expect(res.body.success).toBe(false);
  });

  test('POST /api/v1/auth/login should fail for unverified user', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({
        phone: testUser.phone,
        password: testUser.password
      });
    
    expect(res.statusCode).toEqual(403);
    expect(res.body.message).toContain('Phone not verified');
  });
});
