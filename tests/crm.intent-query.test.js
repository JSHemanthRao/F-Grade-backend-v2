const test = require('node:test');
const assert = require('node:assert/strict');
const { buildExecutionPlan } = require('../src/crm/services/assistant/planner.service');
const { optimizeExecutionPlan } = require('../src/crm/services/assistant/query-optimizer.service');
const { validateIntentQueryPlan } = require('../src/crm/services/assistant/query-plan-validator.service');
const { buildQueryPlan } = require('../src/crm/services/query-builder.service');

test('planner creates an authoritative structured query plan for historical Closed Won deals', () => {
  const plan = optimizeExecutionPlan(buildExecutionPlan('Give me Closed Won deals in June 2026'));
  const queryPlan = plan.queryPlan;

  assert.equal(queryPlan.module, 'Deals');
  assert.equal(queryPlan.operation, 'LIST');
  assert.equal(queryPlan.dateField, 'Closing_Date');
  assert.equal(queryPlan.startDate, '2026-06-01T00:00:00Z');
  assert.equal(queryPlan.endDate, '2026-07-01T00:00:00Z');
  assert.equal(queryPlan.stage, 'Closed Won');
  assert.equal(queryPlan.displayLimit, 25);
  assert.equal(queryPlan.searchScope, 'all_matching_records');
  assert.ok(queryPlan.fields.includes('id'));
  assert.ok(queryPlan.fields.includes('Deal_Name'));
  assert.ok(queryPlan.fields.includes('Amount'));
  assert.ok(queryPlan.fields.includes('Closing_Date'));
  assert.equal(validateIntentQueryPlan(queryPlan).valid, true);
});

test('created-in-period requests select Created_Time instead of a deal closing date', () => {
  const queryPlan = buildExecutionPlan('Give me deals created in June 2026').queryPlan;
  assert.equal(queryPlan.dateField, 'Created_Time');
  assert.equal(queryPlan.startDate, '2026-06-01T00:00:00Z');
  assert.equal(queryPlan.endDate, '2026-07-01T00:00:00Z');
  assert.equal(queryPlan.filters.find((filter) => filter.logicalField === 'date').field, 'Created_Time');
});

test('aggregate plans contain the exact operation and amount field', () => {
  const queryPlan = buildExecutionPlan('What is the total Closed Won value in June 2026?').queryPlan;
  assert.equal(queryPlan.module, 'Deals');
  assert.equal(queryPlan.operation, 'SUM');
  assert.deepEqual(queryPlan.aggregation.function, 'sum');
  assert.equal(queryPlan.aggregation.field, 'Amount');
  assert.equal(queryPlan.filters.some((filter) => filter.logicalField === 'stage'), true);
  assert.equal(queryPlan.filters.some((filter) => filter.logicalField === 'date'), true);
});

test('structured query plans build CRM criteria without reparsing the user question', () => {
  const queryPlan = {
    moduleKey: 'deals',
    operation: 'LIST',
    fields: ['id', 'Deal_Name', 'Amount', 'Stage', 'Closing_Date'],
    criteria: '(Stage:equals:Closed Won)',
    dateField: 'Closing_Date',
    startDate: '2026-06-01T00:00:00Z',
    endDate: '2026-07-01T00:00:00Z',
  };
  const built = buildQueryPlan('deals', {
    question: 'This text must not be used to invent a date',
    queryPlan,
    fields: queryPlan.fields,
    retrieval_mode: 'all',
    force_coql: true,
  });
  assert.match(built.query, /Stage = 'Closed Won'/i);
  assert.match(built.query, /Closing_Date >= '2026-06-01T00:00:00Z'/i);
  assert.match(built.query, /Closing_Date < '2026-07-01T00:00:00Z'/i);
  assert.doesNotMatch(built.query, /This text must not be used/i);
});
