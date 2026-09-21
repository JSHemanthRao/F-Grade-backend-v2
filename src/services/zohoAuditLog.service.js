const axios = require('axios');
const { getZohoConfig } = require('../config/zoho.config');
const { ZohoAuthService } = require('./zohoAuth.service');
const { createAppError } = require('../utils/errors');

class ZohoAuditLogService {
  constructor(httpClient = axios, configLoader = getZohoConfig, authService) {
    this.httpClient = httpClient;
    this.configLoader = configLoader;
    this.authService = authService || new ZohoAuthService(httpClient, configLoader);
  }

  async getAuditLogs(params = {}) {
    const config = this.configLoader();
    const token = await this.authService.getAccessToken();
    const baseUrl = (this.authService.getApiDomain() || config.apiBaseUrl).replace(/\/$/, '');
    const dateRange = params.date_range || todayDateRange();
    const criteria = [{ field: { api_name: 'audited_time' }, comparator: 'between', value: [dateRange.start, dateRange.end] }];
    if (params.entity) criteria.push({ field: { api_name: 'module' }, comparator: 'in', value: [{ api_name: params.entity }] });
    if (params.action) criteria.push({ field: { api_name: 'action' }, comparator: 'equals', value: params.action });
    if (params.user?.id) criteria.push({ field: { api_name: 'user' }, comparator: 'equals', value: params.user.id });
    const createResponse = await this.request('post', `${baseUrl}/settings/audit_log_export`, token, config, {
      audit_log_export: [{ criteria: { group_operator: 'and', group: criteria } }]
    });
    const job = createResponse.data?.audit_log_export?.[0] || createResponse.data?.details || createResponse.data;
    const jobId = job?.details?.id || job?.job_id || job?.id || createResponse.data?.details?.id;
    if (!jobId) throw createAppError('AUDIT_LOG_EXPORT_JOB_UNAVAILABLE', 'Zoho did not return an audit-log export job ID.', 502);

    let status;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      status = await this.request('get', `${baseUrl}/settings/audit_log_export/${encodeURIComponent(jobId)}`, token, config);
      const state = String(status.data?.audit_log_export?.[0]?.status || '').toLowerCase();
      if (state === 'finished') break;
      if (state === 'failed') throw createAppError('AUDIT_LOG_EXPORT_FAILED', 'Zoho audit-log export failed.', 502);
      if (attempt < 19) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const exportJob = status?.data?.audit_log_export?.[0];
    if (String(exportJob?.status || '').toLowerCase() !== 'finished') throw createAppError('AUDIT_LOG_EXPORT_TIMEOUT', 'Zoho audit-log export did not finish within the polling limit.', 504);
    const downloadUrl = exportJob.download_links?.[0];
    if (!downloadUrl) throw createAppError('AUDIT_LOG_DOWNLOAD_UNAVAILABLE', 'Zoho did not provide an audit-log download link.', 502);
    const download = await this.httpClient.get(downloadUrl, { responseType: 'text', timeout: config.timeoutMs });
    const records = parseCsv(String(download.data || ''));
    return { records, info: { count: records.length, more_records: false } };
  }

  async request(method, url, token, config, data) {
    try {
      return method === 'get'
        ? await this.httpClient.get(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` }, timeout: config.timeoutMs })
        : await this.httpClient.post(url, data, { headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' }, timeout: config.timeoutMs });
    } catch (error) {
      if (error.response?.status === 401) this.authService.clearToken?.();
      throw createAppError(error.response?.status === 403 ? 'ZOHO_AUTHORIZATION_ERROR' : 'AUDIT_LOG_REQUEST_FAILED', error.response?.data?.message || 'Unable to retrieve Zoho Audit Log data.', error.response?.status || 502, { operation: 'audit_log' });
    }
  }
}

function parseCsv(csv) {
  const lines = csv.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? null]));
  });
}

function splitCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1; } else quoted = !quoted;
    } else if (char === ',' && !quoted) { values.push(value.trim()); value = ''; } else value += char;
  }
  values.push(value.trim());
  return values;
}

module.exports = { ZohoAuditLogService };

function todayDateRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}
