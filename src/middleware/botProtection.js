const { createHash } = require('node:crypto');
const { env } = require('../config/env');
const { log } = require('../utils/logger');

function createBotRateLimiters(options = {}) {
  const windowMs = options.windowMs || env.botRateLimitWindowMs;
  const store = options.store || createRateLimitStore(options);
  return {
    crm: createRateLimiter({
      bucket: 'crm',
      limit: options.crmLimit || env.botCrmRateLimit,
      windowMs,
      store
    }),
    aggregate: createRateLimiter({
      bucket: 'aggregate',
      limit: options.aggregateLimit || env.botAggregateRateLimit,
      windowMs,
      store
    }),
    audit: createRateLimiter({
      bucket: 'audit',
      limit: options.auditLimit || env.botAuditRateLimit,
      windowMs,
      store
    })
  };
}

function selectCrmRateLimiter(rateLimiters) {
  return function rateLimitByRequestType(req, res, next) {
    const question = String(
      req.body?.question
        || req.body?.request?.question
        || req.body?.prompt
        || req.body?.message
        || ''
    );
    const isExpensive = /\b(?:sum|total|average|avg|revenue|how many|count|conversion|performance|report|dashboard|compare)\b/i.test(question);
    const limiter = isExpensive ? rateLimiters.aggregate : rateLimiters.crm;
    return (limiter || passThrough)(req, res, next);
  };
}

function passThrough(_req, _res, next) {
  next();
}

function createRateLimitStore({ maxEntries = 10000 } = {}) {
  const memory = new Map();
  const entryLimit = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : 10000;
  let hasLoggedFallback = false;

  return {
    async increment(key, windowMs) {
      if (!hasLoggedFallback) {
        log('info', '[BOT_RATE_LIMIT] storage=process_memory');
        hasLoggedFallback = true;
      }
      const now = Date.now();
      for (const [storedKey, item] of memory) {
        if (item.expiresAt <= now) memory.delete(storedKey);
      }
      let item = memory.get(key);
      if (!item || item.expiresAt <= now) {
        item = { count: 0, expiresAt: now + windowMs };
        memory.set(key, item);
      }
      while (memory.size > entryLimit) memory.delete(memory.keys().next().value);
      item.count += 1;
      return { count: item.count, ttlMs: Math.max(0, item.expiresAt - now) };
    }
  };
}

function createRateLimiter({ bucket, limit, windowMs, store }) {
  return async function rateLimitBotRequest(req, res, next) {
    const identity = req.ip || req.socket?.remoteAddress || 'unknown';
    const identityHash = createHash('sha256').update(identity).digest('hex');
    const key = `bot-rate:${bucket}:${identityHash}`;
    try {
      const result = await store.increment(key, windowMs);
      if (result.count > limit) {
        return res.status(429).json({
          success: false,
          status: 'error',
          error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests. Please try again later.' }
        });
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

function rejectUnsafeBotInput({ allowedKeys, nestedKeys = {} }) {
  const allowed = new Set(allowedKeys);
  const credentialKey = /(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|credential|secret)/i;

  return function validateBotInput(req, res, next) {
    if (String(req.originalUrl || req.url || '').includes('?')) {
      return res.status(400).json({
        success: false,
        status: 'error',
        error: { code: 'INVALID_REQUEST', message: 'Query parameters are not accepted.' }
      });
    }
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({
        success: false,
        status: 'error',
        error: { code: 'INVALID_REQUEST', message: 'A JSON object request body is required.' }
      });
    }
    const unknownKey = Object.keys(body).find((key) => !allowed.has(key));
    const forbiddenKey = findCredentialKey(body, credentialKey);
    const nestedUnknown = findUnsupportedNestedKey(body, nestedKeys);
    if (unknownKey || nestedUnknown || forbiddenKey) {
      return res.status(400).json({
        success: false,
        status: 'error',
        error: {
          code: forbiddenKey ? 'CREDENTIAL_INPUT_NOT_ALLOWED' : 'INVALID_REQUEST',
          message: forbiddenKey
            ? 'Credentials must not be included in request data.'
            : 'The request contains an unsupported property.'
        }
      });
    }
    return next();
  };
}

function findCredentialKey(value, credentialKey) {
  if (!value || typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value)) {
    if (credentialKey.test(key) || findCredentialKey(child, credentialKey)) return true;
  }
  return false;
}

function findUnsupportedNestedKey(value, nestedKeys, parentKey = null) {
  if (Array.isArray(value)) {
    return value.some((item) => findUnsupportedNestedKey(item, nestedKeys, parentKey));
  }
  if (!value || typeof value !== 'object') return false;
  if (parentKey === null) {
    return Object.entries(value).some(([key, child]) => findUnsupportedNestedKey(child, nestedKeys, key));
  }
  const allowed = nestedKeys[parentKey];
  if (!allowed) return false;
  const allowedSet = new Set(allowed);
  for (const [key, child] of Object.entries(value)) {
    if (!allowedSet.has(key)) return true;
    if (findUnsupportedNestedKey(child, nestedKeys, key)) return true;
  }
  return false;
}

function requestTimeout(timeoutMs = env.requestTimeoutMs) {
  return function limitRequestDuration(req, res, next) {
    const timer = setTimeout(() => {
      if (res.headersSent || res.writableEnded) return;
      req.requestTimedOut = true;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.status(504).end(JSON.stringify({
        success: false,
        status: 'error',
        error: { code: 'REQUEST_TIMEOUT', message: 'The request could not be completed in time.' }
      }));
    }, timeoutMs);
    timer.unref?.();
    res.once('finish', () => clearTimeout(timer));
    res.once('close', () => clearTimeout(timer));
    next();
  };
}

module.exports = {
  createBotRateLimiters,
  selectCrmRateLimiter,
  createRateLimitStore,
  createRateLimiter,
  rejectUnsafeBotInput,
  requestTimeout
};
