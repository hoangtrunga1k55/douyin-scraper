const express = require('express');
const router = express.Router();
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
    const { url, count = 20, cursor = 0 } = req.body;
    if (!url) return res.status(400).json({ success: false, error: 'Missing required field: url' });

    logger.info(`[API] Queue channel videos: ${url}, count: ${count}`);
    const jobId = await addJob('channel.videos', { url, count, cursor });

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
router.post('/free/parse', async (req, res, next) => {
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

module.exports = router;
