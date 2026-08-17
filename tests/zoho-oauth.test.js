const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { zohoClient } = require('../src/common/config/axios');
const authService = require('../src/common/auth/auth.service');
const tokenService = require('../src/common/auth/token.service');

function invalidTokenError(config) {
  const error = new Error('Request failed with status code 401');
  error.config = config;
  error.response = {
    status: 401,
    data: { code: 'INVALID_TOKEN', message: 'Authentication failed' },
  };
  return error;
}

test('OAuth manager caches the refreshed token until expiry', async () => {
  const originalPost = axios.post;
  let refreshCalls = 0;
  axios.post = async () => {
    refreshCalls += 1;
    return { data: { access_token: 'cached-token', expires_in: 3600 } };
  };

  try {
    tokenService.clearAccessToken();
    assert.equal(await authService.getAccessToken(), 'cached-token');
    assert.equal(await authService.getAccessToken(), 'cached-token');
    assert.equal(refreshCalls, 1);
  } finally {
    axios.post = originalPost;
    tokenService.clearAccessToken();
  }
});

test('OAuth manager treats a near-expiry token as unavailable', () => {
  tokenService.setAccessToken('short-lived-token', 1);
  assert.equal(tokenService.getAccessToken(), null);
  tokenService.clearAccessToken();
});

test('Zoho client refreshes once and retries INVALID_TOKEN with the new header', async () => {
  const originalPost = axios.post;
  const originalAdapter = zohoClient.defaults.adapter;
  const requests = [];
  let refreshCalls = 0;
  let requestCalls = 0;
  axios.post = async () => {
    refreshCalls += 1;
    return { data: { access_token: refreshCalls === 1 ? 'initial-token' : 'refreshed-token', expires_in: 3600 } };
  };
  zohoClient.defaults.adapter = async (config) => {
    requestCalls += 1;
    requests.push(String(config.headers?.Authorization || config.headers?.get?.('Authorization') || ''));
    if (requestCalls === 1) throw invalidTokenError(config);
    return { status: 200, statusText: 'OK', headers: {}, config, data: { data: [] } };
  };

  try {
    tokenService.clearAccessToken();
    const response = await zohoClient.get('/crm/v8/Deals');
    assert.equal(response.status, 200);
    assert.equal(requestCalls, 2);
    assert.equal(refreshCalls, 2);
    assert.equal(requests[0], 'Zoho-oauthtoken initial-token');
    assert.equal(requests[1], 'Zoho-oauthtoken refreshed-token');
  } finally {
    axios.post = originalPost;
    zohoClient.defaults.adapter = originalAdapter;
    tokenService.clearAccessToken();
  }
});

test('refresh failure returns a sanitized authentication error', async () => {
  const originalPost = axios.post;
  const originalAdapter = zohoClient.defaults.adapter;
  axios.post = async () => {
    const error = new Error('token endpoint rejected refresh credentials');
    error.response = { status: 400, data: { error: 'invalid_code' } };
    throw error;
  };
  zohoClient.defaults.adapter = async (config) => {
    throw invalidTokenError(config);
  };

  try {
    tokenService.clearAccessToken();
    await assert.rejects(
      () => zohoClient.get('/crm/v8/Deals'),
      (error) => error.code === 'ZOHO_AUTHENTICATION_ERROR'
        && error.status === 502
        && !String(error.message).includes('token endpoint'),
    );
  } finally {
    axios.post = originalPost;
    zohoClient.defaults.adapter = originalAdapter;
    tokenService.clearAccessToken();
  }
});
