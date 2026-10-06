const test = require('node:test');
const assert = require('node:assert/strict');
const { ZohoAuditLogService } = require('../src/services/zohoAuditLog.service');
const { ZohoAuthService } = require('../src/services/zohoAuth.service');
const { CrmService } = require('../src/services/crm.service');
const { ZohoCrmService } = require('../src/services/zohoCrm.service');

const config = {
  accountsUrl: 'https://accounts.zoho.in',
  apiBaseUrl: 'https://www.zohoapis.com/crm/v8',
  timeoutMs: 1000
};

test('refreshes a rejected Zoho token and retries the audit export', async () => {
  let tokenRequests = 0;
  const auditTokens = [];
  const client = {
    post: async (url, _body, options) => {
      if (url.includes('/oauth/v2/token')) {
        tokenRequests += 1;
        return { data: { access_token: `access-${tokenRequests}`, api_domain: 'https://www.zohoapis.in', expires_in: 3600 } };
      }
      assert.match(url, /^https:\/\/www\.zohoapis\.in\/crm\/v8\//);
      auditTokens.push(options.headers.Authorization);
      if (auditTokens.length === 1) {
        const error = new Error('expired token');
        error.response = { status: 401, data: { code: 'INVALID_TOKEN' } };
        throw error;
      }
      return { data: { audit_log_export: [{ details: { id: 'job-1' } }] } };
    },
    get: async (url, options) => {
      if (url.endsWith('/job-1')) {
        assert.equal(options.headers.Authorization, 'Zoho-oauthtoken access-2');
        return { data: { audit_log_export: [{ status: 'finished', download_links: ['https://download.zoho.in/audit.csv'] }] } };
      }
      assert.equal(url, 'https://download.zoho.in/audit.csv');
      assert.equal(options.headers.Authorization, 'Zoho-oauthtoken access-2');
      return { data: 'audited_time,action,module\n2026-10-02T10:00:00+05:30,updated,Deals' };
    }
  };
  const auth = new ZohoAuthService(client, () => ({ ...config, clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh' }));
  const service = new ZohoAuditLogService(client, () => config, auth);

  const result = await service.getAuditLogs({
    date_range: { start: '2026-10-02', end: '2026-10-03' }
  });

  assert.equal(tokenRequests, 2);
  assert.deepEqual(auditTokens, ['Zoho-oauthtoken access-1', 'Zoho-oauthtoken access-2']);
  assert.equal(result.records[0].module, 'Deals');
});

test('returns a gateway error, not connector 401, when Zoho rejects refreshed auth', async () => {
  let clearCount = 0;
  const client = {
    post: async () => {
      const error = new Error('Zoho token rejected');
      error.response = { status: 401, data: { code: 'INVALID_TOKEN', message: 'Invalid token' } };
      throw error;
    }
  };
  const auth = {
    getAccessToken: async () => 'sensitive-access-token',
    getApiDomain: () => null,
    clearToken: () => { clearCount += 1; }
  };
  const service = new ZohoAuditLogService(client, () => config, auth);

  await assert.rejects(service.getAuditLogs(), (error) => {
    assert.equal(error.statusCode, 502);
    assert.equal(error.code, 'ZOHO_AUTHENTICATION_ERROR');
    assert.equal(error.details.upstream_status, 401);
    assert.doesNotMatch(error.message, /sensitive-access-token|Invalid token/);
    return true;
  });
  assert.equal(clearCount, 2);
});

test('resolves a named audit module to its Zoho module ID', async () => {
  let auditParams;
  const zoho = {
    resolveModuleApiName: async () => 'Deals',
    getModulesMetadata: async () => ({ modules: [{ api_name: 'Deals', id: 'module-42' }] }),
    auditLogService: {
      getAuditLogs: async (params) => {
        auditParams = params;
        return { records: [] };
      }
    }
  };

  await new CrmService(zoho).queryAuditLog({
    audit_log: { entity: 'Deals' },
    limit: 20,
    offset: 0
  });

  assert.equal(auditParams.entity, 'Deals');
  assert.equal(auditParams.entity_id, 'module-42');
});

test('refreshes an expired Zoho CRM token and retries the original request once', async () => {
  let token = 'expired-token';
  let clearCount = 0;
  const authorizationHeaders = [];
  const client = {
    post: async (_url, _data, options) => {
      authorizationHeaders.push(options.headers.Authorization);
      if (authorizationHeaders.length === 1) {
        const error = new Error('expired access token');
        error.response = { status: 401, data: { code: 'INVALID_TOKEN' } };
        throw error;
      }
      return { status: 200, data: { data: [{ id: 'deal-1' }], info: { more_records: false } } };
    }
  };
  const auth = {
    getAccessToken: async () => token,
    getApiDomain: () => 'https://www.zohoapis.com',
    clearToken: () => {
      clearCount += 1;
      token = 'fresh-token';
    }
  };
  const service = new ZohoCrmService(client, () => config, auth);
  const result = await service.executeRequest('post', 'https://www.zohoapis.com/crm/v8/coql', {
    data: { select_query: 'select id from Deals' },
    config: { headers: { Authorization: 'Zoho-oauthtoken expired-token' } },
    retrySameRequest: false
  });

  assert.deepEqual(authorizationHeaders, [
    'Zoho-oauthtoken expired-token',
    'Zoho-oauthtoken fresh-token'
  ]);
  assert.equal(clearCount, 1);
  assert.equal(service.executionStats.retries, 1);
  assert.deepEqual(result.data.data, [{ id: 'deal-1' }]);
});

test('returns a controlled Zoho auth error when refreshing a rejected CRM token fails', async () => {
  let accessTokenCalls = 0;
  const auth = {
    getAccessToken: async () => {
      accessTokenCalls += 1;
      const error = new Error('refresh token secret details');
      error.code = 'ZOHO_AUTHENTICATION_ERROR';
      throw error;
    },
    getApiDomain: () => 'https://www.zohoapis.com',
    clearToken: () => {}
  };
  const client = {
    post: async () => {
      const error = new Error('provider response included a sensitive-stale-token');
      error.response = { status: 401, data: { code: 'INVALID_TOKEN' } };
      throw error;
    }
  };
  const service = new ZohoCrmService(client, () => config, auth);

  await assert.rejects(
    service.executeRequest('post', 'https://www.zohoapis.com/crm/v8/coql', {
      data: { select_query: 'select id from Deals' },
      config: { headers: { Authorization: 'Zoho-oauthtoken sensitive-stale-token' } },
      retrySameRequest: false
    }),
    (error) => {
      assert.equal(error.code, 'ZOHO_AUTHENTICATION_ERROR');
      assert.equal(error.statusCode, 502);
      assert.doesNotMatch(error.message, /sensitive-stale-token|refresh token secret details/);
      assert.equal(JSON.stringify(error.details).includes('sensitive-stale-token'), false);
      return true;
    }
  );
  assert.equal(accessTokenCalls, 1);
});

test('returns a controlled Zoho unauthorized error after the one allowed refresh retry', async () => {
  let token = 'stale-token';
  const client = {
    post: async () => {
      const error = new Error('unauthorized');
      error.response = { status: 401, data: { code: 'INVALID_TOKEN', message: 'token rejected' } };
      throw error;
    }
  };
  const auth = {
    getAccessToken: async () => token,
    getApiDomain: () => 'https://www.zohoapis.com',
    clearToken: () => { token = 'fresh-token'; }
  };
  const service = new ZohoCrmService(client, () => config, auth);

  await assert.rejects(
    service.executeRequest('post', 'https://www.zohoapis.com/crm/v8/coql', {
      data: { select_query: 'select id from Deals' },
      config: { headers: { Authorization: 'Zoho-oauthtoken stale-token' } },
      retrySameRequest: false
    }),
    (error) => {
      assert.equal(error.code, 'ZOHO_OAUTH_UNAUTHORIZED');
      assert.equal(error.statusCode, 502);
      assert.equal(error.details.upstream_status, 401);
      assert.equal(error.details.upstream_code, 'INVALID_TOKEN');
      assert.doesNotMatch(error.message, /stale-token|fresh-token|token rejected/);
      return true;
    }
  );
});