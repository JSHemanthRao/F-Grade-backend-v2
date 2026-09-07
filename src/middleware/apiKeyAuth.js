const crypto = require('node:crypto');
const { env } = require('../config/env');

function apiKeyAuth(req, res, next) {
  if (!env.backendApiKey) return next();

  const supplied = req.get('x-api-key') || extractBearerToken(req.get('authorization'));
  if (!supplied || !safeEqual(supplied, env.backendApiKey)) {
    return res.status(401).json({
      success: false,
      status: 'error',
      error: { code: 'AUTHENTICATION_REQUIRED', message: 'A valid backend API key is required.' }
    });
  }
  return next();
}

function extractBearerToken(value) {
  const match = String(value || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

module.exports = { apiKeyAuth };