const { BOOKS_MODULES, BOOKS_API_NAMES } = require('../constants/booksModules');
const { createAppError } = require('../utils/errors');

const BOOKS_OPERATORS = Object.freeze([
  'equals', 'not_equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal',
  'between', 'in', 'contains', 'starts_with', 'ends_with', 'is_empty', 'is_not_empty'
]);

function resolveProductDomain(text = '') {
  const lower = String(text || '').toLowerCase();
  const booksModules = Object.keys(BOOKS_API_NAMES);
  const crmModules = ['Leads', 'Deals', 'Contacts', 'Accounts', 'Tasks', 'Calls', 'Meetings', 'Products', 'Reports', 'Users'];

  for (const moduleName of [...booksModules].sort((a, b) => b.length - a.length)) {
    const pattern = new RegExp(`\\b${moduleName.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (pattern.test(lower)) return 'books';
  }

  for (const moduleName of crmModules) {
    const pattern = new RegExp(`\\b${moduleName.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (pattern.test(lower)) return 'crm';
  }

  if (/\b(invoices|items|customers|vendors|estimates|sales orders|purchase orders|bills|expenses|bank accounts|projects|payments received|payments made)\b/i.test(lower)) return 'books';
  if (/\b(deals|leads|contacts|accounts|meetings|calls|tasks|products|reports|users)\b/i.test(lower)) return 'crm';
  return 'unknown';
}

function booksQueryValidator(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createAppError('INVALID_BOOKS_REQUEST', 'Books request validation failed.', 400, { errors: [{ path: 'body', message: 'Request body must be a JSON object.' }] });
  }

  const { module, fields = [], filters = [], sort, limit = 20, offset = 0, request_type = 'records' } = body;
  const requestTypes = new Set(['records', 'count', 'search', 'aggregate', 'comparison', 'analysis']);

  if (!module || typeof module !== 'string' || module.trim().length === 0) {
    throw createAppError('INVALID_BOOKS_REQUEST', 'Book module is required.', 400);
  }
  if (!requestTypes.has(request_type)) {
    throw createAppError('INVALID_BOOKS_REQUEST', 'request_type must be one of: records, count, search, aggregate, comparison, analysis.', 400);
  }
  if (!Object.prototype.hasOwnProperty.call(BOOKS_MODULES, module)) {
    if (typeof body.module_api_name === 'string' && body.module_api_name.trim().length > 0) {
      // dynamic/ custom modules are allowed when the API name is explicit.
    } else {
      throw createAppError('BOOKS_MODULE_UNSUPPORTED', `Books module '${module}' is not supported by the backend allowlist.`, 404, { module, supported_modules: Object.keys(BOOKS_MODULES) });
    }
  }

  const moduleFieldList = BOOKS_MODULES[module] || [];
  const normalizedFields = Array.isArray(fields) && fields.length > 0 ? fields : moduleFieldList.slice(0, 6);
  if (Array.isArray(normalizedFields)) {
    normalizedFields.forEach((field, index) => {
      if (typeof field !== 'string' || field.length === 0) {
        throw createAppError('INVALID_BOOKS_FIELD', `Field at index ${index} is invalid.`, 400);
      }
      if (moduleFieldList.length > 0 && !moduleFieldList.includes(field) && !/^[A-Za-z0-9_]+$/.test(field)) {
        throw createAppError('INVALID_BOOKS_FIELD', `Field '${field}' is not a valid Books field name for module '${module}'.`, 400);
      }
    });
  }

  if (!Array.isArray(filters)) throw createAppError('INVALID_BOOKS_FILTER', 'filters must be an array.', 400);
  for (const filter of filters) {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
      throw createAppError('INVALID_BOOKS_FILTER', 'Each Books filter must be an object.', 400);
    }
    if (typeof filter.field !== 'string' || filter.field.length === 0) {
      throw createAppError('INVALID_BOOKS_FILTER', 'Filter field is required.', 400);
    }
    if (typeof filter.operator !== 'string' || !BOOKS_OPERATORS.includes(filter.operator)) {
      throw createAppError('INVALID_BOOKS_FILTER', `Operator '${filter.operator}' is not supported for Books.`, 400);
    }
  }

  if (sort && typeof sort === 'object' && !Array.isArray(sort)) {
    if (typeof sort.field !== 'string' || sort.field.length === 0) {
      throw createAppError('INVALID_BOOKS_SORT', 'sort.field must be a non-empty string.', 400);
    }
    if (!['asc', 'desc'].includes(sort.order)) {
      throw createAppError('INVALID_BOOKS_SORT', "sort.order must be either 'asc' or 'desc'.", 400);
    }
  }

  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw createAppError('INVALID_BOOKS_REQUEST', 'limit must be an integer between 1 and 200.', 400);
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw createAppError('INVALID_BOOKS_REQUEST', 'offset must be a non-negative integer.', 400);
  }

  return {
    module,
    module_api_name: body.module_api_name || BOOKS_API_NAMES[module] || body.module,
    fields: normalizedFields,
    filters,
    sort,
    limit,
    offset,
    request_type,
    date_range: body.date_range,
    comparison: body.comparison,
    aggregate: body.aggregate,
    analysis: body.analysis
  };
}

module.exports = { booksQueryValidator, resolveProductDomain, BOOKS_OPERATORS };
