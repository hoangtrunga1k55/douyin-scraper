const mongoose = require('mongoose');

const seoSchema = new mongoose.Schema({
  path: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    index: true
  },
  title: {
    type: String,
    default: 'Tải Video TikTok & Douyin Miễn Phí - Không Watermark'
  },
  description: {
    type: String,
    default: ''
  },
  keywords: {
    type: String,
    default: ''
  },
  ogImage: {
    type: String,
    default: ''
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Seo', seoSchema);
