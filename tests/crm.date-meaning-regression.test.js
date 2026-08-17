const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveBusinessRequest } = require('../src/crm/services/intent-resolution.service');
const { buildExecutionPlan } = require('../src/crm/services/assistant/planner.service');
const { filterClosedWonTransitionsInPeriod } = require('../src/crm/services/closed-won-date-service');

test('last month resolves to a July half-open window and never selects August', () => {
  const request = resolveBusinessRequest('Show all deals from last month');
  assert.equal(request.from.slice(0, 10), '2026-07-01');
  assert.equal(request.to.slice(0, 10), '2026-08-01');
  const records = ['2026-07-01', '2026-07-31', '2026-08-20'].filter((date) => date >= request.from.slice(0, 10) && date < request.to.slice(0, 10));
  assert.deepEqual(records, ['2026-07-01', '2026-07-31']);
});

test('Closed Won date meanings stay separate', () => {
  const current = resolveBusinessRequest('Which deals are already Closed Won?');
  const closing = resolveBusinessRequest('Which Closed Won deals have a closing date in July?');
  const actual = resolveBusinessRequest('Give me the Closed Won deals of July.');

  assert.equal(current.dateMeaning, 'current_status');
  assert.equal(current.date_field, null);
  assert.equal(closing.dateMeaning, 'closing_date');
  assert.equal(closing.date_field, 'Closing_Date');
  assert.equal(actual.dateMeaning, 'actual_closed_won_date');
  assert.equal(actual.requires_stage_history, true);
  assert.equal(actual.date_field, null);
});

test('future Closing_Date does not remove a currently Closed Won deal', () => {
  const plan = buildExecutionPlan('Which deals are already Closed Won?');
  assert.equal(plan.queryPlan.dateField, null);
  assert.deepEqual(plan.queryPlan.filters.find((filter) => filter.logicalField === 'stage')?.value, ['Closed Won']);
});

test('close watch requests are not silently assigned a date or status meaning', () => {
  const request = resolveBusinessRequest('Give me a close watch of last month');
  assert.equal(request.requires_clarification, true);
  assert.equal(request.dateMeaning, 'ambiguous');
});

test('stage-history transition filter uses the actual transition timestamp', () => {
  const transitions = filterClosedWonTransitionsInPeriod([
    { record_id: 'july', field: 'Stage', old_value: 'Negotiation', new_value: 'Closed Won', audited_time: '2026-07-31T23:59:59Z' },
    { record_id: 'august', field: 'Stage', old_value: 'Negotiation', new_value: 'Closed Won', audited_time: '2026-08-01T00:00:00Z' },
    { record_id: 'unchanged', field: 'Stage', old_value: 'Closed Won', new_value: 'Closed Won', audited_time: '2026-07-10T00:00:00Z' },
  ], '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z');
  assert.deepEqual(transitions.map((entry) => entry.dealId), ['july']);
});

test('expected-close requests use Closing_Date for next month', () => {
  const plan = buildExecutionPlan('Give me the deals expected to close next month.');
  assert.equal(plan.queryPlan.dateMeaning, 'expected_closing_date');
  assert.equal(plan.queryPlan.dateField, 'Closing_Date');
  assert.equal(plan.queryPlan.startDate.slice(0, 10), '2026-09-01');
  assert.equal(plan.queryPlan.endDate.slice(0, 10), '2026-10-01');
});
