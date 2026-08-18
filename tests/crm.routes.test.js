const test = require('node:test');
const assert = require('node:assert/strict');
const router = require('../src/crm/routes');
const controller = require('../src/crm/controllers/crm.controller');
const recordsService = require('../src/crm/services/records.service');
const dealsService = require('../src/crm/services/deals.service');
const { zohoClient } = require('../src/common/config/axios');
const openapiSpec = require('../src/crm/openapi/crm.openapi.json');

const expectedRoutes = [
  '/',
  '/count',
  '/query',
  '/leads',
  '/contacts',
  '/accounts',
  '/deals',
  '/tasks',
  '/events',
  '/calls',
  '/meetings',
  '/notes',
  '/products',
  '/vendors',
  '/quotes',
  '/sales-orders',
  '/purchase-orders',
  '/campaigns',
  '/cases',
  '/solutions',
  '/users',
  '/organization',
  '/partners',
  '/enterprise-leads',
  '/renewal-accounts',
  '/service-provider',
  '/co-operative-banks',
  '/documents',
];

test('CRM router exposes one GET route per requested module', () => {
  const stack = router.stack || [];

  const registeredRoutes = stack
    .filter((layer) => layer.route)
    .map((layer) => layer.route.path)
    .sort();

  assert.ok(registeredRoutes.includes('/activity'));
  assert.ok(registeredRoutes.includes('/dashboard'));
  assert.ok(registeredRoutes.includes('/dashboard/view'));
  assert.ok(registeredRoutes.includes('/assistant'));
  assert.ok(registeredRoutes.includes('/dns'));
  expectedRoutes.forEach((route) => {
    assert.ok(registeredRoutes.includes(route), `${route} should be registered`);
  });
});

test('CRM assistant endpoint accepts only a question and routes count requests internally', async () => {
  const originalGetRecords = recordsService.getRecords;
  let receivedOptions;

  recordsService.getRecords = async (_moduleName, options) => {
    receivedOptions = options;
    return { data: Array.from({ length: 12 }, (_, index) => ({ id: String(index + 1) })), info: { count: 12, more_records: false } };
  };

  const req = {
    method: 'POST',
    body: {
      question: 'How many leads are there?',
      page: 2,
      per_page: 10,
      module: 'leads',
    },
    route: { path: '/assistant' },
  };
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
    },
  };

  await controller.handleAssistantRequest(req, res, () => {});

  assert.equal(receivedOptions.question, 'How many leads are there?');
  assert.equal(receivedOptions.retrieval_mode, 'count');
  assert.equal(receivedOptions.page, undefined);
  assert.equal(receivedOptions.per_page, undefined);
  assert.equal(res.payload.success, true);
  assert.equal(res.payload.summary.includes('matching records'), true);
  assert.equal(res.payload.calculations[0].label, 'Count');
  assert.equal(res.payload.calculations[0].value, 12);

  recordsService.getRecords = originalGetRecords;
});

test('CRM router exposes a dedicated DNS checker endpoint', () => {
  const stack = router.stack || [];
  const registeredRoutes = stack
    .filter((layer) => layer.route)
    .map((layer) => layer.route.path);

  assert.ok(registeredRoutes.includes('/dns'));
});

test('CRM controller resolves the requested module from the matched route path', async () => {
  const originalGetRecords = recordsService.getRecords;
  let receivedModule;

  recordsService.getRecords = async (moduleName) => {
    receivedModule = moduleName;
    return { data: [], info: {} };
  };

  const req = {
    route: { path: '/leads' },
    query: {},
    body: {},
  };
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
    },
  };

  await controller.getModuleRecords(req, res, () => {});

  assert.equal(receivedModule, 'leads');
  assert.equal(res.payload.success, true);
  assert.equal(res.payload.module, 'Leads');
  assert.deepEqual(res.payload.data, []);

  recordsService.getRecords = originalGetRecords;
});

test('CRM Deals query ignores incidental 1/25 pagination and retrieves the complete unique dataset', async () => {
  const originalGetAllDeals = dealsService.getAllDeals;
  let receivedOptions;
  dealsService.getAllDeals = async (options) => {
    receivedOptions = options;
    return {
      data: [{ id: '1' }, { id: '2' }],
      info: { count: 2, retrievalComplete: true, pagesFetched: 2 },
      metadata: { uniqueRecordCount: 2 },
    };
  };

  try {
    const req = {
      method: 'GET',
      query: { module: 'deals', page: '1', per_page: '25', filter: '(Stage:equals:Closed Won)' },
      body: {},
      route: { path: '/query' },
    };
    const res = { json(payload) { this.payload = payload; } };

    await controller.getModuleQuery(req, res, () => {});

    assert.equal(receivedOptions.retrieval_mode, 'all');
    assert.equal(receivedOptions.page, undefined);
    assert.equal(receivedOptions.per_page, undefined);
    assert.equal(receivedOptions.limit, undefined);
    assert.equal(receivedOptions.criteria, undefined);
    assert.equal(receivedOptions.filter, '(Stage:equals:Closed Won)');
    assert.equal(receivedOptions.force_coql, false);
    assert.equal(res.payload.count, 2);
    assert.deepEqual(res.payload.data, [{ id: '1' }, { id: '2' }]);
  } finally {
    dealsService.getAllDeals = originalGetAllDeals;
  }
});

test('CRM controller resolves the requested module from the query string', async () => {
  const originalGetRecords = recordsService.getRecords;
  let receivedModule;

  recordsService.getRecords = async (moduleName) => {
    receivedModule = moduleName;
    return { data: [], info: {} };
  };

  const req = {
    route: { path: '/' },
    query: { module: 'accounts' },
    body: {},
  };
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
    },
  };

  await controller.getModuleRecords(req, res, () => {});

  assert.equal(receivedModule, 'accounts');
  assert.equal(res.payload.success, true);
  assert.equal(res.payload.module, 'Accounts');
  assert.deepEqual(res.payload.data, []);

  recordsService.getRecords = originalGetRecords;
});

test('CRM controller routes count requests without pagination parameters', async () => {
  const originalGetCount = recordsService.getCount;
  let receivedOptions;

  recordsService.getCount = async (_moduleName, options) => {
    receivedOptions = options;
    return { data: [], info: { count: 437 } };
  };

  const req = {
    route: { path: '/count' },
    query: {
      module: 'leads',
      filter: '(Lead_Source:equals:Advertisement)',
      page: 1,
      per_page: 25,
    },
    body: {},
  };
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
    },
  };

  await controller.getModuleCount(req, res, () => {});

  assert.equal(receivedOptions.filter, '(Lead_Source:equals:Advertisement)');
  assert.equal(receivedOptions.retrieval_mode, 'count');
  assert.equal(res.payload.success, true);
  assert.equal(res.payload.module, 'Leads');
  assert.equal(res.payload.count, 437);
  assert.equal(res.payload.page, undefined);
  assert.equal(res.payload.per_page, undefined);

  recordsService.getCount = originalGetCount;
});

test('CRM OpenAPI exposes separate count and query operations', () => {
  const countOperation = openapiSpec.paths['/api/crm/count'].get;
  const queryOperation = openapiSpec.paths['/api/crm/query'].get;

  const countParameterNames = countOperation.parameters.map((parameter) => parameter.name);
  const queryParameterNames = queryOperation.parameters.map((parameter) => parameter.name);

  assert.equal(countOperation.operationId, 'countCRMRecords');
  assert.equal(queryOperation.operationId, 'queryCRMRecords');
  assert.deepEqual(countParameterNames, ['module', 'operation', 'criteria', 'filter', 'date_field', 'from', 'to', 'search', 'retrieval_mode']);
  assert.deepEqual(queryParameterNames, ['module', 'operation', 'limit', 'page', 'per_page', 'fields', 'date_field', 'from', 'to', 'filter', 'criteria', 'search', 'retrieval_mode', 'ids']);
  assert.equal(countOperation.parameters[0].required, true);
  assert.equal(queryOperation.parameters[0].required, true);
  assert.match(queryOperation.description, /Never default to retrieving the complete module/);
  assert.equal(queryOperation.parameters.some((parameter) => parameter.name === 'retrieval_mode'), true);
});

test('CRM service applies module fields and forwards Zoho query parameters', async () => {
  const originalGet = zohoClient.get;
  const requests = [];

  zohoClient.get = async (url, config) => {
    requests.push({ url, config });
    return { data: { data: [{ id: '1' }], info: {} } };
  };

  try {
    const result = await recordsService.getRecords('deals', {
      page: 2,
      per_page: 5,
      ids: ['1', '2'],
      fields: ['Deal_Name', 'Amount'],
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/crm/v8/Deals');
    assert.deepEqual(requests[0].config.params, {
      page: 2,
      per_page: 5,
      ids: '1,2',
      fields: 'Deal_Name,Amount',
    });
    assert.deepEqual(result, { data: [{ id: '1' }], info: {} });
  } finally {
    zohoClient.get = originalGet;
  }
});

test('CRM service completes filtered conversational requests when pagination is not explicit', async () => {
  const originalGet = zohoClient.get;
  const requests = [];
  const pages = [
    { data: [{ id: '1' }], info: { more_records: true } },
    { data: [{ id: '2' }], info: { more_records: true } },
    { data: [{ id: '3' }], info: { more_records: false } },
  ];

  zohoClient.get = async (url, config) => {
    requests.push({ url, config });
    return { data: pages[requests.length - 1] };
  };

  try {
    const result = await recordsService.getRecords('deals', {
      fields: ['Deal_Name', 'Stage'],
      criteria: "(Stage:equals:Closed Won)",
      sort_by: 'Closing_Date',
      sort_order: 'desc',
    });

    assert.equal(requests.length, 3);
    requests.forEach((request) => {
      assert.equal(request.url, '/crm/v8/Deals/search');
      assert.equal(request.config.params.per_page, 200);
      assert.equal(request.config.params.fields, 'Deal_Name,Stage');
      assert.equal(request.config.params.criteria, "(Stage:equals:Closed Won)");
      assert.equal(request.config.params.sort_by, 'Closing_Date');
      assert.equal(request.config.params.sort_order, 'desc');
    });
    assert.deepEqual(result.data, [{ id: '1' }, { id: '2' }, { id: '3' }]);
    assert.equal(result.info.more_records, false);
  } finally {
    zohoClient.get = originalGet;
  }
});

test('CRM service uses Zoho count endpoint for count and total questions', async () => {
  const originalGet = zohoClient.get;
  const requests = [];

  zohoClient.get = async (url, config) => {
    requests.push({ url, config });
    return { data: { count: 437 } };
  };

  try {
    const countRequest = await recordsService.getRecords('leads', {
      retrieval_mode: 'count',
      search: 'How many leads are there in the entire CRM?',
    });

    const totalRequest = await recordsService.getRecords('leads', {
      retrieval_mode: 'count',
      search: 'Total leads',
    });

    assert.equal(requests.length, 2);
    requests.forEach((request) => {
      assert.equal(request.url, '/crm/v8/Leads/actions/count');
      assert.deepEqual(request.config.params, {});
    });
    assert.equal(countRequest.info.count, 437);
    assert.equal(countRequest.data.length, 0);
    assert.equal(totalRequest.info.count, 437);
    assert.equal(totalRequest.data.length, 0);
  } finally {
    zohoClient.get = originalGet;
  }
});

test('CRM query endpoint applies Zoho server-side Created_Time date filtering for July 2026 leads', async () => {
  const originalGet = zohoClient.get;
  const requests = [];
  const julyLead = { id: '1001', Created_Time: '2026-07-10T12:34:56+05:30', First_Name: 'Alice', Last_Name: 'Example' };
  const augustLead = { id: '1002', Created_Time: '2026-08-09T22:39:33+05:30', First_Name: 'August', Last_Name: 'Example' };
  const mockZohoRecords = [julyLead, augustLead];
  const expectedCriteria = '(Created_Time:greater_equal:2026-07-01T00:00:00+05:30)and(Created_Time:less_than:2026-08-01T00:00:00+05:30)';

  zohoClient.get = async (url, config) => {
    requests.push({ url, config });
    return {
      data: {
        // Emulate Zoho server-side filtering: an unfiltered module request
        // returns both July and August data.
        data: url === '/crm/v8/Leads/search' && config.params.criteria === expectedCriteria
          ? mockZohoRecords.filter((record) => record.id === julyLead.id)
          : mockZohoRecords,
        info: { count: 1, per_page: config.params.per_page, more_records: false },
      },
    };
  };

  try {
    const req = {
      method: 'GET',
      query: {
        module: 'Leads',
        date_field: 'Created_Time',
        from: '2026-07-01',
        to: '2026-08-01',
        limit: '10',
      },
      route: { path: '/query' },
    };
    const res = { json(payload) { this.payload = payload; } };

    await controller.getModuleQuery(req, res, () => {});

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/crm/v8/Leads/search');
    assert.equal(requests[0].config.params.per_page, 10);
    assert.equal(requests[0].config.params.criteria, expectedCriteria);
    assert.ok(requests[0].config.params.fields.includes('Created_Time'));
    assert.deepEqual(res.payload.data, [julyLead]);
    assert.equal(res.payload.per_page, 10);
    assert.equal(res.payload.data.every((record) => {
      const createdTime = new Date(record.Created_Time).valueOf();
      return createdTime >= new Date('2026-07-01T00:00:00+05:30').valueOf()
        && createdTime < new Date('2026-08-01T00:00:00+05:30').valueOf();
    }), true);
    assert.equal(res.payload.count, 1);
  } finally {
    zohoClient.get = originalGet;
  }
});

test('CRM query endpoint interprets "give me the closed deals of last month" as Closed Won July closing dates only', async () => {
  const originalGet = zohoClient.get;
  const requests = [];
  const julyDeal = { id: 'deal-july', Stage: 'Closed Won', Closing_Date: '2026-07-15T00:00:00+05:30' };
  const augustDeal = { id: 'deal-august', Stage: 'Closed Won', Closing_Date: '2026-08-15T00:00:00+05:30' };
  const mockZohoRecords = [julyDeal, augustDeal];
  const expectedCriteria = "(Stage:equals:Closed Won)and((Closing_Date:greater_equal:2026-07-01T00:00:00Z)and(Closing_Date:less_than:2026-08-01T00:00:00Z))";

  zohoClient.get = async (url, config) => {
    requests.push({ url, config });
    const matchingRecords = config.params.criteria === expectedCriteria
      ? mockZohoRecords.filter((record) => new Date(record.Closing_Date) >= new Date('2026-07-01T00:00:00+05:30') && new Date(record.Closing_Date) < new Date('2026-08-01T00:00:00+05:30'))
      : mockZohoRecords;

    return {
      data: {
        data: matchingRecords,
        info: { count: matchingRecords.length, per_page: config.params.per_page, more_records: false },
      },
    };
  };

  try {
    const req = {
      method: 'GET',
      query: {
        module: 'Deals',
        search: 'give me the closed deals of last month',
        limit: '10',
      },
      route: { path: '/query' },
    };
    const res = { json(payload) { this.payload = payload; } };

    await controller.getModuleQuery(req, res, () => {});

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/crm/v8/Deals/search');
    assert.equal(requests[0].config.params.per_page, 200);
    assert.equal(requests[0].config.params.criteria, expectedCriteria);
    assert.ok(requests[0].config.params.criteria.includes("Stage:equals:Closed Won"));
    assert.ok(requests[0].config.params.criteria.includes("Closing_Date:greater_equal:2026-07-01T00:00:00Z"));
    assert.ok(requests[0].config.params.criteria.includes("Closing_Date:less_than:2026-08-01T00:00:00Z"));
    assert.deepEqual(res.payload.data.map((record) => record.id), ['deal-july']);
    assert.equal(res.payload.data.every((record) => record.Stage === 'Closed Won' && new Date(record.Closing_Date) >= new Date('2026-07-01T00:00:00+05:30') && new Date(record.Closing_Date) < new Date('2026-08-01T00:00:00+05:30')), true);
  } finally {
    zohoClient.get = originalGet;
  }
});

test('CRM query endpoint falls back to Zoho /search with Created_Time criteria when COQL scope is unavailable', async () => {
  const originalGet = zohoClient.get;
  const originalPost = zohoClient.post;
  const requests = [];

  zohoClient.get = async (url, config) => {
    requests.push({ url, config });
    return {
      data: {
        data: [
          { id: '1001', Created_Time: '2026-07-10T12:34:56Z', First_Name: 'Alice', Last_Name: 'Example' },
        ],
        info: { count: 1, more_records: false },
      },
    };
  };
  zohoClient.post = async () => {
    const error = new Error('COQL scope missing');
    error.response = { status: 401, data: { message: 'invalid oauth scope: coql' } };
    throw error;
  };

  try {
    const result = await recordsService.getRecords('leads', {
      module: 'Leads',
      date_field: 'Created_Time',
      from: '2026-07-01',
      to: '2026-08-01',
      force_coql: true,
    });

    assert.equal(requests[0].url, '/crm/v8/Leads/search');
    assert.equal(requests[0].config.params.per_page, 25);
    assert.equal(requests[0].config.params.page, 1);
    assert.equal(requests[0].config.params.criteria,
      '(Created_Time:greater_equal:2026-07-01T00:00:00+05:30)and(Created_Time:less_than:2026-08-01T00:00:00+05:30)');
    assert.ok(requests[0].config.params.fields.includes('Created_Time'));
    assert.deepEqual(result.data, [
      { id: '1001', Created_Time: '2026-07-10T12:34:56Z', First_Name: 'Alice', Last_Name: 'Example' },
    ]);
    assert.equal(result.info.count, 1);
  } finally {
    zohoClient.get = originalGet;
    zohoClient.post = originalPost;
  }
});

test('CRM service counts filtered closed won deals without paginating records', async () => {
  const originalGet = zohoClient.get;
  const requests = [];

  zohoClient.get = async (url, config) => {
    requests.push({ url, config });
    return { data: { count: 91 } };
  };

  try {
    const result = await recordsService.getRecords('deals', {
      retrieval_mode: 'count',
      search: 'How many closed won deals?',
      filters: '(Stage:equals:Closed Won)',
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/crm/v8/Deals/actions/count');
    assert.equal(requests[0].config.params.criteria, '(Stage:equals:Closed Won)');
    assert.equal(result.info.count, 91);
    assert.equal(result.data.length, 0);
  } finally {
    zohoClient.get = originalGet;
  }
});

test('CRM service counts filtered leads from advertisement without record pagination', async () => {
  const originalGet = zohoClient.get;
  const requests = [];

  zohoClient.get = async (url, config) => {
    requests.push({ url, config });
    return { data: { count: 18 } };
  };

  try {
    const result = await recordsService.getRecords('leads', {
      retrieval_mode: 'count',
      search: 'How many leads came from Advertisement?',
      filters: '(Lead_Source:equals:Advertisement)',
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/crm/v8/Leads/actions/count');
    assert.equal(requests[0].config.params.criteria, '(Lead_Source:equals:Advertisement)');
    assert.equal(result.info.count, 18);
    assert.equal(result.data.length, 0);
  } finally {
    zohoClient.get = originalGet;
  }
});

test('CRM service retrieves every Zoho page when retrieval_mode=all even with Copilot defaults', async () => {
  const originalGet = zohoClient.get;
  const requests = [];
  const pages = [
    { data: [{ id: '1' }], info: { more_records: true } },
    { data: [{ id: '2' }], info: { more_records: false } },
  ];

  zohoClient.get = async (url, config) => {
    requests.push({ url, config });
    return { data: pages[requests.length - 1] };
  };

  try {
    const result = await recordsService.getRecords('leads', {
      page: 1,
      per_page: 25,
      retrieval_mode: 'all',
    });

    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests.map((request) => request.config.params.page),
      [1, 2]
    );
    requests.forEach((request) => {
      assert.equal(request.config.params.per_page, 200);
    });
    assert.deepEqual(result.data, [{ id: '1' }, { id: '2' }]);
    assert.equal(result.info.count, 2);
  } finally {
    zohoClient.get = originalGet;
  }
});

test('CRM service keeps only the requested page when retrieval_mode=page', async () => {
  const originalGet = zohoClient.get;
  const requests = [];

  zohoClient.get = async (url, config) => {
    requests.push({ url, config });
    return {
      data: {
        data: [{ id: '1' }],
        info: { more_records: true },
      },
    };
  };

  try {
    const result = await recordsService.getRecords('leads', {
      page: 1,
      per_page: 25,
      retrieval_mode: 'page',
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/crm/v8/Leads');
    assert.equal(requests[0].config.params.page, 1);
    assert.equal(requests[0].config.params.per_page, 25);
    assert.deepEqual(result.data, [{ id: '1' }]);
  } finally {
    zohoClient.get = originalGet;
  }
});

test('CRM service completes natural-language all-record list requests', async () => {
  const originalGet = zohoClient.get;
  const requests = [];
  const pages = [
    { data: Array.from({ length: 25 }, (_, index) => ({ id: `task-${index + 1}` })), info: { more_records: true } },
    { data: Array.from({ length: 25 }, (_, index) => ({ id: `task-${index + 26}` })), info: { more_records: true } },
    { data: Array.from({ length: 2 }, (_, index) => ({ id: `task-${index + 51}` })), info: { more_records: false } },
  ];

  zohoClient.get = async (url, config) => {
    requests.push({ url, config });
    return { data: pages[requests.length - 1] };
  };

  try {
    const result = await recordsService.getRecords('tasks', {
      page: 1,
      per_page: 25,
      search: 'Show all Tasks',
    });

    assert.equal(requests.length, 3);
    requests.forEach((request) => {
      assert.equal(request.url, '/crm/v8/Tasks');
      assert.equal(request.config.params.per_page, 200);
    });
    assert.equal(result.data.length, 52);
    assert.equal(result.info.more_records, false);
  } finally {
    zohoClient.get = originalGet;
  }
});

test('CRM service completes Closed Won June 2026 searches across later pages', async () => {
  const originalGet = zohoClient.get;
  const requests = [];
  const pages = [
    {
      data: Array.from({ length: 25 }, (_, index) => ({
        id: `june-page-one-${index}`,
        Stage: 'Closed Won',
        Closing_Date: '2026-06-10T00:00:00+05:30',
      })),
      info: { more_records: true },
    },
    {
      data: [
        { id: 'closed-won-june', Stage: 'Closed Won', Closing_Date: '2026-06-15T00:00:00+05:30' },
      ],
      info: { more_records: false },
    },
  ];

  zohoClient.get = async (url, config) => {
    requests.push({ url, config });
    return { data: pages[requests.length - 1] };
  };

  try {
    const result = await recordsService.getRecords('deals', {
      question: 'Give me Closed Won deals in June 2026',
      criteria: '((Stage:equals:Closed Won)and(Closing_Date:greater_equal:2026-06-01T00:00:00Z)and(Closing_Date:less_than:2026-07-01T00:00:00Z))',
      retrieval_mode: 'all',
      force_search: true,
    });

    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((request) => request.config.params.page), [1, 2]);
    assert.equal(result.data.length, 26);
    assert.equal(result.data.every((record) => record.Stage === 'Closed Won' && record.Closing_Date.startsWith('2026-06')), true);
  } finally {
    zohoClient.get = originalGet;
  }
});

test('CRM service completes Copilot default complete-list phrasing', async () => {
  const originalGet = zohoClient.get;
  const requests = [];
  const pages = [
    { data: [{ id: '1' }], info: { more_records: true } },
    { data: [{ id: '2' }], info: { more_records: false } },
  ];

  zohoClient.get = async (url, config) => {
    requests.push({ url, config });
    return { data: pages[requests.length - 1] };
  };

  try {
    const result = await recordsService.getRecords('leads', {
      page: 1,
      per_page: 25,
      search: 'Give me the complete list of Leads from Advertisement',
    });

    assert.equal(requests.length, 2);
    requests.forEach((request) => {
      assert.equal(request.config.params.page, undefined);
      assert.equal(request.config.params.per_page, 200);
    });
    assert.deepEqual(result.data, [{ id: '1' }, { id: '2' }]);
  } finally {
    zohoClient.get = originalGet;
  }
});

test('CRM service still respects explicitly requested page and limits', async () => {
  const originalGet = zohoClient.get;
  const requests = [];

  zohoClient.get = async (url, config) => {
    requests.push({ url, config });
    return { data: { data: [{ id: '1' }], info: { more_records: true } } };
  };

  try {
    await recordsService.getRecords('leads', {
      page: 1,
      per_page: 25,
      search: 'Show page 2 of Leads',
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].config.params.page, 2);
    assert.equal(requests[0].config.params.per_page, 200);
  } finally {
    zohoClient.get = originalGet;
  }
});

test('CRM service uses one default page for plain module list prompts', async () => {
  const originalGet = zohoClient.get;
  const requests = [];

  zohoClient.get = async (url, config) => {
    requests.push({ url, config });
    return {
      data: {
        data: [{ id: '1' }],
        info: { more_records: true },
      },
    };
  };

  try {
    const result = await recordsService.getRecords('leads', {
      search: 'Show Leads',
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/crm/v8/Leads');
    assert.equal(requests[0].config.params.page, 1);
    assert.equal(requests[0].config.params.per_page, 25);
    assert.deepEqual(result.data, [{ id: '1' }]);
  } finally {
    zohoClient.get = originalGet;
  }
});

test('CRM service switches to next_page_token after 2000 records', async () => {
  const originalGet = zohoClient.get;
  const requests = [];

  zohoClient.get = async (url, config) => {
    requests.push({ url, config });
    const requestNumber = requests.length;

    if (requestNumber <= 9) {
      return { data: { data: [{ id: String(requestNumber) }], info: { more_records: true } } };
    }

    if (requestNumber === 10) {
      return {
        data: {
          data: [{ id: '10' }],
          info: { more_records: true, next_page_token: 'token-10' },
        },
      };
    }

    return { data: { data: [{ id: '11' }], info: { more_records: false } } };
  };

  try {
    const result = await recordsService.getRecords('leads', {
      search: 'Show all leads',
      retrieval_mode: 'all',
    });

    assert.equal(requests.length, 11);
    assert.equal(requests[9].config.params.page, 10);
    assert.equal(requests[9].config.params.per_page, 200);
    assert.equal(requests[10].config.params.page, undefined);
    assert.equal(requests[10].config.params.page_token, 'token-10');
    assert.equal(requests[10].config.params.per_page, 200);
    assert.equal(result.data.length, 11);
    assert.equal(result.info.count, 11);
  } finally {
    zohoClient.get = originalGet;
  }
});

test('CRM service uses page mode for first 30 leads', async () => {
  const originalGet = zohoClient.get;
  const requests = [];

  zohoClient.get = async (url, config) => {
    requests.push({ url, config });
    return {
      data: {
        data: [{ id: '1' }],
        info: { more_records: true },
      },
    };
  };

  try {
    const result = await recordsService.getRecords('leads', {
      page: 1,
      per_page: 25,
      retrieval_mode: 'page',
      search: 'First 30 leads',
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/crm/v8/Leads');
    assert.equal(requests[0].config.params.page, 1);
    assert.equal(requests[0].config.params.per_page, 30);
    assert.deepEqual(result.data, [{ id: '1' }]);
  } finally {
    zohoClient.get = originalGet;
  }
});

test('CRM service uses page 2 for next 30 leads', async () => {
  const originalGet = zohoClient.get;
  const requests = [];

  zohoClient.get = async (url, config) => {
    requests.push({ url, config });
    return {
      data: {
        data: [{ id: '1' }],
        info: { more_records: true },
      },
    };
  };

  try {
    const result = await recordsService.getRecords('leads', {
      page: 1,
      per_page: 25,
      retrieval_mode: 'page',
      search: 'Next 30 leads',
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/crm/v8/Leads');
    assert.equal(requests[0].config.params.page, 2);
    assert.equal(requests[0].config.params.per_page, 30);
    assert.deepEqual(result.data, [{ id: '1' }]);
  } finally {
    zohoClient.get = originalGet;
  }
});

test('CRM service treats top and analytics prompts as full retrieval', async () => {
  const originalGet = zohoClient.get;
  const requests = [];
  const pages = [
    { data: [{ id: '1' }], info: { more_records: true } },
    { data: [{ id: '2' }], info: { more_records: false } },
  ];

  zohoClient.get = async (url, config) => {
    requests.push({ url, config });
    return { data: pages[requests.length - 1] };
  };

  try {
    const result = await recordsService.getRecords('accounts', {
      search: 'Top 10 customers',
    });

    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests.map((request) => request.config.params.page),
      [1, 2]
    );
    requests.forEach((request) => {
      assert.equal(request.config.params.per_page, 200);
    });
    assert.deepEqual(result.data, [{ id: '1' }, { id: '2' }]);
  } finally {
    zohoClient.get = originalGet;
  }
});

test('CRM service paginates specific record prompts', async () => {
  const originalGet = zohoClient.get;
  const requests = [];

  zohoClient.get = async (url, config) => {
    requests.push({ url, config });
    return { data: requests.length === 1
      ? { data: [{ id: '1' }], info: { more_records: true } }
      : { data: [{ id: '2' }], info: { more_records: false } } };
  };

  try {
    await recordsService.getRecords('deals', {
      search: 'Show Deal ABC',
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, '/crm/v8/Deals/search');
    assert.equal(requests[0].config.params.per_page, 200);
    assert.equal(requests[0].config.params.criteria, '((Deal_Name:equals:ABC)or(Account_Name:equals:ABC))');
  } finally {
    zohoClient.get = originalGet;
  }
});

test('CRM service completes explicit filtered list requests', async () => {
  const originalGet = zohoClient.get;
  const requests = [];
  const pages = [
    { data: [{ id: '1' }], info: { more_records: true } },
    { data: [{ id: '2' }], info: { more_records: false } },
  ];

  zohoClient.get = async (url, config) => {
    requests.push({ url, config });
    return { data: pages[requests.length - 1] };
  };

  try {
    const result = await recordsService.getRecords('contacts', {
      filters: '(Mailing_City:equals:Hyderabad)',
      search: 'Show contacts from Hyderabad',
    });

    assert.equal(requests.length, 2);
    requests.forEach((request) => {
      assert.equal(request.url, '/crm/v8/Contacts/search');
      assert.equal(request.config.params.per_page, 200);
      assert.equal(request.config.params.criteria, '(Mailing_City:equals:Hyderabad)');
    });
    assert.deepEqual(result.data, [{ id: '1' }, { id: '2' }]);
  } finally {
    zohoClient.get = originalGet;
  }
});

test('CRM service infers simple equality filters before complete retrieval', async () => {
  const originalGet = zohoClient.get;
  const requests = [];

  zohoClient.get = async (url, config) => {
    requests.push({ url, config });
    return {
      data: {
        data: [{ id: '1' }],
        info: { more_records: false },
      },
    };
  };

  try {
    await recordsService.getRecords('accounts', {
      search: 'Companies where Invoice Type = RAW',
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/crm/v8/Accounts');
    assert.equal(requests[0].config.params.page, 1);
    assert.equal(requests[0].config.params.per_page, 200);
    assert.equal(requests[0].config.params.criteria, '(Invoice_Type:equals:RAW)');
  } finally {
    zohoClient.get = originalGet;
  }
});

test('CRM service does not auto-paginate explicit IDs', async () => {
  const originalGet = zohoClient.get;
  const requests = [];

  zohoClient.get = async (url, config) => {
    requests.push({ url, config });
    return {
      data: {
        data: [{ id: '1' }],
        info: { more_records: true },
      },
    };
  };

  try {
    await recordsService.getRecords('contacts', {
      ids: ['1'],
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/crm/v8/Contacts');
    assert.equal(requests[0].config.params.ids, '1');
    assert.equal(requests[0].config.params.page, undefined);
    assert.equal(requests[0].config.params.per_page, undefined);
  } finally {
    zohoClient.get = originalGet;
  }
});

test('CRM service surfaces Zoho API failures without fallback data', async () => {
  const originalGet = zohoClient.get;
  const error = {
    message: 'Zoho rejected the request',
    response: {
      status: 400,
      data: { code: 400, message: 'Bad request' },
    },
  };

  zohoClient.get = async () => {
    throw error;
  };

  try {
    await assert.rejects(() => recordsService.getRecords('leads'), (thrown) => thrown === error);
  } finally {
    zohoClient.get = originalGet;
  }
});

test('CRM service uses the requested co-operative-banks field list', async () => {
  const originalGet = zohoClient.get;
  const requests = [];

  zohoClient.get = async (url, config) => {
    requests.push({ url, config });
    return { data: { data: [{ id: '1' }], info: {} } };
  };

  try {
    await recordsService.getRecords('co-operative-banks');

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/crm/v8/Co_operative_Banks');
    assert.equal(requests[0].config.params.fields, 'Co_operative_Banks_Name,Contact_Name,Contact_Number,State_UT');
  } finally {
    zohoClient.get = originalGet;
  }
});

test('CRM service uses the requested partners field list', async () => {
  const originalGet = zohoClient.get;
  const requests = [];

  zohoClient.get = async (url, config) => {
    requests.push({ url, config });
    return { data: { data: [{ id: '1' }], info: {} } };
  };

  try {
    await recordsService.getRecords('partners');

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/crm/v8/Partners');
    assert.equal(
      requests[0].config.params.fields,
      'Partner_Name,Company_Name,Partner_Owner,Partner_Status,Email,Created_Time,Modified_Time,Last_Activity_Time,End_Customer_Accounts,id'
    );
  } finally {
    zohoClient.get = originalGet;
  }
});

test('CRM service uses the requested enterprise leads field list', async () => {
  const originalGet = zohoClient.get;
  const requests = [];

  zohoClient.get = async (url, config) => {
    requests.push({ url, config });
    return { data: { data: [{ id: '1' }], info: {} } };
  };

  try {
    await recordsService.getRecords('enterprise-leads');

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/crm/v8/Enterprise');
    assert.equal(
      requests[0].config.params.fields,
      'Enterprise_Name,Email,Enterprise_Owner,Modified_Time,Created_Time,Created_By,Connected_To,id'
    );
  } finally {
    zohoClient.get = originalGet;
  }
});

test('CRM service does not expose unsupported Projects through CRM Records API', async () => {
  await assert.rejects(
    () => recordsService.getRecords('projects'),
    /Unsupported CRM module: projects/
  );
});

test('CRM service surfaces invalid Zoho field names explicitly', async () => {
  const originalGet = zohoClient.get;
  const error = {
    message: 'Zoho rejected the request',
    response: {
      status: 400,
      data: { code: 400, message: "The field 'Contact_Name' does not exist" },
    },
  };

  zohoClient.get = async () => {
    throw error;
  };

  try {
    await assert.rejects(
      () => recordsService.getRecords('co-operative-banks'),
      (thrown) => thrown?.invalidFields?.includes('Contact_Name') && thrown.message.includes('Contact_Name')
    );
  } finally {
    zohoClient.get = originalGet;
  }
});
