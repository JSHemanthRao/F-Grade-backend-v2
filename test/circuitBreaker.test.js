const test = require('node:test');
const assert = require('node:assert/strict');
const { CircuitBreaker } = require('../src/utils/circuitBreaker');

test('circuit breaker opens after transient failures and fails fast', async () => {
  const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 });
  const failure = new Error('temporary failure');
  failure.statusCode = 503;

  await assert.rejects(() => breaker.execute(async () => { throw failure; }), /temporary failure/);
  await assert.rejects(() => breaker.execute(async () => { throw failure; }), /temporary failure/);
  await assert.rejects(() => breaker.execute(async () => 'not called'), (error) => error.code === 'CRM_CIRCUIT_OPEN' && error.statusCode === 503);
  assert.equal(breaker.state, 'open');
});

test('circuit breaker closes after a successful half-open probe', async () => {
  const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 0 });
  const failure = new Error('temporary failure');
  failure.statusCode = 503;

  await assert.rejects(() => breaker.execute(async () => { throw failure; }));
  const result = await breaker.execute(async () => 'recovered');

  assert.equal(result, 'recovered');
  assert.equal(breaker.state, 'closed');
});
