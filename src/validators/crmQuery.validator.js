const { CRM_MODULES, CRM_API_NAMES } = require('../constants/crmModules');
const { CRM_OPERATORS } = require('../constants/crmOperators');
const { createAppError } = require('../utils/errors');

const OPERATOR_SET = new Set(CRM_OPERATORS);
const NULL_OPERATORS = new Set(['is_null', 'is_not_null']);
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
  const supportedFields = resolvedModuleKey ? CRM_MODULES[resolvedModuleKey] : undefined;
  const canonicalModule = resolvedModuleKey || module;
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

  if (!Array.isArray(fields) || fields.length === 0) {
    if (!metricRequest && !(supportedFields && supportedFields.length > 0) && !isVirtualAnalysisModule) {
      addError('fields', 'fields must be a non-empty array for record requests.');
    }
  } else {
    const duplicates = fields.filter((field, index) => fields.indexOf(field) !== index);
    if (duplicates.length > 0) addError('fields', `fields must not contain duplicates: ${[...new Set(duplicates)].join(', ')}.`);
    fields.forEach((field, index) => {
      if (typeof field !== 'string' || field.length === 0) addError(`fields[${index}]`, 'Field names must be non-empty strings.');
      else if (field === 'Converted') addError(`fields[${index}]`, invalidFieldMessage(field));
      else if (!metadataDriven && supportedFields && !supportedFields.includes(field) && !isApiFieldName(field)) addError(`fields[${index}]`, invalidFieldMessage(field));
    });
  }

  const normalizedFields = Array.isArray(fields) && fields.length > 0
    ? fields
    : (metricRequest ? ['id'] : (metadataDriven ? [] : (supportedFields ? defaultModuleFields : [])));

  if (request_type === 'aggregate') {
    if (!aggregate || typeof aggregate !== 'object' || Array.isArray(aggregate)) {
      addError('aggregate', 'aggregate is required for aggregate requests and must be an object.');
    } else {
      if (!['sum', 'avg', 'min', 'max', 'count'].includes(aggregate.operation)) addError('aggregate.operation', 'aggregate.operation must be one of: sum, avg, min, max, count.');
      if (typeof aggregate.field !== 'string' || aggregate.field.length === 0) addError('aggregate.field', 'aggregate.field must be a non-empty string.');
      else if (!metadataDriven && supportedFields && !supportedFields.includes(aggregate.field) && !isApiFieldName(aggregate.field)) addError('aggregate.field', invalidFieldMessage(aggregate.field));
    }
  }

  if (request_type === 'comparison' && (!aggregate || typeof aggregate !== 'object' || !['sum', 'avg', 'min', 'max', 'count'].includes(aggregate.operation) || typeof aggregate.field !== 'string')) {
    addError('aggregate', 'comparison requests require an aggregate with operation count, sum, avg, min, or max and a field.');
  }

  if (group_by !== undefined && (typeof group_by !== 'string' || group_by.length === 0)) addError('group_by', 'group_by must be a non-empty string.');
  else if (group_by !== undefined && !metadataDriven && supportedFields && !supportedFields.includes(group_by) && !isApiFieldName(group_by)) addError('group_by', invalidFieldMessage(group_by));

  if (Array.isArray(fields) && fields.length > 500) addError('fields', 'A COQL query cannot select more than 500 fields.');
  if (Array.isArray(filters) && filters.length > 25) addError('filters', 'A COQL query cannot contain more than 25 criteria.');

  const normalizedFilters = Array.isArray(filters) ? filters.map((filter) => ({ ...filter })) : filters;
  if (!Array.isArray(filters)) addError('filters', 'filters must be an array.');
  else filters.forEach((filter, index) => {
    const path = `filters[${index}]`;
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
      addError(path, 'Each filter must be an object.');
      return;
    }
    if (typeof filter.field !== 'string' || filter.field.length === 0) addError(`${path}.field`, 'Filter field must be a non-empty string.');
    else if (filter.field === 'Converted') addError(`${path}.field`, invalidFieldMessage(filter.field));
    else if (!metadataDriven && supportedFields && !supportedFields.includes(filter.field) && !isApiFieldName(filter.field)) addError(`${path}.field`, invalidFieldMessage(filter.field));
    if (typeof filter.operator !== 'string' || !OPERATOR_SET.has(filter.operator)) {
      addError(`${path}.operator`, `Operator must be one of: ${CRM_OPERATORS.join(', ')}.`);
      return;
    }
    if (['Owner', 'Deal_Owner', 'Lead_Owner'].includes(filter.field) && ['contains', 'starts_with'].includes(filter.operator)) addError(`${path}.operator`, 'Lookup owner fields support only equals, not_equals, and in operators.');
    const hasValue = Object.prototype.hasOwnProperty.call(filter, 'value');
    if (NULL_OPERATORS.has(filter.operator)) {
      if (hasValue) addError(`${path}.value`, `${filter.operator} must not include a value.`);
    } else if (VALUE_OPERATORS.has(filter.operator)) {
      if (!hasValue) addError(`${path}.value`, `Operator '${filter.operator}' requires a value.`);
      else if (filter.operator === 'in' && (!Array.isArray(filter.value) || filter.value.length === 0 || filter.value.some((value) => !isValue(value)))) addError(`${path}.value`, 'in requires a non-empty array of scalar values.');
      else if (['in', 'not_in'].includes(filter.operator) && (!Array.isArray(filter.value) || filter.value.length === 0 || filter.value.some((value) => !isValue(value)))) addError(`${path}.value`, `${filter.operator} requires a non-empty array of scalar values.`);
      else if (filter.operator === 'between') {
        const betweenValue = normalizeBetweenValue(filter.value);
        if (!betweenValue || betweenValue.length !== 2 || betweenValue.some((value) => !hasNonEmptyValue(value))) {
          addError(`${path}.value`, 'between requires exactly two non-empty scalar values, provided as an array or comma-separated string.');
        } else {
          normalizedFilters[index] = { ...filter, value: betweenValue };
        }
      } else if (!['in', 'between'].includes(filter.operator) && !isValue(filter.value)) {
        addError(`${path}.value`, `Operator '${filter.operator}' requires a scalar value.`);
      }
    }
  });

  if (havingFilter !== undefined) {
    if (request_type !== 'aggregate' || !havingFilter || typeof havingFilter !== 'object' || Array.isArray(havingFilter)) addError('having_filter', 'having_filter is only allowed as one filter object on aggregate requests.');
    else if (typeof havingFilter.field !== 'string' || !havingFilter.field || !OPERATOR_SET.has(havingFilter.operator)) addError('having_filter', 'having_filter requires a valid field and operator.');
    else if (NULL_OPERATORS.has(havingFilter.operator) ? Object.prototype.hasOwnProperty.call(havingFilter, 'value') : !hasNonEmptyValue(havingFilter.value) && !['in', 'not_in', 'between'].includes(havingFilter.operator)) addError('having_filter.value', 'having_filter value is invalid.');
  }

  let normalizedSort = sort;
  const hasFlatSort = sort_field !== undefined || sort_order !== undefined;
  if (hasFlatSort) {
    if (sort !== undefined) addError('sort', 'Use sort_field and sort_order instead of the nested sort object.');
    if (sort_field === undefined) addError('sort_field', 'sort_field is required when sort_order is provided.');
    else if (typeof sort_field !== 'string' || sort_field.length === 0) addError('sort_field', 'sort_field must be a non-empty string.');
    else if (supportedFields && !supportedFields.includes(sort_field) && !isApiFieldName(sort_field)) addError('sort_field', invalidFieldMessage(sort_field));
    if (sort_order === undefined) addError('sort_order', 'sort_order is required when sort_field is provided.');
    else if (!['asc', 'desc'].includes(sort_order)) addError('sort_order', "sort_order must be either 'asc' or 'desc'.");
    if (sort_field !== undefined && sort_order !== undefined && typeof sort_field === 'string' && supportedFields?.includes(sort_field) && ['asc', 'desc'].includes(sort_order)) {
      normalizedSort = { field: sort_field, order: sort_order };
    } else {
      normalizedSort = undefined;
    }
  } else if (sort !== undefined) {
    if (!sort || typeof sort !== 'object' || Array.isArray(sort)) addError('sort', 'sort must be an object.');
    else {
      const sorts = Array.isArray(sort) ? sort : [sort];
      sorts.forEach((sortItem, index) => {
        const path = Array.isArray(sort) ? `sort[${index}]` : 'sort';
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
    aggregate,
    group_by,
    having_filter: havingFilter,
    relationships: body.relationships || [],
    aggregations: body.aggregations || [],
    comparison: body.comparison,
    date_range: body.date_range,
    analysis: body.analysis
  };
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
  const isSupported = (field) => typeof field === 'string' && supportedFields.includes(field);

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





