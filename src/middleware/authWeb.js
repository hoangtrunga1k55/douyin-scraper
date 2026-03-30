const User = require('../models/User');

const authWeb = async (req, res, next) => {
  if (!req.session || !req.session.userId) {
    return res.redirect('/login');
  }

  try {
    const user = await User.findById(req.session.userId);
    if (!user) {
      req.session.destroy();
      return res.redirect('/login');
    }

    if (user.banned) {
      req.session.destroy();
      return res.redirect('/login');
    }

    req.user = user;
    res.locals.user = user;
    next();
  } catch (err) {
    console.error('Web Auth Error:', err);
    res.status(500).send('Internal Server Error');
  }
};

const authAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).send('Forbidden: Admins only');
  }
};

module.exports = { authWeb, authAdmin };
