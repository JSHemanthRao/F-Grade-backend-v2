const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateClosedWonMetrics,
  getClosedWonDeals,
} = require('../src/crm/services/closed-won-date-service');
const dashboardService = require('../src/crm/services/dashboard.service');
const recordsService = require('../src/crm/services/retrieval-engine.service');

const AUGUST_DEALS = [
  { id: '1', Deal_Name: 'A', Amount: '₹1,25,000.50', Stage: 'Closed Won', Closing_Date: '2026-08-01' },
  { id: '2', Deal_Name: 'B', Amount: 200000.25, Stage: 'Closed Won', Closing_Date: '2026-08-05' },
  { id: '3', Deal_Name: 'C', Amount: '200333', Stage: 'Closed Won', Closing_Date: '2026-08-12' },
  { id: '4', Deal_Name: 'D', Amount: 90000, Stage: 'Closed Won', Closing_Date: '2026-08-20' },
  { id: '5', Deal_Name: 'E', Amount: 51000, Stage: 'Closed Won', Closing_Date: '2026-08-25' },
  { id: '6', Deal_Name: 'F', Amount: 1.22, Stage: 'Closed Won', Closing_Date: '2026-08-26' },
  { id: '7', Deal_Name: 'G', Amount: null, Stage: 'Closed Won', Closing_Date: '2026-08-27' },
  { id: '8', Deal_Name: 'H', Amount: 0, Stage: 'Closed Won', Closing_Date: '2026-08-31' },
  { id: 'future', Deal_Name: 'Future', Amount: 999999, Stage: 'Closed Won', Closing_Date: '2026-12-31' },
  { id: 'open', Deal_Name: 'Open', Amount: 999999, Stage: 'Negotiation/Review', Closing_Date: '2026-08-10' },
];

test('Closed Won metrics count and sum the same complete dataset', () => {
  const result = calculateClosedWonMetrics(AUGUST_DEALS, {
    dateFrom: '2026-08-01',
    dateTo: '2026-09-01',
    dateMeaning: 'closing_date',
  });

  assert.equal(result.count, 8);
  assert.equal(result.revenue, 666334.97);
  assert.equal(result.records.length, result.count);
});

test('current Closed Won status does not reject a future Closing_Date', () => {
  const result = calculateClosedWonMetrics(AUGUST_DEALS);
  assert.equal(result.count, 9);
  assert.equal(result.records.some((deal) => deal.id === 'future'), true);
});

test('Closing_Date filters use half-open August and July windows', () => {
  const records = [
    { id: 'aug-start', Stage: 'Closed Won', Amount: 1, Closing_Date: '2026-08-01' },
    { id: 'aug-end', Stage: 'Closed Won', Amount: 2, Closing_Date: '2026-08-31' },
    { id: 'sep-start', Stage: 'Closed Won', Amount: 4, Closing_Date: '2026-09-01' },
    { id: 'jul-end', Stage: 'Closed Won', Amount: 8, Closing_Date: '2026-07-31' },
  ];

  assert.deepEqual(
    getClosedWonDeals(records, { dateFrom: '2026-08-01', dateTo: '2026-09-01', dateMeaning: 'closing_date' }).map((deal) => deal.id),
    ['aug-start', 'aug-end'],
  );
  assert.deepEqual(
    getClosedWonDeals(records, { dateFrom: '2026-07-01', dateTo: '2026-08-01', dateMeaning: 'closing_date' }).map((deal) => deal.id),
    ['jul-end'],
  );
});

test('actual Closed Won date queries cannot be calculated from snapshots', () => {
  assert.throws(
    () => calculateClosedWonMetrics(AUGUST_DEALS, { dateMeaning: 'actual_closed_won_date', dateFrom: '2026-08-01', dateTo: '2026-09-01' }),
    /stage history/i,
  );
});

test('incomplete CRM retrieval is a reconciliation failure, not partial success', async () => {
  const originalGetRecords = recordsService.getRecords;
  try {
    recordsService.getRecords = async (module) => ({
      data: module === 'deals' ? [{ id: 'partial', Stage: 'Closed Won', Amount: 100000 }] : [],
      info: module === 'deals' ? { retrievalComplete: false, more_records: true } : {},
    });
    const result = await dashboardService.getDashboard({ question: 'Create a sales dashboard for August 2026.' });
    assert.equal(result.crmError, true);
    assert.equal(result.errorCode, 'CRM_DATA_RECONCILIATION_ERROR');
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});
