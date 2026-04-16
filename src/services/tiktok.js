const axios = require('axios');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');
const config = require('../config');
const logger = require('../utils/logger');
const {
  extractTiktokVideoId,
  extractTiktokUsername,
  isTiktokShortLink,
  extractTiktokUrlFromShareText,
} = require('../utils/helpers');

// ─── Browser Instance (separate from Douyin) ───────────────

let browserInstance = null;

/**
 * Get or launch a shared Puppeteer browser instance for TikTok.
 * Uses a separate userDataDir from Douyin.
 */
async function getBrowser() {
  if (!browserInstance || !browserInstance.isConnected()) {
    fs.mkdirSync(config.tiktokBrowserDataDir, { recursive: true });

    const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || null;
    logger.info(`[TikTok] Launching Puppeteer (profile: ${config.tiktokBrowserDataDir}${execPath ? ', chromium: ' + execPath : ''})...`);
    browserInstance = await puppeteer.launch({
      headless: 'new',
      userDataDir: config.tiktokBrowserDataDir,
      executablePath: execPath || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--lang=en-US',
      ],
    });
  }
  return browserInstance;
}

/**
 * Close the TikTok browser instance
 */
async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

/**
 * Extract cookie string from TikTok browser profile.
 */
async function getCookieString() {
  return getCookieStringFromBrowser(await getBrowser());
}

/**
 * Read TikTok cookies from a specific browser instance (e.g. the login browser).
 */
async function getCookieStringFromBrowser(browser) {
  const page = await browser.newPage();
  try {
    const cookies = await page.cookies('https://www.tiktok.com');
    if (cookies.length === 0) return null;
    return cookies.map(c => `${c.name}=${c.value}`).join('; ');
  } finally {
    await page.close();
  }
}

/**
 * Open a VISIBLE browser for the user to log in to TikTok.
 * Cookies are saved to the persistent profile automatically.
 */
async function openLoginBrowser() {
  await closeBrowser();
  fs.mkdirSync(config.tiktokBrowserDataDir, { recursive: true });

  logger.info('[TikTok] Opening login browser (visible)...');
  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || null;
  const loginBrowser = await puppeteer.launch({
    headless: false,
    userDataDir: config.tiktokBrowserDataDir,
    executablePath: execPath || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1280,800',
      '--lang=en-US',
    ],
    defaultViewport: { width: 1280, height: 800 },
  });

  const page = await loginBrowser.newPage();
  await page.goto('https://www.tiktok.com/login', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  return { browser: loginBrowser, page };
}

/**
 * Confirm login, extract cookies from persistent profile, and save to .env
 */
async function confirmLogin(loginBrowser = null) {
  logger.info(`[TikTok] confirmLogin called. loginBrowser provided: ${!!loginBrowser}`);

  const cookieString = loginBrowser
    ? await getCookieStringFromBrowser(loginBrowser)
    : await getCookieString();

  logger.info(`[TikTok] Cookies found: ${cookieString ? cookieString.length + ' chars' : 'NONE'}`);

  if (!cookieString) return null;

  const path = require('path');
  const fs = require('fs');
  const envPath = path.resolve(process.cwd(), '.env');
  logger.info(`[TikTok] Writing cookie to: ${envPath}`);

  let envWriteError = null;
  try {
    if (!fs.existsSync(envPath)) {
      fs.writeFileSync(envPath, `TIKTOK_COOKIE='${cookieString}'\n`);
      logger.info('[TikTok] Created new .env with TIKTOK_COOKIE');
    } else {
      let content = fs.readFileSync(envPath, 'utf8');
      const regex = /^TIKTOK_COOKIE=.*$/m;
      if (regex.test(content)) {
        content = content.replace(regex, `TIKTOK_COOKIE='${cookieString}'`);
        logger.info('[TikTok] Replaced existing TIKTOK_COOKIE in .env');
      } else {
        content += `\nTIKTOK_COOKIE='${cookieString}'\n`;
        logger.info('[TikTok] Appended TIKTOK_COOKIE to .env');
      }
      fs.writeFileSync(envPath, content);
    }
    logger.info('[TikTok] ✅ .env write successful');
  } catch (err) {
    envWriteError = err.message;
    logger.error(`[TikTok] ❌ .env write FAILED: ${err.message}`);
  }

  config.tiktokCookie = cookieString;
  return { cookieString, envWriteError };
}

/**
 * Inject .env TIKTOK_COOKIE into the persistent browser profile on startup.
 * Mirrors the same pattern as Douyin's injectEnvCookies().
 */
async function injectEnvCookies() {
  if (!config.tiktokCookie || config.tiktokCookie === 'your_tiktok_cookie_here') {
    return false;
  }

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    const cookies = parseCookieString(config.tiktokCookie);
    if (cookies.length > 0) {
      await page.setCookie(...cookies);
      logger.info(`[TikTok] Injected ${cookies.length} cookies from .env into browser profile`);

      // Visit TikTok to refresh/validate cookies (same as Douyin pattern)
      await page.goto('https://www.tiktok.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await new Promise(r => setTimeout(r, 2000));
      logger.info('[TikTok] Startup cookie warm-up done');
      return true;
    }
  } catch (err) {
    logger.warn(`[TikTok] injectEnvCookies error: ${err.message}`);
  } finally {
    await page.close();
  }
  return false;
}

// ─── Short Link Resolution ──────────────────────────────────

/**
 * Resolve a TikTok short link (vm.tiktok.com / vt.tiktok.com) to the full URL
 */
async function resolveShortLink(shortUrl) {
  try {
    const response = await axios.get(shortUrl, {
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
      headers: {
        'User-Agent': config.tiktok.userAgent,
      },
      timeout: 10000,
    });

    const location = response.headers.location || response.request?.res?.responseUrl;
    if (location) {
      logger.info(`[TikTok] Resolved short link: ${shortUrl} -> ${location}`);
      return location;
    }

    return shortUrl;
  } catch (error) {
    if (error.response && error.response.headers.location) {
      logger.info(
        `[TikTok] Resolved short link (via redirect): ${shortUrl} -> ${error.response.headers.location}`
      );
      return error.response.headers.location;
    }
    throw new Error(`[TikTok] Failed to resolve short link: ${error.message}`);
  }
}

// ─── Video Parsing ──────────────────────────────────────────

/**
 * Parse a single TikTok video URL and return video details.
 */
async function parseVideo(inputUrl) {
  let url = inputUrl.trim();

  // Extract URL from share text if needed
  const extractedUrl = extractTiktokUrlFromShareText(url);
  if (extractedUrl) url = extractedUrl;

  // Resolve short links
  if (isTiktokShortLink(url)) {
    url = await resolveShortLink(url);
  }

  const videoId = extractTiktokVideoId(url);
  if (!videoId) {
    throw Object.assign(new Error('Could not extract TikTok video ID from URL'), {
      name: 'ValidationError',
    });
  }

  logger.info(`[TikTok] Parsing video: ${videoId}`);
  return await parseVideoViaPuppeteer(videoId, url);
}

/**
 * Parse TikTok video using Puppeteer with network interception.
 */
async function parseVideoViaPuppeteer(videoId, originalUrl) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  let interceptedDetail = null;

  try {
    await page.setUserAgent(config.tiktok.userAgent);
    await page.setViewport({ width: 1920, height: 1080 });

    // Intercept network responses to capture API data
    page.on('response', async (response) => {
      const url = response.url();
      try {
        // TikTok internal API for video detail
        if (url.includes('/api/item/detail') || url.includes('/api/related/item_list') ||
            (url.includes('/aweme/v1/') && url.includes(videoId))) {
          const json = await response.json();
          if (json.itemInfo?.itemStruct) {
            interceptedDetail = json.itemInfo.itemStruct;
            logger.info(`[TikTok] Intercepted video detail for ${videoId}`);
          } else if (json.item_list && json.item_list.length > 0) {
            const found = json.item_list.find(i => String(i.id) === String(videoId));
            if (found) {
              interceptedDetail = found;
              logger.info(`[TikTok] Intercepted video from item_list for ${videoId}`);
            }
          }
        }
      } catch (e) { /* ignore non-JSON responses */ }
    });

    // Navigate to the video page
    const videoUrl = originalUrl || `${config.tiktok.baseUrl}/@/video/${videoId}`;
    logger.info(`[TikTok] Loading page: ${videoUrl}`);

    await page.goto(videoUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.requestTimeout,
    });

    // Poll for intercepted data (max 15 seconds)
    const startTime = Date.now();
    const maxWait = 15000;
    while (Date.now() - startTime < maxWait) {
      if (interceptedDetail) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    let result = null;

    if (interceptedDetail) {
      result = formatVideoDetail(interceptedDetail);
    }

    // Fallback: Try page data extraction
    if (!result) {
      logger.info('[TikTok] No intercepted data, trying page data extraction...');
      const pageData = await page.evaluate((vid) => {
        const r = {};

        // __UNIVERSAL_DATA_FOR_REHYDRATION__
        const universalEl = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
        if (universalEl) {
          try {
            const parsed = JSON.parse(universalEl.textContent);
            const defaultScope = parsed['__DEFAULT_SCOPE__'];
            if (defaultScope?.['webapp.video-detail']?.itemInfo?.itemStruct) {
              r.videoDetail = defaultScope['webapp.video-detail'].itemInfo.itemStruct;
            }
          } catch (e) { r.universalError = e.message; }
        }

        // SIGI_STATE
        if (!r.videoDetail) {
          const sigiEl = document.getElementById('SIGI_STATE') || document.getElementById('sigi-persisted-data');
          if (sigiEl) {
            try {
              const parsed = JSON.parse(sigiEl.textContent);
              if (parsed.ItemModule?.[vid]) r.videoDetail = parsed.ItemModule[vid];
            } catch (e) { r.sigiError = e.message; }
          }
        }

        // __NEXT_DATA__
        if (!r.videoDetail) {
          const nextDataEl = document.getElementById('__NEXT_DATA__');
          if (nextDataEl) {
            try {
              const parsed = JSON.parse(nextDataEl.textContent);
              if (parsed?.props?.pageProps?.itemInfo?.itemStruct) {
                r.videoDetail = parsed.props.pageProps.itemInfo.itemStruct;
              }
            } catch (e) { r.nextDataError = e.message; }
          }
        }

        r.title = document.title || '';
        return r;
      }, videoId);

      if (pageData.videoDetail) {
        result = formatVideoDetail(pageData.videoDetail);
      }
    }

    if (!result || !result.download_url) {
      throw Object.assign(
        new Error('Không thể lấy dữ liệu video TikTok. Video có thể đã bị xóa hoặc bị hạn chế khu vực.'),
        { statusCode: 404 }
      );
    }

    // ─── Get NO-WATERMARK download URL via external API ─────────
    // TikTok's own APIs (web & internal) always return watermarked URLs.
    // Use tikwm.com API — a reliable service that extracts clean video URLs.
    logger.info(`[TikTok] Getting no-watermark URL for video ${result.video_id}...`);

    const noWmUrl = await getNoWatermarkUrl(result.video_id, originalUrl);
    if (noWmUrl) {
      logger.info('[TikTok] ✅ Got no-watermark URL');
      result.download_url = noWmUrl;
    } else {
      logger.warn('[TikTok] ⚠️ Could not get no-watermark URL, using original (may have watermark)');
    }

    return result;
  } finally {
    await page.close();
  }
}

// ─── No-Watermark URL ───────────────────────────────────────

/**
 * Get a no-watermark download URL for a TikTok video.
 * Uses multiple methods with fallbacks:
 * 1. tikwm.com API (public no-watermark service)
 * 2. Construct no-watermark URL from playAddr
 */
async function getNoWatermarkUrl(videoId, originalUrl) {
  const videoUrl = originalUrl || `https://www.tiktok.com/@/video/${videoId}`;

  // Method 1: tikwm.com API
  try {
    logger.info('[TikTok] Trying tikwm.com API...');
    const response = await axios({
      method: 'POST',
      url: 'https://www.tikwm.com/api/',
      data: `url=${encodeURIComponent(videoUrl)}&hd=1`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Origin': 'https://www.tikwm.com',
        'Referer': 'https://www.tikwm.com/',
      },
      timeout: 15000,
    });

    const data = response.data;
    if (data?.code === 0 && data?.data) {
      const hdUrl = data.data.hdplay;
      const sdUrl = data.data.play;
      if (hdUrl) {
        logger.info('[TikTok] ✅ Got HD no-watermark URL from tikwm');
        return hdUrl;
      }
      if (sdUrl) {
        logger.info('[TikTok] ✅ Got SD no-watermark URL from tikwm');
        return sdUrl;
      }
    }
    logger.warn(`[TikTok] tikwm: code=${data?.code}, msg=${data?.msg}`);
  } catch (err) {
    logger.warn(`[TikTok] tikwm API error: ${err.message}`);
  }

  // Method 2: Construct no-watermark URL from video ID
  // TikTok stores a no-watermark copy accessible via a direct CDN URL pattern
  try {
    logger.info('[TikTok] Trying direct CDN URL construction...');
    // This URL pattern often provides the clean version
    const directUrl = `https://api16-normal-c-useast1a.tiktokv.com/aweme/v1/play/?video_id=${videoId}&ratio=1080p&line=0`;

    const headCheck = await axios.head(directUrl, {
      headers: {
        'User-Agent': 'com.zhiliaoapp.musically/300904 (Linux; U; Android 12; en_US; Pixel 6; Build/SD1A.210817.036; Cronet/TTNetVersion:b4d74d15 2023-04-08 QuicVersion:0144d358 2023-03-26)',
      },
      timeout: 8000,
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 400,
    });

    if (headCheck.status === 200 || headCheck.status === 206 || headCheck.status === 302) {
      const finalUrl = headCheck.request?.res?.responseUrl || directUrl;
      logger.info('[TikTok] ✅ Got URL from direct CDN');
      return finalUrl;
    }
  } catch (err) {
    logger.warn(`[TikTok] Direct CDN error: ${err.message}`);
  }

  // Method 3: Use Puppeteer browser context to get downloadAddr via internal API
  try {
    logger.info('[TikTok] Trying browser-context API...');
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      await page.setUserAgent(config.tiktok.userAgent);
      // Navigate to TikTok first so cookies are available
      await page.goto('https://www.tiktok.com', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});

      const apiResult = await page.evaluate(async (vid) => {
        try {
          const res = await fetch(`https://www.tiktok.com/api/item/detail/?itemId=${vid}`, {
            credentials: 'include',
            headers: { 'Accept': 'application/json' },
          });
          if (!res.ok) return { ok: false, error: `${res.status}` };
          const data = await res.json();
          const item = data?.itemInfo?.itemStruct;
          if (!item?.video) return { ok: false, error: 'no video data' };

          const v = item.video;
          const result = {};

          // downloadAddr (no watermark)
          if (v.downloadAddr) {
            result.downloadAddr = typeof v.downloadAddr === 'string'
              ? v.downloadAddr : v.downloadAddr?.url_list?.[0];
          }

          // playAddr (watermarked but can be cleaned)
          if (v.playAddr) {
            result.playAddr = typeof v.playAddr === 'string'
              ? v.playAddr : v.playAddr?.url_list?.[0];
          }

          // bitrateInfo - highest quality
          if (v.bitrateInfo?.length > 0) {
            const sorted = [...v.bitrateInfo].sort((a, b) => (b.Bitrate || 0) - (a.Bitrate || 0));
            result.bitrateUrl = sorted[0]?.PlayAddr?.UrlList?.[0];
          }

          return { ok: true, ...result };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }, videoId);

      if (apiResult.ok) {
        // downloadAddr is the no-watermark version
        if (apiResult.downloadAddr) {
          logger.info('[TikTok] ✅ Got downloadAddr from browser API');
          return apiResult.downloadAddr;
        }
        // playAddr — try to clean it 
        if (apiResult.playAddr) {
          const cleaned = cleanPlayAddrUrl(apiResult.playAddr);
          logger.info('[TikTok] Using cleaned playAddr from browser API');
          return cleaned;
        }
        if (apiResult.bitrateUrl) {
          logger.info('[TikTok] Using bitrateUrl from browser API');
          return apiResult.bitrateUrl;
        }
      }
      logger.warn(`[TikTok] Browser API result: ${JSON.stringify(apiResult)}`);
    } finally {
      await page.close();
    }
  } catch (err) {
    logger.warn(`[TikTok] Browser API error: ${err.message}`);
  }

  return null;
}

/**
 * Clean a TikTok playAddr URL by removing watermark indicators.
 * Some TikTok URLs have watermark as a query parameter.
 */
function cleanPlayAddrUrl(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    // Remove watermark-related params
    u.searchParams.delete('logo_name');
    u.searchParams.delete('watermark');
    u.searchParams.delete('is_play_url');
    // Set watermark to 0 if present
    if (u.searchParams.has('watermark')) {
      u.searchParams.set('watermark', '0');
    }
    return u.toString();
  } catch {
    return url;
  }
}

// ─── Format Video Detail ────────────────────────────────────

/**
 * Format raw TikTok video detail into a clean response object.
 * Handles both old (SIGI_STATE) and new (__UNIVERSAL_DATA__) formats.
 */
function formatVideoDetail(detail) {
  const video = detail.video || {};
  const author = detail.author || {};
  const statistics = detail.stats || detail.statistics || {};

  // Extract download URL (no watermark)
  let downloadUrl = null;

  // Prefer downloadAddr (no watermark) over playAddr
  if (video.downloadAddr) {
    if (typeof video.downloadAddr === 'string' && video.downloadAddr.length > 0) {
      downloadUrl = video.downloadAddr;
    } else if (video.downloadAddr?.url_list?.length > 0) {
      downloadUrl = video.downloadAddr.url_list[0];
    }
  }
  const usedDownloadAddr = !!downloadUrl;
  if (!downloadUrl && video.playAddr) {
    if (typeof video.playAddr === 'string' && video.playAddr.length > 0) {
      downloadUrl = video.playAddr;
    } else if (video.playAddr?.url_list?.length > 0) {
      downloadUrl = video.playAddr.url_list[0];
    }
  }
  // Log which URL type is being used (helps debug watermark issues)
  const videoId = detail.id || detail.aweme_id || '';
  if (videoId) logger.info(`[TikTok] ${videoId}: using ${usedDownloadAddr ? 'downloadAddr (no-wm)' : 'playAddr (may have wm)'}`);
  // Bitrate list fallback
  if (!downloadUrl && video.bitrateInfo?.length > 0) {
    const sorted = [...video.bitrateInfo].sort(
      (a, b) => (b.Bitrate || b.bitrate || 0) - (a.Bitrate || a.bitrate || 0)
    );
    const best = sorted[0];
    if (best?.PlayAddr?.UrlList?.length > 0) {
      downloadUrl = best.PlayAddr.UrlList[0];
    }
  }

  // Cover URL
  let coverUrl = null;
  if (video.cover) {
    if (typeof video.cover === 'string') {
      coverUrl = video.cover;
    } else if (video.cover?.url_list?.length > 0) {
      coverUrl = video.cover.url_list[0];
    }
  }
  if (!coverUrl && video.originCover) {
    if (typeof video.originCover === 'string') {
      coverUrl = video.originCover;
    } else if (video.originCover?.url_list?.length > 0) {
      coverUrl = video.originCover.url_list[0];
    }
  }
  // Dynamic cover (animated)
  if (!coverUrl && video.dynamicCover) {
    coverUrl = typeof video.dynamicCover === 'string'
      ? video.dynamicCover
      : video.dynamicCover?.url_list?.[0] || null;
  }

  // Duration
  let duration = 0;
  if (video.duration) {
    duration = video.duration > 1000 ? Math.round(video.duration / 1000) : video.duration;
  }

  // Author info
  const authorInfo = {
    nickname: author.nickname || author.uniqueId || '',
    uid: author.id || author.uid || '',
    sec_uid: author.secUid || author.sec_uid || '',
    unique_id: author.uniqueId || '',
    avatar: author.avatarThumb || author.avatar_thumb?.url_list?.[0] || '',
  };

  return {
    video_id: detail.id || detail.aweme_id || String(detail.awemeId || ''),
    title: detail.desc || '',
    author: authorInfo,
    download_url: downloadUrl,
    cover_url: coverUrl,
    duration,
    create_time: detail.createTime
      ? new Date(detail.createTime * 1000).toISOString()
      : detail.create_time
        ? new Date(detail.create_time * 1000).toISOString()
        : null,
    statistics: {
      likes: statistics.diggCount || statistics.digg_count || 0,
      comments: statistics.commentCount || statistics.comment_count || 0,
      shares: statistics.shareCount || statistics.share_count || 0,
      plays: statistics.playCount || statistics.play_count || 0,
      collects: statistics.collectCount || statistics.collect_count || 0,
    },
    platform: 'tiktok',
  };
}

/**
 * Parse cookie string into Puppeteer cookie format
 */
function parseCookieString(cookieStr) {
  if (!cookieStr || cookieStr === 'your_tiktok_cookie_here') return [];

  const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;

  return cookieStr
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair.includes('='))
    .map((pair) => {
      const eqIdx = pair.indexOf('=');
      return {
        name: pair.substring(0, eqIdx).trim(),
        value: pair.substring(eqIdx + 1).trim(),
        domain: '.tiktok.com',
        path: '/',
        expires,
      };
    });
}

// ─── User Videos ────────────────────────────────────────────

/**
 * Parse 'since' parameter into a Unix timestamp (seconds).
 */
function parseSinceDate(since) {
  if (!since) return null;

  if (since === 'today') {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
  }
  if (since === 'yesterday') {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime() / 1000;
  }
  if (/^\d{10,}$/.test(String(since))) {
    return parseInt(since, 10);
  }
  const parsed = new Date(since);
  if (!isNaN(parsed.getTime())) {
    return parsed.getTime() / 1000;
  }
  return null;
}

/**
 * Get user videos via tikwm.com API — no browser, no captcha.
 * Returns raw tikwm video objects.
 */
async function tikwmRequest(username, batchCount, currentCursor) {
  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Origin': 'https://www.tikwm.com',
    'Referer': 'https://www.tikwm.com/',
  };

  // Try POST first
  try {
    const res = await axios({
      method: 'POST',
      url: 'https://www.tikwm.com/api/user/posts',
      data: `unique_id=${encodeURIComponent(username)}&count=${batchCount}&cursor=${currentCursor}&web=1`,
      headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    });
    if (res.data && res.data.code === 0) return res.data;
    logger.warn(`[TikTok/tikwm] POST code=${res.data?.code} msg=${res.data?.msg} — trying GET`);
  } catch (e) {
    logger.warn(`[TikTok/tikwm] POST failed (${e.response?.status || e.message}) — trying GET`);
  }

  // Fallback: GET
  const res = await axios({
    method: 'GET',
    url: `https://www.tikwm.com/api/user/posts`,
    params: { unique_id: username, count: batchCount, cursor: currentCursor, web: 1 },
    headers: HEADERS,
    timeout: 15000,
  });

  if (!res.data || res.data.code !== 0) {
    const preview = typeof res.data === 'string' ? res.data.substring(0, 120) : JSON.stringify(res.data).substring(0, 120);
    throw new Error(`tikwm API error: code=${res.data?.code}, msg=${res.data?.msg || 'unknown'}, body=${preview}`);
  }
  return res.data;
}

async function getUserVideosViaTikwm(username, count, cursor, sinceTs) {
  logger.info(`[TikTok/tikwm] Fetching @${username}, count: ${count}, cursor: ${cursor}`);

  const allVideos = [];
  let currentCursor = cursor || 0;
  let hasMore = true;
  let userInfo = null;

  while (allVideos.length < count && hasMore) {
    const batchCount = Math.min(count - allVideos.length, 35);
    const data = await tikwmRequest(username, batchCount, currentCursor);

    if (!userInfo && data.data.author) userInfo = data.data.author;

    const videos = data.data.videos || [];
    hasMore = !!data.data.hasMore;
    currentCursor = data.data.cursor || 0;

    logger.info(`[TikTok/tikwm] Got ${videos.length} videos (hasMore: ${hasMore})`);

    for (const v of videos) {
      if (sinceTs && v.create_time && v.create_time < sinceTs) {
        hasMore = false;
        break;
      }
      allVideos.push(v);
      if (allVideos.length >= count) break;
    }

    if (videos.length === 0) break;
  }

  return { videos: allVideos, hasMore, cursor: currentCursor, userInfo };
}

/**
 * Format a tikwm.com video object into the standard response format.
 */
function formatTikwmVideo(v) {
  const author = v.author || {};
  return {
    video_id: v.video_id || v.id || v.aweme_id || '',
    title: v.title || '',
    author: {
      nickname: author.nickname || '',
      uid: author.id || '',
      sec_uid: author.sec_uid || '',
      unique_id: author.unique_id || '',
      avatar: author.avatar || '',
    },
    download_url: v.hdplay || v.play || null,
    cover_url: v.cover || v.origin_cover || null,
    duration: v.duration || 0,
    create_time: v.create_time ? new Date(v.create_time * 1000).toISOString() : null,
    statistics: {
      likes: v.digg_count || 0,
      comments: v.comment_count || 0,
      shares: v.share_count || 0,
      plays: v.play_count || 0,
      collects: v.collect_count || 0,
    },
    platform: 'tiktok',
  };
}

/**
 * Get list of videos from a TikTok user profile.
 * Strategy:
 *   1. TikTok internal API with session cookie (fast, no browser)
 *   2. Puppeteer fallback (slower, handles JS-only pages)
 * @param {string} inputUrl - TikTok profile URL (https://www.tiktok.com/@username)
 * @param {number} count - Number of videos to fetch
 * @param {number} cursor - Pagination cursor
 * @param {string|null} since - Date filter
 */
async function getUserVideos(inputUrl, count = 20, cursor = 0, since = null) {
  let url = inputUrl.trim();

  if (isTiktokShortLink(url)) {
    url = await resolveShortLink(url);
  }

  const username = extractTiktokUsername(url);
  if (!username) {
    throw Object.assign(
      new Error('Could not extract TikTok username from profile URL. Expected format: https://www.tiktok.com/@username'),
      { name: 'ValidationError' }
    );
  }

  const sinceTs = parseSinceDate(since);
  logger.info(`[TikTok] Fetching videos for user: @${username}, count: ${count}, cursor: ${cursor}${sinceTs ? ', since: ' + new Date(sinceTs * 1000).toISOString() : ''}`);

  // ── Primary: TikTok internal API with session cookie ──────────
  const hasCookie = config.tiktokCookie && config.tiktokCookie !== 'your_tiktok_cookie_here';
  if (hasCookie) {
    try {
      const result = await getUserVideosViaApi(username, url, count, cursor, sinceTs);
      if (result && result.videos && result.videos.length > 0) {
        return result;
      }
      logger.warn('[TikTok] Internal API returned 0 videos, falling back to Puppeteer...');
    } catch (apiErr) {
      logger.warn(`[TikTok] Internal API failed (${apiErr.message}). Falling back to Puppeteer...`);
    }
  } else {
    logger.warn('[TikTok] No TIKTOK_COOKIE set. Run: node get_tiktok_cookie.js — then restart Docker.');
  }

  // ── Fallback: Puppeteer ───────────────────────────────────────
  return await getUserVideosViaPuppeteer(username, url, count, cursor, sinceTs);
}

/**
 * Fetch user videos using TikTok's internal web API with session cookie.
 * Requires a valid TIKTOK_COOKIE (sessionid, tt_csrf_token, etc.)
 */
async function getUserVideosViaApi(username, profileUrl, count, cursor, sinceTs) {
  // Step 1: Get secUid from profile page (lightweight HTML request)
  logger.info(`[TikTok/API] Resolving secUid for @${username}...`);
  const secUid = await resolveSecUid(username, profileUrl);
  if (!secUid) throw new Error('Could not resolve secUid for user');

  logger.info(`[TikTok/API] secUid: ${secUid.substring(0, 30)}...`);

  const cookieStr = config.tiktokCookie;
  // Extract msToken and tt_csrf_token from cookie string
  const msTokenMatch = cookieStr.match(/msToken=([^;]+)/);
  const csrfMatch = cookieStr.match(/tt_csrf_token=([^;]+)/);
  const msToken = msTokenMatch ? msTokenMatch[1] : '';
  const csrfToken = csrfMatch ? csrfMatch[1] : '';

  const allVideos = [];
  let currentCursor = cursor || 0;
  let hasMore = true;
  let userInfo = null;

  while (allVideos.length < count && hasMore) {
    const batchCount = Math.min(count - allVideos.length, 35);
    const params = new URLSearchParams({
      secUid,
      count: batchCount,
      cursor: currentCursor,
      aid: '1988',
      app_language: 'en',
      app_name: 'tiktok_web',
      browser_language: 'en-US',
      browser_name: 'Mozilla',
      browser_platform: 'Win32',
      browser_version: '5.0',
      channel: 'tiktok_web',
      device_platform: 'web_pc',
      focus_state: 'true',
      from_page: 'user',
      history_len: '3',
      is_fullscreen: 'false',
      is_page_visible: 'true',
      language: 'en',
      os: 'windows',
      priority_region: '',
      referer: '',
      region: 'US',
      screen_height: '1080',
      screen_width: '1920',
      tz_name: 'America/New_York',
      webcast_language: 'en',
      ...(msToken ? { msToken } : {}),
    });

    const apiUrl = `https://www.tiktok.com/api/post/item_list/?${params.toString()}`;

    const headers = {
      'Cookie': cookieStr,
      'Referer': `https://www.tiktok.com/@${username}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
    };

    const res = await axios.get(apiUrl, { headers, timeout: 15000 });
    const data = res.data;

    if (!data || (data.statusCode && data.statusCode !== 0)) {
      throw new Error(`TikTok API error: statusCode=${data?.statusCode}, msg=${data?.statusMsg || 'unknown'}`);
    }

    const items = data.itemList || data.item_list || [];
    hasMore = !!data.hasMore;
    currentCursor = data.cursor || 0;

    logger.info(`[TikTok/API] Batch: ${items.length} videos (hasMore: ${hasMore})`);

    if (!userInfo && items.length > 0) {
      userInfo = items[0].author || null;
    }

    for (const item of items) {
      const ct = item.createTime || item.create_time;
      if (sinceTs && ct && ct < sinceTs) { hasMore = false; break; }
      allVideos.push(item);
      if (allVideos.length >= count) break;
    }

    if (items.length === 0) break;
  }

  const videos = allVideos.map(item => withProxyUrl(formatVideoDetail(item)));
  const u = userInfo || {};
  return {
    user: {
      nickname: u.nickname || videos[0]?.author?.nickname || '',
      uid: u.id || u.uid || videos[0]?.author?.uid || '',
      unique_id: u.uniqueId || u.unique_id || username,
      sec_uid: secUid,
      avatar: u.avatarThumb || u.avatar_thumb?.url_list?.[0] || videos[0]?.author?.avatar || '',
      signature: u.signature || '',
    },
    videos,
    has_more: hasMore,
    cursor: currentCursor,
    total: videos.length,
    filter: sinceTs ? { since: new Date(sinceTs * 1000).toISOString() } : undefined,
    platform: 'tiktok',
  };
}

/**
 * Resolve a TikTok username to their secUid by fetching the profile page HTML.
 */
async function resolveSecUid(username, profileUrl) {
  const url = profileUrl || `https://www.tiktok.com/@${username}`;
  const cookieStr = config.tiktokCookie || '';

  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(cookieStr ? { 'Cookie': cookieStr } : {}),
      },
      timeout: 15000,
    });

    const html = res.data;

    // Try __UNIVERSAL_DATA_FOR_REHYDRATION__ JSON block
    const universalMatch = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
    if (universalMatch) {
      try {
        const parsed = JSON.parse(universalMatch[1]);
        const userDetail = parsed?.['__DEFAULT_SCOPE__']?.['webapp.user-detail'];
        const secUid = userDetail?.userInfo?.user?.secUid;
        if (secUid) return secUid;
      } catch (e) { /* ignore */ }
    }

    // Try SIGI_STATE
    const sigiMatch = html.match(/<script id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
    if (sigiMatch) {
      try {
        const parsed = JSON.parse(sigiMatch[1]);
        const users = parsed?.UserModule?.users || {};
        const user = users[username] || Object.values(users)[0];
        if (user?.secUid) return user.secUid;
      } catch (e) { /* ignore */ }
    }

    // Try plain regex for secUid pattern
    const secUidMatch = html.match(/"secUid"\s*:\s*"(MS4wLjABAAAA[^"]+)"/);
    if (secUidMatch) return secUidMatch[1];

  } catch (err) {
    logger.warn(`[TikTok/API] resolveSecUid error: ${err.message}`);
  }

  return null;
}

async function getUserVideosViaPuppeteer(username, profileUrl, count, cursor = 0, sinceTs = null) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  const allPosts = [];
  let secUid = null;
  let userInfo = null;
  let currentCursor = cursor;
  let hasMore = true;
  let reachedOlderThanSince = false;
  let caughtError = null;

  try {
    await page.setUserAgent(config.tiktok.userAgent);
    await page.setViewport({ width: 1920, height: 1080 });

    // Hook window.fetch BEFORE page loads so we capture every item_list response.
    // This is more reliable than page.on('response') whose response.text() call often
    // fails with "No resource with given identifier found" (CDP body already consumed).
    await page.evaluateOnNewDocument(() => {
      window.__tt = { items: [], hasMore: true, cursor: 0 };
      const origFetch = window.fetch;
      window.fetch = async function(...args) {
        const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        if (typeof url === 'string' && (url.includes('/api/post/item_list/') || url.includes('/api/item_list/'))) {
          const res = await origFetch.apply(this, args);
          res.clone().text().then(text => {
            try {
              const j = JSON.parse(text);
              const items = j.itemList || j.ItemList || j.videoList || j.items || j.aweme_list || [];
              if (items.length > 0) window.__tt.items.push(...items);
              if (j.hasMore === false || j.hasMore === 0) window.__tt.hasMore = false;
              if (j.cursor) window.__tt.cursor = j.cursor;
            } catch(e) {}
          }).catch(() => {});
          return res;
        }
        return origFetch.apply(this, args);
      };
    });

    const userUrl = profileUrl || `${config.tiktok.baseUrl}/@${username}`;
    logger.info(`[TikTok] Loading profile page: ${userUrl}`);

    // Inject cookies to bypass TikTok Captcha limits
    const hasCookie = config.tiktokCookie && config.tiktokCookie !== 'your_tiktok_cookie_here';
    if (hasCookie) {
       const cookies = parseCookieString(config.tiktokCookie);
       if (cookies.length > 0) {
          await page.setCookie(...cookies);
          logger.info(`[TikTok] Injected ${cookies.length} cookies to bypass Captcha`);

          // Warm-up: visit homepage first to validate session (same pattern as Douyin)
          try {
            await page.goto('https://www.tiktok.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
            await new Promise(r => setTimeout(r, 1500));
            logger.info('[TikTok] Warm-up navigation done');
          } catch(e) {
            logger.warn(`[TikTok] Warm-up navigation failed: ${e.message}`);
          }
       }
    } else {
       logger.warn('[TikTok] No TIKTOK_COOKIE set — TikTok may show captcha for headless browser. Set TIKTOK_COOKIE in .env to bypass.');
    }

    await page.goto(userUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.requestTimeout || 30000,
    });

    // Wait for React hydration + initial fetch calls to complete
    await new Promise(r => setTimeout(r, 2500 + Math.random() * 1000));

    // Extract user info + any items already captured by the fetch hook
    const pageData = await page.evaluate(() => {
        const result = { userInfo: null, secUid: null, initialVideos: [] };

        // __UNIVERSAL_DATA_FOR_REHYDRATION__
        const universalEl = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
        if (universalEl) {
          try {
            const parsed = JSON.parse(universalEl.textContent);
            const defaultScope = parsed['__DEFAULT_SCOPE__'];
            if (defaultScope && defaultScope['webapp.user-detail']) {
              result.userInfo = defaultScope['webapp.user-detail'].userInfo?.user;
              result.secUid = result.userInfo?.secUid;
            }
          } catch(e) {}
        }

        // SIGI_STATE — may contain ItemModule with initial videos
        const sigiEl = document.getElementById('SIGI_STATE') || document.getElementById('sigi-persisted-data');
        if (sigiEl) {
          try {
            const parsed = JSON.parse(sigiEl.textContent);
            if (!result.secUid && parsed.UserModule && parsed.UserModule.users) {
               const users = Object.values(parsed.UserModule.users);
               if (users.length > 0) {
                  result.userInfo = users[0];
                  result.secUid = users[0].secUid;
               }
            }
            if (parsed.ItemModule) {
               result.initialVideos = Object.values(parsed.ItemModule);
            }
          } catch(e) {}
        }

        // Drain whatever the fetch hook already captured
        result.hookItems = window.__tt ? window.__tt.items.splice(0) : [];
        result.hookHasMore = window.__tt ? window.__tt.hasMore : true;
        result.hookCursor = window.__tt ? window.__tt.cursor : 0;
        return result;
    });

    if (pageData.userInfo) userInfo = pageData.userInfo;
    if (pageData.secUid) secUid = pageData.secUid;
    logger.info(`[TikTok] Page loaded for @${username}. secUid: ${secUid || 'unknown'}`);

    // Merge initial videos from SIGI_STATE
    if (pageData.initialVideos && pageData.initialVideos.length > 0) {
       for (const v of pageData.initialVideos) {
         if (!allPosts.some(p => String(p.id) === String(v.id))) allPosts.push(v);
       }
       logger.info(`[TikTok] Added ${pageData.initialVideos.length} videos from SIGI_STATE`);
    }

    // Merge items from fetch hook (fired during initial page load)
    for (const item of (pageData.hookItems || [])) {
      const ct = item.createTime || item.create_time;
      if (sinceTs && ct && ct < sinceTs) { reachedOlderThanSince = true; break; }
      if (!allPosts.some(p => String(p.id) === String(item.id))) allPosts.push(item);
    }
    if (pageData.hookHasMore === false) hasMore = false;
    if (pageData.hookCursor) currentCursor = pageData.hookCursor;
    logger.info(`[TikTok] Fetch hook (initial): ${pageData.hookItems?.length || 0} items. Total so far: ${allPosts.length}`);

    // Scroll loop — each iteration scrolls down and drains newly captured items
    let scrollAttempts = 0;
    const maxScrollAttempts = Math.ceil(count / 10) + 10;
    let noProgressStreak = 0;

    while (allPosts.length < count && hasMore && !reachedOlderThanSince && scrollAttempts < maxScrollAttempts) {
       scrollAttempts++;

       await page.evaluate(() => window.scrollBy(0, window.innerHeight * 3));
       await new Promise(r => setTimeout(r, 1500 + Math.random() * 800));

       const captured = await page.evaluate(() => {
          const items = window.__tt.items.splice(0);
          return { items, hasMore: window.__tt.hasMore, cursor: window.__tt.cursor };
       });

       let newThisRound = 0;
       for (const item of captured.items) {
          const ct = item.createTime || item.create_time;
          if (sinceTs && ct && ct < sinceTs) { reachedOlderThanSince = true; break; }
          if (!allPosts.some(p => String(p.id) === String(item.id))) {
             allPosts.push(item);
             newThisRound++;
          }
       }
       if (captured.hasMore === false) hasMore = false;
       if (captured.cursor) currentCursor = captured.cursor;

       logger.info(`[TikTok] @${username} scroll ${scrollAttempts}: +${newThisRound} new, total ${allPosts.length}/${count}`);

       if (newThisRound === 0) {
          noProgressStreak++;
          if (noProgressStreak >= 3) break; // No new items for 3 consecutive scrolls → stop
          await new Promise(r => setTimeout(r, 1500)); // extra wait before retry
       } else {
          noProgressStreak = 0;
       }
    }

    // DOM fallback: extract video IDs from links when the fetch hook captured nothing
    if (allPosts.length === 0) {
       logger.warn('[TikTok] Fetch hook captured nothing. Trying DOM link extraction.');
       const domVideos = await page.evaluate(() => {
          const seen = new Set();
          const videos = [];
          document.querySelectorAll('a[href*="/video/"]').forEach((link) => {
             const href = link.href;
             const idMatch = href.match(/\/video\/(\d+)/);
             if (idMatch && !seen.has(idMatch[1])) {
                seen.add(idMatch[1]);
                videos.push({ id: idMatch[1], desc: link.getAttribute('title') || '', video: {} });
             }
          });
          return videos;
       });
       if (domVideos.length > 0) {
          logger.info(`[TikTok] DOM fallback: ${domVideos.length} video links found`);
          allPosts.push(...domVideos);
          hasMore = false;
       }
    }

    if (allPosts.length === 0) {
      const isCaptcha = await page.evaluate(() =>
         document.body.innerHTML.includes('verify') ||
         document.body.innerHTML.includes('captcha') ||
         document.body.innerHTML.includes('Just a moment')
      );
      if (isCaptcha) {
         throw new Error(`[Bị chặn Captcha] TikTok đã chặn bot server của bạn. Hãy điền TIKTOK_COOKIE trong file .env để Bypass Captcha.`);
      }
      throw new Error(`Không thể lấy danh sách video TikTok cho @${username}. API có thể bị rate-limit hoặc profile không tồn tại.`);
    }
  } catch (err) {
    caughtError = err;
    logger.warn(`[TikTok] Puppeteer user fetch error: ${err.message}`);
  } finally {
    await page.close();
  }

  if (caughtError) throw caughtError;

  // Filter posts
  let filteredPosts = allPosts;
  if (sinceTs) {
    filteredPosts = allPosts.filter(item => {
      const ct = item.createTime || item.create_time;
      return !ct || ct >= sinceTs;
    });
    logger.info(`[TikTok] Since filter: ${allPosts.length} -> ${filteredPosts.length} videos`);
  }

  // Web API results use formatVideoDetail structure, perfectly adapting to standard output
  const videos = filteredPosts.slice(0, count).map(item => withProxyUrl(formatVideoDetail(item)));

  return {
    user: {
      nickname: userInfo?.nickname || videos[0]?.author?.nickname || '',
      uid: userInfo?.id || userInfo?.uid || videos[0]?.author?.uid || '',
      unique_id: userInfo?.uniqueId || userInfo?.unique_id || username,
      sec_uid: secUid || userInfo?.secUid || videos[0]?.author?.sec_uid || '',
      avatar: userInfo?.avatarThumb || userInfo?.avatar_thumb?.url_list?.[0] || videos[0]?.author?.avatar || '',
      signature: userInfo?.signature || '',
    },
    videos,
    has_more: hasMore && !reachedOlderThanSince,
    cursor: currentCursor,
    total: videos.length,
    filter: sinceTs ? { since: new Date(sinceTs * 1000).toISOString() } : undefined,
    platform: 'tiktok',
  };
}

// ─── Proxy URL Helper ───────────────────────────────────────

/**
 * Wrap a TikTok CDN URL through our proxy to avoid 403 (missing Referer/Cookie).
 * Also strips watermark query params from the CDN URL before proxying.
 * Returns the proxy URL as download_url, keeps original in cdn_url.
 */
function withProxyUrl(video) {
  if (!video || !video.download_url) return video;
  const base = config.serverBaseUrl || 'http://localhost:3000';
  // Pass the original CDN URL unchanged — TikTok uses HMAC-signed URLs,
  // modifying any query param invalidates the signature and causes 403.
  return {
    ...video,
    download_url: `${base}/api/tiktok/proxy/media?url=${encodeURIComponent(video.download_url)}&dl=1`,
    cdn_url: video.download_url,
  };
}

// ─── Exports ────────────────────────────────────────────────

module.exports = {
  parseVideo,
  getUserVideos,
  resolveShortLink,
  closeBrowser,
  getBrowser,
  getCookieString,
  openLoginBrowser,
  confirmLogin,
  injectEnvCookies,
};
