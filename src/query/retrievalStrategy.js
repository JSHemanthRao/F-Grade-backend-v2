const RETRIEVAL_STRATEGIES = Object.freeze({
  DIRECT_COQL: 'DIRECT_COQL',
  RELATIONSHIP_COQL: 'RELATIONSHIP_COQL',
  PAGINATED_COQL: 'PAGINATED_COQL',
  COUNT_API: 'COUNT_API',
  AGGREGATE_COQL: 'AGGREGATE_COQL',
  GROUPED_COQL: 'GROUPED_COQL',
  RECORD_LOOKUP: 'RECORD_LOOKUP',
  BULK_READ: 'BULK_READ',
  MULTI_QUERY_ANALYSIS: 'MULTI_QUERY_ANALYSIS',
  CONVERSION_ANALYSIS: 'CONVERSION_ANALYSIS',
  ACTIVITY_ANALYSIS: 'ACTIVITY_ANALYSIS'
});

const CONVERSION_ANALYSES = new Set([
  'lead_conversion',
  'lead_closed_won_conversion',
  'conversion_funnel',
  'lead_source_conversion_report'
]);

/**
 * Selects a retrieval mode exclusively from a canonical plan. It deliberately
 * does not inspect the original question, so execution remains deterministic
 * after semantic planning and live-metadata resolution.
 */
function selectRetrievalStrategy(plan = {}) {
  const requestType = plan.intent || plan.request_type || 'records';
  const analysisType = plan.analysis?.type;

  if (analysisType === 'today_activity') return RETRIEVAL_STRATEGIES.ACTIVITY_ANALYSIS;
  if (CONVERSION_ANALYSES.has(analysisType)) return RETRIEVAL_STRATEGIES.CONVERSION_ANALYSIS;
  if (requestType === 'analysis' || requestType === 'comparison') return RETRIEVAL_STRATEGIES.MULTI_QUERY_ANALYSIS;
  if (requestType === 'bulk_read') return RETRIEVAL_STRATEGIES.BULK_READ;
  if (requestType === 'search') return RETRIEVAL_STRATEGIES.RECORD_LOOKUP;
  if (requestType === 'count') return RETRIEVAL_STRATEGIES.COUNT_API;
  if (requestType === 'aggregate') {
    return hasGroupBy(plan) ? RETRIEVAL_STRATEGIES.GROUPED_COQL : RETRIEVAL_STRATEGIES.AGGREGATE_COQL;
  }
  if (hasRelationshipReferences(plan)) return RETRIEVAL_STRATEGIES.RELATIONSHIP_COQL;
  if (Number(plan.offset ?? plan.pagination?.offset ?? 0) > 0) return RETRIEVAL_STRATEGIES.PAGINATED_COQL;
  return RETRIEVAL_STRATEGIES.DIRECT_COQL;
}

function hasGroupBy(plan) {
  return Array.isArray(plan.group_by) ? plan.group_by.length > 0 : Boolean(plan.group_by);
}

function hasRelationshipReferences(plan) {
  if (Array.isArray(plan.relationships) && plan.relationships.length > 0) return true;
  const fields = [
    ...(plan.fields || []),
    ...(plan.execution_fields || []),
    ...(plan.response_fields || []),
    ...(plan.filters || []).map((filter) => filter?.field),
    ...(Array.isArray(plan.sort) ? plan.sort : plan.sort ? [plan.sort] : []).map((sort) => sort?.field),
    plan.aggregate?.field,
    ...(Array.isArray(plan.group_by) ? plan.group_by : [plan.group_by]),
    plan.having_filter?.field
  ].filter(Boolean);
  return fields.some((field) => String(field).includes('.'));
}

module.exports = { RETRIEVAL_STRATEGIES, selectRetrievalStrategy, hasRelationshipReferences };
