const User = require('../models/User');

const authApi = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: Missing or invalid token format. Use "Bearer <token>"'
      });
    }

    const token = authHeader.split(' ')[1];
    
    const user = await User.findOne({ apiToken: token });
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: Invalid API token'
      });
    }

    // Check if user is banned
    if (user.banned) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: Your account has been banned. Contact admin.'
      });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('API Auth Error:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error during authentication' });
  }
};

module.exports = authApi;
