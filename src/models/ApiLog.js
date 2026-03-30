const mongoose = require('mongoose');

const apiLogSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  email: {
    type: String,
  },
  endpoint: {
    type: String,
    required: true,
  },
  method: {
    type: String,
    required: true,
  },
  ip: {
    type: String,
  },
  userAgent: {
    type: String,
  },
  creditsCost: {
    type: Number,
    default: 0,
  },
  creditsRemaining: {
    type: Number,
    default: 0,
  },
  statusCode: {
    type: Number,
  },
  success: {
    type: Boolean,
    default: true,
  },
}, { timestamps: true });

// Index for fast queries
apiLogSchema.index({ createdAt: -1 });
apiLogSchema.index({ userId: 1, createdAt: -1 });

const ApiLog = mongoose.model('ApiLog', apiLogSchema);

module.exports = ApiLog;
