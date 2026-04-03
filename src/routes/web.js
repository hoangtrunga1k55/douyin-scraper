const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Setting = require('../models/Setting');
const ApiLog = require('../models/ApiLog');
const BannedIp = require('../models/BannedIp');
const Package = require('../models/Package');
const Seo = require('../models/Seo');
const { authWeb, authAdmin } = require('../middleware/authWeb');
const { sendTelegramMessage } = require('../utils/telegram');

// ==== GLOBAL SEO MIDDLEWARE ====
router.use(async (req, res, next) => {
  if (req.method === 'GET') {
    try {
      res.locals.seo = await Seo.findOne({ path: req.path });
    } catch (e) {
      console.error('SEO middleware error:', e);
    }
  }
  next();
});

// ==== PUBLIC ROUTES ====

router.get('/docs', (req, res) => {
  res.render('docs');
});

router.get('/pricing', async (req, res) => {
  try {
    const packages = await Package.find().sort({ price: 1 });
    res.render('pricing', { packages });
  } catch (err) {
    res.render('pricing', { packages: [] });
  }
});

router.get('/login', async (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard');
  const defaultCredits = await Setting.get('default_user_credits', 200);
  res.render('login', { error: null, defaultCredits });
});

router.post('/login', async (req, res) => {
  let defaultCredits = 200;
  try {
    defaultCredits = await Setting.get('default_user_credits', 200);
    const { email, password } = req.body;
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    
    if (!user || !(await user.comparePassword(password))) {
      return res.render('login', { error: 'Invalid email or password', defaultCredits });
    }

    if (user.banned) {
      return res.render('login', { error: 'Your account has been banned. Contact admin.', defaultCredits });
    }

    req.session.userId = user._id;
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Login error:', err);
    res.render('login', { error: 'Internal Server Error', defaultCredits });
  }
});

router.get('/register', async (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard');
  const defaultCredits = await Setting.get('default_user_credits', 200);
  res.render('register', { error: null, success: null, defaultCredits });
});

router.post('/register', async (req, res) => {
  let defaultCredits = 200;
  try {
    defaultCredits = await Setting.get('default_user_credits', 200);
    const { email, password, confirmPassword } = req.body;
    const trimmedEmail = email.toLowerCase().trim();

    // Validate Gmail
    if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(trimmedEmail)) {
      return res.render('register', { error: 'Please enter a valid email address', success: null, defaultCredits });
    }
    if (password !== confirmPassword) {
      return res.render('register', { error: 'Passwords do not match', success: null, defaultCredits });
    }
    if (password.length < 6) {
      return res.render('register', { error: 'Password must be at least 6 characters', success: null, defaultCredits });
    }
    
    const existing = await User.findOne({ email: trimmedEmail });
    if (existing) {
      return res.render('register', { error: 'Email already registered', success: null, defaultCredits });
    }

    const userCount = await User.countDocuments();
    const role = userCount === 0 ? 'admin' : 'user';

    const user = new User({ email: trimmedEmail, passwordHash: password, role, credits: defaultCredits });
    await user.save();

    res.render('register', { success: `Đăng ký thành công! Bạn đã nhận ${defaultCredits} credits miễn phí. Hãy đăng nhập.`, error: null, defaultCredits });
  } catch (err) {
    console.error('Register error:', err);
    res.render('register', { error: 'Internal Server Error', success: null, defaultCredits });
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ==== PROTECTED ROUTES (USER) ====

router.get('/dashboard', authWeb, (req, res) => {
  res.render('dashboard', { pwError: null, pwSuccess: null });
});

router.post('/dashboard/regenerate-token', authWeb, async (req, res) => {
  try {
    await req.user.regenerateToken();
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Regenerate token error:', err);
    res.redirect('/dashboard');
  }
});

router.post('/dashboard/change-password', authWeb, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmNewPassword } = req.body;

    if (!(await req.user.comparePassword(currentPassword))) {
      return res.render('dashboard', { pwError: 'Current password is incorrect', pwSuccess: null });
    }
    if (newPassword.length < 6) {
      return res.render('dashboard', { pwError: 'New password must be at least 6 characters', pwSuccess: null });
    }
    if (newPassword !== confirmNewPassword) {
      return res.render('dashboard', { pwError: 'New passwords do not match', pwSuccess: null });
    }

    req.user.passwordHash = newPassword; // Pre-save hook will hash
    await req.user.save();
    res.render('dashboard', { pwSuccess: 'Password changed successfully!', pwError: null });
  } catch (err) {
    console.error('Change password error:', err);
    res.render('dashboard', { pwError: 'Internal Server Error', pwSuccess: null });
  }
});

router.get('/dashboard/pricing', authWeb, async (req, res) => {
  try {
    const packages = await Package.find().sort({ price: 1 });
    
    res.render('dashboard-pricing', { 
      packages,
      successMsg: null
    });
  } catch (err) {
    res.status(500).send('Error loading pricing');
  }
});

router.post('/dashboard/notify-payment', authWeb, async (req, res) => {
  try {
    const msg = `💰 <b>THÔNG BÁO CHUYỂN KHOẢN</b>\n👤 User: <code>${req.user.email}</code>\n🔑 ID: <code>${req.user._id}</code>\n💬 Người dùng vừa báo hiệu đã chuyển khoản thành công. Hãy kiểm tra biến động số dư!`;
    
    await sendTelegramMessage(msg);

    const packages = await Package.find().sort({ price: 1 });
    
    res.render('dashboard-pricing', { 
      packages,
      successMsg: '✅ Đã gửi thông báo cho Admin thành công! Vui lòng chờ vài phút để được cộng credit.'
    });
  } catch (err) {
    console.error('Notify payment error:', err);
    res.status(500).send('Error sending notification');
  }
});

// ==== PROTECTED ROUTES (ADMIN) ====

router.get('/admin', authWeb, authAdmin, async (req, res) => {
  try {
    const users = await User.find().select('-passwordHash').sort({ createdAt: -1 });
    const settings = await Setting.find().sort({ key: 1 });
    const logs = await ApiLog.find().sort({ createdAt: -1 }).limit(100);
    const bannedIps = await BannedIp.find().sort({ createdAt: -1 });
    const packages = await Package.find().sort({ price: 1 });
    const seoConfigs = await Seo.find().sort({ path: 1 });

    res.render('admin', { users, settings, logs, bannedIps, packages, seoConfigs, error: null, success: null });
  } catch (err) {
    res.render('admin', { users: [], settings: [], logs: [], bannedIps: [], packages: [], seoConfigs: [], error: 'Failed to load data', success: null });
  }
});

router.post('/admin/grant', authWeb, authAdmin, async (req, res) => {
  try {
    const { userId, credits } = req.body;
    const amount = parseInt(credits, 10);
    if (!amount || amount <= 0) return res.redirect('/admin');

    const targetUser = await User.findById(userId);
    if (!targetUser) return res.redirect('/admin');

    targetUser.credits += amount;
    await targetUser.save();
    res.redirect('/admin');
  } catch (err) {
    console.error(err);
    res.redirect('/admin');
  }
});

router.post('/admin/settings', authWeb, authAdmin, async (req, res) => {
  try {
    const { keys, values } = req.body;
    const keyArr = Array.isArray(keys) ? keys : [keys];
    const valArr = Array.isArray(values) ? values : [values];

    for (let i = 0; i < keyArr.length; i++) {
      const numVal = parseInt(valArr[i], 10);
      if (!isNaN(numVal) && numVal >= 0) {
        await Setting.findOneAndUpdate({ key: keyArr[i] }, { value: numVal });
      }
    }
    res.redirect('/admin');
  } catch (err) {
    console.error('Settings update error:', err);
    res.redirect('/admin');
  }
});

// Ban / Unban user
router.post('/admin/ban', authWeb, authAdmin, async (req, res) => {
  try {
    const { userId } = req.body;
    const targetUser = await User.findById(userId);
    if (!targetUser) return res.redirect('/admin');

    targetUser.banned = !targetUser.banned;
    await targetUser.save();
    res.redirect('/admin');
  } catch (err) {
    console.error(err);
    res.redirect('/admin');
  }
});

// Change user token
router.post('/admin/change-token', authWeb, authAdmin, async (req, res) => {
  try {
    const { userId, newToken } = req.body;
    const targetUser = await User.findById(userId);
    if (!targetUser) return res.redirect('/admin');

    if (newToken && newToken.trim().length >= 16) {
      targetUser.apiToken = newToken.trim();
    } else {
      // Generate new random token
      const crypto = require('crypto');
      targetUser.apiToken = crypto.randomBytes(32).toString('hex');
    }
    await targetUser.save();
    res.redirect('/admin');
  } catch (err) {
    console.error(err);
    res.redirect('/admin');
  }
});

// Change user password
router.post('/admin/change-password', authWeb, authAdmin, async (req, res) => {
  try {
    const { userId, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) return res.redirect('/admin');

    const targetUser = await User.findById(userId);
    if (!targetUser) return res.redirect('/admin');

    targetUser.passwordHash = newPassword; // Pre-save hook will hash it
    await targetUser.save();
    res.redirect('/admin');
  } catch (err) {
    console.error(err);
    res.redirect('/admin');
  }
});
// Ban IP
router.post('/admin/ban-ip', authWeb, authAdmin, async (req, res) => {
  try {
    const { ip, reason } = req.body;
    if (!ip || !ip.trim()) return res.redirect('/admin');
    await BannedIp.findOneAndUpdate(
      { ip: ip.trim() },
      { ip: ip.trim(), reason: reason || 'Manual ban', autoBanned: false },
      { upsert: true }
    );
    res.redirect('/admin');
  } catch (err) {
    console.error(err);
    res.redirect('/admin');
  }
});

// Unban IP
router.post('/admin/unban-ip', authWeb, authAdmin, async (req, res) => {
  try {
    const { ip } = req.body;
    await BannedIp.deleteOne({ ip });
    res.redirect('/admin');
  } catch (err) {
    console.error(err);
    res.redirect('/admin');
  }
});
// Add or update package
router.post('/admin/package', authWeb, authAdmin, async (req, res) => {
  try {
    const { packageId, name, price, credits } = req.body;
    if (!name || isNaN(price) || isNaN(credits)) return res.redirect('/admin');

    if (packageId) {
      await Package.findByIdAndUpdate(packageId, { name, price, credits });
    } else {
      await Package.create({ name, price, credits });
    }
    res.redirect('/admin');
  } catch (err) {
    console.error(err);
    res.redirect('/admin');
  }
});

// Delete package
router.post('/admin/package/delete', authWeb, authAdmin, async (req, res) => {
  try {
    const { packageId } = req.body;
    await Package.findByIdAndDelete(packageId);
    res.redirect('/admin');
  } catch (err) {
    console.error(err);
    res.redirect('/admin');
  }
});

// ==== SEO ADMIN ROUTES ====
router.post('/admin/seo/save', authWeb, authAdmin, async (req, res) => {
  try {
    const { path, title, description, keywords, ogImage } = req.body;
    if (!path || !path.trim()) return res.redirect('/admin');

    await Seo.findOneAndUpdate(
      { path: path.trim() },
      { title, description, keywords, ogImage },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.redirect('/admin');
  } catch (err) {
    console.error('SEO save error:', err);
    res.redirect('/admin');
  }
});

router.post('/admin/seo/delete', authWeb, authAdmin, async (req, res) => {
  try {
    const { id } = req.body;
    await Seo.findByIdAndDelete(id);
    res.redirect('/admin');
  } catch (err) {
    console.error('SEO delete error:', err);
    res.redirect('/admin');
  }
});

module.exports = router;
