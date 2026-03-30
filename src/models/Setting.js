const mongoose = require('mongoose');

const settingSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true,
    trim: true,
  },
  value: {
    type: mongoose.Schema.Types.Mixed,
    required: true,
  },
  label: {
    type: String,
    default: '',
  },
}, { timestamps: true });

// Get a setting value by key, with a fallback default
settingSchema.statics.get = async function (key, defaultValue = null) {
  const doc = await this.findOne({ key });
  return doc ? doc.value : defaultValue;
};

// Set a setting value by key (upsert)
settingSchema.statics.set = async function (key, value, label = '') {
  return this.findOneAndUpdate(
    { key },
    { value, ...(label ? { label } : {}) },
    { upsert: true, new: true }
  );
};

const Setting = mongoose.model('Setting', settingSchema);

// Seed default settings if they don't exist
Setting.init().then(async () => {
  const defaults = [
    { key: 'credit_video_parse', value: 10, label: 'Credits per /api/video/parse' },
    { key: 'credit_video_download', value: 10, label: 'Credits per /api/video/download' },
    { key: 'credit_channel_videos', value: 20, label: 'Credits per /api/channel/videos' },
    { key: 'credit_channel_download', value: 20, label: 'Credits per /api/channel/download' },
    { key: 'default_user_credits', value: 200, label: 'Default credits for new users' },
    { key: 'ip_rate_limit', value: 30, label: 'IP soft rate limit (requests/window, 429)' },
    { key: 'ip_rate_window_minutes', value: 1, label: 'IP rate window (minutes)' },
    { key: 'ip_auto_ban_threshold', value: 100, label: 'IP auto-ban threshold (requests/window)' },
    { key: 'bank_id', value: 'mbbank', label: 'Bank ID (VietQR)' },
    { key: 'bank_account', value: '113366668888', label: 'Bank Account Number' },
    { key: 'bank_account_name', value: 'THQ SOLUTION', label: 'Bank Account Name' },
  ];

  for (const d of defaults) {
    const exists = await Setting.findOne({ key: d.key });
    if (!exists) {
      await Setting.create(d);
    }
  }
});

module.exports = Setting;
