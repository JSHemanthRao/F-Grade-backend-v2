const axios = require('axios');
const {
  ZOHO_ACCOUNTS_URL,
  ZOHO_CLIENT_ID,
  ZOHO_CLIENT_SECRET,
  ZOHO_REFRESH_TOKEN,
  ZOHO_API_DOMAIN,
} = require('../config/env');
const tokenService = require('./token.service');

let refreshPromise = null;

const ACCOUNTS_HOST_BY_API_HOST = {
  'zohoapis.com': 'accounts.zoho.com',
  'zohoapis.eu': 'accounts.zoho.eu',
  'zohoapis.in': 'accounts.zoho.in',
  'zohoapis.com.au': 'accounts.zoho.com.au',
  'zohoapis.jp': 'accounts.zoho.jp',
  'zohoapis.sa': 'accounts.zoho.sa',
  'zohoapis.ca': 'accounts.zoho.ca',
  'zohoapis.com.cn': 'accounts.zoho.com.cn',
};

function authenticationError(message, cause) {
  const error = new Error(message);
  error.code = 'ZOHO_AUTHENTICATION_ERROR';
  error.status = 502;
  error.isZohoAuthenticationError = true;
  if (cause) error.cause = cause;
  return error;
}

function assertDataCenterConfiguration() {
  const apiHost = new URL(ZOHO_API_DOMAIN).hostname.toLowerCase();
  const accountsUrl = new URL(ZOHO_ACCOUNTS_URL);
  const expectedAccountsHost = ACCOUNTS_HOST_BY_API_HOST[apiHost];

  if (expectedAccountsHost && accountsUrl.hostname.toLowerCase() !== expectedAccountsHost) {
    throw authenticationError('Zoho API and Accounts domains must belong to the same data center.');
  }
}

function assertOAuthConfig() {
  const missing = [];

  if (!ZOHO_CLIENT_ID) missing.push('ZOHO_CLIENT_ID');
  if (!ZOHO_CLIENT_SECRET) missing.push('ZOHO_CLIENT_SECRET');
  if (!ZOHO_REFRESH_TOKEN) missing.push('ZOHO_REFRESH_TOKEN');

  if (missing.length > 0) {
    throw authenticationError(`Missing Zoho OAuth environment variables: ${missing.join(', ')}`);
  }

  try {
    assertDataCenterConfiguration();
  } catch (error) {
    if (error.isZohoAuthenticationError) throw error;
    throw authenticationError('Zoho API and Accounts domains must be valid and belong to the same data center.', error);
  }
}

async function refreshAccessToken(options = {}) {
  assertOAuthConfig();

  const tokenUrl = new URL('/oauth/v2/token', ZOHO_ACCOUNTS_URL).toString();
  const params = new URLSearchParams({
    refresh_token: ZOHO_REFRESH_TOKEN,
    client_id: ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });

  let response;
  try {
    response = await axios.post(tokenUrl, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 10000,
      signal: options.signal,
    });
  } catch (error) {
    throw authenticationError('Zoho authentication failed while refreshing the access token.', error);
  }

  if (!response.data?.access_token) {
    throw authenticationError('Zoho authentication failed because no access token was returned.');
  }

  tokenService.setAccessToken(response.data.access_token, response.data.expires_in);

  return response.data.access_token;
}

async function getAccessToken(options = {}) {
  if (!options.forceRefresh) {
    const cachedToken = tokenService.getAccessToken();

    if (cachedToken) {
      return cachedToken;
    }
  }

  if (!refreshPromise) {
    refreshPromise = refreshAccessToken(options).finally(() => {
      refreshPromise = null;
    });
  }

  return refreshPromise;
}

async function getAuthorizationHeader(options = {}) {
  const accessToken = await getAccessToken(options);

  return `Zoho-oauthtoken ${accessToken}`;
}

function isInvalidTokenError(error) {
  const status = error?.response?.status;
  const code = String(error?.response?.data?.code || '').toUpperCase();
  const message = String(error?.response?.data?.message || '').toUpperCase();
  return status === 401 && (code === 'INVALID_TOKEN' || message.includes('INVALID_TOKEN'));
}

module.exports = {
  authenticationError,
  getAccessToken,
  getAuthorizationHeader,
  isInvalidTokenError,
  refreshAccessToken,
};
