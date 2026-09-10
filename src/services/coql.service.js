const { CRM_API_NAMES } = require('../constants/crmModules');
const { validateModuleFieldScope } = require('../validators/crmQuery.validator');
const { env } = require('../config/env');

const DATE_FIELDS = new Set(['Closing_Date', 'Due_Date', 'Valid_Till', 'Start_Date', 'End_Date', 'Renewal_Date']);
const DATETIME_FIELDS = new Set(['Created_Time', 'Modified_Time', 'Converted_Date_Time', 'Lead_Conversion_Time', 'Start_DateTime', 'End_DateTime', 'Call_Start_Time']);

function buildModuleCriteria(filters) {
  return filters.map(({ field, operator, value, exclusive_end: exclusiveEnd }) => {
    if (operator === 'is_null' || operator === 'is_not_null') return `(${field}:${operator})`;
    if (operator === 'between' && exclusiveEnd && DATETIME_FIELDS.has(field)) return `(${field}:greater_equal:${formatSearchDate(field, value[0], false)})and(${field}:less_than:${formatSearchDate(field, value[1], false)})`;
    if (operator === 'between') return `(${field}:between:${formatSearchDate(field, value[0], false)},${formatSearchDate(field, value[1], true)})`;
    if (operator === 'in') return `(${field}:in:[${value.map((item) => formatSearchValue(field, item)).join(',')}])`;
    return `(${field}:${operator}:${formatSearchValue(field, value)})`;
  }).join('and');
}

function buildCriteria(filters) {
  return filters.map(({ field, operator, value, exclusive_end: exclusiveEnd }) => {
    if (operator === 'between' && exclusiveEnd && DATETIME_FIELDS.has(field)) return `(${field}:greater_equal:${formatSearchDate(field, value[0], false)})and(${field}:less_than:${formatSearchDate(field, value[1], false)})`;
    if (operator === 'between') return `(${field}:between:${formatSearchDate(field, value[0], false)},${formatSearchDate(field, value[1], true)})`;
    if (operator === 'is_null' || operator === 'is_not_null') return `(${field}:${operator}:true)`;
    return `(${field}:${operator}:${formatSearchValue(field, value)})`;
  }).join('and');
}

function formatSearchDate(field, value, endOfDay = false) {
  if (DATETIME_FIELDS.has(field) && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) return `${value}T${endOfDay ? '23:59:59' : '00:00:00'}${timeZoneOffset(value)}`;
  return String(value);
}

function timeZoneOffset(value) {
  const date = new Date(`${value}T12:00:00Z`);
  const part = new Intl.DateTimeFormat('en-US', { timeZone: env.crmTimezone, timeZoneName: 'longOffset' }).formatToParts(date).find((item) => item.type === 'timeZoneName')?.value || 'GMT';
  if (part === 'GMT' || part === 'UTC') return '+00:00';
  const match = part.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  return match ? `${match[1]}${match[2].padStart(2, '0')}:${match[3] || '00'}` : '+00:00';
}

function formatSearchValue(field, value) {
  if (DATE_FIELDS.has(field)) return formatSearchDate(field, value);
  return String(value).replace(/([\\,:()])/g, '\\$1');
}

function normalizeDateValue(field, value) {
  if (!DATE_FIELDS.has(field) && !DATETIME_FIELDS.has(field)) return value;
  // Accept plain YYYY-MM-DD or ISO datetimes and normalize to YYYY-MM-DD
  if (typeof value === 'string') {
    const m = value.match(/^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$/);
    if (m) return m[1];
  }
  throw new Error(`Date value for ${field} must use YYYY-MM-DD.`);
}

function formatValue(field, value) {
  const normalized = normalizeDateValue(field, value);
  if (typeof normalized === 'number' || typeof normalized === 'boolean') return String(normalized);
  return `'${String(normalized).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function formatComparisonValue(field, value) {
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) return value;
  return formatValue(field, value);
}

function formatDateComparisonValue(field, value, endOfDay = false, exclusiveEnd = false) {
  if (!DATE_FIELDS.has(field) && !DATETIME_FIELDS.has(field)) return formatComparisonValue(field, value);
  const normalized = normalizeDateValue(field, value);
  if (DATETIME_FIELDS.has(field) && endOfDay && !exclusiveEnd) {
    const end = new Date(`${normalized}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    const nextDay = end.toISOString().slice(0, 10);
    return `'${nextDay}T00:00:00+05:30'`;
  }
  return `'${formatSearchDate(field, normalized)}'`;
}

function buildFilterClauses(filters) {
  return filters.flatMap((filter) => {
    const { field, operator, value } = filter;
    if (operator === 'is_null') return [`${field} is null`];
    if (operator === 'is_not_null') return [`${field} is not null`];
    if (operator === 'equals') return [`${field} = ${formatValue(field, value)}`];
    if (operator === 'not_equals') return [`${field} != ${formatValue(field, value)}`];
    if (operator === 'contains') return [`${field} like ${formatValue(field, `%${value}%`)}`];
    if (operator === 'starts_with') return [`${field} like ${formatValue(field, `${value}%`)}`];
    if (operator === 'greater_than') return [`${field} > ${formatComparisonValue(field, value)}`];
    if (operator === 'less_than') return [`${field} < ${formatComparisonValue(field, value)}`];
    if (operator === 'greater_equal') return [`${field} >= ${formatComparisonValue(field, value)}`];
    if (operator === 'less_equal') return [`${field} <= ${formatComparisonValue(field, value)}`];
    if (operator === 'in') return [`${field} in (${value.map((item) => formatValue(field, item)).join(', ')})`];
    if (operator === 'not_in') return [`${field} not in (${value.map((item) => formatValue(field, item)).join(', ')})`];
    if (operator === 'between') return [`${field} >= ${formatDateComparisonValue(field, value[0])} and ${field} ${DATETIME_FIELDS.has(field) ? '<' : '<='} ${formatDateComparisonValue(field, value[1], true, filter.exclusive_end === true)}`];
    return [];
  });
}

function buildCoqlQuery({ module, fields, filters, filter_expression: filterExpression, sort, having_filter: havingFilter }) {
  validateModuleFieldScope({ module, fields, filters, sort });
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
