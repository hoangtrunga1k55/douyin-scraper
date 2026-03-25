const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const logger = require('../utils/logger');
const { sanitizeFilename, formatBytes } = require('../utils/helpers');
const douyinService = require('./douyin');

// In-memory task store
const tasks = new Map();

/**
 * Download a single video and stream it to the response
 */
async function streamVideoToResponse(downloadUrl, res) {
  if (!downloadUrl) {
    throw new Error('No download URL available');
  }

  logger.info(`Streaming video from: ${downloadUrl.substring(0, 100)}...`);

  const response = await axios({
    method: 'GET',
    url: downloadUrl,
    responseType: 'stream',
    timeout: 120000,
    headers: {
      'User-Agent': config.douyin.userAgent,
      Referer: config.douyin.baseUrl,
    },
  });

  const contentLength = response.headers['content-length'];
  const contentType = response.headers['content-type'] || 'video/mp4';

  res.setHeader('Content-Type', contentType);
  if (contentLength) {
    res.setHeader('Content-Length', contentLength);
  }
  res.setHeader('Content-Disposition', 'attachment; filename="douyin_video.mp4"');

  response.data.pipe(res);

  return new Promise((resolve, reject) => {
    response.data.on('end', resolve);
    response.data.on('error', reject);
  });
}

/**
 * Download a single video to disk
 */
async function downloadVideoToDisk(downloadUrl, outputDir, filename) {
  if (!downloadUrl) {
    throw new Error('No download URL available');
  }

  // Ensure output directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  const safeFilename = sanitizeFilename(filename) + '.mp4';
  const outputPath = path.join(outputDir, safeFilename);

  logger.info(`Downloading video to: ${outputPath}`);

  const response = await axios({
    method: 'GET',
    url: downloadUrl,
    responseType: 'stream',
    timeout: 120000,
    headers: {
      'User-Agent': config.douyin.userAgent,
      Referer: config.douyin.baseUrl,
    },
  });

  const writer = fs.createWriteStream(outputPath);
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', () => {
      const stats = fs.statSync(outputPath);
      logger.info(`Downloaded: ${safeFilename} (${formatBytes(stats.size)})`);
      resolve({
        filename: safeFilename,
        path: outputPath,
        size: stats.size,
        size_formatted: formatBytes(stats.size),
      });
    });
    writer.on('error', reject);
  });
}

/**
 * Start a batch download task for channel videos
 */
async function startBatchDownload(userUrl, count = 10) {
  const taskId = uuidv4();

  const task = {
    task_id: taskId,
    status: 'starting',
    url: userUrl,
    requested: count,
    total: 0,
    progress: 0,
    completed: [],
    errors: [],
    created_at: new Date().toISOString(),
  };

  tasks.set(taskId, task);

  // Run download in background
  processBatchDownload(taskId, userUrl, count).catch((err) => {
    logger.error(`Batch download task ${taskId} failed: ${err.message}`);
    const t = tasks.get(taskId);
    if (t) {
      t.status = 'failed';
      t.error = err.message;
    }
  });

  return { task_id: taskId, status: 'started' };
}

/**
 * Process batch download (runs asynchronously)
 */
async function processBatchDownload(taskId, userUrl, count) {
  const task = tasks.get(taskId);
  if (!task) return;

  try {
    // Get video list
    task.status = 'fetching_videos';
    const result = await douyinService.getUserVideos(userUrl, count);
    const videos = result.videos;
    task.total = videos.length;
    task.user = result.user;
    task.status = 'downloading';

    logger.info(`Batch download: found ${videos.length} videos for task ${taskId}`);

    // Create task-specific directory
    const taskDir = path.join(
      config.downloadDir,
      sanitizeFilename(result.user?.nickname || 'unknown') + '_' + taskId.substring(0, 8)
    );

    // Download videos with concurrency control
    const concurrency = config.maxConcurrentDownloads;
    for (let i = 0; i < videos.length; i += concurrency) {
      const batch = videos.slice(i, i + concurrency);
      const promises = batch.map(async (video, idx) => {
        const index = i + idx + 1;
        try {
          const filename = `${String(index).padStart(3, '0')}_${video.video_id}_${video.title || 'video'}`;

          if (!video.download_url) {
            // Parse video again to get download URL
            const parsed = await douyinService.parseVideo(
              `${config.douyin.baseUrl}/video/${video.video_id}`
            );
            video.download_url = parsed.download_url;
          }

          const result = await downloadVideoToDisk(
            video.download_url,
            taskDir,
            filename
          );

          task.progress++;
          task.completed.push({
            video_id: video.video_id,
            title: video.title,
            ...result,
          });
        } catch (err) {
          logger.error(
            `Failed to download video ${video.video_id}: ${err.message}`
          );
          task.progress++;
          task.errors.push({
            video_id: video.video_id,
            title: video.title,
            error: err.message,
          });
        }
      });

      await Promise.all(promises);
    }

    task.status = 'completed';
    task.completed_at = new Date().toISOString();
    logger.info(
      `Batch download complete: ${task.completed.length}/${task.total} succeeded`
    );
  } catch (err) {
    task.status = 'failed';
    task.error = err.message;
    throw err;
  }
}

/**
 * Get task status
 */
function getTaskStatus(taskId) {
  return tasks.get(taskId) || null;
}

/**
 * List all tasks
 */
function listTasks() {
  return Array.from(tasks.values()).map((t) => ({
    task_id: t.task_id,
    status: t.status,
    progress: t.progress,
    total: t.total,
    created_at: t.created_at,
  }));
}

module.exports = {
  streamVideoToResponse,
  downloadVideoToDisk,
  startBatchDownload,
  getTaskStatus,
  listTasks,
};
