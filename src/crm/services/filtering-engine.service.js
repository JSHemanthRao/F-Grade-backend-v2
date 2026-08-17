const { DEBUG_ASSISTANT } = require('../../common/config/env');
const { getModuleDefinition } = require('./module-definition.service');
const { detectTimeRange } = require('./assistant/date-detector.service');
const {
  getCustomerRecordScope,
  selectBusinessDateField,
} = require('./business-criteria.service');
const logger = require('../../common/logging/logger');

const OPERATORS = new Set([
  'equals', 'not_equals', 'contains', 'starts_with', 'ends_with',
  'greater_than', 'greater_equal', 'less_than', 'less_equal', 'between', 'in',
  'existing_in_period',
]);

const OPERATOR_ALIASES = {
  '=': 'equals',
  '==': 'equals',
  eq: 'equals',
  '!=': 'not_equals',
  '<>': 'not_equals',
  ne: 'not_equals',
  '>': 'greater_than',
  gt: 'greater_than',
  '>=': 'greater_equal',
  gte: 'greater_equal',
  '<': 'less_than',
  lt: 'less_than',
  '<=': 'less_equal',
  lte: 'less_equal',
};

const FIELD_ALIASES = {
  stage: ['Stage', 'Deal_Stage'],
  owner: ['Owner', 'Owner_Name', 'Deal_Owner', 'Partner_Owner', 'Enterprise_Owner'],
  company: ['Company', 'Account_Name', 'Company_Name'],
  lead_source: ['Lead_Source', 'Deal_Source', 'Source'],
  product: ['Product_Name', 'Product', 'Product_Details'],
  status: ['Status', 'State'],
  amount: ['Amount', 'Grand_Total', 'Unit_Price', 'Annual_Revenue', 'value'],
  date: ['Closing_Date', 'Created_Time', 'CreatedDate', 'Created_Date', 'Modified_Time', 'Start_Date', 'Start_DateTime', 'Due_Date'],
};

const MODULE_FIELDS = {
  leads: ['Stage', 'Owner', 'Status', 'Created_Time', 'Converted_Date_Time'],
  contacts: ['Owner', 'Status', 'Created_Time'],
  accounts: ['Owner', 'Status', 'Created_Time'],
  deals: ['Stage', 'Owner', 'Status', 'Product_Name', 'Created_Time'],
  tasks: ['Owner', 'Status', 'Due_Date'],
  events: ['Owner', 'Start_DateTime'],
  calls: ['Owner', 'Status', 'Call_Start_Time'],
  meetings: ['Owner', 'Start_DateTime'],
  notes: ['Owner', 'Created_Time'],
  products: ['Status', 'Created_Time'],
  vendors: ['Owner', 'Status', 'Created_Time'],
  quotes: ['Owner', 'Status', 'Created_Time'],
  'sales-orders': ['Owner', 'Status', 'Created_Time'],
  'purchase-orders': ['Owner', 'Status', 'Created_Time'],
  campaigns: ['Status', 'Start_Date', 'End_Date'],
};

const DATE_FIELDS_BY_MODULE = {
  deals: 'Closing_Date',
  events: 'Start_DateTime',
  meetings: 'Start_DateTime',
  tasks: 'Due_Date',
  campaigns: 'Start_Date',
  calls: 'Call_Start_Time',
};

function normalizeText(value) {
  return String(value ?? '').trim().toLowerCase();
}

function uniqueFilters(filters) {
  const seen = new Set();
  return filters.filter((filter) => {
    const key = JSON.stringify(filter);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fieldNames(moduleKey, records = []) {
  const definition = getModuleDefinition(moduleKey);
  return [...new Set([
    ...(definition?.defaultFields || []),
    ...(MODULE_FIELDS[moduleKey] || []),
    ...records.flatMap((record) => Object.keys(record || {})),
  ])];
}

function resolveField(moduleKey, logicalField, records = []) {
  const candidates = FIELD_ALIASES[logicalField] || [logicalField];
  const available = fieldNames(moduleKey, records);
  return candidates.find((candidate) => available.some((field) => field.toLowerCase() === candidate.toLowerCase())) || null;
}

function moduleSupportsField(moduleKey, logicalField, records = []) {
  if (logicalField === 'text') return true;
  return Boolean(resolveField(moduleKey, logicalField, records));
}

function normalizeAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value ?? '').trim().toLowerCase().replace(/[₹$€£\s]/g, '').replace(/,/g, '');
  const match = text.match(/^([\d.]+)(lakh|lakhs|crore|crores|k|m|million|billion)?$/);
  if (!match) return null;
  const multiplier = {
    k: 1e3,
    m: 1e6,
    lakh: 1e5,
    lakhs: 1e5,
    crore: 1e7,
    crores: 1e7,
    million: 1e6,
    billion: 1e9,
  }[match[2]] || 1;
  const number = Number(match[1]) * multiplier;
  return Number.isFinite(number) ? number : null;
}

function parseDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function parseDateFilter(question, timeRange, moduleKey) {
  const range = timeRange || detectTimeRange(question);
  const isCompare = /\b(?:compare|versus|vs)\b/i.test(question);
  const hasRelativeMonthOrYear = /\b(?:this|last|current|previous)\s+(?:month|year)\b/i.test(question);
  if (isCompare && hasRelativeMonthOrYear && range?.periods?.length > 1) return null;
  if (!range?.startDate || !range?.endDate || range.range === 'all_time') return null;
  const text = String(question || '').toLowerCase();
  const dateField = selectBusinessDateField(moduleKey, text);
  // Actual Closed Won dates live in stage history, not in a Deal field.
  // The history executor owns that time filter, so never create an invalid
  // `field: null` record filter here.
  if (!dateField) return null;
  return {
    field: dateField,
    logicalField: 'date',
    operator: 'between',
    value: [range.startDate, range.endDate],
    source: 'date',
  };
}

function parseYearFilter(question, moduleKey) {
  if (/\b(?:last|this)\s+year\b/i.test(question)) return null;
  const yearMatch = String(question).match(/\b(20\d{2})\b/);
  if (!yearMatch || /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(question)) return null;
  const year = Number(yearMatch[1]);
  return {
    field: DATE_FIELDS_BY_MODULE[moduleKey] || 'Created_Time',
    logicalField: 'date',
    operator: 'between',
    value: [new Date(Date.UTC(year, 0, 1)).toISOString(), new Date(Date.UTC(year + 1, 0, 1)).toISOString()],
    source: 'year',
  };
}

function parseQuestionFilters(question, moduleKey, timeRange) {
  const text = String(question || '');
  const filters = [];
  const stageMatches = [...text.matchAll(/\b(closed\s+won|closed\s+lost|qualification|needs\s+analysis|value\s+proposition|negotiation|proposal|open|won|lost)\b/gi)]
    .map((match) => match[1]);
  if (stageMatches.length > 0) {
    filters.push({ field: 'Stage', logicalField: 'stage', operator: 'in', value: [...new Set(stageMatches)], source: 'question' });
  }

  const ownerMatch = text.match(/\b(?:owned\s+by|owner(?:\s+is)?|assigned\s+to)\s+([a-z][a-z .'-]{1,80}?)(?=\s+(?:for|from|in|with|and|above|below|over|under|this|last|between|today|yesterday|tomorrow|week|month|quarter|year)\b|$)/i);
  const ownerValue = ownerMatch?.[1].trim().replace(/[.,]+$/, '');
  if (ownerValue && !/^(?:this|last|current|previous|today|yesterday|tomorrow)$/i.test(ownerValue)) {
    filters.push({ field: 'Owner', logicalField: 'owner', operator: 'equals', value: ownerValue, source: 'question' });
  }

  const companyMatch = text.match(/\b(?:company|account|customer)\b(?:\s+is|\s+named|\s*=|\s*:)?\s*([a-z][a-z0-9 &.'-]{1,80}?)(?=\s+(?:for|from|in|with|and|above|below|over|under|this|last|between)\b|$)/i);
  const companyValue = companyMatch?.[1]?.trim();
  if (companyValue && !/^(?:data|records?|only|created|added|new|existing)$/i.test(companyValue)) {
    filters.push({ field: 'Account_Name', logicalField: 'company', operator: 'equals', value: companyValue, source: 'question' });
  }

  const productMatch = text.match(/\bproduct\b(?:\s+is|\s+named|\s*=|\s*:)?\s*([a-z][a-z0-9 &.'-]{1,80}?)(?=\s+(?:for|from|in|with|and|above|below|over|under|this|last|between)\b|$)/i);
  if (productMatch) filters.push({ field: 'Product_Name', logicalField: 'product', operator: 'equals', value: productMatch[1].trim(), source: 'question' });

  const sourceMatch = text.match(/\b(?:lead\s+source|source)(?:\s+is|\s*=|\s*:)?\s*([a-z][a-z0-9 &.'-]{1,80}?)(?=\s+(?:leads?|deals?|for|from|in|with|and|above|below|over|under|this|last|between)\b|$)/i)
    || (moduleKey === 'leads' && text.match(/\b(advertisement|web|referral|partner|event|import|cold\s+call)\b/i));
  if (sourceMatch) filters.push({ field: moduleKey === 'deals' ? 'Deal_Source' : 'Lead_Source', logicalField: 'lead_source', operator: 'equals', value: sourceMatch[1].trim(), source: 'question' });

  const statusMatch = text.match(/\b(?:status|state)(?:\s+is|\s*=|\s*:)?\s*([a-z][a-z -]{1,50}?)(?=\s+(?:for|from|in|with|and|above|below|over|under|this|last|between)\b|$)/i);
  if (statusMatch) filters.push({ field: 'Status', logicalField: 'status', operator: 'equals', value: statusMatch[1].trim(), source: 'question' });

  const betweenAmount = text.match(/\bbetween\s+((?:₹|rs\.?|\$|€|£)?[\d,.]+\s*(?:lakh|lakhs|crore|crores|k|m|million|billion)?)\s+and\s+((?:₹|rs\.?|\$|€|£)?[\d,.]+\s*(?:lakh|lakhs|crore|crores|k|m|million|billion)?)\b/i);
  const comparisonAmount = text.match(/\b(above|over|greater\s+than|at\s+least|below|under|less\s+than|at\s+most)\s+((?:₹|rs\.?|\$|€|£)?[\d,.]+\s*(?:lakh|lakhs|crore|crores|k|m|million|billion)?)\b/i);
  if (betweenAmount) {
    filters.push({ field: 'Amount', logicalField: 'amount', operator: 'between', value: [normalizeAmount(betweenAmount[1]), normalizeAmount(betweenAmount[2])], source: 'question' });
  } else if (comparisonAmount) {
    const operator = /above|over|greater|least/i.test(comparisonAmount[1]) ? ( /least/i.test(comparisonAmount[1]) ? 'greater_equal' : 'greater_than') : (/most/i.test(comparisonAmount[1]) ? 'less_equal' : 'less_than');
    filters.push({ field: 'Amount', logicalField: 'amount', operator, value: normalizeAmount(comparisonAmount[2]), source: 'question' });
  }

  const textSearch = text.match(/\b(?:search\s+for|containing|contains|matching)\s+["']([^"']+)["']/i);
  if (textSearch) filters.push({ field: '*', logicalField: 'text', operator: 'contains', value: textSearch[1], source: 'question' });

  const dateFilter = parseDateFilter(question, timeRange, moduleKey) || parseYearFilter(question, moduleKey);
  if (dateFilter) {
    filters.push(dateFilter);
    if (getCustomerRecordScope(question) === 'existing') {
      filters.push({
        field: 'Created_Time',
        logicalField: 'customer_scope',
        operator: 'existing_in_period',
        value: dateFilter.value,
        source: 'customer_scope',
      });
    }
  }
  return filters;
}

function hasStageRequest(question) {
  return /\b(closed\s*won|closed\s*lost|qualification|needs\s+analysis|value\s+proposition|negotiation|proposal|open|won|lost)\b/i.test(question);
}

function hasOwnerRequest(question) {
  return /\b(?:owned\s+by|owner(?:\s+is)?|assigned\s+to)\b/i.test(question);
}

function hasCompanyRequest(question) {
  return /\b(?:company|account)\b(?:\s+is|\s+named|\s*=|\s*:)?/i.test(question)
    || /\bcustomer\b(?:\s+is|\s+named|\s*=|\s*:)\s+/i.test(question);
}

function hasAmountRequest(question) {
  return /\b(?:between\s+[^\s]+\s+and\s+[^\s]+|above|over|greater\s+than|at\s+least|below|under|less\s+than|at\s+most|₹|rs\.?|\$|€|£|lakh|lakhs|crore|crores|k|m|million|billion)\b/i.test(question);
}

function hasDateRequest(question, timeRange, moduleKey) {
  return Boolean(
    parseDateFilter(question, timeRange, moduleKey)
    || parseYearFilter(question, moduleKey)
    || /\b(?:today|yesterday|tomorrow|this\s+week|last\s+week|this\s+month|last\s+month|last\s+\d+\s+months?|this\s+quarter|last\s+quarter|this\s+year|last\s+year|january|february|march|april|may|june|july|august|september|october|november|december|between\s+.*\s+and\s+.*)\b/i.test(question),
  );
}

function detectRequestedFilters(question, timeRange, moduleKey) {
  const normalizedQuestion = String(question || '');
  return {
    stage: hasStageRequest(normalizedQuestion),
    owner: hasOwnerRequest(normalizedQuestion),
    company: hasCompanyRequest(normalizedQuestion),
    amount: hasAmountRequest(normalizedQuestion),
    date: hasDateRequest(normalizedQuestion, timeRange, moduleKey),
  };
}

function normalizeStructuredFilter(filter) {
  if (!filter || typeof filter !== 'object') return null;
  const requestedField = String(filter.logicalField || filter.field || '').trim();
  const logicalField = Object.entries(FIELD_ALIASES).find(([, aliases]) => aliases.some((alias) => alias.toLowerCase() === requestedField.toLowerCase()))?.[0] || requestedField;
  const rawOperator = String(filter.operator || 'equals').trim().toLowerCase();
  const operator = OPERATOR_ALIASES[rawOperator] || rawOperator;
  const value = filter.value;
  return { ...filter, field: filter.field || logicalField, logicalField, operator, value, source: filter.source || 'structured' };
}

function contextFilters(context = {}, moduleKey) {
  const previous = context.lastPlan?.filterPlans?.[moduleKey]?.filters
    || context.previousPlan?.filterPlans?.[moduleKey]?.filters
    || context.filterPlans?.[moduleKey]?.filters
    || (context.module === moduleKey ? context.filters : null);
  return Array.isArray(previous) ? previous.map(normalizeStructuredFilter).filter(Boolean) : [];
}

function validateFilter(filter, moduleKey, records = []) {
  const errors = [];
  if (!filter.logicalField) errors.push({ code: 'FIELD_REQUIRED', message: 'A filter field is required.' });
  if (!OPERATORS.has(filter.operator)) errors.push({ code: 'INVALID_OPERATOR', field: filter.logicalField, message: `Unsupported filter operator: ${filter.operator}.` });
  if (filter.value === undefined || filter.value === null || filter.value === '' || (Array.isArray(filter.value) && filter.value.some((value) => value === null || value === undefined || value === ''))) {
    errors.push({ code: 'VALUE_REQUIRED', field: filter.logicalField, message: 'A filter value is required.' });
  }
  if (filter.logicalField === 'amount') {
    const values = Array.isArray(filter.value) ? filter.value : [filter.value];
    if (values.some((value) => normalizeAmount(value) === null)) errors.push({ code: 'INVALID_VALUE', field: 'amount', message: 'Amount must be numeric.' });
  }
  if (filter.logicalField === 'date') {
    const values = Array.isArray(filter.value) ? filter.value : [filter.value];
    if (values.some((value) => !parseDate(value))) errors.push({ code: 'INVALID_VALUE', field: filter.field, message: 'Date filter values must be valid dates.' });
  }
  if (filter.operator === 'between' && (!Array.isArray(filter.value) || filter.value.length !== 2)) {
    errors.push({ code: 'INVALID_VALUE', field: filter.logicalField, message: 'Between filters require exactly two values.' });
  }
  if (filter.operator === 'in' && (!Array.isArray(filter.value) || filter.value.length === 0)) {
    errors.push({ code: 'INVALID_VALUE', field: filter.logicalField, message: 'In filters require one or more values.' });
  }
  if (filter.logicalField !== 'customer_scope' && !moduleSupportsField(moduleKey, filter.logicalField, records)) errors.push({ code: 'UNSUPPORTED_FIELD', field: filter.field, module: moduleKey, message: `The ${moduleKey} module does not support the ${filter.field} filter.` });
  return errors;
}

function valueText(value) {
  if (value && typeof value === 'object') return value.name || value.Name || value.full_name || value.id || value.ID || '';
  return value;
}

function recordValue(record, field) {
  if (field === '*') return Object.values(record || {}).map(valueText).filter((value) => typeof value === 'string').join(' ');
  const direct = Object.keys(record || {}).find((key) => key.toLowerCase() === String(field).toLowerCase());
  return direct ? valueText(record[direct]) : undefined;
}

function matchesFilter(record, filter) {
  const raw = recordValue(record, filter.field);
  if (filter.logicalField === 'customer_scope') {
    const actual = parseDate(raw)?.valueOf();
    const expected = (Array.isArray(filter.value) ? filter.value : [filter.value]).map((value) => parseDate(value)?.valueOf());
    if (!actual || expected.some((value) => value === undefined || Number.isNaN(value))) return false;
    if (filter.operator === 'existing_in_period') return actual < expected[0] || actual >= expected[1];
  }
  if (filter.logicalField === 'text') return normalizeText(raw).includes(normalizeText(filter.value));
  if (filter.logicalField === 'amount') {
    const actual = normalizeAmount(raw);
    const expected = Array.isArray(filter.value) ? filter.value.map(normalizeAmount) : normalizeAmount(filter.value);
    if (actual === null) return false;
    if (filter.operator === 'between') return actual >= expected[0] && actual <= expected[1];
    if (filter.operator === 'greater_than') return actual > expected;
    if (filter.operator === 'greater_equal') return actual >= expected;
    if (filter.operator === 'less_than') return actual < expected;
    if (filter.operator === 'less_equal') return actual <= expected;
  }
  if (filter.logicalField === 'date') {
    const actual = parseDate(raw)?.valueOf();
    const expected = (Array.isArray(filter.value) ? filter.value : [filter.value]).map((value) => parseDate(value)?.valueOf());
    if (actual === undefined || actual === null || expected.some((value) => value === undefined || Number.isNaN(value))) return false;
    if (filter.operator === 'equals') return actual === expected[0];
    if (filter.operator === 'not_equals') return actual !== expected[0];
    if (filter.operator === 'greater_than') return actual > expected[0];
    if (filter.operator === 'greater_equal') return actual >= expected[0];
    if (filter.operator === 'less_than') return actual < expected[0];
    if (filter.operator === 'less_equal') return actual <= expected[0];
    return actual >= expected[0] && actual < expected[1];
  }
  const actualText = normalizeText(raw);
  const expected = Array.isArray(filter.value) ? filter.value.map(normalizeText) : normalizeText(filter.value);
  if (filter.operator === 'equals') return actualText === expected;
  if (filter.operator === 'not_equals') return actualText !== expected;
  if (filter.operator === 'contains') return actualText.includes(expected);
  if (filter.operator === 'starts_with') return actualText.startsWith(expected);
  if (filter.operator === 'ends_with') return actualText.endsWith(expected);
  if (filter.operator === 'in') return expected.includes(actualText);
  return false;
}

function escapeCriteriaValue(value) {
  return String(value).replace(/[()']/g, '\\$&');
}

function serverCriteria(filters) {
  const clauses = [];
  filters.forEach((filter) => {
    if (filter.field === '*' || filter.logicalField === 'customer_scope') return;
    if (filter.operator === 'between') {
      clauses.push(`(${filter.field}:greater_equal:${escapeCriteriaValue(filter.value[0])})`);
      clauses.push(`(${filter.field}:less_than:${escapeCriteriaValue(filter.value[1])})`);
      return;
    }
    if (filter.operator === 'in') {
      clauses.push(`(${filter.value.map((value) => `${filter.field}:equals:${escapeCriteriaValue(value)}`).join('or')})`);
      return;
    }
    clauses.push(`(${filter.field}:${filter.operator}:${escapeCriteriaValue(filter.value)})`);
  });
  return clauses.length ? clauses.join('and') : null;
}

function buildFilterPlan({ question = '', module, modules = [], plan = {}, context = {}, filters = [], records = [] } = {}) {
  const startedAt = process.hrtime.bigint();
  const moduleKey = module || modules[0] || plan.modules?.[0];
  const structuredInput = Array.isArray(filters) ? filters : (filters && typeof filters === 'object' ? [filters] : []);
  const structured = structuredInput.map(normalizeStructuredFilter).filter(Boolean);
  const inherited = contextFilters(context, moduleKey);
  const structuredFilters = plan.queryPlansByModule?.[moduleKey]?.filters
    || (plan.queryPlan?.moduleKey === moduleKey ? plan.queryPlan.filters : null);
  const parsed = Array.isArray(structuredFilters)
    ? structuredFilters
    : parseQuestionFilters(question, moduleKey, plan.timeRange);
  const allFilters = uniqueFilters([...inherited, ...structured, ...parsed]);
  allFilters.forEach((filter) => {
    if (FIELD_ALIASES[filter.logicalField]) filter.field = resolveField(moduleKey, filter.logicalField, records) || filter.field;
  });
  const ignoredFilters = [];
  const applicableFilters = allFilters.filter((filter) => {
    const errors = validateFilter(filter, moduleKey, records);
    const unsupportedOnly = errors.length > 0 && errors.every((error) => error.code === 'UNSUPPORTED_FIELD');
    const supportedByAnotherModule = modules.some((candidate) => candidate !== moduleKey && moduleSupportsField(candidate, filter.logicalField, records));
    if (unsupportedOnly && supportedByAnotherModule) {
      ignoredFilters.push({ ...filter, reason: 'not_applicable_to_module' });
      return false;
    }
    return true;
  });
  const requestedFilters = detectRequestedFilters(question, plan.timeRange, moduleKey);
  if (plan.businessRequest?.requires_stage_history) requestedFilters.date = false;
  const requestedValidationErrors = [];

  const ignoredLogicalFields = new Set(ignoredFilters.map((filter) => filter.logicalField));

  if (requestedFilters.stage && !applicableFilters.some((filter) => filter.logicalField === 'stage') && !ignoredLogicalFields.has('stage')) {
    requestedValidationErrors.push({ code: 'MISSING_REQUESTED_STAGE_FILTER', field: 'stage', message: 'A stage filter was requested but could not be applied.' });
  }
  if (requestedFilters.date && !applicableFilters.some((filter) => filter.logicalField === 'date') && !ignoredLogicalFields.has('date')) {
    requestedValidationErrors.push({ code: 'MISSING_REQUESTED_DATE_FILTER', field: 'date', message: 'A date filter was requested but could not be applied.' });
  }
  if (requestedFilters.owner && !applicableFilters.some((filter) => filter.logicalField === 'owner') && !ignoredLogicalFields.has('owner')) {
    requestedValidationErrors.push({ code: 'MISSING_REQUESTED_OWNER_FILTER', field: 'owner', message: 'An owner filter was requested but could not be applied.' });
  }
  if (requestedFilters.amount && !applicableFilters.some((filter) => filter.logicalField === 'amount') && !ignoredLogicalFields.has('amount')) {
    requestedValidationErrors.push({ code: 'MISSING_REQUESTED_AMOUNT_FILTER', field: 'amount', message: 'An amount filter was requested but could not be applied.' });
  }
  if (requestedFilters.company && !applicableFilters.some((filter) => filter.logicalField === 'company') && !ignoredLogicalFields.has('company')) {
    requestedValidationErrors.push({ code: 'MISSING_REQUESTED_COMPANY_FILTER', field: 'company', message: 'A company filter was requested but could not be applied.' });
  }

  const validationErrors = [
    ...applicableFilters.flatMap((filter) => validateFilter(filter, moduleKey, records)),
    ...requestedValidationErrors,
  ];
  const valid = validationErrors.length === 0;
  const criteria = valid ? serverCriteria(applicableFilters) : null;
  const result = {
    valid,
    module: moduleKey,
    filters: applicableFilters,
    canonicalFilters: applicableFilters,
    requestedFilters,
    serverCriteria: criteria,
    serverCriteriaWithoutDate: valid ? serverCriteria(applicableFilters.filter((filter) => filter.logicalField !== 'date')) : null,
    localFilters: applicableFilters.filter((filter) => filter.field === '*'),
    ignoredFilters,
    validationErrors,
  };
  if (DEBUG_ASSISTANT) logger.info('Filtering Engine', {
    module: moduleKey,
    appliedFilters: result.filters,
    ignoredFilters: result.ignoredFilters,
    validation: result.validationErrors,
    filteredRecordCount: records.length ? records.filter((record) => result.valid && result.filters.every((filter) => matchesFilter(record, filter))).length : null,
    executionTimeMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
  });
  return result;
}

function applyFilterPlan(records = [], filterPlan = {}) {
  const startedAt = process.hrtime.bigint();
  if (!filterPlan.valid) return { valid: false, records: [], error: { code: 'FILTER_VALIDATION_ERROR', details: filterPlan.validationErrors } };
  const applicableFilters = Array.isArray(filterPlan.filters) ? filterPlan.filters : [];
  const filtered = applicableFilters.length === 0
    ? records
    : records.filter((record) => applicableFilters.every((filter) => matchesFilter(record, filter)));
  if (DEBUG_ASSISTANT) logger.info('Filtering Engine', {
    appliedFilters: filterPlan.filters,
    filteredRecordCount: filtered.length,
    executionTimeMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
  });
  return { valid: true, records: filtered, error: null };
}

function applyFilterToDataset(dataset, filterPlan) {
  const sourceRecords = Array.isArray(dataset)
    ? dataset
    : (dataset?.result?.data || dataset?.data || []);
  const applied = applyFilterPlan(sourceRecords, filterPlan);
  if (!applied.valid) return { valid: false, error: applied.error, dataset };
  if (Array.isArray(dataset)) return { valid: true, error: null, dataset: applied.records };
  const result = dataset?.result || dataset || {};
  return {
    valid: true,
    error: null,
    dataset: {
      ...dataset,
      result: {
        ...result,
        data: applied.records,
        info: { ...(result.info || {}), filteredRecordCount: applied.records.length },
      },
    },
  };
}

function buildFilterPlans({ question = '', modules = [], plan = {}, context = {} } = {}) {
  const byModule = {};
  const validationErrors = [];
  modules.forEach((module) => {
    const filterPlan = buildFilterPlan({ question, module, modules, plan, context });
    byModule[module] = filterPlan;
    validationErrors.push(...filterPlan.validationErrors);
  });
  return { valid: validationErrors.length === 0, byModule, validationErrors };
}

module.exports = {
  applyFilterPlan,
  applyFilterToDataset,
  buildFilterPlan,
  buildFilterPlans,
  matchesFilter,
  normalizeAmount,
  parseQuestionFilters,
};
