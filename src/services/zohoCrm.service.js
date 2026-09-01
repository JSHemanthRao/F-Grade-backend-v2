const axios = require('axios');
const { getZohoConfig } = require('../config/zoho.config');
const { ZohoAuthService } = require('./zohoAuth.service');
const { buildCoqlQuery, buildFilterClauses, buildWhereClause, buildModuleCriteria } = require('./coql.service');
const { createAppError } = require('../utils/errors');
const { log } = require('../utils/logger');
const { env } = require('../config/env');
const { CircuitBreaker, isTransientFailure } = require('../utils/circuitBreaker');
const { CRM_API_NAMES } = require('../constants/crmModules');
const { validateModuleFieldScope } = require('../validators/crmQuery.validator');

class ZohoCrmService {
  constructor(httpClient = axios, configLoader = getZohoConfig, authService) {
    this.httpClient = httpClient;
    this.configLoader = configLoader;
    this.authService = authService || new ZohoAuthService(httpClient, configLoader);
    this.circuitBreaker = new CircuitBreaker({ failureThreshold: env.zohoCircuitFailureThreshold, resetTimeoutMs: env.zohoCircuitResetTimeoutMs });
    this.executionStats = { calls: 0, successfulCalls: 0, failedCalls: 0, retries: 0 };
    this.maxConcurrency = Math.max(1, env.zohoMaxConcurrency);
    this.activeRequests = 0;
    this.requestQueue = [];
    this.metadataCache = new Map();
  }

  async acquireSlot() {
    if (this.activeRequests < this.maxConcurrency) {
      this.activeRequests += 1;
      return;
    }
    await new Promise((resolve) => this.requestQueue.push(resolve));
    this.activeRequests += 1;
  }

  releaseSlot() {
    this.activeRequests -= 1;
    const next = this.requestQueue.shift();
    if (next) next();
  }

  async executeRequest(method, url, options) {
    const maxAttempts = options?.retrySameRequest === false ? 1 : Math.max(1, env.zohoMaxRetries + 1);
    let attempt = 0;
    const startedAt = Date.now();
    this.executionStats.calls += 1;
    while (attempt < maxAttempts) {
      await this.acquireSlot();
      try {
        const response = await this.circuitBreaker.execute(() => method === 'get'
          ? this.httpClient.get(url, options?.config)
          : this.httpClient.post(url, options?.data, options?.config));
        this.executionStats.successfulCalls += 1;
        log('info', `[ZOHO EXECUTION] method=${method} durationMs=${Date.now() - startedAt} retries=${attempt}`);
        return response;
      } catch (error) {
        attempt += 1;
        if (attempt >= maxAttempts || !isTransientFailure(error)) {
          this.executionStats.failedCalls += 1;
          throw error;
        }
        this.executionStats.retries += 1;
        const retryAfter = Number(error.response?.headers?.['retry-after']);
        const retryDelay = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(250 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 100), 2000);
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      } finally {
        this.releaseSlot();
      }
    }
  }

  async query(request) {
    let config;
    try {
      config = this.configLoader();
    } catch (_error) {
      throw createAppError('ZOHO_CONFIGURATION_ERROR', 'Zoho CRM is not configured.', 502);
    }

    const token = await this.authService.getAccessToken();
    const resolvedModule = await this.resolveModuleApiName(request.module);
    const staticFields = require('../constants/crmModules').CRM_MODULES[request.module] || [];
    if (CRM_API_NAMES[request.module]) {
      const selectQuery = `${buildCoqlQuery(request)} limit ${request.offset}, ${request.limit}`;
      return this.executeQueryRequest(selectQuery, token, config, request);
    }

    let metadata;
    try {
      metadata = await this.getFieldMetadata(resolvedModule);
    } catch (error) {
      throw createAppError('ZOHO_METADATA_ERROR', `Unable to verify Zoho CRM field metadata for '${resolvedModule}'.`, mapZohoStatus(error.response?.status), safeZohoDetails(error));
    }
    const requestedFields = Array.isArray(request.fields) ? request.fields : [];
    const usableFields = requestedFields.length > 0
      ? requestedFields.filter((field) => metadata.fields.includes(field))
      : metadata.fields.slice(0, 6);
    const finalFields = usableFields.length > 0 ? usableFields : staticFields;
    if (finalFields.length === 0) {
      throw createAppError('ZOHO_FIELD_UNAVAILABLE', `Zoho CRM metadata for '${resolvedModule}' does not expose any of the requested fields.`, 502);
    }
    const selectQuery = `${buildDynamicCoqlQuery({ ...request, module: resolvedModule, fields: finalFields })} limit ${request.offset}, ${request.limit}`;
    return this.executeQueryRequest(selectQuery, token, config, request);
  }

  async executeQueryRequest(selectQuery, token, config) {
    const apiBaseUrl = normalizeCrmBaseUrl(this.authService.getApiDomain() || config.apiBaseUrl);
    log('info', `[COQL query] ${selectQuery}`);
    try {
      const response = await this.executeRequest('post', `${apiBaseUrl}/coql`, { data: { select_query: selectQuery }, config: {
        headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
        timeout: config.timeoutMs
      }, retrySameRequest: false });
      const records = Array.isArray(response.data?.data) ? response.data.data : [];
      const info = response.data?.info || {};
      const firstRecord = records[0] || {};
      log('info', `[COQL result] count=${records.length} more_records=${Boolean(info.more_records)} first_stage=${String(firstRecord.Stage ?? '')} first_closing_date=${String(firstRecord.Closing_Date ?? '')}`);
      return { records, info };
    } catch (error) {
      if (error.response?.status === 401) this.authService.clearToken();
      log('error', `[ZOHO QUERY FAILURE] operation=record_query query=${selectQuery} status=${error.response?.status || 'unknown'}`);
      throw createAppError('ZOHO_QUERY_ERROR', 'Unable to retrieve CRM data.', mapZohoStatus(error.response?.status), {
        ...safeZohoDetails(error),
        operation: 'record_query'
      });
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
      const response = await this.executeRequest('post', `${apiBaseUrl}/coql`, { data: { select_query: selectQuery }, config: {
        headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
        timeout: config.timeoutMs
      }, retrySameRequest: false });
      const rows = Array.isArray(response.data?.data) ? response.data.data : [];
      log('info', `[COQL aggregate result] count=${rows.length}`);
      return { rows };
    } catch (error) {
      if (error.response?.status === 401) this.authService.clearToken();
      log('error', `[ZOHO QUERY FAILURE] operation=aggregate_query query=${selectQuery} status=${error.response?.status || 'unknown'}`);
      throw createAppError(
        'ZOHO_AGGREGATE_ERROR',
        'Unable to execute the CRM aggregate query.',
        mapZohoStatus(error.response?.status),
        { ...safeZohoDetails(error), operation: 'aggregate_query' }
      );
    }
  }

  async count(module, filters = []) {
    const moduleName = await this.resolveModuleApiName(module);
    validateModuleFieldScope({ module: moduleName, filters });
    let config;
    try { config = this.configLoader(); } catch (_error) { throw createAppError('ZOHO_CONFIGURATION_ERROR', 'Zoho CRM is not configured.', 502); }
    const token = await this.authService.getAccessToken();
    const apiBaseUrl = normalizeCrmBaseUrl(this.authService.getApiDomain() || config.apiBaseUrl);
    const criteria = buildModuleCriteria(filters);
    log('info', `[CRM count API] module=${module} criteria=${criteria || '(none)'}`);
    try {
      const response = await this.executeRequest('get', `${apiBaseUrl}/${module}/actions/count`, { config: {
        params: criteria ? { criteria } : undefined,
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        timeout: config.timeoutMs
      }});
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
    const response = await this.executeRequest('get', `${apiBaseUrl}/users`, { config: { params: { type: 'AllUsers' }, headers: { Authorization: `Zoho-oauthtoken ${token}` }, timeout: config.timeoutMs } });
    return Array.isArray(response.data?.users) ? response.data.users : [];
  }

  async getRecordsByIds(module, ids, fields) {
    const moduleName = await this.resolveModuleApiName(module);
    validateModuleFieldScope({ module: moduleName, fields });
    let config;
    try { config = this.configLoader(); } catch (_error) { throw createAppError('ZOHO_CONFIGURATION_ERROR', 'Zoho CRM is not configured.', 502); }
    const token = await this.authService.getAccessToken();
    const apiBaseUrl = normalizeCrmBaseUrl(this.authService.getApiDomain() || config.apiBaseUrl);
    const response = await this.executeRequest('get', `${apiBaseUrl}/${module}`, { config: {
      params: { ids: ids.join(','), fields: fields.join(',') },
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      timeout: config.timeoutMs
    }});
    return Array.isArray(response.data?.data) ? response.data.data : [];
  }

  async searchRecords(module, fields, filters, page = 1, perPage = 200) {
    const moduleName = await this.resolveModuleApiName(module);
    validateModuleFieldScope({ module: moduleName, fields, filters });
    let config;
    try { config = this.configLoader(); } catch (_error) { throw createAppError('ZOHO_CONFIGURATION_ERROR', 'Zoho CRM is not configured.', 502); }
    const token = await this.authService.getAccessToken();
    const apiBaseUrl = normalizeCrmBaseUrl(this.authService.getApiDomain() || config.apiBaseUrl);
    const { buildCriteria } = require('./coql.service');
    const criteria = buildCriteria(filters);
    const response = await this.executeRequest('get', `${apiBaseUrl}/${module}/search`, { config: {
      params: { criteria, fields: fields.join(','), page, per_page: perPage },
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      timeout: config.timeoutMs
    }});
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
    const cached = this.metadataCache.get(module);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    let config;
    try {
      config = this.configLoader();
    } catch (_error) {
      throw createAppError('ZOHO_CONFIGURATION_ERROR', 'Zoho CRM is not configured.', 502);
    }
    const token = await this.authService.getAccessToken();
    const apiBaseUrl = normalizeCrmBaseUrl(this.authService.getApiDomain() || config.apiBaseUrl);
    try {
      const response = await this.executeRequest('get', `${apiBaseUrl}/settings/fields`, { config: {
        params: { module },
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        timeout: config.timeoutMs
      }});
      let fields = Array.isArray(response.data?.fields) ? response.data.fields : [];
      const value = {
        fields: fields.map((field) => field.api_name).filter(Boolean),
        metadata: fields
      };
      if (value.fields.length === 0 && CRM_API_NAMES[module]) {
        const fallbackFields = require('../constants/crmModules').CRM_MODULES[module] || [];
        return { fields: fallbackFields, metadata: [] };
      }
      this.metadataCache.set(module, { value, expiresAt: Date.now() + env.zohoMetadataTtlMs });
      return value;
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

  async getModulesMetadata() {
    const cached = this.metadataCache.get('__modules__');
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    let config;
    try {
      config = this.configLoader();
    } catch (_error) {
      throw createAppError('ZOHO_CONFIGURATION_ERROR', 'Zoho CRM is not configured.', 502);
    }
    const token = await this.authService.getAccessToken();
    const apiBaseUrl = normalizeCrmBaseUrl(this.authService.getApiDomain() || config.apiBaseUrl);
    try {
      const response = await this.executeRequest('get', `${apiBaseUrl}/settings/modules`, { config: {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        timeout: config.timeoutMs
      }});
      const modules = Array.isArray(response.data?.modules) ? response.data.modules : [];
      const value = {
        modules,
        byApiName: new Map(modules.filter((module) => module?.api_name).map((module) => [module.api_name, module]))
      };
      this.metadataCache.set('__modules__', { value, expiresAt: Date.now() + env.zohoMetadataTtlMs });
      return value;
    } catch (error) {
      if (error.response?.status === 401) this.authService.clearToken();
      throw createAppError('ZOHO_METADATA_ERROR', 'Unable to verify Zoho CRM module metadata.', mapZohoStatus(error.response?.status), safeZohoDetails(error));
    }
  }

  async resolveModuleApiName(module) {
    const cached = CRM_API_NAMES[module];
    if (cached) return cached;
    const metadata = await this.getModulesMetadata();
    const byApiName = metadata.byApiName.get(module);
    if (byApiName?.api_name) return byApiName.api_name;
    const normalized = String(module || '').trim();
    const match = metadata.modules.find((item) => String(item?.module_name || item?.plural_label || item?.singular_label || item?.api_name || '').toLowerCase() === normalized.toLowerCase());
    if (match?.api_name) return match.api_name;
    return normalized;
  }

  extractRelationships(metadata = []) {
    const normalizeModule = (value) => {
      if (!value) return null;
      if (typeof value === 'string') return value;
      if (typeof value === 'object') return value.api_name || value.module_name || value.name || value.label || null;
      return null;
    };
    return metadata
      .filter((field) => field && typeof field === 'object' && field.data_type === 'lookup')
      .map((field) => ({
        field_api_name: field.api_name || null,
        field_label: field.display_label || field.field_label || field.label || field.api_name || null,
        target_module_api_name: normalizeModule(field.lookup?.module) || normalizeModule(field.lookup?.module_name) || normalizeModule(field.module),
        target_module_label: field.lookup?.module?.name || field.lookup?.module?.plural_label || field.lookup?.module_label || null,
        related_list: field.related_list || field.lookup?.related_list || null,
        searchable: field.searchable ?? null,
        sortable: field.sortable ?? null,
        multi_select_lookup: Boolean(field.data_type === 'multi_select_lookup' || field.multi_module_lookup)
      }))
      .filter((relationship) => relationship.field_api_name && relationship.target_module_api_name);
  }
}

function buildDynamicCoqlQuery({ module, fields, filters, sort }) {
  const clauses = buildFilterClauses(filters || []);
  let query = `select ${fields.join(', ')} from ${module}`;
  query += ` where ${clauses.length > 0 ? buildWhereClause(clauses) : '(id is not null)'}`;
  if (sort) query += ` order by ${sort.field} ${sort.order}`;
  return query;
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
