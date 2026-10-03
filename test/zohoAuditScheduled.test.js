const test = require('node:test');
const assert = require('node:assert/strict');
const { ZohoAuditLogService } = require('../src/services/zohoAuditLog.service');

const config = {
  accountsUrl: 'https://accounts.zoho.in',
  apiBaseUrl: 'https://www.zohoapis.in/crm/v8',
  timeoutMs: 1000
};
const dateRange = { start: '2026-10-02', end: '2026-10-03' };

function zohoHttpError(status, code, message = code) {
  const error = new Error(message);
  error.response = { status, data: { code, message } };
  return error;
}

function createHarness({ create, jobs = [], statusById = {} }) {
  const calls = [];
  const sleeps = [];
  const authService = {
    getAccessToken: async () => 'test-access-token',
    getApiDomain: () => 'https://www.zohoapis.in',
    clearToken: () => {}
  };
  const client = {
    post: async (url, data) => {
      calls.push({ method: 'POST', url, data });
      return create({ url, data, call: calls.length });
    },
    get: async (url) => {
      calls.push({ method: 'GET', url });
      if (url.endsWith('/settings/audit_log_export')) {
        if (typeof jobs === 'function') return jobs();
        return { data: { audit_log_export: jobs } };
      }
      const jobId = decodeURIComponent(url.split('/').pop());
      if (statusById[jobId]) return statusById[jobId]({ call: calls.length });
      if (url === 'https://download.zoho.in/audit.csv') {
        return { data: 'audited_time,action,module\n2026-10-02T10:00:00+05:30,updated,Deals' };
      }
      throw new Error(`Unexpected URL ${url}`);
    }
  };
  const service = new ZohoAuditLogService(
    client,
    () => config,
    authService,
    async (milliseconds) => sleeps.push(milliseconds),
  );
  return { service, calls, sleeps };
}

function createdJob(jobId) {
  return {
    data: {
      audit_log_export: [{ details: { id: jobId } }]
    }
  };
}

function completedJob(jobId, criteria) {
  return {
    id: jobId,
    status: 'Finished',
    criteria,
    download_links: ['https://download.zoho.in/audit.csv']
  };
}

async function runAudit(service, filters = {}) {
  return service.getAuditLogs({ date_range: dateRange, ...filters });
}

function createResponseData(calls) {
  return calls.find((call) => call.method === 'POST').data.audit_log_export[0].criteria;
}

test('creates a new export and follows the normal poll/download flow', async () => {
  const statusById = {
    'new-job': async () => ({ data: { audit_log_export: [{ status: 'Finished', download_links: ['https://download.zoho.in/audit.csv'] }] } })
  };
  const { service, calls } = createHarness({ create: async () => createdJob('new-job'), statusById });

  const result = await runAudit(service);

  assert.equal(result.records.length, 1);
  assert.deepEqual(calls.map((call) => call.method), ['POST', 'GET', 'GET']);
  assert.match(calls[1].url, /\/new-job$/);
  assert.equal(calls[2].url, 'https://download.zoho.in/audit.csv');
});

test('reuses an exact-criteria job after ALREADY_SCHEDULED', async () => {
  let requestedCriteria;
  const statusById = {
    'matching-job': async () => ({ data: { audit_log_export: [{ status: 'Finished', download_links: ['https://download.zoho.in/audit.csv'] }] } })
  };
  const { service, calls } = createHarness({
    create: async ({ data }) => {
      requestedCriteria = data.audit_log_export[0].criteria;
      nearMatchCriteria = JSON.parse(JSON.stringify(requestedCriteria));
      replaceCriterionValue(nearMatchCriteria, 'action', 'deleted');
      throw zohoHttpError(400, 'ALREADY_SCHEDULED');
    },
    jobs: [],
    statusById
  });
  const originalGet = service.httpClient.get;
  service.httpClient.get = async (url, options) => {
    if (url.endsWith('/settings/audit_log_export')) {
      calls.push({ method: 'GET', url });
      return { data: { audit_log_export: [completedJob('matching-job', requestedCriteria)] } };
    }
    return originalGet(url, options);
  };

  const result = await runAudit(service);

  assert.equal(result.records.length, 1);
  assert.deepEqual(calls.map((call) => call.method), ['POST', 'GET', 'GET', 'GET']);
  assert.match(calls[2].url, /\/matching-job$/);
});

test('polls a matching scheduled job while it is still processing', async () => {
  let requestedCriteria;
  let pollCount = 0;
  const statusById = {
    'processing-job': async () => {
      pollCount += 1;
      return {
        data: {
          audit_log_export: [pollCount === 1
            ? { status: 'Progress' }
            : { status: 'Finished', download_links: ['https://download.zoho.in/audit.csv'] }]
        }
      };
    }
  };
  const { service, calls, sleeps } = createHarness({
    create: async ({ data }) => {
      requestedCriteria = data.audit_log_export[0].criteria;
      throw zohoHttpError(400, 'ALREADY_SCHEDULED');
    },
    statusById
  });
  service.httpClient.get = async (url) => {
    calls.push({ method: 'GET', url });
    if (url.endsWith('/settings/audit_log_export')) {
      return { data: { audit_log_export: [{ id: 'processing-job', status: 'Scheduled', criteria: requestedCriteria }] } };
    }
    if (url.endsWith('/processing-job')) return statusById['processing-job']();
    return { data: 'audited_time,action,module\n2026-10-02T10:00:00+05:30,updated,Deals' };
  };

  const result = await runAudit(service);

  assert.equal(result.records.length, 1);
  assert.equal(pollCount, 2);
  assert.deepEqual(sleeps, [1000]);
});

test('returns a clear conflict when no existing job matches the criteria', async () => {
  const { service, calls } = createHarness({
    create: async () => { throw zohoHttpError(400, 'ALREADY_SCHEDULED'); },
    jobs: [{
      id: 'other-job',
      status: 'Scheduled',
      criteria: { field: { api_name: 'action' }, comparator: 'equal', value: 'deleted' }
    }]
  });

  await assert.rejects(runAudit(service), (error) => {
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, 'AUDIT_LOG_SCHEDULED_EXPORT_UNMATCHED');
    assert.match(error.message, /no existing job with matching criteria could be identified/);
    assert.equal(error.details.upstream_status, 400);
    assert.equal(error.details.upstream_code, 'ALREADY_SCHEDULED');
    return true;
  });
  assert.deepEqual(calls.map((call) => call.method), ['POST', 'GET']);
});

test('treats Zoho NO_CONTENT from the status-all endpoint as no matching job', async () => {
  const { service, calls } = createHarness({
    create: async () => { throw zohoHttpError(400, 'ALREADY_SCHEDULED'); },
    jobs: async () => { throw zohoHttpError(400, 'NO_CONTENT', 'No audit log has been scheduled'); }
  });

  await assert.rejects(runAudit(service), (error) => {
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, 'AUDIT_LOG_SCHEDULED_EXPORT_UNMATCHED');
    assert.equal(error.details.upstream_code, 'ALREADY_SCHEDULED');
    return true;
  });
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(calls.filter((call) => call.method === 'GET').length, 1);
});

test('selects a matching job rather than the first job returned', async () => {
  let requestedCriteria;
  let nearMatchCriteria;
  const statusById = {
    'matching-finished': async () => ({ data: { audit_log_export: [{ status: 'Finished', download_links: ['https://download.zoho.in/audit.csv'] }] } })
  };
  const { service, calls } = createHarness({
    create: async ({ data }) => {
      requestedCriteria = data.audit_log_export[0].criteria;
      throw zohoHttpError(400, 'ALREADY_SCHEDULED');
    },
    statusById
  });
  service.httpClient.get = async (url) => {
    calls.push({ method: 'GET', url });
    if (url.endsWith('/settings/audit_log_export')) {
      return { data: { audit_log_export: [
        { id: 'wrong-first', status: 'Scheduled', criteria: { comparator: 'equal', value: 'unrelated' } },
        { id: 'near-match', status: 'Finished', criteria: nearMatchCriteria },
        { id: 'matching-scheduled', status: 'Scheduled', criteria: requestedCriteria },
        { id: 'matching-finished', status: 'Finished', criteria: reverseCriteriaGroups(requestedCriteria) }
      ] } };
    }
    if (url.endsWith('/matching-finished')) return statusById['matching-finished']();
    return { data: 'audited_time,action,module\n2026-10-02T10:00:00+05:30,updated,Deals' };
  };

  const requestPromise = runAudit(service, {
    entity: 'Deals',
    entity_id: 'deals-module-id',
    action: 'updated',
    user: { id: 'user-7', name: 'Ravi' }
  });
  const result = await requestPromise;

  assert.equal(result.records.length, 1);
  assert.match(calls[2].url, /\/matching-finished$/);
  assert.equal(calls.some((call) => call.url?.endsWith('/wrong-first')), false);
  assert.equal(calls.some((call) => call.url?.endsWith('/near-match')), false);
});

test('does not poll indefinitely when a matching job remains in progress', async () => {
  let requestedCriteria;
  let pollCount = 0;
  const { service, calls } = createHarness({
    create: async ({ data }) => {
      requestedCriteria = data.audit_log_export[0].criteria;
      throw zohoHttpError(400, 'ALREADY_SCHEDULED');
    }
  });
  service.httpClient.get = async (url) => {
    calls.push({ method: 'GET', url });
    if (url.endsWith('/settings/audit_log_export')) {
      return { data: { audit_log_export: [{ id: 'long-running', status: 'Progress', criteria: requestedCriteria }] } };
    }
    if (url.endsWith('/long-running')) {
      pollCount += 1;
      return { data: { audit_log_export: [{ status: 'Progress' }] } };
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  await assert.rejects(runAudit(service), (error) => {
    assert.equal(error.code, 'AUDIT_LOG_EXPORT_TIMEOUT');
    assert.equal(error.statusCode, 504);
    return true;
  });
  assert.equal(pollCount, 20);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
});

test('does not repeat export scheduling when Zoho returns an unrelated HTTP 400', async () => {
  const { service, calls } = createHarness({
    create: async () => { throw zohoHttpError(400, 'INVALID_DATA'); }
  });

  await assert.rejects(runAudit(service), (error) => {
    assert.equal(error.statusCode, 400);
    assert.equal(error.details.upstream_code, 'INVALID_DATA');
    return true;
  });
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(calls.filter((call) => call.method === 'GET').length, 0);
});

test('coalesces concurrent identical requests into one export job', async () => {
  let createCount = 0;
  let releaseCreate;
  const createBarrier = new Promise((resolve) => { releaseCreate = resolve; });
  const statusById = {
    'shared-job': async () => ({ data: { audit_log_export: [{ status: 'Finished', download_links: ['https://download.zoho.in/audit.csv'] }] } })
  };
  const { service, calls } = createHarness({
    create: async () => {
      createCount += 1;
      await createBarrier;
      return createdJob('shared-job');
    },
    statusById
  });

  const first = runAudit(service);
  const second = runAudit(service);
  releaseCreate();
  const results = await Promise.all([first, second]);

  assert.equal(createCount, 1);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  assert.deepEqual(results.map((result) => result.records.length), [1, 1]);
});

function replaceCriterionValue(criteria, fieldApiName, value) {
  if (criteria.field?.api_name === fieldApiName) {
    criteria.value = value;
    return true;
  }
  return Array.isArray(criteria.group)
    && criteria.group.some((item) => replaceCriterionValue(item, fieldApiName, value));
}

function reverseCriteriaGroups(criteria) {
  if (Array.isArray(criteria)) return criteria.map(reverseCriteriaGroups);
  if (!criteria || typeof criteria !== 'object') return criteria;
  return Object.fromEntries(Object.entries(criteria).map(([key, value]) => [
    key,
    key === 'group' && Array.isArray(value)
      ? value.map(reverseCriteriaGroups).reverse()
      : reverseCriteriaGroups(value)
  ]));
}
