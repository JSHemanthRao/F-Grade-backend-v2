const test = require('node:test');
const assert = require('node:assert/strict');
const { createCrmController, planQuestion } = require('../src/controllers/crm.controller');
const { CrmService } = require('../src/services/crm.service');
const { buildCoqlQuery } = require('../src/services/coql.service');
const { createQueryIdentity } = require('../src/query/pagination');
const { execFileSync } = require('node:child_process');

function responseCapture() {
  const capture = { statusCode: null, body: null };
  return {
    capture,
    res: {
      status(code) {
        capture.statusCode = code;
        return this;
      },
      json(value) {
        capture.body = value;
        return value;
      }
    }
  };
}

function moduleMetadata(module) {
  const common = [
    { api_name: 'id', display_label: 'Record ID', data_type: 'text' },
    { api_name: 'Owner', display_label: 'Owner', data_type: 'ownerlookup' }
  ];
  if (module === 'Tasks') {
    return {
      fields: ['id', 'Subject', 'Due_Date', 'Created_Time', 'Owner'],
      metadata: [
        ...common,
        { api_name: 'Subject', display_label: 'Subject', data_type: 'text' },
        { api_name: 'Due_Date', display_label: 'Due Date', data_type: 'date' },
        { api_name: 'Created_Time', display_label: 'Created Time', data_type: 'datetime' }
      ]
    };
  }
  if (module === 'Leads') {
    return {
      fields: ['id', 'First_Name', 'Last_Name', 'Company', 'Created_Time', 'Owner'],
      metadata: [
        ...common,
        { api_name: 'First_Name', display_label: 'First Name', data_type: 'text' },
        { api_name: 'Last_Name', display_label: 'Last Name', data_type: 'text' },
        { api_name: 'Company', display_label: 'Company', data_type: 'text' },
        { api_name: 'Created_Time', display_label: 'Created Time', data_type: 'datetime' }
      ]
    };
  }
  return {
    fields: ['id', 'Deal_Name', 'Amount', 'Stage', 'Closing_Date', 'Created_Time', 'Owner'],
    metadata: [
      ...common,
      { api_name: 'Deal_Name', display_label: 'Deal Name', data_type: 'text' },
      { api_name: 'Amount', display_label: 'Amount', data_type: 'currency' },
      { api_name: 'Stage', display_label: 'Stage', data_type: 'picklist' },
      { api_name: 'Closing_Date', display_label: 'Closing Date', data_type: 'date' },
      { api_name: 'Created_Time', display_label: 'Created Time', data_type: 'datetime' }
    ]
  };
}

function createTypedDateHarness({ queryInfo = { more_records: false } } = {}) {
  const calls = [];
  const zoho = {
    executionStats: {},
    resolveModuleApiName: async (module) => module === 'Meetings' ? 'Events' : module,
    getFieldMetadata: async (module) => moduleMetadata(module),
    resolveOwnerFilters: async (filters) => filters,
    count: async (module, filters) => {
      calls.push({ type: 'count', module, filters });
      return { count: 3 };
    },
    query: async (request) => {
      calls.push({ type: 'query', request });
      const start = request.offset || 0;
      return {
        records: Array.from({ length: Math.min(request.limit || 20, 20) }, (_, index) => ({
          id: String(start + index + 1),
          Deal_Name: `Deal ${start + index + 1}`,
          First_Name: 'Asha',
          Last_Name: 'Rao',
          Company: 'Acme'
        })),
        info: queryInfo,
        module_api_name: request.module_api_name
      };
    }
  };
  return { calls, controller: createCrmController(new CrmService(zoho)), service: new CrmService(zoho) };
}

async function assistant(controller, body) {
  const { capture, res } = responseCapture();
  await controller.assistant({ method: 'POST', originalUrl: '/api/crm/assistant', body }, res, (error) => { throw error; });
  assert.equal(capture.statusCode, 200);
  return capture.body;
}

test('CRM timezone fallback is configured India semantics independent of host timezone', () => {
  const output = execFileSync(process.execPath, ['-e', `
    process.env.CRM_TIMEZONE = '';
    process.env.APPLICATION_TIMEZONE = '';
    process.env.TZ = 'UTC';
    const { env } = require('./src/config/env');
    const { DEFAULT_TIMEZONE } = require('./src/utils/relativeDate');
    process.stdout.write(JSON.stringify({ crmTimezone: env.crmTimezone, defaultTimezone: DEFAULT_TIMEZONE }));
  `], { cwd: process.cwd(), encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), { crmTimezone: 'Asia/Kolkata', defaultTimezone: 'Asia/Kolkata' });
});

test('count-to-details follow-up preserves metadata-typed DateTime filters and fingerprint', async () => {
  const { controller, calls } = createTypedDateHarness();
  const first = await assistant(controller, { conversation_id: 'date-count-details', question: 'How many deals were created today?' });
  const second = await assistant(controller, { conversation_id: 'date-count-details', question: 'give me details' });

  const countCall = calls.find((call) => call.type === 'count');
  const queryCall = calls.find((call) => call.type === 'query');
  assert.equal(countCall.module, 'Deals');
  assert.equal(queryCall.request.module, 'Deals');
  assert.equal(queryCall.request.request_type, 'records');
  assert.equal(countCall.filters[0].value_type, 'datetime');
  assert.deepEqual(queryCall.request.filters, countCall.filters);
  assert.equal(queryCall.request.filters[0].date_range.semantic, 'today');
  assert.equal(queryCall.request.filters[0].date_range.end_operator, 'less_than');
  assert.match(queryCall.request.filters[0].value[0], /^\d{4}-\d{2}-\d{2}T00:00:00[+-]\d{2}:\d{2}$/);
  assert.equal(second.diagnostics.query_fingerprint, first.diagnostics.query_fingerprint);
});

test('ordinary created-date record requests stay as records while explicit count stays count', () => {
  assert.equal(planQuestion('give me deals created today').request_type, 'records');
  assert.equal(planQuestion('show me deals created today').request_type, 'records');
  assert.equal(planQuestion('list deals created today').request_type, 'records');
  assert.equal(planQuestion('how many deals were created today?').request_type, 'count');
});

test('materializes assignment language as a metadata-typed user lookup across modules', async () => {
  const captured = [];
  const service = new CrmService({
    executionStats: {},
    resolveModuleApiName: async (module) => module,
    getFieldMetadata: async (module) => ({
      fields: ['id', 'Owner', 'Created_Time'],
      metadata: [
        { api_name: 'id', data_type: 'text' },
        { api_name: 'Owner', display_label: 'Owner', data_type: 'ownerlookup' },
        { api_name: 'Created_Time', display_label: 'Created Time', data_type: 'datetime' }
      ]
    }),
    resolveLookupFilters: async (filters) => filters.map((filter) => ({ ...filter, value: filter.value === 'John Smith' ? 'user-123' : filter.value })),
    query: async (request) => {
      captured.push(request);
      return { records: [], info: { more_records: false }, module_api_name: request.module_api_name };
    }
  });

  for (const question of ['Find all contacts assigned to John Smith.', 'Find all deals assigned to John Smith.', 'Find all tasks assigned to John Smith.']) {
    const plan = planQuestion(question);
    assert.equal(plan.request_type, 'records');
    assert.equal(plan.filters[0].field, 'Owner');
    assert.equal(plan.filters[0].value, 'John Smith');
    await service.query(plan);
  }

  for (const request of captured) {
    assert.equal(request.filters[0].field, 'Owner');
    assert.equal(request.filters[0].value_type, 'lookup');
    assert.equal(request.filters[0].lookup_target_module, 'users');
    assert.equal(request.filters[0].value, 'user-123');
  }
});

test('past month and last month remain typed date ranges with distinct semantics', () => {
  const past = planQuestion('Show all closed deals from the past month.');
  const last = planQuestion('Show all closed deals from last month.');
  assert.deepEqual(past.filters[0].value, ['2026-08-18', '2026-09-18']);
  assert.equal(past.filters[0].operator, 'between');
  assert.equal(past.filters[0].exclusive_end, true);
  assert.deepEqual(last.filters[0].value, ['2026-08-01', '2026-09-01']);
  assert.equal(last.filters[0].operator, 'between');
  assert.ok(Array.isArray(last.filters[0].value));
});

test('slash-format created-on dates become exclusive calendar ranges', () => {
  const request = planQuestion('List all deals created on 09/18/2026 with their details.');
  assert.equal(request.request_type, 'records');
  assert.deepEqual(request.filters[0], {
    field: 'Created_Time',
    operator: 'between',
    value: ['2026-09-18', '2026-09-19'],
    exclusive_end: true
  });
});

test('pagination follow-up preserves typed date filters while advancing only offset', async () => {
  const { controller, calls } = createTypedDateHarness({ queryInfo: { more_records: true } });
  const first = await assistant(controller, { conversation_id: 'date-page', question: 'List 20 lead records created this month' });
  const second = await assistant(controller, { conversation_id: 'date-page', question: 'next 20' });
  const queries = calls.filter((call) => call.type === 'query').map((call) => call.request);

  assert.equal(queries.length, 2);
  assert.equal(queries[0].module, 'Leads');
  assert.equal(queries[1].offset, 20);
  assert.deepEqual(queries[1].filters, queries[0].filters);
  assert.equal(queries[0].filters[0].value_type, 'datetime');
  assert.equal(first.diagnostics.query_fingerprint, second.diagnostics.query_fingerprint);
});

test('metadata type controls formatting independently of field name', async () => {
  const captured = [];
  const service = new CrmService({
    executionStats: {},
    resolveModuleApiName: async (module) => module,
    getFieldMetadata: async (module) => module === 'Leads'
      ? { fields: ['id', 'Created_Time'], metadata: [{ api_name: 'id', data_type: 'text' }, { api_name: 'Created_Time', display_label: 'Created Time', data_type: 'date' }] }
      : { fields: ['id', 'Closing_Date'], metadata: [{ api_name: 'id', data_type: 'text' }, { api_name: 'Closing_Date', display_label: 'Closing Date', data_type: 'datetime' }] },
    resolveOwnerFilters: async (filters) => filters,
    query: async (request) => {
      captured.push(request);
      return { records: [], info: { more_records: false }, module_api_name: request.module_api_name };
    }
  });

  await service.query({ module: 'Leads', fields: ['id'], filters: [{ field: 'Created_Time', operator: 'between', value: ['2026-09-18', '2026-09-19'], exclusive_end: true }] });
  await service.query({ module: 'Deals', fields: ['id'], filters: [{ field: 'Closing_Date', operator: 'between', value: ['2026-09-18', '2026-09-19'], exclusive_end: true }] });

  assert.deepEqual(captured[0].filters[0].value, ['2026-09-18', '2026-09-19']);
  assert.equal(captured[0].filters[0].value_type, 'date');
  assert.deepEqual(captured[1].filters[0].value, ['2026-09-18T00:00:00+05:30', '2026-09-19T00:00:00+05:30']);
  assert.equal(captured[1].filters[0].value_type, 'datetime');
});

test('typed semantic Date and DateTime filters generate correct COQL operators', () => {
  const datetimePlan = {
    module: 'Leads',
    fields: ['id'],
    filters: [{ field: 'Created_Time', operator: 'between', value: ['2026-09-18', '2026-09-19'], exclusive_end: true, value_type: 'datetime' }]
  };
  const datePlan = {
    module: 'Deals',
    fields: ['id', 'Closing_Date'],
    filters: [{ field: 'Closing_Date', operator: 'between', value: ['2026-09-18', '2026-09-18'], value_type: 'date' }]
  };

  assert.equal(buildCoqlQuery(datetimePlan), "select id from Leads where (Created_Time >= '2026-09-18T00:00:00+05:30' and Created_Time < '2026-09-19T00:00:00+05:30')");
  assert.equal(buildCoqlQuery(datePlan), "select id, Closing_Date from Deals where (Closing_Date >= '2026-09-18' and Closing_Date <= '2026-09-18')");
});

test('metadata-validated plans can select live Zoho fields outside static module constants', () => {
  const query = buildCoqlQuery({
    module: 'Deals',
    fields: ['Deal_Name', 'Invoice_Number', 'Ad_Campaign_Name', 'Created_Time'],
    filters: [{ field: 'Created_Time', operator: 'between', value: ['2026-09-18', '2026-09-19'], exclusive_end: true, value_type: 'datetime' }],
    metadata_validated: true
  });

  assert.equal(query, "select Deal_Name, Invoice_Number, Ad_Campaign_Name, Created_Time from Deals where (Created_Time >= '2026-09-18T00:00:00+05:30' and Created_Time < '2026-09-19T00:00:00+05:30')");
});

test('count and record plans share one selection fingerprint when only retrieval mode changes', async () => {
  const { service } = createTypedDateHarness();
  const count = await service.query(planQuestion('How many deals were created today?'));
  const records = await service.query({ ...planQuestion('How many deals were created today?'), request_type: 'records', intent: 'records', fields: ['id'], aggregate: null });

  assert.equal(createQueryIdentity(count), createQueryIdentity(records));
});
