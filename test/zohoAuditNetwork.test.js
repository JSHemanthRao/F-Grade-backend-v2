const test = require('node:test');
const assert = require('node:assert/strict');
const { ZohoAuditLogService } = require('../src/services/zohoAuditLog.service');

const config = {
  accountsUrl: 'https://accounts.zoho.in',
  apiBaseUrl: 'https://www.zohoapis.in/crm/v8',
  timeoutMs: 1000,
  clientId: 'test-client-id-secret',
  clientSecret: 'test-client-secret-secret',
  refreshToken: 'test-refresh-token-secret'
};
const accessToken = 'test-access-token-secret';

function createHarness(handler, options = {}) {
  const calls = [];
  const delays = [];
  const authService = {
    getAccessToken: async () => accessToken,
    getApiDomain: () => 'https://www.zohoapis.in',
    clearToken: () => {}
  };
  const client = {
    get: async (url, requestOptions) => {
      calls.push({ method: 'GET', url, requestOptions });
      return handler({ method: 'GET', url, requestOptions, call: calls.length });
    },
    post: async (url, data, requestOptions) => {
      calls.push({ method: 'POST', url, data, requestOptions });
      return handler({ method: 'POST', url, data, requestOptions, call: calls.length });
    }
  };
  const service = new ZohoAuditLogService(
    client,
    () => config,
    authService,
    async (milliseconds) => delays.push(milliseconds),
  );
  return { service, calls, delays };
}

function networkError(code, message = `Socket failed: ${accessToken}`) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function httpError(status, code = `ZOHO_${status}`) {
  const error = new Error(`HTTP ${status}`);
  error.response = { status, data: { code, message: `Zoho HTTP ${status}` } };
  return error;
}

async function request(service, hostname = 'www.zohoapis.in') {
  return service.request(
    'post',
    `https://${hostname}/crm/v8/settings/audit_log_export`,
    config,
    { audit_log_export: [] },
    { zohoApiRequest: true },
  );
}

test('returns successful upstream responses without retrying', async () => {
  const { service, calls, delays } = createHarness(async () => ({ status: 200, data: { ok: true } }));
  const response = await request(service);
  assert.equal(response.data.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(delays, []);
});

test('retries ECONNRESET once and succeeds', async () => {
  const { service, calls, delays } = createHarness(async ({ call }) => {
    if (call === 1) throw networkError('ECONNRESET');
    return { status: 200, data: { ok: true } };
  });
  const response = await request(service);
  assert.equal(response.data.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(delays, [500]);
});

test('stops after three ECONNRESET attempts with a network-specific error and redacted logs', async () => {
  const { service, calls, delays } = createHarness(async () => {
    throw networkError('ECONNRESET', `Socket failed ${accessToken} ${config.clientId} ${config.clientSecret} ${config.refreshToken}`);
  });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  let error;
  try {
    await assert.rejects(request(service), (caught) => {
      error = caught;
      return true;
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [500, 1000]);
  assert.equal(error.code, 'AUDIT_LOG_UPSTREAM_NETWORK_ERROR');
  assert.equal(error.statusCode, 502);
  assert.deepEqual(error.details, { operation: 'audit_log', upstream_status: null, upstream_code: null });
  const diagnosticText = warnings.join('\n');
  for (const secret of [accessToken, config.clientId, config.clientSecret, config.refreshToken]) {
    assert.equal(diagnosticText.includes(secret), false);
  }
  assert.match(diagnosticText, /ZOHO_AUDIT_NETWORK_ERROR/);
  assert.match(diagnosticText, /ECONNRESET/);
  assert.match(diagnosticText, /www\.zohoapis\.in/);
});

test('retries ETIMEDOUT and succeeds', async () => {
  const { service, calls, delays } = createHarness(async ({ call }) => {
    if (call === 1) throw networkError('ETIMEDOUT');
    return { status: 200, data: { ok: true } };
  });
  const response = await request(service);
  assert.equal(response.data.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(delays, [500]);
});

test('does not network-retry HTTP responses', async (t) => {
  for (const status of [400, 403, 429, 500, 502, 503, 504]) {
    await t.test(`HTTP ${status}`, async () => {
      const { service, calls, delays } = createHarness(async () => { throw httpError(status); });
      await assert.rejects(request(service), (error) => {
        assert.equal(error.details.upstream_status, status);
        assert.equal(error.details.upstream_code, `ZOHO_${status}`);
        assert.equal(error.code, status === 403 ? 'ZOHO_AUTHORIZATION_ERROR' : `ZOHO_${status}`);
        return true;
      });
      assert.equal(calls.length, 1);
      assert.deepEqual(delays, []);
    });
  }
});

test('does not retry ENOTFOUND and reports no upstream HTTP response', async () => {
  const { service, calls, delays } = createHarness(async () => { throw networkError('ENOTFOUND'); });
  await assert.rejects(request(service, 'missing-hostname.invalid'), (error) => {
    assert.equal(error.code, 'AUDIT_LOG_UPSTREAM_NETWORK_ERROR');
    assert.equal(error.details.upstream_status, null);
    assert.equal(error.details.upstream_code, null);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(delays, []);
});
