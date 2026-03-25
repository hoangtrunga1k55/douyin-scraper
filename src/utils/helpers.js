/**
 * Extract video ID from various Douyin URL formats:
 * - https://www.douyin.com/video/7000000000000000000
 * - https://www.douyin.com/note/7000000000000000000
 * - https://v.douyin.com/xxxxx/
 * - Douyin share text containing a URL
 */
function extractVideoId(url) {
  if (!url) return null;

  // Match /video/ID or /note/ID pattern
  const videoMatch = url.match(/(?:video|note)\/(\d+)/);
  if (videoMatch) return videoMatch[1];

  // Match modal_id parameter
  const modalMatch = url.match(/modal_id=(\d+)/);
  if (modalMatch) return modalMatch[1];

  return null;
}

/**
 * Extract sec_uid from Douyin user profile URL:
 * - https://www.douyin.com/user/MS4wLjABAAAAxxxxxx
 * - https://www.douyin.com/user/MS4wLjABAAAAxxxxxx?...
 */
function extractSecUid(url) {
  if (!url) return null;

  const match = url.match(/\/user\/([A-Za-z0-9_-]+)/);
  if (match) return match[1];

  return null;
}

/**
 * Check if a URL is a Douyin short link (v.douyin.com)
 */
function isShortLink(url) {
  return /v\.douyin\.com/.test(url);
}

/**
 * Check if URL is a Douyin video URL
 */
function isVideoUrl(url) {
  return /douyin\.com\/(video|note)\/\d+/.test(url) || isShortLink(url);
}

/**
 * Check if URL is a Douyin user profile URL
 */
function isUserUrl(url) {
  return /douyin\.com\/user\//.test(url);
}

/**
 * Extract URL from Douyin share text
 * e.g., "7.05 Eih:/ 复制打开抖音... https://v.douyin.com/xxxxx/"
 */
function extractUrlFromShareText(text) {
  if (!text) return null;

  const urlMatch = text.match(
    /https?:\/\/(?:www\.)?(?:v\.)?douyin\.com\/[^\s]+/
  );
  return urlMatch ? urlMatch[0] : null;
}

/**
 * Sanitize filename for filesystem
 */
function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, 200);
}

/**
 * Format file size
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

module.exports = {
  extractVideoId,
  extractSecUid,
  isShortLink,
  isVideoUrl,
  isUserUrl,
  extractUrlFromShareText,
  sanitizeFilename,
  formatBytes,
};
