const { CRM_MODULES } = require('../constants/crmModules');
const { CRM_OPERATORS } = require('../constants/crmOperators');
const { createAppError } = require('../utils/errors');

const OPERATOR_SET = new Set(CRM_OPERATORS);
const NULL_OPERATORS = new Set(['is_null', 'is_not_null']);
const VALUE_OPERATORS = new Set(CRM_OPERATORS.filter((operator) => !NULL_OPERATORS.has(operator)));

function isValue(value) {
  return value !== null && value !== undefined && ['string', 'number', 'boolean'].includes(typeof value);
}

function validateCrmQuery(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createAppError('INVALID_CRM_REQUEST', 'CRM request validation failed.', 400, { errors: [{ path: 'body', message: 'Request body must be a JSON object.' }] });
  }

  const { module, fields, filters = [], sort, limit = 20, offset = 0 } = body;
  const supportedFields = CRM_MODULES[module];
  const addError = (path, message) => errors.push({ path, message });

  if (typeof module !== 'string' || !supportedFields) addError('module', `module must be one of: ${Object.keys(CRM_MODULES).join(', ')}.`);
  if (!Array.isArray(fields) || fields.length === 0) addError('fields', 'fields must be a non-empty array.');
  else {
    const duplicates = fields.filter((field, index) => fields.indexOf(field) !== index);
    if (duplicates.length > 0) addError('fields', `fields must not contain duplicates: ${[...new Set(duplicates)].join(', ')}.`);
    fields.forEach((field, index) => {
      if (typeof field !== 'string' || field.length === 0) addError(`fields[${index}]`, 'Field names must be non-empty strings.');
      else if (supportedFields && !supportedFields.includes(field)) addError(`fields[${index}]`, `Field '${field}' is not supported for module '${module}'.`);
    });
  }

  if (!Array.isArray(filters)) addError('filters', 'filters must be an array.');
  else filters.forEach((filter, index) => {
    const path = `filters[${index}]`;
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
      addError(path, 'Each filter must be an object.');
      return;
    }
    if (!supportedFields || typeof filter.field !== 'string' || !supportedFields.includes(filter.field)) addError(`${path}.field`, `Filter field must be supported for module '${module}'.`);
    if (typeof filter.operator !== 'string' || !OPERATOR_SET.has(filter.operator)) {
      addError(`${path}.operator`, `Operator must be one of: ${CRM_OPERATORS.join(', ')}.`);
      return;
    }
    const hasValue = Object.prototype.hasOwnProperty.call(filter, 'value');
    if (NULL_OPERATORS.has(filter.operator)) {
      if (hasValue) addError(`${path}.value`, `${filter.operator} must not include a value.`);
    } else if (VALUE_OPERATORS.has(filter.operator)) {
      if (!hasValue) addError(`${path}.value`, `Operator '${filter.operator}' requires a value.`);
      else if (filter.operator === 'in' && (!Array.isArray(filter.value) || filter.value.length === 0 || filter.value.some((value) => !isValue(value)))) addError(`${path}.value`, 'in requires a non-empty array of scalar values.');
      else if (filter.operator === 'between' && (!Array.isArray(filter.value) || filter.value.length !== 2 || filter.value.some((value) => !isValue(value)))) addError(`${path}.value`, 'between requires exactly two scalar values.');
      else if (!['in', 'between'].includes(filter.operator) && !isValue(filter.value)) addError(`${path}.value`, `Operator '${filter.operator}' requires a scalar value.`);
    }
  });

  if (sort !== undefined) {
    if (!sort || typeof sort !== 'object' || Array.isArray(sort)) addError('sort', 'sort must be an object.');
    else {
      if (!supportedFields || !supportedFields.includes(sort.field)) addError('sort.field', `Sort field must be supported for module '${module}'.`);
      if (!['asc', 'desc'].includes(sort.order)) addError('sort.order', "sort.order must be either 'asc' or 'desc'.");
    }
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) addError('limit', 'limit must be an integer between 1 and 200.');
  if (!Number.isInteger(offset) || offset < 0) addError('offset', 'offset must be a non-negative integer.');

  if (errors.length > 0) throw createAppError('INVALID_CRM_REQUEST', 'CRM request validation failed.', 400, { errors });
  return { module, fields, filters, sort, limit, offset };
}

module.exports = { validateCrmQuery };
