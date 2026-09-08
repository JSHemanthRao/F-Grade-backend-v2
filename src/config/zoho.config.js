const { env } = require('./env');

function required(primaryName, ...aliases) {
  const value = [primaryName, ...aliases].map((name) => process.env[name]).find(Boolean);
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

function deriveBulkApiBaseUrl(apiBaseUrl) {
  return apiBaseUrl.replace(/\/crm\/v\d+$/i, '/crm/bulk/v8');
}

function getZohoConfig() {
  const apiBaseUrl = normalizeApiBaseUrl(
    process.env.ZOHO_API_BASE_URL || process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com'
  );
  return {
    accountsUrl: (process.env.ZOHO_ACCOUNTS_URL || deriveAccountsUrl(apiBaseUrl)).replace(/\/$/, ''),
    apiBaseUrl,
    bulkApiBaseUrl: process.env.ZOHO_BULK_API_BASE_URL || deriveBulkApiBaseUrl(apiBaseUrl),
    clientId: required('ZOHO_CRM_CLIENT_ID', 'ZOHO_CLIENT_ID', 'CLIENT_ID'),
    clientSecret: required('ZOHO_CRM_CLIENT_SECRET', 'ZOHO_CLIENT_SECRET', 'CLIENT_SECRET'),
    refreshToken: required('ZOHO_CRMREFRESH_TOKEN_CRM', 'ZOHO_CRM_REFRESH_TOKEN', 'ZOHO_REFRESH_TOKEN', 'REFRESH_TOKEN'),
    timeoutMs: env.zohoRequestTimeoutMs
  };
}

module.exports = { getZohoConfig, normalizeApiBaseUrl, deriveAccountsUrl, deriveBulkApiBaseUrl };
