const MONTH_OR_PERIOD_PATTERN = /\b(today|yesterday|tomorrow|this\s+week|last\s+week|this\s+month|current\s+month|next\s+month|month[-\s]+to[-\s]+date|last\s+month|previous\s+month|this\s+quarter|last\s+quarter|this\s+year|last\s+year|last\s+\d+\s+months?|january|february|march|april|may|june|july|august|september|october|november|december|between\s+.*\s+and\s+.*|from\s+.*\s+to\s+.*)\b/i;
const BUSINESS_ACTIVITY_PATTERN = /\b(data|business\s+data|business\s+activity|sales?|revenue|amount|value|deal(?:s)?|customer\s+data|customers?)\b/i;
const EXPLICIT_CREATION_PATTERN = /\b(created|creation|added|newly\s+created)\b/i;
const NEW_CUSTOMER_PATTERN = /\bnew\s+(?:customers?|accounts?|records?)\b|\b(?:customers?|accounts?|records?)\s+(?:created|added)\b/i;
const EXISTING_ONLY_PATTERN = /\bexisting\s+(?:customers?|accounts?|records?)\s+only\b|\bonly\s+existing\s+(?:customers?|accounts?|records?)\b/i;
const NEW_ONLY_PATTERN = /\bnew\s+(?:customers?|accounts?|records?)\s+only\b|\bonly\s+new\s+(?:customers?|accounts?|records?)\b/i;
const CLOSED_WON_STATUS_PATTERN = /\b(closed\s+won|closed\s+lost|already\s+closed|already\s+won|currently\s+closed)\b/i;
const CLOSED_WON_IN_PERIOD_PATTERN = /\b(?:closed\s+won|won)\b[\s\S]{0,40}\b(?:in|during|on|of)\s+(?:january|february|march|april|may|june|july|august|september|october|november|december|last\s+month|this\s+month)\b/i;

const DATE_FIELDS_BY_MODULE = {
  deals: 'Closing_Date',
  events: 'Start_DateTime',
  meetings: 'Start_DateTime',
  tasks: 'Due_Date',
  campaigns: 'Start_Date',
  calls: 'Call_Start_Time',
  'renewal-accounts': 'Renewal_Date',
};

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function hasPeriodRequest(question) {
  return MONTH_OR_PERIOD_PATTERN.test(normalizeText(question));
}

function isExplicitCreationRequest(question) {
  const text = normalizeText(question);
  return EXPLICIT_CREATION_PATTERN.test(text) || NEW_CUSTOMER_PATTERN.test(text);
}

function isExplicitModifiedRequest(question) {
  return /\b(modified|updated|changed)\b/i.test(normalizeText(question));
}

function getCustomerRecordScope(question) {
  const text = normalizeText(question);
  if (EXISTING_ONLY_PATTERN.test(text)) return 'existing';
  if (NEW_ONLY_PATTERN.test(text)) return 'new';
  return 'all';
}

function shouldDefaultMonthlyBusinessActivityToDeals(question) {
  const text = normalizeText(question);
  return hasPeriodRequest(text)
    && BUSINESS_ACTIVITY_PATTERN.test(text)
    && !isExplicitCreationRequest(text)
    && !/\b(leads?|contacts?|vendors?|products?|tasks?|calls?|meetings?|events?|quotes?|sales\s+orders?|purchase\s+orders?)\b/i.test(text);
}

function selectBusinessDateField(moduleKey, question, conversionFields = []) {
  const text = normalizeText(question);
  
  if (moduleKey === 'leads' && /conver/.test(text)) {
    return conversionFields.find((field) => /converted.*(date|time)|converted_time/i.test(field)) || 'Converted_Date_Time';
  }
  
  if (isExplicitModifiedRequest(text)) return 'Modified_Time';
  if (isExplicitCreationRequest(text)) return 'Created_Time';
  
  // CRITICAL: For deals, distinguish between current Closed Won STATUS vs. DATE FILTERS
  if (moduleKey === 'deals') {
    // "close watch" has no stable CRM meaning. It must be resolved through
    // conversation context before a date field is selected.
    if (/\bclose\s+watch\b/i.test(text)) return null;

    // Handle stage-history queries first: these are about when a deal transitioned,
    // not about current status or Closing_Date logic.
    const stageHistoryTransition = /\b(became|turned|transitioned|changed\s+to|when\s+did)\b/i.test(text)
      && /\b(closed\s+won|closed\s+lost|won|lost)\b/i.test(text);
    if (stageHistoryTransition) {
      return null;
    }

    // Check if asking about Closed Won/Closed Lost status
    if (CLOSED_WON_STATUS_PATTERN.test(text)) {
      // Current-status questions should not use Closing_Date as proof of closure.
      // Examples: "already closed won", "currently closed won", "which deals are closed won"
      if (/\balready\b|\bcurrently\b|\bnow\b|\bhow\s+many\b|\bcount\b|\bwhich\s+deals\b|\bshow\s+me\b|\bgive\s+me\b/i.test(text)) {
        if (!MONTH_OR_PERIOD_PATTERN.test(text) && !/closing\s*date/i.test(text)) {
          return null;
        }
      }

      // This lower-level legacy selector has no business request context;
      // preserve a date field for direct query-builder callers. The central
      // intent resolver overrides this to audit history for a Closed Won
      // event-in-period request.
      if (MONTH_OR_PERIOD_PATTERN.test(text) || /closing[-_\s]*date|expected\s+to\s+close|expected\s+closing/i.test(text)) {
        return 'Closing_Date';
      }

      // Otherwise, default to current-status behavior and ignore Closing_Date as proof.
      return null;
    }

    // For other deal queries with "sales", "revenue", "amount", "value" that don't involve status
    if (/sales?|revenue|amount|value|customer|data/.test(text)) return 'Closing_Date';
  }
  
  return DATE_FIELDS_BY_MODULE[moduleKey] || 'Created_Time';
}

module.exports = {
  getCustomerRecordScope,
  hasPeriodRequest,
  isExplicitCreationRequest,
  isExplicitModifiedRequest,
  selectBusinessDateField,
  shouldDefaultMonthlyBusinessActivityToDeals,
};
