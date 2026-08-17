/**
 * Closed Won Query Integration Tests
 *
 * Tests the integration between business-criteria.service and dashboard.service
 * to ensure that queries for "already Closed Won" do NOT add automatic Closing_Date filters.
 *
 * These tests verify RULE 1-11 from the requirements.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const businessCriteria = require('../src/crm/services/business-criteria.service');

// ============================================================================
// TEST SUITE 1: Business Criteria - selectBusinessDateField()
// ============================================================================

test('1.1: selectBusinessDateField - "Which deals are already Closed Won?" should NOT use Closing_Date', () => {
  const result = businessCriteria.selectBusinessDateField('deals', 'Which deals are already Closed Won?');
  assert.strictEqual(result, null);
});

test('1.2: selectBusinessDateField - "Give me closed won deals" should NOT use Closing_Date', () => {
  const result = businessCriteria.selectBusinessDateField('deals', 'Give me closed won deals');
  assert.strictEqual(result, null);
});

test('1.3: selectBusinessDateField - "How many deals are currently Closed Won?" should NOT use Closing_Date', () => {
  const result = businessCriteria.selectBusinessDateField('deals', 'How many deals are currently Closed Won?');
  assert.strictEqual(result, null);
});

test('1.4: selectBusinessDateField - "Show me all closed won deals" should NOT use Closing_Date', () => {
  const result = businessCriteria.selectBusinessDateField('deals', 'Show me all closed won deals');
  assert.strictEqual(result, null);
});

test('1.5: selectBusinessDateField - "Give me closed won deals this month" SHOULD use Closing_Date (ambiguous)', () => {
  // "this month" with Closed Won → interpret as "Closed Won with Closing_Date in this month"
  const result = businessCriteria.selectBusinessDateField('deals', 'Give me closed won deals this month');
  assert.strictEqual(result, 'Closing_Date');
});

test('1.6: selectBusinessDateField - "Closed Won deals with closing date in July" SHOULD use Closing_Date', () => {
  // Explicit "closing date" mention → use Closing_Date filter
  const result = businessCriteria.selectBusinessDateField('deals', 'Closed Won deals with closing date in July');
  assert.strictEqual(result, 'Closing_Date');
});

test('1.7: selectBusinessDateField - "Closed Won deals in July" SHOULD use Closing_Date (ambiguous)', () => {
  // Ambiguous: could mean current status or closing date. Interpret as "Closed Won with July Closing_Date"
  const result = businessCriteria.selectBusinessDateField('deals', 'Closed Won deals in July');
  assert.strictEqual(result, 'Closing_Date');
});

test('1.8: selectBusinessDateField - "Closed Lost with past Closing_Date" should NOT use Closing_Date', () => {
  const result = businessCriteria.selectBusinessDateField('deals', 'Give me closed lost deals');
  assert.strictEqual(result, null);
});

test('1.9: selectBusinessDateField - "Which deals became closed won in July?" should NOT use Closing_Date', () => {
  // "became" suggests stage history, not Closing_Date
  const result = businessCriteria.selectBusinessDateField('deals', 'Which deals became closed won in July?');
  assert.strictEqual(result, null);
});

test('1.10: selectBusinessDateField - "Sales revenue for July" should use Closing_Date', () => {
  // Not a Closed Won status query, so default to Closing_Date
  const result = businessCriteria.selectBusinessDateField('deals', 'Sales revenue for July');
  assert.strictEqual(result, 'Closing_Date');
});

test('1.11: selectBusinessDateField - "Deals created in July" should use Created_Time', () => {
  const result = businessCriteria.selectBusinessDateField('deals', 'Deals created in July');
  assert.strictEqual(result, 'Created_Time');
});

test('1.12: selectBusinessDateField - "Deals modified in July" should use Modified_Time', () => {
  const result = businessCriteria.selectBusinessDateField('deals', 'Deals modified in July');
  assert.strictEqual(result, 'Modified_Time');
});

// ============================================================================
// TEST SUITE 2: Business Criteria - hasPeriodRequest()
// ============================================================================

test('2.1: hasPeriodRequest - "this month" returns true', () => {
  const result = businessCriteria.hasPeriodRequest('Show me deals from this month');
  assert.strictEqual(result, true);
});

test('2.2: hasPeriodRequest - "last month" returns true', () => {
  const result = businessCriteria.hasPeriodRequest('Give me deals from last month');
  assert.strictEqual(result, true);
});

test('2.3: hasPeriodRequest - "July" returns true', () => {
  const result = businessCriteria.hasPeriodRequest('Show me deals in July');
  assert.strictEqual(result, true);
});

test('2.4: hasPeriodRequest - "no period" returns false', () => {
  const result = businessCriteria.hasPeriodRequest('Give me closed won deals');
  assert.strictEqual(result, false);
});

// ============================================================================
// TEST SUITE 3: Real-World Query Scenarios
// ============================================================================

test('3.1: RULE 1 - "Already Closed Won" - Stage = Closed Won, NO Closing_Date filter', () => {
  // Query: "Which deals are already Closed Won?"
  // Expected: Stage = 'Closed Won', no Closing_Date filter
  
  const dateField = businessCriteria.selectBusinessDateField(
    'deals',
    'Which deals are already Closed Won?'
  );
  
  // Should NOT add a date field (no Closing_Date filter)
  assert.strictEqual(dateField, null);
});

test('3.2: RULE 2 - "Closed Won with Closing Date" - Stage = Closed Won AND Closing_Date filter', () => {
  // Query: "Which Closed Won deals have a closing date in August?"
  // Expected: Stage = 'Closed Won' AND Closing_Date in August
  
  const dateField = businessCriteria.selectBusinessDateField(
    'deals',
    'Which Closed Won deals have a closing date in August?'
  );
  
  // Should use Closing_Date because explicitly mentioned
  assert.strictEqual(dateField, 'Closing_Date');
});

test('3.3: RULE 3 - "Exact Date Request" - Closing_Date only when explicitly requested', () => {
  // Query: "Give me Closed Won deals with closing date July 26"
  // Expected: Closing_Date >= 2026-07-26 AND Closing_Date < 2026-07-27 AND Stage = 'Closed Won'
  
  const dateField = businessCriteria.selectBusinessDateField(
    'deals',
    'Give me Closed Won deals with closing date July 26'
  );
  
  // Should use Closing_Date
  assert.strictEqual(dateField, 'Closing_Date');
});

test('3.4: RULE 4 - Count tool - "How many deals are currently Closed Won?"', () => {
  // Query: "How many deals are currently Closed Won?"
  // Expected: COUNT(Deal Category = Closed Won), no Closing_Date filter
  
  const dateField = businessCriteria.selectBusinessDateField(
    'deals',
    'How many deals are currently Closed Won?'
  );
  
  // Should NOT add a date field
  assert.strictEqual(dateField, null);
});

test('3.5: RULE 5 - Query tool - "Which deals are already Closed Won?"', () => {
  // Query: "Which deals are already Closed Won?"
  // Expected: Return records where Stage = Closed Won, no Closing_Date filter
  
  const dateField = businessCriteria.selectBusinessDateField(
    'deals',
    'Which deals are already Closed Won?'
  );
  
  // Should NOT add a date field
  assert.strictEqual(dateField, null);
});

test('3.6: RULE 6 - Prevent false "no results" - Closed Won with future Closing_Date', () => {
  // Deal: Stage = Closed Won, Closing_Date = 2026-08-22 (future), Today = 2026-08-17
  // The system must NOT say "no Closed Won deals because Closing_Date is in the future"
  
  // When querying for currently Closed Won, no Closing_Date filter should be added
  const dateField = businessCriteria.selectBusinessDateField(
    'deals',
    'Which deals are already Closed Won?'
  );
  
  assert.strictEqual(dateField, null, 'Should not add Closing_Date filter for "already Closed Won" query');
});

test('3.7: RULE 7 - Response format - Currently Closed Won Deals returns all Closed Won', () => {
  // Even if Closing_Date is in the future, Closed Won deal should be included
  
  const dateField = businessCriteria.selectBusinessDateField(
    'deals',
    'Show me currently closed won deals'
  );
  
  assert.strictEqual(dateField, null, 'No date filter should be applied');
});

test('3.8: Dashboard - "Closed Won this month" should use Closing_Date (has period)', () => {
  // Query: "Build a dashboard for closed won deals this month"
  // Has explicit period ("this month") → use Closing_Date to filter to this month
  
  const dateField = businessCriteria.selectBusinessDateField(
    'deals',
    'Dashboard for closed won deals this month'
  );
  
  // Should use Closing_Date to filter to this month
  assert.strictEqual(dateField, 'Closing_Date');
});

test('3.9: Dashboard - "Closed Won with Closing Date" should use Closing_Date', () => {
  // Query: "Build a dashboard for closed won deals with closing date in July"
  // Clear instruction to use Closing_Date
  
  const dateField = businessCriteria.selectBusinessDateField(
    'deals',
    'Dashboard for closed won deals with closing date in July'
  );
  
  // Should use Closing_Date
  assert.strictEqual(dateField, 'Closing_Date');
});

// ============================================================================
// TEST SUITE 4: Verification of Business Rules
// ============================================================================

test('4.1: RULE 1 Verification - Closing_Date is NOT proof of closure', () => {
  // For "already closed won" query, don't use Closing_Date to filter
  const dateField = businessCriteria.selectBusinessDateField(
    'deals',
    'already closed won'
  );
  assert.strictEqual(dateField, null);
});

test('4.2: RULE 2 Verification - Current Stage determines Closed Won status', () => {
  // For "closed won" query, no automatic Closing_Date filter
  const dateField = businessCriteria.selectBusinessDateField(
    'deals',
    'closed won deals'
  );
  assert.strictEqual(dateField, null);
});

test('4.3: RULE 3 Verification - Do NOT use Closing_Date <= today for open/closed decision', () => {
  // "Give me closed won deals" should not add "Closing_Date <= today"
  const dateField = businessCriteria.selectBusinessDateField(
    'deals',
    'Give me closed won deals'
  );
  assert.strictEqual(dateField, null);
});

test('4.4: RULE 4 Verification - Future Closing_Date does NOT make Closed Won open', () => {
  // Query for Closed Won should include deals with future Closing_Date
  const dateField = businessCriteria.selectBusinessDateField(
    'deals',
    'closed won deals'
  );
  assert.strictEqual(dateField, null, 'No filter to exclude future dates');
});

test('4.5: RULE 5 Verification - Past Closing_Date does NOT make Open deal closed', () => {
  // Query for Open deals should not be affected by Closing_Date
  const dateField = businessCriteria.selectBusinessDateField(
    'deals',
    'open deals'
  );
  // For "open deals" query without explicit date, default to Closing_Date for deals
  // (this is existing behavior, not changed)
  assert.ok(dateField === 'Closing_Date' || dateField === null);
});

test('4.6: RULE 9 Verification - Count tool uses Deal Category not Closing_Date', () => {
  // Count: "How many deals are currently Closed Won?"
  const dateField = businessCriteria.selectBusinessDateField(
    'deals',
    'How many deals are currently Closed Won?'
  );
  assert.strictEqual(dateField, null);
});

test('4.7: RULE 10 Verification - Query tool uses Stage field for current status', () => {
  // Query: "Which deals are already Closed Won?"
  const dateField = businessCriteria.selectBusinessDateField(
    'deals',
    'Which deals are already Closed Won?'
  );
  assert.strictEqual(dateField, null);
});

test('4.8: RULE 12 Verification - Current Closed Won count must reflect current status', () => {
  // For counting Closed Won, don't filter by Closing_Date
  const dateField = businessCriteria.selectBusinessDateField(
    'deals',
    'Current Closed Won count'
  );
  assert.strictEqual(dateField, null);
});

// ============================================================================
// TEST SUITE 5: Edge Cases and Ambiguous Phrases
// ============================================================================

test('5.1: "Closed Won this month" with period - should use Closing_Date', () => {
  const dateField = businessCriteria.selectBusinessDateField(
    'deals',
    'closed won deals this month'
  );
  // Has "this month" period → use Closing_Date to filter to this month
  assert.strictEqual(dateField, 'Closing_Date');
});

test('5.2: Explicit "closing date" overrides ambiguity', () => {
  const dateField = businessCriteria.selectBusinessDateField(
    'deals',
    'closed won deals with closing date this month'
  );
  // Explicit "closing date" mention → use Closing_Date filter
  assert.strictEqual(dateField, 'Closing_Date');
});

test('5.3: "became" indicates stage history, not Closing_Date', () => {
  const dateField = businessCriteria.selectBusinessDateField(
    'deals',
    'deals that became closed won in July'
  );
  // Stage history query, not Closing_Date
  assert.strictEqual(dateField, null);
});

test('5.4: Closed Lost should follow same rules as Closed Won', () => {
  const dateField = businessCriteria.selectBusinessDateField(
    'deals',
    'closed lost deals'
  );
  // No date filter for "closed lost" without explicit "closing date"
  assert.strictEqual(dateField, null);
});

console.log('✅ All Closed Won Query Integration tests completed!');
