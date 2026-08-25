const axios = require('axios');
const { getZohoConfig } = require('../config/zoho.config');
const { ZohoAuthService } = require('./zohoAuth.service');
const { buildCoqlQuery } = require('./coql.service');
const { createAppError } = require('../utils/errors');
const { log } = require('../utils/logger');

class ZohoCrmService {
  constructor(httpClient = axios, configLoader = getZohoConfig, authService) {
    this.httpClient = httpClient;
    this.configLoader = configLoader;
    this.authService = authService || new ZohoAuthService(httpClient, configLoader);
  }

  async query(request) {
    let config;
    try {
      config = this.configLoader();
    } catch (_error) {
      throw createAppError('ZOHO_CONFIGURATION_ERROR', 'Zoho CRM is not configured.', 502);
    }

    const token = await this.authService.getAccessToken();
    const selectQuery = `${buildCoqlQuery(request)} limit ${request.offset}, ${request.limit}`;
    const apiBaseUrl = normalizeCrmBaseUrl(this.authService.getApiDomain() || config.apiBaseUrl);
    log('info', `[COQL query] ${selectQuery}`);

    try {
      const response = await this.httpClient.post(`${apiBaseUrl}/coql`, { select_query: selectQuery }, {
        headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
        timeout: config.timeoutMs
      });
      const records = Array.isArray(response.data?.data) ? response.data.data : [];
      const info = response.data?.info || {};
      const firstRecord = records[0] || {};
      log('info', `[COQL result] count=${records.length} more_records=${Boolean(info.more_records)} first_stage=${String(firstRecord.Stage ?? '')} first_closing_date=${String(firstRecord.Closing_Date ?? '')}`);
      return { records, info };
    } catch (error) {
      if (error.response?.status === 401) this.authService.clearToken();
      throw createAppError('ZOHO_QUERY_ERROR', 'Unable to retrieve CRM data.', 502);
    }
  }

  async aggregate(selectQuery) {
    let config;
    try {
      config = this.configLoader();
    } catch (_error) {
      throw createAppError('ZOHO_CONFIGURATION_ERROR', 'Zoho CRM is not configured.', 502);
    }
    const token = await this.authService.getAccessToken();
    const apiBaseUrl = normalizeCrmBaseUrl(this.authService.getApiDomain() || config.apiBaseUrl);
    log('info', `[COQL aggregate query] ${selectQuery}`);
    try {
      const response = await this.httpClient.post(`${apiBaseUrl}/coql`, { select_query: selectQuery }, {
        headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
        timeout: config.timeoutMs
      });
      const rows = Array.isArray(response.data?.data) ? response.data.data : [];
      log('info', `[COQL aggregate result] count=${rows.length}`);
      return { rows };
    } catch (error) {
      if (error.response?.status === 401) this.authService.clearToken();
      throw createAppError('ZOHO_AGGREGATE_ERROR', 'Unable to execute the CRM aggregate query.', error.response?.status === 429 ? 429 : 502);
    }
  }
}

function normalizeCrmBaseUrl(value) {
  const url = value.replace(/\/$/, '');
  return /\/crm\/v\d+$/i.test(url) ? url : `${url}/crm/v8`;
}

module.exports = { ZohoCrmService, normalizeCrmBaseUrl };
