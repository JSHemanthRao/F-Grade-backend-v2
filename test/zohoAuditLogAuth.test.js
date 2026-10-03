const test = require('node:test');
const assert = require('node:assert/strict');
const { ZohoAuditLogService } = require('../src/services/zohoAuditLog.service');
const { ZohoAuthService } = require('../src/services/zohoAuth.service');
const { CrmService } = require('../src/services/crm.service');

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