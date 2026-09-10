const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveModuleReference } = require('../src/resolvers/moduleResolver');
const { CrmService } = require('../src/services/crm.service');
const { planQuestion } = require('../src/controllers/crm.controller');

const metadata = [
  { api_name: 'Deals', module_name: 'Deals', plural_label: 'Deals', singular_label: 'Deal', viewable: true, api_supported: true },
  { api_name: 'Leads', module_name: 'Leads', plural_label: 'Leads', singular_label: 'Lead', viewable: true, api_supported: true },
  { api_name: 'Events', module_name: 'Events', plural_label: 'Events', singular_label: 'Event', viewable: true, api_supported: true },
  { api_name: 'Calls', module_name: 'Calls', plural_label: 'Calls', singular_label: 'Call', viewable: true, api_supported: true },
  { api_name: 'Products', module_name: 'Products', plural_label: 'Products', singular_label: 'Product', viewable: true, api_supported: true },
  { api_name: 'Customer_Projects', module_name: 'Customer Projects', plural_label: 'Customer Projects', singular_label: 'Customer Project', viewable: true, api_supported: true }
];

for (const [input, apiName, matchType] of [
  ['Deals', 'Deals', 'exact_normalized'], ['deals', 'Deals', 'exact_normalized'], ['DEALS', 'Deals', 'exact_normalized'],
  ['DeAlS', 'Deals', 'exact_normalized'], ['deal', 'Deals', 'singular'], ['deal records', 'Deals', 'singular'],
  ['show me deals', 'Deals', 'exact_normalized'], ['show me the deals', 'Deals', 'exact_normalized'],
  ['lead', 'Leads', 'singular'], ['meeting', 'Events', 'singular'], ['meetings', 'Events', 'exact_normalized'],
  ['today\'s meetings', 'Events', 'exact_normalized'], ['call', 'Calls', 'singular'], ['product', 'Products', 'singular'],
  ['customer project', 'Customer_Projects', 'singular'], ['show me customer projects', 'Customer_Projects', 'exact_normalized']
]) {
  test(`resolves ${input} semantically`, () => {
    const result = resolveModuleReference(input, metadata);
    assert.equal(result.matched, true);
    assert.equal(result.api_name, apiName);
    assert.equal(result.match_type, matchType);
  });
}

test('returns ambiguity instead of guessing overlapping order modules', () => {
  const result = resolveModuleReference('orders', [
    { api_name: 'Sales_Orders', module_name: 'Sales Orders', plural_label: 'Sales Orders' },
    { api_name: 'Purchase_Orders', module_name: 'Purchase Orders', plural_label: 'Purchase Orders' }
  ]);
  assert.equal(result.ambiguous, true);
  assert.deepEqual(result.candidates.map((item) => item.api_name).sort(), ['Purchase_Orders', 'Sales_Orders']);
});

test('equivalent case variants produce the same canonical planner module', () => {
  const upper = planQuestion('Show me Deals where the amount is greater than 50000.');
  const lower = planQuestion('Show me deals where the amount is greater than 50000.');
  assert.equal(upper.module, lower.module);
  assert.deepEqual(upper.filters, lower.filters);
});

test('CRM service resolves original custom module references before fields', async () => {
  let captured;
  const service = new CrmService({
    executionStats: {},
    resolveModuleReference: async () => ({ semantic_name: 'Customer Projects', api_name: 'Customer_Projects', confidence: 0.99, match_type: 'exact_normalized' }),
    resolveModuleApiName: async () => 'Customer_Projects',
    getFieldMetadata: async () => ({ fields: ['id'], metadata: [{ api_name: 'id', data_type: 'text' }] }),
    resolveOwnerFilters: async (filters) => filters,
    query: async (request) => { captured = request; return { records: [], info: {}, module_api_name: request.module_api_name }; }
  });
  await service.query({ module: 'customer projects', original_question: 'Show me customer projects', fields: ['id'], filters: [], limit: 20, offset: 0 });
  assert.equal(captured.module, 'Customer Projects');
  assert.equal(captured.module_api_name, 'Customer_Projects');
});
