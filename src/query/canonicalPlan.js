const INTENTS = Object.freeze({
  records: 'records',
  count: 'count',
  aggregate: 'aggregate',
  comparison: 'comparison',
  analysis: 'analysis',
  search: 'search',
  bulk_read: 'bulk_read'
});

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

function createCanonicalPlan(input = {}) {
  const request = input && typeof input === 'object' ? input : {};
  const requestType = INTENTS[request.request_type] || 'records';
  const limit = clampInteger(request.pagination?.limit ?? request.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clampInteger(request.pagination?.offset ?? request.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const sort = normalizeSort(request.sort, request.sort_field, request.sort_order);
  const fields = uniqueStrings(request.fields);
  const filters = Array.isArray(request.filters) ? request.filters.map((filter) => ({ ...filter })) : [];
  const groupBy = uniqueStrings(request.group_by);

  return {
    domain: request.domain || 'CRM',
    module: request.module || null,
    module_api_name: request.module_api_name,
    intent: requestType,
    request_type: requestType,
    fields,
    filters,
    filter_expression: request.filter_expression,
    sort,
    pagination: { limit, offset },
    limit,
    offset,
    aggregate: request.aggregate || null,
    group_by: groupBy,
    having_filter: request.having_filter,
    comparison: request.comparison || null,
    date_range: request.date_range || null,
    relationships: Array.isArray(request.relationships) ? request.relationships : [],
    search: request.search || null,
    analysis: request.analysis || null,
    original_question: request.original_question || null,
    metadata_driven: request.metadata_driven === true
  };
}

function normalizeSort(sort, sortField, sortOrder) {
  if (sortField || sortOrder) return sortField ? { field: sortField, order: sortOrder || 'asc' } : null;
  if (!sort) return null;
  return Array.isArray(sort) ? sort.map((item) => ({ ...item })) : { ...sort };
}

function uniqueStrings(value) {
  if (Array.isArray(value)) return [...new Set(value.filter((item) => typeof item === 'string' && item.trim()))];
  if (typeof value === 'string' && value.trim()) return [value];
  return [];
}

function clampInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number)) return value;
  if (number < minimum || number > maximum) return number;
  return number;
}

module.exports = { INTENTS, createCanonicalPlan };
