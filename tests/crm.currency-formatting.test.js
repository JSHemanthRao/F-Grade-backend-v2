const test = require('node:test');
const assert = require('node:assert/strict');
const { formatCurrency, formatNumber } = require('../src/crm/services/assistant/currency.service');
const { formatResponse } = require('../src/crm/services/assistant/formatter.service');

test('currency formatter uses INR and Indian grouping without converting the CRM amount', () => {
  // Required regression checks
  assert.equal(formatCurrency(43660), '₹43,660');
  assert.equal(formatCurrency(1250000), '₹12,50,000');
  assert.equal(formatCurrency(1250000.50), '₹12,50,000.50');
  assert.equal(formatCurrency('1250000.50'), '₹12,50,000.50');
  assert.equal(formatCurrency(25355), '₹25,355');
  assert.equal(formatCurrency(540000), '₹5,40,000');
  assert.equal(formatCurrency(1000), '₹1,000');
  assert.equal(formatCurrency(100000), '₹1,00,000');
  assert.equal(formatCurrency(1000000), '₹10,00,000');
});

test('currency formatter supports explicit USD and multi-currency when record is explicitly in USD', () => {
  assert.equal(formatCurrency(43660, 'USD'), '$43,660');
  assert.equal(formatCurrency(1250000, 'USD'), '$1,250,000');
  assert.equal(formatCurrency(43660, null, '$'), '$43,660');
  assert.equal(formatCurrency(43660, 'EUR'), '€43,660');
  assert.equal(formatCurrency(43660, 'INR'), '₹43,660');
});

test('CRM monetary fields and calculated monetary metrics are displayed in INR', () => {
  const sourceRecord = {
    id: 'deal-1',
    Amount: '$25,355',
    Closed_Won_Value: 540000,
    Pipeline_Value: 1250000,
    Total_Records: 3,
  };
  const response = formatResponse(
    { question: 'Show deal values', intents: ['LIST'], modules: ['deals'], timeRange: { label: 'all time' } },
    [{ module: 'deals', result: { data: [sourceRecord], info: { retrievalComplete: true } } }],
    [
      { type: 'closed_won_value', label: 'Closed Won Value', value: 540000 },
      { type: 'pipeline', label: 'Pipeline Value', value: 1250000 },
      { type: 'total_revenue', label: 'Total Revenue', value: 1275355 },
      { type: 'comparison', label: 'Comparison', value: { 'this month': 25355, 'last month': 540000, difference: -514645 } },
    ],
  );

  assert.deepEqual(response.data[0], {
    id: 'deal-1',
    Amount: '₹25,355',
    Closed_Won_Value: '₹5,40,000',
    Pipeline_Value: '₹12,50,000',
    Total_Records: 3,
  });
  assert.deepEqual(response.keyMetrics.map((metric) => metric.value), [
    '₹5,40,000',
    '₹12,50,000',
    '₹12,75,355',
    { 'this month': '₹25,355', 'last month': '₹5,40,000', difference: '-₹5,14,645' },
  ]);
  assert.doesNotMatch(JSON.stringify(response.data), /\$|USD/);
  assert.equal(sourceRecord.Amount, '$25,355');
});

test('formatDisplayedRecord preserves USD when record explicitly declares Currency: USD', () => {
  const usdRecord = {
    id: 'deal-usd',
    Amount: 43660,
    Currency: 'USD',
  };
  const response = formatResponse(
    { question: 'Show USD deal', intents: ['LIST'], modules: ['deals'] },
    [{ module: 'deals', result: { data: [usdRecord], info: { retrievalComplete: true } } }],
    [],
  );

  assert.equal(response.data[0].Amount, '$43,660');
});

