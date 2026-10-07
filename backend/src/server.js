const env          = require('./config/env');
const express      = require('express');
const path         = require('path');
const cors         = require('cors');
const helmet       = require('helmet');
const morgan       = require('morgan');
const compression  = require('compression');
const rateLimit    = require('express-rate-limit');

const { connectDB }  = require('./config/database');
const { connectRedis } = require('./config/redis');
const logger         = require('./utils/logger');
const errorHandler   = require('./middleware/errorHandler');

const authRoutes         = require('./routes/auth');
const complaintRoutes    = require('./routes/complaints');
const aiRoutes           = require('./routes/ai');
const mapRoutes          = require('./routes/map');
const trainingRoutes = require('./routes/training');
const { learningRouter, quizRouter, userRouter, gamificationRouter } = require('./routes/training');
const workerRoutes       = require('./routes/workers');
const reportRoutes       = require('./routes/reports');
const notificationRoutes = require('./routes/notifications');
const wardRoutes         = require('./routes/wards');
const workforceRoutes    = require('./routes/workforce');

const http = require('http');
const { initSocket } = require('./services/socketService');

const app  = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5000;

function validateProductionEnv() {
  if (process.env.NODE_ENV !== 'production') return;

  const required = ['MONGODB_URI', 'REDIS_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'AIML_SERVICE_URL', 'ALLOWED_ORIGINS'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing required production env vars: ${missing.join(', ')}`);
  }

  const weakSecrets = ['change_me_in_production', 'change_me_refresh_in_production', 'your_super_secret_jwt_key_here', 'your_super_secret_refresh_key_here'];
  if (weakSecrets.includes(process.env.JWT_SECRET) || weakSecrets.includes(process.env.JWT_REFRESH_SECRET)) {
    throw new Error('Refusing to start with insecure JWT secrets in production');
  }
}

app.use(helmet());
app.use(compression());
if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}
app.use(cors({
  origin:      process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  credentials: true,
}));
app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/uploads', express.static(path.resolve(__dirname, '../uploads')));

app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      300,
  message:  { error: 'Too many requests. Please try again later.' },
}));

app.get('/health', (req, res) => {
  const payload = { status: 'ok', service: 'swachhanet-api', db: 'mongodb', timestamp: new Date().toISOString() };
  res.json({ success: true, data: payload, message: 'Health check ok' });
});

app.get('/ready', (req, res) => {
  const mongoose = require('mongoose');
  const dbState = mongoose.connection.readyState === 1;
  const isReady = dbState;
  const statusCode = isReady ? 200 : 503;
  res.status(statusCode).json({
    success: isReady,
    data: {
      db: dbState ? 'connected' : 'disconnected',
      timestamp: new Date().toISOString()
    },
    message: isReady ? 'Backend service ready' : 'Backend service not ready'
  });
});

const API = '/api/v1';
app.use(`${API}/auth`,          authRoutes);
app.use(`${API}/complaints`,    complaintRoutes);
app.use(`${API}/ai`,            aiRoutes);
app.use(`${API}/map`,           mapRoutes);
app.use(`${API}/training`,      trainingRoutes);
app.use(`${API}/learning`,      learningRouter);
app.use(`${API}/quiz`,          quizRouter);
app.use(`${API}/user`,          userRouter);
app.use(`${API}/gamification`,  gamificationRouter);
app.use(`${API}/workers`,       workerRoutes);
app.use(`${API}/reports`,       reportRoutes);
app.use(`${API}/notifications`, notificationRoutes);
app.use(`${API}/wards`,         wardRoutes);
app.use(`${API}/workforce`,     workforceRoutes);

app.use('*', (req, res) => res.status(404).json({
  success: false,
  data: null,
  message: `Route ${req.originalUrl} not found`,
}));
app.use(errorHandler);

async function startServer() {
  try {
    validateProductionEnv();
    await connectDB();
    await connectRedis();
    initSocket(server);
    server.listen(PORT, () => {
      logger.info(`SwachhaNet API & WebSocket server running on port ${PORT} [${process.env.NODE_ENV}] — MongoDB`);
    });
  } catch (err) {
    logger.error('Failed to start server:', err);
    process.exit(1);
  }
}

if (env.NODE_ENV !== 'test') {
  startServer();
}

module.exports = app;
