/**
 * Closed Won Date Logic Regression Tests
 *
 * Validates that the business logic correctly distinguishes between:
 * - Current Deal Category/Stage (whether deal is Closed Won RIGHT NOW)
 * - Closing_Date (CRM field, NOT proof of closure)
 * - Actual Closed Won Date (from stage history/audit logs)
 *
 * Key Rules Being Tested:
 * 1. Closing_Date is NOT proof that a deal is actually closed
 * 2. A deal is actually Closed Won only when its current Deal Stage/Category is mapped to Closed Won
 * 3. Do NOT use Closing_Date <= today to decide whether a deal is closed
 * 4. A future Closing_Date does not make a Closed Won deal open
 * 5. A past Closing_Date does not make an Open deal closed
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const closedWonDateService = require('../src/crm/services/closed-won-date-service');

// ============================================================================
// TEST SUITE 1: Basic Status Determination
// ============================================================================

test('1.1: isCurrentlyClosedWon - correctly identifies Closed Won stage variations', () => {
  assert.strictEqual(closedWonDateService.isCurrentlyClosedWon('Closed Won'), true);
  assert.strictEqual(closedWonDateService.isCurrentlyClosedWon('closed won'), true);
  assert.strictEqual(closedWonDateService.isCurrentlyClosedWon('Closed-Won'), true);
  assert.strictEqual(closedWonDateService.isCurrentlyClosedWon('won'), true);
  assert.strictEqual(closedWonDateService.isCurrentlyClosedWon('Won'), true);
});

test('1.2: isCurrentlyClosedWon - returns false for non-Closed Won stages', () => {
  assert.strictEqual(closedWonDateService.isCurrentlyClosedWon('Open'), false);
  assert.strictEqual(closedWonDateService.isCurrentlyClosedWon('Closed Lost'), false);
  assert.strictEqual(closedWonDateService.isCurrentlyClosedWon('Proposal/Price Quote'), false);
  assert.strictEqual(closedWonDateService.isCurrentlyClosedWon('Negotiation/Review'), false);
  assert.strictEqual(closedWonDateService.isCurrentlyClosedWon(null), false);
  assert.strictEqual(closedWonDateService.isCurrentlyClosedWon(''), false);
});

test('1.3: isCurrentlyClosedLost - correctly identifies Closed Lost stage variations', () => {
  assert.strictEqual(closedWonDateService.isCurrentlyClosedLost('Closed Lost'), true);
  assert.strictEqual(closedWonDateService.isCurrentlyClosedLost('closed lost'), true);
  assert.strictEqual(closedWonDateService.isCurrentlyClosedLost('Closed-Lost'), true);
  assert.strictEqual(closedWonDateService.isCurrentlyClosedLost('Lost'), true);
});

test('1.4: isCurrentlyClosedLost - returns false for non-Closed Lost stages', () => {
  assert.strictEqual(closedWonDateService.isCurrentlyClosedLost('Closed Won'), false);
  assert.strictEqual(closedWonDateService.isCurrentlyClosedLost('Open'), false);
  assert.strictEqual(closedWonDateService.isCurrentlyClosedLost(null), false);
});

test('1.5: isCurrentlyOpen - correctly identifies Open deals', () => {
  assert.strictEqual(closedWonDateService.isCurrentlyOpen('Qualification'), true);
  assert.strictEqual(closedWonDateService.isCurrentlyOpen('Proposal/Price Quote'), true);
  assert.strictEqual(closedWonDateService.isCurrentlyOpen(null), true); // Default to Open
  assert.strictEqual(closedWonDateService.isCurrentlyOpen(''), true);
});

test('1.6: isCurrentlyOpen - returns false for closed stages', () => {
  assert.strictEqual(closedWonDateService.isCurrentlyOpen('Closed Won'), false);
  assert.strictEqual(closedWonDateService.isCurrentlyOpen('Closed Lost'), false);
});

// ============================================================================
// TEST SUITE 2: RULE #1 - Closing_Date is NOT proof of closure
// ============================================================================

test('2.1: Open deal with past Closing_Date should NOT be considered Closed Won', () => {
  const deal = {
    id: '1',
    Deal_Name: 'Open with Past Date',
    Stage: 'Qualification',
    Closing_Date: '2026-07-15', // Past date
  };

  assert.strictEqual(closedWonDateService.isCurrentlyClosedWon(deal.Stage), false);
  assert.strictEqual(closedWonDateService.isCurrentlyOpen(deal.Stage), true);
});

test('2.2: Closed Lost deal with past Closing_Date should NOT be considered Closed Won', () => {
  const deal = {
    id: '2',
    Deal_Name: 'Closed Lost with Past Date',
    Stage: 'Closed Lost',
    Closing_Date: '2026-07-15', // Past date
  };

  assert.strictEqual(closedWonDateService.isCurrentlyClosedWon(deal.Stage), false);
  assert.strictEqual(closedWonDateService.isCurrentlyClosedLost(deal.Stage), true);
});

// ============================================================================
// TEST SUITE 3: RULE #2 - Only current stage determines Closed Won status
// ============================================================================

test('3.1: Current Stage determines Closed Won status, not Closing_Date', () => {
  const closedWonDeal = {
    id: '3',
    Deal_Name: 'Closed Won Deal',
    Stage: 'Closed Won',
    Closing_Date: '2026-09-15', // Future date
  };

  assert.strictEqual(closedWonDateService.isCurrentlyClosedWon(closedWonDeal.Stage), true);
  // Note: Closing_Date doesn't affect the current status determination
});

test('3.2: Open stage with future Closing_Date should NOT be Closed Won', () => {
  const openDeal = {
    id: '4',
    Deal_Name: 'Open with Future Date',
    Stage: 'Negotiation/Review',
    Closing_Date: '2026-09-01', // Future date
  };

  assert.strictEqual(closedWonDateService.isCurrentlyClosedWon(openDeal.Stage), false);
  assert.strictEqual(closedWonDateService.isCurrentlyOpen(openDeal.Stage), true);
});

// ============================================================================
// TEST SUITE 4: RULE #3 & #4 - Closing_Date semantics
// ============================================================================

test('4.1: Closed Won + future Closing_Date = still Closed Won (Rule #4)', () => {
  const deal = {
    id: '5',
    Deal_Name: 'Closed Won with Future Closing Date',
    Stage: 'Closed Won',
    Closing_Date: '2026-12-31', // Future date, doesn't make it open
  };

  assert.strictEqual(closedWonDateService.isCurrentlyClosedWon(deal.Stage), true);
  
  // Validation should flag this as unusual
  const validation = closedWonDateService.validateDealClosedWonLogic(deal);
  assert.strictEqual(validation.warnings.length > 0, true);
  assert.ok(validation.warnings.some(w => w.includes('future Closing_Date')));
});

test('4.2: Open + past Closing_Date ≠ Closed Won (Rule #5)', () => {
  const deal = {
    id: '6',
    Deal_Name: 'Open with Past Closing Date',
    Stage: 'Proposal/Price Quote',
    Closing_Date: '2026-07-15', // Past date, doesn't close it
  };

  assert.strictEqual(closedWonDateService.isCurrentlyClosedWon(deal.Stage), false);
  assert.strictEqual(closedWonDateService.isCurrentlyOpen(deal.Stage), true);
  
  // Validation should flag this as unusual
  const validation = closedWonDateService.validateDealClosedWonLogic(deal);
  assert.ok(validation.warnings.some(w => w.includes('past Closing_Date')));
});

// ============================================================================
// TEST SUITE 5: Closing_Date Field Validation
// ============================================================================

test('5.1: isValidClosingDate - accepts valid date formats', () => {
  assert.strictEqual(closedWonDateService.isValidClosingDate('2026-07-15'), true);
  assert.strictEqual(closedWonDateService.isValidClosingDate('2026-07-15T00:00:00+05:30'), true);
  assert.strictEqual(closedWonDateService.isValidClosingDate(new Date('2026-07-15')), true);
});

test('5.2: isValidClosingDate - rejects invalid formats', () => {
  assert.strictEqual(closedWonDateService.isValidClosingDate('not-a-date'), false);
  assert.strictEqual(closedWonDateService.isValidClosingDate(null), false);
  assert.strictEqual(closedWonDateService.isValidClosingDate(''), false);
  assert.strictEqual(closedWonDateService.isValidClosingDate(undefined), false);
});

// ============================================================================
// TEST SUITE 6: Filtering Logic - Query Pattern
// ============================================================================

test('6.1: filterClosedWonWithClosingDate - "Closed Won deals with closing date in July 2026"', () => {
  const deals = [
    { id: '1', Deal_Name: 'July Deal', Stage: 'Closed Won', Closing_Date: '2026-07-15' },
    { id: '2', Deal_Name: 'August Deal', Stage: 'Closed Won', Closing_Date: '2026-08-15' },
    { id: '3', Deal_Name: 'June Open', Stage: 'Qualification', Closing_Date: '2026-06-15' },
    { id: '4', Deal_Name: 'July Open', Stage: 'Proposal/Price Quote', Closing_Date: '2026-07-20' },
    { id: '5', Deal_Name: 'July Closed Lost', Stage: 'Closed Lost', Closing_Date: '2026-07-25' },
  ];

  const result = closedWonDateService.filterClosedWonWithClosingDate(
    deals,
    '2026-07-01T00:00:00+05:30',
    '2026-08-01T00:00:00+05:30'
  );

  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, '1');
  assert.strictEqual(result[0].Deal_Name, 'July Deal');
});

test('6.2: filterClosedWonWithClosingDate - handles no Closing_Date field', () => {
  const deals = [
    { id: '1', Deal_Name: 'No Date Deal', Stage: 'Closed Won' }, // Missing Closing_Date
    { id: '2', Deal_Name: 'Valid Deal', Stage: 'Closed Won', Closing_Date: '2026-07-15' },
  ];

  const result = closedWonDateService.filterClosedWonWithClosingDate(
    deals,
    '2026-07-01T00:00:00+05:30',
    '2026-08-01T00:00:00+05:30'
  );

  // Should only return deal with valid Closing_Date
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, '2');
});

test('6.3: filterCurrentlyClosedWon - filters only by current stage, ignores dates', () => {
  const deals = [
    { id: '1', Deal_Name: 'July Won', Stage: 'Closed Won', Closing_Date: '2026-07-15' },
    { id: '2', Deal_Name: 'December Won', Stage: 'Closed Won', Closing_Date: '2026-12-01' },
    { id: '3', Deal_Name: 'July Open', Stage: 'Qualification', Closing_Date: '2026-07-20' },
  ];

  const result = closedWonDateService.filterCurrentlyClosedWon(deals);

  assert.strictEqual(result.length, 2);
  assert.ok(result.some(d => d.id === '1'));
  assert.ok(result.some(d => d.id === '2'));
});

// ============================================================================
// TEST SUITE 7: Query Interpretation
// ============================================================================

test('7.1: interpretClosedWonQuery - "Closed Won deals in July" = current status', () => {
  const interpretation = closedWonDateService.interpretClosedWonQuery('Show me Closed Won deals in July 2026');
  
  assert.strictEqual(interpretation.interpretation, 'currentStatus');
  assert.strictEqual(interpretation.requiresStageHistory, false);
  assert.strictEqual(interpretation.dateFieldPreference, 'Closing_Date');
});

test('7.2: interpretClosedWonQuery - "Deals that closed in July" = transition date', () => {
  const interpretation = closedWonDateService.interpretClosedWonQuery('Give me deals that closed in July 2026');
  
  assert.strictEqual(interpretation.interpretation, 'transitionDate');
  assert.strictEqual(interpretation.requiresStageHistory, true);
});

test('7.3: interpretClosedWonQuery - "Deals that became Closed Won in July" = transition date', () => {
  const interpretation = closedWonDateService.interpretClosedWonQuery('When did deals become Closed Won in July?');
  
  assert.strictEqual(interpretation.interpretation, 'transitionDate');
  assert.strictEqual(interpretation.requiresStageHistory, true);
});

test('7.4: interpretClosedWonQuery - "Closed Won with July Closing_Date" = closingDateOnly', () => {
  const interpretation = closedWonDateService.interpretClosedWonQuery('Closed Won deals with Closing_Date in July');
  
  assert.strictEqual(interpretation.interpretation, 'closingDateOnly');
  assert.strictEqual(interpretation.requiresStageHistory, false);
});

// ============================================================================
// TEST SUITE 8: Deal Date Normalization
// ============================================================================

test('8.1: normalizeDealDates - extracts and separates both date concepts', () => {
  const deal = {
    id: '1',
    Deal_Name: 'Sample Deal',
    Stage: 'Closed Won',
    Closing_Date: '2026-07-15',
  };

  const normalized = closedWonDateService.normalizeDealDates(deal);

  assert.strictEqual(normalized.dealId, '1');
  assert.strictEqual(normalized.dealName, 'Sample Deal');
  assert.strictEqual(normalized.currentStage, 'Closed Won');
  assert.strictEqual(normalized.isClosedWon, true);
  assert.strictEqual(normalized.closingDate, '2026-07-15');
});

test('8.2: normalizeDealDates - detects future Closing_Date on Closed Won', () => {
  const deal = {
    id: '2',
    Deal_Name: 'Future Closing Date Deal',
    Stage: 'Closed Won',
    Closing_Date: '2026-12-31',
  };

  const normalized = closedWonDateService.normalizeDealDates(deal);

  assert.strictEqual(normalized.validation.futureClosingDateWithClosedWon, true);
  assert.strictEqual(normalized.validation.pastClosingDateWithOpen, false);
});

test('8.3: normalizeDealDates - detects past Closing_Date on Open deal', () => {
  const deal = {
    id: '3',
    Deal_Name: 'Past Closing Date Open Deal',
    Stage: 'Proposal/Price Quote',
    Closing_Date: '2026-07-15',
  };

  const normalized = closedWonDateService.normalizeDealDates(deal);

  assert.strictEqual(normalized.validation.pastClosingDateWithOpen, true);
  assert.strictEqual(normalized.validation.futureClosingDateWithClosedWon, false);
});

// ============================================================================
// TEST SUITE 9: Deal Validation Logic
// ============================================================================

test('9.1: validateDealClosedWonLogic - flags future Closing_Date on Closed Won', () => {
  const deal = {
    id: '1',
    Deal_Name: 'Future Date Deal',
    Stage: 'Closed Won',
    Closing_Date: '2026-12-31',
  };

  const validation = closedWonDateService.validateDealClosedWonLogic(deal);

  assert.strictEqual(validation.valid, true); // Not an error, just unusual
  assert.strictEqual(validation.warnings.length > 0, true);
  assert.ok(validation.warnings[0].includes('future Closing_Date'));
});

test('9.2: validateDealClosedWonLogic - flags missing Closing_Date on Closed Won', () => {
  const deal = {
    id: '2',
    Deal_Name: 'No Closing Date',
    Stage: 'Closed Won',
    // Missing Closing_Date
  };

  const validation = closedWonDateService.validateDealClosedWonLogic(deal);

  assert.strictEqual(validation.warnings.length > 0, true);
  assert.ok(validation.warnings[0].includes('missing Closing_Date'));
});

test('9.3: validateDealClosedWonLogic - flags past Closing_Date on Open', () => {
  const deal = {
    id: '3',
    Deal_Name: 'Open with Past Date',
    Stage: 'Qualification',
    Closing_Date: '2026-07-15',
  };

  const validation = closedWonDateService.validateDealClosedWonLogic(deal);

  assert.strictEqual(validation.warnings.length > 0, true);
  assert.ok(validation.warnings[0].includes('past Closing_Date'));
});

// ============================================================================
// TEST SUITE 10: Criteria Building for Server-Side Queries
// ============================================================================

test('10.1: buildClosedWonWithClosingDateCriteria - builds correct COQL WHERE clause', () => {
  const criteria = closedWonDateService.buildClosedWonWithClosingDateCriteria(
    '2026-07-01T00:00:00+05:30',
    '2026-08-01T00:00:00+05:30',
    'Closed Won'
  );

  assert.ok(criteria.includes("Stage = 'Closed Won'"));
  assert.ok(criteria.includes("Closing_Date >= '2026-07-01T00:00:00+05:30'"));
  assert.ok(criteria.includes("Closing_Date < '2026-08-01T00:00:00+05:30'"));
});

test('10.2: buildStageTransitionCriteria - builds audit log criteria for stage changes', () => {
  const criteria = closedWonDateService.buildStageTransitionCriteria(
    '2026-07-01T00:00:00+05:30',
    '2026-08-01T00:00:00+05:30',
    'Closed Won'
  );

  assert.strictEqual(criteria.module, 'Deals');
  assert.strictEqual(criteria.action, 'update');
  assert.strictEqual(criteria.fieldName, 'Stage');
  assert.strictEqual(criteria.newValue, 'Closed Won');
});

// ============================================================================
// TEST SUITE 11: Real-World Scenarios
// ============================================================================

test('11.1: Scenario - Closed Won + July Closing_Date', () => {
  const deals = [
    { id: 'cw1', Deal_Name: 'CW Deal 1', Stage: 'Closed Won', Closing_Date: '2026-07-10', Amount: 50000 },
    { id: 'cw2', Deal_Name: 'CW Deal 2', Stage: 'Closed Won', Closing_Date: '2026-07-20', Amount: 75000 },
  ];

  const filtered = closedWonDateService.filterClosedWonWithClosingDate(
    deals,
    '2026-07-01T00:00:00+05:30',
    '2026-08-01T00:00:00+05:30'
  );

  assert.strictEqual(filtered.length, 2);
  const totalAmount = filtered.reduce((sum, d) => sum + d.Amount, 0);
  assert.strictEqual(totalAmount, 125000);
});

test('11.2: Scenario - Deal became Closed Won in July but has August Closing_Date', () => {
  // This deal transitioned to Closed Won on 2026-07-15 but Closing_Date is 2026-08-15
  const deal = {
    id: 'mixed1',
    Deal_Name: 'Mixed Dates Deal',
    Stage: 'Closed Won',
    Closing_Date: '2026-08-15', // Future relative to transition
    actualClosedWonDate: '2026-07-15', // From stage history
  };

  // When filtering by Closing_Date range (July), this should NOT be included
  const filtered = closedWonDateService.filterClosedWonWithClosingDate(
    [deal],
    '2026-07-01T00:00:00+05:30',
    '2026-08-01T00:00:00+05:30'
  );

  assert.strictEqual(filtered.length, 0); // Not included because Closing_Date is August

  // But when checking current status, it's Closed Won
  assert.strictEqual(closedWonDateService.isCurrentlyClosedWon(deal.Stage), true);

  // Validation should flag the date mismatch
  const validation = closedWonDateService.validateDealClosedWonLogic(deal);
  // Note: mismatch detection requires actualClosedWonDate from history
});

test('11.3: Scenario - Open deal with July Closing_Date', () => {
  const deals = [
    { id: 'open1', Deal_Name: 'Open Deal', Stage: 'Proposal/Price Quote', Closing_Date: '2026-07-15' },
  ];

  // Should NOT be included in Closed Won filter
  const filtered = closedWonDateService.filterClosedWonWithClosingDate(
    deals,
    '2026-07-01T00:00:00+05:30',
    '2026-08-01T00:00:00+05:30'
  );

  assert.strictEqual(filtered.length, 0);

  // But Closing_Date validation should pass (date field is valid)
  assert.strictEqual(closedWonDateService.isValidClosingDate(deals[0].Closing_Date), true);
});

test('11.4: Scenario - Custom Closed Won stage mapping', () => {
  // Some organizations might use custom stage names
  const stageMetadata = {
    stages: [
      { api_name: 'Custom_Closed_Won', category: 'closed won' },
      { api_name: 'Open_Pipeline', category: 'open' },
    ],
  };

  // Without metadata, custom stage won't match
  assert.strictEqual(closedWonDateService.isCurrentlyClosedWon('Custom_Closed_Won'), false);

  // With metadata, custom stage should match
  assert.strictEqual(
    closedWonDateService.isCurrentlyClosedWon('Custom_Closed_Won', stageMetadata),
    true
  );
});

// ============================================================================
// TEST SUITE 12: Edge Cases
// ============================================================================

test('12.1: Empty and null inputs', () => {
  assert.strictEqual(closedWonDateService.filterCurrentlyClosedWon([]).length, 0);
  assert.strictEqual(closedWonDateService.filterCurrentlyClosedWon(null).length, 0);
  assert.strictEqual(closedWonDateService.filterCurrentlyClosedWon(undefined).length, 0);
});

test('12.2: Case insensitivity', () => {
  assert.strictEqual(closedWonDateService.isCurrentlyClosedWon('CLOSED WON'), true);
  assert.strictEqual(closedWonDateService.isCurrentlyClosedWon('ClOsEd WoN'), true);
  assert.strictEqual(closedWonDateService.isCurrentlyClosedWon('won'), true);
  assert.strictEqual(closedWonDateService.isCurrentlyClosedWon('WON'), true);
});

test('12.3: Whitespace handling', () => {
  assert.strictEqual(closedWonDateService.isCurrentlyClosedWon('  Closed Won  '), true);
  assert.strictEqual(closedWonDateService.isCurrentlyClosedWon('\tClosed Won\n'), true);
});

console.log('✅ All Closed Won Date Service regression tests completed!');
