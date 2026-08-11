const test = require('node:test');
const assert = require('node:assert/strict');
const { createDisplayState, getDisplayBatch } = require('../src/crm/services/assistant/display-batching.service');
const { formatResponse } = require('../src/crm/services/assistant/formatter.service');

function listPlan() {
  return { question: 'Show matching leads', intents: ['LIST'], modules: ['leads'], timeRange: { label: 'all time' } };
}

function formatRecords(records, offset = 0) {
  const batch = getDisplayBatch(createDisplayState(records, offset));
  return formatResponse(listPlan(), [{ module: 'leads', result: { data: records, info: { retrievalComplete: true } } }], [], {
    displayRecords: batch.records,
    displayStart: batch.start,
    displayTotal: batch.total,
  });
}

test('display batching returns all records when there are 10 or 25 matches', () => {
  [10, 25].forEach((count) => {
    const response = formatRecords(Array.from({ length: count }, (_, index) => ({ id: String(index) })));
    assert.equal(response.data.length, count);
    assert.match(response.summary, new RegExp(`Showing ${count} of ${count} matching records`));
    assert.doesNotMatch(response.summary, /more matching records/);
  });
});

test('display batching reports remaining records without shrinking the search dataset', () => {
  const records = Array.from({ length: 60 }, (_, index) => ({ id: String(index) }));
  const first = formatRecords(records);
  const secondBatch = getDisplayBatch(createDisplayState(records, first.data.length));
  const second = formatRecords(records, secondBatch.start);

  assert.equal(first.data.length, 25);
  assert.match(first.summary, /Showing 25 of 60 matching records\. There are 35 more/);
  assert.deepEqual(second.data.map((record) => record.id), records.slice(25, 50).map((record) => record.id));
  assert.match(second.summary, /Showing 25 of 60 matching records\. There are 10 more/);
});

test('zero matches use the required no-match response', () => {
  const response = formatRecords([]);
  assert.equal(response.summary, 'No matching CRM records were found for the requested period.');
  assert.deepEqual(response.data, []);
});