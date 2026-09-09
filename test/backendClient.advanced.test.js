const test = require('node:test');
const assert = require('assert');
const { BackendClient } = require('../src/services/backendClient');

test('BackendClient.ask forwards structured object payload to httpClient.post', async () => {
  const fakeHttp = {
    posted: null,
    async post(endpoint, payload, options) {
      this.posted = { endpoint, payload, options };
      return { status: 200, data: { success: true, received: payload } };
    }
  };

  const config = {
    backendApiUrl: 'http://localhost:3000',
    backendApiPath: '/api/crm/assistant',
    backendApiKey: undefined,
    backendDiagnostics: false,
    backendRequestTimeoutMs: 2000
  };

  const client = new BackendClient(fakeHttp, config);

  const req = { question: 'Who are my leads?', module: 'Leads', request_type: 'records' };
  const res = await client.ask(req);

  assert.deepEqual(fakeHttp.posted.payload, req);
  assert.deepEqual(res, { success: true, received: req });
});
