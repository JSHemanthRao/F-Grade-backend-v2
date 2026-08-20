const dotenv = require('dotenv');

dotenv.config();

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const env = Object.freeze({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: numberFromEnv('PORT', 3000),
  requestBodyLimit: process.env.REQUEST_BODY_LIMIT || '100kb',
  logLevel: process.env.LOG_LEVEL || 'info',
  zohoRequestTimeoutMs: numberFromEnv('ZOHO_REQUEST_TIMEOUT_MS', 15000),
  corsOrigin: process.env.CORS_ORIGIN || '*'
});

module.exports = { env };
