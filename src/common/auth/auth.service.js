const axios = require('axios');
const {
  ZOHO_ACCOUNTS_URL,
  ZOHO_CLIENT_ID,
  ZOHO_CLIENT_SECRET,
  ZOHO_REFRESH_TOKEN,
} = require('../config/env');
const tokenService = require('./token.service');

let refreshPromise = null;

function assertOAuthConfig() {
  const missing = [];

  if (!ZOHO_CLIENT_ID) missing.push('ZOHO_CLIENT_ID');
  if (!ZOHO_CLIENT_SECRET) missing.push('ZOHO_CLIENT_SECRET');
  if (!ZOHO_REFRESH_TOKEN) missing.push('ZOHO_REFRESH_TOKEN');

  if (missing.length > 0) {
    throw new Error(`Missing Zoho OAuth environment variables: ${missing.join(', ')}`);
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

  const response = await axios.post(tokenUrl, params, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    timeout: 10000,
    signal: options.signal,
  });

  if (!response.data?.access_token) {
    throw new Error('Zoho OAuth did not return an access token.');
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

module.exports = {
  getAccessToken,
  getAuthorizationHeader,
  refreshAccessToken,
};
