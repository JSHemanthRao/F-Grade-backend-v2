const app = require('./app');
const { env } = require('./config/env');

const server = app.listen(env.port, '0.0.0.0', () => {
  console.log(`CRM backend listening on 0.0.0.0:${env.port}`);
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`Port ${env.port} is already in use. Another process is listening on this port.`);
    console.error('If you previously started the server, stop that process or choose a different PORT in your .env.');
    process.exit(1);
  }
  console.error('Server error:', err);
  process.exit(1);
});

function shutdown(signal) {
  console.log(`Received ${signal}; shutting down.`);
  server.close(() => process.exit(0));
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
