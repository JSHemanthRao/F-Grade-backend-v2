function log(level, message) {
  if (level === 'error') console.error(message);
  else if (level === 'warn') console.warn(message);
  else if (process.env.NODE_ENV !== 'test') console.log(message);
}

function logRequest(req, res, elapsedMs) {
  log('info', `[${res.statusCode}] ${req.method} ${req.originalUrl} ${elapsedMs.toFixed(1)}ms`);
}

module.exports = { log, logRequest };
