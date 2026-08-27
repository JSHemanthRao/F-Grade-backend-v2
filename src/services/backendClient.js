const axios = require('axios');
const { env } = require('../config/env');

class BackendClient {
  constructor(httpClient = axios, config = env) {
    this.httpClient = httpClient;
    this.config = config;
  }

  getBaseUrl() {
    const url = this.config.backendApiUrl || 'http://localhost:3000';
    return url.replace(/\/$/, '');
  }

  getRequestPath() {
    const path = this.config.backendApiPath || '/api/crm/assistant';
    return path.startsWith('/') ? path : `/${path}`;
  }

  buildHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (this.config.backendApiKey) {
      headers.Authorization = `Bearer ${this.config.backendApiKey}`;
      headers['x-api-key'] = this.config.backendApiKey;
    }
    return headers;
  }

  async ask(question) {
    if (typeof question !== 'string' || question.trim().length === 0) {
      const error = new Error('Question must be a non-empty string.');
      error.code = 'INVALID_QUESTION';
      error.statusCode = 400;
      throw error;
    }

    const endpoint = `${this.getBaseUrl()}${this.getRequestPath()}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.backendRequestTimeoutMs || 15000);

    try {
      const response = await this.httpClient.post(endpoint, { question: question.trim() }, {
        headers: this.buildHeaders(),
        signal: controller.signal,
        timeout: this.config.backendRequestTimeoutMs || 15000
      });

      return response.data;
    } catch (error) {
      if (error.code === 'ECONNABORTED' || error.name === 'AbortError') {
        const timeoutError = new Error('The CRM backend timed out while processing the request.');
        timeoutError.code = 'BACKEND_TIMEOUT';
        timeoutError.statusCode = 504;
        throw timeoutError;
      }

      if (error.response) {
        const status = error.response.status;
        const message = extractBackendErrorMessage(error.response.data);
        const enriched = new Error(message || 'The CRM backend returned an error.');
        enriched.code = `BACKEND_HTTP_${status}`;
        enriched.statusCode = status;
        throw enriched;
      }

      if (error.request) {
        const networkError = new Error('The CRM backend could not be reached.');
        networkError.code = 'BACKEND_UNAVAILABLE';
        networkError.statusCode = 503;
        throw networkError;
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function extractBackendErrorMessage(payload) {
  if (!payload) return 'The CRM backend returned an error.';
  if (typeof payload === 'string') return payload;
  if (typeof payload.message === 'string') return payload.message;
  if (typeof payload.error === 'string') return payload.error;
  if (payload.error && typeof payload.error.message === 'string') return payload.error.message;
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    return payload.errors.map((item) => item?.message || item).join('; ');
  }
  return JSON.stringify(payload);
}

module.exports = { BackendClient };
