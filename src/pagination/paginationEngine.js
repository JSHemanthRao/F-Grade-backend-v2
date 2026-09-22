const { createHash } = require('node:crypto');
const { createAppError } = require('../utils/errors');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

class PaginationEngine {
  constructor({ defaultLimit = DEFAULT_LIMIT, maxLimit = MAX_LIMIT } = {}) {
    this.defaultLimit = defaultLimit;
    this.maxLimit = maxLimit;
  }

  normalizePagination(pagination = {}) {
    const limit = pagination.limit === undefined ? this.defaultLimit : pagination.limit;
    const offset = pagination.offset === undefined ? 0 : pagination.offset;
    this.validatePagination({ limit, offset });
    return { limit, offset };
  }

  validatePagination({ limit, offset } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > this.maxLimit) {
      throw createAppError('INVALID_PAGINATION', `limit must be an integer between 1 and ${this.maxLimit}`, 400, { path: 'pagination.limit' });
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw createAppError('INVALID_PAGINATION', 'offset must be a non-negative integer', 400, { path: 'pagination.offset' });
    }
    return true;
  }

  calculateNextOffset({ offset = 0, returned = 0, hasMore = false } = {}) {
    if (!hasMore) return null;
    return offset + returned;
  }

  calculatePageNumber({ offset = 0, limit = this.defaultLimit } = {}) {
    return Math.floor(offset / limit) + 1;
  }

  buildPaginationMetadata({ offset, limit, returned, hasMore }) {
    const normalizedReturned = Number.isInteger(returned) && returned >= 0 ? returned : 0;
    return {
      offset,
      limit,
      returned: normalizedReturned,
      next_offset: this.calculateNextOffset({ offset, returned: normalizedReturned, hasMore }),
      has_more: Boolean(hasMore),
      more_records: Boolean(hasMore)
    };
  }

  validateQueryContinuity(query, queryContext = {}) {
    if (!queryContext || queryContext.fingerprint === undefined) return true;
    const expected = createQueryFingerprint(query);
    if (queryContext.fingerprint !== expected) {
      throw createAppError('QUERY_CONTEXT_MISMATCH', 'Pagination state does not match the requested query.', 409, {
        expected_fingerprint: expected,
        received_fingerprint: queryContext.fingerprint
      });
    }
    return true;
  }
}

function createQueryFingerprint(query) {
  return createHash('sha256').update(stableStringify(stripPagination(query))).digest('hex');
}

function stripPagination(query = {}) {
  const { limit: _limit, offset: _offset, pagination: _pagination, query_context: _queryContext, ...rest } = query || {};
  return rest;
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
  DEFAULT_LIMIT,
  MAX_LIMIT,
  PaginationEngine,
  createQueryFingerprint,
  stableStringify
};
