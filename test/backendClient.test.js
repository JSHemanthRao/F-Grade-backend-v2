const test = require('node:test');
const assert = require('node:assert/strict');
const { BackendClient } = require('../src/services/backendClient');

test('BackendClient forwards the natural-language question to the configured assistant route', async () => {
  const calls = [];
  const client = new BackendClient({
    post: async (...args) => {
      calls.push(args);
      return { status: 200, data: { success: true, answer: '10 leads found.' } };
    }
  }, {
    backendApiUrl: 'https://f-grade-backend-v2.onrender.com/',
    backendApiPath: 'api/crm/assistant',
    backendRequestTimeoutMs: 1000,
    backendDiagnostics: false
  });

  const response = await client.ask('give me first 10 leads');

  assert.deepEqual(response, { success: true, answer: '10 leads found.' });
  assert.equal(calls[0][0], 'https://f-grade-backend-v2.onrender.com/api/crm/assistant');
  assert.deepEqual(calls[0][1], { question: 'give me first 10 leads' });
  assert.equal(calls[0][2].headers['Content-Type'], 'application/json');
});

test('BackendClient does not duplicate a path already present in the base URL', async () => {
  let endpoint;
  const client = new BackendClient({
    post: async (url) => {
      endpoint = url;
      return { status: 200, data: { success: true } };
    }
  }, {
    backendApiUrl: 'https://example.test/api',
    backendApiPath: '/api/crm/assistant',
    backendRequestTimeoutMs: 1000,
    backendDiagnostics: false
  });

  await client.ask('how many leads are there?');

  assert.equal(endpoint, 'https://example.test/api/crm/assistant');
});

test('BackendClient preserves the complete question while validating whitespace-only input', async () => {
  let requestBody;
  const client = new BackendClient({
    post: async (url, body) => {
      requestBody = body;
      return { status: 200, data: { success: true } };
    }
  }, {
    backendApiUrl: 'https://example.test',
    backendApiPath: '/api/crm/assistant',
    backendRequestTimeoutMs: 1000,
    backendDiagnostics: false
  });

  await client.ask('  Give me first 10 leads.  ');

  assert.equal(requestBody.question, '  Give me first 10 leads.  ');
  await assert.rejects(() => client.ask('   '), /non-empty string/);
});

test('BackendClient reports a sanitized endpoint-not-found error for HTTP 404', async () => {
  const client = new BackendClient({
    post: async () => {
      const error = new Error('not found');
      error.response = { status: 404, data: { error: { message: 'Route not found.' } } };
      throw error;
    }
  }, {
    backendApiUrl: 'https://example.test',
    backendApiPath: '/wrong/path',
    backendRequestTimeoutMs: 1000,
    backendDiagnostics: false
  });

  await assert.rejects(
    () => client.ask('show leads by lead source'),
    (error) => error.code === 'BACKEND_ENDPOINT_NOT_FOUND'
      && error.statusCode === 404
      && error.message === 'Backend endpoint not found: /wrong/path'
  );
});
