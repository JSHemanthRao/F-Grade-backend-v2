const { CRM_MODULES } = require('../constants/crmModules');
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

function validateCrmQuery(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createAppError('INVALID_CRM_REQUEST', 'CRM request validation failed.', 400, { errors: [{ path: 'body', message: 'Request body must be a JSON object.' }] });
  }

  const { module, fields, filters = [], sort, sort_field, sort_order, limit = 20, offset = 0, request_type = 'records', aggregate, group_by } = body;
  const supportedFields = CRM_MODULES[module];
  const defaultModuleFields = supportedFields ? supportedFields.slice(0, 6) : [];
  const addError = (path, message) => errors.push({ path, message });
  const invalidFieldMessage = (field) => `Field '${field}' is not supported for module '${module}'. Use a valid Zoho CRM API field name. Allowed fields: ${supportedFields ? supportedFields.join(', ') : 'none'}.`;

  const requestTypes = new Set(['records', 'count', 'aggregate', 'analysis']);
  const metricRequest = request_type !== 'records';
  if (typeof module !== 'string' || !supportedFields) addError('module', `module must be one of: ${Object.keys(CRM_MODULES).join(', ')}.`);
  if (!requestTypes.has(request_type)) addError('request_type', 'request_type must be one of: records, count, aggregate, analysis.');
  if (!Array.isArray(fields) || fields.length === 0) {
    if (!metricRequest) {
      if (supportedFields && supportedFields.length > 0) {
        // Connector payloads can omit fields for a module-only request. Fill with a safe default set
        // so the request still executes instead of failing validation.
      } else {
        addError('fields', 'fields must be a non-empty array for record requests.');
      }
    }
  } else {
    const duplicates = fields.filter((field, index) => fields.indexOf(field) !== index);
    if (duplicates.length > 0) addError('fields', `fields must not contain duplicates: ${[...new Set(duplicates)].join(', ')}.`);
    fields.forEach((field, index) => {
      if (typeof field !== 'string' || field.length === 0) addError(`fields[${index}]`, 'Field names must be non-empty strings.');
      else if (supportedFields && !supportedFields.includes(field)) addError(`fields[${index}]`, invalidFieldMessage(field));
    });
  }

  const normalizedFields = Array.isArray(fields) && fields.length > 0
    ? fields
    : (metricRequest ? ['id'] : (supportedFields ? defaultModuleFields : []));
  if (request_type === 'aggregate') {
    if (!aggregate || typeof aggregate !== 'object' || Array.isArray(aggregate)) {
      addError('aggregate', 'aggregate is required for aggregate requests and must be an object.');
    } else {
      if (!['sum', 'avg', 'min', 'max', 'count'].includes(aggregate.operation)) addError('aggregate.operation', 'aggregate.operation must be one of: sum, avg, min, max, count.');
      if (typeof aggregate.field !== 'string' || !supportedFields?.includes(aggregate.field)) addError('aggregate.field', invalidFieldMessage(aggregate.field));
    }
  }
  if (group_by !== undefined && (typeof group_by !== 'string' || !supportedFields?.includes(group_by))) addError('group_by', invalidFieldMessage(group_by));
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
    if (!supportedFields || typeof filter.field !== 'string' || !supportedFields.includes(filter.field)) addError(`${path}.field`, invalidFieldMessage(filter.field));
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
      else if (filter.operator === 'between') {
        const betweenValue = normalizeBetweenValue(filter.value);
        if (!betweenValue || betweenValue.length !== 2 || betweenValue.some((value) => !hasNonEmptyValue(value))) {
          addError(`${path}.value`, 'between requires exactly two non-empty scalar values, provided as an array or comma-separated string.');
        } else {
          normalizedFilters[index] = { ...filter, value: betweenValue };
        }
      }
      else if (!['in', 'between'].includes(filter.operator) && !isValue(filter.value)) addError(`${path}.value`, `Operator '${filter.operator}' requires a scalar value.`);
    }
  });

  let normalizedSort = sort;
  const hasFlatSort = sort_field !== undefined || sort_order !== undefined;
  if (hasFlatSort) {
    if (sort !== undefined) addError('sort', 'Use sort_field and sort_order instead of the nested sort object.');
    if (sort_field === undefined) addError('sort_field', 'sort_field is required when sort_order is provided.');
    else if (typeof sort_field !== 'string' || !supportedFields || !supportedFields.includes(sort_field)) addError('sort_field', invalidFieldMessage(sort_field));
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
      if (!supportedFields || !supportedFields.includes(sort.field)) addError('sort.field', invalidFieldMessage(sort.field));
      if (!['asc', 'desc'].includes(sort.order)) addError('sort.order', "sort.order must be either 'asc' or 'desc'.");
    }
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) addError('limit', 'limit must be an integer between 1 and 200.');
  if (!Number.isInteger(offset) || offset < 0) addError('offset', 'offset must be a non-negative integer.');

  if (errors.length > 0) throw createAppError(
    'INVALID_CRM_REQUEST',
    `CRM request validation failed: ${errors.map((error) => `${error.path}: ${error.message}`).join('; ')}`,
    400,
    { errors }
  );
  return { module, fields: normalizedFields, filters: normalizedFilters, sort: normalizedSort, limit, offset, request_type, aggregate, group_by };
}

module.exports = { validateCrmQuery };
