const { getModuleDefinition } = require('../module-definition.service');

const OPERATIONS = new Set(['LIST', 'SEARCH', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COMPARE']);

function validateIntentQueryPlan(queryPlan) {
  const issues = [];
  if (!queryPlan || typeof queryPlan !== 'object') return { valid: false, issues: ['query_plan_missing'] };
  if (!queryPlan.moduleKey || !getModuleDefinition(queryPlan.moduleKey)) issues.push('unsupported_module');
  if (!OPERATIONS.has(queryPlan.operation)) issues.push('unsupported_operation');
  if (!Array.isArray(queryPlan.fields) || !queryPlan.fields.includes('id')) issues.push('required_id_field_missing');
  if (!Array.isArray(queryPlan.filters)) issues.push('filters_missing');
  if (queryPlan.startDate || queryPlan.endDate || queryPlan.dateField) {
    if (!queryPlan.dateField || !queryPlan.startDate || !queryPlan.endDate) issues.push('incomplete_date_range');
    if (queryPlan.startDate && Number.isNaN(new Date(queryPlan.startDate).valueOf())) issues.push('invalid_start_date');
    if (queryPlan.endDate && Number.isNaN(new Date(queryPlan.endDate).valueOf())) issues.push('invalid_end_date');
    if (queryPlan.startDate && queryPlan.endDate && new Date(queryPlan.startDate) >= new Date(queryPlan.endDate)) issues.push('invalid_date_order');
  }
  if (['SUM', 'AVG', 'MIN', 'MAX'].includes(queryPlan.operation)
    && !queryPlan.aggregation?.field) issues.push('aggregate_field_missing');
  if (!Number.isInteger(queryPlan.displayLimit) || queryPlan.displayLimit < 1) issues.push('display_limit_invalid');
  return { valid: issues.length === 0, issues };
}

function validateIntentQueryPlans(plansByModule = {}) {
  const results = Object.fromEntries(Object.entries(plansByModule).map(([moduleKey, queryPlan]) => [moduleKey, validateIntentQueryPlan(queryPlan)]));
  const issues = Object.values(results).flatMap((result) => result.issues);
  return { valid: issues.length === 0, issues: [...new Set(issues)], byModule: results };
}

module.exports = { validateIntentQueryPlan, validateIntentQueryPlans };
