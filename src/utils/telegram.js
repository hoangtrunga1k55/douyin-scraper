const axios = require('axios');
const config = require('../config');
const logger = require('./logger');

/**
 * Send a message to Telegram using the bot API
 * @param {string} message Text message to be sent
 */
async function sendTelegramMessage(message) {
  const { botToken, chatId } = config.telegram;

  if (!botToken || !chatId) {
    logger.debug('Telegram alert skipped: missing botToken or chatId');
    return false;
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  try {
    const response = await axios.post(
      url,
      {
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
      },
      { timeout: 7000 }
    );
    if (response.data && response.data.ok) {
      logger.info('Telegram alert sent successfully');
      return true;
    }
    return false;
  } catch (error) {
    logger.error('Failed to send Telegram alert: ' + error.message);
    return false;
  }
}

module.exports = {
  sendTelegramMessage,
};
