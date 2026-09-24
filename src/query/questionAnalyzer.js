const { CRM_MODULES } = require('../constants/crmModules');
const { validateCrmQuery } = require('../validators/crmQuery.validator');
const { resolveRelativePeriod, relativePeriodFromText } = require('../utils/relativeDate');
const { createAppError } = require('../utils/errors');

const MODULE_ALIASES = [
  ['deal', 'Deals'], ['deals', 'Deals'],
  ['lead', 'Leads'], ['leads', 'Leads'],
  ['contact', 'Contacts'], ['contacts', 'Contacts'],
  ['account', 'Accounts'], ['accounts', 'Accounts'],
  ['task', 'Tasks'], ['tasks', 'Tasks'],
  ['call', 'Calls'], ['calls', 'Calls'],
  ['meeting', 'Meetings'], ['meetings', 'Meetings'],
  ['product', 'Products'], ['products', 'Products']
];

function analyzeCrmQuestion(question, context = {}) {
  const text = String(question || '').trim();
  if (!text) {
    throw createAppError('QUESTION_REQUIRED', 'A natural-language CRM question is required.', 400);
  }

  const lower = text.toLowerCase();
  const module = detectModule(lower);
  const operation = /\b(?:how many|count|number of|total number)\b/.test(lower) ? 'count' : 'list';
  const filters = [];
  const sort = [];

  const stageFilter = detectStageFilter(lower);
  if (stageFilter) filters.push(stageFilter);

  const amountFilter = detectAmountFilter(lower);
  if (amountFilter) filters.push(amountFilter);

  const dateFilter = detectDateFilter(lower, module);
  if (dateFilter) filters.push(dateFilter);

  const detectedSort = detectSort(lower, module);
  if (detectedSort) sort.push(detectedSort);

  const limit = normalizeLimit(context.limit ?? extractExplicitLimit(lower), lower);
  const offset = Number.isInteger(Number(context.offset)) ? Number(context.offset) : 0;

  const canonical = {
    module,
    operation,
    filters,
    sort,
    pagination: { limit, offset }
  };

  validateCanonicalQuestion(canonical);
  return canonical;
}

function detectModule(lower) {
  for (const [alias, moduleName] of MODULE_ALIASES) {
    const pattern = new RegExp(`\\b${escapeRegExp(alias)}\\b`, 'i');
    if (pattern.test(lower)) return moduleName;
  }
  for (const moduleName of Object.keys(CRM_MODULES)) {
    const match = new RegExp(`\\b${escapeRegExp(moduleName.toLowerCase())}\\b`, 'i');
    if (match.test(lower)) return moduleName;
  }
  throw createAppError('MODULE_NOT_FOUND', `I couldn't determine which CRM module '${lower}' refers to.`, 400, { requested_question: lower });
}

function detectStageFilter(lower) {
  if (/\b(?:closed won|closed-won)\b/.test(lower)) return { field: 'Stage', operator: 'equals', value: 'Closed Won' };
  if (/\b(?:closed lost|closed-lost)\b/.test(lower)) return { field: 'Stage', operator: 'equals', value: 'Closed Lost' };
  if (/\bopen\b/.test(lower) && /\bdeal(s)?\b/.test(lower)) return { field: 'Stage', operator: 'equals', value: 'Open' };
  return null;
}

function detectAmountFilter(lower) {
  const amountMatch = lower.match(/(?:amount|value|revenue)\s*(?:is\s+)?(?:greater than|above|over|more than|>=|>)\s*[$₹]?\s*(\d[\d,]*)/i);
  if (amountMatch) return { field: 'Amount', operator: 'greater_than', value: Number(amountMatch[1].replace(/,/g, '')) };

  const bareThresholdMatch = lower.match(/(?:^|\s)(?:above|over|more than|greater than|>)\s*[$₹]?\s*(\d[\d,]*)\b/i);
  if (bareThresholdMatch && /\bdeals?\b/.test(lower)) {
    return { field: 'Amount', operator: 'greater_than', value: Number(bareThresholdMatch[1].replace(/,/g, '')) };
  }

  const topMatch = lower.match(/(?:top|highest|largest|maximum)\s+(\d+)\b/i);
  if (topMatch && /deals?\b/.test(lower) && /amount\b|value\b/.test(lower)) {
    return null;
  }
  return null;
}

function detectDateFilter(lower, module) {
  const explicitDays = lower.match(/(?:in\s+the\s+)?(?:last|past|previous)\s+(\d+)\s+days|(?:for\s+the\s+)?(?:last|past|previous)\s+(\d+)\s+days|\b(\d+)\s+days\s+ago\b/i);
  if (explicitDays) {
    const days = Number(explicitDays[1] || explicitDays[2] || explicitDays[3]);
    if (days > 0) {
      if (/\b(?:modified|updated|not updated)\b/.test(lower)) return buildRelativeDaysFilter('Modified_Time', days, 'last');
      if (/\b(?:created|added|new)\b/.test(lower)) return buildRelativeDaysFilter('Created_Time', days, 'last');
      if (/\b(?:due|deadline|due date)\b/.test(lower) || /\btask(s)?\b/.test(lower)) return buildRelativeDaysFilter('Due_Date', days, 'last');
    }
  }

  const datePeriod = relativePeriodFromText(lower);
  if (!datePeriod) return null;

  if (/\b(?:created|added|new)\b/.test(lower)) {
    return buildDateRangeFilter('Created_Time', datePeriod);
  }

  if (/\b(?:modified|updated|not updated)\b/.test(lower)) {
    return buildDateRangeFilter('Modified_Time', datePeriod);
  }

  if (/\b(?:due|deadline|due date)\b/.test(lower) || (/\btask(s)?\b/.test(lower) && /\bnext\s+week\b/.test(lower))) {
    return buildDateRangeFilter('Due_Date', datePeriod);
  }

  if (/\b(?:closing|close)\b/.test(lower) && /\b(?:date|deadline)\b/.test(lower)) {
    return buildDateRangeFilter('Closing_Date', datePeriod);
  }

  if (module === 'Leads' && /\bcreated\b/.test(lower)) {
    return buildDateRangeFilter('Created_Time', datePeriod);
  }

  return null;
}

function buildDateRangeFilter(field, period) {
  const bounds = resolveRelativePeriod(period);
  if (!bounds) return null;
  return {
    field,
    operator: 'between',
    value: [bounds.start, bounds.end],
    date_range: { field, start: bounds.start, end: bounds.end, period, timezone: bounds.timeZone || 'Asia/Kolkata' }
  };
}

function buildRelativeDaysFilter(field, days, direction) {
  const now = new Date();
  const end = new Date(now);
  const start = new Date(now);
  start.setDate(start.getDate() - days);
  return {
    field,
    operator: 'between',
    value: [formatDate(start), formatDate(end)],
    date_range: { field, start: formatDate(start), end: formatDate(end), period: `${direction} ${days} days`, timezone: 'Asia/Kolkata' }
  };
}

function formatDate(date) {
  return new Date(date.getTime() - (date.getTimezoneOffset() * 60000)).toISOString().slice(0, 10);
}

function detectSort(lower, module) {
  const sortMatch = lower.match(/(?:sorted by|sort by)\s+(.+?)(?:\s+(?:limit|top|offset)|$)/i);
  if (sortMatch) {
    const phrase = sortMatch[1].trim();
    if (/closing[_\s-]*date|close date/i.test(phrase) && /(descending|desc|newest|latest|highest)/i.test(phrase)) {
      return { field: 'Closing_Date', order: 'desc' };
    }
    if (/amount|value|revenue/i.test(phrase) && /(descending|desc|newest|latest|highest|largest|top)/i.test(phrase)) {
      return { field: 'Amount', order: 'desc' };
    }
    if (/amount|value|revenue/i.test(phrase) && /(ascending|asc|lowest|oldest|smallest)/i.test(phrase)) {
      return { field: 'Amount', order: 'asc' };
    }
  }

  if (/\b(?:top|highest|largest|maximum|most expensive)\b/.test(lower) && /\b(?:amount|value|revenue)\b/.test(lower)) {
    return { field: 'Amount', order: 'desc' };
  }

  if (/\b(?:sort(?:ed)? by|sorted by)\s+.*\b(?:closing[_\s-]*date|close date)\b/i.test(lower) && /(descending|desc|newest|latest)/i.test(lower)) {
    return { field: 'Closing_Date', order: 'desc' };
  }

  if (/\b(?:latest|newest|most recent|recent)\b/.test(lower) && (module === 'Contacts' || module === 'Leads' || module === 'Deals')) {
    return { field: module === 'Deals' ? 'Closing_Date' : 'Created_Time', order: 'desc' };
  }

  if (/\b(?:earliest|oldest|first)\b/.test(lower) && (/created\b|date\b|modified\b/).test(lower)) {
    return { field: 'Created_Time', order: 'asc' };
  }

  return null;
}

function normalizeLimit(requestedLimit, lower) {
  const hasDateWindowCount = /\b(?:last|past|previous|next)\s+\d+\s+days?\b|\b\d+\s+days?\s+ago\b/i.test(lower);
  const explicitLimit = hasDateWindowCount
    ? null
    : lower.match(/\b(?:top|first|last)\s+(\d+)\b(?!\s+days?\b)/i)
      || lower.match(/\b(?:show\s+me|give\s+me|fetch|return|get)\s+(?:the\s+)?(\d+)\b(?!\s+days?\b)/i)
      || lower.match(/\b(\d+)\s+(?:records?|deals?|leads?|contacts?|accounts?|tasks?|products?|quotes?|sales\s+orders?|purchase\s+orders?|invoices?)\b/i);
  if (explicitLimit) return Math.min(Number(explicitLimit[1] || explicitLimit[0]), 200);
  if (Number.isInteger(Number(requestedLimit)) && Number(requestedLimit) > 0) return Math.min(Number(requestedLimit), 200);
  return 20;
}

function extractExplicitLimit(lower) {
  const hasDateWindowCount = /\b(?:last|past|previous|next)\s+\d+\s+days?\b|\b\d+\s+days?\s+ago\b/i.test(lower);
  const match = hasDateWindowCount
    ? null
    : lower.match(/\b(?:top|first|last)\s+(\d+)\b(?!\s+days?\b)/i)
      || lower.match(/\b(?:show\s+me|give\s+me|fetch|return|get)\s+(?:the\s+)?(\d+)\b(?!\s+days?\b)/i)
      || lower.match(/\b(\d+)\s+(?:records?|deals?|leads?|contacts?|accounts?|tasks?|products?|quotes?|sales\s+orders?|purchase\s+orders?|invoices?)\b/i);
  if (match) return Number(match[1] || match[0]);
  return null;
}

function validateCanonicalQuestion(canonical) {
  const module = canonical.module;
  if (!module || !Object.prototype.hasOwnProperty.call(CRM_MODULES, module)) {
    throw createAppError('MODULE_NOT_FOUND', `The CRM module '${module || 'unknown'}' is not supported.`, 400, { module: module || null });
  }
  if (!['list', 'count'].includes(canonical.operation)) {
    throw createAppError('INVALID_OPERATION', `The CRM operation '${canonical.operation}' is not supported.`, 400, { operation: canonical.operation });
  }
  if (!Array.isArray(canonical.filters)) {
    throw createAppError('INVALID_CANONICAL_QUERY', 'The canonical query must contain a filters array.', 400);
  }
  if (!Array.isArray(canonical.sort)) {
    throw createAppError('INVALID_CANONICAL_QUERY', 'The canonical query must contain a sort array.', 400);
  }
  if (!canonical.pagination || !Number.isInteger(Number(canonical.pagination.limit)) || !Number.isInteger(Number(canonical.pagination.offset))) {
    throw createAppError('INVALID_CANONICAL_QUERY', 'The canonical query pagination must include valid integer limit and offset values.', 400);
  }
  for (const filter of canonical.filters) {
    if (!filter || typeof filter !== 'object' || !filter.field || !filter.operator) {
      throw createAppError('INVALID_FILTER', 'Each filter must include a field and operator.', 400, { filter });
    }
    if (!Object.prototype.hasOwnProperty.call(CRM_MODULES, module)) {
      throw createAppError('MODULE_NOT_FOUND', `Module '${module}' is not supported for filtering.`, 400, { module });
    }
    const allowed = new Set(CRM_MODULES[module]);
    if (!allowed.has(filter.field)) {
      throw createAppError('FIELD_NOT_AVAILABLE', `Field '${filter.field}' is not available for module '${module}'.`, 400, { module, field: filter.field });
    }
    const validOperators = new Set(['equals', 'not_equals', 'greater_than', 'greater_equal', 'less_than', 'less_equal', 'between', 'in', 'not_in', 'is_null', 'is_not_null']);
    if (!validOperators.has(filter.operator)) {
      throw createAppError('INVALID_OPERATOR', `Operator '${filter.operator}' is not supported.`, 400, { field: filter.field, operator: filter.operator });
    }
  }

  validateCrmQuery({
    module,
    request_type: canonical.operation === 'count' ? 'count' : 'records',
    filters: canonical.filters,
    sort: canonical.sort,
    limit: canonical.pagination.limit,
    offset: canonical.pagination.offset,
    metadata_driven: true
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { analyzeCrmQuestion };
