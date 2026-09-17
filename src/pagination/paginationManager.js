const {
  advancePagination,
  createPaginationState,
  createQueryIdentity,
  isExplicitPageRequest,
  isPaginationContinuation
} = require('../query/pagination');

class PaginationManager {
  constructor({ maxConversations = 1000 } = {}) {
    this.states = new Map();
    this.maxConversations = maxConversations;
  }

  get(conversationId) {
    return conversationId ? this.states.get(conversationId) || null : null;
  }

  isContinuation(question) {
    return isPaginationContinuation(question) || isExplicitPageRequest(question);
  }

  planContinuation(question, previous) {
    if (!previous?.canonical_plan || !this.isContinuation(question)) return null;
    const pagination = advancePagination(previous, question, previous.canonical_plan);
    return {
      ...previous.canonical_plan,
      ...pagination,
      pagination: { ...(previous.canonical_plan.pagination || {}), ...pagination }
    };
  }

  save(conversationId, canonicalPlan, result, requestId, question) {
    if (!conversationId) return null;
    const pagination = createPaginationState(canonicalPlan, result);
    const previous = this.get(conversationId);
    const recordIds = extractRecordIds(result);
    if (previous && previous.query_fingerprint === createQueryIdentity(canonicalPlan)
      && previous.pagination.offset !== pagination.offset
      && previous.pagination.limit === pagination.limit
      && recordIds.length > 0
      && JSON.stringify(previous.record_ids) === JSON.stringify(recordIds)) {
      const error = new Error('The requested next page returned the same records as the previous page.');
      error.code = 'PAGINATION_DUPLICATE_PAGE';
      error.statusCode = 409;
      throw error;
    }
    const state = {
      conversation_id: conversationId,
      canonical_plan: { ...canonicalPlan, pagination },
      canonical_plan_without_pagination: stripPagination(canonicalPlan),
      pagination,
      last_offset: pagination.offset,
      last_returned: pagination.returned,
      last_limit: pagination.limit,
      more_records: pagination.more_records,
      query_fingerprint: createQueryIdentity(canonicalPlan),
      record_ids: recordIds,
      updated_at: new Date().toISOString(),
      request_id: requestId,
      question
    };
    this.states.set(conversationId, state);
    if (this.states.size > this.maxConversations) this.states.delete(this.states.keys().next().value);
    return state;
  }
}

function extractRecordIds(result) {
  const records = Array.isArray(result?.data) ? result.data : Array.isArray(result?.records) ? result.records : [];
  return records.map((record) => String(record?.id || record?.ID || '')).filter(Boolean);
}

function stripPagination(plan) {
  const { pagination: _pagination, limit: _limit, offset: _offset, ...withoutPagination } = plan || {};
  return withoutPagination;
}

module.exports = { PaginationManager, stripPagination };
