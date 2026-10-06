const express = require('express');
const cors = require('cors');
const createCrmRoutes = require('./routes/crm.routes');
const healthRoutes = require('./routes/health.routes');
const createSkillsRoutes = require('./routes/skills.routes');
const { errorHandler } = require('./middleware/errorHandler');
const { requestLogger } = require('./middleware/requestLogger');
const { apiKeyAuth } = require('./middleware/apiKeyAuth');
const { createBotRateLimiters } = require('./middleware/botProtection');
const { env } = require('./config/env');
const { createCrmDiagnostics } = require('./utils/crmDiagnostics');

function createApp({ crmService, rateLimiters, requestTimeoutMs } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.trustProxyHops);
  app.use(cors({ origin: env.corsOrigin }));
  app.use(requestLogger);
  app.use((req, _res, next) => {
    if (req.path === '/api/crm/assistant') req.crmDiagnostics = createCrmDiagnostics();
    next();
  });
  app.use(express.json({ limit: env.requestBodyLimit }));

  app.use('/health', healthRoutes);
  app.use('/api/skills', apiKeyAuth, createSkillsRoutes());
  app.use('/api/crm', createCrmRoutes(crmService, {
    apiKeyAuth,
    rateLimiters: rateLimiters || createBotRateLimiters(),
    requestTimeoutMs
  }));
  app.use((req, res) => {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found.' } });
  });
  app.use(errorHandler);
  return app;
}

module.exports = createApp();
module.exports.createApp = createApp;
