const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
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

test('assistant returns request-scoped diagnostics and preserves explicit module routing', async () => {
  const seen = [];
  const app = createApp({ crmService: { query: async (input) => {
    seen.push(input);
    return { module: input.module, module_api_name: input.module === 'Meetings' ? 'Events' : input.module, request_type: 'records', fields: input.fields, filters: input.filters, data: [], count: 0 };
  } } });

  const result = await request(app, { question: "Show me today's meetings" });

  assert.equal(result.status, 200);
  assert.equal(result.body.diagnostics.resolved_module, 'Meetings');
  assert.equal(result.body.diagnostics.module_api_name, 'Events');
  assert.equal(result.body.diagnostics.zoho_error_code, null);
  assert.equal(result.body.diagnostics.zoho_error_message, null);
  assert.match(result.body.diagnostics.request_id, /^crm_\d{8}_\d{6}_[a-f0-9]{6}$/);
  assert.equal(seen[0].module, 'Meetings');
  assert.notEqual(seen[0].module, 'Deals');
});

test('assistant preserves diagnostics and upstream details on failure', async () => {
  const app = createApp({ crmService: { query: async () => {
    const error = new Error('Zoho denied the request.');
    error.code = 'OAUTH_SCOPE_MISMATCH';
    error.statusCode = 502;
    error.details = { endpoint: '/crm/v8/Calls', upstream_status: 401, upstream_code: 'OAUTH_SCOPE_MISMATCH', upstream_message: 'Scope is missing.' };
    throw error;
  } } });

  const result = await request(app, { question: "Show me today's calls" });

  assert.equal(result.status, 502);
  assert.equal(result.body.error.code, 'OAUTH_SCOPE_MISMATCH');
  assert.equal(result.body.diagnostics.resolved_module, 'Calls');
  assert.equal(result.body.diagnostics.zoho_endpoint, '/crm/v8/Calls');
  assert.equal(result.body.diagnostics.zoho_http_status, 401);
  assert.equal(result.body.diagnostics.zoho_error_code, 'OAUTH_SCOPE_MISMATCH');
  assert.equal(result.body.diagnostics.zoho_error_message, 'Scope is missing.');
});

test('assistant maps Zoho NO_PERMISSION to HTTP 403 without changing Quotes', async () => {
  const app = createApp({ crmService: { query: async (_input, _context, diagnostics) => {
    diagnostics.module_api_name = 'Quotes';
    const error = new Error("Unable to access 'Quotes' field metadata.");
    error.code = 'NO_PERMISSION';
    error.statusCode = 403;
    error.details = { endpoint: '/crm/v8/settings/fields', upstream_status: 400, upstream_code: 'NO_PERMISSION', upstream_message: 'permission denied to access the module' };
    throw error;
  } } });

  const result = await request(app, { question: "Show me today's quotes" });

  assert.equal(result.status, 403);
  assert.equal(result.body.error.code, 'NO_PERMISSION');
  assert.equal(result.body.error.message, "Unable to access 'Quotes' field metadata.");
  assert.equal(result.body.diagnostics.resolved_module, 'Quotes');
  assert.equal(result.body.diagnostics.module_api_name, 'Quotes');
  assert.equal(result.body.diagnostics.zoho_http_status, 400);
});