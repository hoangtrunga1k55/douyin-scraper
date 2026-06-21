require('dotenv').config();
const path = require('path');

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/douyindb',

  // Douyin cookie - optional, persistent browser profile is preferred
  douyinCookie: process.env.DOUYIN_COOKIE || '',

  // Persistent browser profile directory (auto-saves cookies)
  browserDataDir: process.env.BROWSER_DATA_DIR || path.join(__dirname, '..', '.browser_data'),

  // Download settings
  downloadDir: process.env.DOWNLOAD_DIR || './downloads',
  maxConcurrentDownloads: parseInt(process.env.MAX_CONCURRENT_DOWNLOADS, 10) || 1,
  requestTimeout: parseInt(process.env.REQUEST_TIMEOUT, 10) || 30000,

  // Browser lifecycle
  browserIdleTimeoutMs: parseInt(process.env.BROWSER_IDLE_TIMEOUT_MS, 10) || 300000,

  // Proxy settings
  httpProxy: process.env.HTTP_PROXY || process.env.HTTPS_PROXY || null,

  // Douyin base URLs
  douyin: {
    baseUrl: 'https://www.douyin.com',
    apiBaseUrl: 'https://www.douyin.com/aweme/v1/web',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  },

  // TikTok base URLs
  tiktok: {
    baseUrl: 'https://www.tiktok.com',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  },

  // TikTok cookie - bypasses captcha
  tiktokCookie: process.env.TIKTOK_COOKIE || '',

  // TikTok persistent browser profile (separate from Douyin)
  tiktokBrowserDataDir: process.env.TIKTOK_BROWSER_DATA_DIR || path.join(__dirname, '..', '.browser_data_tiktok'),

  // Base URL for generating proxy links in API responses
  serverBaseUrl: process.env.SERVER_BASE_URL || 'http://localhost:3000',

  // Telegram Notifications
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },
};

module.exports = config;

