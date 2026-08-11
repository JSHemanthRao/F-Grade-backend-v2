const test = require('node:test');
const assert = require('node:assert/strict');
const router = require('../src/crm/routes');
const controller = require('../src/crm/controllers/crm.controller');
const recordsService = require('../src/crm/services/records.service');
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

  assert.equal(registeredRoutes.length, expectedRoutes.length + 2);
  expectedRoutes.forEach((route) => {
    assert.ok(registeredRoutes.includes(route), `${route} should be registered`);
  });
  assert.ok(registeredRoutes.includes('/assistant'));
  assert.ok(registeredRoutes.includes('/dns'));
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

test('CRM query tool treats Copilot 1/25 defaults as complete retrieval', async () => {
  const originalGetRecords = recordsService.getRecords;
  let receivedOptions;
  recordsService.getRecords = async (_moduleName, options) => {
    receivedOptions = options;
    return { data: [{ id: '1' }], info: { count: 26, retrievalComplete: true } };
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
    assert.equal(receivedOptions.criteria, undefined);
    assert.equal(res.payload.count, 26);
  } finally {
    recordsService.getRecords = originalGetRecords;
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
  assert.deepEqual(countParameterNames, ['module', 'filter']);
  assert.deepEqual(queryParameterNames, ['module', 'page', 'per_page', 'fields', 'filter', 'ids']);
  assert.equal(countOperation.parameters[0].required, true);
  assert.equal(queryOperation.parameters[0].required, true);
  assert.equal(queryOperation.parameters.some((parameter) => parameter.name === 'retrieval_mode'), false);
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

test('CRM service automatically merges all Zoho pages when pagination is not explicit', async () => {
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
    assert.deepEqual(
      requests.map((request) => request.config.params.page),
      [1, 2, 3]
    );
    requests.forEach((request) => {
      assert.equal(request.url, '/crm/v8/Deals');
      assert.equal(request.config.params.per_page, 200);
      assert.equal(request.config.params.fields, 'Deal_Name,Stage');
      assert.equal(request.config.params.criteria, "(Stage:equals:Closed Won)");
      assert.equal(request.config.params.sort_by, 'Closing_Date');
      assert.equal(request.config.params.sort_order, 'desc');
    });
    assert.deepEqual(result.data, [{ id: '1' }, { id: '2' }, { id: '3' }]);
    assert.deepEqual(result.info, {
      more_records: false,
      count: 3,
      page: 1,
      per_page: 200,
    });
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

test('CRM service fetches beyond page 1 for complete dataset requests on any module', async () => {
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
    assert.deepEqual(
      requests.map((request) => request.config.params.page),
      [1, 2, 3]
    );
    requests.forEach((request) => {
      assert.equal(request.url, '/crm/v8/Tasks');
      assert.equal(request.config.params.per_page, 200);
    });
    assert.equal(result.data.length, 52);
    assert.equal(result.info.count, 52);
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
    });

    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((request) => request.config.params.page), [1, 2]);
    assert.equal(result.data.length, 26);
    assert.equal(result.data.every((record) => record.Stage === 'Closed Won' && record.Closing_Date.startsWith('2026-06')), true);
  } finally {
    zohoClient.get = originalGet;
  }
});

test('CRM service ignores Copilot default pagination for complete and filtered requests', async () => {
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
    requests.forEach((request, index) => {
      assert.equal(request.config.params.page, index + 1);
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

test('CRM service uses one bounded request for specific record prompts', async () => {
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
    await recordsService.getRecords('deals', {
      search: 'Show Deal ABC',
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/crm/v8/Deals');
    assert.equal(requests[0].config.params.page, 1);
    assert.equal(requests[0].config.params.per_page, 1);
    assert.equal(requests[0].config.params.criteria, '((Deal_Name:equals:ABC)or(Account_Name:equals:ABC))');
  } finally {
    zohoClient.get = originalGet;
  }
});

test('CRM service fetches all pages for explicit filtered requests', async () => {
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
    requests.forEach((request, index) => {
      assert.equal(request.url, '/crm/v8/Contacts');
      assert.equal(request.config.params.page, index + 1);
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
