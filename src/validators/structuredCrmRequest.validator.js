const { CRM_API_NAMES } = require('../constants/crmModules');
const { CRM_OPERATORS } = require('../constants/crmOperators');
const { resolveRelativePeriod } = require('../utils/relativeDate');
const { createAppError } = require('../utils/errors');
const { PaginationEngine, createQueryFingerprint } = require('../pagination/paginationEngine');
const { ensureStableSort } = require('../coql/coqlBuilder');

const SUPPORTED_SCHEMA_VERSION = '1.0';
const ALLOWED_TOP_LEVEL_KEYS = new Set(['schema_version', 'request', 'query', 'pagination', 'query_context']);
const ALLOWED_REQUEST_KEYS = new Set(['module', 'operation']);
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

  rejectUnknownKeys(body, ALLOWED_TOP_LEVEL_KEYS, '', addError);
  if (body.schema_version !== SUPPORTED_SCHEMA_VERSION) addError('schema_version', `schema_version must be ${SUPPORTED_SCHEMA_VERSION}.`);
  if (!isPlainObject(body.request)) addError('request', 'request must be an object.');
  if (!isPlainObject(body.query)) addError('query', 'query must be an object.');
  if (body.pagination !== undefined && !isPlainObject(body.pagination)) addError('pagination', 'pagination must be an object.');
  if (body.query_context !== undefined && !isPlainObject(body.query_context)) addError('query_context', 'query_context must be an object.');
  if (errors.length > 0) throw validationError(errors);

  rejectUnknownKeys(body.request, ALLOWED_REQUEST_KEYS, 'request', addError);
  rejectUnknownKeys(body.query, ALLOWED_QUERY_KEYS, 'query', addError);
  rejectUnknownKeys(body.pagination || {}, ALLOWED_PAGINATION_KEYS, 'pagination', addError);
  rejectUnknownKeys(body.query_context || {}, ALLOWED_QUERY_CONTEXT_KEYS, 'query_context', addError);

  const module = normalizeModule(body.request.module);
  const operation = body.request.operation;
  if (!module) addError('request.module', 'module must be a supported CRM module string.');
  if (!['list', 'count'].includes(operation)) addError('request.operation', 'operation must be list or count.');

  const fields = normalizeFields(body.query.fields, addError);
  const filters = normalizeFilters(body.query.filters, addError);
  const sort = normalizeSort(body.query.sort, addError);
  const grouping = body.query.grouping;
  if (grouping !== undefined && typeof grouping !== 'string') addError('query.grouping', 'grouping must be a string when provided.');

  let pagination;
  try {
    pagination = paginationEngine.normalizePagination(body.pagination || {});
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
  paginationEngine.validateQueryContinuity(logicalQuery, body.query_context || {});

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
  if (!Array.isArray(value) || value.length === 0) {
    addError('query.fields', 'fields must be a non-empty array.');
    return [];
  }
  return value.map((field, index) => {
    if (typeof field !== 'string' || !field.trim()) addError(`query.fields[${index}]`, 'field must be a non-empty string.');
    return typeof field === 'string' ? field.trim() : field;
  });
}

function normalizeFilters(value, addError) {
  if (value === undefined) return [];
  if (!isPlainObject(value) && !Array.isArray(value)) {
    addError('query.filters', 'filters must be an object or array.');
    return [];
  }
  if (Array.isArray(value)) return value.map((filter, index) => normalizeFilterObject(filter, `query.filters[${index}]`, addError)).filter(Boolean);
  return Object.entries(value).map(([field, definition]) => normalizeFilterObject({ field, ...definition }, `query.filters.${field}`, addError)).filter(Boolean);
}

function normalizeFilterObject(filter, path, addError) {
  if (!isPlainObject(filter)) {
    addError(path, 'filter must be an object.');
    return null;
  }
  rejectUnknownKeys(filter, ALLOWED_FILTER_KEYS, path, addError);
  const field = typeof filter.field === 'string' ? filter.field.trim() : '';
  const operator = typeof filter.operator === 'string' ? filter.operator.trim() : '';
  if (!field) addError(`${path}.field`, 'field must be a non-empty string.');
  if (!operator) addError(`${path}.operator`, 'operator must be a non-empty string.');
  const semantic = normalizeSemanticOperator(operator);
  if (semantic) {
    const range = resolveRelativePeriod(semantic);
    if (!range) addError(`${path}.operator`, `Unsupported semantic date operator '${operator}'.`);
    return {
      field,
      operator: 'between',
      value: [range.start, range.end],
      exclusive_end: true,
      date_range: { semantic: range.period, timezone: range.timeZone, start: range.start, end: range.end }
    };
  }
  if (!OPERATOR_SET.has(operator)) addError(`${path}.operator`, `operator must be one of: ${CRM_OPERATORS.join(', ')}.`);
  const nullOperator = operator === 'is_null' || operator === 'is_not_null' || operator === 'is_empty' || operator === 'is_not_empty';
  if (!nullOperator && !Object.prototype.hasOwnProperty.call(filter, 'value')) addError(`${path}.value`, `operator '${operator}' requires a value.`);
  return nullOperator ? { field, operator } : { field, operator, value: filter.value };
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
