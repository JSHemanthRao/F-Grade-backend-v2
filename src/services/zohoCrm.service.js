const axios = require('axios');
const { getZohoConfig } = require('../config/zoho.config');
const { ZohoAuthService } = require('./zohoAuth.service');
const { buildFilterClauses, buildWhereClause, buildLogicalFilterClause, buildModuleCriteria } = require('./coql.service');
const { createAppError } = require('../utils/errors');
const { log } = require('../utils/logger');
const { env } = require('../config/env');
const { CircuitBreaker, isTransientFailure } = require('../utils/circuitBreaker');
const { CRM_API_NAMES } = require('../constants/crmModules');
const { validateModuleFieldScope } = require('../validators/crmQuery.validator');
const { getCurrentCrmDiagnostics, recordCrmEvent, updateDiagnostics } = require('../utils/crmDiagnostics');
const { resolveModuleReference, assertResolvedModule, buildModuleRegistry, normalizeModuleReference } = require('../resolvers/moduleResolver');

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
    assertReadOnlyRequest(method, url);
    const maxAttempts = options?.retrySameRequest === false ? 1 : Math.max(1, env.zohoMaxRetries + 1);
    let attempt = 0;
    const startedAt = Date.now();
    this.executionStats.calls += 1;
    const endpoint = safeEndpoint(url);
    const diagnostics = getCurrentCrmDiagnostics();
    updateDiagnostics(diagnostics, { zoho_endpoint: endpoint });
    recordCrmEvent('ZOHO_REQUEST', diagnostics, { method: String(method || '').toUpperCase(), endpoint });
    while (attempt < maxAttempts) {
      await this.acquireSlot();
      try {
        const response = await this.circuitBreaker.execute(() => method === 'get'
          ? this.httpClient.get(url, options?.config)
          : this.httpClient.post(url, options?.data, options?.config));
        this.executionStats.successfulCalls += 1;
        updateDiagnostics(diagnostics, { zoho_http_status: response.status, zoho_error_code: null, zoho_error_message: null });
        recordCrmEvent('ZOHO_RESPONSE', diagnostics, { method: String(method || '').toUpperCase(), endpoint, status: response.status });
        log('info', `[ZOHO EXECUTION] method=${method} durationMs=${Date.now() - startedAt} retries=${attempt}`);
        return response;
      } catch (error) {
        attempt += 1;
        if (attempt >= maxAttempts || !isTransientFailure(error)) {
          this.executionStats.failedCalls += 1;
          error.zohoDiagnostics = {
            method: String(method || '').toUpperCase(),
            endpoint: safeEndpoint(url),
            status: error.response?.status || 'not_reached',
            code: error.response?.data?.code || 'not_reached',
            message: error.response?.data?.message || 'not_reached'
          };
          updateDiagnostics(diagnostics, {
            zoho_http_status: error.zohoDiagnostics.status,
            zoho_error_code: error.zohoDiagnostics.code,
            zoho_error_message: error.zohoDiagnostics.message
          });
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
    const requestedModule = request.module;
    const resolvedModule = request.module_api_name || await this.resolveModuleApiName(requestedModule);
    const expectedModuleApiName = CRM_API_NAMES[requestedModule];
    if (expectedModuleApiName && resolvedModule !== expectedModuleApiName) {
      throw createAppError(
        'CRM_MODULE_ROUTING_ERROR',
        `CRM module '${request.module}' resolved to '${resolvedModule}' instead of '${expectedModuleApiName}'.`,
        500,
        { requested_module: request.module, resolved_module: resolvedModule, expected_module_api_name: expectedModuleApiName }
      );
    }
    let metadata;
    try {
      metadata = await this.getFieldMetadata(resolvedModule);
    } catch (error) {
      if (error.code === 'ZOHO_METADATA_EMPTY') throw error;
      if (typeof this.httpClient.get !== 'function' && CRM_API_NAMES[requestedModule]) {
        const staticFields = require('../constants/crmModules').CRM_MODULES[requestedModule] || [];
        if (staticFields.length > 0) return { fields: staticFields, metadata: [] };
      }
      throw createAppError(normalizeZohoErrorCode(error, 'ZOHO_METADATA_ERROR'), `Unable to access '${resolvedModule}' field metadata.`, mapZohoStatus(error.response?.status, error.response?.data?.code), safeZohoDetails(error, 'ZohoCRM.settings.fields.READ'));
    }
    const requestedFields = Array.isArray(request.fields) ? request.fields : [];
    const missingFields = requestedFields.filter((field) => !metadata.fields.includes(field));
    if (missingFields.length > 0) {
      throw createAppError(
        'FIELD_NOT_AVAILABLE',
        `Zoho CRM metadata for '${resolvedModule}' does not expose the requested field(s).`,
        400,
        { module: requestedModule, module_api_name: resolvedModule, field: missingFields[0], fields: missingFields }
      );
    }
    let safeFields = metadata.fields;
    try {
      safeFields = await this.getCoqlSafeFields(resolvedModule);
    } catch (_err) {
      // Use the complete metadata field list if type filtering is unavailable.
    }
    const finalFields = requestedFields.length > 0
      ? requestedFields
      : safeFields.slice(0, 6);
    if (finalFields.length === 0) {
      throw createAppError('ZOHO_FIELD_UNAVAILABLE', `Zoho CRM metadata for '${resolvedModule}' does not expose any of the requested fields.`, 502);
    }
    const selectQuery = `${buildDynamicCoqlQuery({ ...request, module: resolvedModule, fields: finalFields })} limit ${request.offset}, ${request.limit}`;
    return this.executeQueryRequest(selectQuery, token, config, request, resolvedModule);
  }

  async executeQueryRequest(selectQuery, token, config, request, resolvedModule) {
    const apiBaseUrl = normalizeCrmBaseUrl(this.authService.getApiDomain() || config.apiBaseUrl);
    updateDiagnostics(getCurrentCrmDiagnostics(), { final_query: selectQuery });
    log('info', `[COQL query] operation=record_query module=${resolvedModule} field_count=${Array.isArray(request?.fields) ? request.fields.length : 0}`);
    try {
      const response = await this.executeRequest('post', `${apiBaseUrl}/coql`, { data: { select_query: selectQuery }, config: {
        headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
        timeout: config.timeoutMs
      }, retrySameRequest: false });
      const records = Array.isArray(response.data?.data) ? response.data.data : [];
      const info = response.data?.info || {};
      const firstRecord = records[0] || {};
      log('info', `[COQL result] count=${records.length} more_records=${Boolean(info.more_records)}`);
      return { records, info, module_api_name: resolvedModule || request?.module || null };
    } catch (error) {
      if (error.response?.status === 401) this.authService.clearToken();
      const upstreamMessage = String(error.response?.data?.message || error.message || '');
      log('error', `[ZOHO QUERY FAILURE] operation=record_query status=${error.response?.status || 'unknown'} message=${upstreamMessage.replace(/\n/g, ' ')}`);

      throw createAppError(normalizeZohoErrorCode(error, 'ZOHO_READ_ERROR'), upstreamMessage || 'Unable to retrieve CRM data.', mapZohoStatus(error.response?.status, error.response?.data?.code), {
        ...safeZohoDetails(error, 'ZohoCRM.coql.READ'),
        operation: 'record_query',
        query_stage: 'zoho_execution',
        query: selectQuery
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
    log('info', '[COQL aggregate query] operation=aggregate_query');
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
      log('error', `[ZOHO QUERY FAILURE] operation=aggregate_query status=${error.response?.status || 'unknown'}`);
      throw createAppError(
        normalizeZohoErrorCode(error, 'ZOHO_AGGREGATE_ERROR'),
        'Unable to execute the CRM aggregate query.',
        mapZohoStatus(error.response?.status, error.response?.data?.code),
        { ...safeZohoDetails(error, 'ZohoCRM.coql.READ'), operation: 'aggregate_query' }
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
    log('info', `[CRM count API] module=${module} filter_count=${filters.length}`);
    try {
      const response = await this.executeRequest('get', `${apiBaseUrl}/${moduleName}/actions/count`, { config: {
        params: criteria ? { criteria } : undefined,
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        timeout: config.timeoutMs
      }});
      return { count: Number(response.data?.count || 0), criteria };
    } catch (error) {
      if (error.response?.status === 401) this.authService.clearToken();
      throw createAppError(normalizeZohoErrorCode(error, 'ZOHO_COUNT_ERROR'), 'Unable to count CRM records.', mapZohoStatus(error.response?.status, error.response?.data?.code), safeZohoDetails(error, 'ZohoCRM.modules.READ'));
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

  async getOrganization() {
    const response = await this.readGet('/org', { operation: 'organization', scope: 'ZohoCRM.org.READ' });
    return Array.isArray(response.data?.org) ? response.data.org : (response.data?.org || response.data || {});
  }

  async getAuditLogs(params = {}) {
    const response = await this.readGet('/settings/audit_log_export', { params, operation: 'audit_logs', scope: 'ZohoCRM.settings.audit_logs.READ' });
    return { records: Array.isArray(response.data?.audit_log_export) ? response.data.audit_log_export : [], info: response.data?.info || {} };
  }

  async getFiles({ id } = {}) {
    throw createAppError('ZOHO_FILES_UNSUPPORTED', 'Zoho Files is not supported by the current Zoho CRM OAuth client. Configure a separate Zoho Files read-only integration before enabling this operation.', 501, { operation: 'files', required_read_scope: 'ZohoFiles.files.READ' });
  }

  async startBulkRead({ module, module_api_name, fields = [], criteria } = {}) {
    if (!module || !Array.isArray(fields) || fields.length === 0) {
      throw createAppError('INVALID_BULK_READ_REQUEST', 'Bulk read requires a module and at least one field.', 400);
    }
    const moduleName = module_api_name || await this.resolveModuleApiName(module);
    validateModuleFieldScope({ module: moduleName, fields });
    const response = await this.readPost('/read', {
      query: { module: { api_name: moduleName }, fields, ...(criteria ? { criteria } : {}) }
    }, { apiBaseUrl: this.getBulkApiBaseUrl(), operation: 'bulk_read', scope: 'ZohoCRM.bulk.READ' });
    return response.data || {};
  }

  async getBulkReadStatus(jobId) {
    const payload = (await this.readGet(`/read/${encodeURIComponent(jobId)}`, { apiBaseUrl: this.getBulkApiBaseUrl(), operation: 'bulk_read_status', scope: 'ZohoCRM.bulk.READ' })).data || {};
    return Array.isArray(payload.data) ? (payload.data[0] || {}) : payload;
  }

  async getBulkReadResult(jobId) {
    return (await this.readGet(`/read/${encodeURIComponent(jobId)}/result`, { apiBaseUrl: this.getBulkApiBaseUrl(), operation: 'bulk_read_result', scope: 'ZohoCRM.bulk.READ' })).data || {};
  }

  async bulkRead({ module, module_api_name, fields, criteria, maxPolls = 60, pollDelayMs = 1000 } = {}) {
    const started = await this.startBulkRead({ module, module_api_name, fields, criteria });
    const jobId = extractBulkJobId(started);
    if (!jobId) throw createAppError('BULK_READ_JOB_UNAVAILABLE', 'Zoho did not return a bulk-read job ID.', 502, { operation: 'bulk_read' });

    let status = started;
    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      const state = String(status.state || status.status || status.details?.state || '').toUpperCase();
      if (['COMPLETED', 'SUCCESS', 'COMPLETED_WITH_ERRORS'].includes(state)) {
        const result = await this.getBulkReadResult(jobId);
        return { job_id: jobId, status: state, result, download_url: status.result?.download_url || result.download_url || null };
      }
      if (['FAILED', 'ERROR', 'CANCELLED'].includes(state)) {
        throw createAppError('BULK_READ_FAILED', 'Zoho bulk read failed.', 502, { operation: 'bulk_read', job_id: jobId, state });
      }
      if (attempt < maxPolls - 1) await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
      status = await this.getBulkReadStatus(jobId);
    }
    throw createAppError('BULK_READ_TIMEOUT', 'Zoho bulk read did not complete within the polling limit.', 504, { operation: 'bulk_read', job_id: jobId, max_polls: maxPolls });
  }

  getBulkApiBaseUrl() {
    const config = this.configLoader();
    if (config.bulkApiBaseUrl) return config.bulkApiBaseUrl.replace(/\/$/, '');
    const apiBaseUrl = normalizeCrmBaseUrl(this.authService.getApiDomain() || config.apiBaseUrl);
    return apiBaseUrl.replace(/\/crm\/v\d+$/i, '/crm/bulk/v8');
  }

  async readGet(path, { params, apiBaseUrl, operation, scope } = {}) {
    const config = this.configLoader();
    const token = await this.authService.getAccessToken();
    const baseUrl = apiBaseUrl || normalizeCrmBaseUrl(this.authService.getApiDomain() || config.apiBaseUrl);
    try {
      return await this.executeRequest('get', `${baseUrl}${path}`, { config: { params, headers: { Authorization: `Zoho-oauthtoken ${token}` }, timeout: config.timeoutMs } });
    } catch (error) {
      if (error.response?.status === 401) this.authService.clearToken();
      throw createZohoOperationError(error, operation, scope);
    }
  }

  async readPost(path, data, { apiBaseUrl, operation, scope } = {}) {
    const config = this.configLoader();
    const token = await this.authService.getAccessToken();
    const baseUrl = apiBaseUrl || normalizeCrmBaseUrl(this.authService.getApiDomain() || config.apiBaseUrl);
    try {
      return await this.executeRequest('post', `${baseUrl}${path}`, { data, config: { headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' }, timeout: config.timeoutMs } });
    } catch (error) {
      if (error.response?.status === 401) this.authService.clearToken();
      throw createZohoOperationError(error, operation, scope);
    }
  }

  async getRecordsByIds(module, ids, fields) {
    const moduleName = await this.resolveModuleApiName(module);
    validateModuleFieldScope({ module: moduleName, fields });
    let config;
    try { config = this.configLoader(); } catch (_error) { throw createAppError('ZOHO_CONFIGURATION_ERROR', 'Zoho CRM is not configured.', 502); }
    const token = await this.authService.getAccessToken();
    const apiBaseUrl = normalizeCrmBaseUrl(this.authService.getApiDomain() || config.apiBaseUrl);
    const response = await this.executeRequest('get', `${apiBaseUrl}/${moduleName}`, { config: {
      params: { ids: ids.join(','), fields: fields.join(',') },
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      timeout: config.timeoutMs
    }});
    return Array.isArray(response.data?.data) ? response.data.data : [];
  }

  async searchRecords(module, fields, filters, page = 1, perPage = 200, search = {}) {
    const moduleName = await this.resolveModuleApiName(module);
    validateModuleFieldScope({ module: moduleName, fields, filters });
    let config;
    try { config = this.configLoader(); } catch (_error) { throw createAppError('ZOHO_CONFIGURATION_ERROR', 'Zoho CRM is not configured.', 502); }
    const token = await this.authService.getAccessToken();
    const apiBaseUrl = normalizeCrmBaseUrl(this.authService.getApiDomain() || config.apiBaseUrl);
    const { buildCriteria } = require('./coql.service');
    const criteria = buildCriteria(filters);
    const params = { fields: fields.join(','), page, per_page: perPage };
    if (filters.length > 0) params.criteria = criteria;
    else if (search.email) params.email = search.email;
    else if (search.phone) params.phone = search.phone;
    else if (search.word) params.word = search.word;
    else throw createAppError('INVALID_SEARCH_REQUEST', 'Search requires criteria, email, phone, or word.', 400);
    const response = await this.executeRequest('get', `${apiBaseUrl}/${moduleName}/search`, { config: {
      params,
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      timeout: config.timeoutMs
    }});
    return { records: Array.isArray(response.data?.data) ? response.data.data : [], info: response.data?.info || {}, module_api_name: moduleName };
  }

  async resolveFieldApiNames(module, labels) {
    const moduleApiName = await this.resolveModuleApiName(module);
    const metadata = await this.getFieldMetadata(moduleApiName);
    const normalized = new Map();
    for (const field of metadata.metadata || []) {
      for (const value of [field.api_name, field.display_label, field.field_label, field.label, field.name]) {
        if (value) normalized.set(normalizeLabel(value), field.api_name);
      }
    }
    const requestedLabels = Array.isArray(labels) ? labels : [];
    const apiNames = requestedLabels.map((label) => normalized.get(normalizeLabel(label))).filter(Boolean);
    const missing = requestedLabels.filter((label) => !normalized.has(normalizeLabel(label)));
    if (missing.length > 0) {
      throw createAppError('FIELD_NOT_RESOLVED', `CRM field '${missing[0]}' could not be resolved for module '${module}'.`, 400, {
        module,
        module_api_name: moduleApiName,
        user_term: missing[0],
        fields: missing,
        candidate_fields: (metadata.metadata || []).map((field) => ({ api_name: field.api_name, field_label: field.display_label || field.field_label || field.label || field.name || field.api_name })).slice(0, 50),
        reason: 'No exact API name or live metadata label matched the requested field.'
      });
    }
    return apiNames;
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
    log('info', '[OWNER RESOLVED] owner filter resolved');
    return String(id);
  }

  async getFieldMetadata(module, { forceRefresh = false } = {}) {
    const cached = this.metadataCache.get(module);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      log('info', `[CRM FIELD METADATA] module_api_name=${module} cache=hit field_count=${cached.value.fields.length}`);
      return cached.value;
    }
    const startedAt = Date.now();
    log('info', `[CRM FIELD METADATA] module_api_name=${module} lookup=start`);
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
      const fields = normalizeFieldMetadata(response.data?.fields);
      const value = {
        fields: fields.map((field) => field.api_name).filter(Boolean),
        metadata: fields
      };
      if (value.fields.length === 0) {
        throw createAppError('ZOHO_METADATA_EMPTY', `Zoho field metadata for '${module}' was empty.`, 502, { module_api_name: module, reason: 'Fields Metadata API returned no fields.' });
      }
      this.metadataCache.set(module, { value, expiresAt: Date.now() + env.zohoMetadataTtlMs });
      log('info', `[CRM FIELD METADATA] module_api_name=${module} lookup=complete field_count=${value.fields.length} elapsed_ms=${Date.now() - startedAt}`);
      return value;
    } catch (error) {
      if (error.response?.status === 401) this.authService.clearToken();
      if (error.code === 'ZOHO_METADATA_EMPTY') throw error;
      if (typeof this.httpClient.get !== 'function' && CRM_API_NAMES[module]) {
        const staticFields = require('../constants/crmModules').CRM_MODULES[module] || [];
        if (staticFields.length > 0) return { fields: staticFields, metadata: [] };
      }
      throw createAppError(
        normalizeZohoErrorCode(error, 'ZOHO_METADATA_ERROR'),
        'Unable to verify Zoho CRM field metadata.',
        mapZohoStatus(error.response?.status, error.response?.data?.code),
        safeZohoDetails(error, 'ZohoCRM.settings.fields.READ')
      );
    }
  }

  async getCoqlSafeFields(module) {
    // Returns a list of api_name fields that are safe to include in COQL select
    const meta = await this.getFieldMetadata(module);
    const allowedTypes = new Set(['text', 'string', 'email', 'phone', 'integer', 'long', 'double', 'boolean', 'date', 'datetime', 'picklist', 'currency']);
    const safe = (meta.metadata || []).filter((f) => {
      if (!f || !f.api_name) return false;
      const dtype = String(f.data_type || '').toLowerCase();
      if (!allowedTypes.has(dtype)) return false;
      // exclude multi-select lookup and multi-module lookups
      if (f.multi_module_lookup || f.data_type === 'multi_select_lookup' || f.multi_select_lookup) return false;
      return true;
    }).map((f) => f.api_name).filter(Boolean);
    // If safe list is empty, fall back to the generic field list
    return safe.length > 0 ? safe : meta.fields;
  }

  async getModulesMetadata({ forceRefresh = false } = {}) {
    const cached = this.metadataCache.get('__modules__');
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.value;
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
        byApiName: new Map(modules.filter((module) => module?.api_name).map((module) => [module.api_name, module])),
        registry: buildModuleRegistry(modules, CRM_API_NAMES)
      };
      this.metadataCache.set('__modules__', { value, expiresAt: Date.now() + env.zohoMetadataTtlMs });
      return value;
    } catch (error) {
      if (error.response?.status === 401) this.authService.clearToken();
      throw createAppError(normalizeZohoErrorCode(error, 'ZOHO_METADATA_ERROR'), 'Unable to verify Zoho CRM module metadata.', mapZohoStatus(error.response?.status, error.response?.data?.code), safeZohoDetails(error, 'ZohoCRM.settings.modules.READ'));
    }
  }

  async resolveModuleApiName(module, { preferStatic = false, forceRefresh = false } = {}) {
    const normalized = String(module || '').trim();
    const staticEntry = Object.entries(CRM_API_NAMES).find(([label, apiName]) => normalizeModuleReference(label) === normalizeModuleReference(normalized) || normalizeModuleReference(apiName) === normalizeModuleReference(normalized));
    const expectedApiName = staticEntry?.[1];
    if (preferStatic && expectedApiName) return expectedApiName;
    const startedAt = Date.now();
    log('info', `[CRM MODULE METADATA] requested_module=${normalized} lookup=start`);
    let metadata;
    try {
      metadata = await this.getModulesMetadata({ forceRefresh });
    } catch (error) {
      if (expectedApiName && typeof this.httpClient.get !== 'function') return expectedApiName;
      if (!expectedApiName) {
        throw createAppError('MODULE_UNAVAILABLE', `Zoho CRM module '${normalized}' is unavailable for read operations.`, 400, {
          requested_module: normalized,
          resolved_api_name: null,
          reason: 'The requested module is not a recognized semantic module and could not be verified in live metadata.'
        });
      }
      throw createAppError('MODULE_UNAVAILABLE', `Zoho CRM module '${normalized}' is unavailable for read operations.`, 400, {
        requested_module: normalized,
        resolved_api_name: null,
        reason: 'Live Zoho module metadata could not verify this module.'
      });
    }
    let resolution = resolveModuleReference(normalized, metadata.registry || metadata.modules, { staticAliases: CRM_API_NAMES });
    if (!resolution.matched && !resolution.ambiguous && !forceRefresh) {
      const refreshed = await this.getModulesMetadata({ forceRefresh: true });
      resolution = resolveModuleReference(normalized, refreshed.registry || refreshed.modules, { staticAliases: CRM_API_NAMES });
    }
    const resolved = assertResolvedModule(resolution, normalized);
    if (resolved.metadata.api_supported === false || resolved.metadata.viewable === false) {
      throw createAppError('MODULE_UNAVAILABLE', `Zoho CRM module '${normalized}' is not available for read operations.`, 400, { requested_module: normalized, resolved_api_name: resolved.api_name, reason: 'Zoho metadata marks the module as unsupported or not viewable.', api_supported: resolved.metadata.api_supported, viewable: resolved.metadata.viewable });
    }
    log('info', `[CRM MODULE ROUTING] requested=${normalized} semantic=${resolved.semantic_name} resolved=${resolved.api_name} match_type=${resolved.match_type}`);
    log('info', `[CRM MODULE METADATA] requested_module=${normalized} lookup=complete module_api_name=${resolved.api_name} elapsed_ms=${Date.now() - startedAt}`);
    return resolved.api_name;
  }

  async resolveModuleReference(moduleReference, { forceRefresh = false } = {}) {
    const metadata = await this.getModulesMetadata({ forceRefresh });
    let result = resolveModuleReference(moduleReference, metadata.registry || metadata.modules, { staticAliases: CRM_API_NAMES });
    if (!result.matched && !result.ambiguous && !forceRefresh) return this.resolveModuleReference(moduleReference, { forceRefresh: true });
    return assertResolvedModule(result, moduleReference);
  }

  async getModuleMetadata(module) {
    const normalized = normalizeLabel(String(module || '').trim());
    const metadata = await this.getModulesMetadata();
    const match = metadata.modules.find((item) => [item?.api_name, item?.module_name, item?.plural_label, item?.singular_label].filter(Boolean).some((value) => normalizeLabel(value) === normalized));
    if (!match) throw createAppError('MODULE_NOT_FOUND', `Zoho CRM module '${module}' was not found.`, 404, { module });
    if (match.api_supported === false || match.viewable === false) throw createAppError('MODULE_UNAVAILABLE', `Zoho CRM module '${module}' is not available for read operations.`, 400, { module, module_api_name: match.api_name });
    return match;
  }

  clearMetadataCache(module) {
    if (module) this.metadataCache.delete(module);
    else this.metadataCache.clear();
  }

  async refreshMetadata(module) {
    if (module) return this.getFieldMetadata(module, { forceRefresh: true });
    return this.getModulesMetadata({ forceRefresh: true });
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

function buildDynamicCoqlQuery({ module, fields, filters, filter_expression: filterExpression, sort, having_filter: havingFilter }) {
  const clauses = buildFilterClauses(filters || []);
  let query = `select ${fields.join(', ')} from ${module}`;
  query += ` where ${filterExpression ? buildLogicalFilterClause(filterExpression) : (clauses.length > 0 ? buildWhereClause(clauses) : '(id is not null)')}`;
  if (sort) {
    const sorts = Array.isArray(sort) ? sort : [sort];
    query += ` order by ${sorts.map(({ field, order }) => `${field} ${order}`).join(', ')}`;
  }
  if (havingFilter) query += ` having ${buildWhereClause(buildFilterClauses([havingFilter]))}`;
  return query;
}

function mapZohoStatus(status, upstreamCode) {
  if (upstreamCode === 'OAUTH_SCOPE_MISMATCH' || upstreamCode === 'AUTHENTICATION_FAILURE') return 401;
  if (upstreamCode === 'NO_PERMISSION') return 403;
  return [400, 401, 403, 404, 429].includes(status) ? status : 502;
}

function safeZohoDetails(error, requiredScope) {
  const response = error.response;
  const payload = response?.data;
  return {
    endpoint: error?.zohoDiagnostics?.endpoint,
    method: error?.zohoDiagnostics?.method,
    upstream_status: response?.status,
    upstream_code: typeof payload?.code === 'string' ? payload.code : undefined,
    upstream_message: typeof payload?.message === 'string' ? payload.message : undefined
    ,required_read_scope: requiredScope
  };
}

function safeEndpoint(url) {
  try {
    const parsed = new URL(String(url));
    return `${parsed.pathname}${parsed.search}`;
  } catch (_error) {
    return String(url || 'not_reached').replace(/https?:\/\/[^/]+/i, '');
  }
}

function normalizeZohoErrorCode(error, fallback) {
  const upstreamCode = String(error.response?.data?.code || '').trim();
  if (upstreamCode) return upstreamCode;
  const status = error.response?.status;
  if (status === 401) return 'AUTHENTICATION_FAILURE';
  if (status === 403) return 'NO_PERMISSION';
  if (status === 404) return 'INVALID_MODULE';
  if (status === 429) return 'RATE_LIMIT';
  if (status >= 500) return 'INTERNAL_ERROR';
  return fallback;
}

function createZohoOperationError(error, operation, scope) {
  const upstreamCode = String(error.response?.data?.code || '');
  const statusCode = mapZohoStatus(error.response?.status, upstreamCode);
  const code = normalizeZohoErrorCode(error, 'ZOHO_READ_ERROR');
  const message = upstreamCode === 'OAUTH_SCOPE_MISMATCH'
    ? `Zoho denied the read operation '${operation}' because the OAuth client lacks the required read scope.`
    : `Unable to execute the Zoho read operation '${operation}'.`;
  return createAppError(code, message, statusCode, {
    ...safeZohoDetails(error, scope),
    operation,
    required_read_scope: scope
  });
}

function assertReadOnlyRequest(method, url) {
  const normalizedMethod = String(method || '').toLowerCase();
  if (normalizedMethod === 'get') return;
  if (normalizedMethod === 'post' && (/\/oauth\/v2\/token$/i.test(url) || /\/coql$/i.test(url) || /\/read$/i.test(url))) return;
  throw createAppError('READ_ONLY_OPERATION_BLOCKED', `Blocked non-read Zoho request: ${normalizedMethod.toUpperCase()} ${String(url).replace(/https?:\/\/[^/]+/i, '')}`, 403);
}

function normalizeCrmBaseUrl(value) {
  const url = value.replace(/\/$/, '');
  return /\/crm\/v\d+$/i.test(url) ? url : `${url}/crm/v8`;
}

function normalizeFieldMetadata(rawFields) {
  if (!Array.isArray(rawFields)) return [];
  return rawFields
    .map((field) => {
      if (typeof field === 'string') return { api_name: field };
      if (!field || typeof field !== 'object') return null;
      const apiName = field.api_name || field.apiName || field.name;
      return apiName ? { ...field, api_name: apiName } : null;
    })
    .filter(Boolean);
}

function normalizeLabel(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function extractBulkJobId(payload) {
  return payload?.details?.id || payload?.details?.job_id || payload?.id || payload?.data?.[0]?.details?.id || payload?.data?.[0]?.id || null;
}

module.exports = { ZohoCrmService, normalizeCrmBaseUrl };
