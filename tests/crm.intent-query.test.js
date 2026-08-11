const test = require('node:test');
const assert = require('node:assert/strict');
const { buildExecutionPlan } = require('../src/crm/services/assistant/planner.service');
const { optimizeExecutionPlan } = require('../src/crm/services/assistant/query-optimizer.service');
const { validateIntentQueryPlan } = require('../src/crm/services/assistant/query-plan-validator.service');
const { buildQueryPlan } = require('../src/crm/services/query-builder.service');
const recordsService = require('../src/crm/services/records.service');
const assistantEngine = require('../src/crm/services/assistant-engine.service');
const { formatResponse } = require('../src/crm/services/assistant/formatter.service');

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
  assert.equal(queryPlan.fields.includes('Created_Time'), true);
  assert.equal(queryPlan.filters.find((filter) => filter.logicalField === 'date').field, 'Created_Time');
});

test('monthly customer data defaults to deal activity instead of account creation', () => {
  const plan = buildExecutionPlan('Give me July customer data');
  assert.deepEqual(plan.modules, ['deals']);
  assert.equal(plan.queryPlan.module, 'Deals');
  assert.equal(plan.queryPlan.dateField, 'Closing_Date');
  assert.equal(plan.queryPlan.startDate, '2026-07-01T00:00:00Z');
  assert.equal(plan.queryPlan.endDate, '2026-08-01T00:00:00Z');
  assert.equal(plan.queryPlan.customerScope, 'all');
  assert.equal(plan.queryPlan.fields.includes('Created_Time'), true);
});

test('new customer period requests use creation date explicitly', () => {
  const plan = buildExecutionPlan('Give me July data for new customers only');
  assert.deepEqual(plan.modules, ['accounts']);
  assert.equal(plan.queryPlan.dateField, 'Created_Time');
  assert.equal(plan.queryPlan.customerScope, 'new');
  assert.equal(plan.queryPlan.filters.find((filter) => filter.logicalField === 'date').field, 'Created_Time');
});

test('existing customer period requests keep the business date and add an internal scope filter', () => {
  const plan = buildExecutionPlan('Give me July data for existing customers only');
  assert.deepEqual(plan.modules, ['deals']);
  assert.equal(plan.queryPlan.dateField, 'Closing_Date');
  assert.equal(plan.queryPlan.customerScope, 'existing');
  assert.equal(plan.queryPlan.filters.some((filter) => filter.logicalField === 'date' && filter.field === 'Closing_Date'), true);
  assert.equal(plan.queryPlan.filters.some((filter) => filter.logicalField === 'customer_scope' && filter.field === 'Created_Time'), true);
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

test('cross-module relationship requests retrieve filtered deals first and only related contacts', async () => {
  const originalGetRecords = recordsService.getRecords;
  const calls = [];
  recordsService.getRecords = async (moduleKey, options) => {
    calls.push({ moduleKey, options });
    if (moduleKey === 'deals') {
      return {
        data: [{ id: 'deal-1', Stage: 'Closed Won', Closing_Date: '2026-06-15', Contact_Name: { id: 'contact-1' } }],
        info: { count: 1, more_records: false, retrievalComplete: true },
      };
    }
    assert.deepEqual(options.ids, ['contact-1']);
    return { data: [{ id: 'contact-1', First_Name: 'Asha', Email: 'asha@example.com' }], info: { count: 1, more_records: false } };
  };

  try {
    const response = await assistantEngine.handleAssistantRequest({ question: 'Give me contacts that converted to Closed Won deals in June 2026' });
    assert.equal(response.success, true);
    assert.deepEqual(response.data.map((record) => record.id), ['contact-1']);
    assert.deepEqual(calls.map((call) => call.moduleKey), ['deals', 'contacts']);
    assert.match(calls[0].options.criteria, /Stage:equals:Closed Won/);
    assert.match(calls[0].options.criteria, /Closing_Date:greater_equal:2026-06-01/);
    assert.equal(calls[1].options.criteria, undefined);
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('response data never asks for technical retrieval parameters', () => {
  const response = formatResponse({
    question: 'Give me deals',
    modules: ['deals'],
    intents: ['LIST'],
    timeRange: { label: 'all time', range: 'all_time' },
    queryPlan: { module: 'Deals', moduleKey: 'deals', operation: 'LIST', filters: [] },
  }, [{ module: 'deals', result: { data: [{ id: 'deal-1', Deal_Name: 'Acme' }], info: { count: 1, more_records: false, retrievalComplete: true } } }], []);
  const output = JSON.stringify(response);
  assert.doesNotMatch(output, /page number|pagination parameters|per_page|API parameters|retrieval parameters|sort parameters/i);
  assert.equal(response.module, 'Deals');
  assert.equal(response.operation, 'LIST');
  assert.equal(response.displayed, 1);
  assert.equal(response.hasMore, false);
});
