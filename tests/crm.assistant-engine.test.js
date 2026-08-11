const test = require('node:test');
const assert = require('node:assert/strict');
const recordsService = require('../src/crm/services/records.service');
const assistantEngine = require('../src/crm/services/assistant-engine.service');
const crmController = require('../src/crm/controllers/crm.controller');
const { formatResponse } = require('../src/crm/services/assistant/formatter.service');
const { detectModule, detectModules } = require('../src/crm/services/assistant/module-detector.service');
const { buildExecutionPlan, detectPagination } = require('../src/crm/services/assistant/planner.service');

test('planner detects natural-language pagination limits and directions', () => {
  const cases = [
    ['Show 10 leads', 'leads', 1, 10, 0, 'first'],
    ['Show first 20 contacts', 'contacts', 1, 20, 0, 'first'],
    ['Show next 35 leads', 'leads', 2, 35, 35, 'next'],
    ['Show previous 50 deals', 'deals', 1, 50, 0, 'previous'],
    ['Show page 2 with 40 records', null, 2, 40, 40, 'page'],
    ['Show last 15 contacts', 'contacts', 1, 15, 0, 'last'],
  ];

  cases.forEach(([question, module, page, perPage, offset, direction]) => {
    const pagination = detectPagination(question, module);
    assert.deepEqual(
      { module: pagination.module, page: pagination.page, per_page: pagination.per_page, offset: pagination.offset, direction: pagination.direction },
      { module, page, per_page: perPage, offset, direction },
    );
  });
});

test('assistant passes planner pagination values to CRM records service', async () => {
  const originalGetRecords = recordsService.getRecords;
  let receivedOptions;
  recordsService.getRecords = async (_module, options) => {
    receivedOptions = options;
    return { data: Array.from({ length: 35 }, (_, index) => ({ id: index + 1 })), info: { count: 35 } };
  };

  try {
    const plan = buildExecutionPlan('Show next 35 leads');
    assert.deepEqual(plan.steps[0], {
      type: 'query', module: 'leads', timeRange: { label: 'all time', range: 'all_time' },
      action: 'query', page: 2, per_page: 35, offset: 35, direction: 'next', explicit: true,
    });
    const response = await assistantEngine.handleAssistantRequest({ question: 'Show next 35 leads' });
    assert.equal(receivedOptions.retrieval_mode, 'page');
    assert.equal(receivedOptions.page, 2);
    assert.equal(receivedOptions.per_page, 35);
    assert.equal(response.summary, '35 records.');
    assert.equal(response.data.length, 35);
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('module detector resolves every supported alias and normalizes punctuation', () => {
  const cases = [
    ['How many leads are there?', 'leads'],
    ['Show first 20 leads', 'leads'],
    ['Total contacts', 'contacts'],
    ['Deals this month', 'deals'],
    ['Closed Won deals', 'deals'],
    ['Accounts', 'accounts'],
    ['Meetings', 'events'],
    ['Appointments', 'events'],
    ['Customers', 'accounts'],
    ['Prospects', 'leads'],
    ['Suppliers', 'vendors'],
    ['...LeAdS!!!', 'leads'],
    ['Show me a task', 'tasks'],
    ['Calls for this week', 'calls'],
    ['Quote details', 'quotes'],
    ['Products', 'products'],
    ['Purchase orders', 'purchase-orders'],
    ['Sales orders', 'sales-orders'],
    ['Campaigns', 'campaigns'],
    ['Purchase Order', 'purchase-orders'],
    ['Sales Order', 'sales-orders'],
    ['PO request', 'purchase-orders'],
  ];

  cases.forEach(([question, expectedModule]) => {
    assert.equal(detectModule(question), expectedModule, `Expected ${question} to resolve to ${expectedModule}`);
    assert.deepEqual(detectModules(question), [expectedModule]);
  });
});

test('module detector returns multiple modules when the question mentions more than one', () => {
  assert.deepEqual(detectModules('Show leads and contacts'), ['leads', 'contacts']);
});

test('assistant controller delegates the request to the assistant engine without pre-detecting modules', async () => {
  const originalHandleAssistantRequest = assistantEngine.handleAssistantRequest;
  let receivedPayload;

  assistantEngine.handleAssistantRequest = async (payload) => {
    receivedPayload = payload;
    return { success: true, summary: 'delegated' };
  };

  try {
    const req = {
      method: 'POST',
      body: { question: 'How many leads are there?' },
      query: {},
      params: {},
      headers: {},
      originalUrl: '/crm/assistant',
      ip: '127.0.0.1',
    };
    const res = {
      json: (body) => body,
      status: () => ({ json: () => null }),
    };

    const response = await crmController.handleAssistantRequest(req, res, () => null);

    assert.deepEqual(receivedPayload, { question: 'How many leads are there?' });
    assert.equal(response.success, true);
    assert.equal(response.summary, 'delegated');
  } finally {
    assistantEngine.handleAssistantRequest = originalHandleAssistantRequest;
  }
});

test('assistant handles DNS requests by performing a complete lookup and returning DNS results', async () => {
  const axios = require('axios');
  const originalAxiosGet = axios.get;

  axios.get = async () => ({
    status: 200,
    data: {
      domain: 'example.com',
      records: [
        { type: 'A', name: 'example.com', ttl: 300, data: '93.184.216.34' },
        { type: 'NS', name: 'example.com', ttl: 300, data: 'a.iana-servers.net' },
        { type: 'MX', name: 'example.com', ttl: 300, data: { priority: 10, exchange: 'mx.example.com' } },
      ],
    },
  });

  try {
    const response = await assistantEngine.handleAssistantRequest({ question: 'Check DNS for example.com' });
    assert.equal(response.success, true);
    assert.equal(response.source, 'DNS Checker');
    assert.equal(response.domain, 'example.com');
    assert.equal(response.completeRecords.A[0].value, '93.184.216.34');
    assert.equal(response.completeRecords.NS[0].value, 'a.iana-servers.net');
    assert.equal(response.completeRecords.MX[0].value, 'mx.example.com');
    assert.deepEqual(response.records, [
      { type: 'A', name: 'example.com', value: '93.184.216.34', priority: null, ttl: 300 },
      { type: 'NS', name: 'example.com', value: 'a.iana-servers.net', priority: null, ttl: 300 },
      { type: 'MX', name: 'example.com', value: 'mx.example.com', priority: 10, ttl: 300 },
    ]);
    assert.equal(response.tables[0].columns[0], 'Type');
  } finally {
    axios.get = originalAxiosGet;
  }
});

test('assistant filters DNS results when a specific record type is requested', async () => {
  const axios = require('axios');
  const originalAxiosGet = axios.get;

  axios.get = async () => ({
    status: 200,
    data: {
      domain: 'example.com',
      records: [
        { type: 'A', name: 'example.com', ttl: 300, data: '93.184.216.34' },
        { type: 'MX', name: 'example.com', ttl: 300, data: { priority: 10, exchange: 'mx.example.com' } },
      ],
    },
  });

  try {
    const response = await assistantEngine.handleAssistantRequest({ question: 'Check the MX records for example.com' });
    assert.equal(response.success, true);
    assert.equal(response.source, 'DNS Checker');
    assert.equal(response.domain, 'example.com');
    assert.deepEqual(response.data, { MX: [{ type: 'MX', name: 'example.com', value: 'mx.example.com', ttl: 300, priority: 10 }] });
    assert.equal(response.summary, 'DNS MX records for example.com.');
    assert.equal(response.records.length, 1);
    assert.equal(response.records[0].type, 'MX');
  } finally {
    axios.get = originalAxiosGet;
  }
});

test('assistant engine executes compare steps with both datasets and formats real CRM output', async () => {
  const originalGetRecords = recordsService.getRecords;
  const calls = [];

  recordsService.getRecords = async (moduleKey, options) => {
    calls.push({ moduleKey, options });
    if (calls.length === 1) {
      return { data: [{ Amount: 100 }], info: { count: 1 } };
    }
    return { data: [{ Amount: 200 }], info: { count: 1 } };
  };

  try {
    const response = await assistantEngine.handleAssistantRequest({ question: 'Compare this month deal value with last month' });

    assert.equal(calls.length, 2);
    assert.equal(response.success, true);
    assert.equal(response.summary.includes('I analyzed your request'), false);
    assert.equal(response.summary.includes('No matching CRM records'), false);
    assert.equal(response.calculations.some((item) => item.type === 'comparison'), true);
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('formatter returns a CRM-data-only message when no matching records are available', () => {
  const response = formatResponse({ question: 'Show leads', steps: [{ type: 'query', module: 'leads' }], modules: ['leads'], intents: ['LIST'] }, [], []);

  assert.equal(response.success, true);
  assert.equal(response.summary, 'No matching CRM records were found for the requested period.');
  assert.equal(response.data.length, 0);
});

test('assistant engine builds a count plan for simple count questions', async () => {
  const originalGetCount = recordsService.getCount;
  const originalGetRecords = recordsService.getRecords;

  recordsService.getRecords = async () => ({ data: Array.from({ length: 18 }, (_, index) => ({ id: `lead-${index}` })), info: {} });

  try {
    const response = await assistantEngine.handleAssistantRequest({ question: 'How many leads are there?' });

    assert.equal(response.success, true);
    assert.equal(response.summary.includes('18'), true);
    assert.equal(response.calculations[0].label, 'Count');
    assert.equal(response.calculations[0].value, 18);
  } finally {
    recordsService.getCount = originalGetCount;
    recordsService.getRecords = originalGetRecords;
  }
});

test('assistant engine returns a clear module error when the question has no module alias', async () => {
  const response = await assistantEngine.handleAssistantRequest({ question: 'How much is there?' });

  assert.equal(response.success, false);
  assert.equal(response.message, 'I could not identify the CRM information needed to answer that question.');
});

test('assistant engine builds a comparison plan for month-over-month questions', async () => {
  const originalGetRecords = recordsService.getRecords;

  recordsService.getRecords = async (moduleKey, options) => {
    assert.equal(moduleKey, 'deals');
    assert.equal(options.question.includes('this month'), true);
    return {
      data: [{ Amount: 100 }, { Amount: 200 }],
      info: { count: 2 },
    };
  };

  try {
    const response = await assistantEngine.handleAssistantRequest({ question: 'Compare this month deal value with last month' });

    assert.equal(response.success, true);
    assert.equal(response.summary.includes('comparison'), true);
    assert.equal(response.calculations.length >= 1, true);
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('assistant returns CRM-backed results for the six supported CRM questions', async () => {
  const originalGetCount = recordsService.getCount;
  const originalGetRecords = recordsService.getRecords;
  const leads = Array.from({ length: 20 }, (_, index) => ({ id: `lead-${index + 1}`, First_Name: `Lead ${index + 1}` }));
  const deals = [
    { id: 'deal-1', Amount: 1000, Stage: 'Closed Won', Owner: { name: 'Alice' } },
    { id: 'deal-2', Amount: 500, Stage: 'Closed Won', Owner: { name: 'Bob' } },
    { id: 'deal-3', Amount: 250, Stage: 'Closed Won', Owner: { name: 'Alice' } },
  ];

  recordsService.getCount = async (moduleKey) => ({ data: [], info: { count: moduleKey === 'leads' ? 20 : 3 } });
  recordsService.getRecords = async (moduleKey, options) => {
    if (moduleKey === 'leads') return { data: leads, info: { count: leads.length } };
    if (options.request_text?.includes('last month')) return { data: [{ id: 'old-deal', Amount: 400, Owner: { name: 'Bob' } }], info: { count: 1 } };
    return { data: deals, info: { count: deals.length } };
  };

  try {
    const responses = [];
    for (const question of [
      'How many leads are there?',
      'Show first 20 leads',
      "Compare this month's deals with last month",
      'Total Closed Won revenue this month',
      'Average deal value this month',
      'Top 5 deal owners',
    ]) {
      responses.push(await assistantEngine.handleAssistantRequest({ question }));
    }

    responses.forEach((response) => {
      assert.equal(response.success, true);
      assert.equal(/I analyzed your request|request was interpreted|Internal pagination/i.test(JSON.stringify(response)), false);
    });
    assert.equal(responses[0].calculations[0].value, 20);
    assert.equal(responses[1].data.length, 20);
    assert.equal(responses[2].calculations.some((item) => item.type === 'comparison'), true);
    assert.equal(responses[3].calculations.some((item) => item.type === 'sum'), true);
    assert.equal(responses[4].calculations.some((item) => item.type === 'average'), true);
    assert.equal(responses[5].calculations.some((item) => item.type === 'top_owners'), true);
  } finally {
    recordsService.getCount = originalGetCount;
    recordsService.getRecords = originalGetRecords;
  }
});

test('assistant searches all Deals before displaying Closed Won June 2026 matches', async () => {
  const originalGetRecords = recordsService.getRecords;
  const records = [
    ...Array.from({ length: 25 }, (_, index) => ({
      id: `other-${index}`,
      Stage: 'Negotiation',
      Closing_Date: '2026-06-10T00:00:00Z',
    })),
    { id: 'matching-june-deal', Stage: 'Closed Won', Closing_Date: '2026-06-15T00:00:00Z' },
    { id: 'wrong-month-deal', Stage: 'Closed Won', Closing_Date: '2026-07-15T00:00:00Z' },
  ];
  let receivedOptions;
  recordsService.getRecords = async (_module, options) => {
    receivedOptions = options;
    return { data: records, info: { count: records.length, retrievalComplete: true, more_records: false } };
  };

  try {
    const response = await assistantEngine.handleAssistantRequest({ question: 'Give me Closed Won deals in June 2026.' });

    assert.equal(receivedOptions.retrieval_mode, 'all');
    assert.deepEqual(response.data.map((record) => record.id), ['matching-june-deal']);
    assert.match(response.summary, /Showing 1 of 1 matching records/);
    assert.doesNotMatch(response.summary, /No matching records found/);
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('assistant keeps first-N list requests bounded to the requested CRM page', async () => {
  const originalGetRecords = recordsService.getRecords;
  const calls = [];
  recordsService.getRecords = async (_module, options) => {
    calls.push(options);
    return { data: Array.from({ length: 10 }, (_, index) => ({ id: `lead-${index + 1}` })), info: { count: 883, more_records: true } };
  };

  try {
    const response = await assistantEngine.handleAssistantRequest({ question: 'Give me first 10 leads' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].retrieval_mode, 'page');
    assert.equal(calls[0].page, 1);
    assert.equal(calls[0].per_page, 10);
    assert.equal(response.data.length, 10);
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('assistant uses CRM-side aggregation for total Closed Won value', async () => {
  const originalGetRecords = recordsService.getRecords;
  const calls = [];
  recordsService.getRecords = async (_module, options) => {
    calls.push(options);
    return {
      data: [],
      info: {
        count: 4,
        aggregateValues: { sum: 125000 },
        aggregateValue: 125000,
        retrievalStrategy: 'aggregate',
        retrievalComplete: true,
        more_records: false,
      },
    };
  };

  try {
    const response = await assistantEngine.handleAssistantRequest({ question: 'What was the total Closed Won value in June 2026?' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].retrieval_mode, 'aggregate');
    assert.match(calls[0].criteria, /Stage:equals:Closed Won/);
    assert.match(calls[0].criteria, /Closing_Date:greater_equal:2026-06-01/);
    assert.match(response.summary, /₹1,25,000/);
    assert.equal(response.calculations.some((item) => item.type === 'sum' && item.value === 125000), true);
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('assistant defaults July customer data to complete new and existing deal activity', async () => {
  const originalGetRecords = recordsService.getRecords;
  const calls = [];
  const julyDeals = [
    { id: 'new-july', Deal_Name: 'New July customer', Account_Name: 'Asha Foods', Amount: 160000, Closing_Date: '2026-07-08T00:00:00Z', Created_Time: '2026-07-01T00:00:00Z' },
    { id: 'existing-july', Deal_Name: 'Existing July customer', Account_Name: 'Bharat Retail', Amount: 240000, Closing_Date: '2026-07-15T00:00:00Z', Created_Time: '2026-04-03T00:00:00Z' },
    { id: 'existing-july-late-page', Deal_Name: 'Existing July page 2', Account_Name: 'Cedar Stores', Amount: '\u20B990,000', Closing_Date: '2026-07-20T00:00:00Z', Created_Time: '2026-06-03T00:00:00Z' },
    { id: 'existing-july-late-page', Deal_Name: 'Duplicate July page 2', Account_Name: 'Cedar Stores', Amount: '\u20B990,000', Closing_Date: '2026-07-20T00:00:00Z', Created_Time: '2026-06-03T00:00:00Z' },
    { id: 'august-deal', Deal_Name: 'August customer', Account_Name: 'Delta', Amount: 700000, Closing_Date: '2026-08-01T00:00:00Z', Created_Time: '2026-07-02T00:00:00Z' },
  ];

  recordsService.getRecords = async (moduleKey, options) => {
    calls.push({ moduleKey, options });
    return { data: julyDeals, info: { count: julyDeals.length, retrievalComplete: true, more_records: false, duplicateRecordsRemoved: 1 } };
  };

  try {
    const response = await assistantEngine.handleAssistantRequest({ question: 'Give me July customer data' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].moduleKey, 'deals');
    assert.equal(calls[0].options.retrieval_mode, 'all');
    assert.match(calls[0].options.criteria, /Closing_Date:greater_equal:2026-07-01/);
    assert.match(calls[0].options.criteria, /Closing_Date:less_than:2026-08-01/);
    assert.doesNotMatch(calls[0].options.criteria, /Created_Time|Modified_Time/);
    assert.deepEqual(response.data.map((record) => record.id), ['new-july', 'existing-july', 'existing-july-late-page']);
    assert.equal(response.crmRetrievalMetadata.newRecords, 1);
    assert.equal(response.crmRetrievalMetadata.existingRecords, 2);
    assert.equal(response.crmRetrievalMetadata.totalAmountRevenue, '\u20B94,90,000');
    assert.equal(response.crmRetrievalMetadata.duplicateRecordsRemoved, 1);
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('assistant filters July data to existing customers only after complete retrieval', async () => {
  const originalGetRecords = recordsService.getRecords;
  let receivedOptions;
  recordsService.getRecords = async (_moduleKey, options) => {
    receivedOptions = options;
    return {
      data: [
        { id: 'new-july', Amount: 160000, Closing_Date: '2026-07-05T00:00:00Z', Created_Time: '2026-07-01T00:00:00Z' },
        { id: 'existing-july', Amount: 240000, Closing_Date: '2026-07-15T00:00:00Z', Created_Time: '2026-06-01T00:00:00Z' },
      ],
      info: { count: 2, retrievalComplete: true, more_records: false },
    };
  };

  try {
    const response = await assistantEngine.handleAssistantRequest({ question: 'Give me July data for existing customers only' });

    assert.equal(receivedOptions.retrieval_mode, 'all');
    assert.match(receivedOptions.criteria, /Closing_Date:greater_equal:2026-07-01/);
    assert.doesNotMatch(receivedOptions.criteria, /Created_Time:greater_equal/);
    assert.deepEqual(response.data.map((record) => record.id), ['existing-july']);
    assert.equal(response.crmRetrievalMetadata.customerScope, 'existing');
    assert.equal(response.crmRetrievalMetadata.existingRecords, 1);
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('assistant compares named periods with one CRM-side aggregate per period', async () => {
  const originalGetRecords = recordsService.getRecords;
  const calls = [];
  recordsService.getRecords = async (_module, options) => {
    calls.push(options);
    const sum = calls.length === 2 ? 225000 : 125000;
    return {
      data: [],
      info: {
        count: 2,
        aggregateValues: { sum },
        aggregateValue: sum,
        retrievalStrategy: 'aggregate',
        retrievalComplete: true,
        more_records: false,
      },
    };
  };

  try {
    const response = await assistantEngine.handleAssistantRequest({ question: 'Compare Closed Won value for June 2026 and July 2026' });
    assert.equal(calls.length, 2);
    assert.equal(calls.every((options) => options.retrieval_mode === 'aggregate'), true);
    assert.equal(calls.some((options) => /june\s+2026/i.test(options.request_text || '')), true);
    assert.equal(calls.some((options) => /july\s+2026/i.test(options.request_text || '')), true);
    const comparison = response.calculations.find((item) => item.type === 'comparison');
    assert.equal(comparison.value['june 2026'], 125000);
    assert.equal(comparison.value['july 2026'], 225000);
    assert.match(response.summary, /june 2026 ₹1,25,000/);
    assert.match(response.summary, /july 2026 ₹2,25,000/);
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('assistant only reports zero Closed Won June matches after complete retrieval', async () => {
  const originalGetRecords = recordsService.getRecords;
  recordsService.getRecords = async () => ({
    data: [],
    info: { count: 0, retrievalComplete: true, more_records: false },
  });

  try {
    const response = await assistantEngine.handleAssistantRequest({ question: 'Give me Closed Won deals in June 2026.' });
    assert.equal(response.summary, 'No Closed Won deals were found for June 2026.');
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('assistant displays at most 25 complete matches and reuses them for show more', async () => {
  const originalGetRecords = recordsService.getRecords;
  let calls = 0;
  recordsService.getRecords = async () => {
    calls += 1;
    return {
      data: Array.from({ length: 47 }, (_, index) => ({ id: `deal-${index + 1}`, Stage: 'Closed Won' })),
      info: { count: 47, retrievalComplete: true, more_records: false },
    };
  };

  try {
    const first = await assistantEngine.handleAssistantRequest({ question: 'Show Closed Won deals' });
    const second = await assistantEngine.handleAssistantRequest({ question: 'show more' });

    assert.equal(calls, 1);
    assert.equal(first.data.length, 25);
    assert.match(first.summary, /Showing 25 of 47 matching records/);
    assert.equal(first.continuation.available, true);
    assert.equal(first.continuation.remainingRecords, 22);
    assert.equal(second.data.length, 22);
    assert.equal(second.data[0].id, 'deal-26');
    assert.equal(second.continuation.available, false);
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('assistant does not turn an incomplete empty dataset into a no-match answer', () => {
  const response = formatResponse(
    { question: 'Give me Closed Won deals in June 2026.', modules: ['deals'], intents: ['LIST'] },
    [{ result: { data: [], info: { retrievalComplete: false, more_records: true } } }],
    [],
  );

  assert.doesNotMatch(response.summary, /No Closed Won deals were found/);
  assert.match(response.summary, /search could not be completed/i);
});
