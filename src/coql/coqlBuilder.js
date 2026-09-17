const { buildCoqlQuery, buildFilterClauses, buildWhereClause, buildLogicalFilterClause } = require('../services/coql.service');

function buildExecutableCoqlPlan(plan) {
  return {
    ...plan,
    select_query: buildCoqlQuery(plan)
  };
}

module.exports = {
  buildCoqlQuery,
  buildExecutableCoqlPlan,
  buildFilterClauses,
  buildWhereClause,
  buildLogicalFilterClause
};
