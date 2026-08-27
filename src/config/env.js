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
  corsOrigin: process.env.CORS_ORIGIN || '*',
  backendApiUrl: process.env.BACKEND_API_URL || 'http://localhost:3000',
  backendApiPath: process.env.BACKEND_API_PATH || '/api/crm/assistant',
  backendApiKey: process.env.BACKEND_API_KEY || '',
  backendRequestTimeoutMs: numberFromEnv('BACKEND_REQUEST_TIMEOUT_MS', 15000),
  backendDiagnostics: process.env.BACKEND_DIAGNOSTICS === 'true',
  zohoMaxRetries: numberFromEnv('ZOHO_MAX_RETRIES', 2),
  zohoCircuitFailureThreshold: numberFromEnv('ZOHO_CIRCUIT_FAILURE_THRESHOLD', 3),
  zohoCircuitResetTimeoutMs: numberFromEnv('ZOHO_CIRCUIT_RESET_TIMEOUT_MS', 30000),
  zohoMaxConcurrency: numberFromEnv('ZOHO_MAX_CONCURRENCY', 4)
});

module.exports = { env };
