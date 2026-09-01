const assert = require('assert');
const { createCrmController } = require('../src/controllers/crm.controller');

// Lightweight unit test that calls the controller.test handler directly
async function run() {
  const mockService = {};
  const controller = createCrmController(mockService);

  const req = { body: { module: 'Meetings' } };
  let statusCode = 0;
  let body = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(obj) { body = obj; }
  };

  await controller.test(req, res, (err) => { throw err; });

  assert.strictEqual(statusCode, 200, 'expected status 200');
  assert.ok(body, 'expected body');
  assert.strictEqual(body.success, true, 'expected success true');
  assert.strictEqual(body.module, 'Meetings');
  assert.strictEqual(body.count, 1);
  console.log('crm.test passed');
}

if (require.main === module) run();
module.exports = run;
