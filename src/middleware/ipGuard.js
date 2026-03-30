const BannedIp = require('../models/BannedIp');
const Setting = require('../models/Setting');
const logger = require('../utils/logger');

// In-memory rate tracking (reset on restart, that's fine)
const ipHits = new Map(); // ip -> { count, windowStart }

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.ip
    || req.connection?.remoteAddress
    || 'unknown';
}

/**
 * Middleware: check if IP is banned, and track request rate for auto-ban.
 */
const ipGuard = async (req, res, next) => {
  const ip = getClientIp(req);
  req.clientIp = ip;

  try {
    // 1. Check if IP is already banned in DB
    const banned = await BannedIp.findOne({ ip });
    if (banned) {
      logger.warn(`[IP Guard] Blocked banned IP: ${ip} (${banned.reason})`);
      return res.status(403).json({
        success: false,
        error: 'Forbidden: Your IP has been banned.',
      });
    }

    // 2. Rate tracking + auto-ban
    const maxRequests = await Setting.get('ip_rate_limit', 30); // requests per window
    const windowMs = await Setting.get('ip_rate_window_minutes', 1) * 60 * 1000; // window in ms
    const autoBanThreshold = await Setting.get('ip_auto_ban_threshold', 100); // auto-ban after N in window

    const now = Date.now();
    let entry = ipHits.get(ip);

    if (!entry || (now - entry.windowStart) > windowMs) {
      // New window
      entry = { count: 1, windowStart: now };
      ipHits.set(ip, entry);
    } else {
      entry.count++;
    }

    // Check if should auto-ban
    if (entry.count > autoBanThreshold) {
      await BannedIp.findOneAndUpdate(
        { ip },
        {
          ip,
          reason: `Auto-banned: ${entry.count} requests in ${Math.round(windowMs / 1000)}s`,
          autoBanned: true,
          requestCount: entry.count,
        },
        { upsert: true }
      );
      logger.warn(`[IP Guard] Auto-banned IP: ${ip} (${entry.count} requests)`);
      return res.status(403).json({
        success: false,
        error: 'Forbidden: Too many requests. Your IP has been automatically banned.',
      });
    }

    // Check soft rate limit (429 but don't ban yet)
    if (entry.count > maxRequests) {
      return res.status(429).json({
        success: false,
        error: `Too many requests. Limit: ${maxRequests} per ${Math.round(windowMs / 60000)} minute(s). Slow down or you will be banned.`,
      });
    }

    next();
  } catch (err) {
    logger.error(`[IP Guard] Error: ${err.message}`);
    next(); // Don't block on error
  }
};

module.exports = { ipGuard, getClientIp };
