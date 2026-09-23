const { CRM_API_NAMES } = require('../constants/crmModules');
const { CRM_OPERATORS } = require('../constants/crmOperators');
const { resolveCrmField, normalizeCrmOperator, normalizeCrmFilters } = require('../metadata/crmFieldCatalog');
const { resolveRelativePeriod } = require('../utils/relativeDate');
const { createAppError } = require('../utils/errors');
const { PaginationEngine, createQueryFingerprint } = require('../pagination/paginationEngine');
const { ensureStableSort } = require('../coql/coqlBuilder');

const SUPPORTED_SCHEMA_VERSION = '1.0';
const ALLOWED_TOP_LEVEL_KEYS = new Set(['schema_version', 'request', 'query', 'pagination', 'query_context']);
const ALLOWED_REQUEST_KEYS = new Set(['module', 'operation', 'query', 'pagination', 'query_context']);
const ALLOWED_QUERY_KEYS = new Set(['fields', 'filters', 'sort', 'grouping']);
const ALLOWED_PAGINATION_KEYS = new Set(['limit', 'offset']);
const ALLOWED_QUERY_CONTEXT_KEYS = new Set(['fingerprint']);
const ALLOWED_FILTER_KEYS = new Set(['field', 'operator', 'value']);
const OPERATOR_SET = new Set(CRM_OPERATORS);
const SEMANTIC_DATE_OPERATORS = new Set(['today', 'yesterday', 'tomorrow', 'this_week', 'last_week', 'next_week', 'this_month', 'last_month', 'next_month', 'this_quarter', 'last_quarter', 'next_quarter', 'this_year', 'last_year', 'next_year']);

function normalizeStructuredCrmRequest(body, { paginationEngine = new PaginationEngine() } = {}) {
  const errors = [];
  const addError = (path, message) => errors.push({ path, message });

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw validationError([{ path: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const requestBody = isPlainObject(body.request) ? body.request : {};
  const legacyQuery = isPlainObject(body.query) ? body.query : {};
  const legacyPagination = isPlainObject(body.pagination) ? body.pagination : {};
  const legacyQueryContext = isPlainObject(body.query_context) ? body.query_context : {};
  const requestQuery = requestBody.query ?? legacyQuery;
  const requestPagination = requestBody.pagination ?? legacyPagination;
  const requestQueryContext = requestBody.query_context ?? legacyQueryContext;
  const moduleValue = requestBody.module ?? body.module;
  const operationValue = requestBody.operation ?? body.operation;

  rejectUnknownKeys(body, ALLOWED_TOP_LEVEL_KEYS, '', addError);
  if (body.schema_version !== undefined && body.schema_version !== SUPPORTED_SCHEMA_VERSION) addError('schema_version', `schema_version must be ${SUPPORTED_SCHEMA_VERSION}.`);
  if (!isPlainObject(requestBody) && (!body.query || !isPlainObject(body.query)) && (!body.pagination || !isPlainObject(body.pagination))) {
    addError('request', 'request must be an object.');
  }
  if (requestQuery !== undefined && !isPlainObject(requestQuery)) addError('request.query', 'query must be an object.');
  if (requestPagination !== undefined && !isPlainObject(requestPagination)) addError('request.pagination', 'pagination must be an object.');
  if (requestQueryContext !== undefined && !isPlainObject(requestQueryContext)) addError('request.query_context', 'query_context must be an object.');
  if (errors.length > 0) throw validationError(errors);

  rejectUnknownKeys(requestBody, ALLOWED_REQUEST_KEYS, 'request', addError);
  rejectUnknownKeys(requestQuery || {}, ALLOWED_QUERY_KEYS, 'request.query', addError);
  rejectUnknownKeys(requestPagination || {}, ALLOWED_PAGINATION_KEYS, 'request.pagination', addError);
  rejectUnknownKeys(requestQueryContext || {}, ALLOWED_QUERY_CONTEXT_KEYS, 'request.query_context', addError);

  const module = normalizeModule(moduleValue);
  const operation = operationValue;
  if (!module) addError('request.module', 'module must be a supported CRM module string.');
  if (!['list', 'count'].includes(operation)) addError('request.operation', 'operation must be list or count.');

  const fields = normalizeFields(requestQuery.fields, addError);
  const filters = normalizeFilters(requestQuery.filters, addError, module);
  const sort = normalizeSort(requestQuery.sort, addError);
  const grouping = requestQuery.grouping;
  if (grouping !== undefined && typeof grouping !== 'string') addError('query.grouping', 'grouping must be a string when provided.');

  let pagination;
  try {
    pagination = paginationEngine.normalizePagination(requestPagination || {});
  } catch (error) {
    throw error;
  }

  if (errors.length > 0) throw validationError(errors);

  const logicalQuery = {
    module,
    operation,
    fields,
    filters,
    sort: ensureStableSort(sort),
    grouping: grouping || null
  };
  const fingerprint = createQueryFingerprint(logicalQuery);
  paginationEngine.validateQueryContinuity(logicalQuery, requestQueryContext || {});

  return {
    schema_version: SUPPORTED_SCHEMA_VERSION,
    logical_query: logicalQuery,
    query_fingerprint: fingerprint,
    plan: {
      module,
      request_type: operation === 'count' ? 'count' : 'records',
      fields,
      filters,
      sort: logicalQuery.sort,
      group_by: grouping || undefined,
      limit: pagination.limit,
      offset: pagination.offset,
      pagination,
      metadata_driven: true,
      metadata_validated: true
    }
  };
}

function normalizeModule(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  return Object.keys(CRM_API_NAMES).find((module) => module.toLowerCase() === trimmed.toLowerCase() || CRM_API_NAMES[module].toLowerCase() === trimmed.toLowerCase()) || trimmed;
}

function normalizeFields(value, addError) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    addError('query.fields', 'fields must be an array.');
    return [];
  }
  return value.map((field, index) => {
    if (typeof field !== 'string' || !field.trim()) addError(`query.fields[${index}]`, 'field must be a non-empty string.');
    return typeof field === 'string' ? field.trim() : field;
  });
}

function normalizeFilters(value, addError, moduleName) {
  if (value === undefined) return [];
  if (!isPlainObject(value) && !Array.isArray(value)) {
    addError('query.filters', 'filters must be an object or array.');
    return [];
  }
  const entries = Array.isArray(value)
    ? value.map((filter, index) => normalizeFilterObject(filter, `query.filters[${index}]`, addError, moduleName)).filter(Boolean)
    : Object.entries(value).map(([field, definition]) => normalizeFilterObject({ field, ...definition }, `query.filters.${field}`, addError, moduleName)).filter(Boolean);
  return entries.map((filter) => ({
    ...filter,
    field: resolveCrmField(moduleName, filter.field)
  }));
}

function normalizeFilterObject(filter, path, addError, moduleName) {
  if (!isPlainObject(filter)) {
    addError(path, 'filter must be an object.');
    return null;
  }
  rejectUnknownKeys(filter, ALLOWED_FILTER_KEYS, path, addError);
  const rawField = typeof filter.field === 'string' ? filter.field.trim() : '';
  const rawOperator = typeof filter.operator === 'string' ? filter.operator.trim() : '';
  const value = Object.prototype.hasOwnProperty.call(filter, 'value') ? filter.value : undefined;
  if (!rawField) addError(`${path}.field`, 'field must be a non-empty string.');

  let operator = rawOperator ? normalizeCrmOperator(rawOperator) : '';
  if (!operator && value !== undefined) {
    if (Array.isArray(value) && value.length === 2) operator = 'between';
    else if (Array.isArray(value) && value.length > 0) operator = 'in';
    else operator = 'equals';
  }
  if (!operator && value === undefined) operator = 'is_not_null';

  if (!operator) addError(`${path}.operator`, 'operator must be a non-empty string.');
  const semantic = normalizeSemanticOperator(operator);
  if (semantic) {
    const range = resolveRelativePeriod(semantic);
    if (!range) addError(`${path}.operator`, `Unsupported semantic date operator '${operator}'.`);
    return {
      field: rawField,
      operator: 'between',
      value: [range.start, range.end],
      exclusive_end: true,
      date_range: { semantic: range.period, timezone: range.timeZone, start: range.start, end: range.end }
    };
  }
  if (operator && !OPERATOR_SET.has(operator)) addError(`${path}.operator`, `operator must be one of: ${CRM_OPERATORS.join(', ')}.`);
  const nullOperator = operator === 'is_null' || operator === 'is_not_null' || operator === 'is_empty' || operator === 'is_not_empty';
  if (!nullOperator && value === undefined) addError(`${path}.value`, `operator '${operator}' requires a value.`);
  if (!rawField) return null;
  return nullOperator ? { field: rawField, operator } : { field: rawField, operator, value };
}

function normalizeSort(value, addError) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    addError('query.sort', 'sort must be an array.');
    return [];
  }
  return value.map((item, index) => {
    const path = `query.sort[${index}]`;
    if (!isPlainObject(item)) {
      addError(path, 'sort entry must be an object.');
      return null;
    }
    if (typeof item.field !== 'string' || !item.field.trim()) addError(`${path}.field`, 'field must be a non-empty string.');
    if (!['asc', 'desc'].includes(item.order)) addError(`${path}.order`, 'order must be asc or desc.');
    return { field: String(item.field || '').trim(), order: item.order };
  }).filter(Boolean);
}

function normalizeSemanticOperator(operator) {
  const normalized = String(operator || '').toLowerCase().trim().replace(/\s+/g, '_');
  return SEMANTIC_DATE_OPERATORS.has(normalized) ? normalized.replace(/_/g, ' ') : null;
}

function rejectUnknownKeys(object, allowed, path, addError) {
  Object.keys(object || {}).forEach((key) => {
    if (!allowed.has(key)) addError(path ? `${path}.${key}` : key, 'Unknown field is not allowed.');
  });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validationError(errors) {
  return createAppError('INVALID_CRM_JSON_REQUEST', `CRM JSON request validation failed: ${errors.map((error) => `${error.path}: ${error.message}`).join('; ')}`, 400, { errors });
}

module.exports = { normalizeStructuredCrmRequest };
