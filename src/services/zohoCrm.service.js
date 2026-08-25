const axios = require('axios');
const { getZohoConfig } = require('../config/zoho.config');
const { ZohoAuthService } = require('./zohoAuth.service');
const { buildCoqlQuery } = require('./coql.service');
const { buildModuleCriteria } = require('./coql.service');
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
      throw createAppError(
        'ZOHO_AGGREGATE_ERROR',
        'Unable to execute the CRM aggregate query.',
        mapZohoStatus(error.response?.status),
        safeZohoDetails(error)
      );
    }
  }

  async count(module, filters = []) {
    let config;
    try { config = this.configLoader(); } catch (_error) { throw createAppError('ZOHO_CONFIGURATION_ERROR', 'Zoho CRM is not configured.', 502); }
    const token = await this.authService.getAccessToken();
    const apiBaseUrl = normalizeCrmBaseUrl(this.authService.getApiDomain() || config.apiBaseUrl);
    const criteria = buildModuleCriteria(filters);
    log('info', `[CRM count API] module=${module} criteria=${criteria || '(none)'}`);
    try {
      const response = await this.httpClient.get(`${apiBaseUrl}/${module}/actions/count`, {
        params: criteria ? { criteria } : undefined,
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        timeout: config.timeoutMs
      });
      return { count: Number(response.data?.count || 0), criteria };
    } catch (error) {
      if (error.response?.status === 401) this.authService.clearToken();
      throw createAppError('ZOHO_COUNT_ERROR', 'Unable to count CRM records.', mapZohoStatus(error.response?.status), safeZohoDetails(error));
    }
  }

  async getUsers() {
    let config;
    try { config = this.configLoader(); } catch (_error) { throw createAppError('ZOHO_CONFIGURATION_ERROR', 'Zoho CRM is not configured.', 502); }
    const token = await this.authService.getAccessToken();
    const apiBaseUrl = normalizeCrmBaseUrl(this.authService.getApiDomain() || config.apiBaseUrl);
    const response = await this.httpClient.get(`${apiBaseUrl}/users`, { params: { type: 'AllUsers' }, headers: { Authorization: `Zoho-oauthtoken ${token}` }, timeout: config.timeoutMs });
    return Array.isArray(response.data?.users) ? response.data.users : [];
  }

  async getRecordsByIds(module, ids, fields) {
    let config;
    try { config = this.configLoader(); } catch (_error) { throw createAppError('ZOHO_CONFIGURATION_ERROR', 'Zoho CRM is not configured.', 502); }
    const token = await this.authService.getAccessToken();
    const apiBaseUrl = normalizeCrmBaseUrl(this.authService.getApiDomain() || config.apiBaseUrl);
    const response = await this.httpClient.get(`${apiBaseUrl}/${module}`, {
      params: { ids: ids.join(','), fields: fields.join(',') },
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      timeout: config.timeoutMs
    });
    return Array.isArray(response.data?.data) ? response.data.data : [];
  }

  async searchRecords(module, fields, filters, page = 1, perPage = 200) {
    let config;
    try { config = this.configLoader(); } catch (_error) { throw createAppError('ZOHO_CONFIGURATION_ERROR', 'Zoho CRM is not configured.', 502); }
    const token = await this.authService.getAccessToken();
    const apiBaseUrl = normalizeCrmBaseUrl(this.authService.getApiDomain() || config.apiBaseUrl);
    const { buildCriteria } = require('./coql.service');
    const criteria = buildCriteria(filters);
    const response = await this.httpClient.get(`${apiBaseUrl}/${module}/search`, {
      params: { criteria, fields: fields.join(','), page, per_page: perPage },
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      timeout: config.timeoutMs
    });
    return { records: Array.isArray(response.data?.data) ? response.data.data : [], info: response.data?.info || {} };
  }

  async resolveOwnerFilters(filters) {
    const ownerFields = new Set(['Owner', 'Deal_Owner', 'Lead_Owner']);
    const resolved = [];
    for (const filter of filters) {
      if (!ownerFields.has(filter.field) || !['equals', 'in'].includes(filter.operator)) { resolved.push(filter); continue; }
      const users = await this.getUsers();
      const values = filter.operator === 'in' ? filter.value : [filter.value];
      const ids = values.map((value) => this.resolveUserId(users, value));
      resolved.push({ ...filter, value: filter.operator === 'in' ? ids : ids[0] });
    }
    return resolved;
  }

  resolveUserId(users, value) {
    const requested = String(value).trim().toLowerCase();
    if (/^\d+$/.test(requested)) return String(value);
    const matches = users.filter((user) => [user.name, user.full_name, user.first_name, user.last_name, `${user.first_name || ''} ${user.last_name || ''}`.trim(), user.email].filter(Boolean).some((candidate) => String(candidate).toLowerCase() === requested));
    if (matches.length > 1) throw createAppError('OWNER_AMBIGUOUS', `Owner name '${value}' matches multiple Zoho CRM users.`, 400);
    if (matches.length === 0) throw createAppError('OWNER_NOT_FOUND', `No Zoho CRM user matches owner '${value}'.`, 400);
    const id = matches[0].id || matches[0].user_id;
    log('info', `[OWNER RESOLVED] requested=${value} id=${id}`);
    return String(id);
  }

  async getFieldMetadata(module) {
    let config;
    try {
      config = this.configLoader();
    } catch (_error) {
      throw createAppError('ZOHO_CONFIGURATION_ERROR', 'Zoho CRM is not configured.', 502);
    }
    const token = await this.authService.getAccessToken();
    const apiBaseUrl = normalizeCrmBaseUrl(this.authService.getApiDomain() || config.apiBaseUrl);
    try {
      const response = await this.httpClient.get(`${apiBaseUrl}/settings/fields`, {
        params: { module },
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        timeout: config.timeoutMs
      });
      const fields = Array.isArray(response.data?.fields) ? response.data.fields : [];
      return {
        fields: fields.map((field) => field.api_name).filter(Boolean),
        metadata: fields
      };
    } catch (error) {
      if (error.response?.status === 401) this.authService.clearToken();
      throw createAppError(
        'ZOHO_METADATA_ERROR',
        'Unable to verify Zoho CRM field metadata.',
        mapZohoStatus(error.response?.status),
        safeZohoDetails(error)
      );
    }
  }
}

function mapZohoStatus(status) {
  return [401, 403, 404, 429].includes(status) ? status : 502;
}

function safeZohoDetails(error) {
  const response = error.response;
  const payload = response?.data;
  return {
    upstream_status: response?.status,
    upstream_code: typeof payload?.code === 'string' ? payload.code : undefined,
    upstream_message: typeof payload?.message === 'string' ? payload.message : undefined
  };
}

function normalizeCrmBaseUrl(value) {
  const url = value.replace(/\/$/, '');
  return /\/crm\/v\d+$/i.test(url) ? url : `${url}/crm/v8`;
}

module.exports = { ZohoCrmService, normalizeCrmBaseUrl };
