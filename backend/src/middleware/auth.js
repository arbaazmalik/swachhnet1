const jwt    = require('jsonwebtoken');
const User   = require('../models/User');
const env    = require('../config/env');
const logger = require('../utils/logger');

function getJwtSecret() {
  const secret = env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is not set. Cannot verify tokens.');
  }
  return secret;
}

const authenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, data: null, message: 'No token provided' });
    }
    const token   = header.split(' ')[1];
    const decoded = jwt.verify(token, getJwtSecret());

    const user = await User.findById(decoded.userId)
      .select('name phone email role wardId isVerified')
      .lean();
    if (!user) return res.status(401).json({ success: false, data: null, message: 'User not found' });

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, data: null, message: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ success: false, data: null, message: 'Invalid token' });
    }
    // Config error (missing JWT_SECRET) - log server-side, return generic 500
    logger.error('Auth middleware configuration error:', err.message);
    return res.status(500).json({ success: false, data: null, message: 'Internal server error' });
  }
};

const authorize = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user?.role)) {
    return res.status(403).json({ success: false, data: null, message: 'Insufficient permissions' });
  }
  next();
};

const optionalAuth = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      const token   = header.split(' ')[1];
      const decoded = jwt.verify(token, getJwtSecret());
      const user    = await User.findById(decoded.userId).select('name role wardId').lean();
      if (user) req.user = user;
    }
  } catch { /* optional — ignore auth failure */ }
  next();
};

module.exports = { authenticate, authorize, optionalAuth };