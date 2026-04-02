const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const config = require('./config');
const apiRoutes = require('./routes/api');
const errorHandler = require('./middleware/errorHandler');
const logger = require('./utils/logger');
const { closeBrowser, injectEnvCookies, checkSession } = require('./services/douyin');
const douyinService = require('./services/douyin');
const { startWorker } = require('./services/queue');
const connectDB = require('./models/index');
const session = require('express-session');
const webRoutes = require('./routes/web');

// Connect to MongoDB
connectDB();

const app = express();

// Trust reverse proxy (Nginx) to get real IPs for rate limiters
app.set('trust proxy', 1);

// View Engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));

// ─── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session Middleware (for web dashboard)
app.use(session({
  secret: process.env.SESSION_SECRET || 'douyin-session-secret-12345',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 1 day
}));

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

// IP ban & anti-spam guard
const { ipGuard } = require('./middleware/ipGuard');
app.use('/api/', ipGuard);

// Serve downloaded files statically
app.use(
  '/downloads',
  express.static(path.resolve(config.downloadDir))
);

// Serve public static assets (like images)
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── Routes ──────────────────────────────────────────────────
// Web Dashboard Routes
app.use('/', webRoutes);

// API Routes
app.use('/api', apiRoutes);

// Root - Public landing page
app.get('/', (_req, res) => {
  res.render('home');
});

// ─── Error Handler ───────────────────────────────────────────
app.use(errorHandler);

// ─── Start Server ────────────────────────────────────────────
const server = app.listen(config.port, async () => {
  logger.info(`🚀 Douyin Video Downloader API running on port ${config.port}`);
  logger.info(`📋 API docs: http://localhost:${config.port}/`);
  logger.info(`📁 Browser profile: ${config.browserDataDir}`);

  // Start queue worker
  startWorker(douyinService);

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
