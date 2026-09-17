const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

function validateCoqlPagination(limit = DEFAULT_LIMIT, offset = 0) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error('COQL limit must be an integer between 1 and 200.');
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error('COQL offset must be a non-negative integer.');
  }
  return { limit, offset };
}

function buildCoqlPagination(limit, offset) {
  const pagination = validateCoqlPagination(limit, offset);
  return ` limit ${pagination.offset}, ${pagination.limit}`;
}

module.exports = { buildCoqlPagination, validateCoqlPagination };
