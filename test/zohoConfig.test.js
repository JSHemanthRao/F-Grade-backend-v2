const test = require('node:test');
const assert = require('node:assert/strict');
const { getZohoConfig } = require('../src/config/zoho.config');

test('accepts the legacy Zoho refresh-token environment variable name', () => {
  const names = [
    'ZOHO_REFRESH_TOKEN',
    'ZOHO_REFRESH_TOKEN_CRM',
    'ZOHO_CRM_REFRESH_TOKEN',
    'ZOHO_CRMREFRESH_TOKEN_CRM',
    'REFRESH_TOKEN'
  ];
  const originalValues = new Map(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    process.env.ZOHO_REFRESH_TOKEN_CRM = 'test-refresh-token';
    assert.equal(getZohoConfig().refreshToken, 'test-refresh-token');
  } finally {
    for (const [name, value] of originalValues) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
