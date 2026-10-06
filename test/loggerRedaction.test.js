const test = require('node:test');
const assert = require('node:assert/strict');
const { redactSensitiveLogData } = require('../src/utils/logger');

test('redacts connector keys, OAuth credentials, authorization values, and signed URL queries', () => {
  const input = [
    'x-api-key=backend-key-secret',
    'access_token=oauth-access-secret',
    'refresh_token=oauth-refresh-secret',
    'client_secret=oauth-client-secret',
    'Authorization: Zoho-oauthtoken oauth-header-secret',
    'https://download.example.test/audit.csv?sig=signed-url-secret'
  ].join(' ');
  const redacted = redactSensitiveLogData(input);

  for (const secret of [
    'backend-key-secret',
    'oauth-access-secret',
    'oauth-refresh-secret',
    'oauth-client-secret',
    'oauth-header-secret',
    'signed-url-secret'
  ]) {
    assert.equal(redacted.includes(secret), false);
  }
});
