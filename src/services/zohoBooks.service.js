const axios = require('axios');
const { getZohoBooksConfig } = require('../config/books.config');
const { createAppError } = require('../utils/errors');
const { log } = require('../utils/logger');
const { BooksMetadataService } = require('./booksMetadata.service');

class ZohoBooksService {
  constructor(httpClient = axios, configLoader = getZohoBooksConfig, metadataService = new BooksMetadataService()) {
    this.httpClient = httpClient;
    this.configLoader = configLoader;
    this.metadataService = metadataService;
    this.accessToken = null;
    this.apiDomain = null;
    this.expiresAt = 0;
    this.tokenRequest = null;
  }

  async getAccessToken() {
    const config = this.configLoader();
    if (this.accessToken && Date.now() < this.expiresAt - 300000) return this.accessToken;
    if (!this.tokenRequest) this.tokenRequest = this.refreshAccessToken(config);
    try { return await this.tokenRequest; } finally { this.tokenRequest = null; }
  }

  clearToken() {
    this.accessToken = null;
    this.apiDomain = null;
    this.expiresAt = 0;
  }

  async refreshAccessToken(config) {
    try {
      const response = await this.httpClient.post(`${config.accountsUrl}/oauth/v2/token`, null, {
        params: {
          refresh_token: config.refreshToken,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          grant_type: 'refresh_token'
        },
        timeout: config.timeoutMs
      });
      const payload = response.data || {};
      if (!payload.access_token) throw new Error('Zoho Books did not return an access token.');
      this.accessToken = payload.access_token;
      this.apiDomain = payload.api_domain || null;
      this.expiresAt = Date.now() + Number(payload.expires_in || 3600) * 1000;
      return this.accessToken;
    } catch (_error) {
      this.clearToken();
      const error = new Error('Unable to authenticate with Zoho Books.');
      error.code = 'BOOKS_AUTHENTICATION_ERROR';
      error.statusCode = 502;
      throw error;
    }
  }

  async resolveModuleApiName(moduleName) {
    return this.metadataService.resolveModuleApiName(moduleName);
  }

  async getFieldMetadata(moduleName) {
    return this.metadataService.getFieldMetadata(moduleName);
  }

  async query(request) {
    const config = this.configLoader();
    const token = await this.getAccessToken();
    const moduleApiName = request.module_api_name || await this.resolveModuleApiName(request.module);
    const fields = Array.isArray(request.fields) && request.fields.length > 0 ? request.fields.join(',') : undefined;
    const baseUrl = (this.apiDomain || config.apiBaseUrl || 'https://www.zohoapis.com/books/v3').replace(/\/$/, '');
    const params = {
      organization_id: config.organizationId,
      page: Math.max(1, request.offset ? Math.floor(request.offset / Math.max(1, request.limit || 20)) + 1 : 1),
      per_page: request.limit || 20
    };
    if (fields) params.fields = fields;
    if (Array.isArray(request.filters) && request.filters.length > 0) {
      params.search = request.filters.map((filter) => `${filter.field}:${filter.operator}:${Array.isArray(filter.value) ? filter.value.join(',') : filter.value}`).join('|');
    }
    const response = await this.httpClient.get(`${baseUrl}/${moduleApiName}`, {
      params,
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      timeout: config.timeoutMs
    });
    const records = Array.isArray(response.data?.data) ? response.data.data : [];
    return { records, info: response.data?.info || { more_records: false }, module_api_name: moduleApiName };
  }

  async getModuleHistory(moduleName, params = {}) {
    const config = this.configLoader();
    const token = await this.getAccessToken();
    const apiName = requestModuleApiName(moduleName);
    const baseUrl = (this.apiDomain || config.apiBaseUrl || 'https://www.zohoapis.com/books/v3').replace(/\/$/, '');
    const requestParams = { ...params, organization_id: config.organizationId };
    const response = await this.httpClient.get(`${baseUrl}/${apiName}/comments`, {
      params: requestParams,
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      timeout: config.timeoutMs
    });
    return { records: Array.isArray(response.data?.data) ? response.data.data : [], info: response.data?.info || { total_count: 0 } };
  }
}

function requestModuleApiName(moduleName) {
  const mapping = {
    invoices: 'invoices',
    bills: 'bills',
    estimates: 'estimates',
    salesorders: 'salesorders',
    purchaseorders: 'purchaseorders',
    vendorcredits: 'vendorcredits',
    creditnotes: 'creditnotes'
  };
  return mapping[String(moduleName || '').toLowerCase()] || String(moduleName || '').trim() || 'invoices';
}

module.exports = { ZohoBooksService };
