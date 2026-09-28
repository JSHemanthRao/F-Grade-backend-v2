const { env } = require('./env');

function required(primaryName, ...aliases) {
  const value = [primaryName, ...aliases].map((name) => process.env[name]).find(Boolean);
  if (!value) {
    const error = new Error(`Missing required Zoho Books environment variable: ${primaryName}`);
    error.code = 'BOOKS_CONFIGURATION_ERROR';
    error.statusCode = 502;
    throw error;
  }
  return value;
}

function getZohoBooksConfig() {
  const apiBaseUrl = (process.env.BOOKS_API_BASE_URL || 'https://www.zohoapis.com/books/v3').replace(/\/$/, '');
  const accountsUrl = (process.env.BOOKS_ACCOUNTS_URL || 'https://accounts.zoho.com').replace(/\/$/, '');
  return {
    accountsUrl,
    apiBaseUrl,
    clientId: required('BOOKS_CLIENT_ID', 'ZOHO_BOOKS_CLIENT_ID'),
    clientSecret: required('BOOKS_CLIENT_SECRET', 'ZOHO_BOOKS_CLIENT_SECRET'),
    refreshToken: required('BOOKS_REFRESH_TOKEN', 'ZOHO_BOOKS_REFRESH_TOKEN'),
    organizationId: required('BOOKS_ORGANIZATION_ID', 'ZOHO_BOOKS_ORGANIZATION_ID'),
    timeoutMs: env.zohoRequestTimeoutMs || 15000
  };
}

module.exports = { getZohoBooksConfig };
