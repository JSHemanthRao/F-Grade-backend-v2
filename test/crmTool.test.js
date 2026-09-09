const test = require('node:test');
const assert = require('assert');
const { CrmTool } = require('../src/tools/crmTool');

class FakeBackendClient {
  constructor() { this.calls = []; }
  async ask(args) { this.calls.push(args); return { ok: true, args }; }
}

test('CrmTool forwards structured args to backend and returns structuredContent', async () => {
  const fake = new FakeBackendClient();
  const tool = new CrmTool(fake);

  const args = {
    question: 'Show me leads created this month with an email, newest first',
    module: 'Leads',
    request_type: 'records',
    query: { filters: [] }
  };

  const result = await tool.execute(args);

  assert.ok(result); 
  assert.ok(result.structuredContent);
  // `structuredContent.response` is a JSON-stringified response
  const parsed = JSON.parse(result.structuredContent.response);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.args, args);
});
