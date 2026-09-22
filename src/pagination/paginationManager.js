const {
  advancePagination,
  createPaginationState,
  createQueryIdentity,
  isExplicitPageRequest,
  isPaginationContinuation
} = require('../query/pagination');
const { randomUUID } = require('node:crypto');
const { createClient } = require('redis');
const { env } = require('../config/env');

const DEFAULT_TTL_MS = 30 * 60 * 1000;

class PaginationManager {
  constructor({ maxConversations = 1000, tokenTtlMs = DEFAULT_TTL_MS, redisUrl = env.redisUrl, redisPrefix = env.redisPrefix } = {}) {
    this.states = new Map();
    this.tokenStates = new Map();
    this.maxConversations = maxConversations;
    this.tokenTtlMs = tokenTtlMs;
    this.redisPrefix = redisPrefix;
    this.redis = redisUrl ? createClient({ url: redisUrl }) : null;
    this.redisConnection = null;
    if (this.redis) {
      this.redis.on('error', (error) => console.error('[PAGINATION_REDIS] connection error', error.message));
    }
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

  async getAsync(conversationId) {
    const local = this.get(conversationId);
    if (local || !this.redis) return local;
    const state = await this.readRedis(`conversation:${conversationId}`);
    if (!state) return null;
    this.remember(state);
    return state;
  }

  async getByTokenAsync(token) {
    if (!token) return null;
    const local = this.tokenStates.get(token);
    if (local) return this.getByToken(token);
    if (!this.redis) return this.getByToken(token);
    const state = await this.readRedis(`token:${token}`);
    if (!state) return this.getByToken(token);
    this.remember(state, token);
    return this.getByToken(token);
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

  async saveAsync(conversationId, canonicalPlan, result, requestId, question, previousToken = null) {
    const previous = previousToken
      ? await this.getByTokenAsync(previousToken)
      : await this.getAsync(conversationId);
    if (previous) this.remember(previous);
    const state = this.save(conversationId, canonicalPlan, result, requestId, question, previousToken);
    if (!this.redis) return state;
    await this.writeRedis(`token:${state.continuation_token}`, state);
    if (conversationId) await this.writeRedis(`conversation:${conversationId}`, state);
    if (previous?.continuation_token) await this.writeRedis(`token:${previous.continuation_token}`, state);
    return state;
  }

  remember(state, token = null) {
    if (!state) return;
    if (state.conversation_id) this.states.set(state.conversation_id, state);
    if (state.continuation_token) this.tokenStates.set(state.continuation_token, state);
    if (token) this.tokenStates.set(token, state);
  }

  async connectRedis() {
    if (!this.redis) return false;
    if (!this.redisConnection) {
      this.redisConnection = this.redis.connect().catch((error) => {
        this.redisConnection = null;
        console.error('[PAGINATION_REDIS] unavailable', error.message);
        return false;
      });
    }
    return this.redisConnection;
  }

  async readRedis(key) {
    if (!(await this.connectRedis())) return null;
    try {
      const value = await this.redis.get(`${this.redisPrefix}${key}`);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      console.error('[PAGINATION_REDIS] read failed', error.message);
      return null;
    }
  }

  async writeRedis(key, state) {
    if (!(await this.connectRedis())) return;
    try {
      await this.redis.set(`${this.redisPrefix}${key}`, JSON.stringify(state), { PX: Math.max(1, state.expires_at - Date.now()) });
    } catch (error) {
      console.error('[PAGINATION_REDIS] write failed', error.message);
    }
  }
}

function extractRecordIds(result) {
  const records = Array.isArray(result?.data) ? result.data : Array.isArray(result?.records) ? result.records : [];
  return records.map((record) => String(record?.id || record?.ID || '')).filter(Boolean);
}

module.exports = { PaginationManager };
