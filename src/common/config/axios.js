const axios = require('axios');
const http = require('http');
const https = require('https');
const {
  ZOHO_API_DOMAIN,
  ZOHO_API_TIMEOUT_MS,
} = require('./env');
const { getAuthorizationHeader } = require('../auth/auth.service');
const logger = require('../logging/logger');

const keepAliveOptions = {
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
};

const httpAgent = new http.Agent(keepAliveOptions);
const httpsAgent = new https.Agent(keepAliveOptions);

function logRequestDuration(config, status, errorCode) {
  if (!config?.metadata?.startedAt) return;
  const durationMs = Number(process.hrtime.bigint() - config.metadata.startedAt) / 1e6;
  logger.info('CRM HTTP', {
    method: String(config.method || 'get').toUpperCase(),
    url: config.url,
    status: status ?? null,
    errorCode: errorCode || null,
    durationMs: Number(durationMs.toFixed(2)),
  });
}

const zohoClient = axios.create({
  baseURL: ZOHO_API_DOMAIN,
  timeout: ZOHO_API_TIMEOUT_MS,
  httpAgent,
  httpsAgent,
});

zohoClient.interceptors.request.use(async (config) => {
  config.metadata = { startedAt: process.hrtime.bigint() };
  const authorizationHeader = await getAuthorizationHeader({ signal: config.signal });

  config.headers = {
    ...(config.headers || {}),
    Authorization: authorizationHeader,
  };

  return config;
});

zohoClient.interceptors.response.use(
  (response) => {
    logRequestDuration(response.config, response.status);
    return response;
  },
  (error) => {
    logRequestDuration(error.config, error.response?.status, error.code);
    return Promise.reject(error);
  },
);

module.exports = {
  zohoClient,
};
