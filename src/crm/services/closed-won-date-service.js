/**
 * Closed Won Date Service
 *
 * Handles the critical distinction between:
 * 1. Current Deal Category/Stage → whether the deal is Closed Won RIGHT NOW
 * 2. Closing_Date → CRM closing date field (NOT proof of closure)
 * 3. Actual Closed Won Date → When the deal transitioned into Closed Won stage (from history/audit logs)
 *
 * Business Rules:
 * - Closing_Date is NOT proof that a deal is actually closed
 * - A deal is actually Closed Won only when its current Deal Stage/Deal Category is mapped to Closed Won
 * - Do NOT use Closing_Date <= today to decide whether a deal is closed
 * - A future Closing_Date does not make a Closed Won deal open
 * - A past Closing_Date does not make an Open deal closed
 */

const logger = require('../../common/logging/logger');
const metadataService = require('./crm-metadata.service');
const activityService = require('./activity.service');
const { numericValue } = require('./assistant/currency.service');

/**
 * Standard Closed Won stage/category mappings.
 * Keys are lowercase for consistent lookup.
 */
const CLOSED_WON_STAGE_MAPPINGS = {
  'closed won': true,
  'closed-won': true,
  'won': true,
};

/**
 * Determines if a deal is currently in Closed Won status based on its current Stage field.
 *
 * Key: This checks CURRENT status, not history. A deal with future Closing_Date can still be Closed Won.
 *
 * @param {string} stage - The current Stage value from the deal record
 * @param {object} stageMetadata - Optional: Zoho CRM stage metadata for this organization
 * @returns {boolean} true if the deal's current stage maps to Closed Won
 */
function isCurrentlyClosedWon(stage, stageMetadata = null) {
  if (!stage) return false;

  const normalized = String(stage).trim().toLowerCase();

  // First check hard-coded mappings (all keys are lowercase)
  if (CLOSED_WON_STAGE_MAPPINGS[normalized]) {
    return true;
  }

  // Then check organization-specific metadata if provided
  if (stageMetadata && Array.isArray(stageMetadata.stages)) {
    const stageObj = stageMetadata.stages.find(
      (s) =>
        String(s.api_name || s.name || '').toLowerCase() ===
        normalized
    );
    if (stageObj) {
      // Check if this stage has a mapping to Closed Won category
      return (
        String(stageObj.category || stageObj.type || '').toLowerCase() ===
        'closed won'
      );
    }
  }

  return false;
}

/**
 * Determines if a deal is currently in Closed Lost status based on its current Stage field.
 *
 * @param {string} stage - The current Stage value from the deal record
 * @param {object} stageMetadata - Optional: Zoho CRM stage metadata for this organization
 * @returns {boolean} true if the deal's current stage maps to Closed Lost
 */
function isCurrentlyClosedLost(stage, stageMetadata = null) {
  if (!stage) return false;

  const normalized = String(stage).trim().toLowerCase();

  // Hard-coded mappings
  if (
    normalized === 'closed lost' ||
    normalized === 'closed-lost' ||
    normalized === 'lost'
  ) {
    return true;
  }

  // Check organization-specific metadata if provided
  if (stageMetadata && Array.isArray(stageMetadata.stages)) {
    const stageObj = stageMetadata.stages.find(
      (s) =>
        String(s.api_name || s.name || '').toLowerCase() ===
        normalized
    );
    if (stageObj) {
      return (
        String(stageObj.category || stageObj.type || '').toLowerCase() ===
        'closed lost'
      );
    }
  }

  return false;
}

/**
 * Determines if a deal is currently in any Open status.
 *
 * @param {string} stage - The current Stage value from the deal record
 * @param {object} stageMetadata - Optional: Zoho CRM stage metadata for this organization
 * @returns {boolean} true if the deal is Open
 */
function isCurrentlyOpen(stage, stageMetadata = null) {
  if (!stage) return true; // Default to Open if no stage

  // If it's Closed Won or Closed Lost, it's not Open
  if (isCurrentlyClosedWon(stage, stageMetadata) ||
      isCurrentlyClosedLost(stage, stageMetadata)) {
    return false;
  }

  return true;
}

/**
 * Validates that a deal's Closing_Date field is a valid date string or Date object.
 * This does NOT determine if a deal is closed—it just checks the field's validity.
 *
 * @param {string|Date|null} closingDate - The Closing_Date field value
 * @returns {boolean} true if the Closing_Date is valid
 */
function isValidClosingDate(closingDate) {
  if (!closingDate) return false;

  if (typeof closingDate === 'string') {
    // Matches YYYY-MM-DD or ISO 8601 with time
    return /^\d{4}-\d{2}-\d{2}/.test(closingDate.trim());
  }

  if (closingDate instanceof Date) {
    return !Number.isNaN(closingDate.getTime());
  }

  return false;
}

/**
 * Filters deals that are CURRENTLY in Closed Won status.
 * Does NOT use Closing_Date for the filter—only the current Stage field.
 *
 * @param {array} deals - Array of deal records with Stage and other fields
 * @param {object} stageMetadata - Optional: Zoho CRM stage metadata
 * @returns {array} Deals whose current Stage maps to Closed Won
 */
function filterCurrentlyClosedWon(deals = [], stageMetadata = null) {
  if (!Array.isArray(deals)) return [];

  return deals.filter((deal) =>
    isCurrentlyClosedWon(deal.Stage || deal.stage, stageMetadata)
  );
}

/**
 * Returns the current Closed Won deal snapshot, optionally restricted by the
 * expected Closing_Date window. Current status is always decided by Stage.
 */
function getClosedWonDeals(deals = [], options = {}) {
  const {
    stageMetadata = null,
    dateFrom = null,
    dateTo = null,
    dateMeaning = null,
  } = options;
  const closedWonDeals = filterCurrentlyClosedWon(deals, stageMetadata);

  if (dateMeaning === 'actual_closed_won_date') {
    throw new Error('Actual Closed Won dates require stage history, not deal snapshots.');
  }
  if (!dateFrom || !dateTo || dateMeaning !== 'closing_date') return closedWonDeals;
  return filterClosedWonWithClosingDate(closedWonDeals, dateFrom, dateTo, stageMetadata);
}

/**
 * Calculates count and revenue from the same complete Closed Won dataset.
 * Amount is parsed without truncating decimal currency values.
 */
function calculateClosedWonMetrics(deals = [], options = {}) {
  const records = getClosedWonDeals(deals, options);
  const amountField = options.amountField || 'Amount';
  const closedWonRevenue = records.reduce((total, deal) => {
    const value = numericAmount(deal?.[amountField] ?? deal?.Amount ?? deal?.amount);
    return total + value;
  }, 0);
  return {
    records,
    count: records.length,
    revenue: Number(closedWonRevenue.toFixed(2)),
    amountField,
  };
}

/**
 * Validates query: "Closed Won deals with a closing date in July 2026"
 * Returns deals that are:
 * - Currently Closed Won (by Stage)
 * - AND have Closing_Date within the date range
 *
 * @param {array} deals - Array of deal records
 * @param {string} dateFrom - ISO 8601 date string (e.g., "2026-07-01T00:00:00+05:30")
 * @param {string} dateTo - ISO 8601 date string (e.g., "2026-08-01T00:00:00+05:30")
 * @param {object} stageMetadata - Optional: Zoho CRM stage metadata
 * @returns {array} Matching deals
 */
function filterClosedWonWithClosingDate(
  deals = [],
  dateFrom,
  dateTo,
  stageMetadata = null
) {
  if (!Array.isArray(deals)) return [];

  return deals.filter((deal) => {
    // Must be currently Closed Won
    if (!isCurrentlyClosedWon(deal.Stage || deal.stage, stageMetadata)) {
      return false;
    }

    // Must have Closing_Date in the specified range
    const closingDate = deal.Closing_Date || deal.closing_date;
    if (!isValidClosingDate(closingDate)) {
      return false;
    }

    // Parse dates for comparison
    const dealDate = new Date(String(closingDate).slice(0, 10));
    const fromDate = new Date(dateFrom.slice(0, 10));
    const toDate = new Date(dateTo.slice(0, 10));

    return dealDate >= fromDate && dealDate < toDate;
  });
}

/**
 * For query: "Give me the Closed Won deal details for July 26, 2026"
 *
 * Disambiguates between two interpretations and returns both:
 * 1. If user means Closing_Date = July 26 → return deals with that Closing_Date + Closed Won stage
 * 2. If user means actually became Closed Won on July 26 → return from stage history
 *
 * Returns both separately so the response can clarify which interpretation was used.
 *
 * @param {array} deals - Array of deal records (must include id, Stage, Closing_Date)
 * @param {string} targetDate - Target date string (e.g., "2026-07-26")
 * @param {object} stageMetadata - Optional: Zoho CRM stage metadata
 * @returns {object} { byClosingDate: [...], byActualClosedWonDate: [...], stageHistoryNeeded: boolean }
 */
function disambiguateClosedWonDateQuery(
  deals = [],
  targetDate,
  stageMetadata = null
) {
  if (!Array.isArray(deals)) {
    return { byClosingDate: [], byActualClosedWonDate: [], stageHistoryNeeded: true };
  }

  const targetDateStr = String(targetDate).slice(0, 10);

  // Interpretation 1: Closing_Date = July 26
  const byClosingDate = deals.filter((deal) => {
    if (!isCurrentlyClosedWon(deal.Stage || deal.stage, stageMetadata)) {
      return false;
    }
    const closingDate = String(deal.Closing_Date || deal.closing_date || '')
      .slice(0, 10);
    return closingDate === targetDateStr;
  });

  // Interpretation 2: Became Closed Won on July 26
  // This requires stage history/audit logs (not available locally, requires API call)
  // Return indicator that stageHistory is needed
  const byActualClosedWonDate = []; // Would be populated from audit log query

  return {
    byClosingDate,
    byActualClosedWonDate,
    stageHistoryNeeded: true, // Caller should fetch from audit logs
    interpretationNote:
      'Please specify: (1) Closing_Date on July 26, or (2) Deal transitioned to Closed Won on July 26?',
  };
}

/**
 * Builds server-side COQL criteria for fetching Closed Won deals with a specific Closing_Date range.
 * Used for efficient server-side filtering.
 *
 * @param {string} dateFrom - ISO 8601 date string
 * @param {string} dateTo - ISO 8601 date string
 * @param {string} stageValue - Stage name (e.g., "Closed Won")
 * @returns {string} COQL WHERE clause
 *
 * Example:
 * "Stage = 'Closed Won' and Closing_Date >= '2026-07-01T00:00:00+05:30' and Closing_Date < '2026-08-01T00:00:00+05:30'"
 */
function buildClosedWonWithClosingDateCriteria(
  dateFrom,
  dateTo,
  stageValue = 'Closed Won'
) {
  const escapedStage = String(stageValue).replace(/'/g, "\\'");
  return `Stage = '${escapedStage}' and Closing_Date >= '${dateFrom}' and Closing_Date < '${dateTo}'`;
}

/**
 * Builds server-side COQL criteria for detecting stage transitions.
 * Used with stage history/audit logs to find when a deal transitioned to Closed Won.
 *
 * @param {string} dateFrom - ISO 8601 date string
 * @param {string} dateTo - ISO 8601 date string
 * @param {string} stageValue - Stage name to match the transition into
 * @returns {object} Audit log export criteria
 *
 * Note: This requires the Audit Log Export API (ZohoCRM.settings.audit_logs scopes).
 */
function buildStageTransitionCriteria(
  dateFrom,
  dateTo,
  stageValue = 'Closed Won'
) {
  return {
    module: 'Deals',
    action: 'update', // Only updates (stage transitions)
    dateFrom,
    dateTo,
    fieldName: 'Stage',
    newValue: stageValue,
  };
}

function historyValue(entry, names) {
  for (const name of names) {
    const value = entry?.[name];
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') return value.name || value.value || value.display_value || null;
    return value;
  }
  return null;
}

/**
 * Returns only genuine transitions INTO Closed Won. It deliberately does not
 * infer a win timestamp from Closing_Date, Created_Time, or Modified_Time.
 */
function findClosedWonTransitions(history = [], stageMetadata = null) {
  return (Array.isArray(history) ? history : []).map((entry) => {
    const field = historyValue(entry, ['field', 'field_name', 'api_name']);
    const previousStage = historyValue(entry, ['previous_value', 'old_value', 'old', 'from_value']);
    const newStage = historyValue(entry, ['new_value', 'new', 'to_value', 'value']);
    const actualClosedWonDate = historyValue(entry, ['audited_time', 'timestamp', 'time', 'modified_time']);
    if (!/^(stage|deal_stage)$/i.test(String(field || ''))
      || isCurrentlyClosedWon(previousStage, stageMetadata)
      || !isCurrentlyClosedWon(newStage, stageMetadata)
      || !actualClosedWonDate) return null;
    return {
      dealId: historyValue(entry, ['record_id', 'deal_id', 'id']),
      previousStage,
      newStage,
      actualClosedWonDate,
      source: 'stage_history',
    };
  }).filter(Boolean);
}

function filterClosedWonTransitionsInPeriod(history = [], from, to, stageMetadata = null) {
  const start = new Date(from).valueOf();
  const end = new Date(to).valueOf();
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error('A valid half-open date range is required.');
  return findClosedWonTransitions(history, stageMetadata).filter((transition) => {
    const time = new Date(transition.actualClosedWonDate).valueOf();
    return Number.isFinite(time) && time >= start && time < end;
  });
}

/**
 * Normalizes a deal record into the standard deterministic Closed Won output shape.
 */
function normalizeDealForTransition(deal) {
  if (!deal || typeof deal !== 'object') return null;
  const owner = (() => {
    const o = deal.Owner;
    if (o && typeof o === 'object') return o.name || o.full_name || '';
    return String(o || deal.Owner_Name || '');
  })();
  return {
    dealId: String(deal.id || deal.ID || ''),
    dealName: deal.Deal_Name || deal.Deal || deal.deal_name || 'Untitled Deal',
    accountName: (() => {
      const a = deal.Account_Name;
      if (a && typeof a === 'object') return a.name || '';
      return String(a || '');
    })(),
    amount: numericAmount(deal.Amount ?? deal.amount ?? 0),
    owner,
    closingDate: deal.Closing_Date || deal.closing_date || null,
  };
}

function numericAmount(value) {
  return numericValue(value) ?? 0;
}

/**
 * PART 7 — Actual Closed Won transitions (dedicated deterministic function).
 *
 * Takes the relevant Deal records plus their stage/audit history and returns ONLY
 * genuine stage transitions INTO Closed Won during the half-open range [from, to).
 *
 * The returned date is the ACTUAL transition timestamp (from stage history) — NEVER
 * Closing_Date, Created_Time, or Modified_Time.
 *
 * @param {Array<object>} deals - Relevant Deal records (current snapshot).
 * @param {Array<object>} history - Stage history / audit entries for those deals.
 * @param {object} options
 * @param {string} options.from - Start of half-open range (ISO 8601).
 * @param {string} options.to - End of half-open range (ISO 8601, exclusive).
 * @param {object|null} options.stageMetadata - Optional org stage metadata.
 * @returns {Array<object>} Normalized transitions.
 */
function getActualClosedWonTransitions(deals = [], history = [], options = {}) {
  const { from, to, stageMetadata = null } = options;
  if (!from || !to) throw new Error('A valid half-open date range (from/to) is required.');

  const inPeriod = filterClosedWonTransitionsInPeriod(history, from, to, stageMetadata);
  const dealById = new Map(
    (Array.isArray(deals) ? deals : [])
      .map((deal) => {
        const id = String(deal?.id ?? deal?.ID ?? '');
        return id ? [id, deal] : null;
      })
      .filter(Boolean),
  );

  return inPeriod.map((transition) => {
    const deal = dealById.get(String(transition.dealId)) || {};
    const normalized = normalizeDealForTransition(deal);
    return {
      dealId: transition.dealId,
      dealName: normalized ? normalized.dealName : (deal.Deal_Name || 'Untitled Deal'),
      accountName: normalized ? normalized.accountName : '',
      amount: normalized ? normalized.amount : 0,
      owner: normalized ? normalized.owner : '',
      previousStage: transition.previousStage,
      newStage: transition.newStage || 'Closed Won',
      actualClosedWonDate: transition.actualClosedWonDate,
      closingDate: normalized ? normalized.closingDate : (deal.Closing_Date || null),
    };
  });
}

/**
 * PART 7 — Fetches the relevant Deal records + stage history from the CRM, then
 * returns the actual Closed Won transitions inside the requested half-open range.
 *
 * @param {object} options
 * @param {string} options.from - Start of half-open range (ISO 8601).
 * @param {string} options.to - End of half-open range (ISO 8601, exclusive).
 * @param {object|null} options.stageMetadata - Optional org stage metadata.
 * @param {AbortSignal|null} options.signal
 * @param {number} [options.limit]
 * @returns {Promise<{ success: boolean, count: number, data: Array<object> }>}
 *   Throws on CRM failure (never returns empty success for an API error).
 */
async function fetchActualClosedWonTransitions(options = {}) {
  const { from, to, stageMetadata = null, signal, limit = 1000 } = options;
  if (!from || !to) throw new Error('A valid half-open date range (from/to) is required.');

  const retrievalEngine = require('./retrieval-engine.service');

  const dealsResult = await retrievalEngine.getRecords('deals', {
    from: null,
    to: null,
    date_field: null,
    retrieval_mode: 'all',
    fields: ['id', 'Deal_Name', 'Amount', 'Stage', 'Closing_Date', 'Account_Name', 'Owner'],
    limit,
    signal,
  });
  const deals = Array.isArray(dealsResult?.data) ? dealsResult.data : [];

  const history = await retrievalEngine.getStageTransitionHistory({
    from,
    to,
    targetStage: 'Closed Won',
    limit,
    signal,
  });

  const data = getActualClosedWonTransitions(deals, history, { from, to, stageMetadata });
  return { success: true, count: data.length, data };
}


/**
 * Normalizes and extracts both dates from a deal record, with clear labeling.
 * Returns: { currentStage, isClosedWon, closingDate, actualClosedWonDate, actualClosedWonDateFromHistory }
 *
 * @param {object} deal - A deal record from CRM
 * @param {object} options - Optional: { stageMetadata, auditLogEntry, stageHistoryEntry }
 * @returns {object} Normalized deal with both date concepts separated
 */
function normalizeDealDates(deal = {}, options = {}) {
  const { stageMetadata = null, auditLogEntry = null, stageHistoryEntry = null } =
    options;

  const currentStage = deal.Stage || deal.stage || null;
  const isClosedWon = isCurrentlyClosedWon(currentStage, stageMetadata);
  const closingDate = deal.Closing_Date || deal.closing_date || null;

  let actualClosedWonDate = null;
  let actualClosedWonDateFromHistory = null;

  // If we have audit log or history info, extract the actual transition time
  if (auditLogEntry && auditLogEntry.new_value === 'Closed Won') {
    actualClosedWonDate = auditLogEntry.time || auditLogEntry.audited_time;
    actualClosedWonDateFromHistory = true;
  } else if (
    stageHistoryEntry &&
    stageHistoryEntry.new === 'Closed Won'
  ) {
    actualClosedWonDate = stageHistoryEntry.timestamp || stageHistoryEntry.modified_time;
    actualClosedWonDateFromHistory = true;
  }

  return {
    dealId: deal.id,
    dealName: deal.Deal_Name || deal.deal_name,
    currentStage,
    isClosedWon,
    closingDate,
    actualClosedWonDate,
    actualClosedWonDateFromHistory,
    validation: {
      futureClosingDateWithClosedWon:
        isClosedWon &&
        closingDate &&
        new Date(closingDate) > new Date(),
      pastClosingDateWithOpen:
        !isClosedWon &&
        closingDate &&
        new Date(closingDate) < new Date(),
      missingClosingDate: isClosedWon && !closingDate,
      mismatchedDates:
        actualClosedWonDate &&
        closingDate &&
        String(actualClosedWonDate).slice(0, 10) !==
          String(closingDate).slice(0, 10),
    },
  };
}

/**
 * Validates a deal against business rules and returns warnings/errors.
 *
 * @param {object} deal - A deal record
 * @param {object} stageMetadata - Optional: Zoho CRM stage metadata
 * @returns {object} { valid, warnings, errors }
 */
function validateDealClosedWonLogic(deal = {}, stageMetadata = null) {
  const warnings = [];
  const errors = [];
  const normalized = normalizeDealDates(deal, { stageMetadata });

  // Rule 1: Closed Won with future Closing_Date should be noted (not an error, but unusual)
  if (normalized.validation.futureClosingDateWithClosedWon) {
    warnings.push(
      `Deal ${normalized.dealId} is Closed Won but has a future Closing_Date (${normalized.closingDate})`
    );
  }

  // Rule 2: Open deal with past Closing_Date should be noted
  if (normalized.validation.pastClosingDateWithOpen) {
    warnings.push(
      `Deal ${normalized.dealId} is Open but has a past Closing_Date (${normalized.closingDate})`
    );
  }

  // Rule 3: Closed Won deal should have a Closing_Date
  if (normalized.validation.missingClosingDate) {
    warnings.push(
      `Deal ${normalized.dealId} is Closed Won but missing Closing_Date`
    );
  }

  // Rule 4: If we have both Actual Closed Won Date and Closing_Date, they should typically match
  if (normalized.validation.mismatchedDates) {
    warnings.push(
      `Deal ${normalized.dealId} transitioned to Closed Won on ${normalized.actualClosedWonDate} ` +
        `but Closing_Date is ${normalized.closingDate}`
    );
  }

  return {
    valid: errors.length === 0,
    warnings,
    errors,
    normalized,
  };
}

/**
 * Resolves what "Closed Won" means from natural language and determines interpretation.
 *
 * @param {string} question - The natural language question
 * @returns {object} { interpretation, requiresStageHistory, dateFieldPreference }
 *
 * Example interpretations:
 * - "Closed Won deals in July" → { interpretation: 'currentStatus', requiresStageHistory: false }
 * - "Deals that closed in July" → { interpretation: 'transitionDate', requiresStageHistory: true }
 * - "Closed Won with July Closing_Date" → { interpretation: 'closingDateOnly', requiresStageHistory: false }
 */
function interpretClosedWonQuery(question = '') {
  const q = String(question).toLowerCase();

  // Check for transition/became patterns
  const requiresStageHistory =
    /\b(became|turned|transitioned|changed|moved|went)\b/i.test(question) ||
    /\b(when|date)\s+.*\b(actually|became|closed)\b/i.test(question) ||
    /\bactually\s+closed\b/i.test(question) ||
    /\bdeals\s+that\s+closed\b/i.test(question) ||
    /\bwhen\s+.*\b(closed|won)\b/i.test(question);

  // Check if explicitly asking about Closing_Date (with various separators and spacing)
  const isExplicitClosingDate = /closing[-_\s]*date/i.test(question);

  // Determine date field preference
  let dateFieldPreference = 'Closing_Date'; // Default
  if (/\b(created|made)\b/i.test(question)) {
    dateFieldPreference = 'Created_Time';
  } else if (/\b(modified|updated)\b/i.test(question)) {
    dateFieldPreference = 'Modified_Time';
  }

  // Determine interpretation
  let interpretation = 'currentStatus'; // Default: filter by current Stage
  if (requiresStageHistory) {
    interpretation = 'transitionDate'; // Needs stage history
  } else if (isExplicitClosingDate) {
    interpretation = 'closingDateOnly'; // Explicitly asking about Closing_Date field
  }

  return {
    interpretation,
    requiresStageHistory,
    dateFieldPreference,
  };
}

module.exports = {
  getActualClosedWonTransitions,
  fetchActualClosedWonTransitions,
  isCurrentlyClosedWon,
  isCurrentlyClosedLost,
  isCurrentlyOpen,
  isValidClosingDate,
  filterCurrentlyClosedWon,
  getClosedWonDeals,
  calculateClosedWonMetrics,
  filterClosedWonWithClosingDate,
  disambiguateClosedWonDateQuery,
  buildClosedWonWithClosingDateCriteria,
  buildStageTransitionCriteria,
  findClosedWonTransitions,
  filterClosedWonTransitionsInPeriod,
  normalizeDealDates,
  validateDealClosedWonLogic,
  interpretClosedWonQuery,
  CLOSED_WON_STAGE_MAPPINGS,
};
