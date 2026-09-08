const test = require('node:test');
const assert = require('node:assert/strict');
const { planQuestion, createCrmController } = require('../src/controllers/crm.controller');
const { CrmService } = require('../src/services/crm.service');
const { validateCrmQuery } = require('../src/validators/crmQuery.validator');

const periods = ['today', 'yesterday', 'tomorrow', 'this week', 'last week', 'next week', 'this month', 'last month', 'next month', 'this quarter', 'last quarter', 'next quarter', 'this year', 'last year', 'next year'];

test('plans every relative period with a dynamic exclusive end', () => {
  for (const period of periods) {
    const request = planQuestion(`Show me leads created ${period}`);
    assert.equal(request.module, 'Leads');
    assert.equal(request.filters[0].field, 'Created_Time');
    assert.equal(request.filters[0].exclusive_end, true);
    assert.match(request.filters[0].value[0], /^\d{4}-\d{2}-\d{2}$/);
    assert.match(request.filters[0].value[1], /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('plans standard period comparisons without changing the module', () => {
  const request = planQuestion('Compare leads created today vs yesterday');
  assert.equal(request.request_type, 'comparison');
  assert.equal(request.module, 'Leads');
  assert.equal(request.module_api_name, 'Leads');
  assert.deepEqual(request.comparison, { current_period: 'today', previous_period: 'yesterday', date_field: 'Created_Time', operation: 'count', field: 'id' });
  assert.equal(request.date_range.current.period, 'today');
  assert.equal(request.date_range.previous.period, 'yesterday');
});

test('plans COUNT, SUM, and AVG comparisons', () => {
  assert.equal(planQuestion('Compare leads this month vs last month').aggregate.operation, 'count');
  assert.deepEqual(planQuestion("Compare total deal value this month vs last month").aggregate, { operation: 'sum', field: 'Amount' });
  assert.deepEqual(planQuestion('Compare average deal amount this quarter vs last quarter').aggregate, { operation: 'avg', field: 'Amount' });
});

test('plans all requested numeric comparison operators', () => {
  const cases = [['>', 'greater_than'], ['>=', 'greater_equal'], ['<', 'less_than'], ['<=', 'less_equal'], ['=', 'equals'], ['!=', 'not_equals']];
  for (const [symbol, operator] of cases) {
    const request = planQuestion(`Show deals with Amount ${symbol} 1000`);
    assert.equal(request.filters.find((filter) => filter.field === 'Amount').operator, operator);
  }
});

test('validates BETWEEN, IS NULL, and IS NOT NULL filters', () => {
  assert.equal(validateCrmQuery({ module: 'Leads', filters: [{ field: 'Created_Time', operator: 'between', value: ['2026-01-01', '2026-02-01'] }] }).filters[0].operator, 'between');
  assert.equal(validateCrmQuery({ module: 'Leads', filters: [{ field: 'Email', operator: 'is_null' }] }).filters[0].operator, 'is_null');
  assert.equal(validateCrmQuery({ module: 'Leads', filters: [{ field: 'Email', operator: 'is_not_null' }] }).filters[0].operator, 'is_not_null');
});

test('executes normalized count and SUM comparisons with zero-safe percentage changes', async () => {
  const zoho = {
    executionStats: {},
    resolveModuleApiName: async (module) => ({ Leads: 'Leads', Deals: 'Deals' })[module] || module,
    getFieldMetadata: async () => ({ fields: ['id', 'Created_Time', 'Amount'], metadata: [] }),
    resolveOwnerFilters: async (filters) => filters,
    count: async (_module, filters) => ({ count: filters[0].value[0].endsWith('-08') ? 12 : 0 }),
    aggregate: async (query) => ({ rows: [{ value: query.includes("'2026-10-01'") ? 100 : 50 }] })
  };
  const service = new CrmService(zoho);
  const countResult = await service.query(planQuestion('Compare leads created today vs yesterday'));
  assert.deepEqual(countResult.comparison, { current_period: 'today', previous_period: 'yesterday', current_value: 12, previous_value: 0, difference: 12, percentage_change: null });
  const sumResult = await service.query(planQuestion('Compare total deal value this month vs last month'));
  assert.equal(sumResult.request_type, 'comparison');
  assert.equal(sumResult.comparison.difference, 50);
});

test('preserves follow-up module and intent while changing only the period', async () => {
  const calls = [];
  const controller = createCrmController({ query: async (input) => { calls.push(input); return { module: input.module, request_type: input.request_type, count: 0, data: [] }; } });
  const response = (body) => ({ status: () => ({ json: (value) => value }), json: (value) => value });
  await controller.assistant({ body: { conversation_id: 'planner-follow-up', question: 'How many leads were created today?' } }, response({}), (error) => { throw error; });
  await controller.assistant({ body: { conversation_id: 'planner-follow-up', question: 'For yesterday' } }, response({}), (error) => { throw error; });
  assert.equal(calls[1].module, 'Leads');
  assert.equal(calls[1].request_type, 'count');
  assert.notEqual(calls[1].filters[0].value[0], calls[0].filters[0].value[0]);
});

test('preserves exact activity and lookup routing', () => {
  assert.equal(planQuestion('Show calls created today').module, 'Calls');
  assert.equal(planQuestion('Show tasks created today').module, 'Tasks');
  assert.equal(planQuestion('Show meetings created today').module, 'Meetings');
  assert.equal(planQuestion('Show products created today').module, 'Products');
  const request = planQuestion('Show me Deals with Account Name and Account Owner');
  assert.equal(request.module, 'Deals');
  assert.deepEqual(request.fields, ['id']);
});
