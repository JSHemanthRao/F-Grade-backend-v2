const app = require('./app');
const { env } = require('./config/env');

const server = app.listen(env.port, '0.0.0.0', () => {
  console.log(`CRM backend listening on 0.0.0.0:${env.port}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}; shutting down.`);
  server.close(() => process.exit(0));
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
