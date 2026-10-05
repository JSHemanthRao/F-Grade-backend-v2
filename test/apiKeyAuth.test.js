const test = require('node:test');
const assert = require('node:assert/strict');

process.env.BACKEND_API_KEY = 'test-backend-key';
const { createApp } = require('../src/app');

test('audit-log endpoint accepts a valid API key and rejects missing or invalid keys', async (t) => {
  let capturedInput;
  const app = createApp({
    crmService: {
      queryAuditLog: async (input) => {
        capturedInput = input;
        return {
          count: 0,
          returned: 0,
          records: [],
          data: [],
          pagination: { limit: input.limit, offset: input.offset, returned: 0, more_records: false }
        };
      }
    }
  });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/crm/audit-log`;
  const body = JSON.stringify({ request: { question: "Give me yesterday's updates in CRM" } });

  const send = (headers = {}) => fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'close', ...headers },
    body
  });

  const missing = await send();
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error.code, 'AUTHENTICATION_REQUIRED');

  const invalid = await send({ 'x-api-key': 'wrong-test-key' });
  assert.equal(invalid.status, 401);
  assert.equal((await invalid.json()).error.code, 'AUTHENTICATION_REQUIRED');

  const bearerOnly = await send({ authorization: 'Bearer test-backend-key' });
  assert.equal(bearerOnly.status, 401);
  assert.equal((await bearerOnly.json()).error.code, 'AUTHENTICATION_REQUIRED');

  const valid = await send({ 'x-api-key': 'test-backend-key' });
  const result = await valid.json();
  assert.equal(valid.status, 200);
  assert.equal(result.success, true);
  assert.equal(result.operation, 'audit_log');
  assert.ok(result.time_range.start);
  assert.ok(result.time_range.end);
  assert.deepEqual(result.filters.action, ['updated']);
  assert.equal(capturedInput.audit_log.date_range.timeZone, 'Asia/Kolkata');
  assert.equal(capturedInput.audit_log.date_range.end_operator, 'exclusive');
});