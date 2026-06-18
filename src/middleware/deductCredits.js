const Setting = require('../models/Setting');
const ApiLog = require('../models/ApiLog');

/**
 * Middleware factory that deducts credits based on a setting key and logs the API call.
 * @param {string} settingKey - The Setting key to look up the cost
 * @param {number} fallback - Fallback cost if the setting is not found
 */
const deductCredits = (settingKey, fallback = 10) => {
  return async (req, res, next) => {
    try {
      const user = req.user;

      if (!user) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      const cost = await Setting.get(settingKey, fallback);

      const User = user.constructor;
      const updatedUser = await User.findOneAndUpdate(
        { _id: user._id, banned: { $ne: true }, credits: { $gte: cost } },
        { $inc: { credits: -cost } },
        { new: true }
      );

      if (!updatedUser) {
        // Log failed attempt
        await ApiLog.create({
          userId: user._id,
          email: user.email,
          endpoint: req.originalUrl,
          method: req.method,
          ip: req.clientIp || req.ip || 'unknown',
          userAgent: req.headers['user-agent'] || '',
          creditsCost: cost,
          creditsRemaining: user.credits,
          statusCode: 402,
          success: false,
        });

        return res.status(402).json({
          success: false,
          error: `Payment Required: Insufficient credits. You need ${cost} credits, but have ${user.credits}.`
        });
      }

      // Log successful call
      await ApiLog.create({
        userId: user._id,
        email: user.email,
        endpoint: req.originalUrl,
        method: req.method,
        ip: req.clientIp || req.ip || 'unknown',
        userAgent: req.headers['user-agent'] || '',
        creditsCost: cost,
        creditsRemaining: updatedUser.credits,
        statusCode: 200,
        success: true,
      });

      req.user = updatedUser;
      next();
    } catch (error) {
      console.error('Deduct Credits Error:', error);
      res.status(500).json({ success: false, error: 'Internal Server Error during credit check' });
    }
  };
};

module.exports = deductCredits;
