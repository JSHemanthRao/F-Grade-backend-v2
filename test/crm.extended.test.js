const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const createApp = require('../src/app').createApp;

function request(app, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const payload = JSON.stringify(body);
      const req = http.request({ hostname: '127.0.0.1', port, path: '/api/crm/assistant', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers } }, (res) => {
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

test('uses the connector conversation header when the body omits conversation_id', async () => {
  const calls = [];
  const app = createApp({ crmService: makeMockService((input) => {
    calls.push(input);
    const offset = input.offset || 0;
    return {
      module: input.module,
      request_type: input.request_type,
      data: Array.from({ length: 20 }, (_, index) => ({ id: `deal-${offset + index + 1}` })),
      pagination: { limit: input.limit, offset, returned: 20, more_records: true }
    };
  }) });

  const headers = { 'x-ms-conversation-id': 'copilot-conversation-1' };
  const first = await request(app, { question: 'Show me the first 20 deals.' }, headers);
  const second = await request(app, { question: 'give me next 20 records' }, headers);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body.conversation_id, 'copilot-conversation-1');
  assert.equal(second.body.conversation_id, 'copilot-conversation-1');
  assert.deepEqual(calls.map((call) => call.offset), [0, 20]);
});

test('propagates conversation_id and continuation_token across connector pagination calls', async () => {
  const calls = [];
  const app = createApp({ crmService: makeMockService((input) => {
    calls.push({ offset: input.offset || 0, limit: input.limit || 20 });
    const offset = input.offset || 0;
    return {
      module: 'Deals',
      request_type: 'records',
      data: Array.from({ length: 20 }, (_, index) => ({ id: `deal-${offset + index + 1}` })),
      pagination: { limit: input.limit || 20, offset, returned: 20, more_records: true }
    };
  }) });

  const first = await request(app, { question: 'give me deals created this month' });
  const conversationId = first.body.conversation_id;
  const token1 = first.body.continuation_token;
  const second = await request(app, { question: 'Yes please fetch the next set of deals.', conversation_id: conversationId, continuation_token: token1 });
  const token2 = second.body.continuation_token;
  const third = await request(app, { question: 'next 20', conversation_id: conversationId, continuation_token: token2 });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(third.status, 200);
  assert.ok(conversationId);
  assert.ok(token1);
  assert.ok(token2);
  assert.notEqual(token1, token2);
  assert.deepEqual(calls.map((call) => call.offset), [0, 20, 40]);
  assert.deepEqual([first.body.pagination.offset, second.body.pagination.offset, third.body.pagination.offset], [0, 20, 40]);
  assert.equal(second.body.diagnostics.continuation_token_present, true);
  assert.equal(second.body.diagnostics.previous_state_found, true);
  assert.equal(second.body.diagnostics.previous_offset, 0);
  assert.equal(second.body.diagnostics.new_offset, 20);
});

test('supports the Copilot CRM pagination acceptance flow with internal token rotation', async () => {
  const calls = [];
  const sentState = [];
  const app = createApp({ crmService: makeMockService((input) => {
    calls.push({ offset: input.offset || 0, limit: input.limit || 20 });
    const offset = input.offset || 0;
    return {
      module: 'Deals',
      request_type: 'records',
      data: Array.from({ length: 20 }, (_, index) => ({ id: `deal-${offset + index + 1}` })),
      pagination: { limit: input.limit || 20, offset, returned: 20, more_records: true }
    };
  }) });

  let crmContinuationToken = '';
  let crmConversationId = '';

  const first = await request(app, { question: 'Give me deals created this month' });
  crmContinuationToken = first.body.continuation_token;
  crmConversationId = first.body.conversation_id;

  for (let index = 0; index < 4; index += 1) {
    sentState.push({ continuation_token: crmContinuationToken, conversation_id: crmConversationId });
    const next = await request(app, {
      question: 'next 20',
      continuation_token: crmContinuationToken,
      conversation_id: crmConversationId
    });
    crmContinuationToken = next.body.continuation_token;
    crmConversationId = next.body.conversation_id;
  }

  assert.deepEqual(calls.map((call) => call.offset), [0, 20, 40, 60, 80]);
  assert.deepEqual(calls.map((call) => call.limit), [20, 20, 20, 20, 20]);
  assert.equal(new Set(sentState.map((state) => state.conversation_id)).size, 1);
  assert.equal(new Set(sentState.map((state) => state.continuation_token)).size, 4);
  assert.ok(sentState.every((state) => state.continuation_token && state.conversation_id));
});

test('uses conversation_id as pagination fallback when continuation_token is absent', async () => {
  const offsets = [];
  const app = createApp({ crmService: makeMockService((input) => {
    const offset = input.offset || 0;
    offsets.push(offset);
    return { module: 'Deals', request_type: 'records', data: [{ id: `deal-${offset}` }], pagination: { limit: 20, offset, returned: 1, more_records: true } };
  }) });

  const first = await request(app, { conversation_id: 'fallback-conversation', question: 'show me deals' });
  const second = await request(app, { conversation_id: 'fallback-conversation', question: 'next 20' });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(offsets, [0, 1]);
  assert.equal(second.body.diagnostics.continuation_token_present, false);
  assert.equal(second.body.diagnostics.conversation_id_present, true);
});

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
