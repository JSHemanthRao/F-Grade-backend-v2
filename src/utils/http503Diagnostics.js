const { randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { log } = require('./logger');

const diagnosticsStorage = new AsyncLocalStorage();

function http503Diagnostics(req, res, next) {
  const context = {
    requestId: req.crmDiagnostics?.request_id || randomUUID(),
    source: null,
    route: safeRoute(req),
    method: req.method,
    zohoRequestStarted: false,
    zohoStatus: null
  };
  req.http503Diagnostics = context;
  res.once('finish', () => {
    if (res.statusCode !== 503) return;
    log('error', `[HTTP_503_SOURCE] ${JSON.stringify({
      source: context.source || 'unclassified_application_503',
      route: context.route,
      method: context.method,
      zohoRequestStarted: context.zohoRequestStarted,
      zohoStatus: context.zohoStatus,
      requestId: context.requestId
    })}`);
  });
  diagnosticsStorage.run(context, next);
}

function markZohoRequestStarted() {
  const context = diagnosticsStorage.getStore();
  if (context) context.zohoRequestStarted = true;
}

function recordZohoStatus(status) {
  const context = diagnosticsStorage.getStore();
  if (context && Number.isInteger(Number(status))) context.zohoStatus = Number(status);
}

function setHttp503Source(source) {
  const context = diagnosticsStorage.getStore();
  if (context) context.source = source;
}

function safeRoute(req) {
  const pathname = String(req.originalUrl || req.path || '').split('?')[0];
  const knownRoutes = new Set([
    '/api/crm/assistant',
    '/api/crm/audit-log',
    '/api/crm/query',
    '/api/crm/diagnostics',
    '/api/crm/assistant/fast-summary',
    '/api/crm/audit-log/assistant',
    '/api/crm/metadata',
    '/api/crm/metadata/refresh',
    '/api/skills',
    '/health',
    '/health/'
  ]);
  return knownRoutes.has(pathname) ? pathname : '/other';
}

module.exports = {
  http503Diagnostics,
  markZohoRequestStarted,
  recordZohoStatus,
  setHttp503Source
};
