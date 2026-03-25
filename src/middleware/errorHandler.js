const logger = require('../utils/logger');

/**
 * Global error handler middleware
 */
function errorHandler(err, req, res, _next) {
  logger.error(`${err.message}`, { stack: err.stack, path: req.path });

  // Axios errors (upstream API failures)
  if (err.response) {
    return res.status(502).json({
      success: false,
      error: 'Upstream API error',
      message: `Douyin API returned status ${err.response.status}`,
      details: err.response.data?.status_msg || null,
    });
  }

  // Timeout errors
  if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
    return res.status(504).json({
      success: false,
      error: 'Request timeout',
      message: 'The request to Douyin timed out. Please try again.',
    });
  }

  // Validation errors
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      error: 'Validation error',
      message: err.message,
    });
  }

  // Default server error
  return res.status(err.statusCode || 500).json({
    success: false,
    error: err.name || 'Internal Server Error',
    message: err.message || 'An unexpected error occurred',
  });
}

module.exports = errorHandler;
