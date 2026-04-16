const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const logger = require('../utils/logger');
const crypto = require('crypto');

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT, 10) || 6379;

const connection = new IORedis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  maxRetriesPerRequest: null, // required by BullMQ
});

// ─── Queue ───────────────────────────────────────────────────
const douyinQueue = new Queue('douyin-jobs', { connection });

// ─── Worker ──────────────────────────────────────────────────
let worker = null;

function startWorker(douyinService, tiktokService) {
  worker = new Worker('douyin-jobs', async (job) => {
    const { type, url, count, cursor, since } = job.data;
    logger.info(`[Queue] Processing job ${job.id}: ${type} - ${url}`);

    switch (type) {
      case 'video.parse': {
        const result = await douyinService.parseVideo(url);
        return result;
      }
      case 'channel.videos': {
        const result = await douyinService.getUserVideos(url, count || 20, cursor || 0, since);
        return result;
      }
      // ─── TikTok Job Types ───────────────────────
      case 'tiktok.video.parse': {
        const result = await tiktokService.parseVideo(url);
        return result;
      }
      case 'tiktok.channel.videos': {
        const result = await tiktokService.getUserVideos(url, count || 20, cursor || 0, since);
        return result;
      }
      default:
        throw new Error(`Unknown job type: ${type}`);
    }
  }, {
    connection,
    concurrency: 2, // Process max 2 jobs at a time
    limiter: {
      max: 5,
      duration: 10000, // Max 5 jobs per 10 seconds
    },
  });

  worker.on('completed', (job) => {
    logger.info(`[Queue] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`[Queue] Job ${job?.id} failed: ${err.message}`);
  });

  logger.info('✅ Queue worker started (concurrency: 2)');
  return worker;
}

// ─── Helper: Add job and return job ID ───────────────────────
async function addJob(type, data, opts = {}) {
  const jobId = crypto.randomUUID();
  const job = await douyinQueue.add(type, { type, ...data }, {
    jobId,
    removeOnComplete: { age: 3600 }, // Keep completed jobs for 1 hour
    removeOnFail: { age: 3600 },
    attempts: 2,
    backoff: { type: 'exponential', delay: 3000 },
    ...opts,
  });
  return job.id;
}

// ─── Helper: Get job result ──────────────────────────────────
async function getJobStatus(jobId) {
  const job = await douyinQueue.getJob(jobId);
  if (!job) return null;

  const state = await job.getState();
  const result = {
    id: job.id,
    state, // 'waiting' | 'active' | 'completed' | 'failed' | 'delayed'
    progress: job.progress,
    data: job.data,
  };

  if (state === 'completed') {
    result.result = job.returnvalue;
  } else if (state === 'failed') {
    result.error = job.failedReason;
  }

  return result;
}

module.exports = { douyinQueue, startWorker, addJob, getJobStatus };
