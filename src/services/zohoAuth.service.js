const axios = require('axios');
const { getZohoConfig } = require('../config/zoho.config');

const EXPIRY_BUFFER_MS = 300000;

class ZohoAuthService {
  constructor(httpClient = axios, configLoader = getZohoConfig) {
    this.httpClient = httpClient;
    this.configLoader = configLoader;
    this.accessToken = null;
    this.apiDomain = null;
    this.expiresAt = 0;
    this.tokenRequest = null;
  }

  async getAccessToken() {
    const config = this.configLoader();
    if (this.accessToken && Date.now() < this.expiresAt - EXPIRY_BUFFER_MS) {
      return this.accessToken;
    }
    if (!this.tokenRequest) this.tokenRequest = this.refreshAccessToken(config);
    try {
      return await this.tokenRequest;
    } finally {
      this.tokenRequest = null;
    }
  }

  getApiDomain() {
    return this.apiDomain;
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
      if (!payload.access_token) throw new Error('Zoho did not return an access token.');
      this.accessToken = payload.access_token;
      this.apiDomain = payload.api_domain || null;
      this.expiresAt = Date.now() + Number(payload.expires_in || 3600) * 1000;
      return this.accessToken;
    } catch (_error) {
      this.clearToken();
      const error = new Error('Unable to authenticate with Zoho CRM.');
      error.code = 'ZOHO_AUTHENTICATION_ERROR';
      error.statusCode = 502;
      throw error;
    }
  }
}

module.exports = { ZohoAuthService, EXPIRY_BUFFER_MS };
