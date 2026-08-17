const { resolveRequestedModule } = require('../validators/crm.validator');
const logger = require('../../common/logging/logger');

function stringifyMessage(message) {
  if (typeof message === 'string') {
    return message;
  }

  if (message && typeof message === 'object') {
    try {
      return JSON.stringify(message);
    } catch {
      return String(message);
    }
  }

  return String(message);
}

/**
 * Distinguish between success + zero data vs actual API failure
 * per spec rule 17: SUCCESS + ZERO DATA → valid result if CRM successfully returned zero matches
 * CRM/API FAILURE → success = false with real error information
 */
function crmErrorHandler(err, req, res, next) {
  const httpStatus = err?.status || err?.response?.status || 500;
  const moduleKey = resolveRequestedModule(req);
  
  // Build error payload with raw Zoho error visibility
  const payload = {
    success: false,
    module: moduleKey || 'unknown',
    httpStatus,
    error: stringifyMessage(err?.response?.data?.message || err?.message || 'Internal server error'),
  };

  // Include additional error context for debugging
  if (err?.response?.data?.code) {
    payload.errorCode = err.response.data.code;
  }

  if (err?.response?.data?.errors && Array.isArray(err.response.data.errors)) {
    payload.errors = err.response.data.errors.map((e) => ({
      code: e.code,
      message: e.message,
      field: e.field,
    }));
  }

  if (err?.invalidFields) {
    payload.invalidFields = err.invalidFields;
  }

  // Include sanitized request info for non-production debugging
  if (process.env.NODE_ENV !== 'production') {
    payload.debugInfo = {
      endpoint: req.originalUrl || req.url,
      method: req.method,
      zohoResponse: err?.response?.data || null,
      criteria: req.query?.criteria || req.body?.criteria,
    };
  }

  // Log raw error with full context
  logger.error('CRM Error Handler', {
    endpoint: req.originalUrl || req.url,
    method: req.method,
    module: moduleKey || 'unknown',
    httpStatus,
    errorMessage: payload.error,
    errorCode: payload.errorCode,
    zohoCriteria: req.query?.criteria || req.body?.criteria,
    zohoErrorDetails: err?.response?.data,
  });

  res.status(httpStatus).json(payload);
}

module.exports = {
  crmErrorHandler,
};
