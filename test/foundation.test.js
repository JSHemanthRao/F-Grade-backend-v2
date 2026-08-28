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

test('resolves date-only follow-ups using the previous CRM question', async () => {
  const calls = [];
  const app = createApp({ crmService: { query: async (input) => {
    calls.push(input);
    return { module: input.module, request_type: input.request_type, count: 0, data: [], pagination: { limit: input.limit, offset: input.offset, more_records: false } };
  } } });
  await requestJson(app, '/api/crm/assistant', 'POST', { conversation_id: 'follow-up-test', question: 'What is the total Amount for Closed Won Deals?' });
  const response = await requestJson(app, '/api/crm/assistant', 'POST', { conversation_id: 'follow-up-test', question: 'give me only this year' });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].module, 'Deals');
  assert.equal(calls[1].filters.some((filter) => filter.field === 'Stage' && filter.value === 'Closed Won'), true);
  assert.equal(calls[1].filters.some((filter) => filter.field === 'Created_Time'), true);
});

test('re-evaluates Closed Won follow-ups as Deals instead of adding Stage to Leads', () => {
  const { planQuestion } = require('../src/controllers/crm.controller');
  const request = planQuestion('In these 10 leads how many are Closed Won?');
  assert.equal(request.module, 'Deals');
  assert.equal(request.filters.some((filter) => filter.field === 'Stage' && filter.value === 'Closed Won'), true);
  assert.equal(request.filters.some((filter) => filter.field === 'Lead_Source'), false);
});

test('plans count and list requests as separate logical operations', () => {
  const { planQuestion } = require('../src/controllers/crm.controller');
  const request = planQuestion('Count and list all Closed Won Deals');
  assert.equal(request.module, 'Deals');
  assert.equal(request.analysis.type, 'count_and_records');
  assert.equal(request.retrieve_all, true);
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

test('routes Lead-to-Closed-Won conversion rate to Lead conversion analysis', () => {
  const { planQuestion } = require('../src/controllers/crm.controller');
  const request = planQuestion('give me the conversion rate from leads to closed won deals.');
  assert.equal(request.module, 'Leads');
  assert.equal(request.request_type, 'analysis');
  assert.deepEqual(request.analysis, { type: 'lead_closed_won_conversion' });
  assert.equal(request.filters.some((filter) => filter.field === 'Stage'), false);
  assert.equal(request.aggregate, undefined);
});

test('does not let total wording turn Lead conversion into SUM(Amount)', () => {
  const { planQuestion } = require('../src/controllers/crm.controller');
  const request = planQuestion('show the total conversion rate from leads to closed won deals');
  assert.deepEqual(request.analysis, { type: 'lead_closed_won_conversion' });
  assert.equal(request.aggregate, undefined);
});

test('plans Lead-to-Closed-Won conversion as a cross-module analysis', () => {
  const { planQuestion } = require('../src/controllers/crm.controller');
  const request = planQuestion('give me the conversion rate from leads to closed won deals');
  assert.equal(request.analysis.type, 'lead_closed_won_conversion');
  assert.equal(request.module, 'Leads');
  assert.deepEqual(request.filters, []);
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

test('plans highest-value deal requests with server-side amount sorting', () => {
  const request = require('../src/controllers/crm.controller').planQuestion('Give me the top 5 deals by amount');
  assert.equal(request.module, 'Deals');
  assert.equal(request.limit, 5);
  assert.equal(request.sort_field, 'Amount');
  assert.equal(request.sort_order, 'desc');
});

test('separates owner dimension from total deal value metric', () => {
  const request = require('../src/controllers/crm.controller').planQuestion('Show the top 3 owners by total deal value');
  assert.equal(request.module, 'Deals');
  assert.equal(request.request_type, 'analysis');
  assert.deepEqual(request.analysis, { type: 'owner_performance' });
  assert.deepEqual(request.ranking, { dimension: 'Owner', metric: 'Amount', operation: 'sum', limit: 3 });
  assert.deepEqual(request.filters, []);
});

test('plans oldest lead requests with ascending creation sorting', () => {
  const request = require('../src/controllers/crm.controller').planQuestion('Show the oldest 10 leads');
  assert.equal(request.module, 'Leads');
  assert.equal(request.limit, 10);
  assert.equal(request.sort_field, 'Created_Time');
  assert.equal(request.sort_order, 'asc');
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

test('plans monthly Closed Won deal summaries with a Closing_Date filter', () => {
  const request = require('../src/controllers/crm.controller').planQuestion('Give me a total closed won deals for this month');
  assert.equal(request.request_type, 'analysis');
  assert.equal(request.analysis.type, 'closed_won_summary');
  assert.deepEqual(request.filters, [
    { field: 'Closing_Date', operator: 'between', value: [request.filters[0].value[0], request.filters[0].value[1]] },
    { field: 'Stage', operator: 'equals', value: 'Closed Won' }
  ]);
});

test('uses Created_Time when a Deal prompt explicitly asks for created records', () => {
  const request = require('../src/controllers/crm.controller').planQuestion('Show closed won deals created this month');
  assert.equal(request.filters[0].field, 'Created_Time');
  assert.deepEqual(request.filters[0].value, ['2026-08-01', '2026-09-01']);
  assert.equal(request.filters[0].exclusive_end, true);
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
    { field: 'Created_Time', operator: 'between', value: ['2026-01-01', '2026-07-01'], exclusive_end: true },
    { field: 'Lead_Source', operator: 'is_not_null' }
  ]);
  assert.deepEqual(request.fields, ['First_Name', 'Last_Name', 'Company', 'Email', 'Lead_Status', 'Lead_Source', 'Created_Time']);
});

test('plans comprehensive multi-module sales prompts before single-module aggregates', () => {
  const request = require('../src/controllers/crm.controller').planQuestion('Analyze our 2026 sales performance: show the total number of Leads, Converted Leads, Accounts, Contacts, and Deals created during 2026; calculate the Lead conversion rate; group Leads by Lead Source and identify the top 3 sources by conversion rate while excluding sources with fewer than 10 Leads; then group Deals by Owner and show deal count, total deal value, average deal value, and Closed Won rate; identify the top 3 owners by total deal value; for each top owner, show their 3 highest-value Deals with Deal Name, Account Name, Amount, Stage, and Closing Date; finally compare the overall Lead conversion rate with the overall Deal Closed Won rate and identify the strongest Lead Source and strongest Deal Owner based on their respective conversion rates.');
  assert.equal(request.request_type, 'analysis');
  assert.equal(request.analysis.type, 'sales_performance');
  assert.equal(request.complexity, 'MULTI-STEP');
  assert.equal(request.filters[0].value[0], '2026-01-01');
  assert.equal(request.filters[0].value[1], '2027-01-01');
});

test('plans advanced Lead Source conversion ranking separately from Lead conversion', () => {
  const { planQuestion } = require('../src/controllers/crm.controller');
  const request = planQuestion('Show Leads grouped by Lead Source and rank the top 3 sources by conversion rate, excluding sources with fewer than 10 Leads');
  assert.deepEqual(request.analysis, { type: 'lead_source_conversion_report' });
  assert.equal(request.module, 'Leads');
  assert.equal(request.filters.some((filter) => filter.field === 'Lead_Source'), true);
});

test('accepts questions up to 2000 characters and rejects longer questions', async () => {
  const app = createApp({ crmService: { query: async (input) => ({ module: input.module, data: [], pagination: { limit: input.limit, offset: input.offset, more_records: false } }) } });
  const accepted = await requestJson(app, '/api/crm/assistant', 'POST', { question: 'x'.repeat(2000) });
  const rejected = await requestJson(app, '/api/crm/assistant', 'POST', { question: 'x'.repeat(2001) });
  assert.equal(accepted.status, 200);
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.code, 'QUESTION_TOO_LONG');
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
  assert.deepEqual(Object.keys(dashboard), ['title', 'description', 'type', 'kpis', 'charts', 'tables', 'filters', 'insights', 'layout']);
  assert.equal(dashboard.kpis[0].value, '10');
  assert.equal(dashboard.charts[0].type, 'horizontal_bar');
  assert.deepEqual(dashboard.charts[0].data, dashboard.tables[0].rows);
  assert.equal(dashboard.tables[1].rows[0].email, 'a@example.com');
  assert.equal(dashboard.layout[0].type, 'kpi_row');
  assert.equal(response.body.answer.startsWith('{'), true);
  assert.equal(response.body.answer.includes('|'), false);
});

test('returns an explicit dashboard empty state when CRM data is unavailable', async () => {
  const app = createApp({ crmService: { query: async () => ({ module: 'Leads', data: [], pagination: { more_records: false } }) } });
  const response = await requestJson(app, '/api/crm/assistant', 'POST', { question: 'Create a lead dashboard.' });
  const dashboard = JSON.parse(response.body.answer).dashboard;

  assert.equal(response.status, 200);
  assert.equal(dashboard.tables[0].empty_state, 'No data available for the selected request.');
  assert.deepEqual(Object.keys(dashboard), ['title', 'description', 'type', 'kpis', 'charts', 'tables', 'filters', 'insights', 'layout']);
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
  assert.deepEqual(Object.keys(request.properties), ['question', 'conversation_id']);
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

test('rejects a cross-module aggregate field before CRM execution', () => {
  const { validateModuleFieldScope } = require('../src/validators/crmQuery.validator');
  assert.throws(
    () => validateModuleFieldScope({ module: 'Leads', aggregate: { operation: 'sum', field: 'Amount' } }),
    (error) => error.code === 'INVALID_CRM_FIELD_SCOPE'
      && error.statusCode === 400
      && error.details.invalid_fields[0].path === 'aggregate.field'
      && error.details.invalid_fields[0].field === 'Amount'
  );
});

test('rejects aggregate-expression ordering before CRM execution', () => {
  const { validateAggregateQuery } = require('../src/validators/crmQuery.validator');
  assert.throws(
    () => validateAggregateQuery({
      module: 'Deals',
      fields: ['Owner', 'Amount'],
      filters: [],
      aggregate: { operation: 'sum', field: 'Amount' },
      groupBy: 'Owner',
      sort: { field: 'SUM(Amount)', order: 'desc' }
    }),
    (error) => error.code === 'INVALID_CRM_AGGREGATE_ORDER' && error.statusCode === 400
  );
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
