const express = require('express');
const cors = require('cors');
const createCrmRoutes = require('./routes/crm.routes');
const healthRoutes = require('./routes/health.routes');
const { errorHandler } = require('./middleware/errorHandler');
const { requestLogger } = require('./middleware/requestLogger');
const { env } = require('./config/env');

function createApp({ crmService } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: env.corsOrigin }));
  app.use(requestLogger);
  app.use(express.json({ limit: env.requestBodyLimit }));

  app.use('/health', healthRoutes);
  app.use('/api/crm', createCrmRoutes(crmService));
  app.use((req, res) => {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found.' } });
  });
  app.use(errorHandler);
  return app;
}

module.exports = createApp();
module.exports.createApp = createApp;
