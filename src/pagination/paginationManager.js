const {
  advancePagination,
  createPaginationState,
  createQueryIdentity,
  isExplicitPageRequest,
  isPaginationContinuation
} = require('../query/pagination');
const { randomUUID } = require('node:crypto');

const DEFAULT_TTL_MS = 30 * 60 * 1000;

class PaginationManager {
  constructor({ maxConversations = 1000, tokenTtlMs = DEFAULT_TTL_MS } = {}) {
    this.states = new Map();
    this.tokenStates = new Map();
    this.maxConversations = maxConversations;
    this.tokenTtlMs = tokenTtlMs;
  }

  get(conversationId) {
    return conversationId ? this.states.get(conversationId) || null : null;
  }

  getByToken(token) {
    if (!token) return null;
    const state = this.tokenStates.get(token);
    if (!state) {
      const error = new Error('The pagination continuation is expired or invalid. Please start a new query.');
      error.code = 'PAGINATION_TOKEN_INVALID';
      error.statusCode = 409;
      throw error;
    }
    if (state.expires_at <= Date.now()) {
      this.tokenStates.delete(token);
      const error = new Error('The pagination continuation has expired. Please start a new query.');
      error.code = 'PAGINATION_TOKEN_EXPIRED';
      error.statusCode = 409;
      throw error;
    }
    return state;
  }

  isContinuation(question) {
    return isPaginationContinuation(question) || isExplicitPageRequest(question);
  }

  planContinuation(question, previous) {
    if (!previous?.canonical_plan) return null;
    const pagination = advancePagination(previous, question, previous.canonical_plan);
    return {
      ...previous.canonical_plan,
      ...pagination,
      pagination: { ...(previous.canonical_plan.pagination || {}), ...pagination }
    };
  }

  save(conversationId, canonicalPlan, result, requestId, question, previousToken = null) {
    const pagination = createPaginationState(canonicalPlan, result);
    const previous = previousToken ? this.getByToken(previousToken) : this.get(conversationId);
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
    const continuationToken = randomUUID();
    const now = Date.now();
    const state = {
      conversation_id: conversationId,
      continuation_token: continuationToken,
      canonical_plan: { ...canonicalPlan, pagination },
      canonical_plan_without_pagination: stripPagination(canonicalPlan),
      pagination,
      last_offset: pagination.offset,
      last_returned: pagination.returned,
      last_limit: pagination.limit,
      more_records: pagination.more_records,
      query_fingerprint: createQueryIdentity(canonicalPlan),
      record_ids: recordIds,
      created_at: new Date(now).toISOString(),
      expires_at: now + this.tokenTtlMs,
      updated_at: new Date(now).toISOString(),
      request_id: requestId,
      question
    };
    // Keep prior tokens as aliases to the newest state so connector retries do
    // not restart or fail a conversation after a token rotation.
    if (previous) {
      for (const [token, tokenState] of this.tokenStates.entries()) {
        if (tokenState === previous) this.tokenStates.set(token, state);
      }
    }
    this.tokenStates.set(continuationToken, state);
    if (conversationId) this.states.set(conversationId, state);
    if (this.tokenStates.size > this.maxConversations) this.tokenStates.delete(this.tokenStates.keys().next().value);
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
