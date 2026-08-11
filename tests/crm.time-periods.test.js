const test = require('node:test');
const assert = require('node:assert/strict');
const { detectTimeRange } = require('../src/crm/services/assistant/time-detector.service');
const { buildExecutionPlan } = require('../src/crm/services/assistant/planner.service');
const { buildQueryPlan } = require('../src/crm/services/query-builder.service');
const { formatResponse } = require('../src/crm/services/assistant/formatter.service');

const forbiddenInferredWording = /partial month|as of July 8|as of \w+ \d+|through July 15|likely incomplete|appears incomplete|probably incomplete|strongly suggests/i;

test('last 6 months is a historical-only complete range', () => {
  const range = detectTimeRange('Show monthly deal totals for the last 6 months');
  assert.equal(range.monthCount, 6);
  assert.equal(range.historicalOnly, true);
  assert.equal(range.includesCurrentMonth, false);

  const query = buildQueryPlan('deals', { question: 'Show deals for the last 6 months' });
  const now = new Date();
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().replace('.000Z', 'Z');
  assert.match(query.whereClause, new RegExp(`Closing_Date < '${currentMonthStart.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}'`));
});

test('last 12 months excludes the current month', () => {
  const range = detectTimeRange('last 12 months');
  assert.equal(range.monthCount, 12);
  assert.equal(range.historicalOnly, true);
  assert.equal(range.includesCurrentMonth, false);
});

test('current month, month-to-date, and previous month have explicit period semantics', () => {
  assert.equal(detectTimeRange('current month').includesCurrentMonth, true);
  assert.equal(detectTimeRange('month-to-date').includesCurrentMonth, true);
  assert.equal(detectTimeRange('previous month').historicalOnly, true);
  assert.equal(detectTimeRange('last month').historicalOnly, true);
});

test('historical-only named month is complete and current month gets the MTD label', () => {
  const historical = detectTimeRange('July deals');
  assert.equal(historical.historicalOnly, true);
  assert.equal(historical.includesCurrentMonth, false);

  const current = detectTimeRange(`${new Date().toLocaleString('en-US', { month: 'long' })} deals`);
  const response = formatResponse(
    { question: 'Current month deals', timeRange: current, steps: [], modules: ['deals'], intents: ['LIST'] },
    [{ module: 'deals', result: { data: [{ id: 'd1' }], info: { count: 1 } } }],
    [],
  );
  assert.match(response.summary, /Current Month \(Month-to-Date\)/);
  assert.doesNotMatch(response.summary, forbiddenInferredWording);
});

test('CRM-provided cutoff is displayed verbatim and no cutoff is inferred', () => {
  const withCutoff = formatResponse(
    { question: 'Show deals', timeRange: detectTimeRange('last month'), steps: [], modules: ['deals'], intents: ['LIST'] },
    [{ module: 'deals', result: { data: [{ id: 'd1' }], info: { data_available_through: '2026-07-15' } } }],
    [],
  );
  assert.match(withCutoff.summary, /Data available through 2026-07-15\./);

  const withoutCutoff = formatResponse(
    { question: 'Show deals', timeRange: detectTimeRange('last month'), steps: [], modules: ['deals'], intents: ['LIST'] },
    [{ module: 'deals', result: { data: [{ id: 'd1' }], info: { count: 1 } } }],
    [],
  );
  assert.doesNotMatch(withoutCutoff.summary, /Data available through|as of|partial/i);
  assert.doesNotMatch(withoutCutoff.summary, forbiddenInferredWording);
});

test('response exposes the required evidence sections and reports uncovered months', () => {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1));
  const months = Array.from({ length: 3 }, (_, index) => new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + index, 1)).toISOString().slice(0, 7));
  const response = formatResponse(
    { question: 'Monthly deal values for the last 3 months', timeRange: detectTimeRange('last 3 months'), steps: [], modules: ['deals'], intents: ['COMPARE'] },
    [{ module: 'deals', result: { data: [
      { id: 'd1', Amount: 100, Closing_Date: `${months[0]}-10` },
      { id: 'd2', Amount: 200, Closing_Date: `${months[2]}-10` },
    ], info: { more_records: true } } }],
    [{ type: 'sum', label: 'Sum', value: 300 }],
  );

  const required = ['success', 'summary', 'retrievedDataCoverage', 'requestedInformation', 'calculatedMetrics', 'businessObservations', 'limitations'];
  required.forEach((key) => assert.ok(Object.keys(response).includes(key), `Missing response key: ${key}`));
  assert.deepEqual(response.retrievedDataCoverage.monthsWithData, [months[0], months[2]]);
  assert.deepEqual(response.retrievedDataCoverage.monthsWithoutRetrievedRecords, [months[1]]);
  assert.equal(response.retrievedDataCoverage.retrievedDataCoverage.includes('could not be confirmed'), true);
  assert.equal(response.limitations.some((item) => /entire requested period/.test(item)), true);
  assert.doesNotMatch(JSON.stringify(response), /retrieved dataset|first page|latest records|pagination|backend|connector|~/i);
});

test('follow-up questions use fields present in returned CRM records', () => {
  const response = formatResponse(
    { question: 'Show deals', timeRange: { label: 'all time', range: 'all_time' }, steps: [], modules: ['deals'], intents: ['LIST'] },
    [{ module: 'deals', result: { data: [{ id: 'd1', Owner: { name: 'Asha' }, Amount: 500 }], info: { retrievalComplete: true } } }],
    [],
  );
  assert.ok(response.suggestedNextAnalysis.length > 0);
  assert.doesNotMatch(JSON.stringify(response.suggestedNextAnalysis), /forecast|dashboard|report|analytics|chart/i);
});

test('response coverage uses business-facing incomplete-period labels', () => {
  const response = formatResponse(
    { question: 'Monthly deal values', timeRange: detectTimeRange('last 3 months'), steps: [], modules: ['deals'], intents: ['COMPARE'] },
    [{ module: 'deals', result: { data: [{ id: 'd1', Closing_Date: '2026-06-10', Amount: 100 }], info: { more_records: true } } }],
    [],
  );

  assert.equal(response.retrievedDataCoverage.dataCoverage, response.retrievedDataCoverage.retrievedDataCoverage);
  assert.deepEqual(response.retrievedDataCoverage.unavailablePeriods, response.retrievedDataCoverage.monthsWithoutRetrievedRecords);
  assert.doesNotMatch(JSON.stringify(response), /retrieved dataset|first page|latest records|pagination|backend|api|connector|approx\.?|around|roughly|approximately|~/i);
});

test('response keeps only factual business observations', () => {
  const response = formatResponse(
    { question: 'Deal values', timeRange: { label: 'all time', range: 'all_time' }, steps: [], modules: ['deals'], intents: ['LIST'] },
    [{ module: 'deals', result: { data: [{ id: 'd1', Owner: { name: 'Asha' }, Amount: 500 }], info: { retrievalComplete: true } } }],
    [],
    {
      insights: [
        { type: 'increase', message: 'August value increased from 100 in July to 500 in August.' },
        { type: 'top_performer', message: 'Sales performance surged.' },
        { type: 'unsupported', message: 'Pipeline remains strong.' },
      ],
    },
  );

  assert.deepEqual(response.businessObservations, [
    { type: 'increase', message: 'August value increased from 100 in July to 500 in August.' },
  ]);
  assert.doesNotMatch(JSON.stringify(response), /surged|strong momentum|healthy growth|pipeline remains strong/i);
});
