class CRMError extends Error {
  constructor(message, { code = 'CRM_API_ERROR', status = null, cause = null, module = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CRMError';
    this.code = code;
    this.status = status;
    this.module = module;
    this.cause = cause;
  }
}

function toCRMError(error, module = null) {
  if (error?.name === 'CRMError') return error;

  const status = error?.response?.status ?? error?.status ?? null;
  const providerCode = error?.response?.data?.code;
  const isAuthError = status === 401 || status === 403
    || ['INVALID_TOKEN', 'OAUTH_SCOPE_MISMATCH'].includes(providerCode);

  return new CRMError(error?.message || 'Zoho CRM request failed', {
    code: isAuthError ? 'CRM_AUTH_ERROR' : 'CRM_API_ERROR',
    status,
    cause: error,
    module,
  });
}

module.exports = { CRMError, toCRMError };