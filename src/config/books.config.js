const { env } = require('./env');

function requiredBooksEnv(primaryName, ...aliases) {
  const value = [primaryName, ...aliases].map((name) => process.env[name]).find(Boolean);
  if (!value) {
    const error = new Error(`Missing required Zoho Books environment variable: ${primaryName}`);
    error.code = 'BOOKS_CONFIGURATION_ERROR';
    error.statusCode = 502;
    throw error;
  }
  return value;
}

function normalizeBooksApiBaseUrl(value) {
  const trimmed = String(value || '').replace(/\/$/, '');
  if (!trimmed) return 'https://www.zohoapis.com/books/v3';
  return /\/books\/v\d+$/i.test(trimmed) ? trimmed : `${trimmed}/books/v3`;
}

function deriveBooksAccountsUrl(apiBaseUrl) {
  const match = apiBaseUrl.match(/^https?:\/\/www\.zohoapis\.([a-z.]+)/i);
  return match ? `https://accounts.zoho.${match[1]}` : 'https://accounts.zoho.com';
}

function getZohoBooksConfig() {
  const apiBaseUrl = normalizeBooksApiBaseUrl(
    process.env.BOOKS_API_BASE_URL || process.env.BOOKS_API_DOMAIN || process.env.ZOHO_BOOKS_API_BASE_URL || 'https://www.zohoapis.com'
  );

  return {
    accountsUrl: (process.env.BOOKS_ACCOUNTS_URL || process.env.ZOHO_BOOKS_ACCOUNTS_URL || deriveBooksAccountsUrl(apiBaseUrl)).replace(/\/$/, ''),
    apiBaseUrl,
    clientId: requiredBooksEnv(
      'BOOKS_CLIENT_ID',
      'ZOHO_BOOKS_CLIENT_ID',
      'BOOKS_CLIENT_ID_OLD',
      'ZOHO_BOOKS_CLIENT_ID_OLD'
    ),
    clientSecret: requiredBooksEnv(
      'BOOKS_CLIENT_SECRET',
      'ZOHO_BOOKS_CLIENT_SECRET',
      'BOOKS_CLIENT_SECRET_OLD',
      'ZOHO_BOOKS_CLIENT_SECRET_OLD'
    ),
    refreshToken: requiredBooksEnv(
      'BOOKS_REFRESH_TOKEN',
      'ZOHO_BOOKS_REFRESH_TOKEN',
      'ZOHO_BOOKS_REFRESH_TOKEN_BOOKS',
      'ZOHO_BOOKS_REFRESH_TOKEN_OLD'
    ),
    organizationId: requiredBooksEnv(
      'BOOKS_ORGANIZATION_ID',
      'ZOHO_BOOKS_ORGANIZATION_ID'
    ),
    timeoutMs: env.zohoRequestTimeoutMs
  };
}

module.exports = { getZohoBooksConfig, normalizeBooksApiBaseUrl, deriveBooksAccountsUrl };
