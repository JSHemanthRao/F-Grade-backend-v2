const test = require('node:test');
const assert = require('node:assert/strict');
const { getRetrievalPlan, DEFAULT_LIMITED_PER_PAGE } = require('../src/crm/services/retrieval-policy.service');
const { getModuleDefinition } = require('../src/crm/services/module-definition.service');
const recordsService = require('../src/crm/services/retrieval-engine.service');
const { zohoClient } = require('../src/common/config/axios');

test('date-filtered queries do not set fetchAll and return paginated_list', () => {
  const moduleDefinition = getModuleDefinition('leads');
  const options = {
    requestText: 'Show me leads created in July',
    date_field: 'Created_Time',
    from: '2026-07-01',
    to: '2026-08-01',
  };

  const plan = getRetrievalPlan(moduleDefinition, options);
  assert.equal(plan.fetchAll, false, 'Expected fetchAll to be false for date-filtered conversational queries');
  assert.equal(plan.strategy === 'paginated_list' || plan.strategy === 'paginated_list', true);
  assert.equal(plan.params.per_page, DEFAULT_LIMITED_PER_PAGE);
});

test('count questions use COUNT retrieval strategy', () => {
  const moduleDefinition = getModuleDefinition('leads');
  const options = {
    requestText: 'How many leads were created in July?'
  };

  const plan = getRetrievalPlan(moduleDefinition, options);
  assert.equal(plan.strategy, 'count', 'Expected count strategy for count-style questions');
  assert.equal(plan.fetchAll, false);
});

test('first 10 leads uses one bounded request with per_page=10', async () => {
  const originalGet = zohoClient.get;
  const requests = [];

  zohoClient.get = async (url, config) => {
    requests.push({ url, config });
    return {
      data: {
        data: Array.from({ length: 10 }, (_, index) => ({ id: `lead-${index + 1}` })),
        info: { count: 10, more_records: true },
      },
    };
  };

  try {
    const result = await recordsService.getRecords('leads', {
      operation: 'query',
      limit: 10,
      retrieval_mode: 'limited',
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/crm/v8/Leads');
    assert.equal(requests[0].config.params.page, 1);
    assert.equal(requests[0].config.params.per_page, 10);
    assert.equal(requests[0].config.params.page_token, undefined);
    assert.equal(result.data.length, 10);
  } finally {
    zohoClient.get = originalGet;
  }
});

test('first 25 leads uses one bounded request with per_page=25', async () => {
  const originalGet = zohoClient.get;
  const requests = [];

  zohoClient.get = async (url, config) => {
    requests.push({ url, config });
    return {
      data: {
        data: Array.from({ length: 25 }, (_, index) => ({ id: `lead-${index + 1}` })),
        info: { count: 25, more_records: true },
      },
    };
  };

  try {
    const result = await recordsService.getRecords('leads', {
      operation: 'query',
      limit: 25,
      retrieval_mode: 'limited',
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/crm/v8/Leads');
    assert.equal(requests[0].config.params.page, 1);
    assert.equal(requests[0].config.params.per_page, 25);
    assert.equal(requests[0].config.params.page_token, undefined);
    assert.equal(result.data.length, 25);
  } finally {
    zohoClient.get = originalGet;
  }
});

test('count leads in July uses count endpoint and retrieves no records', async () => {
  const originalGet = zohoClient.get;
  const requests = [];

  zohoClient.get = async (url, config) => {
    requests.push({ url, config });
    return { data: { count: 37 } };
  };

  try {
    const result = await recordsService.getRecords('leads', {
      operation: 'count',
      date_field: 'Created_Time',
      from: '2026-07-01',
      to: '2026-08-01',
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/crm/v8/Leads/actions/count');
    assert.equal(requests[0].config.params.criteria,
      '(Created_Time:greater_equal:2026-07-01T00:00:00Z)and(Created_Time:less_than:2026-08-01T00:00:00Z)');
    assert.equal(result.info.count, 37);
    assert.deepEqual(result.data, []);
  } finally {
    zohoClient.get = originalGet;
  }
});

test('leads created in July uses server-side Created_Time criteria and bounded limit', async () => {
  const originalGet = zohoClient.get;
  const requests = [];

  zohoClient.get = async (url, config) => {
    requests.push({ url, config });
    return {
      data: {
        data: [{ id: 'lead-july', Created_Time: '2026-07-15T00:00:00Z' }],
        info: { count: 1, more_records: true },
      },
    };
  };

  try {
    await recordsService.getRecords('leads', {
      operation: 'query',
      date_field: 'Created_Time',
      from: '2026-07-01',
      to: '2026-08-01',
      retrieval_mode: 'filtered',
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/crm/v8/Leads/search');
    assert.equal(requests[0].config.params.page, 1);
    assert.equal(requests[0].config.params.per_page, DEFAULT_LIMITED_PER_PAGE);
    assert.equal(requests[0].config.params.criteria,
      '(Created_Time:greater_equal:2026-07-01T00:00:00+05:30)and(Created_Time:less_than:2026-08-01T00:00:00+05:30)');
  } finally {
    zohoClient.get = originalGet;
  }
});

test('filtered company query uses server-side criteria and bounded limit', async () => {
  const originalGet = zohoClient.get;
  const requests = [];

  zohoClient.get = async (url, config) => {
    requests.push({ url, config });
    return {
      data: {
        data: [{ id: 'lead-abc', Company: 'ABC' }],
        info: { count: 1, more_records: true },
      },
    };
  };

  try {
    await recordsService.getRecords('leads', {
      operation: 'query',
      criteria: '(Company:equals:ABC)',
      retrieval_mode: 'filtered',
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/crm/v8/Leads');
    assert.equal(requests[0].config.params.page, 1);
    assert.equal(requests[0].config.params.per_page, DEFAULT_LIMITED_PER_PAGE);
    assert.equal(requests[0].config.params.criteria, '(Company:equals:ABC)');
  } finally {
    zohoClient.get = originalGet;
  }
});
