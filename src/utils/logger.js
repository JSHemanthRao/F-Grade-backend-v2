function log(level, message) {
  const safeMessage = redactSensitiveLogData(message);
  if (level === 'error') console.error(safeMessage);
  else if (level === 'warn') console.warn(safeMessage);
  else if (process.env.NODE_ENV !== 'test') console.log(safeMessage);
}

function logRequest(req, res, elapsedMs) {
  log('info', `[${res.statusCode}] ${req.method} ${req.originalUrl} ${elapsedMs.toFixed(1)}ms`);
}

function redactSensitiveLogData(value) {
  return String(value)
    .replace(/(authorization\s*[:=]\s*)([^,\s}]+)/gi, '$1[REDACTED]')
    .replace(/(access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|password)\s*[:=]\s*([^,\s}]+)/gi, '$1=[REDACTED]')
    .replace(/Zoho-oauthtoken\s+[^\s]+/gi, 'Zoho-oauthtoken [REDACTED]');
}

module.exports = { log, logRequest };
