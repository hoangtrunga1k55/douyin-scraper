require('dotenv').config();
const path = require('path');

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,

  // Douyin cookie - optional, persistent browser profile is preferred
  douyinCookie: process.env.DOUYIN_COOKIE || '',

  // Persistent browser profile directory (auto-saves cookies)
  browserDataDir: process.env.BROWSER_DATA_DIR || path.join(__dirname, '..', '.browser_data'),

  // Download settings
  downloadDir: process.env.DOWNLOAD_DIR || './downloads',
  maxConcurrentDownloads: parseInt(process.env.MAX_CONCURRENT_DOWNLOADS, 10) || 3,
  requestTimeout: parseInt(process.env.REQUEST_TIMEOUT, 10) || 30000,

  // Proxy settings
  httpProxy: process.env.HTTP_PROXY || process.env.HTTPS_PROXY || null,

  // Douyin base URLs
  douyin: {
    baseUrl: 'https://www.douyin.com',
    apiBaseUrl: 'https://www.douyin.com/aweme/v1/web',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  },
};

module.exports = config;

