const { buildCoqlQuery, buildFilterClauses, buildWhereClause, buildLogicalFilterClause } = require('../services/coql.service');

function buildExecutableCoqlPlan(plan) {
  const normalizedPlan = {
    ...plan,
    fields: Array.isArray(plan.fields) ? plan.fields : [],
    filters: Array.isArray(plan.filters) ? plan.filters : [],
    sort: ensureStableSort(plan.sort)
  };
  return {
    ...normalizedPlan,
    select_query: buildCoqlQuery(normalizedPlan)
  };
}

function ensureStableSort(sort) {
  const sorts = Array.isArray(sort) ? sort : sort ? [sort] : [];
  if (sorts.length === 0) return [{ field: 'id', order: 'desc' }];
  if (sorts.some((item) => String(item?.field).toLowerCase() === 'id')) return sorts;
  return [...sorts, { field: 'id', order: 'desc' }];
}

module.exports = {
  buildCoqlQuery,
  buildExecutableCoqlPlan,
  buildFilterClauses,
  buildWhereClause,
  buildLogicalFilterClause,
  ensureStableSort
};
