const { log } = require('../utils/logger');
const { createCrmDiagnostics, diagnosticsFromError, publicCrmDiagnostics } = require('../utils/crmDiagnostics');
const { env } = require('../config/env');

function errorHandler(error, req, res, _next) {
  const isJsonSyntaxError = error instanceof SyntaxError && error.status === 400 && error.type === 'entity.parse.failed';
  const statusCode = isJsonSyntaxError ? 400 : (Number.isInteger(error.statusCode) ? error.statusCode : 500);
  const code = isJsonSyntaxError ? 'INVALID_JSON' : (error.code || 'INTERNAL_SERVER_ERROR');
  const diagnostics = req.crmDiagnostics || error.crmDiagnostics || (req.originalUrl === '/api/crm/assistant' ? createCrmDiagnostics() : null);
  if (diagnostics) {
    diagnosticsFromError(error, diagnostics);
    diagnostics.stage = 'request_failed';
    log('error', JSON.stringify({ event: 'REQUEST_FAILED', request_id: diagnostics.request_id, stage: diagnostics.stage, error_code: code, zoho_http_status: diagnostics.zoho_http_status, zoho_error_code: diagnostics.zoho_error_code }));
  } else if (statusCode >= 500) log('error', `[${code}] ${req.method} ${req.originalUrl}`);
  else log('warn', `[${code}] ${req.method} ${req.originalUrl}: ${error.message}`);
  const details = error.details || (error.response ? { upstream: error.response.data || null } : undefined);
  res.status(statusCode).json({
    success: false,
    status: 'error',
    error: {
      code,
      message: statusCode >= 500 ? (error.message || 'The CRM request could not be completed.') : error.message,
      ...(details ? { details } : {})
    },
    ...(diagnostics ? { request_id: diagnostics.request_id, diagnostics: publicCrmDiagnostics(diagnostics, env.crmDebug) } : {})
  });
}

module.exports = { errorHandler };
