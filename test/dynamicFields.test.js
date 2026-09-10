const test = require('node:test');
const assert = require('node:assert/strict');
const { CrmService } = require('../src/services/crm.service');

test('retrieval uses dynamic response fields plus execution-only filter fields', async () => {
  let captured;
  const service = new CrmService({
    executionStats: {},
    resolveModuleApiName: async () => 'Deals',
    getFieldMetadata: async () => ({
      fields: ['id', 'Deal_Name', 'Amount', 'Stage'],
      metadata: [
        { api_name: 'id', display_label: 'Record ID', data_type: 'text' },
        { api_name: 'Deal_Name', display_label: 'Deal Name', data_type: 'text', name_field: true },
        { api_name: 'Amount', display_label: 'Amount', data_type: 'currency' },
        { api_name: 'Stage', display_label: 'Stage', data_type: 'picklist' }
      ]
    }),
    resolveOwnerFilters: async (filters) => filters,
    query: async (request) => {
      captured = request;
      return { records: [{ Deal_Name: 'ABC', Amount: 75000, Stage: 'Negotiation' }], info: { count: 1, more_records: false }, module_api_name: 'Deals' };
    }
  });

  const result = await service.query({
    module: 'Deals',
    fields: ['Deal_Name'],
    filters: [{ field: 'Amount', operator: 'greater_than', value: 50000 }],
    limit: 20,
    offset: 0
  });

  assert.deepEqual(captured.response_fields, ['Deal_Name']);
  assert.deepEqual(captured.execution_fields, ['Deal_Name', 'Amount']);
  assert.deepEqual(result.records, [{ Deal_Name: 'ABC' }]);
});

test('implicit record fields are selected from live metadata, not module constants', async () => {
  let captured;
  const service = new CrmService({
    executionStats: {},
    resolveModuleApiName: async () => 'Custom_Projects',
    getFieldMetadata: async () => ({
      fields: ['id', 'Project_Title__c', 'Risk_Level__c', 'Created_Time'],
      metadata: [
        { api_name: 'id', display_label: 'Record ID', data_type: 'text' },
        { api_name: 'Project_Title__c', display_label: 'Project Title', data_type: 'text', name_field: true },
        { api_name: 'Risk_Level__c', display_label: 'Risk Level', data_type: 'picklist' },
        { api_name: 'Created_Time', display_label: 'Created Time', data_type: 'datetime' }
      ]
    }),
    resolveOwnerFilters: async (filters) => filters,
    query: async (request) => { captured = request; return { records: [], info: {}, module_api_name: 'Custom_Projects' }; }
  });

  await service.query({ module: 'Customer Projects', fields: ['id'], fields_source: 'planner_default', filters: [], limit: 20, offset: 0 });
  assert.ok(captured.execution_fields.includes('Project_Title__c'));
  assert.ok(!captured.execution_fields.includes('Amount'));
});
