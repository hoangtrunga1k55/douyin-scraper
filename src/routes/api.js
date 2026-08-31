const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const downloaderService = require('../services/downloader');
const logger = require('../utils/logger');
const authApi = require('../middleware/authApi');
const deductCredits = require('../middleware/deductCredits');
const { addJob, getJobStatus } = require('../services/queue');

function requireAdminApi(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin privileges required' });
  }
  next();
}

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

// No API token: refreshing the Douyin session means scanning a QR code in the
// noVNC window, a manual operator step. Requiring a Bearer token here forced us
// to pull an admin token out of Mongo just to re-login.
router.get('/auth/login', async (_req, res, next) => {
  try {
    // Single-flight: close any previous login browser first, so repeated
    // /auth/login calls (or retries) don't orphan Chrome instances holding the profile.
    if (router._loginBrowser) {
      try { await router._loginBrowser.close(); } catch (_) { /* already gone */ }
      router._loginBrowser = null;
      router._loginPage = null;
    }
    const { browser, page } = await douyinService.openLoginBrowser();
    router._loginBrowser = browser;
    router._loginPage = page;
    res.json({ success: true, message: 'Browser opened. Login then call GET /api/auth/confirm.' });
  } catch (err) { next(err); }
});

// Paired with /auth/login above, so it carries the same no-token rule.
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

/**
 * GET /api/auth/status
 * Lightweight session health check (for cron/Telegram monitoring).
 * Returns checkSession() — { valid, logged_in, cookie_count, has_session, ... }.
 * Side-effect-free except that checkSession re-extends local session cookies.
 */
router.get('/auth/status', async (_req, res, next) => {
  try {
    const status = await douyinService.checkSession();
    res.json({ success: true, data: status });
  } catch (err) { next(err); }
});

router.post('/auth/inject', authApi, requireAdminApi, async (_req, res, next) => {
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

/**
 * POST /api/douyin/cookie
 * Directly save a Douyin cookie string to .env and inject into browser profile (no restart needed).
 * Body: { cookie: "sessionid=xxx; ttwid=xxx; ..." }
 */
router.post('/douyin/cookie', authApi, requireAdminApi, async (req, res) => {
  try {
    const { cookie } = req.body;
    if (!cookie || cookie.trim().length < 10) {
      return res.status(400).json({ success: false, error: 'Missing or invalid cookie string' });
    }
    const cookieStr = cookie.trim();

    const fs = require('fs');
    const path = require('path');
    const envPath = path.resolve(process.cwd(), '.env');

    // Update runtime config immediately
    const config = require('../config');
    config.douyinCookie = cookieStr;

    // Write to .env
    if (!fs.existsSync(envPath)) {
      fs.writeFileSync(envPath, `DOUYIN_COOKIE='${cookieStr}'\n`);
    } else {
      let content = fs.readFileSync(envPath, 'utf8');
      if (/^DOUYIN_COOKIE=.*$/m.test(content)) {
        content = content.replace(/^DOUYIN_COOKIE=.*$/m, `DOUYIN_COOKIE='${cookieStr}'`);
      } else {
        content += `\nDOUYIN_COOKIE='${cookieStr}'\n`;
      }
      fs.writeFileSync(envPath, content);
    }

    // Inject into browser profile immediately
    await douyinService.injectEnvCookies();

    res.json({ success: true, message: 'DOUYIN_COOKIE saved and injected into browser profile', length: cookieStr.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const tiktokService = require('../services/tiktok');

/**
 * POST /api/tiktok/cookie
 * Directly save a TikTok cookie string to .env and runtime config.
 * Body: { cookie: "sessionid=xxx; tt_webid=xxx; ..." }
 */
router.post('/tiktok/cookie', authApi, requireAdminApi, async (req, res) => {
  try {
    const { cookie } = req.body;
    if (!cookie || cookie.trim().length < 10) {
      return res.status(400).json({ success: false, error: 'Missing or invalid cookie string' });
    }
    const cookieStr = cookie.trim();

    const fs = require('fs');
    const path = require('path');
    const envPath = path.resolve(process.cwd(), '.env');

    // Update runtime config immediately
    const config = require('../config');
    config.tiktokCookie = cookieStr;

    // Write to .env
    if (!fs.existsSync(envPath)) {
      fs.writeFileSync(envPath, `TIKTOK_COOKIE='${cookieStr}'\n`);
    } else {
      let content = fs.readFileSync(envPath, 'utf8');
      if (/^TIKTOK_COOKIE=.*$/m.test(content)) {
        content = content.replace(/^TIKTOK_COOKIE=.*$/m, `TIKTOK_COOKIE='${cookieStr}'`);
      } else {
        content += `\nTIKTOK_COOKIE='${cookieStr}'\n`;
      }
      fs.writeFileSync(envPath, content);
    }

    res.json({ success: true, message: 'TIKTOK_COOKIE saved to .env', length: cookieStr.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/tiktok/auth/login', authApi, requireAdminApi, async (_req, res, next) => {
  try {
    const { browser, page } = await tiktokService.openLoginBrowser();
    res.json({ success: true, message: 'Browser opened. Login then call GET /api/tiktok/auth/confirm.' });
    router._tiktokLoginBrowser = browser;
    router._tiktokLoginPage = page;
  } catch (err) { next(err); }
});

router.get('/tiktok/auth/confirm', authApi, requireAdminApi, async (_req, res, next) => {
  try {
    // Read cookies BEFORE closing the browser — closing first loses unflushed session data
    const result = await tiktokService.confirmLogin(router._tiktokLoginBrowser);
    if (router._tiktokLoginBrowser) {
      await router._tiktokLoginBrowser.close().catch(() => {});
      router._tiktokLoginBrowser = null;
      router._tiktokLoginPage = null;
    }
    if (result && result.cookieString) {
       res.json({
         success: true,
         message: result.envWriteError
           ? `Cookie saved to memory but .env write failed: ${result.envWriteError}`
           : 'TikTok Login confirmed. Cookie saved to .env!',
         data: {
           cookie_saved: !result.envWriteError,
           env_write_error: result.envWriteError || null,
           cookie_length: result.cookieString.length,
           cookie_preview: result.cookieString.substring(0, 60) + '...',
         }
       });
    } else {
       res.status(400).json({ success: false, error: 'No TikTok cookies found in browser session. Did you log in?' });
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

// ─── TikTok Endpoints ────────────────────────────────────────

/**
 * POST /api/tiktok/video/parse
 * Queue a TikTok video parse job. Returns jobId.
 */
router.post('/tiktok/video/parse', authApi, deductCredits('credit_tiktok_video_parse', 10), async (req, res, next) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ success: false, error: 'Missing required field: url' });

    logger.info(`[API] Queue TikTok video parse: ${url}`);
    const jobId = await addJob('tiktok.video.parse', { url });

    res.json({ success: true, data: { jobId, message: 'Job queued. Poll GET /api/job/:jobId for result.' } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/tiktok/video/download
 * Queue a TikTok video parse, then client downloads from the returned URL
 */
router.post('/tiktok/video/download', authApi, deductCredits('credit_tiktok_video_download', 10), async (req, res, next) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ success: false, error: 'Missing required field: url' });

    logger.info(`[API] Queue TikTok video download: ${url}`);
    const jobId = await addJob('tiktok.video.parse', { url });

    res.json({ success: true, data: { jobId, message: 'Job queued. Poll GET /api/job/:jobId for download URL.' } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/tiktok/channel/videos
 * Queue a TikTok channel videos fetch job. Returns jobId.
 */
router.post('/tiktok/channel/videos', authApi, deductCredits('credit_tiktok_channel_videos', 20), async (req, res, next) => {
  try {
    const { url, count = 20, cursor = 0, since = null } = req.body;
    if (!url) return res.status(400).json({ success: false, error: 'Missing required field: url' });

    logger.info(`[API] Queue TikTok channel videos: ${url}, count: ${count}, since: ${since || 'all'}`);
    const jobId = await addJob('tiktok.channel.videos', { url, count, cursor, since });

    res.json({ success: true, data: { jobId, message: 'Job queued. Poll GET /api/job/:jobId for result.' } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/tiktok/channel/download
 * Start batch download (kept synchronous as it already has its own task system)
 */
router.post('/tiktok/channel/download', authApi, deductCredits('credit_tiktok_channel_download', 20), async (req, res, next) => {
  try {
    const { url, count = 10 } = req.body;
    if (!url) return res.status(400).json({ success: false, error: 'Missing required field: url' });
    if (count > 100) return res.status(400).json({ success: false, error: 'Count must be <= 100' });

    logger.info(`[API] TikTok Batch download: ${url}, count: ${count}`);
    const result = await downloaderService.startBatchDownload(url, count);

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/tiktok/free/parse
 * Parse a TikTok video URL (free, queued)
 */
const tiktokFreeApiLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 10, // Limit each IP to 10 requests per day
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Bạn đã đạt giới hạn dùng thử miễn phí (10 lần / ngày). Vui lòng đợi hoặc đăng ký tài khoản để sử dụng tiếp.',
  },
});

router.post('/tiktok/free/parse', tiktokFreeApiLimiter, async (req, res, next) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ success: false, error: 'Missing required field: url' });

    logger.info(`[FREE] Queue TikTok parse video: ${url}`);
    const jobId = await addJob('tiktok.video.parse', { url });

    res.json({ success: true, data: { jobId } });
  } catch (err) {
    next(err);
  }
});

// ─── TikTok Media Proxy (bypass TikTok anti-hotlink) ─────────

/**
 * GET /api/tiktok/proxy/media?url=<encoded_tiktok_cdn_url>&dl=1
 * Streams TikTok CDN content through our server.
 * Uses browser session cookies to bypass TikTok anti-hotlink 403.
 */
router.get('/tiktok/proxy/media', async (req, res) => {
  try {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ success: false, error: 'Missing url param' });

    let parsed;
    try { parsed = new URL(targetUrl); } catch { return res.status(400).json({ success: false, error: 'Invalid URL' }); }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ success: false, error: 'Invalid protocol' });
    }

    logger.info(`[TikTok Proxy] Streaming: ${parsed.hostname}${parsed.pathname.substring(0, 60)}...`);

    const config = require('../config');
    const cookieStr = config.tiktokCookie || '';

    // Full browser-like headers — TikTok CDN validates these
    const browserHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'identity',
      'Referer': 'https://www.tiktok.com/',
      'Origin': 'https://www.tiktok.com',
      'sec-ch-ua': '"Chromium";v="131", "Google Chrome";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'video',
      'sec-fetch-mode': 'no-cors',
      'sec-fetch-site': 'cross-site',
      'Range': 'bytes=0-',
    };

    // Try with cookie first (needed for downloadAddr / no-watermark URLs)
    const tryFetch = async (withCookie) => {
      const headers = { ...browserHeaders };
      if (withCookie && cookieStr) headers['Cookie'] = cookieStr;
      const r = await fetch(targetUrl, { headers, redirect: 'follow' });
      logger.info(`[TikTok Proxy] ${withCookie ? 'with' : 'without'} cookie → ${r.status}`);
      return r;
    };

    let upstream = await tryFetch(true);

    // 403 with cookie → try without (some public CDN nodes block cookie)
    if ((upstream.status === 403 || upstream.status === 400) && cookieStr) {
      upstream = await tryFetch(false);
    }

    if (!upstream.ok && upstream.status !== 206) {
      logger.error(`[TikTok Proxy] Failed: ${upstream.status} for ${targetUrl.substring(0, 120)}`);
      return res.status(upstream.status).json({ success: false, error: `CDN returned ${upstream.status}` });
    }

    const ct = upstream.headers.get('content-type') || 'video/mp4';
    res.setHeader('Content-Type', ct);
    const cl = upstream.headers.get('content-length');
    if (cl) res.setHeader('Content-Length', cl);
    if (upstream.status === 206) res.setHeader('Accept-Ranges', 'bytes');

    if (req.query.dl === '1') {
      res.setHeader('Content-Disposition', 'attachment; filename="tiktok_video.mp4"');
    }
    res.setHeader('Cache-Control', 'public, max-age=1800');

    const { Readable } = require('stream');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    logger.error(`[TikTok Proxy] Error: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Proxy error' });
    }
  }
});

module.exports = router;
