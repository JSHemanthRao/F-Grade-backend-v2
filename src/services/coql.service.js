const { CRM_API_NAMES } = require('../constants/crmModules');

const DATE_FIELDS = new Set(['Closing_Date', 'Due_Date', 'Valid_Till', 'Start_Date', 'End_Date', 'Renewal_Date']);

function normalizeDateValue(field, value) {
  if (!DATE_FIELDS.has(field)) return value;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Date value for ${field} must use YYYY-MM-DD.`);
  }
  return value;
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

function buildFilterClauses(filters) {
  return filters.flatMap(({ field, operator, value }) => {
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
    if (operator === 'between') return [`${field} >= ${formatComparisonValue(field, value[0])} and ${field} <= ${formatComparisonValue(field, value[1])}`];
    return [];
  });
}

function buildCoqlQuery({ module, fields, filters, sort }) {
  const clauses = buildFilterClauses(filters);
  let query = `select ${fields.join(', ')} from ${CRM_API_NAMES[module]}`;
  query += ` where ${buildWhereClause(clauses)}`;
  if (sort) query += ` order by ${sort.field} ${sort.order}`;
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

module.exports = { buildCoqlQuery, buildFilterClauses, buildWhereClause, formatValue, formatComparisonValue };
