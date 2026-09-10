const test = require('node:test');
const assert = require('node:assert/strict');
const { createCanonicalPlan } = require('../src/query/canonicalPlan');
const { createCrmQueryPlanner } = require('../src/planners/crmQueryPlanner');
const { CrmService } = require('../src/services/crm.service');

test('canonical plans have one stable shape for record requests', () => {
  const plan = createCanonicalPlan({
    module: 'Deals',
    request_type: 'records',
    fields: ['id'],
    filters: [{ field: 'Amount', operator: 'greater_than', value: 50000 }],
    sort_field: 'Amount',
    sort_order: 'desc',
    limit: 10,
    offset: 20
  });

  assert.equal(plan.domain, 'CRM');
  assert.equal(plan.intent, 'records');
  assert.deepEqual(plan.pagination, { limit: 10, offset: 20 });
  assert.deepEqual(plan.sort, { field: 'Amount', order: 'desc' });
  assert.deepEqual(plan.group_by, []);
  assert.equal(plan.filters[0].value, 50000);
});

test('the planner rejects record mutations before execution', () => {
  const planner = createCrmQueryPlanner(() => ({ module: 'Deals', fields: ['id'], filters: [] }));
  assert.throws(() => planner('Delete the deals'), (error) => error.code === 'READ_ONLY_OPERATION');
  assert.doesNotThrow(() => planner('Create a lead dashboard'));
});

test('numeric filter values are normalized from live field metadata', async () => {
  let captured;
  const service = new CrmService({
    executionStats: {},
    resolveModuleApiName: async () => 'Deals',
    getFieldMetadata: async () => ({
      fields: ['id', 'Amount'],
      metadata: [
        { api_name: 'id', display_label: 'Record ID', data_type: 'text' },
        { api_name: 'Amount', display_label: 'Amount', data_type: 'currency' }
      ]
    }),
    resolveOwnerFilters: async (filters) => filters,
    query: async (request) => {
      captured = request;
      return { records: [], info: { more_records: false }, module_api_name: request.module_api_name };
    }
  });

  await service.query({ module: 'Deals', fields: ['id'], filters: [{ field: 'Amount', operator: 'greater_than', value: '50k' }], limit: 20, offset: 0 });
  assert.equal(captured.filters[0].value, 50000);
});

test('invalid numeric filter values fail before Zoho record execution', async () => {
  let queryCalls = 0;
  const service = new CrmService({
    executionStats: {},
    resolveModuleApiName: async () => 'Deals',
    getFieldMetadata: async () => ({ fields: ['id', 'Amount'], metadata: [{ api_name: 'id', data_type: 'text' }, { api_name: 'Amount', data_type: 'currency' }] }),
    resolveOwnerFilters: async (filters) => filters,
    query: async () => { queryCalls += 1; return { records: [], info: {} }; }
  });

  await assert.rejects(() => service.query({ module: 'Deals', fields: ['id'], filters: [{ field: 'Amount', operator: 'greater_than', value: 'many' }], limit: 20, offset: 0 }), (error) => error.code === 'INVALID_FILTER_VALUE');
  assert.equal(queryCalls, 0);
});
