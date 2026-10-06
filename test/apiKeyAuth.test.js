const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.BACKEND_API_KEY = 'test-backend-key';
const { createApp } = require('../src/app');
const { createBotRateLimiters, createRateLimitStore } = require('../src/middleware/botProtection');

function startServer(t, app) {
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return new Promise((resolve) => server.once('listening', () => resolve(server)));
}

async function send(server, path, { body = {}, headers = {}, method = 'POST' } = {}) {
  const payload = JSON.stringify(body);
  return fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', connection: 'close', ...headers },
    body: method === 'GET' ? undefined : payload
  });
}

test('bot-facing CRM and Audit Log requests succeed without API key or Authorization', async (t) => {
  const app = createApp({
    crmService: {
      query: async (input) => ({ module: input.module || 'Deals', request_type: 'records', data: [], count: 0 }),
      queryAuditLog: async () => ({ count: 0, returned: 0, records: [], data: [], pagination: { limit: 20, offset: 0, returned: 0, more_records: false } })
    }
  });
  const server = await startServer(t, app);
  const crm = await send(server, '/api/crm/assistant', { body: { question: 'Show me deals' } });
  const audit = await send(server, '/api/crm/audit-log', { body: { request: { question: 'Show audit logs yesterday' } } });

  assert.equal(crm.status, 200);
  assert.equal(audit.status, 200);
  assert.equal((await crm.json()).success, true);
  assert.equal((await audit.json()).success, true);
});

test('bot-facing endpoints ignore backend API-key and Authorization credentials', async (t) => {
  const app = createApp({
    crmService: {
      query: async (input) => ({ module: input.module || 'Deals', request_type: 'records', data: [], count: 0 }),
      queryAuditLog: async () => ({ count: 0, returned: 0, records: [], data: [], pagination: { limit: 20, offset: 0, returned: 0, more_records: false } })
    }
  });
  const server = await startServer(t, app);
  const response = await send(server, '/api/crm/assistant', {
    body: { question: 'Show me deals' },
    headers: { 'x-api-key': 'not-required', authorization: 'Bearer not-required' }
  });
  assert.equal(response.status, 200);
});

test('administrative and non-connector API routes remain protected', async (t) => {
  const app = createApp({ crmService: { query: async () => ({ data: [] }) } });
  const server = await startServer(t, app);
  const metadata = await send(server, '/api/crm/metadata', { method: 'GET' });
  const skills = await send(server, '/api/skills', { method: 'GET' });

  assert.equal(metadata.status, 401);
  assert.equal(skills.status, 401);
  assert.equal((await metadata.json()).error.code, 'AUTHENTICATION_REQUIRED');
});

test('rate limits anonymous CRM calls with a safe 429 response', async (t) => {
  const store = new Map();
  const rateLimiters = createBotRateLimiters({
    crmLimit: 1,
    aggregateLimit: 1,
    auditLimit: 1,
    windowMs: 60000,
    store: {
      async increment(key, windowMs) {
        const current = store.get(key) || { count: 0, ttlMs: windowMs };
        current.count += 1;
        store.set(key, current);
        return current;
      }
    }
  });
  const app = createApp({
    rateLimiters,
    crmService: { query: async (input) => ({ module: input.module || 'Deals', request_type: 'records', data: [], count: 0 }) }
  });
  const server = await startServer(t, app);
  const first = await send(server, '/api/crm/assistant', { body: { question: 'Show me deals' } });
  const limited = await send(server, '/api/crm/assistant', { body: { question: 'Show me deals' } });
  const aggregate = await send(server, '/api/crm/assistant', { body: { question: 'What is total revenue?' } });
  const aggregateLimited = await send(server, '/api/crm/assistant', { body: { question: 'What is total revenue?' } });
  const error = await limited.json();

  assert.equal(first.status, 200);
  assert.equal(limited.status, 429);
  assert.equal(aggregate.status, 200);
  assert.equal(aggregateLimited.status, 429);
  assert.equal(error.error.code, 'RATE_LIMIT_EXCEEDED');
  assert.doesNotMatch(JSON.stringify(error), /storage|bucket|127\.0\.0\.1/i);
});

test('rejects malformed JSON and oversized JSON with controlled 400 and 413 responses', async (t) => {
  const app = createApp({
    crmService: { query: async () => ({ module: 'Deals', request_type: 'records', data: [], count: 0 }) }
  });
  const server = await startServer(t, app);
  const invalidJson = await fetch(`http://127.0.0.1:${server.address().port}/api/crm/assistant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: '{"question":'
  });
  const oversized = await fetch(`http://127.0.0.1:${server.address().port}/api/crm/assistant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({ question: 'x'.repeat(110 * 1024) })
  });

  assert.equal(invalidJson.status, 400);
  assert.equal((await invalidJson.json()).error.code, 'INVALID_JSON');
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, 'REQUEST_TOO_LARGE');
});

test('rejects URL inputs, credentials, and arbitrary query parameters on bot endpoints', async (t) => {
  const app = createApp({
    crmService: { query: async () => ({ module: 'Deals', request_type: 'records', data: [], count: 0 }) }
  });
  const server = await startServer(t, app);
  const urlField = await send(server, '/api/crm/assistant', { body: { question: 'Show deals', url: 'https://attacker.test' } });
  const nestedUrl = await send(server, '/api/crm/assistant', { body: { request: { question: 'Show deals', url: 'https://attacker.test' } } });
  const credential = await send(server, '/api/crm/assistant', { body: { question: 'Show deals', request: { refresh_token: 'never-echo' } } });
  const query = await fetch(`http://127.0.0.1:${server.address().port}/api/crm/assistant?access_token=never-echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({ question: 'Show deals' })
  });

  assert.equal(urlField.status, 400);
  assert.equal(nestedUrl.status, 400);
  assert.equal(credential.status, 400);
  assert.equal((await credential.json()).error.code, 'CREDENTIAL_INPUT_NOT_ALLOWED');
  assert.equal(query.status, 400);
});

test('uses a bounded expiring process-local counter without external storage', async () => {
  const store = createRateLimitStore({ maxEntries: 2 });
  assert.equal((await store.increment('client-a', 60000)).count, 1);
  assert.equal((await store.increment('client-a', 60000)).count, 2);
  await store.increment('client-b', 50);
  await store.increment('client-c', 50);
  assert.equal((await store.increment('client-c', 60000)).count, 2);
  assert.equal((await store.increment('client-a', 60000)).count, 1);

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await store.increment('expiring-client', 5)).count, 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await store.increment('expiring-client', 5)).count, 1);
});

test('reports the exact application 503 source with safe request metadata', async (t) => {
  const app = createApp({
    crmService: {
      query: async () => {
        const error = new Error('CRM query budget exhausted');
        error.code = 'CRM_QUERY_BUDGET_EXCEEDED';
        error.statusCode = 503;
        throw error;
      }
    }
  });
  const server = await startServer(t, app);
  const loggedErrors = [];
  const originalError = console.error;
  console.error = (message) => loggedErrors.push(String(message));
  try {
    const response = await send(server, '/api/crm/assistant', { body: { question: 'Show me deals' } });
    assert.equal(response.status, 503);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    console.error = originalError;
  }
  const sourceLog = loggedErrors.find((message) => message.startsWith('[HTTP_503_SOURCE] '));
  assert.ok(sourceLog);
  const diagnostic = JSON.parse(sourceLog.slice('[HTTP_503_SOURCE] '.length));
  assert.deepEqual(diagnostic, {
    source: 'crm_query_budget',
    route: '/api/crm/assistant',
    method: 'POST',
    zohoRequestStarted: false,
    zohoStatus: null,
    requestId: diagnostic.requestId
  });
  assert.equal(typeof diagnostic.requestId, 'string');
});

test('health route remains independent of bot rate limiting', async (t) => {
  let limiterCalls = 0;
  const app = createApp({
    rateLimiters: {
      crm: (_req, _res, next) => { limiterCalls += 1; next(); },
      aggregate: (_req, _res, next) => { limiterCalls += 1; next(); },
      audit: (_req, _res, next) => { limiterCalls += 1; next(); }
    },
    crmService: { query: async () => ({ data: [] }) }
  });
  const server = await startServer(t, app);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  assert.equal(response.status, 200);
  assert.equal(limiterCalls, 0);
});

test('rejects client-supplied conversation and continuation identifiers', async (t) => {
  const app = createApp({
    crmService: { query: async () => ({ module: 'Deals', request_type: 'records', data: [], count: 0 }) }
  });
  const server = await startServer(t, app);
  const response = await send(server, '/api/crm/assistant', {
    body: { question: 'Show deals', continuation_token: 'client-controlled-state' }
  });
  assert.equal(response.status, 400);
});

test('times out a stalled bot request and safely ignores a late completion', async (t) => {
  const app = createApp({
    requestTimeoutMs: 10,
    crmService: {
      query: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { module: 'Deals', request_type: 'records', data: [], count: 0 };
      }
    }
  });
  const server = await startServer(t, app);
  const response = await send(server, '/api/crm/assistant', { body: { question: 'Show me deals' } });
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, 'REQUEST_TIMEOUT');
});
