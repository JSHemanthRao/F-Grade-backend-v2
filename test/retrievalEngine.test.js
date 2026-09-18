const test = require('node:test');
const assert = require('node:assert/strict');
const { materializeMetadataRequest } = require('../src/metadata/fieldResolver');
const { resolveRequestedFields } = require('../src/relationships/relationshipResolver');
const { RETRIEVAL_STRATEGIES, selectRetrievalStrategy } = require('../src/query/retrievalStrategy');
const { buildExecutableCoqlPlan } = require('../src/coql/coqlBuilder');

const metadataByModule = {
  Deals: {
    fields: ['id', 'Deal_Name', 'Amount', 'Account_Name'],
    metadata: [
      { api_name: 'id', display_label: 'Record ID', data_type: 'text' },
      { api_name: 'Deal_Name', display_label: 'Deal Name', data_type: 'text', name_field: true },
      { api_name: 'Amount', display_label: 'Amount', data_type: 'currency', filterable: true, sortable: true, aggregatable: true },
      { api_name: 'Account_Name', display_label: 'Account Name', data_type: 'lookup', lookup: { module: { api_name: 'Accounts' } } }
    ]
  },
  Accounts: {
    fields: ['id', 'Account_Name', 'Industry', 'Parent_Account'],
    metadata: [
      { api_name: 'id', display_label: 'Record ID', data_type: 'text' },
      { api_name: 'Account_Name', display_label: 'Account Name', data_type: 'text', name_field: true },
      { api_name: 'Industry', display_label: 'Industry', data_type: 'picklist', filterable: true, groupable: true },
      { api_name: 'Parent_Account', display_label: 'Parent Account', data_type: 'lookup', lookup: { module: { api_name: 'Accounts' } } }
    ]
  }
};

test('materializes requested fields and filters through live relationship metadata', async () => {
  const request = await materializeMetadataRequest({
    getFieldMetadata: async (module) => metadataByModule[module]
  }, {
    module: 'Deals',
    module_api_name: 'Deals',
    request_type: 'records',
    fields: ['id'],
    field_labels: ['deal name', 'account industry'],
    filters: [{ field: '__field__', field_label: 'account industry', operator: 'equals', value: 'Technology' }],
    limit: 20,
    offset: 0
  });

  assert.deepEqual(request.response_fields, ['Deal_Name', 'Account_Name.Industry']);
  assert.equal(request.filters[0].field, 'Account_Name.Industry');
  assert.equal(request.filters[0].value, 'Technology');
  assert.deepEqual(request.relationships[0].path_segments, [{ field: 'Account_Name', target_module: 'Accounts' }]);
  assert.equal(request.relationships[0].target_field, 'Industry');
});

test('traverses nested lookup relationships without a module-specific path map', async () => {
  const result = await resolveRequestedFields({
    module: 'Deals',
    fieldLabels: ['account parent account name'],
    metadata: metadataByModule.Deals.metadata,
    getFieldMetadata: async (module) => metadataByModule[module]
  });

  assert.deepEqual(result.fields, ['Account_Name.Parent_Account.Account_Name']);
  assert.deepEqual(result.relationships[0].path_segments, [
    { field: 'Account_Name', target_module: 'Accounts' },
    { field: 'Parent_Account', target_module: 'Accounts' }
  ]);
});

test('selects retrieval strategy only from the materialized canonical plan', () => {
  const cases = [
    [{ request_type: 'records', fields: ['Deal_Name'] }, RETRIEVAL_STRATEGIES.DIRECT_COQL],
    [{ request_type: 'records', fields: ['Account_Name.Industry'] }, RETRIEVAL_STRATEGIES.RELATIONSHIP_COQL],
    [{ request_type: 'records', fields: ['Account_Name.Industry'], limit: 20, offset: 0 }, RETRIEVAL_STRATEGIES.RELATIONSHIP_COQL],
    [{ request_type: 'records', fields: ['Deal_Name'], offset: 20 }, RETRIEVAL_STRATEGIES.PAGINATED_COQL],
    [{ request_type: 'count' }, RETRIEVAL_STRATEGIES.COUNT_API],
    [{ request_type: 'aggregate', aggregate: { operation: 'sum', field: 'Amount' } }, RETRIEVAL_STRATEGIES.AGGREGATE_COQL],
    [{ request_type: 'aggregate', aggregate: { operation: 'sum', field: 'Amount' }, group_by: 'Stage' }, RETRIEVAL_STRATEGIES.GROUPED_COQL],
    [{ request_type: 'search' }, RETRIEVAL_STRATEGIES.RECORD_LOOKUP],
    [{ request_type: 'analysis', analysis: { type: 'lead_conversion' } }, RETRIEVAL_STRATEGIES.CONVERSION_ANALYSIS],
    [{ request_type: 'analysis', analysis: { type: 'today_activity' } }, RETRIEVAL_STRATEGIES.ACTIVITY_ANALYSIS]
  ];

  for (const [plan, expected] of cases) assert.equal(selectRetrievalStrategy(plan), expected);
});

test('the shared COQL builder adds a deterministic id sort for pagination safety', () => {
  const executable = buildExecutableCoqlPlan({ module: 'Deals', fields: ['Deal_Name'], filters: [] });
  assert.equal(executable.select_query, 'select Deal_Name from Deals where (id is not null) order by id desc');
});
