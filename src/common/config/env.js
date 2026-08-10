require('dotenv').config();

function toNumber(value, fallback) {
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : fallback;
}

function assertRequiredZohoConfig() {
  const missing = [];

  if (!process.env.ZOHO_CLIENT_ID && !process.env.CLIENT_ID) {
    missing.push('ZOHO_CLIENT_ID or CLIENT_ID');
  }

  if (!process.env.ZOHO_CLIENT_SECRET && !process.env.CLIENT_SECRET) {
    missing.push('ZOHO_CLIENT_SECRET or CLIENT_SECRET');
  }

  if (!process.env.ZOHO_REFRESH_TOKEN && !process.env.REFRESH_TOKEN) {
    missing.push('ZOHO_REFRESH_TOKEN or REFRESH_TOKEN');
  }

  if (!process.env.ZOHO_API_DOMAIN && !process.env.API_DOMAIN) {
    missing.push('ZOHO_API_DOMAIN or API_DOMAIN');
  }

  if (missing.length > 0) {
    throw new Error(`Missing required Zoho CRM environment variables: ${missing.join(', ')}`);
  }
}

assertRequiredZohoConfig();

const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || process.env.CLIENT_ID || '';
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || process.env.CLIENT_SECRET || '';
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || process.env.REFRESH_TOKEN || '';
const ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || process.env.API_DOMAIN || '';

module.exports = {
  APP_NAME: process.env.APP_NAME || 'F-Grade Corporate AI Backend',
  NODE_ENV: process.env.NODE_ENV || 'development',
  DEBUG_ASSISTANT: process.env.DEBUG_ASSISTANT === 'true' || process.env.DEBUG_ASSISTANT === '1',
  PORT: toNumber(process.env.PORT, 3000),
  ZOHO_ACCOUNTS_URL: process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.in',
  ZOHO_API_DOMAIN,
  // Keep individual CRM calls comfortably below the Copilot connector
  // deadline. Deployments can still override this explicitly.
  ZOHO_API_TIMEOUT_MS: toNumber(process.env.ZOHO_API_TIMEOUT_MS, 15000),
  ZOHO_CLIENT_ID,
  ZOHO_CLIENT_SECRET,
  ZOHO_REFRESH_TOKEN,
  CLIENT_ID: ZOHO_CLIENT_ID,
  CLIENT_SECRET: ZOHO_CLIENT_SECRET,
  REFRESH_TOKEN: ZOHO_REFRESH_TOKEN,
  API_DOMAIN: ZOHO_API_DOMAIN,
};
