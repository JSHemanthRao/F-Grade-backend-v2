const { CRM_MODULES, CRM_API_NAMES } = require('../constants/crmModules');
const { CRM_OPERATORS } = require('../constants/crmOperators');
const { createAppError } = require('../utils/errors');
const { resolveCrmField } = require('../metadata/crmFieldCatalog');

const OPERATOR_SET = new Set(CRM_OPERATORS);
const NULL_OPERATORS = new Set(['is_null', 'is_not_null', 'is_empty', 'is_not_empty']);
const VALUE_OPERATORS = new Set(CRM_OPERATORS.filter((operator) => !NULL_OPERATORS.has(operator)));

function isValue(value) {
  return value !== null && value !== undefined && ['string', 'number', 'boolean'].includes(typeof value);
}

function normalizeBetweenValue(value) {
  if (typeof value === 'string') return value.split(',').map((part) => part.trim());
  if (Array.isArray(value)) return value;
  return null;     



  
}

function hasNonEmptyValue(value) {
  return isValue(value) && (typeof value !== 'string' || value.trim().length > 0);
}

function isApiFieldName(field) {
  return typeof field === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(field) && field !== 'Converted';
}

function resolveModuleKey(moduleName) {
  if (!moduleName || typeof moduleName !== 'string') return undefined;
  const trimmed = moduleName.trim();
  if (!trimmed) return undefined;
  const direct = CRM_MODULES[trimmed] ? trimmed : undefined;
  if (direct) return direct;
  const canonical = Object.keys(CRM_MODULES).find((key) => key.toLowerCase() === trimmed.toLowerCase());
  if (canonical) return canonical;
  const apiNameMatch = Object.keys(CRM_API_NAMES).find((key) => key.toLowerCase() === trimmed.toLowerCase());
  if (apiNameMatch) return apiNameMatch;
  const apiValueMatch = Object.keys(CRM_API_NAMES).find((key) => CRM_API_NAMES[key].toLowerCase() === trimmed.toLowerCase());
  return apiValueMatch || undefined;
}

function validateCrmQuery(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createAppError('INVALID_CRM_REQUEST', 'CRM request validation failed.', 400, { errors: [{ path: 'body', message: 'Request body must be a JSON object.' }] });
  }

  const { module, fields, filters = [], filter_expression: filterExpression, sort, sort_field, sort_order, limit = 20, offset = 0, request_type = 'records', aggregate, group_by, having_filter: havingFilter } = body;
  const metadataDriven = body.metadata_driven === true;
  const resolvedModuleKey = resolveModuleKey(module);
  const canonicalModule = resolvedModuleKey || module;
  const canonicalFields = Array.isArray(fields) ? fields.map((field) => field) : fields;
  const canonicalFilters = Array.isArray(filters) ? filters.map((filter) => ({ ...filter })) : filters;
  const canonicalSortField = sort_field;
  const canonicalSort = sort;
  const canonicalGroupBy = group_by;
  const canonicalHavingFilter = havingFilter;
  const supportedFields = resolvedModuleKey ? CRM_MODULES[resolvedModuleKey] : undefined;
  const isVirtualAnalysisModule = module === 'CRM' && request_type === 'analysis';
  const defaultModuleFields = supportedFields ? supportedFields.slice(0, 6) : [];
  const addError = (path, message) => errors.push({ path, message });

  const validateExpression = (expression, path = 'filter_expression') => {
    if (!expression || typeof expression !== 'object' || Array.isArray(expression)) return addError(path, 'filter_expression must be an object.');
    if (expression.field) {
      if (typeof expression.field !== 'string' || !expression.field.trim()) addError(`${path}.field`, 'Expression field must be a non-empty string.');
      if (!OPERATOR_SET.has(expression.operator)) addError(`${path}.operator`, `Operator must be one of: ${CRM_OPERATORS.join(', ')}.`);
      return;
    }
    const operator = String(expression.operator || '').toUpperCase();
    if (!['AND', 'OR', 'NOT'].includes(operator) || !Array.isArray(expression.conditions) || expression.conditions.length === 0) return addError(path, 'Logical expressions require AND, OR, or NOT with conditions.');
    if (operator === 'NOT' && expression.conditions.length !== 1) return addError(`${path}.conditions`, 'NOT requires exactly one condition.');
    expression.conditions.forEach((condition, index) => validateExpression(condition, `${path}.conditions[${index}]`));
  };

  if (filterExpression !== undefined) validateExpression(filterExpression);
  const invalidFieldMessage = (field) => `Field '${field}' is not supported for module '${canonicalModule}'. Use a valid Zoho CRM API field name. Allowed fields: ${supportedFields ? supportedFields.join(', ') : 'none'}.`;

  const requestTypes = new Set(['records', 'count', 'aggregate', 'comparison', 'analysis', 'search', 'bulk_read']);
  const metricRequest = request_type !== 'records';

  if (typeof module !== 'string' || module.trim().length === 0) addError('module', 'module must be a non-empty string.');
  if (!requestTypes.has(request_type)) addError('request_type', 'request_type must be one of: records, count, aggregate, analysis, search, bulk_read.');

  if (!Array.isArray(canonicalFields) || canonicalFields.length === 0) {
    if (!metricRequest && !(supportedFields && supportedFields.length > 0) && !isVirtualAnalysisModule) {
      addError('fields', 'fields must be a non-empty array for record requests.');
    }
  } else {
    const duplicates = canonicalFields.filter((field, index) => canonicalFields.indexOf(field) !== index);
    if (duplicates.length > 0) addError('fields', `fields must not contain duplicates: ${[...new Set(duplicates)].join(', ')}.`);
    canonicalFields.forEach((field, index) => {
      if (typeof field !== 'string' || field.length === 0) addError(`fields[${index}]`, 'Field names must be non-empty strings.');
      else if (field === 'Converted') addError(`fields[${index}]`, invalidFieldMessage(field));
      else if (!metadataDriven && supportedFields && !supportedFields.includes(field) && !isApiFieldName(field)) addError(`fields[${index}]`, invalidFieldMessage(field));
    });
  }

  const normalizedFields = Array.isArray(canonicalFields) && canonicalFields.length > 0
    ? canonicalFields
    : (metricRequest ? ['id'] : (metadataDriven ? [] : (supportedFields ? defaultModuleFields : [])));

  const canonicalAggregate = aggregate && typeof aggregate === 'object' && !Array.isArray(aggregate)
    ? { ...aggregate, field: typeof aggregate.field === 'string' ? resolveCrmField(canonicalModule, aggregate.field) : aggregate.field }
    : aggregate;

  if (request_type === 'aggregate') {
    if (!canonicalAggregate || typeof canonicalAggregate !== 'object' || Array.isArray(canonicalAggregate)) {
      addError('aggregate', 'aggregate is required for aggregate requests and must be an object.');
    } else {
      if (!['sum', 'avg', 'min', 'max', 'count'].includes(canonicalAggregate.operation)) addError('aggregate.operation', 'aggregate.operation must be one of: sum, avg, min, max, count.');
      if (typeof canonicalAggregate.field !== 'string' || canonicalAggregate.field.length === 0) addError('aggregate.field', 'aggregate.field must be a non-empty string.');
      else if (!metadataDriven && supportedFields && !supportedFields.includes(canonicalAggregate.field) && !isApiFieldName(canonicalAggregate.field)) addError('aggregate.field', invalidFieldMessage(canonicalAggregate.field));
    }
  }

  if (request_type === 'comparison' && (!aggregate || typeof aggregate !== 'object' || !['sum', 'avg', 'min', 'max', 'count'].includes(aggregate.operation) || typeof aggregate.field !== 'string')) {
    addError('aggregate', 'comparison requests require an aggregate with operation count, sum, avg, min, or max and a field.');
  }

  if (Array.isArray(canonicalFields) && canonicalFields.length > 500) addError('fields', 'A COQL query cannot select more than 500 fields.');
  if (Array.isArray(canonicalFilters) && canonicalFilters.length > 25) addError('filters', 'A COQL query cannot contain more than 25 criteria.');

  const normalizedFilters = Array.isArray(canonicalFilters) ? canonicalFilters.map((filter) => ({ ...filter })) : canonicalFilters;
  if (!Array.isArray(canonicalFilters)) addError('filters', 'filters must be an array.');
  else canonicalFilters.forEach((filter, index) => {
    const path = `filters[${index}]`;
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
      addError(path, 'Each filter must be an object.');
      return;
    }
    const normalizedFilter = { ...filter };
    if (typeof normalizedFilter.field !== 'string' || normalizedFilter.field.length === 0) addError(`${path}.field`, 'Filter field must be a non-empty string.');
    else if (normalizedFilter.field === 'Converted') addError(`${path}.field`, invalidFieldMessage(normalizedFilter.field));
    else if (!metadataDriven && supportedFields && !supportedFields.includes(normalizedFilter.field) && !isApiFieldName(normalizedFilter.field)) addError(`${path}.field`, invalidFieldMessage(normalizedFilter.field));
    if (typeof normalizedFilter.operator !== 'string' || !OPERATOR_SET.has(normalizedFilter.operator)) {
      addError(`${path}.operator`, `Operator must be one of: ${CRM_OPERATORS.join(', ')}.`);
      return;
    }
    if (['Owner', 'Deal_Owner', 'Lead_Owner'].includes(normalizedFilter.field) && ['contains', 'starts_with'].includes(normalizedFilter.operator)) addError(`${path}.operator`, 'Lookup owner fields support only equals, not_equals, and in operators.');
    const hasValue = Object.prototype.hasOwnProperty.call(normalizedFilter, 'value');
    if (NULL_OPERATORS.has(normalizedFilter.operator)) {
      if (hasValue) addError(`${path}.value`, `${normalizedFilter.operator} must not include a value.`);
    } else if (VALUE_OPERATORS.has(normalizedFilter.operator)) {
      if (!hasValue) addError(`${path}.value`, `Operator '${normalizedFilter.operator}' requires a value.`);
      else if (normalizedFilter.operator === 'in' && (!Array.isArray(normalizedFilter.value) || normalizedFilter.value.length === 0 || normalizedFilter.value.some((value) => !isValue(value)))) addError(`${path}.value`, 'in requires a non-empty array of scalar values.');
      else if (['in', 'not_in'].includes(normalizedFilter.operator) && (!Array.isArray(normalizedFilter.value) || normalizedFilter.value.length === 0 || normalizedFilter.value.some((value) => !isValue(value)))) addError(`${path}.value`, `${normalizedFilter.operator} requires a non-empty array of scalar values.`);
      else if (normalizedFilter.operator === 'between') {
        const betweenValue = normalizeBetweenValue(normalizedFilter.value);
        if (!betweenValue || betweenValue.length !== 2 || betweenValue.some((value) => !hasNonEmptyValue(value))) {
          addError(`${path}.value`, 'between requires exactly two non-empty scalar values, provided as an array or comma-separated string.');
        } else {
          normalizedFilters[index] = { ...normalizedFilter, value: betweenValue };
        }
      } else if (!['in', 'between'].includes(normalizedFilter.operator) && !isValue(normalizedFilter.value)) {
        addError(`${path}.value`, `Operator '${normalizedFilter.operator}' requires a scalar value.`);
      }
    }
  });

  if (canonicalHavingFilter !== undefined) {
    if (request_type !== 'aggregate' || !canonicalHavingFilter || typeof canonicalHavingFilter !== 'object' || Array.isArray(canonicalHavingFilter)) addError('having_filter', 'having_filter is only allowed as one filter object on aggregate requests.');
    else if (typeof canonicalHavingFilter.field !== 'string' || !canonicalHavingFilter.field || !OPERATOR_SET.has(canonicalHavingFilter.operator)) addError('having_filter', 'having_filter requires a valid field and operator.');
    else if (NULL_OPERATORS.has(canonicalHavingFilter.operator) ? Object.prototype.hasOwnProperty.call(canonicalHavingFilter, 'value') : !hasNonEmptyValue(canonicalHavingFilter.value) && !['in', 'not_in', 'between'].includes(canonicalHavingFilter.operator)) addError('having_filter.value', 'having_filter value is invalid.');
  }

  let normalizedSort = canonicalSort;
  const hasFlatSort = canonicalSortField !== undefined || sort_order !== undefined;
  if (hasFlatSort) {
    if (sort !== undefined) addError('sort', 'Use sort_field and sort_order instead of the nested sort object.');
    if (sort_field === undefined) addError('sort_field', 'sort_field is required when sort_order is provided.');
    else if (typeof canonicalSortField !== 'string' || canonicalSortField.length === 0) addError('sort_field', 'sort_field must be a non-empty string.');
    else if (supportedFields && !supportedFields.includes(canonicalSortField) && !isApiFieldName(canonicalSortField)) addError('sort_field', invalidFieldMessage(canonicalSortField));
    if (sort_order === undefined) addError('sort_order', 'sort_order is required when sort_field is provided.');
    else if (!['asc', 'desc'].includes(sort_order)) addError('sort_order', "sort_order must be either 'asc' or 'desc'.");
    if (canonicalSortField !== undefined && sort_order !== undefined && typeof canonicalSortField === 'string' && supportedFields?.includes(canonicalSortField) && ['asc', 'desc'].includes(sort_order)) {
      normalizedSort = { field: canonicalSortField, order: sort_order };
    } else {
      normalizedSort = undefined;
    }
  } else if (canonicalSort !== undefined) {
    if (!canonicalSort || typeof canonicalSort !== 'object') addError('sort', 'sort must be an object or array.');
    else {
      const sorts = Array.isArray(canonicalSort) ? canonicalSort : [canonicalSort];
      sorts.forEach((sortItem, index) => {
        const path = Array.isArray(canonicalSort) ? `sort[${index}]` : 'sort';
        if (!sortItem || typeof sortItem !== 'object' || typeof sortItem.field !== 'string' || sortItem.field.length === 0) addError(`${path}.field`, 'sort.field must be a non-empty string.');
        else if (!metadataDriven && supportedFields && !supportedFields.includes(sortItem.field) && !isApiFieldName(sortItem.field)) addError(`${path}.field`, invalidFieldMessage(sortItem.field));
        if (!['asc', 'desc'].includes(sortItem?.order)) addError(`${path}.order`, "sort.order must be either 'asc' or 'desc'.");
      });
    }
  }

  if (!Number.isInteger(limit) || limit < 1 || limit > 200) addError('limit', 'limit must be an integer between 1 and 200.');
  if (!Number.isInteger(offset) || offset < 0) addError('offset', 'offset must be a non-negative integer.');

  if (errors.length > 0) {
    throw createAppError(
      'INVALID_CRM_REQUEST',
      `CRM request validation failed: ${errors.map((error) => `${error.path}: ${error.message}`).join('; ')}`,
      400,
      { errors }
    );
  }

  return {
    domain: body.domain || 'CRM',
    module: canonicalModule,
    fields: normalizedFields,
    requested_fields: body.requested_fields || [],
    execution_fields: body.execution_fields,
    response_fields: body.response_fields,
    filters: normalizedFilters,
    filter_expression: filterExpression,
    sort: normalizedSort,
    limit,
    offset,
    request_type,
    aggregate: canonicalAggregate,
    group_by: canonicalGroupBy,
    having_filter: canonicalHavingFilter,
    relationships: body.relationships || [],
    aggregations: body.aggregations || [],
    comparison: body.comparison,
    date_range: body.date_range,
    analysis: body.analysis,
    metadata_driven: metadataDriven,
    metadata_validated: body.metadata_validated === true || metadataDriven
  };
}

function normalizeFilterForValidation(moduleName, filter) {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return filter;
  const nextFilter = { ...filter };
  if (typeof nextFilter.operator !== 'string' && Object.prototype.hasOwnProperty.call(nextFilter, 'value')) {
    nextFilter.operator = Array.isArray(nextFilter.value) && nextFilter.value.length === 2 ? 'between' : 'equals';
  }
  return nextFilter;
}

function validateAggregateQuery({ module, fields = [], filters = [], aggregate, groupBy, sort, metadataValidated = false } = {}) {
  if (!aggregate || typeof aggregate !== 'object') {
    throw createAppError('INVALID_CRM_AGGREGATE', 'An aggregate definition is required.', 400);
  }
  const aggregateFields = [...fields, aggregate.field, groupBy].filter(Boolean);
  if (!metadataValidated) validateModuleFieldScope({ module, fields: aggregateFields, filters });
  if (sort && /^(SUM|COUNT|AVG|MAX|MIN)\s*\(/i.test(String(sort.field || ''))) {
    throw createAppError(
      'INVALID_CRM_AGGREGATE_ORDER',
      'Grouped aggregate results must be ranked in backend memory; ORDER BY aggregate expressions is not allowed.',
      400,
      { module, sort_field: sort.field }
    );
  }
  return true;
}

function validateModuleFieldScope({
  module,
  fields = [],
  filters = [],
  sort,
  aggregate,
  group_by,
  analysis
} = {}) {
  const analysisType = typeof analysis === 'string' ? analysis : analysis?.type;
  const multiModuleAnalyses = new Set([
    'lead_conversion',
    'lead_closed_won_conversion',
    'conversion_funnel',
    'sales_performance',
    'lead_source_conversion_report',
    'owner_performance',
    'today_activity'
  ]);

  if (multiModuleAnalyses.has(analysisType)) {
    return true;
  }

  const resolvedModuleKey = resolveModuleKey(module);
  const supportedFields = resolvedModuleKey ? CRM_MODULES[resolvedModuleKey] : undefined;

  if (!resolvedModuleKey || !supportedFields) {
    return true;
  }

  const errors = [];
  const addInvalid = (path, field) => errors.push({ path, field });
  const isSupported = (field) => typeof field === 'string' && (supportedFields.includes(field) || field.includes('.'));

  (Array.isArray(fields) ? fields : []).forEach((field, index) => {
    if (!isSupported(field)) addInvalid(`fields[${index}]`, field);
  });

  (Array.isArray(filters) ? filters : []).forEach((filter, index) => {
    if (!isSupported(filter?.field)) addInvalid(`filters[${index}].field`, filter?.field);
  });

  const sorts = Array.isArray(sort) ? sort : (sort ? [sort] : []);
  sorts.forEach((sortItem, index) => {
    if (!isSupported(sortItem?.field)) addInvalid(`sort[${index}].field`, sortItem?.field);
  });

  if (aggregate && !isSupported(aggregate.field)) addInvalid('aggregate.field', aggregate.field);
  if (group_by && !isSupported(group_by)) addInvalid('group_by', group_by);

  if (errors.length > 0) {
    throw createAppError(
      'INVALID_CRM_FIELD_SCOPE',
      `CRM query field scope validation failed for module '${module}'. Every field must belong to this module. Allowed fields: ${supportedFields.join(', ')}.`,
      400,
      {
        module,
        allowed_fields: supportedFields,
        invalid_fields: errors
      }
    );
  }

  return true;
}

module.exports = { validateCrmQuery, validateModuleFieldScope, validateAggregateQuery };





