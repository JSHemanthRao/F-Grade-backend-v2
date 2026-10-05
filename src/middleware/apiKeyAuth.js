const crypto = require('node:crypto');
const { env } = require('../config/env');
const { log } = require('../utils/logger');

function apiKeyAuth(req, res, next) {
  const supplied = req.get('x-api-key');
  const keyConfigured = Boolean(env.backendApiKey);
  const path = `${req.baseUrl}${req.path}` || req.path;
  const authenticated = keyConfigured && Boolean(supplied) && safeEqual(supplied, env.backendApiKey);

  log('info', `[API_KEY_AUTH] ${JSON.stringify({
    path,
    method: req.method,
    headerPresent: Boolean(supplied),
    keyConfigured,
    authenticated
  })}`);

  if (!authenticated) {
    log('warn', `[AUTH_FAILURE] ${JSON.stringify({ source: 'backend_api_key', path, method: req.method })}`);
    return res.status(401).json({
      success: false,
      status: 'error',
      error: { code: 'AUTHENTICATION_REQUIRED', message: 'A valid backend API key is required.' }
    });
  }
  return next();
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

module.exports = { apiKeyAuth };