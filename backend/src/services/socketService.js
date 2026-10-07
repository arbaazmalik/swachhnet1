const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const logger = require('../utils/logger');
const User = require('../models/User');

let io = null;

function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
      credentials: true,
    },
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');
      if (!token) {
        return next(new Error('Authentication error: Token required'));
      }
      const secret = env.JWT_SECRET;
      if (!secret) return next(new Error('Authentication error: Server misconfiguration'));
      const decoded = jwt.verify(token, secret);
      const user = await User.findById(decoded.userId).select('role wardId name').lean();
      if (!user) {
        return next(new Error('Authentication error: User not found'));
      }
      socket.user = user;
      return next();
    } catch (err) {
      return next(new Error('Authentication error: Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.user;
    logger.info(`Socket client connected: ${user.name} (${user.role}) [socket.id: ${socket.id}]`);

    socket.join(`user:${user._id}`);
    socket.join(`role:${user.role}`);
    if (user.wardId) {
      socket.join(`ward:${user.wardId}`);
    }

    socket.on('disconnect', () => {
      logger.info(`Socket client disconnected: ${socket.id}`);
    });
  });

  return io;
}

function getIO() {
  return io;
}

function emitRealtimeEvent({ event, data, wardId, userId, role }) {
  if (!io) return;
  if (userId) {
    io.to(`user:${userId}`).emit(event, data);
  }
  if (wardId) {
    io.to(`ward:${wardId}`).emit(event, data);
  }
  if (role) {
    io.to(`role:${role}`).emit(event, data);
  }
  // Admin receives all events for system-wide monitoring
  io.to('role:admin').emit(event, data);
}

module.exports = {
  initSocket,
  getIO,
  emitRealtimeEvent,
};
