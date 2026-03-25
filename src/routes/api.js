const express = require('express');
const router = express.Router();
const douyinService = require('../services/douyin');
const downloaderService = require('../services/downloader');
const logger = require('../utils/logger');

/**
 * POST /api/video/parse
 * Parse a single Douyin video URL and return video details
 */
router.post('/video/parse', async (req, res, next) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: url',
      });
    }

    logger.info(`[API] Parse video: ${url}`);
    const result = await douyinService.parseVideo(url);

    res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/video/download
 * Download a single Douyin video (streams back as mp4)
 */
router.post('/video/download', async (req, res, next) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: url',
      });
    }

    logger.info(`[API] Download video: ${url}`);

    // Parse video to get download URL
    const videoInfo = await douyinService.parseVideo(url);

    if (!videoInfo.download_url) {
      return res.status(404).json({
        success: false,
        error: 'Could not find video download URL',
      });
    }

    // Set filename from title
    const filename = videoInfo.title
      ? `${videoInfo.title.substring(0, 50)}.mp4`
      : `douyin_${videoInfo.video_id}.mp4`;

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(filename)}"`
    );

    await downloaderService.streamVideoToResponse(videoInfo.download_url, res);
  } catch (err) {
    // If headers are already sent, we can't send JSON error
    if (res.headersSent) {
      logger.error(`Stream error: ${err.message}`);
      res.end();
    } else {
      next(err);
    }
  }
});

/**
 * POST /api/channel/videos
 * Get list of videos from a Douyin user/channel
 */
router.post('/channel/videos', async (req, res, next) => {
  try {
    const { url, count = 20, cursor = 0 } = req.body;

    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: url',
      });
    }

    logger.info(`[API] Get channel videos: ${url}, count: ${count}`);
    const result = await douyinService.getUserVideos(url, count, cursor);

    res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/channel/download
 * Start batch download of videos from a channel
 */
router.post('/channel/download', async (req, res, next) => {
  try {
    const { url, count = 10 } = req.body;

    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: url',
      });
    }

    if (count > 100) {
      return res.status(400).json({
        success: false,
        error: 'Count must be <= 100',
      });
    }

    logger.info(`[API] Batch download: ${url}, count: ${count}`);
    const result = await downloaderService.startBatchDownload(url, count);

    res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/task/:taskId
 * Check status of a batch download task
 */
router.get('/task/:taskId', (req, res) => {
  const task = downloaderService.getTaskStatus(req.params.taskId);

  if (!task) {
    return res.status(404).json({
      success: false,
      error: 'Task not found',
    });
  }

  res.json({
    success: true,
    data: task,
  });
});

/**
 * GET /api/tasks
 * List all download tasks
 */
router.get('/tasks', (_req, res) => {
  const tasks = downloaderService.listTasks();
  res.json({
    success: true,
    data: tasks,
  });
});

/**
 * GET /api/health
 * Health check endpoint
 */
router.get('/health', (_req, res) => {
  res.json({
    success: true,
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

// ─── Auth / Cookie Management ────────────────────────────────

/**
 * GET /api/auth/status
 * Check if Douyin session/cookies are valid
 */
router.get('/auth/status', async (_req, res, next) => {
  try {
    logger.info('[API] Checking auth status...');
    const status = await douyinService.checkSession();
    res.json({
      success: true,
      data: status,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/auth/login
 * Open a visible browser for user to log in to Douyin.
 * Cookies are auto-saved to persistent profile.
 */
router.get('/auth/login', async (_req, res, next) => {
  try {
    logger.info('[API] Opening login browser...');
    const { browser, page } = await douyinService.openLoginBrowser();

    res.json({
      success: true,
      message:
        'Trình duyệt đã mở. Hãy đăng nhập Douyin, sau đó gọi GET /api/auth/confirm để lưu cookie.',
    });

    // Store references for confirm endpoint
    router._loginBrowser = browser;
    router._loginPage = page;
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/auth/confirm
 * Confirm login is done, close the visible browser. Cookies are already saved.
 */
router.get('/auth/confirm', async (_req, res, next) => {
  try {
    if (router._loginBrowser) {
      await router._loginBrowser.close();
      router._loginBrowser = null;
      router._loginPage = null;
      logger.info('[API] Login browser closed. Cookies saved to profile.');
    }

    // Verify session
    const status = await douyinService.checkSession();
    res.json({
      success: true,
      message: 'Đăng nhập thành công! Cookie đã được lưu tự động.',
      data: status,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/inject
 * Migrate cookies from .env DOUYIN_COOKIE into persistent browser profile
 */
router.post('/auth/inject', async (_req, res, next) => {
  try {
    logger.info('[API] Injecting .env cookies into browser profile...');
    const result = await douyinService.injectEnvCookies();
    if (result) {
      const status = await douyinService.checkSession();
      res.json({
        success: true,
        message: 'Cookie từ .env đã được import vào browser profile.',
        data: status,
      });
    } else {
      res.status(400).json({
        success: false,
        error: 'DOUYIN_COOKIE trong .env trống hoặc chưa được cấu hình.',
      });
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;

