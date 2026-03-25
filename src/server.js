const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const config = require('./config');
const apiRoutes = require('./routes/api');
const errorHandler = require('./middleware/errorHandler');
const logger = require('./utils/logger');
const { closeBrowser, injectEnvCookies, checkSession } = require('./services/douyin');

const app = express();

// ─── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting: 60 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many requests, please try again later.',
  },
});
app.use('/api/', limiter);

// Serve downloaded files statically
app.use(
  '/downloads',
  express.static(path.resolve(config.downloadDir))
);

// ─── Routes ──────────────────────────────────────────────────
app.use('/api', apiRoutes);

// Root info endpoint
app.get('/', (_req, res) => {
  res.json({
    name: 'Douyin Video Downloader API',
    version: '1.0.0',
    endpoints: {
      'POST /api/video/parse': 'Parse a Douyin video URL and get video info',
      'POST /api/video/download': 'Download a Douyin video (returns mp4 stream)',
      'POST /api/channel/videos': 'Get list of videos from a user channel',
      'POST /api/channel/download': 'Start batch download of channel videos',
      'GET /api/task/:taskId': 'Check batch download task status',
      'GET /api/tasks': 'List all download tasks',
      'GET /api/auth/login': 'Open browser to login Douyin (auto-save cookies)',
      'GET /api/auth/confirm': 'Confirm login done & close browser',
      'GET /api/auth/status': 'Check cookie/session status',
      'POST /api/auth/inject': 'Import .env cookies into browser profile',
      'GET /api/health': 'Health check',
    },
  });
});

// ─── Error Handler ───────────────────────────────────────────
app.use(errorHandler);

// ─── Start Server ────────────────────────────────────────────
const server = app.listen(config.port, async () => {
  logger.info(`🚀 Douyin Video Downloader API running on port ${config.port}`);
  logger.info(`📋 API docs: http://localhost:${config.port}/`);
  logger.info(`📁 Browser profile: ${config.browserDataDir}`);

  // Auto-inject .env cookies into persistent profile on first start
  try {
    const injected = await injectEnvCookies();
    if (injected) {
      logger.info('✅ .env cookies imported into browser profile');
    }

    const session = await checkSession();
    if (session.valid) {
      logger.info(`✅ Session OK (${session.cookie_count} cookies, logged_in: ${session.logged_in})`);
    } else {
      logger.warn(
        '⚠️  No valid session. Đăng nhập: mở http://localhost:' +
          config.port +
          '/api/auth/login'
      );
    }
  } catch (err) {
    logger.warn(`⚠️  Could not validate session: ${err.message}`);
    logger.warn(
      '⚠️  Đăng nhập: mở http://localhost:' + config.port + '/api/auth/login'
    );
  }
});

// ─── Graceful Shutdown ───────────────────────────────────────
async function shutdown(signal) {
  logger.info(`${signal} received. Shutting down gracefully...`);
  await closeBrowser();
  server.close(() => {
    logger.info('Server closed.');
    process.exit(0);
  });

  // Force exit after 10s
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
});

module.exports = app;
