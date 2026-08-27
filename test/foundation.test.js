const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const createApp = require('../src/app').createApp;
const { CRM_MODULES } = require('../src/constants/crmModules');
const { validateCrmQuery } = require('../src/validators/crmQuery.validator');
const openApi = require('../openapi.json');

function requestJson(app, path, method, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const request = http.request({
        port: server.address().port,
        path,
        method,
        headers: body ? { 'content-type': 'application/json' } : {}
      }, (response) => {
        let content = '';
        response.on('data', (chunk) => { content += chunk; });
        response.on('end', () => {
          server.close();
          resolve({ status: response.statusCode, body: JSON.parse(content) });
        });
      });
      request.on('error', (error) => { server.close(); reject(error); });
      if (body) request.write(JSON.stringify(body));
      request.end();
    });
  });
}

test('GET /health returns a successful health response', async () => {
  const response = await requestJson(createApp(), '/health', 'GET');
  assert.deepEqual(response, { status: 200, body: { success: true, status: 'ok', message: 'F-Grade backend is running' } });
});

test('POST /api/crm/query returns the CRM service response', async () => {
  const request = { module: 'Deals', fields: ['Deal_Name'], limit: 20 };
  const app = createApp({ crmService: { query: async (input) => ({ module: input.module, count: 1, data: [], pagination: { limit: input.limit, offset: input.offset, more_records: false } }) } });
  const response = await requestJson(app, '/api/crm/query', 'POST', request);
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.status, 'ok');
  assert.equal(response.body.module, 'Deals');
  assert.equal(response.body.count, 1);
});

test('POST /api/crm/assistant accepts question, prompt, and message', async () => {
  const calls = [];
  const app = createApp({ crmService: { query: async (input) => {
    calls.push(input);
    return { module: input.module, count: 0, data: [], pagination: { limit: input.limit, offset: input.offset, more_records: false } };
  } } });
  for (const key of ['question', 'prompt', 'message']) {
    const response = await requestJson(app, '/api/crm/assistant', 'POST', { [key]: 'Show me deals' });
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.question, 'Show me deals');
  }
  assert.equal(calls.length, 3);
  assert.equal(calls[0].module, 'Deals');
});

test('POST /api/crm/assistant routes conversion questions to analysis', async () => {
  let request;
  const app = createApp({ crmService: { query: async (input) => {
    request = input;
    return { module: 'Leads', request_type: 'analysis', summary: { leads_created: 0 }, data: [], pagination: { limit: 20, offset: 0, more_records: false } };
  } } });
  const response = await requestJson(app, '/api/crm/assistant', 'POST', { question: 'Give me the count of leads created this month and how many converted to deals.' });
  assert.equal(response.status, 200);
  assert.equal(request.request_type, 'analysis');
  assert.equal(request.analysis.type, 'lead_conversion');
  assert.equal(request.fields.includes('Converted'), false);
});

test('accepts Copilot count requests without record fields', () => {
  const request = validateCrmQuery({
    module: 'Leads',
    request_type: 'count',
    filters: [{ field: 'Created_Time', operator: 'between', value: ['2026-08-01', '2026-09-01'] }]
  });
  assert.deepEqual(request.fields, ['id']);
  assert.equal(request.request_type, 'count');
  assert.deepEqual(request.filters[0].value, ['2026-08-01', '2026-09-01']);
});

test('defaults record requests to valid module fields when the connector omits fields', () => {
  const request = validateCrmQuery({ module: 'Deals' });
  assert.equal(request.module, 'Deals');
  assert.ok(Array.isArray(request.fields));
  assert.ok(request.fields.length > 0);
  assert.ok(request.fields.includes('Deal_Name'));
  assert.equal(request.request_type, 'records');
});

test('plans a general-purpose count question for this month leads', async () => {
  const app = createApp({ crmService: { query: async (input) => ({ module: input.module, request_type: input.request_type, count: 7, pagination: { limit: input.limit, offset: input.offset, more_records: false } }) } });
  const response = await requestJson(app, '/api/crm/assistant', 'POST', { question: 'How many leads were created this month?' });
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.module, 'Leads');
  assert.equal(response.body.request_type, 'count');
  assert.equal(response.body.count, 7);
});

test('plans first lead records as the latest requested page', async () => {
  let request;
  const app = createApp({ crmService: { query: async (input) => {
    request = input;
    return { module: input.module, data: [], pagination: { limit: input.limit, offset: input.offset, more_records: false } };
  } } });
  const response = await requestJson(app, '/api/crm/assistant', 'POST', { question: 'Give me the first 10 leads.' });
  assert.equal(response.status, 200);
  assert.equal(request.module, 'Leads');
  assert.equal(request.limit, 10);
  assert.equal(request.offset, 0);
  assert.equal(request.sort_field, 'Created_Time');
  assert.equal(request.sort_order, 'desc');
});

test('plans a general-purpose aggregate question for average deal value', async () => {
  const app = createApp({ crmService: { query: async (input) => ({ module: input.module, request_type: input.request_type, aggregate: input.aggregate, count: 1, data: [], pagination: { limit: input.limit, offset: input.offset, more_records: false } }) } });
  const response = await requestJson(app, '/api/crm/assistant', 'POST', { question: 'What is the average deal value?' });
  assert.equal(response.status, 200);
  assert.equal(response.body.module, 'Deals');
  assert.equal(response.body.request_type, 'aggregate');
  assert.equal(response.body.aggregate.operation, 'avg');
  assert.equal(response.body.aggregate.field, 'Amount');
});

test('plans a Closed Won dashboard by owner without an Owner name filter', () => {
  const request = require('../src/controllers/crm.controller').planQuestion('Give me a report for all closed won deals by all persons like a dashboard');
  assert.equal(request.module, 'Deals');
  assert.equal(request.request_type, 'aggregate');
  assert.deepEqual(request.aggregate, { operation: 'sum', field: 'Amount' });
  assert.equal(request.group_by, 'Owner');
  assert.deepEqual(request.filters, [{ field: 'Stage', operator: 'equals', value: 'Closed Won' }]);
});

test('plans a complex Lead Source report without Deals-only aggregate fields', () => {
  const request = require('../src/controllers/crm.controller').planQuestion('For all Leads created between January 1, 2026 and June 30, 2026, exclude leads with a blank Lead Source, group the leads by Lead Source, show the number of leads and the percentage each source contributes to the total, sort the results from highest to lowest number of leads, and identify the top 5 individual leads from the highest-volume source.');
  assert.equal(request.module, 'Leads');
  assert.equal(request.request_type, 'analysis');
  assert.deepEqual(request.analysis, { type: 'lead_source_report' });
  assert.equal(request.group_by, undefined);
  assert.deepEqual(request.filters, [
    { field: 'Created_Time', operator: 'between', value: ['2026-01-01', '2026-06-30'] },
    { field: 'Lead_Source', operator: 'is_not_null' }
  ]);
  assert.deepEqual(request.fields, ['First_Name', 'Last_Name', 'Company', 'Email', 'Lead_Status', 'Lead_Source', 'Created_Time']);
});

test('returns a renderer-ready dashboard specification from CRM results', async () => {
  const app = createApp({ crmService: { query: async () => ({
    module: 'Leads',
    request_type: 'analysis',
    analysis: 'lead_source_report',
    total: 10,
    source_breakdown: [
      { source: 'Website', count: 7, percentage: 70 },
      { source: 'Referral', count: 3, percentage: 30 }
    ],
    top_source: 'Website',
    top_leads: [{ name: 'A One', company: 'Example', email: 'a@example.com', lead_status: 'New', lead_source: 'Website', created_time: '2026-08-27' }],
    warnings: []
  }) } });
  const response = await requestJson(app, '/api/crm/assistant', 'POST', { question: 'Create a lead source dashboard.' });
  const dashboard = JSON.parse(response.body.answer).dashboard;

  assert.equal(response.status, 200);
  assert.equal(dashboard.title, 'Lead Source Performance Dashboard');
  assert.equal(dashboard.kpis[0].value, '10');
  assert.equal(dashboard.charts[0].type, 'horizontal_bar');
  assert.deepEqual(dashboard.charts[0].data, dashboard.tables[0].rows);
  assert.equal(dashboard.tables[1].rows[0].email, 'a@example.com');
  assert.equal(dashboard.data_quality.length, 0);
});

test('returns an explicit dashboard empty state when CRM data is unavailable', async () => {
  const app = createApp({ crmService: { query: async () => ({ module: 'Leads', data: [], pagination: { more_records: false } }) } });
  const response = await requestJson(app, '/api/crm/assistant', 'POST', { question: 'Create a lead dashboard.' });
  const dashboard = JSON.parse(response.body.answer).dashboard;

  assert.equal(response.status, 200);
  assert.equal(dashboard.tables[0].empty_state, 'No data available for the selected request.');
  assert.ok(dashboard.data_quality.includes('No verified CRM data was available for the requested visualization.'));
});

test('plans a general-purpose owner and amount filter question', async () => {
  const app = createApp({ crmService: { query: async (input) => ({ module: input.module, filters: input.filters, pagination: { limit: input.limit, offset: input.offset, more_records: false } }) } });
  const response = await requestJson(app, '/api/crm/assistant', 'POST', { question: 'Show me deals owned by Laya above ₹50,000.' });
  assert.equal(response.status, 200);
  assert.equal(response.body.module, 'Deals');
  assert.ok(response.body.filters.some((filter) => filter.field === 'Owner' && filter.value === 'Laya'));
  assert.ok(response.body.filters.some((filter) => filter.field === 'Amount' && filter.operator === 'greater_than'));
});

test('plans lead conversion analysis for a natural-language conversion question', async () => {
  const app = createApp({ crmService: { query: async (input) => ({ module: input.module, request_type: input.request_type, analysis: input.analysis, pagination: { limit: input.limit, offset: input.offset, more_records: false } }) } });
  const response = await requestJson(app, '/api/crm/assistant', 'POST', { question: 'How many of those leads became deals?' });
  assert.equal(response.status, 200);
  assert.equal(response.body.module, 'Leads');
  assert.equal(response.body.request_type, 'analysis');
  assert.equal(response.body.analysis.type, 'lead_conversion');
});

test('returns a natural-language answer for CRM count questions', async () => {
  const app = createApp({ crmService: { query: async () => ({ module: 'Leads', request_type: 'count', count: 42, pagination: { limit: 20, offset: 0, more_records: false } }) } });
  const response = await requestJson(app, '/api/crm/assistant', 'POST', { question: 'How many leads were created this month?' });
  assert.equal(response.status, 200);
  assert.ok(typeof response.body.answer === 'string');
  assert.match(response.body.answer, /42/i);
  assert.match(response.body.answer, /Leads/i);
});

test('returns a natural-language summary for conversion analysis', async () => {
  const app = createApp({ crmService: { query: async () => ({ module: 'Leads', request_type: 'analysis', summary: { leads_created: 120, leads_converted: 30, leads_converted_to_deals: 24, conversion_rate: 20 }, pagination: { limit: 20, offset: 0, more_records: false } }) } });
  const response = await requestJson(app, '/api/crm/assistant', 'POST', { question: 'What is the lead conversion rate?' });
  assert.equal(response.status, 200);
  assert.match(response.body.answer, /20\.00%|20%|20 percent/i);
  assert.match(response.body.answer, /24/i);
});

test('rejects unsupported Converted Lead fields with the exact field error', () => {
  assert.throws(
    () => validateCrmQuery({ module: 'Leads', fields: ['id', 'Converted'] }),
    (error) => error.details.errors.some((item) => item.path === 'fields[1]' && item.message.includes("Field 'Converted' is not supported"))
  );
});

test('Copilot schema treats conversion as an operation, not the invalid Converted field', () => {
  const guidance = openApi.info['x-copilot-studio-tool-description'];
  assert.match(guidance, /never emit a Leads field named Converted/i);
  assert.match(guidance, /conversion questions must remain natural language/i);
  assert.equal(openApi.info['x-copilot-studio-field-mappings'], undefined);
});

test('OpenAPI exposes only question input and response output', () => {
  const operation = openApi.paths['/api/crm/assistant'].post;
  const request = openApi.definitions.AssistantRequest;
  const response = openApi.definitions.AssistantResponse;

  assert.equal(operation.operationId, 'askCrmAssistant');
  assert.deepEqual(Object.keys(request.properties), ['question']);
  assert.deepEqual(request.required, ['question']);
  assert.equal(request.additionalProperties, false);
  assert.deepEqual(Object.keys(response.properties), ['response']);
  assert.deepEqual(response.required, ['response']);
  assert.equal(response.additionalProperties, false);
  assert.equal(response.properties.response.description, "Complete answer and requested CRM data returned by the backend for the user's question.");
});

test('module-specific CRM routes remain unavailable', async () => {
  const response = await requestJson(createApp(), '/api/crm/deals', 'GET');
  assert.equal(response.status, 404);
});

test('rejects invalid module and returns a field-specific error', async () => {
  const response = await requestJson(createApp(), '/api/crm/query', 'POST', { module: 'Unknown', fields: ['id'] });
  assert.equal(response.status, 400);
  assert.equal(response.body.success, false);
  assert.equal(response.body.status, 'error');
  assert.equal(response.body.error.code, 'INVALID_CRM_REQUEST');
  assert.equal(response.body.error.details.errors[0].path, 'module');
});

test('rejects invalid filter values, sorting, limit, and offset', async () => {
  const response = await requestJson(createApp(), '/api/crm/query', 'POST', {
    module: 'Deals',
    fields: ['Deal_Name'],
    filters: [{ field: 'Stage', operator: 'equals' }],
    sort: { field: 'Deal_Name', order: 'sideways' },
    limit: 0,
    offset: -1
  });
  const errors = response.body.error.details.errors;
  assert.equal(response.status, 400);
  assert.ok(errors.some((error) => error.path === 'filters[0].value'));
  assert.ok(errors.some((error) => error.path === 'sort.order'));
  assert.ok(errors.some((error) => error.path === 'limit'));
  assert.ok(errors.some((error) => error.path === 'offset'));
});

test('accepts valid API fields for Deals, Leads, Contacts, and Accounts', () => {
  for (const module of ['Deals', 'Leads', 'Contacts', 'Accounts']) {
    const fields = CRM_MODULES[module].slice(0, 3);
    assert.deepEqual(validateCrmQuery({ module, fields }).fields, fields);
  }
});

test('rejects display labels instead of Zoho API field names', () => {
  for (const [module, field] of [['Deals', 'Account Name'], ['Leads', 'Closing Date'], ['Contacts', 'Account Name'], ['Accounts', 'Closing Date']]) {
    assert.throws(() => validateCrmQuery({ module, fields: [field] }), (error) => {
      assert.equal(error.code, 'INVALID_CRM_REQUEST');
      assert.match(error.details.errors[0].message, new RegExp(`Field '${field}'.*valid Zoho CRM API field name`));
      return true;
    });
  }
});

test('accepts the known-good closed won Deals request', () => {
  const request = validateCrmQuery({
    module: 'Deals',
    fields: ['Deal_Name', 'Account_Name', 'Amount', 'Stage', 'Closing_Date', 'Owner'],
    filters: [
      { field: 'Stage', operator: 'equals', value: 'Closed Won' },
      { field: 'Amount', operator: 'greater_than', value: 50000 }
    ],
    sort_field: 'Amount',
    sort_order: 'desc',
    limit: 20,
    offset: 0
  });
  assert.deepEqual(request.fields, ['Deal_Name', 'Account_Name', 'Amount', 'Stage', 'Closing_Date', 'Owner']);
  assert.equal(request.filters.length, 2);
  assert.deepEqual(request.sort, { field: 'Amount', order: 'desc' });
});

test('normalizes a comma-separated between value into exactly two values', () => {
  const request = validateCrmQuery({
    module: 'Deals',
    fields: ['Closing_Date'],
    filters: [{ field: 'Closing_Date', operator: 'between', value: '2026-07-01,2026-07-31' }]
  });
  assert.deepEqual(request.filters[0].value, ['2026-07-01', '2026-07-31']);
});

test('continues accepting an array between value and rejects invalid ranges', () => {
  const request = validateCrmQuery({
    module: 'Deals',
    fields: ['Closing_Date'],
    filters: [{ field: 'Closing_Date', operator: 'between', value: ['2026-07-01', '2026-07-31'] }]
  });
  assert.deepEqual(request.filters[0].value, ['2026-07-01', '2026-07-31']);
  assert.throws(() => validateCrmQuery({
    module: 'Deals',
    fields: ['Closing_Date'],
    filters: [{ field: 'Closing_Date', operator: 'between', value: '2026-07-01,,2026-07-31' }]
  }), (error) => {
    assert.match(error.details.errors[0].message, /between requires exactly two non-empty scalar values/);
    return true;
  });
});
