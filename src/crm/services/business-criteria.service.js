const MONTH_OR_PERIOD_PATTERN = /\b(today|yesterday|tomorrow|this\s+week|last\s+week|this\s+month|current\s+month|month[-\s]+to[-\s]+date|last\s+month|previous\s+month|this\s+quarter|last\s+quarter|this\s+year|last\s+year|last\s+\d+\s+months?|january|february|march|april|may|june|july|august|september|october|november|december|between\s+.*\s+and\s+.*|from\s+.*\s+to\s+.*)\b/i;
const BUSINESS_ACTIVITY_PATTERN = /\b(data|business\s+data|business\s+activity|sales?|revenue|amount|value|deal(?:s)?|customer\s+data|customers?)\b/i;
const EXPLICIT_CREATION_PATTERN = /\b(created|creation|added|newly\s+created)\b/i;
const NEW_CUSTOMER_PATTERN = /\bnew\s+(?:customers?|accounts?|records?)\b|\b(?:customers?|accounts?|records?)\s+(?:created|added)\b/i;
const EXISTING_ONLY_PATTERN = /\bexisting\s+(?:customers?|accounts?|records?)\s+only\b|\bonly\s+existing\s+(?:customers?|accounts?|records?)\b/i;
const NEW_ONLY_PATTERN = /\bnew\s+(?:customers?|accounts?|records?)\s+only\b|\bonly\s+new\s+(?:customers?|accounts?|records?)\b/i;

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
  if (moduleKey === 'deals' && /closed|closing|sales?|revenue|amount|value|customer|data/.test(text)) return 'Closing_Date';
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
