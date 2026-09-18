const { CRM_API_NAMES } = require('../constants/crmModules');
const { validateModuleFieldScope } = require('../validators/crmQuery.validator');
const { formatDateBoundary } = require('../query/dateResolver');

function buildModuleCriteria(filters = []) {
  return filters.map(({ field, operator, value, exclusive_end: exclusiveEnd, value_type: valueType }) => {
    if (operator === 'is_null' || operator === 'is_not_null') return `(${field}:${operator})`;
    if (operator === 'between' && exclusiveEnd) return `(${field}:greater_equal:${formatSearchDate(value[0], valueType)})and(${field}:less_than:${formatSearchDate(value[1], valueType)})`;
    if (operator === 'between') return `(${field}:between:${formatSearchDate(value[0], valueType)},${formatSearchDate(value[1], valueType)})`;
    if (operator === 'in') return `(${field}:in:[${value.map((item) => formatSearchValue(item, valueType)).join(',')}])`;
    return `(${field}:${operator}:${formatSearchValue(value, valueType)})`;
  }).join('and');
}

function buildCriteria(filters = []) {
  return filters.map(({ field, operator, value, exclusive_end: exclusiveEnd, value_type: valueType }) => {
    if (operator === 'between' && exclusiveEnd) return `(${field}:greater_equal:${formatSearchDate(value[0], valueType)})and(${field}:less_than:${formatSearchDate(value[1], valueType)})`;
    if (operator === 'between') return `(${field}:between:${formatSearchDate(value[0], valueType)},${formatSearchDate(value[1], valueType)})`;
    if (operator === 'is_null' || operator === 'is_not_null') return `(${field}:${operator}:true)`;
    return `(${field}:${operator}:${formatSearchValue(value, valueType)})`;
  }).join('and');
}

function formatSearchDate(value, valueType) {
  return valueType === 'date' || valueType === 'datetime' ? formatDateBoundary(value, valueType) : String(value);
}

function formatSearchValue(value, valueType) {
  if (valueType === 'date' || valueType === 'datetime') return formatSearchDate(value, valueType);
  return String(value).replace(/([\\,:()])/g, '\\$1');
}

function formatValue(filter, value) {
  const normalized = filter.value_type === 'date' || filter.value_type === 'datetime'
    ? formatDateBoundary(value, filter.value_type)
    : value;
  if (typeof normalized === 'number' || typeof normalized === 'boolean') return String(normalized);
  return `'${String(normalized).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function formatComparisonValue(filter, value) {
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) return value;
  return formatValue(filter, value);
}

function formatDateComparisonValue(filter, value) {
  return formatComparisonValue(filter, value);
}

function buildFilterClauses(filters) {
  return filters.flatMap((filter) => {
    const { field, operator, value } = filter;
    if (operator === 'is_null' || operator === 'is_empty') return [`${field} is null`];
    if (operator === 'is_not_null' || operator === 'is_not_empty') return [`${field} is not null`];
    if (operator === 'equals') return [`${field} = ${formatValue(filter, value)}`];
    if (operator === 'not_equals') return [`${field} != ${formatValue(filter, value)}`];
    if (operator === 'contains') return [`${field} like ${formatValue(filter, `%${value}%`)}`];
    if (operator === 'starts_with') return [`${field} like ${formatValue(filter, `${value}%`)}`];
    if (operator === 'greater_than') return [`${field} > ${formatComparisonValue(filter, value)}`];
    if (operator === 'less_than') return [`${field} < ${formatComparisonValue(filter, value)}`];
    if (operator === 'greater_equal') return [`${field} >= ${formatComparisonValue(filter, value)}`];
    if (operator === 'less_equal') return [`${field} <= ${formatComparisonValue(filter, value)}`];
    if (operator === 'in') return [`${field} in (${value.map((item) => formatValue(filter, item)).join(', ')})`];
    if (operator === 'not_in') return [`${field} not in (${value.map((item) => formatValue(filter, item)).join(', ')})`];
    if (operator === 'between') return [`${field} >= ${formatDateComparisonValue(filter, value[0])} and ${field} ${filter.exclusive_end === true ? '<' : '<='} ${formatDateComparisonValue(filter, value[1])}`];
    return [];
  });
}

function buildCoqlQuery({ module, fields, filters, filter_expression: filterExpression, sort, having_filter: havingFilter, analysis, metadata_validated: metadataValidated, metadata_driven: metadataDriven }) {
  if (!metadataValidated && !metadataDriven) validateModuleFieldScope({ module, fields, filters, sort, analysis });
  const clauses = buildFilterClauses(filters);
  const moduleName = CRM_API_NAMES[module] || module;
  let query = `select ${fields.join(', ')} from ${moduleName}`;
  query += ` where ${filterExpression ? buildLogicalFilterClause(filterExpression) : buildWhereClause(clauses)}`;
  if (sort) {
    const sorts = Array.isArray(sort) ? sort : [sort];
    query += ` order by ${sorts.map(({ field, order }) => `${field} ${order}`).join(', ')}`;
  }
  if (havingFilter) query += ` having ${buildWhereClause(buildFilterClauses([havingFilter]))}`;
  return query;
}

function buildWhereClause(clauses) {
  if (clauses.length === 0) return '(id is not null)';
  const wrapped = clauses.map((clause) => `(${clause})`);
  if (wrapped.length === 1) return wrapped[0];
  if (wrapped.length === 2) return `(${wrapped[0]} and ${wrapped[1]})`;
  let expression = `(${wrapped[0]} and ${wrapped[1]})`;
  for (let index = 2; index < wrapped.length; index += 1) expression += ` and ${wrapped[index]}`;
  return expression;
}

function buildLogicalFilterClause(expression) {
  if (!expression || typeof expression !== 'object') return '(id is not null)';
  if (expression.field) {
    const clause = buildFilterClauses([expression])[0];
    return clause ? `(${clause})` : '(id is not null)';
  }
  const operator = String(expression.operator || 'AND').toUpperCase();
  const conditions = Array.isArray(expression.conditions) ? expression.conditions.map(buildLogicalFilterClause) : [];
  if (conditions.length === 0) return '(id is not null)';
  if (operator === 'NOT') return `(not ${conditions[0]})`;
  if (!['AND', 'OR'].includes(operator)) throw new Error(`Unsupported logical filter operator '${operator}'.`);
  return `(${conditions.join(` ${operator.toLowerCase()} `)})`;
}

module.exports = { buildCoqlQuery, buildFilterClauses, buildWhereClause, buildLogicalFilterClause, buildModuleCriteria, buildCriteria };
