const axios = require('axios');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');
const config = require('../config');
const logger = require('../utils/logger');
const {
  extractVideoId,
  extractSecUid,
  isShortLink,
  extractUrlFromShareText,
} = require('../utils/helpers');

// Shared axios instance with default Douyin headers
const httpClient = axios.create({
  timeout: config.requestTimeout,
  headers: {
    'User-Agent': config.douyin.userAgent,
    Referer: config.douyin.baseUrl,
    Cookie: config.douyinCookie,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  },
  maxRedirects: 5,
});

let browserInstance = null;

/**
 * Get or launch a shared Puppeteer browser instance.
 * Uses userDataDir for persistent cookies — survive restarts, auto-refresh on page loads.
 */
async function getBrowser() {
  if (!browserInstance || !browserInstance.isConnected()) {
    // Ensure browser data dir exists
    fs.mkdirSync(config.browserDataDir, { recursive: true });

    const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || null;
    logger.info(`Launching Puppeteer (profile: ${config.browserDataDir}${execPath ? ', chromium: ' + execPath : ''})...`);
    browserInstance = await puppeteer.launch({
      headless: 'new',
      userDataDir: config.browserDataDir,
      executablePath: execPath || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--lang=zh-CN',
      ],
    });
  }
  return browserInstance;
}

/**
 * Close the browser instance
 */
async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

/**
 * Open a VISIBLE browser for the user to log in to Douyin.
 * Cookies are saved to the persistent profile automatically.
 * Returns a Promise that resolves when login is confirmed.
 */
async function openLoginBrowser() {
  // Close headless browser first (can't share userDataDir)
  await closeBrowser();

  fs.mkdirSync(config.browserDataDir, { recursive: true });

  logger.info('Opening login browser (visible)...');
  const loginBrowser = await puppeteer.launch({
    headless: false,
    userDataDir: config.browserDataDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1280,800',
      '--lang=zh-CN',
    ],
    defaultViewport: { width: 1280, height: 800 },
  });

  const page = await loginBrowser.newPage();
  await page.goto('https://www.douyin.com', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  return { browser: loginBrowser, page };
}

/**
 * Check if we have a valid Douyin session (cookies present in profile).
 */
async function checkSession() {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.goto('https://www.douyin.com', {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });

    const cookies = await page.cookies('https://www.douyin.com');
    const hasTtwid = cookies.some((c) => c.name === 'ttwid');
    const hasSessionId = cookies.some((c) => c.name === 'sessionid' || c.name === 'sessionid_ss');
    const cookieCount = cookies.length;

    // Also check if we get a logged-in user
    const isLoggedIn = await page.evaluate(() => {
      const renderEl = document.getElementById('RENDER_DATA');
      if (renderEl) {
        try {
          const decoded = decodeURIComponent(renderEl.textContent);
          const parsed = JSON.parse(decoded);
          for (const val of Object.values(parsed)) {
            if (val?.user?.isLogin !== undefined) {
              return val.user.isLogin;
            }
          }
        } catch (e) {}
      }
      return false;
    });

    return {
      valid: hasTtwid && cookieCount > 5,
      logged_in: isLoggedIn,
      cookie_count: cookieCount,
      has_ttwid: hasTtwid,
      has_session: hasSessionId,
    };
  } finally {
    await page.close();
  }
}

/**
 * Inject .env cookies into the persistent browser profile (one-time migration).
 */
async function injectEnvCookies() {
  if (!config.douyinCookie || config.douyinCookie === 'your_douyin_cookie_here') {
    return false;
  }

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    const cookies = parseCookieString(config.douyinCookie);
    if (cookies.length > 0) {
      await page.setCookie(...cookies);
      logger.info(`Injected ${cookies.length} cookies from .env into browser profile`);

      // Visit Douyin to refresh/validate cookies
      await page.goto('https://www.douyin.com', {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      await new Promise((r) => setTimeout(r, 2000));

      return true;
    }
  } finally {
    await page.close();
  }
  return false;
}

/**
 * Resolve a Douyin short link (v.douyin.com) to the full URL
 */
async function resolveShortLink(shortUrl) {
  try {
    const response = await axios.get(shortUrl, {
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
      headers: {
        'User-Agent': config.douyin.userAgent,
      },
      timeout: 10000,
    });

    const location = response.headers.location || response.request?.res?.responseUrl;
    if (location) {
      logger.info(`Resolved short link: ${shortUrl} -> ${location}`);
      return location;
    }

    return shortUrl;
  } catch (error) {
    if (error.response && error.response.headers.location) {
      logger.info(
        `Resolved short link (via redirect): ${shortUrl} -> ${error.response.headers.location}`
      );
      return error.response.headers.location;
    }
    throw new Error(`Failed to resolve short link: ${error.message}`);
  }
}

/**
 * Parse a single Douyin video URL and return video details.
 */
async function parseVideo(inputUrl) {
  let url = inputUrl.trim();

  // Extract URL from share text if needed
  const extractedUrl = extractUrlFromShareText(url);
  if (extractedUrl) url = extractedUrl;

  // Resolve short links
  if (isShortLink(url)) {
    url = await resolveShortLink(url);
  }

  const videoId = extractVideoId(url);
  if (!videoId) {
    throw Object.assign(new Error('Could not extract video ID from URL'), {
      name: 'ValidationError',
    });
  }

  logger.info(`Parsing video: ${videoId}`);
  return await parseVideoViaPuppeteer(videoId);
}

/**
 * Parse video using Puppeteer with network interception.
 */
async function parseVideoViaPuppeteer(videoId) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  let interceptedDetail = null;
  let filterInfo = null;

  try {
    await page.setUserAgent(config.douyin.userAgent);
    await page.setViewport({ width: 1920, height: 1080 });

    // Intercept network responses to capture API data
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('/aweme/v1/web/aweme/detail/') && url.includes(videoId)) {
        try {
          const json = await response.json();
          if (json.aweme_detail) {
            interceptedDetail = json.aweme_detail;
            logger.info(`Intercepted aweme detail for video ${videoId}`);
          } else if (json.filter_detail) {
            filterInfo = json.filter_detail;
            logger.warn(
              `Video ${videoId} is filtered: ${json.filter_detail.filter_reason}`
            );
          }
        } catch (e) {}
      }
    });

    const videoUrl = `${config.douyin.baseUrl}/video/${videoId}`;
    logger.info(`Loading page: ${videoUrl}`);

    await page.goto(videoUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.requestTimeout,
    });

    // Poll for intercepted data (max 15 seconds)
    const startTime = Date.now();
    const maxWait = 15000;
    while (Date.now() - startTime < maxWait) {
      if (interceptedDetail) {
        return formatVideoDetail(interceptedDetail);
      }
      if (filterInfo) {
        const reason = filterInfo.filter_reason || 'unknown';
        const msg = filterInfo.detail_msg || '';
        throw Object.assign(
          new Error(
            `Video bị chặn bởi Douyin (lý do: ${reason}). ${msg}. Video này có thể bị giới hạn vùng (chỉ xem được từ Trung Quốc) hoặc đã bị xóa.`
          ),
          { name: 'VideoFilteredError', statusCode: 403 }
        );
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    // Final check after polling
    if (interceptedDetail) {
      return formatVideoDetail(interceptedDetail);
    }
    if (filterInfo) {
      const reason = filterInfo.filter_reason || 'unknown';
      throw Object.assign(
        new Error(
          `Video bị chặn bởi Douyin (lý do: ${reason}). Video này có thể bị giới hạn vùng hoặc đã bị xóa.`
        ),
        { name: 'VideoFilteredError', statusCode: 403 }
      );
    }

    // Fallback: Try RENDER_DATA
    logger.info('No intercepted data, trying RENDER_DATA...');
    const pageData = await page.evaluate(() => {
      const result = {};

      const renderEl = document.getElementById('RENDER_DATA');
      if (renderEl) {
        try {
          const decoded = decodeURIComponent(renderEl.textContent);
          const parsed = JSON.parse(decoded);

          for (const [key, value] of Object.entries(parsed)) {
            if (value && typeof value === 'object') {
              if (value.videoDetail) {
                result.videoDetail = value.videoDetail;
                break;
              }
              if (value.awemeDetail) {
                result.videoDetail = value.awemeDetail;
                break;
              }
              if (value.loaderData) {
                for (const loaderVal of Object.values(value.loaderData)) {
                  if (loaderVal?.awemeDetail) {
                    result.videoDetail = loaderVal.awemeDetail;
                    break;
                  }
                }
                if (result.videoDetail) break;
              }
            }
          }

          for (const [key, value] of Object.entries(parsed)) {
            if (value?.isOverSea !== undefined) {
              result.isOverSea = value.isOverSea;
              result.country = value.country;
              break;
            }
          }
        } catch (e) {
          result.renderError = e.message;
        }
      }

      const videoEl = document.querySelector('video');
      if (videoEl) {
        const sourceEl = videoEl.querySelector('source');
        result.videoSrc = sourceEl?.src || videoEl.src || null;
      }

      result.title = document.title || '';
      const authorEl = document.querySelector(
        '[data-e2e="user-info"] .J_nickname, span[class*="author-name"], [class*="authorName"], a[class*="author"]'
      );
      result.author = authorEl?.textContent?.trim() || '';

      return result;
    });

    if (pageData.videoDetail) {
      return formatVideoDetail(pageData.videoDetail);
    }

    const overseasHint = pageData.isOverSea
      ? ' Bạn đang truy cập từ ngoài Trung Quốc — cần proxy IP Trung Quốc.'
      : '';

    if (pageData.videoSrc) {
      return {
        video_id: videoId,
        title: pageData.title || 'Unknown',
        author: { nickname: pageData.author || 'Unknown' },
        download_url: pageData.videoSrc,
        cover_url: null,
        duration: 0,
        create_time: null,
        statistics: { likes: 0, comments: 0, shares: 0, plays: 0, collects: 0 },
        note: 'Limited data - extracted from DOM',
      };
    }

    throw Object.assign(
      new Error(
        `Không thể lấy dữ liệu video.${overseasHint} Cookie có thể đã hết hạn — thử GET /api/auth/login.`
      ),
      { statusCode: 404 }
    );
  } finally {
    await page.close();
  }
}

/**
 * Format raw aweme detail into a clean response object
 */
function formatVideoDetail(detail) {
  const video = detail.video || {};
  const author = detail.author || {};
  const statistics = detail.statistics || {};

  let downloadUrl = null;
  if (video.play_addr?.url_list?.length > 0) {
    downloadUrl = video.play_addr.url_list[0];
  }
  if (!downloadUrl && video.bit_rate?.length > 0) {
    const sortedBitrates = [...video.bit_rate].sort(
      (a, b) => (b.bit_rate || 0) - (a.bit_rate || 0)
    );
    const best = sortedBitrates[0];
    if (best?.play_addr?.url_list?.length > 0) {
      downloadUrl = best.play_addr.url_list[0];
    }
  }
  if (downloadUrl) {
    downloadUrl = downloadUrl
      .replace(/^https?:\/\//, 'https://')
      .replace('playwm', 'play');
  }

  let coverUrl = null;
  if (video.cover?.url_list?.length > 0) {
    coverUrl = video.cover.url_list[0];
  } else if (video.origin_cover?.url_list?.length > 0) {
    coverUrl = video.origin_cover.url_list[0];
  }

  return {
    video_id: detail.aweme_id || String(detail.awemeId || ''),
    title: detail.desc || '',
    author: {
      nickname: author.nickname || '',
      uid: author.uid || '',
      sec_uid: author.sec_uid || '',
      avatar: author.avatar_thumb?.url_list?.[0] || '',
    },
    download_url: downloadUrl,
    cover_url: coverUrl,
    duration: video.duration ? Math.round(video.duration / 1000) : 0,
    create_time: detail.create_time
      ? new Date(detail.create_time * 1000).toISOString()
      : null,
    statistics: {
      likes: statistics.digg_count || 0,
      comments: statistics.comment_count || 0,
      shares: statistics.share_count || 0,
      plays: statistics.play_count || 0,
      collects: statistics.collect_count || 0,
    },
  };
}

/**
 * Get list of videos from a Douyin user profile.
 * Strategy: Direct API call with browser cookies (bypasses captcha).
 */
async function getUserVideos(inputUrl, count = 20, cursor = 0) {
  let url = inputUrl.trim();

  if (isShortLink(url)) {
    url = await resolveShortLink(url);
  }

  const secUid = extractSecUid(url);
  if (!secUid) {
    throw Object.assign(
      new Error('Could not extract sec_uid from user profile URL'),
      { name: 'ValidationError' }
    );
  }

  logger.info(`Fetching videos for user: ${secUid}, count: ${count}, cursor: ${cursor}`);

  // Get cookies from persistent browser profile
  const cookieStr = await getCookieString();
  if (!cookieStr) {
    throw new Error('Không có cookie. Hãy đăng nhập: GET /api/auth/login rồi GET /api/auth/confirm');
  }

  // Direct API call (bypasses captcha entirely)
  try {
    return await getUserVideosViaAPI(secUid, count, cursor, cookieStr);
  } catch (err) {
    logger.warn(`Direct API failed: ${err.message}`);
  }

  // Fallback: try Puppeteer page loading
  return await getUserVideosViaPuppeteer(secUid, url, count, cursor);
}

/**
 * Extract cookie string from persistent browser profile.
 */
async function getCookieString() {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    const cookies = await browser.cookies('https://www.douyin.com');
    if (cookies.length === 0) return null;
    return cookies.map(c => `${c.name}=${c.value}`).join('; ');
  } finally {
    await page.close();
  }
}

/**
 * Fetch user videos via browser-context API call.
 * Auto-paginates until the requested count is reached.
 */
async function getUserVideosViaAPI(secUid, count, cursor, cookieStr) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setUserAgent(config.douyin.userAgent);

    // Navigate to homepage first (establishing session context)
    logger.info('Loading Douyin homepage for API context...');
    await page.goto(config.douyin.baseUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    }).catch(() => {
      logger.warn('Homepage load timed out, continuing with existing session...');
    });
    await new Promise((r) => setTimeout(r, 2000));

    // Auto-paginate until we have enough videos
    const allPosts = [];
    let currentCursor = cursor;
    let hasMore = true;
    const maxPages = 10; // Safety limit

    for (let pageNum = 0; pageNum < maxPages && allPosts.length < count && hasMore; pageNum++) {
      logger.info(`Calling user posts API (page ${pageNum + 1}, cursor: ${currentCursor}, have: ${allPosts.length}/${count})`);

      const apiResult = await page.evaluate(async (params) => {
        const { secUid, count, cursor } = params;
        const url = new URL('https://www.douyin.com/aweme/v1/web/aweme/post/');
        url.searchParams.set('sec_user_id', secUid);
        url.searchParams.set('count', count);
        url.searchParams.set('max_cursor', cursor);
        url.searchParams.set('aid', '6383');
        url.searchParams.set('cookie_enabled', 'true');
        url.searchParams.set('platform', 'PC');
        url.searchParams.set('device_platform', 'webapp');

        try {
          const res = await fetch(url.toString(), {
            method: 'GET',
            credentials: 'include',
            headers: { Accept: 'application/json' },
          });
          const text = await res.text();
          try {
            return { ok: true, data: JSON.parse(text) };
          } catch (e) {
            return { ok: false, error: `Not JSON: ${text.substring(0, 300)}` };
          }
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }, { secUid, count: Math.min(count, 35), cursor: currentCursor });

      if (!apiResult.ok) {
        if (allPosts.length > 0) break; // Got some data, return it
        throw new Error(`Browser-context API error: ${apiResult.error}`);
      }

      const data = apiResult.data;
      if (!data || data.status_code !== 0) {
        if (allPosts.length > 0) break;
        throw new Error(`API status error: ${data?.status_msg || data?.status_code || 'unknown'}`);
      }

      const awemeList = data.aweme_list || [];
      if (awemeList.length === 0) {
        if (allPosts.length > 0) break;
        throw new Error('API returned empty video list');
      }

      allPosts.push(...awemeList);
      hasMore = !!data.has_more;
      currentCursor = data.max_cursor || 0;

      logger.info(`Got ${awemeList.length} videos (total: ${allPosts.length}/${count})`);

      // Small delay between pages to avoid rate limiting
      if (allPosts.length < count && hasMore) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    const videos = allPosts.slice(0, count).map((item) => formatVideoDetail(item));

    let userInfo = {};
    if (allPosts[0]?.author) {
      const author = allPosts[0].author;
      userInfo = {
        nickname: author.nickname || '',
        uid: author.uid || '',
        sec_uid: secUid,
        avatar: author.avatar_thumb?.url_list?.[0] || '',
        signature: author.signature || '',
      };
    }

    return {
      user: userInfo,
      videos,
      has_more: hasMore && allPosts.length >= count,
      cursor: currentCursor,
      total: videos.length,
    };
  } finally {
    await page.close();
  }
}

/**
 * Fetch user videos via Puppeteer (fallback if direct API fails).
 */
async function getUserVideosViaPuppeteer(secUid, profileUrl, count, cursor = 0) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  const interceptedPosts = [];
  let interceptedUserInfo = null;

  try {
    await page.setUserAgent(config.douyin.userAgent);
    await page.setViewport({ width: 1920, height: 1080 });

    page.on('response', async (response) => {
      const url = response.url();
      try {
        if (url.includes('/aweme/v1/web/aweme/post/')) {
          const json = await response.json();
          if (json.aweme_list && json.aweme_list.length > 0) {
            interceptedPosts.push(...json.aweme_list);
            logger.info(`Intercepted ${json.aweme_list.length} posts (total: ${interceptedPosts.length})`);
          }
        }
        if (url.includes('/aweme/v1/web/user/profile/') || url.includes('/aweme/v1/web/user/info/')) {
          const json = await response.json();
          if (json.user) {
            interceptedUserInfo = json.user;
          }
        }
      } catch (e) {}
    });

    let userUrl = profileUrl || `${config.douyin.baseUrl}/user/${secUid}`;
    try {
      const urlObj = new URL(userUrl);
      userUrl = `${urlObj.origin}${urlObj.pathname}`;
    } catch (e) {}

    logger.info(`Loading user page (fallback): ${userUrl}`);

    await page.goto(userUrl, {
      waitUntil: 'networkidle0',
      timeout: 45000,
    }).catch(() => {
      logger.warn('networkidle0 timed out, continuing...');
    });

    await new Promise((r) => setTimeout(r, 5000));

    // Scroll
    const maxScrollAttempts = Math.ceil(count / 18) + 2;
    for (let i = 0; i < maxScrollAttempts && interceptedPosts.length < count; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise((r) => setTimeout(r, 3000));
    }
    await new Promise((r) => setTimeout(r, 2000));

    if (interceptedPosts.length > 0) {
      const videos = interceptedPosts.slice(0, count).map((item) => formatVideoDetail(item));
      const userInfo = interceptedUserInfo || interceptedPosts[0]?.author || {};
      return {
        user: {
          nickname: userInfo.nickname || '',
          uid: userInfo.uid || '',
          sec_uid: secUid,
          avatar: userInfo.avatar_thumb?.url_list?.[0] || '',
        },
        videos,
        has_more: interceptedPosts.length >= count,
        cursor: 0,
        total: videos.length,
      };
    }

    // DOM fallback
    const domVideos = await page.evaluate(() => {
      const seen = new Set();
      const videos = [];
      document.querySelectorAll('a[href*="/video/"], a[href*="/note/"]').forEach((link) => {
        const href = link.getAttribute('href');
        const idMatch = href?.match(/\/(?:video|note)\/(\d+)/);
        if (idMatch && !seen.has(idMatch[1])) {
          seen.add(idMatch[1]);
          videos.push({
            video_id: idMatch[1],
            url: `https://www.douyin.com${href.startsWith('/') ? href : '/' + href}`,
          });
        }
      });
      return videos;
    });

    if (domVideos.length > 0) {
      return {
        user: { sec_uid: secUid },
        videos: domVideos.slice(0, count),
        has_more: false,
        cursor: 0,
        total: domVideos.length,
        note: 'Chỉ lấy được video ID. Dùng /api/video/parse để lấy chi tiết.',
      };
    }

    throw new Error(
      'Không thể lấy danh sách video. Hãy đăng nhập: GET /api/auth/login rồi GET /api/auth/confirm'
    );
  } finally {
    await page.close();
  }
}

/**
 * Parse cookie string into Puppeteer cookie format
 */
function parseCookieString(cookieStr) {
  if (!cookieStr || cookieStr === 'your_douyin_cookie_here') return [];

  return cookieStr
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair.includes('='))
    .map((pair) => {
      const eqIdx = pair.indexOf('=');
      return {
        name: pair.substring(0, eqIdx).trim(),
        value: pair.substring(eqIdx + 1).trim(),
        domain: '.douyin.com',
        path: '/',
      };
    });
}

module.exports = {
  parseVideo,
  getUserVideos,
  resolveShortLink,
  closeBrowser,
  openLoginBrowser,
  checkSession,
  injectEnvCookies,
  getCookieString,
};
