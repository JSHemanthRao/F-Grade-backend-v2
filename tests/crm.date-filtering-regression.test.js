const { test } = require('node:test');
const assert = require('node:assert');
const { buildExecutionPlan } = require('../src/crm/services/assistant/planner.service');
const { resolveBusinessRequest } = require('../src/crm/services/intent-resolution.service');

test('Date Filtering Regression Suite', async (suite) => {
  test('Closed Won deals for July uses Closing_Date filter, not stage history', () => {
    // This is the critical bug: "Closed Won deals last month" was returning deals
    // with Closing_Date in August instead of July
    const businessRequest = resolveBusinessRequest('give me closed won deals last month');
    
    // Verify the request is correctly interpreted
    assert.equal(businessRequest.module, 'deals', 'Should resolve to deals module');
    assert.equal(businessRequest.status, 'Closed Won', 'Should detect Closed Won status');
    assert.equal(businessRequest.date_field, 'Closing_Date', 'Should use Closing_Date field');
    assert.equal(businessRequest.requires_stage_history, false, 'Should NOT require stage history');
    assert.equal(businessRequest.dateMeaning, 'closing_date', 'Should interpret as closing_date meaning');
    
    // Verify date range is correct (current date: 2026-08-17, last month: July)
    assert.equal(businessRequest.from, '2026-07-01T00:00:00Z', 'Should start from July 1st');
    assert.equal(businessRequest.to, '2026-08-01T00:00:00Z', 'Should end before August 1st');
  });

  test('Deals that became Closed Won in July uses stage history, not Closing_Date', () => {
    // This is the contrasting case: when user asks about when a deal transitioned
    const businessRequest = resolveBusinessRequest('deals that became closed won in July');
    
    assert.equal(businessRequest.module, 'deals', 'Should resolve to deals module');
    assert.equal(businessRequest.status, 'Closed Won', 'Should detect Closed Won status');
    assert.equal(businessRequest.requires_stage_history, true, 'Should require stage history');
    assert.equal(businessRequest.dateMeaning, 'actual_closed_won_date', 'Should interpret as actual_closed_won_date meaning');
  });

  test('Closed Won deals (no period) uses current status, not date filter', () => {
    // When user asks about currently Closed Won deals without mentioning a date
    const businessRequest = resolveBusinessRequest('show me closed won deals');
    
    assert.equal(businessRequest.module, 'deals', 'Should resolve to deals module');
    assert.equal(businessRequest.status, 'Closed Won', 'Should detect Closed Won status');
    assert.equal(businessRequest.date_field, null, 'Should NOT filter by date');
    assert.equal(businessRequest.requires_stage_history, false, 'Should NOT require stage history');
    assert.equal(businessRequest.dateMeaning, 'current_status', 'Should interpret as current_status');
  });

  test('Execution plan for "closed won deals last month" applies Closing_Date filter', () => {
    const plan = buildExecutionPlan('give me closed won deals last month');
    const queryPlan = plan.queryPlan;
    
    assert.equal(queryPlan.dateField, 'Closing_Date', 'Query plan should use Closing_Date field');
    assert.equal(queryPlan.startDate, '2026-07-01T00:00:00Z', 'Query plan should start from July 1st');
    assert.equal(queryPlan.endDate, '2026-08-01T00:00:00Z', 'Query plan should end before August 1st');
    
    // Verify the filter exists and uses the correct field
    const dateFilter = queryPlan.filters.find(f => f.logicalField === 'date');
    assert.ok(dateFilter, 'Should have a date filter');
    assert.equal(dateFilter.field, 'Closing_Date', 'Date filter should use Closing_Date');
  });

  test('Deals created in June uses Created_Time, not Closing_Date', () => {
    const businessRequest = resolveBusinessRequest('deals created in June 2026');
    
    assert.equal(businessRequest.module, 'deals', 'Should resolve to deals module');
    assert.equal(businessRequest.date_field, 'Created_Time', 'Should use Created_Time field for created queries');
    assert.equal(businessRequest.dateMeaning, null, 'dateMeaning should be null (handled by keywords)');
  });

  test('Regular period queries (no closed won status) use Closing_Date by default', () => {
    const businessRequest = resolveBusinessRequest('give me deals for July');
    
    assert.equal(businessRequest.module, 'deals', 'Should resolve to deals module');
    assert.equal(businessRequest.date_field, 'Closing_Date', 'Should use Closing_Date as default date field');
    assert.equal(businessRequest.dateMeaning, 'closing_date', 'Should interpret as closing_date');
  });
});
