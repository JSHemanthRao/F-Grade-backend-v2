function log(level, message) {
  const safeMessage = redactSensitiveLogData(message);
  if (level === 'error') console.error(safeMessage);
  else if (level === 'warn') console.warn(safeMessage);
  else if (process.env.NODE_ENV !== 'test') console.log(safeMessage);
}

function logRequest(req, res, elapsedMs) {
  log('info', `[${res.statusCode}] ${req.method} ${req.path} ${elapsedMs.toFixed(1)}ms`);
}

function redactSensitiveLogData(value) {
  return String(value)
    .replace(/(authorization)(["']?\s*[:=]\s*["']?)([^,}\r\n]+)/gi, '$1$2[REDACTED]')
    .replace(/(x-api-key|access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|password)(["']?\s*[:=]\s*["']?)([^"'&,\s}]+)/gi, '$1$2[REDACTED]')
    .replace(/Zoho-oauthtoken\s+[^\s"'<>]+/gi, 'Zoho-oauthtoken [REDACTED]')
    .replace(/https?:\/\/[^\s"'<>?]+(?:\?[^\s"'<>]*)?/gi, (url) => (
      url.includes('?') ? `${url.slice(0, url.indexOf('?'))}?[REDACTED]` : url
    ));
}

module.exports = { log, logRequest, redactSensitiveLogData };
