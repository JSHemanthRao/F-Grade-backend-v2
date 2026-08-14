const { getModuleDefinition } = require('../services/module-definition.service');
const { resolveAlias } = require('../services/module-alias.service');

class CRMValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CRMValidationError';
    this.status = 400;
  }
}

function normalizeModuleKey(moduleKey) {
  if (!moduleKey) {
    return null;
  }

  return String(moduleKey).trim().toLowerCase();
}

function resolveRequestedModule(req) {
  // Read module from common locations (query, body, params, route path)
  const routePath = req?.route?.path;
  let rawModule = null;
  if (req?.query?.module) rawModule = req.query.module;
  else if (req?.body?.module) rawModule = req.body.module;
  else if (req?.params?.module) rawModule = req.params.module;
  else if (routePath && routePath !== '/') rawModule = routePath.replace(/^\//, '').replace(/\/$/, '');

  if (!rawModule) return null;

  // Normalize input and resolve common natural-language aliases first
  const aliasResolved = resolveAlias(rawModule);
  if (aliasResolved) return aliasResolved;

  // If no alias found, fall back to normalized module key
  return normalizeModuleKey(rawModule);
}

function validatePositiveInteger(value, name) {
  if (value === undefined || value === null || value === '') {
    return;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CRMValidationError(`${name} must be a positive integer.`);
  }
}

function normalizeArrayParameter(value, name) {
  if (value === undefined || value === null || value === '') {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => String(item).trim())
      .filter(Boolean);
  }

  throw new CRMValidationError(`${name} must be a comma-separated string or an array.`);
}

function validateFilters(value) {
  if (value === undefined || value === null || value === '') {
    return;
  }

  if (typeof value === 'string') {
    return;
  }

  if (typeof value === 'object') {
    return;
  }

  throw new CRMValidationError('filters must be a string or object.');
}

function validateOperation(value) {
  if (value === undefined || value === null || value === '') {
    return;
  }

  const operation = String(value).trim().toLowerCase();
  if (!['query', 'count'].includes(operation)) {
    throw new CRMValidationError('operation must be query or count.');
  }
}

function validateRetrievalMode(value, { countEndpoint = false } = {}) {
  if (value === undefined || value === null || value === '') {
    return;
  }

  const mode = String(value).trim().toLowerCase();
  const allowedModes = countEndpoint
    ? ['count']
    : ['auto', 'page', 'limited', 'filtered', 'all', 'count', 'aggregate'];

  if (!allowedModes.includes(mode)) {
    throw new CRMValidationError(`retrieval_mode must be one of: ${allowedModes.join(', ')}.`);
  }
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function validateCRMQueryRequest(req, res, next) {
  try {
    const moduleKey = resolveRequestedModule(req);

    if (!moduleKey) {
      throw new CRMValidationError('CRM module is required. Use query parameter module or a module-specific path.');
    }

    const moduleDefinition = getModuleDefinition(moduleKey);

    if (!moduleDefinition) {
      if (['activities', 'activity'].includes(moduleKey)) {
        throw new CRMValidationError(
          `Unsupported CRM module: ${moduleKey}. 'Activities' is not a queryable CRM table. For today's activity and employee action reports, use GET /api/crm/activity.`
        );
      }
      throw new CRMValidationError(`Unsupported CRM module: ${moduleKey}`);
    }

    validatePositiveInteger(req.query?.page ?? req.body?.page, 'page');
    validatePositiveInteger(req.query?.per_page ?? req.body?.per_page, 'per_page');
    validatePositiveInteger(req.query?.limit ?? req.body?.limit, 'limit');
    normalizeArrayParameter(req.query?.ids ?? req.body?.ids, 'ids');
    normalizeArrayParameter(req.query?.fields ?? req.body?.fields, 'fields');
    validateFilters(req.query?.filter ?? req.query?.filters ?? req.body?.filter ?? req.body?.filters);
    validateOperation(req.query?.operation ?? req.body?.operation);
    validateRetrievalMode(req.query?.retrieval_mode ?? req.query?.retrievalMode ?? req.body?.retrieval_mode ?? req.body?.retrievalMode);

    return next();
  } catch (error) {
    return next(error);
  }
}

function validateCRMCountRequest(req, res, next) {
  try {
    const moduleKey = resolveRequestedModule(req);

    if (!moduleKey) {
      throw new CRMValidationError('CRM module is required. Use query parameter module or a module-specific path.');
    }

    const moduleDefinition = getModuleDefinition(moduleKey);

    if (!moduleDefinition) {
      if (['activities', 'activity'].includes(moduleKey)) {
        throw new CRMValidationError(
          `Unsupported CRM module: ${moduleKey}. 'Activities' is not a queryable CRM table. For today's activity and employee action reports, use GET /api/crm/activity.`
        );
      }
      throw new CRMValidationError(`Unsupported CRM module: ${moduleKey}`);
    }

    if (hasValue(req.query?.page ?? req.body?.page) || hasValue(req.query?.per_page ?? req.body?.per_page)) {
      throw new CRMValidationError('count endpoint does not accept page or per_page.');
    }

    validateOperation(req.query?.operation ?? req.body?.operation);
    validateRetrievalMode(
      req.query?.retrieval_mode ?? req.query?.retrievalMode ?? req.body?.retrieval_mode ?? req.body?.retrievalMode,
      { countEndpoint: true }
    );
    validateFilters(req.query?.filter ?? req.query?.filters ?? req.body?.filter ?? req.body?.filters);

    return next();
  } catch (error) {
    return next(error);
  }
}

function validateCRMActivityRequest(req, res, next) {
  try {
    const requestSource = req.method === 'POST' ? req.body : req.query;
    validatePositiveInteger(requestSource?.limit, 'limit');

    if (requestSource?.from && Number.isNaN(new Date(requestSource.from).valueOf())) {
      throw new CRMValidationError('from must be a valid date or ISO datetime string.');
    }

    if (requestSource?.to && Number.isNaN(new Date(requestSource.to).valueOf())) {
      throw new CRMValidationError('to must be a valid date or ISO datetime string.');
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

function validateCRMDashboardRequest(req, res, next) {
  try {
    const requestSource = req.method === 'POST' ? req.body : req.query;

    const from = requestSource?.from || requestSource?.dateRange?.from || requestSource?.date_from;
    const to = requestSource?.to || requestSource?.dateRange?.to || requestSource?.date_to;

    if (from && Number.isNaN(new Date(from).valueOf())) {
      throw new CRMValidationError('from must be a valid date or ISO datetime string.');
    }

    if (to && Number.isNaN(new Date(to).valueOf())) {
      throw new CRMValidationError('to must be a valid date or ISO datetime string.');
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  CRMValidationError,
  resolveRequestedModule,
  validateCRMActivityRequest,
  validateCRMCountRequest,
  validateCRMDashboardRequest,
  validateCRMQueryRequest,
};


