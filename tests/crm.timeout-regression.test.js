const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const app = require('../src/app');
const RetrievalEngine = require('../src/crm/services/retrieval-engine.service');
const { zohoClient } = require('../src/common/config/axios');

function records(module, count, offset = 0) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${module}-${offset + index + 1}`,
    ...(module === 'leads' ? { First_Name: `Lead ${index + 1}`, Company: 'Acme' } : {}),
    ...(module === 'deals' ? {
      Deal_Name: `Deal ${index + 1}`,
      Amount: 125000,
      Stage: 'Closed Won',
      Closing_Date: '2026-06-15T00:00:00Z',
    } : {}),
    ...(module === 'contacts' ? { First_Name: `Contact ${index + 1}`, Email: `contact-${index + 1}@example.com` } : {}),
  }));
}

test('CRM transport uses bounded timeouts and pooled keep-alive connections', () => {
  assert.equal(zohoClient.defaults.timeout, 15000);
  assert.equal(zohoClient.defaults.httpAgent.options.keepAlive, true);
  assert.equal(zohoClient.defaults.httpsAgent.options.keepAlive, true);
});

test('local CRM assistant endpoint stays bounded for the five timeout scenarios', async () => {
  const originalGet = zohoClient.get;
  const originalPost = zohoClient.post;
  const calls = [];
  zohoClient.get = async (url, config = {}) => {
    calls.push({ method: 'GET', url, config });
    const module = url.includes('/Leads') ? 'leads' : url.includes('/Contacts') ? 'contacts' : 'deals';
    const count = Number(config.params?.per_page || 25);
    return { data: { data: records(module, count), info: { count, more_records: false } } };
  };
  zohoClient.post = async (_url, body) => {
    const query = body.select_query;
    calls.push({ method: 'POST', query });
    if (/sum\(/i.test(query)) {
      return { data: { data: [{ record_count: 4, sum_value: 500000 }], info: { more_records: false } } };
    }
    return { data: { data: records('deals', 30), info: { more_records: false } } };
  };

  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const cases = [
    { question: 'Give me 10 leads', expected: 10 },
    { question: 'Give me 10 deals', expected: 10 },
    { question: 'Give me 10 contacts', expected: 10 },
    { question: 'Give me Closed Won deals in June 2026', expected: 25 },
    { question: 'What was the total Closed Won value in June 2026?', expected: 0 },
  ];
  const timings = [];

  try {
    for (const scenario of cases) {
      const startedAt = performance.now();
      const response = await fetch(`${baseUrl}/api/crm/assistant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: scenario.question }),
      });
      const elapsedMs = Number((performance.now() - startedAt).toFixed(2));
      const payload = await response.json();
      timings.push({ question: scenario.question, elapsedMs });
      assert.equal(response.status, 200, scenario.question);
      assert.equal(payload.success, true, scenario.question);
      assert.equal(payload.data.length, scenario.expected, scenario.question);
      if (/Closed Won deals/i.test(scenario.question)) {
        assert.equal(payload.continuation.available, true);
        assert.equal(payload.continuation.remainingRecords, 5);
      }
      assert.ok(elapsedMs < 30000, `${scenario.question} exceeded the connector budget`);
    }

    const leadCall = calls.find((call) => call.url?.endsWith('/Leads'));
    const dealCall = calls.find((call) => call.url?.endsWith('/Deals'));
    const contactCall = calls.find((call) => call.url?.endsWith('/Contacts'));
    const filteredQuery = calls.find((call) => call.query && /from Deals/i.test(call.query) && /Closed Won/i.test(call.query));
    const aggregateQuery = calls.find((call) => call.query && /sum\(/i.test(call.query));

    assert.equal(leadCall.config.params.per_page, 10);
    assert.equal(leadCall.config.signal instanceof AbortSignal, true);
    assert.equal(dealCall.config.params.per_page, 10);
    assert.equal(contactCall.config.params.per_page, 10);
    assert.match(filteredQuery.query, /Stage\s*=\s*'Closed Won'/i);
    assert.match(filteredQuery.query, /Closing_Date\s*>=\s*'2026-06-01/i);
    assert.match(filteredQuery.query, /Closing_Date\s*<\s*'2026-07-01/i);
    assert.match(filteredQuery.query, /select .*Deal_Name.*Account_Name.*Amount.*Closing_Date.*Stage.*Owner/i);
    assert.match(aggregateQuery.query, /sum\(Amount\)/i);
    assert.match(aggregateQuery.query, /Stage\s*=\s*'Closed Won'/i);

    // Keep timing output attached to the test for CI diagnostics without
    // exposing CRM records or credentials.
    console.log(`[CRM timeout regression] ${JSON.stringify(timings)}`);
    assert.equal(timings.length, 5);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    zohoClient.get = originalGet;
    zohoClient.post = originalPost;
  }
});

test('timed-out complete retrievals fail once without repeating the CRM request', async () => {
  const originalGet = zohoClient.get;
  let calls = 0;
  zohoClient.get = async () => {
    calls += 1;
    const error = new Error('CRM request timed out');
    error.code = 'ECONNABORTED';
    throw error;
  };

  try {
    await assert.rejects(
      RetrievalEngine.getRecords('leads', { retrieval_mode: 'all', question: 'Show all leads' }),
      /CRM request timed out/,
    );
    assert.equal(calls, 1);
  } finally {
    zohoClient.get = originalGet;
  }
});

test('COQL scope failures fall back to the same exact CRM Search criteria', async () => {
  const originalGet = zohoClient.get;
  const originalPost = zohoClient.post;
  const requests = [];
  zohoClient.post = async () => {
    const error = new Error('invalid oauth scope to access this URL');
    error.response = { status: 401, data: { message: 'invalid oauth scope to access this URL' } };
    throw error;
  };
  zohoClient.get = async (_url, config) => {
    requests.push(config);
    if (_url.includes('/actions/count')) {
      return { data: { count: 2 } };
    }
    return {
      data: {
        data: [
          { id: 'deal-1', Amount: 125000, Stage: 'Closed Won', Closing_Date: '2026-06-15T00:00:00Z' },
          { id: 'deal-2', Amount: 375000, Stage: 'Closed Won', Closing_Date: '2026-06-20T00:00:00Z' },
        ],
        info: { more_records: false },
      },
    };
  };
  const criteria = '(Stage:equals:Closed Won)and(Closing_Date:greater_equal:2026-06-01T00:00:00Z)and(Closing_Date:less_than:2026-07-01T00:00:00Z)';

  try {
    const recordsResult = await RetrievalEngine.getRecords('deals', {
      question: 'Give me Closed Won deals in June 2026',
      criteria,
      fields: ['id', 'Deal_Name', 'Stage', 'Closing_Date'],
      retrieval_mode: 'all',
      force_coql: true,
    });
    assert.equal(recordsResult.data.length, 2);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].params.criteria, criteria);

    requests.length = 0;
    const aggregateResult = await RetrievalEngine.getRecords('deals', {
      question: 'What was the total Closed Won value in June 2026?',
      criteria,
      aggregate_field: 'Amount',
      aggregate_metrics: ['sum'],
      retrieval_mode: 'aggregate',
      force_coql: true,
    });
    assert.equal(aggregateResult.data.length, 0);
    assert.equal(aggregateResult.info.aggregateValues.sum, 500000);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].params.criteria, criteria);

    requests.length = 0;
    const countResult = await RetrievalEngine.getRecords('deals', {
      question: 'How many Closed Won deals were created in June 2026?',
      criteria,
      retrieval_mode: 'count',
      force_coql: true,
    });
    assert.equal(countResult.info.count, 2);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].params.criteria, criteria);
  } finally {
    zohoClient.get = originalGet;
    zohoClient.post = originalPost;
  }
});
