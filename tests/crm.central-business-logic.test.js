const test = require('node:test');
const assert = require('node:assert/strict');

const app = require('../src/app');
const retrievalEngine = require('../src/crm/services/retrieval-engine.service');
const { zohoClient } = require('../src/common/config/axios');
const closedWonDateService = require('../src/crm/services/closed-won-date-service');
const dashboardService = require('../src/crm/services/dashboard.service');
const { resolveBusinessRequest } = require('../src/crm/services/intent-resolution.service');

function axiosError(status, code, message) {
  return Object.assign(new Error(message || 'Request failed'), {
    response: { status, data: { code, message } },
    isAxiosError: true,
  });
}

function timeoutError() {
  return Object.assign(new Error('timeout of 15000ms exceeded'), {
    code: 'ECONNABORTED',
    isAxiosError: true,
  });
}

// ---------------------------------------------------------------
// PART 7 — getActualClosedWonTransitions (dedicated function)
// ---------------------------------------------------------------
test('7a. getActualClosedWonTransitions returns the normalized output shape', () => {
  const deals = [
    { id: 'd1', Deal_Name: 'Cloud Deal', Amount: 100000, Stage: 'Closed Won', Account_Name: { name: 'Acme' }, Owner: { name: 'Sanjay' }, Closing_Date: '2026-07-05' },
  ];
  const history = [
    { record_id: 'd1', field: 'Stage', old_value: 'Negotiation', new_value: 'Closed Won', audited_time: '2026-07-10T00:00:00+05:30' },
  ];
  const result = closedWonDateService.getActualClosedWonTransitions(deals, history, {
    from: '2026-07-01T00:00:00+05:30',
    to: '2026-08-01T00:00:00+05:30',
  });
  assert.equal(result.length, 1);
  assert.deepEqual(Object.keys(result[0]).sort(), [
    'accountName', 'actualClosedWonDate', 'amount', 'closingDate', 'dealId', 'dealName', 'newStage', 'owner', 'previousStage',
  ]);
  assert.equal(result[0].dealName, 'Cloud Deal');
  assert.equal(result[0].accountName, 'Acme');
  assert.equal(result[0].amount, 100000);
  assert.equal(result[0].owner, 'Sanjay');
  assert.equal(result[0].previousStage, 'Negotiation');
  assert.equal(result[0].newStage, 'Closed Won');
  // The actual date MUST come from stage history, never Closing_Date.
  assert.equal(result[0].actualClosedWonDate, '2026-07-10T00:00:00+05:30');
  assert.equal(result[0].closingDate, '2026-07-05');
});

test('7b. getActualClosedWonTransitions uses half-open range — no August leakage into July', () => {
  const deals = [
    { id: 'j', Deal_Name: 'July', Amount: 1, Stage: 'Closed Won', Closing_Date: '2026-07-31' },
    { id: 'a', Deal_Name: 'August', Amount: 2, Stage: 'Closed Won', Closing_Date: '2026-08-20' },
  ];
  const history = [
    { record_id: 'j', field: 'Stage', old_value: 'Open', new_value: 'Closed Won', timestamp: '2026-07-31T23:59:59+05:30' },
    { record_id: 'a', field: 'Stage', old_value: 'Open', new_value: 'Closed Won', timestamp: '2026-08-01T00:00:00+05:30' },
    { record_id: 'a', field: 'Stage', old_value: 'Open', new_value: 'Closed Won', timestamp: '2026-08-20T00:00:00+05:30' },
  ];
  const result = closedWonDateService.getActualClosedWonTransitions(deals, history, {
    from: '2026-07-01T00:00:00+05:30',
    to: '2026-08-01T00:00:00+05:30',
  });
  assert.deepEqual(result.map((r) => r.dealId), ['j']);
});

test('7c. closed-won-to-closed-won and Closed Lost transitions are excluded', () => {
  const history = [
    { record_id: 'x', field: 'Stage', old_value: 'Closed Won', new_value: 'Closed Won', audited_time: '2026-07-10T00:00:00Z' },
    { record_id: 'x', field: 'Stage', old_value: 'Open', new_value: 'Closed Lost', audited_time: '2026-07-10T00:00:00Z' },
  ];
  const result = closedWonDateService.getActualClosedWonTransitions([], history, {
    from: '2026-07-01',
    to: '2026-08-01',
  });
  assert.equal(result.length, 0);
});

// ---------------------------------------------------------------
// PART 15 — Dashboard reconciliation (consistent data reconciles)
// ---------------------------------------------------------------
test('15a. Dashboard reconciles consistently and does not report an error', async () => {
  const originalGetRecords = retrievalEngine.getRecords;
  try {
    retrievalEngine.getRecords = async (module) => {
      if (module === 'deals') {
        return {
          data: [
            { id: '1', Deal_Name: 'A', Amount: 200000, Stage: 'Closed Won', Owner: { name: 'Sanjay' }, Closing_Date: '2026-07-15' },
            { id: '2', Deal_Name: 'B', Amount: 300000, Stage: 'Closed Won', Owner: { name: 'Ravi' }, Closing_Date: '2026-07-20' },
            { id: '3', Deal_Name: 'C', Amount: 100000, Stage: 'Open', Owner: { name: 'Priya' }, Closing_Date: '2026-07-22' },
          ],
          info: { count: 3, more_records: false },
        };
      }
      return { data: [], info: { count: 0 } };
    };
    const result = await dashboardService.getDashboard({
      question: 'Create a sales dashboard for July 2026',
      type: 'sales',
      dateRange: { from: '2026-07-01', to: '2026-08-01' },
    });
    assert.equal(result.crmError, undefined);
    assert.equal(result.metrics.closedWonCount, 2);
    assert.equal(result.metrics.closedWonRevenue, 500000);
    // Employee revenue must reconcile to closed won revenue.
    const empTotal = result.metrics.employeeRevenue.reduce((sum, e) => sum + e.revenue, 0);
    assert.equal(empTotal, result.metrics.closedWonRevenue);
  } finally {
    retrievalEngine.getRecords = originalGetRecords;
  }
});


// ---------------------------------------------------------------
// PART 18/19/29/32 — Zoho API errors must NEVER become zero data
// ---------------------------------------------------------------
test('32a. Zoho 400/401/403/404/429/500/timeout cause a thrown error, not a zero count', async () => {
  const statuses = [400, 401, 403, 404, 429, 500];
  for (const status of statuses) {
    const originalGet = zohoClient.get;
    const originalPost = zohoClient.post;
    zohoClient.get = async () => { throw axiosError(status, `CODE_${status}`, `Zoho returned ${status}`); };
    zohoClient.post = async () => { throw axiosError(status, `CODE_${status}`, `Zoho returned ${status}`); };
    try {
      await assert.rejects(
        () => retrievalEngine.getCount('deals', { question: 'How many Closed Won deals are there?' }),
        (err) => Boolean(err && (err.isAxiosError || err.response?.status)),
        `status ${status} must be surfaced as an error, not a zero count`,
      );
    } finally {
      zohoClient.get = originalGet;
      zohoClient.post = originalPost;
    }
  }

  // Timeout
  const originalGet = zohoClient.get;
  const originalPost = zohoClient.post;
  zohoClient.get = async () => { throw timeoutError(); };
  zohoClient.post = async () => { throw timeoutError(); };
  try {
    await assert.rejects(
      () => retrievalEngine.getCount('deals', { question: 'How many Closed Won deals are there?' }),
      (err) => Boolean(err && (err.code === 'ECONNABORTED' || err.isAxiosError)),
      'timeout must be surfaced as an error, not a zero count',
    );
  } finally {
    zohoClient.get = originalGet;
    zohoClient.post = originalPost;
  }
});

test('32b. dashboard endpoint returns success=false (never zero success) on a CRM 400', async () => {
  const originalGet = zohoClient.get;
  const originalPost = zohoClient.post;
  zohoClient.get = async () => { throw axiosError(400, 'INVALID_QUERY', 'field is not available for search'); };
  zohoClient.post = async () => { throw axiosError(400, 'INVALID_QUERY', 'field is not available for search'); };

  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${baseUrl}/api/crm/dashboard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request: 'Create a sales dashboard for July 2026', from: '2026-07-01', to: '2026-08-01' }),
    });
    const payload = await response.json();
    assert.equal(payload.success, false);
    assert.equal(payload.error.code, 'CRM_API_ERROR');
    assert.ok(payload.error.message && payload.error.message.length > 0);
    // The failed query must never be presented as a zero metric.
    assert.notEqual(payload.metrics, 0);
  } finally {
    server.close();
    zohoClient.get = originalGet;
    zohoClient.post = originalPost;
  }
});

test('32c. query endpoint surfaces a Zoho 400 as success=false, not empty data', async () => {
  const originalGet = zohoClient.get;
  const originalPost = zohoClient.post;
  zohoClient.get = async () => { throw axiosError(400, 'INVALID_QUERY', 'invalid field'); };
  zohoClient.post = async () => { throw axiosError(400, 'INVALID_QUERY', 'invalid field'); };

  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${baseUrl}/api/crm/deals?question=${encodeURIComponent('Give me Closed Won deals with a closing date in July.')}`, {
      method: 'GET',
    });
    const payload = await response.json();
    assert.equal(payload.success, false);
  } finally {
    server.close();
    zohoClient.get = originalGet;
    zohoClient.post = originalPost;
  }
});

// ---------------------------------------------------------------
// PART 4 — "last month" is July 1 → Aug 1 exclusive (current date 2026-08-17)
// ---------------------------------------------------------------
test('4a. resolves to the previous month with a half-open interval', () => {
  const request = resolveBusinessRequest('Give me deals from last month.');
  assert.equal(request.from.slice(0, 10), '2026-07-01');
  assert.equal(request.to.slice(0, 10), '2026-08-01');
});

// ---------------------------------------------------------------
// PART 6 — the three Closed Won date meanings stay distinct
// ---------------------------------------------------------------
test('6a. current-status vs closing-date vs actual transition are distinct', () => {
  const current = resolveBusinessRequest('Which deals are already Closed Won?');
  assert.equal(current.date_field, null);
  assert.equal(current.dateMeaning, 'current_status');
  assert.equal(current.requires_stage_history, false);

  const withClosingDate = resolveBusinessRequest('Which Closed Won deals have a closing date in July?');
  assert.equal(withClosingDate.date_field, 'Closing_Date');
  assert.equal(withClosingDate.status, 'Closed Won');

  const actual = resolveBusinessRequest('Which deals actually became Closed Won in July?');
  assert.equal(actual.requires_stage_history, true);
  assert.equal(actual.dateMeaning, 'actual_closed_won_date');
});
