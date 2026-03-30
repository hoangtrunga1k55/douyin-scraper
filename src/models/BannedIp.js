const mongoose = require('mongoose');

const bannedIpSchema = new mongoose.Schema({
  ip: {
    type: String,
    required: true,
    unique: true,
    trim: true,
  },
  reason: {
    type: String,
    default: 'Manual ban',
  },
  autoBanned: {
    type: Boolean,
    default: false,
  },
  requestCount: {
    type: Number,
    default: 0,
  },
}, { timestamps: true });




const BannedIp = mongoose.model('BannedIp', bannedIpSchema);

module.exports = BannedIp;
