const { randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { log } = require('./logger');

const diagnosticsStorage = new AsyncLocalStorage();

function createRequestId() {
  const now = new Date();
  const stamp = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0')
  ].join('') + '_' + [
    String(now.getUTCHours()).padStart(2, '0'),
    String(now.getUTCMinutes()).padStart(2, '0'),
    String(now.getUTCSeconds()).padStart(2, '0')
  ].join('');
  return `crm_${stamp}_${randomUUID().replace(/-/g, '').slice(0, 6)}`;
}

function createCrmDiagnostics(requestId = createRequestId()) {
  return {
    request_id: requestId,
    question: 'not_reached',
    resolved_module: 'not_reached',
    module_api_name: 'not_reached',
    resolved_fields: [],
    resolved_filters: [],
    request_type: 'not_reached',
    zoho_endpoint: 'not_reached',
      zoho_http_status: null,
    zoho_error_code: 'not_reached',
    zoho_error_message: 'not_reached',
    stage: 'request_received'
  };
}

function recordCrmEvent(event, diagnostics, details = {}) {
  log('info', JSON.stringify({ event, request_id: diagnostics?.request_id || 'not_reached', ...details }));
}

function runWithCrmDiagnostics(diagnostics, callback) {
  return diagnosticsStorage.run(diagnostics, callback);
}

function getCurrentCrmDiagnostics() {
  return diagnosticsStorage.getStore();
}

function updateDiagnostics(diagnostics, updates = {}) {
  if (!diagnostics) return diagnostics;
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    // Ensure zoho_http_status is numeric or null to avoid type issues downstream
    if (key === 'zoho_http_status') {
      const n = Number(value);
      diagnostics[key] = Number.isFinite(n) ? n : null;
      continue;
    }
    diagnostics[key] = value;
  }
  return diagnostics;
}

function diagnosticsFromError(error, diagnostics) {
  const details = error?.details || {};
  const upstream = error?.zohoDiagnostics || {};
  updateDiagnostics(diagnostics, {
    zoho_endpoint: upstream.endpoint || details.endpoint,
    zoho_http_status: upstream.status || details.upstream_status,
    zoho_error_code: upstream.code || details.upstream_code,
    zoho_error_message: upstream.message || details.upstream_message
  });
  return diagnostics;
}

function publicCrmDiagnostics(diagnostics, debugEnabled = false) {
  if (!diagnostics) return diagnostics;
  const safe = { ...diagnostics };
  if (!debugEnabled) delete safe.stage;
  return safe;
}

module.exports = { createRequestId, createCrmDiagnostics, recordCrmEvent, runWithCrmDiagnostics, getCurrentCrmDiagnostics, updateDiagnostics, diagnosticsFromError, publicCrmDiagnostics };