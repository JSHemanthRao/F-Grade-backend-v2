const { env } = require('./env');

function required(primaryName, legacyName) {
  const value = process.env[primaryName] || (legacyName && process.env[legacyName]);
  if (!value) {
    const error = new Error(`Missing required Zoho environment variable: ${primaryName}`);
    error.code = 'ZOHO_CONFIGURATION_ERROR';
    error.statusCode = 502;
    throw error;
  }
  return value;
}

function normalizeApiBaseUrl(value) {
  const url = value.replace(/\/$/, '');
  return /\/crm\/v\d+$/i.test(url) ? url : `${url}/crm/v8`;
}

function deriveAccountsUrl(apiBaseUrl) {
  const match = apiBaseUrl.match(/^https?:\/\/www\.zohoapis\.([a-z.]+)/i);
  return match ? `https://accounts.zoho.${match[1]}` : 'https://accounts.zoho.com';
}

function getZohoConfig() {
  const apiBaseUrl = normalizeApiBaseUrl(
    process.env.ZOHO_API_BASE_URL || process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com'
  );
  return {
    accountsUrl: (process.env.ZOHO_ACCOUNTS_URL || deriveAccountsUrl(apiBaseUrl)).replace(/\/$/, ''),
    apiBaseUrl,
    clientId: required('ZOHO_CLIENT_ID', 'CLIENT_ID'),
    clientSecret: required('ZOHO_CLIENT_SECRET', 'CLIENT_SECRET'),
    refreshToken: required('ZOHO_REFRESH_TOKEN', 'REFRESH_TOKEN'),
    timeoutMs: env.zohoRequestTimeoutMs
  };
}

module.exports = { getZohoConfig, normalizeApiBaseUrl, deriveAccountsUrl };
