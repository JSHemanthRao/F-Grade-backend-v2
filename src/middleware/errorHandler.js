const { log, redactSensitiveLogData } = require('../utils/logger');
const { createCrmDiagnostics, diagnosticsFromError, publicCrmDiagnostics } = require('../utils/crmDiagnostics');
const { env } = require('../config/env');
const { setHttp503Source } = require('../utils/http503Diagnostics');

function errorHandler(error, req, res, _next) {
  if (res.headersSent || res.writableEnded) return;
  const isJsonSyntaxError = error instanceof SyntaxError && error.status === 400 && error.type === 'entity.parse.failed';
  const entityTooLarge = error?.type === 'entity.too.large' || error?.status === 413;
  const statusCode = isJsonSyntaxError ? 400 : entityTooLarge ? 413 : (Number.isInteger(error.statusCode) ? error.statusCode : 500);
  const code = isJsonSyntaxError ? 'INVALID_JSON' : entityTooLarge ? 'REQUEST_TOO_LARGE' : (error.code || 'INTERNAL_SERVER_ERROR');
  if (statusCode === 503) setHttp503Source(classify503Source(error));
  const diagnostics = req.crmDiagnostics || error.crmDiagnostics || (req.originalUrl === '/api/crm/assistant' ? createCrmDiagnostics() : null);
  if (diagnostics) {
    diagnosticsFromError(error, diagnostics);
    diagnostics.stage = 'request_failed';
    log('error', JSON.stringify({ event: 'REQUEST_FAILED', request_id: diagnostics.request_id, stage: diagnostics.stage, error_code: code, zoho_http_status: diagnostics.zoho_http_status, zoho_error_code: diagnostics.zoho_error_code }));
  } else if (statusCode >= 500) log('error', `[${code}] ${req.method} ${req.path}`);
  else log('warn', `[${code}] ${req.method} ${req.path}: ${error.message}`);
  const details = sanitizePublicErrorDetails(error.details);
  res.status(statusCode).json({
    success: false,
    status: 'error',
    error: {
      code,
      message: isJsonSyntaxError
        ? 'The request body is not valid JSON.'
        : entityTooLarge
          ? 'The request body is too large.'
          : error.response
        ? 'The upstream service could not complete the request.'
        : redactSensitiveLogData(error.message || 'The CRM request could not be completed.'),
      ...(details ? { details } : {})
    },
    ...(diagnostics ? { request_id: diagnostics.request_id, diagnostics: publicCrmDiagnostics(diagnostics, env.crmDebug) } : {})
  });
}

function classify503Source(error) {
  if (error.code === 'CRM_CIRCUIT_OPEN') return 'crm_circuit_breaker';
  if (error.code === 'CRM_QUERY_BUDGET_EXCEEDED') return 'crm_query_budget';
  if (error.zohoDiagnostics?.status === 503 || error.details?.upstream_status === 503 || error.response?.status === 503) {
    return 'zoho_upstream';
  }
  return 'application_error';
}

function sanitizePublicErrorDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;
  const publicKeys = new Set([
    'operation',
    'module',
    'requested_module',
    'field',
    'fields',
    'requested_domain',
    'supported_domain',
    'upstream_status',
    'upstream_code',
    'job_id',
    'blocking_job_id',
    'status',
    'response_top_level_keys',
    'audit_log_export_count',
    'selected_job_keys',
    'has_download_links',
    'download_links_type',
    'download_links_count',
    'discovered_artifact_paths',
    'errors'
  ]);
  const sanitized = {};
  for (const [key, value] of Object.entries(details)) {
    if (!publicKeys.has(key)) continue;
    if (key === 'errors' && Array.isArray(value)) {
      sanitized.errors = value.map((item) => ({
        ...(typeof item?.path === 'string' ? { path: item.path } : {}),
        ...(typeof item?.code === 'string' ? { code: item.code } : {}),
        ...(typeof item?.message === 'string' ? { message: redactSensitiveLogData(item.message) } : {})
      }));
      continue;
    }
    if (Array.isArray(value)) {
      sanitized[key] = value.map((item) => typeof item === 'string' ? redactSensitiveLogData(item) : item);
    } else if (typeof value === 'string') {
      sanitized[key] = redactSensitiveLogData(value);
    } else {
      sanitized[key] = value;
    }
  }
  return Object.keys(sanitized).length ? sanitized : undefined;
}

module.exports = { errorHandler, classify503Source };
