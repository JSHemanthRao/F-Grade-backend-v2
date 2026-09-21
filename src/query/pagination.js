const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

function isPaginationContinuation(text) {
  return /^(?:(?:yes|yeah|yep|please)[,!\s]+)?(?:(?:proceed|continue)|(?:fetch\s+)?next(?:\s+(?:\d+\s+)?(?:page|records?|batch(?:es)?|set)|\s+\d+)?|(?:show|give|fetch)\s+me\s+(?:the\s+)?(?:next(?:\s+(?:\d+\s+)?(?:page|records?|batch(?:es)?|set)|\s+\d+)?|more(?:\s+(?:records?|results?))?)|more(?:\s+(?:records?|results?))?)\b/i.test(String(text || '').trim());
}

function isPaginationAffirmation(text) {
  return /^(?:yes|yeah|yep|yes please|please do)[!.\s]*$/i.test(String(text || '').trim());
}

function isPaginationDecline(text) {
  return /^(?:no|nope|no thanks|not now)[!.\s]*$/i.test(String(text || '').trim());
}

function isExplicitPageRequest(text) {
  return /^(?:show\s+me\s+)?page\s+\d+\b/i.test(String(text || '').trim());
}

function extractPageSize(text) {
  const match = String(text || '').match(/\b(?:next|show\s+me\s+(?:the\s+)?next|show\s+me|show|give\s+me)\s+(\d+)\b/i);
  if (!match) return null;
  return clampLimit(Number(match[1]));
}

function extractPageNumber(text) {
  const match = String(text || '').match(/\bpage\s+(\d+)\b/i);
  return match ? Math.min(Math.max(Number(match[1]), 1), 1000) : 1;
}

function advancePagination(previousState, originalQuestion, priorPlan) {
  const previousPagination = previousState?.pagination || {};
  const previousOffset = integerOr(previousPagination.offset ?? previousState?.last_offset, 0);
  const previousReturned = integerOr(previousPagination.returned ?? previousState?.last_returned, 0);
  const previousLimit = clampLimit(integerOr(previousPagination.limit ?? previousState?.last_limit, priorPlan?.limit || DEFAULT_LIMIT));
  if (previousReturned === 0 && !isExplicitPageRequest(originalQuestion)) {
    const error = new Error('The previous CRM page contained no records, so the next page cannot advance.');
    error.code = 'PAGINATION_NO_PROGRESS';
    error.statusCode = 409;
    error.details = { previous_offset: previousOffset, previous_returned: previousReturned };
    throw error;
  }
  const requestedLimit = extractPageSize(originalQuestion) || previousLimit;
  const offset = isExplicitPageRequest(originalQuestion)
    ? Math.max(0, (extractPageNumber(originalQuestion) - 1) * requestedLimit)
    : previousOffset + previousReturned;

  if (!Number.isInteger(offset) || offset <= previousOffset) {
    const error = new Error('The next CRM page did not advance beyond the previous page.');
    error.code = 'PAGINATION_OFFSET_INVALID';
    error.statusCode = 409;
    error.details = { previous_offset: previousOffset, previous_returned: previousReturned, new_offset: offset };
    throw error;
  }

  return { limit: requestedLimit, offset };
}

function createPaginationState(plan, result) {
  const records = Array.isArray(result?.data) ? result.data : Array.isArray(result?.records) ? result.records : [];
  const requested = plan?.pagination || {};
  return {
    limit: integerOr(requested.limit, DEFAULT_LIMIT),
    offset: integerOr(requested.offset, 0),
    returned: records.length,
    more_records: resolveMoreRecords(result)
  };
}

function createQueryIdentity(plan) {
  const resolvedDateRange = plan?.date_range || plan?.filters?.find((filter) => filter?.date_range)?.date_range || null;
  return stableStringify({
    domain: plan?.domain || 'CRM',
    module: plan?.module || null,
    module_api_name: plan?.module_api_name || null,
    relationships: plan?.relationships || [],
    filters: plan?.filters || [],
    filter_expression: plan?.filter_expression || null,
    sort: plan?.sort || null,
    group_by: plan?.group_by || [],
    aggregate: plan?.aggregate?.operation === 'count' ? null : plan?.aggregate || null,
    comparison: plan?.comparison || null,
    date_range: resolvedDateRange,
    analysis: plan?.analysis || null
  });
}

function resolveMoreRecords(result) {
  if (typeof result?.pagination?.more_records === 'boolean') return result.pagination.more_records;
  if (typeof result?.more_records === 'boolean') return result.more_records;
  return false;
}

function integerOr(value, fallback) {
  return Number.isInteger(Number(value)) && Number(value) >= 0 ? Number(value) : fallback;
}

function clampLimit(value) {
  return Math.min(Math.max(Number(value) || DEFAULT_LIMIT, 1), MAX_LIMIT);
}

function stableStringify(value) {
  return JSON.stringify(value, (_key, innerValue) => {
    if (!innerValue || typeof innerValue !== 'object' || Array.isArray(innerValue)) return innerValue;
    return Object.keys(innerValue).sort().reduce((result, key) => {
      result[key] = innerValue[key];
      return result;
    }, {});
  });
}

module.exports = {
  advancePagination,
  createPaginationState,
  createQueryIdentity,
  extractPageNumber,
  extractPageSize,
  isExplicitPageRequest,
  isPaginationContinuation,
  isPaginationAffirmation,
  isPaginationDecline
};
