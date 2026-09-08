const axios = require('axios');
const { env } = require('../config/env');
const { resolveProductDomain } = require('../validators/booksQuery.validator');
const { relativePeriodFromText, resolveRelativePeriod } = require('../utils/relativeDate');

const MAX_QUESTION_LENGTH = 2000;

class BackendClient {
  constructor(httpClient = axios, config = env) {
    this.httpClient = httpClient;
    this.config = config;
  }

  getEndpoint(question) {
    const baseUrl = this.config.backendApiUrl || 'http://localhost:3000';
    const requestPath = resolveProductDomain(question) === 'books'
      ? (this.config.booksApiPath || '/api/books/query')
      : (this.config.backendApiPath || '/api/crm/assistant');
    const base = new URL(baseUrl);
    const normalizedPath = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
    const basePath = base.pathname.replace(/\/$/, '');

    if (!basePath || basePath === '/') {
      base.pathname = normalizedPath;
    } else if (normalizedPath === basePath || normalizedPath.startsWith(`${basePath}/`)) {
      base.pathname = normalizedPath;
    } else {
      base.pathname = `${basePath}${normalizedPath}`;
    }

    base.search = '';
    base.hash = '';
    return base.toString().replace(/\/$/, '');
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
    if (question.length > MAX_QUESTION_LENGTH) {
      const error = new Error(`Question must not exceed ${MAX_QUESTION_LENGTH} characters.`);
      error.code = 'QUESTION_TOO_LONG';
      error.statusCode = 400;
      throw error;
    }

    const booksRequest = resolveProductDomain(question) === 'books' ? buildBooksQuotesRequest(question) : null;
    const endpoint = this.getEndpoint(question);
    const startedAt = Date.now();
    this.logDiagnostic('request', { method: 'POST', endpoint });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.backendRequestTimeoutMs || 15000);

    try {
      const response = await this.httpClient.post(endpoint, booksRequest || { question }, {
        headers: this.buildHeaders(),
        signal: controller.signal,
        timeout: this.config.backendRequestTimeoutMs || 15000
      });

      this.logDiagnostic('response', { method: 'POST', endpoint, status: response.status, durationMs: Date.now() - startedAt });
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
        this.logDiagnostic('response', { method: 'POST', endpoint, status, durationMs: Date.now() - startedAt });
        const enriched = new Error(message || 'The CRM backend returned an error.');
        enriched.code = `BACKEND_HTTP_${status}`;
        enriched.statusCode = status;
        if (status === 404) {
          enriched.code = 'BACKEND_ENDPOINT_NOT_FOUND';
          enriched.message = `Backend endpoint not found: ${new URL(endpoint).pathname}`;
        }
        throw enriched;
      }

      if (error.request) {
        this.logDiagnostic('network_error', { method: 'POST', endpoint, durationMs: Date.now() - startedAt });
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

  logDiagnostic(event, details) {
    if (!this.config.backendDiagnostics) return;
    console.error(`[BACKEND_CLIENT] ${event}`, JSON.stringify(details));
  }
}

function buildBooksQuotesRequest(question) {
  const lower = String(question).toLowerCase();
  const request = { module: 'Quotes', request_type: /\b(?:count|how many)\b/.test(lower) ? 'count' : 'records', fields: ['id', 'estimate_number', 'customer_name', 'status', 'total', 'date', 'expiry_date'], limit: extractLimit(lower), offset: 0, filters: [] };
  const period = relativePeriodFromText(lower);
  if (period) {
    const range = resolveRelativePeriod(period);
    request.filters.push({ field: 'date', operator: 'between', value: [range.start, range.end], exclusive_end: true });
  }
  const status = lower.match(/\b(?:status\s+is|status|quotes?\s+that\s+are)\s+(approved|accepted|pending|draft|declined|sent)\b/);
  if (status) request.filters.push({ field: 'status', operator: 'equals', value: status[1] });
  const amount = lower.match(/\b(?:above|over|greater than)\s+([0-9][0-9,]*(?:\.\d+)?)/);
  if (amount) request.filters.push({ field: 'total', operator: 'greater_than', value: Number(amount[1].replace(/,/g, '')) });
  if (/\b(?:latest|newest|recent|sorted by created|sorted by date)\b/.test(lower)) request.sort = { field: 'date', order: 'desc' };
  return request;
}

function extractLimit(text) {
  const match = String(text).match(/\b(?:show|give me|list)\s+(\d+)\b/);
  return Math.min(Math.max(match ? Number(match[1]) : 20, 1), 200);
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

module.exports = { BackendClient, buildBooksQuotesRequest };
