const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function positiveIntegerFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeIntegerFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

const env = Object.freeze({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: numberFromEnv('PORT', 3000),
  requestBodyLimit: process.env.REQUEST_BODY_LIMIT || '100kb',
  requestTimeoutMs: positiveIntegerFromEnv('REQUEST_TIMEOUT_MS', 60000),
  logLevel: process.env.LOG_LEVEL || 'info',
  zohoRequestTimeoutMs: numberFromEnv('ZOHO_REQUEST_TIMEOUT_MS', 15000),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  backendApiUrl: process.env.BACKEND_API_URL || 'http://localhost:3000',
  backendApiPath: process.env.BACKEND_API_PATH || '/api/crm/assistant',
  backendApiKey: (process.env.BACKEND_API_KEY || '').trim(),
  backendRequestTimeoutMs: numberFromEnv('BACKEND_REQUEST_TIMEOUT_MS', 15000),
  backendDiagnostics: process.env.BACKEND_DIAGNOSTICS === 'true',
  botRateLimitWindowMs: positiveIntegerFromEnv('BOT_RATE_LIMIT_WINDOW_MS', 60000),
  botCrmRateLimit: positiveIntegerFromEnv('BOT_CRM_RATE_LIMIT', 30),
  botAggregateRateLimit: positiveIntegerFromEnv('BOT_AGGREGATE_RATE_LIMIT', 10),
  botAuditRateLimit: positiveIntegerFromEnv('BOT_AUDIT_RATE_LIMIT', 5),
  trustProxyHops: nonNegativeIntegerFromEnv('TRUST_PROXY_HOPS', process.env.NODE_ENV === 'production' ? 1 : 0),
  crmDebug: process.env.CRM_DEBUG === 'true',
  zohoMaxRetries: numberFromEnv('ZOHO_MAX_RETRIES', 2),
  zohoCircuitFailureThreshold: numberFromEnv('ZOHO_CIRCUIT_FAILURE_THRESHOLD', 3),
  zohoCircuitResetTimeoutMs: numberFromEnv('ZOHO_CIRCUIT_RESET_TIMEOUT_MS', 30000),
  zohoMaxConcurrency: numberFromEnv('ZOHO_MAX_CONCURRENCY', 4),
  zohoMaxQueryBudget: numberFromEnv('ZOHO_MAX_QUERY_BUDGET', 20),
  zohoMetadataTtlMs: numberFromEnv('ZOHO_METADATA_TTL_MS', 300000),
  crmTimezone: process.env.CRM_TIMEZONE || process.env.APPLICATION_TIMEZONE || 'Asia/Kolkata',
  useZohoMetadataForStaticModules: process.env.USE_ZOHO_METADATA_FOR_STATIC_MODULES === 'true',
  // Path to a directory containing Copilot Studio skills. Can be overridden with SKILLS_PATH env var.
  skillsPath: process.env.SKILLS_PATH || path.resolve(__dirname, '..', '..', 'skills')
});

module.exports = { env };
