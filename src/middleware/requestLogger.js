const { logRequest } = require('../utils/logger');

function requestLogger(req, res, next) {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logRequest(req, res, elapsedMs);
  });
  next();
}

module.exports = { requestLogger };
