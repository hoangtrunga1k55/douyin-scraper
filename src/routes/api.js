const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const downloaderService = require('../services/downloader');
const logger = require('../utils/logger');
const authApi = require('../middleware/authApi');
const deductCredits = require('../middleware/deductCredits');
const { addJob, getJobStatus } = require('../services/queue');

// ─── Queue-based Endpoints ───────────────────────────────────

/**
 * POST /api/video/parse
 * Queue a video parse job. Returns jobId.
 */
router.post('/video/parse', authApi, deductCredits('credit_video_parse', 10), async (req, res, next) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ success: false, error: 'Missing required field: url' });

    logger.info(`[API] Queue video parse: ${url}`);
    const jobId = await addJob('video.parse', { url });

    res.json({ success: true, data: { jobId, message: 'Job queued. Poll GET /api/job/:jobId for result.' } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/video/download
 * Queue a video parse, then client downloads from the returned URL
 */
router.post('/video/download', authApi, deductCredits('credit_video_download', 10), async (req, res, next) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ success: false, error: 'Missing required field: url' });

    logger.info(`[API] Queue video download: ${url}`);
    const jobId = await addJob('video.parse', { url });

    res.json({ success: true, data: { jobId, message: 'Job queued. Poll GET /api/job/:jobId for download URL.' } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/channel/videos
 * Queue a channel videos fetch job. Returns jobId.
 */
router.post('/channel/videos', authApi, deductCredits('credit_channel_videos', 20), async (req, res, next) => {
  try {
    const { url, count = 20, cursor = 0, since = null } = req.body;
    if (!url) return res.status(400).json({ success: false, error: 'Missing required field: url' });

    logger.info(`[API] Queue channel videos: ${url}, count: ${count}, since: ${since || 'all'}`);
    const jobId = await addJob('channel.videos', { url, count, cursor, since });

    res.json({ success: true, data: { jobId, message: 'Job queued. Poll GET /api/job/:jobId for result.' } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/channel/download
 * Start batch download (kept synchronous as it already has its own task system)
 */
router.post('/channel/download', authApi, deductCredits('credit_channel_download', 20), async (req, res, next) => {
  try {
    const { url, count = 10 } = req.body;
    if (!url) return res.status(400).json({ success: false, error: 'Missing required field: url' });
    if (count > 100) return res.status(400).json({ success: false, error: 'Count must be <= 100' });

    logger.info(`[API] Batch download: ${url}, count: ${count}`);
    const result = await downloaderService.startBatchDownload(url, count);

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// ─── Job Status Endpoint ─────────────────────────────────────

/**
 * GET /api/job/:jobId
 * Check status of a queued job
 */
router.get('/job/:jobId', async (req, res) => {
  try {
    const status = await getJobStatus(req.params.jobId);
    if (!status) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }
    res.json({ success: true, data: status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Legacy Task Endpoints ───────────────────────────────────

router.get('/task/:taskId', (req, res) => {
  const task = downloaderService.getTaskStatus(req.params.taskId);
  if (!task) return res.status(404).json({ success: false, error: 'Task not found' });
  res.json({ success: true, data: task });
});

router.get('/tasks', (_req, res) => {
  const tasks = downloaderService.listTasks();
  res.json({ success: true, data: tasks });
});

// ─── Health Check ────────────────────────────────────────────

router.get('/health', (_req, res) => {
  res.json({ success: true, status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Free Public Endpoint (queue-based) ──────────────────────

/**
 * POST /api/free/parse
 * Parse a Douyin video URL (free, queued)
 */
const freeApiLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 10, // Limit each IP to 10 requests per day
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Bạn đã đạt giới hạn dùng thử miễn phí (10 lần / ngày). Vui lòng đợi hoặc đăng ký tài khoản để sử dụng tiếp.',
  },
});

router.post('/free/parse', freeApiLimiter, async (req, res, next) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ success: false, error: 'Missing required field: url' });

    logger.info(`[FREE] Queue parse video: ${url}`);
    const jobId = await addJob('video.parse', { url });

    res.json({ success: true, data: { jobId } });
  } catch (err) {
    next(err);
  }
});

// ─── Auth / Cookie Management ────────────────────────────────

const douyinService = require('../services/douyin');

router.get('/auth/status', async (_req, res, next) => {
  try {
    const status = await douyinService.checkSession();
    res.json({ success: true, data: status });
  } catch (err) { next(err); }
});

router.get('/auth/login', async (_req, res, next) => {
  try {
    const { browser, page } = await douyinService.openLoginBrowser();
    res.json({ success: true, message: 'Browser opened. Login then call GET /api/auth/confirm.' });
    router._loginBrowser = browser;
    router._loginPage = page;
  } catch (err) { next(err); }
});

router.get('/auth/confirm', async (_req, res, next) => {
  try {
    if (router._loginBrowser) {
      await router._loginBrowser.close();
      router._loginBrowser = null;
      router._loginPage = null;
    }
    const status = await douyinService.checkSession();
    res.json({ success: true, message: 'Login confirmed. Cookies saved.', data: status });
  } catch (err) { next(err); }
});

router.post('/auth/inject', async (_req, res, next) => {
  try {
    const result = await douyinService.injectEnvCookies();
    if (result) {
      const status = await douyinService.checkSession();
      res.json({ success: true, message: 'Cookies imported.', data: status });
    } else {
      res.status(400).json({ success: false, error: 'DOUYIN_COOKIE not configured.' });
    }
  } catch (err) { next(err); }
});

// ─── Media Proxy (bypass Douyin anti-hotlink 403) ────────────

/**
 * GET /api/proxy/media?url=<encoded_douyin_cdn_url>&dl=1
 * Streams Douyin CDN content through our server.
 * Query params:
 *   url – the Douyin CDN URL (required)
 *   dl  – if "1", sets Content-Disposition to force download
 */
router.get('/proxy/media', async (req, res) => {
  try {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ success: false, error: 'Missing url param' });

    // Validate URL format
    let parsed;
    try { parsed = new URL(targetUrl); } catch { return res.status(400).json({ success: false, error: 'Invalid URL' }); }

    // Only allow http/https
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ success: false, error: 'Invalid protocol' });
    }

    logger.info(`[Proxy] Streaming: ${parsed.hostname}${parsed.pathname.substring(0, 60)}...`);

    const upstream = await fetch(targetUrl, {
      headers: {
        'Referer': 'https://www.douyin.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      redirect: 'follow',
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({ success: false, error: `Upstream returned ${upstream.status}` });
    }

    // Forward content headers
    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('Content-Type', ct);
    const cl = upstream.headers.get('content-length');
    if (cl) res.setHeader('Content-Length', cl);

    // Force download if requested
    if (req.query.dl === '1') {
      const ext = ct && ct.includes('video') ? 'mp4' : 'jpg';
      res.setHeader('Content-Disposition', `attachment; filename="douyin_video.${ext}"`);
    }

    // Cache for 1 hour
    res.setHeader('Cache-Control', 'public, max-age=3600');

    // Stream the body
    const { Readable } = require('stream');
    const nodeStream = Readable.fromWeb(upstream.body);
    nodeStream.pipe(res);
  } catch (err) {
    logger.error(`[Proxy] Error: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Proxy error' });
    }
  }
});

module.exports = router;
