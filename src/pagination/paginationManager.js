const { randomUUID, createHash } = require('node:crypto');
const { createClient } = require('redis');
const { env } = require('../config/env');
const { advance, advancePagination, createPaginationState, createQueryIdentity, extractPageSize, isPaginationContinuation, isExplicitPageRequest } = require('../query/pagination');

const DEFAULT_TTL_MS = 30 * 60 * 1000;

class PaginationManager {
  constructor({ maxConversations = 1000, maxStates = 5000, tokenTtlMs = DEFAULT_TTL_MS, redisUrl = env.redisUrl, redisPrefix = env.redisPrefix } = {}) {
    this.states = new Map();
    this.tokenStates = new Map();
    this.maxConversations = maxConversations;
    this.maxStates = maxStates;
    this.tokenTtlMs = tokenTtlMs;
    this.redisPrefix = redisPrefix;
    this.redis = redisUrl ? createClient({ url: redisUrl }) : null;
    this.redisConnection = null;
    if (this.redis) this.redis.on('error', (error) => console.error('[PAGINATION] storage=redis error=', error.message));
    console.log(`[PAGINATION] storage=${this.redis ? 'redis' : 'memory'}`);
  }

  getConversationState(conversationId) {
    return conversationId ? this.states.get(conversationId) || null : null;
  }

  getTokenState(token) {
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

  get(conversationId) { return this.getConversationState(conversationId); }
  getByToken(token) { return this.getTokenState(token); }

  isContinuation(question) {
    return isPaginationContinuation(question) || isExplicitPageRequest(question);
  }

  advance(previousState, requestedLimit) {
    if (!previousState) throw paginationError('PAGINATION_STATE_NOT_FOUND', 'No previous CRM page is available.', 409);
    if (previousState.pagination.more_records === false) return null;
    return advance(previousState, requestedLimit);
  }

  planContinuation(question, previous) {
    if (!previous?.canonical_plan) return null;
    const pagination = isExplicitPageRequest(question)
      ? advancePagination(previous, question, previous.canonical_plan)
      : this.advance(previous, extractPageSize(question));
    return {
      ...previous.canonical_plan,
      ...pagination,
      pagination: { ...(previous.canonical_plan.pagination || {}), ...pagination }
    };
  }

  save(conversationId, canonicalPlan, result, requestId, question, previousState = null) {
    const pagination = createPaginationState(canonicalPlan, result);
    const recordIds = extractRecordIds(result);
    if (previousState && samePage(previousState.page.record_ids, recordIds)) throw paginationError('PAGINATION_DUPLICATE_PAGE', 'The requested next page returned the same records as the previous page.', 409, { record_ids: recordIds });
    const continuationToken = randomUUID();
    const now = Date.now();
    const state = {
      conversation_id: conversationId,
      continuation_token: continuationToken,
      canonical_query: stripPagination(canonicalPlan),
      canonical_plan: { ...canonicalPlan, pagination },
      pagination,
      last_offset: pagination.offset,
      last_returned: pagination.returned,
      last_limit: pagination.limit,
      more_records: pagination.more_records,
      query_fingerprint: createQueryIdentity(canonicalPlan),
      record_ids: recordIds,
      page: { number: (previousState?.page?.number || 0) + 1, record_ids: recordIds, identity: pageIdentity(recordIds) },
      continuation: { token: continuationToken, created_at: new Date(now).toISOString(), expires_at: now + this.tokenTtlMs },
      metadata: { request_id: requestId, created_from_question: question, updated_at: new Date(now).toISOString() },
      created_at: new Date(now).toISOString(),
      expires_at: now + this.tokenTtlMs,
      updated_at: new Date(now).toISOString(),
      request_id: requestId,
      question
    };
    this.tokenStates.set(continuationToken, state);
    if (conversationId) this.states.set(conversationId, state);
    while (this.tokenStates.size > this.maxStates) this.tokenStates.delete(this.tokenStates.keys().next().value);
    if (this.states.size > this.maxConversations) this.states.delete(this.states.keys().next().value);
    return state;
  }

  async getByTokenAsync(token) {
    const local = this.tokenStates.get(token);
    if (local) return this.getTokenState(token);
    const state = await this.readRedis(`token:${token}`);
    if (!state) return this.getTokenState(token);
    this.tokenStates.set(token, state);
    return state;
  }

  async getConversationStateAsync(conversationId) {
    const local = this.getConversationState(conversationId);
    if (local || !this.redis) return local;
    const state = await this.readRedis(`conversation:${conversationId}`);
    if (state) {
      this.states.set(conversationId, state);
      this.tokenStates.set(state.continuation.token, state);
    }
    return state;
  }

  async saveAsync(conversationId, canonicalPlan, result, requestId, question, previousState = null) {
    const state = this.save(conversationId, canonicalPlan, result, requestId, question, previousState);
    await this.writeRedis(`token:${state.continuation.token}`, state);
    if (conversationId) await this.writeRedis(`conversation:${conversationId}`, state);
    return state;
  }

  async connectRedis() {
    if (!this.redis) return false;
    if (!this.redisConnection) this.redisConnection = this.redis.connect().catch((error) => { this.redisConnection = null; console.error('[PAGINATION] storage=memory redis_unavailable=', error.message); return false; });
    return this.redisConnection;
  }

  async readRedis(key) {
    if (!(await this.connectRedis())) return null;
    try { const value = await this.redis.get(`${this.redisPrefix}pagination:${key}`); return value ? JSON.parse(value) : null; } catch (error) { console.error('[PAGINATION] redis_read_failed=', error.message); return null; }
  }

  async writeRedis(key, state) {
    if (!(await this.connectRedis())) return;
    try { await this.redis.set(`${this.redisPrefix}pagination:${key}`, JSON.stringify(state), { PX: Math.max(1, state.continuation.expires_at - Date.now()) }); } catch (error) { console.error('[PAGINATION] redis_write_failed=', error.message); }
  }

}

function extractRecordIds(result) {
  const records = Array.isArray(result?.data) ? result.data : Array.isArray(result?.records) ? result.records : [];
  return records.map((record) => String(record?.id || record?.ID || '')).filter(Boolean);
}

function stripPagination(plan) {
  const { pagination: _pagination, limit: _limit, offset: _offset, ...query } = plan || {};
  return query;
}

function pageIdentity(recordIds) {
  return recordIds.length ? createHash('sha256').update(JSON.stringify(recordIds)).digest('hex') : null;
}

function samePage(previousIds, currentIds) {
  return previousIds.length > 0 && currentIds.length > 0 && pageIdentity(previousIds) === pageIdentity(currentIds);
}

function paginationError(code, message, statusCode = 409, details) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  if (details) error.details = details;
  return error;
}

module.exports = { PaginationManager, extractRecordIds, pageIdentity };
