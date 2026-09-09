const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const createApp = require('../src/app').createApp;

function request(app, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const payload = JSON.stringify(body);
      const req = http.request({ hostname: '127.0.0.1', port, path: '/api/crm/assistant', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
        let response = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { response += chunk; });
        res.on('end', () => {
          server.close(() => resolve({ status: res.statusCode, body: JSON.parse(response) }));
        });
      });
      req.on('error', (error) => server.close(() => reject(error)));
      req.end(payload);
    });
    server.on('error', reject);
  });
}

// Create a generic mock crmService that echoes expected shapes
function makeMockService(handler) {
  return {
    query: async (input, _ctx, diagnostics) => handler(input, diagnostics)
  };
}

test('today queries for core modules and basic aggregations', async (t) => {
  const scenarios = [
    { question: "give me today's leads", module: 'Leads' },
    { question: "show today's contacts", module: 'Contacts' },
    { question: "show today's accounts", module: 'Accounts' },
    { question: "show today's deals", module: 'Deals' },
    { question: "show today's products", module: 'Products' },
    { question: "show today's calls", module: 'Calls' },
    { question: "show today's tasks", module: 'Tasks' },
    { question: "show today's meetings", module: 'Meetings' },
    { question: "show today's quotes", module: 'Quotes' }
  ];

  const app = createApp({ crmService: makeMockService((input) => {
    // Return a records response with count 0 for simplicity
    return { module: input.module, module_api_name: input.module === 'Meetings' ? 'Events' : input.module, request_type: input.request_type || 'records', fields: input.fields || [], filters: input.filters || [], data: [], count: 0, pagination: { limit: input.limit || 20, offset: input.offset || 0, returned: 0, more_records: false } };
  }) });

  for (const s of scenarios) {
    const res = await request(app, { question: s.question });
    assert.equal(res.status, 200, `expected 200 for ${s.question}`);
    assert.equal(res.body.module, s.module);
    // Meetings must map to Events in module_api_name
    if (s.module === 'Meetings') assert.equal(res.body.diagnostics.module_api_name, 'Events');
  }
});

test('calls vs meetings comparison', async () => {
  const app = createApp({ crmService: makeMockService((input) => {
    if (input.request_type === 'comparison' && input.comparison && input.comparison.multi_module) {
      return { request_type: 'comparison', module: input.module, comparisons: input.comparison.multi_module.map((m, idx) => ({ module: m.module, module_api_name: m.module === 'Meetings' ? 'Events' : m.module, value: idx === 0 ? 10 : 5 })), comparison: { difference: 5, percentage_change: 100 } };
    }
    return { module: input.module, module_api_name: input.module, request_type: input.request_type || 'records', data: [], count: 0 };
  }) });

  const res = await request(app, { question: 'compare calls and meetings this week' });
  assert.equal(res.status, 200);
  assert.equal(res.body.request_type, 'comparison');
  assert.ok(res.body.comparisons && res.body.comparisons.length >= 2);
  const callsEntry = res.body.comparisons.find((c) => c.module === 'Calls');
  const meetingsEntry = res.body.comparisons.find((c) => c.module === 'Meetings' || c.module_api_name === 'Events');
  assert.ok(callsEntry, 'calls present');
  assert.ok(meetingsEntry, 'meetings present');
});

test('count leads and sum deal amount aggregate', async () => {
  const app = createApp({ crmService: makeMockService((input) => {
    if (input.request_type === 'count') return { module: input.module, request_type: 'count', count: 42 };
    if (input.request_type === 'aggregate' && input.aggregate && input.aggregate.operation === 'sum') return { module: input.module, request_type: 'aggregate', data: [{ value: 123456 }], summary: { operation: 'sum', field: input.aggregate.field } };
    return { module: input.module, request_type: 'records', data: [], count: 0 };
  }) });

  const countRes = await request(app, { question: 'how many leads were created today?' });
  assert.equal(countRes.status, 200);
  assert.equal(countRes.body.request_type, 'count');
  assert.equal(countRes.body.count, 42);

  const sumRes = await request(app, { question: 'what is the total deal amount this month?' });
  assert.equal(sumRes.status, 200);
  assert.equal(sumRes.body.request_type, 'aggregate');
  assert.ok(Array.isArray(sumRes.body.data));
  assert.equal(sumRes.body.data[0].value, 123456);
});
