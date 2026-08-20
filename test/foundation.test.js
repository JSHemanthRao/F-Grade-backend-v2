const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const createApp = require('../src/app').createApp;
const { CRM_MODULES } = require('../src/constants/crmModules');
const { validateCrmQuery } = require('../src/validators/crmQuery.validator');

function requestJson(app, path, method, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const request = http.request({
        port: server.address().port,
        path,
        method,
        headers: body ? { 'content-type': 'application/json' } : {}
      }, (response) => {
        let content = '';
        response.on('data', (chunk) => { content += chunk; });
        response.on('end', () => {
          server.close();
          resolve({ status: response.statusCode, body: JSON.parse(content) });
        });
      });
      request.on('error', (error) => { server.close(); reject(error); });
      if (body) request.write(JSON.stringify(body));
      request.end();
    });
  });
}

test('GET /health returns a successful health response', async () => {
  const response = await requestJson(createApp(), '/health', 'GET');
  assert.deepEqual(response, { status: 200, body: { success: true, status: 'ok', message: 'F-Grade backend is running' } });
});

test('POST /api/crm/query returns the CRM service response', async () => {
  const request = { module: 'Deals', fields: ['Deal_Name'], limit: 20 };
  const app = createApp({ crmService: { query: async (input) => ({ module: input.module, count: 1, data: [], pagination: { limit: input.limit, offset: input.offset, more_records: false } }) } });
  const response = await requestJson(app, '/api/crm/query', 'POST', request);
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.status, 'ok');
  assert.equal(response.body.module, 'Deals');
  assert.equal(response.body.count, 1);
});

test('module-specific CRM routes remain unavailable', async () => {
  const response = await requestJson(createApp(), '/api/crm/deals', 'GET');
  assert.equal(response.status, 404);
});

test('rejects invalid module and returns a field-specific error', async () => {
  const response = await requestJson(createApp(), '/api/crm/query', 'POST', { module: 'Unknown', fields: ['id'] });
  assert.equal(response.status, 400);
  assert.equal(response.body.success, false);
  assert.equal(response.body.status, 'error');
  assert.equal(response.body.error.code, 'INVALID_CRM_REQUEST');
  assert.equal(response.body.error.details.errors[0].path, 'module');
});

test('rejects invalid filter values, sorting, limit, and offset', async () => {
  const response = await requestJson(createApp(), '/api/crm/query', 'POST', {
    module: 'Deals',
    fields: ['Deal_Name'],
    filters: [{ field: 'Stage', operator: 'equals' }],
    sort: { field: 'Deal_Name', order: 'sideways' },
    limit: 0,
    offset: -1
  });
  const errors = response.body.error.details.errors;
  assert.equal(response.status, 400);
  assert.ok(errors.some((error) => error.path === 'filters[0].value'));
  assert.ok(errors.some((error) => error.path === 'sort.order'));
  assert.ok(errors.some((error) => error.path === 'limit'));
  assert.ok(errors.some((error) => error.path === 'offset'));
});

test('accepts valid API fields for Deals, Leads, Contacts, and Accounts', () => {
  for (const module of ['Deals', 'Leads', 'Contacts', 'Accounts']) {
    const fields = CRM_MODULES[module].slice(0, 3);
    assert.deepEqual(validateCrmQuery({ module, fields }).fields, fields);
  }
});

test('rejects display labels instead of Zoho API field names', () => {
  for (const [module, field] of [['Deals', 'Account Name'], ['Leads', 'Closing Date'], ['Contacts', 'Account Name'], ['Accounts', 'Closing Date']]) {
    assert.throws(() => validateCrmQuery({ module, fields: [field] }), (error) => {
      assert.equal(error.code, 'INVALID_CRM_REQUEST');
      assert.match(error.details.errors[0].message, new RegExp(`Field '${field}'.*valid Zoho CRM API field name`));
      return true;
    });
  }
});

test('accepts the known-good closed won Deals request', () => {
  const request = validateCrmQuery({
    module: 'Deals',
    fields: ['Deal_Name', 'Amount', 'Stage'],
    filters: [
      { field: 'Stage', operator: 'equals', value: 'Closed Won' },
      { field: 'Amount', operator: 'greater_than', value: 50000 }
    ],
    sort: { field: 'Amount', order: 'desc' },
    limit: 20,
    offset: 0
  });
  assert.deepEqual(request.fields, ['Deal_Name', 'Amount', 'Stage']);
  assert.equal(request.filters.length, 2);
  assert.deepEqual(request.sort, { field: 'Amount', order: 'desc' });
});
