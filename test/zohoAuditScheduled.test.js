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

function createHarness({ create, jobs = [], statusById = {}, downloadByUrl = {}, authService: providedAuthService }) {
  const calls = [];
  const sleeps = [];
  const authService = providedAuthService || {
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
        const scheduledJobs = typeof jobs === 'function' ? await jobs() : jobs;
        return { data: { audit_log_export: scheduledJobs } };
      }
      const jobId = decodeURIComponent(url.split('/').pop());
      if (statusById[jobId]) return statusById[jobId]({ call: calls.length });
      if (downloadByUrl[url]) return downloadByUrl[url]({ call: calls.length });
      if (url.startsWith('https://download')) {
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

test('selects the polled job by ID when status response contains multiple jobs', async () => {
  const requestedUrl = 'https://download-accl.zoho.com/v2/crm/example/auditlog/example/AuditLog.csv';
  const statusById = {
    'requested-job': async () => ({ data: { audit_log_export: [
      { id: 'other-job', status: 'failed', download_links: [] },
      { id: 'requested-job', status: 'finished', download_links: [requestedUrl] }
    ] } })
  };
  const { service, calls } = createHarness({ create: async () => createdJob('requested-job'), statusById });

  const result = await runAudit(service);

  assert.equal(result.records.length, 1);
  assert.equal(calls.some((call) => call.url === requestedUrl), true);
});

test('downloads a CSV from the documented Zoho download_links field', async () => {
  const downloadUrl = 'https://download-accl.zoho.com/v2/crm/example/auditlog/example/AuditLog.csv?sig=abc%2Fdef';
  const { service, calls } = createHarness({
    create: async () => createdJob('documented-csv-job'),
    statusById: {
      'documented-csv-job': async () => ({ data: { audit_log_export: [{
        id: 'documented-csv-job', status: 'finished', download_links: ['not a URL', downloadUrl]
      }] } })
    }
  });

  const result = await runAudit(service);

  assert.equal(result.records[0].module, 'Deals');
  assert.equal(calls.some((call) => call.url === downloadUrl), true);
});

test('logs status response structure without exposing nested download URLs', async () => {
  const signedUrl = 'https://download.zoho.in/audit.csv?sig=private-signature';
  const { service, calls } = createHarness({
    create: async () => createdJob('production-shaped-job'),
    statusById: {
      'production-shaped-job': async () => ({ data: { audit_log_export: [{
        id: 'production-shaped-job',
        status: 'Finished',
        downloadInfo: { downloadUrl: signedUrl },
        error: {
          code: 'EXPORT_PENDING',
          message: `See ${signedUrl} ${process.env.BACKEND_API_KEY}`
        }
      }] } })
    }
  });
  const previousNodeEnv = process.env.NODE_ENV;
  const previousBackendApiKey = process.env.BACKEND_API_KEY;
  const previousConsoleLog = console.log;
  const logged = [];
  process.env.NODE_ENV = 'production';
  process.env.BACKEND_API_KEY = 'diagnostic-test-api-key-not-real';
  console.log = (...args) => logged.push(args.join(' '));

  try {
    await assert.rejects(runAudit(service), (error) => {
      assert.equal(error.code, 'AUDIT_LOG_DOWNLOAD_UNAVAILABLE');
      return true;
    });
  } finally {
    console.log = previousConsoleLog;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousBackendApiKey === undefined) delete process.env.BACKEND_API_KEY;
    else process.env.BACKEND_API_KEY = previousBackendApiKey;
  }

  assert.equal(calls.some((call) => call.url.endsWith('/production-shaped-job')), true);
  const diagnostics = logged
    .filter((message) => message.startsWith('[ZOHO_AUDIT_EXPORT_STATUS_DEBUG] '))
    .map((message) => JSON.parse(message.slice('[ZOHO_AUDIT_EXPORT_STATUS_DEBUG] '.length)));
  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics[0].requestedJobId, 'production-shaped-job');
  assert.equal(diagnostics[0].auditLogExportExists, true);
  assert.equal(diagnostics[0].auditLogExportType, 'array');
  assert.equal(diagnostics[0].auditLogExportCount, 1);
  assert.equal(diagnostics[0].jobs[0].hasDownloadLinks, false);
  assert.ok(diagnostics[0].artifactLocations.some((location) => (
    location.path === 'audit_log_export.0.downloadInfo.downloadUrl'
    && location.type === 'string'
    && location.count === 1
  )));
  assert.equal(diagnostics[1].selectedJobId, 'production-shaped-job');
  assert.equal(diagnostics[1].selectedJobStatus, 'Finished');
  assert.equal(logged.join('\n').includes(signedUrl), false);
  assert.equal(logged.join('\n').includes('diagnostic-test-api-key-not-real'), false);
});

test('does not reuse or download a matching finished job whose expiry date has passed', async () => {
  let requestedCriteria;
  const { service, calls } = createHarness({
    create: async ({ data }) => {
      requestedCriteria = data.audit_log_export[0].criteria;
      throw zohoHttpError(400, 'ALREADY_SCHEDULED');
    },
    jobs: () => [{
      ...completedJob('expired-scheduled-job', requestedCriteria),
      expiry_date: '2000-01-01T00:00:00Z'
    }]
  });

  await assert.rejects(runAudit(service), (error) => {
    assert.equal(error.code, 'AUDIT_LOG_DOWNLOAD_LINK_EXPIRED');
    assert.equal(error.details.job_id, 'expired-scheduled-job');
    return true;
  });
  assert.equal(calls.some((call) => call.url?.endsWith('/expired-scheduled-job')), false);
  assert.equal(calls.some((call) => call.url === 'https://download.zoho.in/audit.csv'), false);
});

test('downloads and parses an AuditLog ZIP result', async () => {
  const downloadUrl = 'https://download-accl.zoho.com/v2/crm/example/auditlog/example/AuditLog.zip';
  const zipFixture = Buffer.from('UEsDBBQAAAAIAEl1RV06qAlVQgAAAEUAAAAMAAAAQXVkaXRMb2cuY3N2SyxNySxJTYkvycxN1UlMLsnMz9PJzU8pzUnlMjIwMtM1NNA1MAoxNLAyACFtA1MrYwOd0oKURKAmHef8vBKgnmIAUEsBAhQAFAAAAAgASXVFXTqoCVVCAAAARQAAAAwAAAAAAAAAAAAAAAAAAAAAAEF1ZGl0TG9nLmNzdlBLBQYAAAAAAQABADoAAABsAAAAAAA=', 'base64');
  const { service } = createHarness({
    create: async () => createdJob('zip-job'),
    statusById: {
      'zip-job': async () => ({ data: { audit_log_export: [{ id: 'zip-job', status: 'finished', download_links: [downloadUrl] }] } })
    },
    downloadByUrl: { [downloadUrl]: async () => ({ data: zipFixture }) }
  });

  const result = await runAudit(service);

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].module, 'Contacts');
});

test('rechecks finished status when the download link is initially missing', async () => {
  let polls = 0;
  const downloadUrl = 'https://download-accl.zoho.com/v2/crm/example/auditlog/example/AuditLog.csv';
  const { service, sleeps } = createHarness({
    create: async () => createdJob('late-link-job'),
    statusById: {
      'late-link-job': async () => {
        polls += 1;
        return { data: { audit_log_export: [polls === 1
          ? { id: 'late-link-job', status: 'finished' }
          : { id: 'late-link-job', status: 'FINISHED', download_links: [downloadUrl] }] } };
      }
    }
  });

  const result = await runAudit(service);

  assert.equal(result.records.length, 1);
  assert.equal(polls, 2);
  assert.deepEqual(sleeps, [1000]);
});

test('returns failed job ID, status, and safe Zoho error details', async () => {
  const { service } = createHarness({
    create: async () => createdJob('failed-job'),
    statusById: {
      'failed-job': async () => ({ data: { audit_log_export: [{
        id: 'failed-job', status: 'failed', error: { code: 'EXPORT_FAILED', message: 'Invalid audit criteria' }
      }] } })
    }
  });

  await assert.rejects(runAudit(service), (error) => {
    assert.equal(error.code, 'AUDIT_LOG_EXPORT_FAILED');
    assert.match(error.message, /failed-job.*failed/);
    assert.equal(error.details.job_id, 'failed-job');
    assert.equal(error.details.status, 'failed');
    assert.equal(error.details.upstream_code, 'EXPORT_FAILED');
    assert.equal(error.details.upstream_message, 'Invalid audit criteria');
    return true;
  });
});

test('returns a controlled error when the status response omits audit_log_export', async () => {
  let polls = 0;
  const { service } = createHarness({
    create: async () => createdJob('malformed-status-job'),
    statusById: {
      'malformed-status-job': async () => {
        polls += 1;
        return { data: { unexpected: [] } };
      }
    }
  });

  await assert.rejects(runAudit(service), (error) => {
    assert.equal(error.code, 'AUDIT_LOG_EXPORT_STATUS_UNAVAILABLE');
    assert.equal(error.statusCode, 502);
    assert.equal(error.details.job_id, 'malformed-status-job');
    assert.equal(error.details.audit_log_export_count, 0);
    return true;
  });
  assert.equal(polls, 20);
});

test('classifies an expired download URL and does not retry that URL', async () => {
  const downloadUrl = 'https://download-accl.zoho.com/v2/crm/example/auditlog/example/expired.csv';
  let downloadAttempts = 0;
  const { service } = createHarness({
    create: async () => createdJob('expired-link-job'),
    statusById: {
      'expired-link-job': async () => ({ data: { audit_log_export: [{
        id: 'expired-link-job', status: 'finished', download_links: [downloadUrl]
      }] } })
    },
    downloadByUrl: {
      [downloadUrl]: async () => {
        downloadAttempts += 1;
        throw zohoHttpError(410, 'DOWNLOAD_LINK_EXPIRED');
      }
    }
  });

  await assert.rejects(runAudit(service), (error) => {
    assert.equal(error.code, 'AUDIT_LOG_DOWNLOAD_LINK_EXPIRED');
    assert.match(error.message, /new export may be required/);
    assert.equal(error.details.job_id, 'expired-link-job');
    return true;
  });
  assert.equal(downloadAttempts, 1);
  assert.equal(service.expiredDownloadJobIds.has('expired-link-job'), true);
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

test('waits for an unrelated active job then creates the requested export once', async () => {
  let createCount = 0;
  let blockerPolls = 0;
  const statusById = {
    'requested-job': async () => ({ data: { audit_log_export: [{ status: 'Finished', download_links: ['https://download.zoho.in/audit.csv'] }] } })
  };
  const { service, calls } = createHarness({
    create: async () => {
      createCount += 1;
      if (createCount === 1) throw zohoHttpError(400, 'ALREADY_SCHEDULED');
      return createdJob('requested-job');
    },
    jobs: [{ id: 'other-job', status: 'Scheduled', criteria: { field: { api_name: 'action' }, comparator: 'equal', value: 'deleted' } }],
    statusById
  });
  const originalGet = service.httpClient.get;
  service.httpClient.get = async (url, options) => {
    if (url.endsWith('/other-job')) {
      calls.push({ method: 'GET', url });
      blockerPolls += 1;
      return { data: { audit_log_export: [{ status: blockerPolls === 1 ? 'Progress' : 'Finished' }] } };
    }
    return originalGet(url, options);
  };

  const result = await runAudit(service);

  assert.equal(result.records.length, 1);
  assert.equal(blockerPolls, 2);
  assert.equal(createCount, 2);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 2);
  assert.equal(calls.some((call) => call.url?.endsWith('/requested-job')), true);
});

test('bounds repeated ALREADY_SCHEDULED responses when the status list is empty', async () => {
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
  assert.equal(calls.filter((call) => call.method === 'POST').length, 2);
  assert.equal(calls.filter((call) => call.method === 'GET').length, 2);
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

test('matches criteria despite object key order and comparator spelling', async () => {
  let requestedCriteria;
  const { service, calls } = createHarness({
    create: async ({ data }) => {
      requestedCriteria = data.audit_log_export[0].criteria;
      throw zohoHttpError(400, 'ALREADY_SCHEDULED');
    },
    jobs: () => [{
      id: 'equivalent-job',
      status: 'fInIsHeD',
      criteria: makeSemanticallyEquivalentCriteria(requestedCriteria)
    }],
    statusById: {
      'equivalent-job': async () => ({ data: { audit_log_export: [{ status: 'FINISHED', download_links: ['https://download.zoho.in/audit.csv'] }] } })
    }
  });
  const originalGet = service.httpClient.get;
  service.httpClient.get = async (url, options) => {
    if (url.endsWith('/settings/audit_log_export')) {
      calls.push({ method: 'GET', url });
      return { data: { audit_log_export: [{
        id: 'equivalent-job',
        status: 'fInIsHeD',
        criteria: makeSemanticallyEquivalentCriteria(requestedCriteria)
      }] } };
    }
    return originalGet(url, options);
  };

  const result = await runAudit(service, { action: 'updated' });

  assert.equal(result.records.length, 1);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  assert.ok(calls.some((call) => call.url?.endsWith('/equivalent-job')));
});

test('matches in-criteria values independent of their order', async () => {
  let requestedCriteria;
  const { service, calls } = createHarness({
    create: async ({ data }) => {
      requestedCriteria = data.audit_log_export[0].criteria;
      replaceCriterionValue(requestedCriteria, 'module', [
        { api_name: 'Contacts', id: 'contacts-id' },
        { api_name: 'Deals', id: 'deals-id' }
      ]);
      throw zohoHttpError(400, 'ALREADY_SCHEDULED');
    },
    statusById: {
      'in-order-job': async () => ({ data: { audit_log_export: [{ status: 'Finished', download_links: ['https://download.zoho.in/audit.csv'] }] } })
    }
  });
  service.httpClient.get = async (url) => {
    calls.push({ method: 'GET', url });
    if (url.endsWith('/settings/audit_log_export')) {
      const criteria = structuredClone(requestedCriteria);
      replaceCriterionValue(criteria, 'module', criteriaValue(criteria, 'module').reverse());
      return { data: { audit_log_export: [{ id: 'in-order-job', status: 'Finished', criteria }] } };
    }
    if (url.endsWith('/in-order-job')) {
      return { data: { audit_log_export: [{ status: 'Finished', download_links: ['https://download.zoho.in/audit.csv'] }] } };
    }
    return { data: 'audited_time,action,module\n2026-10-02T10:00:00+05:30,updated,Deals' };
  };

  const result = await runAudit(service, { entity: 'Contacts', entity_id: 'contacts-id' });

  assert.equal(result.records.length, 1);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
});

test('does not reuse a finished export with a different module', async () => {
  await assertUnrelatedFinishedExportIsNotReused((criteria) => {
    replaceCriterionValue(criteria, 'module', [{ api_name: 'Leads', id: 'leads-id' }]);
  }, { entity: 'Contacts', entity_id: 'contacts-id' });
});

test('does not reuse a finished export with a different action', async () => {
  await assertUnrelatedFinishedExportIsNotReused((criteria) => {
    replaceCriterionValue(criteria, 'action', 'deleted');
  }, { action: 'updated' });
});

test('does not reuse a finished export with a different date range', async () => {
  await assertUnrelatedFinishedExportIsNotReused((criteria) => {
    replaceCriterionValue(criteria, 'audited_time', ['2026-10-03T00:00:00+05:30', '2026-10-03T23:59:59+05:30']);
  });
});

test('retries a transient network error while retrieving scheduled jobs', async () => {
  let listAttempts = 0;
  let requestedCriteria;
  const { service, calls, sleeps } = createHarness({
    create: async ({ data }) => {
      requestedCriteria = data.audit_log_export[0].criteria;
      throw zohoHttpError(400, 'ALREADY_SCHEDULED');
    },
    jobs: () => {
      listAttempts += 1;
      if (listAttempts === 1) {
        const error = new Error('temporary reset');
        error.code = 'ECONNRESET';
        throw error;
      }
      return [{ id: 'matching-after-network', status: 'Finished', criteria: requestedCriteria }];
    },
    statusById: {
      'matching-after-network': async () => ({ data: { audit_log_export: [{ status: 'Finished', download_links: ['https://download.zoho.in/audit.csv'] }] } })
    }
  });

  const result = await runAudit(service);

  assert.equal(result.records.length, 1);
  assert.equal(listAttempts, 2);
  assert.deepEqual(sleeps, [500]);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
});

test('refreshes Zoho authentication after a 401 while retrieving scheduled jobs', async () => {
  let listAttempts = 0;
  let tokenRequests = 0;
  let clearCount = 0;
  let requestedCriteria;
  const authService = {
    getAccessToken: async () => `test-token-${++tokenRequests}`,
    getApiDomain: () => 'https://www.zohoapis.in',
    clearToken: () => { clearCount += 1; }
  };
  const { service, calls } = createHarness({
    authService,
    create: async ({ data }) => {
      requestedCriteria = data.audit_log_export[0].criteria;
      throw zohoHttpError(400, 'ALREADY_SCHEDULED');
    },
    jobs: () => {
      listAttempts += 1;
      if (listAttempts === 1) throw zohoHttpError(401, 'INVALID_TOKEN');
      return [{ id: 'matching-after-refresh', status: 'Finished', criteria: requestedCriteria }];
    },
    statusById: {
      'matching-after-refresh': async () => ({ data: { audit_log_export: [{ status: 'Finished', download_links: ['https://download.zoho.in/audit.csv'] }] } })
    }
  });

  const result = await runAudit(service);

  assert.equal(result.records.length, 1);
  assert.equal(listAttempts, 2);
  assert.equal(clearCount, 1);
  assert.ok(tokenRequests >= 4);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
});

test('returns a blocking-job timeout with safe job details', async () => {
  let requestedCriteria;
  let blockerPolls = 0;
  const { service, calls } = createHarness({
    create: async ({ data }) => {
      requestedCriteria = data.audit_log_export[0].criteria;
      throw zohoHttpError(400, 'ALREADY_SCHEDULED');
    },
    jobs: [{ id: 'blocking-job', status: 'Progress', criteria: { field: { api_name: 'action' }, comparator: 'equal', value: 'deleted' } }]
  });
  service.httpClient.get = async (url) => {
    calls.push({ method: 'GET', url });
    if (url.endsWith('/settings/audit_log_export')) {
      return { data: { audit_log_export: [{
        id: 'blocking-job', status: 'Progress',
        criteria: { field: { api_name: 'action' }, comparator: 'equal', value: 'deleted' }
      }] } };
    }
    blockerPolls += 1;
    return { data: { audit_log_export: [{ status: 'Progress' }] } };
  };

  await assert.rejects(runAudit(service), (error) => {
    assert.equal(error.code, 'AUDIT_LOG_EXPORT_WAIT_TIMEOUT');
    assert.equal(error.statusCode, 504);
    assert.equal(error.details.blocking_job_id, 'blocking-job');
    assert.equal(error.details.status, 'progress');
    return true;
  });
  assert.equal(blockerPolls, 20);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  assert.ok(requestedCriteria);
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

function reorderObjectKeysDeep(value) {
  if (Array.isArray(value)) return value.map(reorderObjectKeysDeep);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reorderObjectKeysDeep(value[key])]));
}

function replaceComparator(criteria, fieldApiName, comparator) {
  if (criteria.field?.api_name === fieldApiName) {
    criteria.comparator = comparator;
    return criteria;
  }
  if (Array.isArray(criteria.group)) {
    for (const child of criteria.group) {
      const match = replaceComparator(child, fieldApiName, comparator);
      if (match) return criteria;
    }
  }
  return criteria;
}

function mutateCriteria(criteria, fieldApiName, mutation) {
  if (criteria.field?.api_name === fieldApiName) {
    mutation(criteria);
    return criteria;
  }
  for (const child of criteria.group || []) mutateCriteria(child, fieldApiName, mutation);
  return criteria;
}

function makeSemanticallyEquivalentCriteria(criteria) {
  const equivalent = reorderObjectKeysDeep(structuredClone(criteria));
  mutateCriteria(equivalent, 'action', (node) => { node.comparator = 'equals'; });
  mutateCriteria(equivalent, 'audited_time', (node) => {
    node.value = node.value.map((boundary) => new Date(boundary).toISOString());
  });
  return equivalent;
}

function criteriaValue(criteria, fieldApiName) {
  if (criteria.field?.api_name === fieldApiName) return criteria.value;
  for (const child of criteria.group || []) {
    const value = criteriaValue(child, fieldApiName);
    if (value !== undefined) return value;
  }
  return undefined;
}

async function assertUnrelatedFinishedExportIsNotReused(changeCriteria, requestFilters = {}) {
  let createCount = 0;
  let requestedCriteria;
  let unrelatedCriteria;
  const { service, calls } = createHarness({
    create: async ({ data }) => {
      createCount += 1;
      if (createCount === 1) {
        requestedCriteria = data.audit_log_export[0].criteria;
        unrelatedCriteria = structuredClone(requestedCriteria);
        changeCriteria(unrelatedCriteria);
        throw zohoHttpError(400, 'ALREADY_SCHEDULED');
      }
      return createdJob('new-requested-job');
    },
    jobs: () => [{ id: 'unrelated-finished-job', status: 'Finished', criteria: unrelatedCriteria }],
    statusById: {
      'new-requested-job': async () => ({ data: { audit_log_export: [{ status: 'Finished', download_links: ['https://download.zoho.in/audit.csv'] }] } })
    }
  });

  const result = await runAudit(service, requestFilters);

  assert.equal(result.records.length, 1);
  assert.equal(createCount, 2);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 2);
  assert.equal(calls.some((call) => call.url?.endsWith('/unrelated-finished-job')), false);
  assert.equal(calls.some((call) => call.url?.endsWith('/new-requested-job')), true);
}
