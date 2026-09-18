const test = require('node:test');
const assert = require('node:assert/strict');
const { planQuestion, createCrmController } = require('../src/controllers/crm.controller');
const { CrmService } = require('../src/services/crm.service');
const { validateCrmQuery } = require('../src/validators/crmQuery.validator');
const { createCrmDiagnostics } = require('../src/utils/crmDiagnostics');
const { buildCoqlQuery, buildLogicalFilterClause } = require('../src/services/coql.service');

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
  assert.equal(request.module_api_name, undefined);
  assert.deepEqual(request.comparison, { current_period: 'today', previous_period: 'yesterday', date_field: 'Created_Time', operation: 'count', field: 'id' });
  assert.equal(request.date_range.current.period, 'today');
  assert.equal(request.date_range.previous.period, 'yesterday');
});

test('plans COUNT, SUM, and AVG comparisons', () => {
  assert.equal(planQuestion('Compare leads this month vs last month').aggregate.operation, 'count');
  assert.deepEqual(planQuestion("Compare total deal value this month vs last month").aggregate, { operation: 'sum', field: 'amount' });
  assert.deepEqual(planQuestion('Compare average deal amount this quarter vs last quarter').aggregate, { operation: 'avg', field: 'amount' });
});

test('plans all requested numeric comparison operators', () => {
  const cases = [['>', 'greater_than'], ['>=', 'greater_equal'], ['<', 'less_than'], ['<=', 'less_equal'], ['=', 'equals'], ['!=', 'not_equals']];
  for (const [symbol, operator] of cases) {
    const request = planQuestion(`Show deals with Amount ${symbol} 1000`);
    assert.equal(request.filters.find((filter) => filter.field === 'amount').operator, operator);
  }
});

test('plans numeric between filters without inventing a field name', () => {
  const request = planQuestion('Show me deals where the amount is between 50000 and 100000');
  assert.deepEqual(request.filters.find((filter) => filter.operator === 'between'), { field: 'amount', operator: 'between', value: [50000, 100000] });
  assert.ok(!request.filters.some((filter) => /^(semantic|the amount)$/.test(filter.field)));
});

test('does not add a generic semantic filter to numeric comparisons', () => {
  const request = planQuestion('Show me deals where the amount is greater than 50000');
  assert.deepEqual(request.filters, [{ field: 'Amount', operator: 'greater_than', value: 50000 }]);
});

test('preserves an explicit Leads module for Closed Won questions', () => {
  const request = planQuestion('Show me leads that are Closed Won');
  assert.equal(request.module, 'Leads');
});

test('plans exclusions as NOT IN and supports multi-field sorting', () => {
  const request = planQuestion('Show deals excluding stage Closed Lost or Prospect, sort by amount descending then created newest');
  assert.deepEqual(request.filters.find((filter) => filter.operator === 'not_in'), { field: 'Stage', operator: 'not_in', value: ['closed lost', 'prospect'] });
  assert.deepEqual(request.sort, [{ field: 'amount', order: 'desc' }, { field: 'created', order: 'desc' }]);
});

test('plans grouped total deal amount as a SUM grouped by Stage', () => {
  const request = planQuestion('show me total deal amount grouped by stage');
  assert.equal(request.module, 'Deals');
  assert.equal(request.request_type, 'aggregate');
  assert.deepEqual(request.aggregate, { operation: 'sum', field: 'amount' });
  assert.equal(request.group_by, 'Stage');
});

test('does not interpret grouped-by wording as an owner filter', () => {
  const request = planQuestion('show me total deal amount grouped by stage and calculate total Amount');
  assert.deepEqual(request.aggregate, { operation: 'sum', field: 'amount' });
  assert.equal(request.group_by, 'Stage');
  assert.deepEqual(request.filters, []);
});

test('builds advanced COQL with NOT IN, multi-sort, and HAVING', () => {
  const query = buildCoqlQuery({
    module: 'Deals',
    fields: ['Owner', 'Amount'],
    filters: [{ field: 'Stage', operator: 'not_in', value: ['Closed Lost', 'Prospecting'] }],
    sort: [{ field: 'Amount', order: 'desc' }, { field: 'Owner', order: 'asc' }],
    having_filter: { field: 'Amount', operator: 'greater_than', value: 50000 }
  });
  assert.equal(query, "select Owner, Amount from Deals where (Stage not in ('Closed Lost', 'Prospecting')) order by Amount desc, Owner asc having (Amount > 50000)");
});

test('preserves nested AND, OR, and NOT filter logic', () => {
  const expression = {
    operator: 'AND',
    conditions: [
      { operator: 'OR', conditions: [
        { field: 'Stage', operator: 'equals', value: 'Closed Won' },
        { field: 'Stage', operator: 'equals', value: 'Negotiation' }
      ] },
      { operator: 'NOT', conditions: [{ field: 'Amount', operator: 'less_than', value: 0 }] }
    ]
  };
  assert.equal(buildLogicalFilterClause(expression), "(((Stage = 'Closed Won') or (Stage = 'Negotiation')) and (not (Amount < 0)))");
  assert.doesNotThrow(() => validateCrmQuery({ module: 'Deals', fields: ['id'], filter_expression: expression }));
});

test('rejects Books questions instead of routing them through CRM', () => {
  assert.throws(() => planQuestion('Show me Zoho Books invoices'), (error) => error.code === 'DOMAIN_AMBIGUOUS');
});

test('validates BETWEEN, IS NULL, and IS NOT NULL filters', () => {
  assert.equal(validateCrmQuery({ module: 'Leads', filters: [{ field: 'Created_Time', operator: 'between', value: ['2026-01-01', '2026-02-01'] }] }).filters[0].operator, 'between');
  assert.equal(validateCrmQuery({ module: 'Leads', filters: [{ field: 'Email', operator: 'is_null' }] }).filters[0].operator, 'is_null');
  assert.equal(validateCrmQuery({ module: 'Leads', filters: [{ field: 'Email', operator: 'is_not_null' }] }).filters[0].operator, 'is_not_null');
});

test('normalizes relative creation dates without adding a null filter', () => {
  for (const module of ['Leads', 'Deals', 'Contacts', 'Accounts', 'Tasks', 'Calls', 'Meetings', 'Products']) {
    const request = planQuestion(`show me ${module.toLowerCase()} created this month`);
    assert.equal(request.filters.length, 1);
    assert.equal(request.filters[0].operator, 'between');
    assert.equal(request.filters[0].exclusive_end, true);
    assert.equal(request.filters.some((filter) => filter.operator === 'is_not_null'), false);
  }
});

test('recognizes empty and not-empty requests as unary filters', () => {
  const notEmpty = planQuestion('show me leads where created time is not empty');
  const empty = planQuestion('show me leads where created time is empty');
  assert.deepEqual(notEmpty.filters[0], { field: '__field__', field_label: 'created time', operator: 'is_not_null' });
  assert.deepEqual(empty.filters[0], { field: '__field__', field_label: 'created time', operator: 'is_null' });
  assert.doesNotThrow(() => validateCrmQuery({ module: 'Leads', fields: ['id'], filters: [{ field: 'Created_Time', operator: 'is_not_empty' }] }));
  assert.throws(() => validateCrmQuery({ module: 'Leads', fields: ['id'], filters: [{ field: 'Created_Time', operator: 'is_not_null', value: 'unexpected' }] }), /must not include a value/);
});

test('normalizes implicit lakh amount ranges and preserves descending sort', () => {
  const request = planQuestion('show me deals between 50000 and 2 lakh sorted from highest to lowest');
  assert.deepEqual(request.filters, [{ field: 'amount', operator: 'between', value: [50000, 200000] }]);
  assert.deepEqual({ field: request.sort_field, order: request.sort_order }, { field: 'amount', order: 'desc' });
  assert.equal(buildCoqlQuery({
    module: 'Deals',
    fields: ['id', 'Amount'],
    filters: [{ field: 'Amount', operator: 'greater_equal', value: 50000 }, { field: 'Amount', operator: 'less_equal', value: 200000 }],
    sort: { field: 'Amount', order: 'desc' }
  }), "select id, Amount from Deals where ((Amount >= 50000) and (Amount <= 200000)) order by Amount desc");
});

test('materializes unary filters without reintroducing a value', async () => {
  let captured;
  const service = new CrmService({
    resolveModuleApiName: async () => 'Leads',
    getFieldMetadata: async () => ({
      fields: ['id', 'Created_Time'],
      metadata: [
        { api_name: 'id', data_type: 'text' },
        { api_name: 'Created_Time', display_label: 'Created Time', data_type: 'datetime', filterable: true, sortable: true }
      ]
    }),
    resolveOwnerFilters: async (filters) => filters,
    query: async (request) => {
      captured = request;
      return { records: [], info: { more_records: false }, module_api_name: 'Leads' };
    }
  });
  await service.query({ module: 'Leads', fields: ['id'], filters: [{ field: 'Created_Time', operator: 'is_not_null' }], limit: 20, offset: 0 });
  assert.equal(Object.prototype.hasOwnProperty.call(captured.filters[0], 'value'), false);
});

test('builds valid unary and date-range COQL', () => {
  assert.equal(buildCoqlQuery({ module: 'Leads', fields: ['id'], filters: [{ field: 'Created_Time', operator: 'is_not_null' }] }), 'select id from Leads where (Created_Time is not null)');
  assert.equal(buildCoqlQuery({ module: 'Leads', fields: ['id'], filters: [{ field: 'Created_Time', operator: 'between', value: ['2026-09-01', '2026-10-01'], exclusive_end: true, value_type: 'datetime' }] }), "select id from Leads where (Created_Time >= '2026-09-01T00:00:00+05:30' and Created_Time < '2026-10-01T00:00:00+05:30')");
});

test('plans today deals with a negated Stage filter and created-date filter', () => {
  const request = planQuestion("show me today's deals where the stage is not Closed Lost, sorted by amount from highest to lowest");
  assert.equal(request.module, 'Deals');
  assert.equal(request.request_type, 'records');
  assert.equal(request.sort_field, 'amount');
  assert.equal(request.sort_order, 'desc');
  assert.equal(request.filters.find((filter) => filter.field === 'Created_Time')?.operator, 'between');
  assert.deepEqual(request.filters.find((filter) => filter.field === 'Stage'), { field: 'Stage', operator: 'not_equals', value: 'closed lost' });
  assert.ok(!request.filters.some((filter) => ['__semantic__', 'semantic'].includes(filter.field)));
});

test('routes today activity history through the CRM audit-log analysis path', () => {
  const request = planQuestion("today's activity?");
  assert.equal(request.module, 'CRM');
  assert.equal(request.activity_type, 'ACTIVITY_HISTORY');
  assert.deepEqual(request.analysis, { type: 'today_activity', activity_type: 'ACTIVITY_HISTORY' });
});

test('does not reject activity history as an explicit Tasks module', async () => {
  let captured;
  const controller = createCrmController({
    query: async (input) => {
      captured = input;
      return { module: 'CRM', request_type: 'analysis', data: [], pagination: { limit: input.limit, offset: input.offset, returned: 0, more_records: false } };
    }
  });
  const response = () => ({ status: () => ({ json: (value) => value }), json: (value) => value });
  await controller.assistant({ body: { conversation_id: 'activity-history-routing', question: "today's activity?" } }, response(), (error) => { throw error; });
  assert.equal(captured.module, 'CRM');
  assert.equal(captured.activity_type, 'ACTIVITY_HISTORY');
});

test('routes today activity including tasks, calls, and meetings as one CRM activity request', async () => {
  let captured;
  const controller = createCrmController({
    query: async (input) => {
      captured = input;
      return { module: 'CRM', request_type: 'analysis', analysis: 'today_activity', data: [], pagination: { limit: input.limit, offset: input.offset, returned: 0, more_records: false } };
    }
  });
  const response = () => ({ status: () => ({ json: (value) => value }), json: (value) => value });
  await controller.assistant({ body: { question: "Show me today's activity including tasks, calls, and meetings for today 09/16/2026" } }, response(), (error) => { throw error; });
  assert.equal(captured.module, 'CRM');
  assert.equal(captured.activity_type, 'SCHEDULED_ACTIVITY');
  assert.deepEqual(captured.analysis, { type: 'today_activity', activity_type: 'SCHEDULED_ACTIVITY' });
});

test('resolves today deal fields only from live metadata before Zoho execution', async () => {
  let captured;
  const diagnostics = createCrmDiagnostics('crm_field_resolution_test');
  const service = new CrmService({
    executionStats: {},
    resolveModuleApiName: async () => 'Deals',
    getFieldMetadata: async () => ({
      fields: ['id', 'deal_created_at__c', 'deal_stage__c', 'total_value__c'],
      metadata: [
        { api_name: 'id', display_label: 'Record ID', data_type: 'text' },
        { api_name: 'deal_created_at__c', display_label: 'Created Time', data_type: 'datetime' },
        { api_name: 'deal_stage__c', display_label: 'Stage', data_type: 'picklist', pick_list_values: [{ display_value: 'Closed Lost', actual_value: 'closed_lost' }] },
        { api_name: 'total_value__c', display_label: 'Amount', data_type: 'currency' }
      ]
    }),
    resolveOwnerFilters: async (filters) => filters,
    query: async (request) => {
      captured = request;
      return { records: [], info: { more_records: false }, module_api_name: request.module_api_name };
    }
  });

  await service.query(planQuestion("Show me today's deals where the stage is not Closed Lost, sorted by amount from highest to lowest"), undefined, diagnostics);

  assert.equal(captured.module_api_name, 'Deals');
  assert.equal(captured.sort.field, 'total_value__c');
  assert.equal(captured.sort.order, 'desc');
  assert.deepEqual(captured.filters, [
    { field: 'deal_created_at__c', operator: 'between', value: captured.filters[0].value, exclusive_end: true, date_range: captured.filters[0].date_range, value_type: 'datetime' },
    { field: 'deal_stage__c', operator: 'not_equals', value: 'closed lost' }
  ]);
  assert.equal(captured.filters[0].date_range.field_type, 'datetime');
  assert.match(captured.filters[0].value[0], /^\d{4}-\d{2}-\d{2}T00:00:00[+-]\d{2}:\d{2}$/);
  assert.ok(captured.filters.every((filter) => !['semantic', 'the closing_date', 'closing_date', 'closing date', 'the stage', 'the amount'].includes(filter.field)));
  assert.deepEqual(diagnostics.resolved_fields, [
    { user_term: 'id', field_label: 'Record ID', api_name: 'id', data_type: 'text' },
    { user_term: 'Created_Time', field_label: 'Created Time', api_name: 'deal_created_at__c', data_type: 'datetime' },
    { user_term: 'Stage', field_label: 'Stage', api_name: 'deal_stage__c', data_type: 'picklist' },
    { user_term: 'amount', field_label: 'Amount', api_name: 'total_value__c', data_type: 'currency' }
  ]);
});

test('executes normalized count and SUM comparisons with zero-safe percentage changes', async () => {
  let countCalls = 0;
  const zoho = {
    executionStats: {},
    resolveModuleApiName: async (module) => ({ Leads: 'Leads', Deals: 'Deals' })[module] || module,
    getFieldMetadata: async () => ({ fields: ['id', 'Created_Time', 'Amount'], metadata: [
      { api_name: 'id', display_label: 'Record ID', data_type: 'text' },
      { api_name: 'Created_Time', display_label: 'Created Time', data_type: 'datetime' },
      { api_name: 'Amount', display_label: 'Amount', data_type: 'currency' }
    ] }),
    resolveOwnerFilters: async (filters) => filters,
    count: async () => ({ count: ++countCalls === 2 ? 12 : 0 }),
    aggregate: async () => ({ rows: [{ value: 50 }] })
  };
  const service = new CrmService(zoho);
  const countResult = await service.query(planQuestion('Compare leads created today vs yesterday'));
  assert.deepEqual(countResult.comparison, { current_period: 'today', previous_period: 'yesterday', current_value: 0, previous_value: 12, difference: -12, percentage_change: -100, direction: 'decreased' });
  const sumResult = await service.query(planQuestion('Compare total deal value this month vs last month'));
  assert.equal(sumResult.request_type, 'comparison');
  assert.equal(sumResult.comparison.difference, 0);
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

test('advances the exact module offset for next-page follow-ups', async () => {
  const calls = [];
  const controller = createCrmController({ query: async (input) => { calls.push(input); return { module: input.module, request_type: input.request_type, more_records: true, data: Array.from({ length: 10 }, (_, index) => ({ id: String((input.offset || 0) + index + 1) })) }; } });
  const response = (body) => ({ status: () => ({ json: (value) => value }), json: (value) => value });
  await controller.assistant({ body: { conversation_id: 'pagination-follow-up', question: 'Show me 10 products' } }, response({}), (error) => { throw error; });
  await controller.assistant({ body: { conversation_id: 'pagination-follow-up', question: 'next 10' } }, response({}), (error) => { throw error; });
  assert.equal(calls[1].module, 'Products');
  assert.equal(calls[1].limit, 10);
  assert.equal(calls[1].offset, 10);
});

test('paginates every supported record module through the same continuation path', async () => {
  const modules = ['Deals', 'Leads', 'Contacts', 'Accounts', 'Calls', 'Meetings', 'Tasks', 'Products', 'Quotes', 'SalesOrders', 'PurchaseOrders', 'Invoices'];
  const calls = [];
  const controller = createCrmController({
    query: async (input) => {
      calls.push({ ...input, filters: input.filters?.map((filter) => ({ ...filter })), sort: input.sort });
      const offset = input.offset || 0;
      return {
        module: input.module,
        request_type: input.request_type,
        filters: input.filters,
        data: Array.from({ length: 2 }, (_, index) => ({ id: `${input.module}-${offset + index + 1}` })),
        pagination: { limit: input.limit, offset, returned: 2, more_records: true }
      };
    }
  });
  const response = () => ({ status: () => ({ json: (value) => value }), json: (value) => value });

  for (const [index, module] of modules.entries()) {
    const conversationId = `pagination-matrix-${index}`;
    await controller.assistant({ body: { conversation_id: conversationId, question: `show me ${module}` } }, response(), (error) => { throw error; });
    await controller.assistant({ body: { conversation_id: conversationId, question: `give me next 20 ${module}` } }, response(), (error) => { throw error; });
    await controller.assistant({ body: { conversation_id: conversationId, question: 'next page' } }, response(), (error) => { throw error; });
  }

  for (let index = 0; index < modules.length; index += 1) {
    const moduleCalls = calls.slice(index * 3, index * 3 + 3);
    assert.equal(moduleCalls[0].module, moduleCalls[1].module);
    assert.equal(moduleCalls[1].module, moduleCalls[2].module);
    assert.ok(moduleCalls[0].module);
    assert.deepEqual(moduleCalls.map((call) => call.offset), [0, 2, 4]);
  }
});

test('preserves non-Deals filters and sorts through generic pagination', async () => {
  const calls = [];
  const controller = createCrmController({
    query: async (input) => {
      calls.push(input);
      return {
        module: input.module,
        request_type: input.request_type,
        data: Array.from({ length: 3 }, (_, index) => ({ id: String((input.offset || 0) + index + 1) })),
        pagination: { limit: input.limit, offset: input.offset, returned: 3, more_records: true }
      };
    }
  });
  const response = () => ({ status: () => ({ json: (value) => value }), json: (value) => value });

  await controller.assistant({ body: { conversation_id: 'pagination-leads-filtered', question: 'show me leads created this month sorted by created newest' } }, response(), (error) => { throw error; });
  await controller.assistant({ body: { conversation_id: 'pagination-leads-filtered', question: 'next 50 leads' } }, response(), (error) => { throw error; });

  assert.equal(calls[0].module, 'Leads');
  assert.equal(calls[1].module, 'Leads');
  assert.equal(calls[1].offset, 3);
  assert.equal(calls[1].limit, 50);
  assert.deepEqual(calls[1].filters, calls[0].filters);
  assert.deepEqual(calls[1].sort, calls[0].sort);
});

test('keeps pagination state isolated across conversations and modules', async () => {
  const calls = [];
  const controller = createCrmController({
    query: async (input) => {
      calls.push(input);
      return {
        module: input.module,
        data: Array.from({ length: 4 }, (_, index) => ({ id: `${input.module}-${(input.offset || 0) + index}` })),
        pagination: { limit: input.limit, offset: input.offset, returned: 4, more_records: true }
      };
    }
  });
  const response = () => ({ status: () => ({ json: (value) => value }), json: (value) => value });

  await controller.assistant({ body: { conversation_id: 'conversation-a', question: 'show me deals' } }, response(), (error) => { throw error; });
  await controller.assistant({ body: { conversation_id: 'conversation-b', question: 'show me leads' } }, response(), (error) => { throw error; });
  await controller.assistant({ body: { conversation_id: 'conversation-a', question: 'next 20' } }, response(), (error) => { throw error; });
  await controller.assistant({ body: { conversation_id: 'conversation-b', question: 'next 20' } }, response(), (error) => { throw error; });

  assert.deepEqual(calls.map((call) => [call.module, call.offset]), [['Deals', 0], ['Leads', 0], ['Deals', 4], ['Leads', 4]]);
});

test('advances conversational pagination when the follow-up repeats the module name', async () => {
  const calls = [];
  const pages = [];
  const controller = createCrmController({
    query: async (input) => {
      calls.push(input);
      const offset = input.offset || 0;
      const data = Array.from({ length: 20 }, (_, index) => ({ id: String(offset + index + 1) }));
      pages.push(data);
      return {
        module: input.module,
        request_type: input.request_type,
        returned: 20,
        more_records: true,
        data
      };
    }
  });
  const response = () => ({ status: () => ({ json: (value) => value }), json: (value) => value });

  await controller.assistant({ body: { conversation_id: 'pagination-module-follow-up', question: 'show me deals' } }, response(), (error) => { throw error; });
  await controller.assistant({ body: { conversation_id: 'pagination-module-follow-up', question: 'give me next 20 deals' } }, response(), (error) => { throw error; });
  await controller.assistant({ body: { conversation_id: 'pagination-module-follow-up', question: 'give me next 20 deals' } }, response(), (error) => { throw error; });

  assert.deepEqual(calls.map((call) => call.offset), [0, 20, 40]);
  assert.equal(new Set(pages[0].map((record) => record.id).concat(pages[1].map((record) => record.id))).size, 40);
  assert.equal(new Set(pages[1].map((record) => record.id).concat(pages[2].map((record) => record.id))).size, 40);
});

test('accepts Copilot conversation ID aliases for pagination state', async () => {
  const calls = [];
  const controller = createCrmController({
    query: async (input) => {
      calls.push(input);
      return { module: input.module, request_type: input.request_type, returned: 1, more_records: true, data: [{ id: String(input.offset || 0) }] };
    }
  });
  const response = () => ({ status: () => ({ json: (value) => value }), json: (value) => value });

  await controller.assistant({ body: { conversationId: 'copilot-alias', question: 'show me deals' }, get: () => null }, response(), (error) => { throw error; });
  await controller.assistant({ body: { conversationId: 'copilot-alias', question: 'next batch' }, get: () => null }, response(), (error) => { throw error; });

  assert.deepEqual(calls.map((call) => call.offset), [0, 1]);
});

test('keeps canonical filters and sort while advancing proceed pagination', async () => {
  const calls = [];
  const controller = createCrmController({
    query: async (input) => {
      calls.push(input);
      const start = input.offset || 0;
      return {
        module: input.module,
        request_type: input.request_type,
        returned: 20,
        more_records: true,
        data: Array.from({ length: 20 }, (_, index) => ({ id: String(start + index + 1) }))
      };
    }
  });
  const response = () => ({ status: () => ({ json: (value) => value }), json: (value) => value });

  await controller.assistant({ body: { conversation_id: 'pagination-canonical', question: 'Show me deals between 50000 and 200000 sorted from highest to lowest.' } }, response(), (error) => { throw error; });
  await controller.assistant({ body: { conversation_id: 'pagination-canonical', question: 'proceed' } }, response(), (error) => { throw error; });
  await controller.assistant({ body: { conversation_id: 'pagination-canonical', question: 'proceed' } }, response(), (error) => { throw error; });

  assert.equal(calls[0].module, 'Deals');
  assert.equal(calls[0].offset, 0);
  assert.equal(calls[1].offset, 20);
  assert.equal(calls[2].offset, 40);
  assert.deepEqual(calls[0].filters, calls[1].filters);
  assert.deepEqual(calls[0].sort, calls[1].sort);
  assert.equal(calls[1].limit, 20);
  assert.equal(calls[2].limit, 20);
});

test('supports explicit page numbers with a stable offset calculation', async () => {
  const calls = [];
  const controller = createCrmController({ query: async (input) => { calls.push(input); return { module: input.module, request_type: input.request_type, returned: 20, more_records: true, data: [] }; } });
  const response = () => ({ status: () => ({ json: (value) => value }), json: (value) => value });
  await controller.assistant({ body: { conversation_id: 'pagination-pages', question: 'Show me deals' } }, response(), (error) => { throw error; });
  await controller.assistant({ body: { conversation_id: 'pagination-pages', question: 'page 4' } }, response(), (error) => { throw error; });
  assert.equal(calls[1].offset, 60);
  assert.equal(calls[1].limit, 20);
});

test('advances offset by the actual returned count on follow-up pagination', async () => {
  const calls = [];
  const controller = createCrmController({
    query: async (input) => {
      calls.push(input);
      return {
        module: input.module,
        request_type: input.request_type,
        returned: input.offset === 0 ? 10 : 10,
        more_records: true,
        data: Array.from({ length: 10 }, (_, index) => ({ id: String(input.offset + index + 1) }))
      };
    }
  });
  const response = () => ({ status: () => ({ json: (value) => value }), json: (value) => value });

  await controller.assistant({ body: { conversation_id: 'pagination-returned-count', question: 'Show me deals' } }, response(), (error) => { throw error; });
  await controller.assistant({ body: { conversation_id: 'pagination-returned-count', question: 'next 20' } }, response(), (error) => { throw error; });

  assert.equal(calls[1].offset, 10);
  assert.equal(calls[1].limit, 20);
});

test('advances from the actual short page length instead of requested limit', async () => {
  const calls = [];
  const controller = createCrmController({
    query: async (input) => {
      calls.push(input);
      const returned = input.offset === 40 ? 7 : 20;
      return {
        module: input.module,
        request_type: input.request_type,
        more_records: true,
        data: Array.from({ length: returned }, (_, index) => ({ id: String(input.offset + index + 1) }))
      };
    }
  });
  const response = () => ({ status: () => ({ json: (value) => value }), json: (value) => value });
  await controller.assistant({ body: { conversation_id: 'pagination-short-page', question: 'show me deals' } }, response(), (error) => { throw error; });
  await controller.assistant({ body: { conversation_id: 'pagination-short-page', question: 'next 20' } }, response(), (error) => { throw error; });
  await controller.assistant({ body: { conversation_id: 'pagination-short-page', question: 'next 20' } }, response(), (error) => { throw error; });
  await controller.assistant({ body: { conversation_id: 'pagination-short-page', question: 'next 20' } }, response(), (error) => { throw error; });
  assert.deepEqual(calls.map((call) => call.offset), [0, 20, 40, 47]);
});

test('requires stable conversation state for pagination continuations', async () => {
  const calls = [];
  const controller = createCrmController({ query: async (input) => { calls.push(input); return { module: input.module, data: [], pagination: { limit: input.limit, offset: input.offset, returned: 0, more_records: true } }; } });
  const response = () => ({ status: (code) => ({ json: (value) => ({ code, value }) }), json: (value) => value });
  let error;
  await controller.assistant({ body: { question: 'give me next 20 deals' }, get: () => null }, response(), (received) => { error = received; });
  assert.equal(error.code, 'PAGINATION_CONVERSATION_REQUIRED');
  assert.equal(calls.length, 0);
});

test('does not repeat a page when the previous page is exhausted', async () => {
  const calls = [];
  const controller = createCrmController({
    query: async (input) => {
      calls.push(input);
      return { module: input.module, data: [{ id: 'only-record' }], pagination: { limit: input.limit, offset: input.offset, returned: 1, more_records: false } };
    }
  });
  const response = () => ({ status: () => ({ json: (value) => value }), json: (value) => value });
  await controller.assistant({ body: { conversation_id: 'pagination-exhausted', question: 'show me deals' } }, response(), (error) => { throw error; });
  let error;
  await controller.assistant({ body: { conversation_id: 'pagination-exhausted', question: 'next 20' } }, response(), (received) => { error = received; });
  assert.equal(error.code, 'PAGINATION_EXHAUSTED');
  assert.equal(calls.length, 1);
});

test('recognizes show me the next page as a continuation', async () => {
  const calls = [];
  const controller = createCrmController({
    query: async (input) => {
      calls.push(input);
      return { module: input.module, data: Array.from({ length: 20 }, (_, index) => ({ id: String((input.offset || 0) + index) })), pagination: { limit: input.limit, offset: input.offset, returned: 20, more_records: true } };
    }
  });
  const response = () => ({ status: () => ({ json: (value) => value }), json: (value) => value });
  await controller.assistant({ body: { conversation_id: 'pagination-next-page', question: 'show me deals' } }, response(), (error) => { throw error; });
  await controller.assistant({ body: { conversation_id: 'pagination-next-page', question: 'show me the next page' } }, response(), (error) => { throw error; });
  assert.equal(calls[1].offset, 20);
});

test('resets pagination when the query shape changes', async () => {
  const calls = [];
  const controller = createCrmController({ query: async (input) => { calls.push(input); return { module: input.module, request_type: input.request_type, returned: 20, more_records: true, data: Array.from({ length: 20 }, (_, index) => ({ id: String((input.offset || 0) + index + 1) })) }; } });
  const response = () => ({ status: () => ({ json: (value) => value }), json: (value) => value });
  await controller.assistant({ body: { conversation_id: 'pagination-reset', question: 'Show me deals above 50000' } }, response(), (error) => { throw error; });
  await controller.assistant({ body: { conversation_id: 'pagination-reset', question: 'Show me leads' } }, response(), (error) => { throw error; });
  await controller.assistant({ body: { conversation_id: 'pagination-reset', question: 'next 20' } }, response(), (error) => { throw error; });
  assert.equal(calls[1].module, 'Leads');
  assert.equal(calls[1].offset, 0);
  assert.equal(calls[2].module, 'Leads');
  assert.equal(calls[2].offset, 20);
});

test('adds a stable id sort when the primary sort is not unique', async () => {
  const { ZohoCrmService } = require('../src/services/zohoCrm.service');
  const zoho = new ZohoCrmService();
  zoho.authService = { getAccessToken: async () => 'token', getApiDomain: () => 'https://example.com' };
  zoho.resolveModuleApiName = async () => 'Deals';
  zoho.getFieldMetadata = async () => ({ fields: ['id', 'Amount'], metadata: [{ api_name: 'id', data_type: 'text' }, { api_name: 'Amount', data_type: 'currency' }] });
  zoho.getCoqlSafeFields = async () => ['id', 'Amount'];
  let selectQuery;
  zoho.executeRequest = async (_method, _url, options) => {
    selectQuery = options.data.select_query;
    return { data: { data: [], info: { more_records: false } } };
  };

  await zoho.query({ module: 'Deals', fields: ['Amount'], sort: { field: 'Amount', order: 'desc' }, limit: 20, offset: 0 });
  assert.match(selectQuery, /order by Amount desc, id desc limit 0, 20$/);
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

test('uses the Calls activity timestamp and Products price semantic term', () => {
  const calls = planQuestion("Show me today's calls");
  const products = planQuestion('Show me products created this month, sorted by price from highest to lowest');
  assert.equal(calls.filters[0].field, 'Call_Start_Time');
  assert.equal(products.module, 'Products');
  assert.equal(products.sort_field, 'price');
  assert.notEqual(products.sort_field, 'Amount');
});

test('resolves a custom field label against the selected module metadata', async () => {
  let captured;
  const service = new CrmService({
    executionStats: {},
    resolveModuleApiName: async (module) => module === 'Leads' ? 'Leads' : module,
    getFieldMetadata: async () => ({
      fields: ['id', 'Customer_Priority__s', 'Created_Time'],
      metadata: [
        { api_name: 'id', display_label: 'Record ID', data_type: 'text' },
        { api_name: 'Customer_Priority__s', display_label: 'Customer Priority', data_type: 'picklist' },
        { api_name: 'Created_Time', display_label: 'Created Time', data_type: 'datetime' }
      ]
    }),
    resolveOwnerFilters: async (filters) => filters,
    query: async (request) => { captured = request; return { records: [], info: { more_records: false }, module_api_name: request.module_api_name }; }
  });

  await service.query(planQuestion('Show leads where customer priority is high'));
  assert.equal(captured.module, 'Leads');
  assert.equal(captured.filters[0].field, 'Customer_Priority__s');
  assert.equal(captured.filters[0].value, 'high');
});

test('compares Calls and Meetings with independent module requests', async () => {
  const counts = { Calls: 15, Events: 8 };
  const requests = [];
  const service = new CrmService({
    executionStats: {},
    resolveModuleApiName: async (module) => module === 'Meetings' ? 'Events' : module,
    getFieldMetadata: async (module) => ({
      fields: ['id', module === 'Calls' ? 'Call_Start_Time' : 'Start_DateTime'],
      metadata: [{ api_name: 'id', data_type: 'text' }, { api_name: module === 'Calls' ? 'Call_Start_Time' : 'Start_DateTime', data_type: 'datetime' }]
    }),
    resolveOwnerFilters: async (filters) => filters,
    count: async (module, filters) => { requests.push({ module, filters }); return { count: counts[module] || 0 }; }
  });

  const result = await service.query(planQuestion('Compare calls and meetings this week'));
  assert.equal(result.comparison.Calls, 15);
  assert.equal(result.comparison.Meetings, 8);
  assert.equal(result.comparison.difference, 7);
  assert.deepEqual(requests.map((request) => request.module).sort(), ['Calls', 'Events']);
});

test('resolves task due dates from live field metadata', async () => {
  let captured;
  const service = new CrmService({
    executionStats: {},
    resolveModuleApiName: async () => 'Tasks',
    getFieldMetadata: async () => ({
      fields: ['id', 'Subject', 'Created_Time', 'Due_Date'],
      metadata: [
        { api_name: 'id', data_type: 'text' },
        { api_name: 'Subject', data_type: 'text' },
        { api_name: 'Created_Time', data_type: 'datetime' },
        { api_name: 'Due_Date', data_type: 'date' }
      ]
    }),
    resolveOwnerFilters: async (filters) => filters,
    query: async (request) => { captured = request.filters; return { records: [], info: { more_records: false }, module_api_name: request.module_api_name }; },
    count: async (_module, filters) => { captured = filters; return { count: 0 }; }
  });

  await service.query(planQuestion('Show me tasks due today'));
  assert.equal(captured[0].field, 'Due_Date');
});

test('rejects an invalid field before invoking the Zoho query', async () => {
  let queryCalls = 0;
  const service = new CrmService({
    executionStats: {},
    resolveModuleApiName: async () => 'Leads',
    getFieldMetadata: async () => ({ fields: ['id', 'Email'], metadata: [{ api_name: 'id' }, { api_name: 'Email' }] }),
    resolveOwnerFilters: async (filters) => filters,
    query: async () => { queryCalls += 1; return { records: [], info: {} }; }
  });

  await assert.rejects(() => service.query({ module: 'Leads', fields: ['Not_A_Lead_Field'], filters: [], limit: 1, offset: 0 }), (error) => error.code === 'FIELD_NOT_AVAILABLE' && error.details.field === 'Not_A_Lead_Field');
  assert.equal(queryCalls, 0);
});

test('plans deal pipeline analysis as metadata-resolved stage grouping', () => {
  const request = planQuestion('Deal pipeline analysis');
  assert.equal(request.module, 'Deals');
  assert.equal(request.request_type, 'aggregate');
  assert.equal(request.aggregate.operation, 'count');
  assert.equal(request.group_by, 'Stage');
  assert.equal(request.group_by_label, 'stage');
  assert.ok(!['__semantic__', 'semantic'].includes(request.group_by));
});

test('plans sales performance reports as CRM analysis', () => {
  const request = planQuestion('Sales performance reports');
  assert.equal(request.module, 'CRM');
  assert.deepEqual(request.analysis, { type: 'sales_performance' });
});
