const mongoose = require('mongoose');

const packageSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  price: {
    type: Number,
    required: true,
    min: 0,
  },
  credits: {
    type: Number,
    required: true,
    min: 1,
  },
}, { timestamps: true });

const Package = mongoose.model('Package', packageSchema);

module.exports = Package;
