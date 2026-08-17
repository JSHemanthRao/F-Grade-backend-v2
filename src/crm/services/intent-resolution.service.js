/**
 * Central CRM Intent Resolution Service
 *
 * Converts natural-language CRM requests into a normalized internal request object
 * before any Zoho API call.
 *
 * Handles:
 * 1. Phonetic/typo correction (speech-to-text errors)
 * 2. Intent classification
 * 3. Conversational context preservation
 * 4. Date resolution
 * 5. Business rule interpretation
 */

const logger = require('../../common/logging/logger');
const { detectTimeRange } = require('./assistant/date-detector.service');
const { detectIntents } = require('./assistant/intent-detector.service');
const { resolveConversationContext } = require('./assistant/conversation-context.service');
const { getModuleDefinition, getSupportedModuleKeys } = require('./module-definition.service');

const CLOSED_WON_PATTERN = /\b(?:closed\s+(?:won|deals?)|closedwon|won)\b/i;
const EXPLICIT_CLOSING_DATE_PATTERN = /\b(?:closing[-_\s]*date|expected\s+to\s+close|expected\s+closing|close\s+date)\b/i;
const ACTUAL_CLOSED_WON_PATTERN = /\b(?:actually|became|become|turned|transitioned|moved|went|were)\b[\s\S]{0,40}\b(?:closed\s+won|won)\b|\b(?:deals?\s+)?won\s+(?:in|during|on)\b|\bclosed\s+won\s+deals?\s+of\b/i;
const CLOSE_WATCH_PATTERN = /\bclose\s+watch\b/i;

// Phonetic/typo correction mappings for common CRM speech-to-text errors
const PHONETIC_CORRECTIONS = {
  // Closed Won variations
  'closed one': 'Closed Won',
  'close one': 'Closed Won',
  'closed won': 'Closed Won',
  'closedwon': 'Closed Won',
  'closed-won': 'Closed Won',
  'close won': 'Closed Won',
  'closed wone': 'Closed Won',
  'closed whon': 'Closed Won',

  // Closed Lost variations
  'closed lost': 'Closed Lost',
  'close lost': 'Closed Lost',
  'closedlost': 'Closed Lost',
  'closed-lost': 'Closed Lost',
  'close lost': 'Closed Lost',

  // Common typos and speech errors
  'dales': 'Deals',
  'deals': 'Deals',
  'leads': 'Leads',
  'leds': 'Leads',
  'contacts': 'Contacts',
  'accounts': 'Accounts',
  'acount': 'Account',
  'acounts': 'Accounts',
  'revenue': 'revenue',
  'revenu': 'revenue',
  'amount': 'amount',
  'amout': 'amount',
  'closing date': 'Closing_Date',
  'close date': 'Closing_Date',
  'closed date': 'Closing_Date',
  'created date': 'Created_Time',
  'create date': 'Created_Time',
};

/**
 * Apply phonetic correction to question
 * Detects common speech-to-text errors and corrects them
 *
 * @param {string} question - The raw user question
 * @returns {object} { original, corrected, hasCorrected, corrections }
 */
function applyPhoneticCorrection(question) {
  if (!question) {
    return { original: '', corrected: '', hasCorrected: false, corrections: [] };
  }

  let corrected = question;
  const corrections = [];
  const text = String(question).toLowerCase();

  // Apply phonetic corrections
  Object.entries(PHONETIC_CORRECTIONS).forEach(([typo, correct]) => {
    const pattern = new RegExp(`\\b${typo}\\b`, 'gi');
    if (pattern.test(text)) {
      corrections.push({ from: typo, to: correct });
      corrected = corrected.replace(pattern, correct);
    }
  });

  return {
    original: question,
    corrected,
    hasCorrected: corrections.length > 0,
    corrections,
  };
}

/**
 * Detect CRM module from question
 *
 * @param {string} question - The user question
 * @param {object} context - Conversation context
 * @returns {string|null} Module key (e.g., 'deals', 'leads', 'contacts')
 */
function detectModule(question, context = {}) {
  const text = String(question).toLowerCase();
  const supportedModules = getSupportedModuleKeys();

  // Check for explicit module mention
  for (const moduleKey of supportedModules) {
    const moduleDefinition = getModuleDefinition(moduleKey);
    if (!moduleDefinition) continue;

    const patterns = [
      new RegExp(`\\b${moduleKey}\\b`, 'i'),
      new RegExp(`\\b${moduleDefinition.label}\\b`, 'i'),
      ...(moduleDefinition.aliases || []).map((alias) => new RegExp(`\\b${alias}\\b`, 'i')),
    ];

    if (patterns.some((pattern) => pattern.test(text))) {
      return moduleKey;
    }
  }

  // Check conversational context for previously used module
  if (context?.previousModules && context.previousModules.length > 0) {
    return context.previousModules[0];
  }

  // Try to infer from question content
  if (/revenue|amount|deal|sales|opportunity|close|closing/.test(text)) return 'deals';
  if (/lead|prospect|potential/.test(text)) return 'leads';
  if (/contact|person|email|phone/.test(text)) return 'contacts';
  if (/account|company|organization/.test(text)) return 'accounts';
  if (/activity|update|change|modify/.test(text)) return null; // Activity questions

  return null;
}

/**
 * Determine the operation type (query, count, activity, dashboard)
 *
 * @param {string} question - The user question
 * @param {array} intents - Detected intents
 * @returns {string} Operation type
 */
function determineOperation(question, intents = []) {
  const text = String(question).toLowerCase();

  if (intents.includes('ACTIVITY')) return 'activity';
  if (intents.includes('DASHBOARD')) return 'dashboard';
  if (/how\s+many|count|total|number\s+of/.test(text)) return 'count';
  if (/activity|change|update|what\s+did/.test(text)) return 'activity';

  return 'query';
}

/**
 * Detect status/category filter (e.g., Closed Won, Open, Closed Lost)
 *
 * @param {string} question - The user question
 * @returns {string|null} Status value
 */
function detectStatus(question) {
  const text = String(question).toLowerCase();

  if (/\bclosed\s+lost\b|\bclosed lost\b/.test(text)) {
    return 'Closed Lost';
  }
  if (/\bclosed\s+won\b|\bclosed won\b|\balready\s+closed\s+won\b|\bcurrently\s+closed\s+won\b/.test(text)) {
    return 'Closed Won';
  }
  if (/\b(?:closed\s+deals?|closed\s+sales?|deals?\s+closed\s+(?:last|this|in|during|on)|deals?\s+that\s+are\s+closed)\b/.test(text)) {
    return 'Closed Won';
  }
  if (/\bopen\b|\bunwon\b|\bin\s+progress\b/.test(text)) {
    return 'Open';
  }

  return null;
}

/**
 * Detect if query is about stage history (when deal became Closed Won)
 *
 * @param {string} question - The user question
 * @returns {boolean} True if asking about stage transition history
 */
function detectStageHistory(question) {
  const text = String(question).toLowerCase();
  return ACTUAL_CLOSED_WON_PATTERN.test(text)
    || (/\b(became|turned|transitioned|changed\s+to|when\s+did|when\s+was)\b/i.test(text)
      && /\b(closed\s+won|closed\s+lost|won|lost|stage|category)\b/i.test(text));
}

/**
 * Makes the date concept explicit before the request reaches a query builder.
 * Closing_Date is an expected date; actual_closed_won_date is audit history.
 */
function resolveDealDateMeaning(question, context = {}) {
  const text = String(question || '').toLowerCase();
  const hasPeriod = Boolean(resolveDateRange(question).from);
  const closedWon = CLOSED_WON_PATTERN.test(text);
  const expectedClose = /\bexpected\s+to\s+close\b/i.test(text);

  if (CLOSE_WATCH_PATTERN.test(text)) {
    const priorWasClosedWon = /\bclosed\s+won\b/i.test(String(context.lastQuestion || context.previousQuestion || ''))
      || context.lastPlan?.businessRequest?.status === 'Closed Won';
    return priorWasClosedWon
      ? { dateMeaning: hasPeriod ? 'actual_closed_won_date' : 'current_status', requiresStageHistory: hasPeriod, ambiguous: false }
      : { dateMeaning: 'ambiguous', requiresStageHistory: false, ambiguous: true };
  }

  if (expectedClose) return { dateMeaning: 'expected_closing_date', requiresStageHistory: false, ambiguous: false };
  if (EXPLICIT_CLOSING_DATE_PATTERN.test(text)) return { dateMeaning: 'closing_date', requiresStageHistory: false, ambiguous: false };
  if (closedWon && detectStageHistory(text)) {
    return { dateMeaning: 'actual_closed_won_date', requiresStageHistory: true, ambiguous: false };
  }
  if (closedWon && hasPeriod) {
    return { dateMeaning: 'closing_date', requiresStageHistory: false, ambiguous: false };
  }
  if (closedWon) return { dateMeaning: 'current_status', requiresStageHistory: false, ambiguous: false };
  // For deals queries with explicit "created" or "modified", let the resolveBusinessRequest
  // date field selection logic handle it based on keywords, not dateMeaning
  if (/\bcreated|creation|added|newly\s+created\b/i.test(text)) return { dateMeaning: null, requiresStageHistory: false, ambiguous: false };
  if (/\bmodified|updated|changed\b/i.test(text)) return { dateMeaning: null, requiresStageHistory: false, ambiguous: false };
  // Default: period queries that aren't about Closed Won or explicit fields use Closing_Date
  return { dateMeaning: hasPeriod ? 'closing_date' : null, requiresStageHistory: false, ambiguous: false };
}

/**
 * Resolve date range from question
 *
 * @param {string} question - The user question
 * @returns {object} { from, to, period }
 */
function resolveDateRange(question) {
  const timeRange = detectTimeRange(question);

  if (timeRange?.startDate && timeRange?.endDate) {
    return {
      from: timeRange.startDate,
      to: timeRange.endDate,
      period: timeRange.period || 'custom',
    };
  }

  return { from: null, to: null, period: null };
}

/**
 * Normalize a CRM business request to standard internal format
 *
 * Input: Natural-language user question
 * Output: Normalized request object:
 * {
 *   "module": "deals|leads|contacts|accounts",
 *   "operation": "query|count|activity|dashboard",
 *   "status": "Closed Won|Open|Closed Lost|...",
 *   "category": "Closed Won|...",
 *   "date_field": "Closing_Date|Created_Time|...",
 *   "from": "ISO date",
 *   "to": "ISO date",
 *   "user": "employee name",
 *   "limit": number,
 *   "filters": [],
 *   "sort": "field name",
 *   "metrics": [],
 *   "group_by": [],
 *   "original_question": "raw user input",
 *   "corrected_question": "after phonetic correction",
 *   "intents": ["INTENT1", "INTENT2"],
 *   "requires_stage_history": boolean,
 *   "interpretation": "currentStatus|transitionDate|dateRange"
 * }
 *
 * @param {string} question - Raw user question
 * @param {object} context - Conversation context from previous turns
 * @returns {object} Normalized business request
 */
function resolveBusinessRequest(question, context = {}) {
  if (!question) {
    throw new Error('Question is required for intent resolution');
  }

  // Step 1: Apply phonetic correction
  const phonetic = applyPhoneticCorrection(question);
  const correctedQuestion = phonetic.corrected;

  // Step 2: Resolve conversation context
  const conversationContext = resolveConversationContext(correctedQuestion, context);

  // Step 3: Detect intents
  const intents = detectIntents(correctedQuestion);

  // Step 4: Detect module
  const module = detectModule(correctedQuestion, conversationContext);

  // Step 5: Determine operation
  const operation = determineOperation(correctedQuestion, intents);

  // Step 6: Detect status/category
  const status = detectStatus(correctedQuestion);

  // Step 7: Detect stage history requirement (deals module only)
  let dealDateMeaning = { dateMeaning: null, requiresStageHistory: false, ambiguous: false };
  if (module === 'deals') {
    dealDateMeaning = resolveDealDateMeaning(correctedQuestion, context);
  }
  const requiresStageHistory = dealDateMeaning.requiresStageHistory || detectStageHistory(correctedQuestion);

  // Step 8: Resolve date range
  const dateRange = resolveDateRange(correctedQuestion);

  // Step 9: Determine date field based on operation and intent
  let dateField = null;
  if (operation === 'query' || operation === 'count' || operation === 'dashboard') {
    if (dealDateMeaning.dateMeaning === 'closing_date' || dealDateMeaning.dateMeaning === 'expected_closing_date') {
      dateField = 'Closing_Date';
    } else if (status && !requiresStageHistory) {
      // Current status query (no date field)
      dateField = null;
    } else if (/created|creation/.test(correctedQuestion)) {
      dateField = 'Created_Time';
    } else if (/modified|updated/.test(correctedQuestion)) {
      dateField = 'Modified_Time';
    }
  }

  // Step 10: Determine interpretation type
  let interpretation = 'currentStatus';
  if (requiresStageHistory) {
    interpretation = 'transitionDate';
  } else if (dealDateMeaning.dateMeaning === 'closing_date' && dateRange.from && dateRange.to && status) {
    interpretation = 'dateRange';
  }

  const normalizedRequest = {
    module,
    operation,
    status: status || undefined,
    category: status || undefined,
    date_field: dateField,
    from: dateRange.from || undefined,
    to: dateRange.to || undefined,
    period: dateRange.period || undefined,
    user: conversationContext.previousModules?.[0] || undefined,
    limit: undefined, // Will be set by retrieval policy
    filters: [],
    sort: undefined,
    metrics: [],
    group_by: [],
    original_question: question,
    corrected_question: correctedQuestion,
    intents,
    requires_stage_history: requiresStageHistory,
    dateMeaning: dealDateMeaning.dateMeaning || undefined,
    intent: dealDateMeaning.dateMeaning === 'actual_closed_won_date'
      ? 'closed_won_in_period'
      : dealDateMeaning.dateMeaning === 'closing_date' && status === 'Closed Won'
        ? 'closed_won_with_closing_date_in_period'
        : status === 'Closed Won'
          ? 'current_closed_won'
          : undefined,
    requires_clarification: dealDateMeaning.ambiguous || undefined,
    interpretation,
    conversation_context: {
      previousQuestion: conversationContext.previousQuestion,
      previousModules: conversationContext.previousModules,
      previousTimeRange: conversationContext.previousTimeRange,
      hasReference: conversationContext.hasReference,
    },
  };

  if (dateRange.from && dateRange.to) {
    logger.info('CRM normalized request', {
      intent: normalizedRequest.intent || (requiresStageHistory ? 'closed_won_in_period' : 'date_filtered_query'),
      module: module === 'deals' ? 'Deals' : module,
      status: normalizedRequest.status || null,
      dateMeaning: normalizedRequest.dateMeaning || null,
      from: dateRange.from,
      to: dateRange.to,
    });
  }

  // Clean up undefined values
  return Object.fromEntries(
    Object.entries(normalizedRequest).filter(([, value]) => value !== undefined)
  );
}

/**
 * Log intent resolution for debugging
 *
 * @param {string} question - The user question
 * @param {object} normalizedRequest - The normalized request
 */
function logIntentResolution(question, normalizedRequest) {
  if (process.env.DEBUG_ASSISTANT !== 'true') {
    return;
  }

  logger.info('Intent Resolution', {
    originalQuestion: question,
    normalizedRequest,
  });
}

module.exports = {
  resolveBusinessRequest,
  detectModule,
  determineOperation,
  detectStatus,
  detectStageHistory,
  resolveDealDateMeaning,
  resolveDateRange,
  applyPhoneticCorrection,
  logIntentResolution,
};
