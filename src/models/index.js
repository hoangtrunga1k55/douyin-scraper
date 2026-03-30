const mongoose = require('mongoose');
const config = require('../config');
const logger = require('../utils/logger');

const connectDB = async () => {
  try {
    await mongoose.connect(config.mongoUri);
    logger.info(`✅ MongoDB Connected: ${config.mongoUri}`);
  } catch (error) {
    logger.error(`❌ MongoDB Connection Error: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
