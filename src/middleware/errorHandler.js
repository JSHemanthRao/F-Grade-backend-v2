const { log } = require('../utils/logger');

function errorHandler(error, req, res, _next) {
  const isJsonSyntaxError = error instanceof SyntaxError && error.status === 400 && error.type === 'entity.parse.failed';
  const statusCode = isJsonSyntaxError ? 400 : (Number.isInteger(error.statusCode) ? error.statusCode : 500);
  const code = isJsonSyntaxError ? 'INVALID_JSON' : (error.code || 'INTERNAL_SERVER_ERROR');
  if (statusCode >= 500) log('error', `[${code}] ${req.method} ${req.originalUrl}`);
  else log('warn', `[${code}] ${req.method} ${req.originalUrl}: ${error.message}`);
  const details = error.details || (error.response ? { upstream: error.response.data || null } : undefined);
  res.status(statusCode).json({
    success: false,
    status: 'error',
    error: {
      code,
      message: statusCode >= 500 ? 'The CRM request could not be completed.' : error.message,
      ...(details ? { details } : {})
    }
  });
}

module.exports = { errorHandler };
