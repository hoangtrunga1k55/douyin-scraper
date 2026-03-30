const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
    match: [/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, 'Please enter a valid email address'],
  },
  passwordHash: {
    type: String,
    required: true,
  },
  role: {
    type: String,
    enum: ['admin', 'user'],
    default: 'user',
  },
  apiToken: {
    type: String,
    unique: true,
    default: () => crypto.randomBytes(32).toString('hex'),
  },
  credits: {
    type: Number,
    default: 200,
    min: 0,
  },
  banned: {
    type: Boolean,
    default: false,
  },
}, { timestamps: true });

// Pre-save hook to hash password if it was modified
userSchema.pre('save', async function () {
  if (!this.isModified('passwordHash')) return;
  const salt = await bcrypt.genSalt(10);
  this.passwordHash = await bcrypt.hash(this.passwordHash, salt);
});

// Method to compare password
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.passwordHash);
};

// Method to regenerate API Token
userSchema.methods.regenerateToken = async function () {
  this.apiToken = crypto.randomBytes(32).toString('hex');
  await this.save();
  return this.apiToken;
};

const User = mongoose.model('User', userSchema);

module.exports = User;
