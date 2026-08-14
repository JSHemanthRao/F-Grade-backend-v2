const { zohoClient } = require('../../common/config/axios');
const logger = require('../../common/logging/logger');
const metadataService = require('./crm-metadata.service');

const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const IST_OFFSET = '+05:30';
const DEFAULT_LIMIT = 100;
// Maximum polls for async export job (10 × 2 s = 20 s)
const EXPORT_MAX_POLLS = 10;
const EXPORT_POLL_MS = 2000;

class CRMActivityError extends Error {
  constructor(message, status = 500, details = null) {
    super(message);
    this.name = 'CRMActivityError';
    this.status = status;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/**
 * Calculates half-open date range for today in Asia/Kolkata.
 * Returns { date, from, to, timezone }
 * from = YYYY-MM-DDT00:00:00+05:30
 * to   = YYYY-MM-DDT00:00:00+05:30  (next calendar day)
 */
function getTodayDateRange(timezone = DEFAULT_TIMEZONE, referenceDate = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const dateStr = formatter.format(referenceDate); // "2026-08-14"
  const [y, m, d] = dateStr.split('-').map(Number);

  const tomorrowDate = new Date(Date.UTC(y, m - 1, d + 1));
  const tomorrowStr = tomorrowDate.toISOString().slice(0, 10);

  const from = `${dateStr}T00:00:00${IST_OFFSET}`;
  const to = `${tomorrowStr}T00:00:00${IST_OFFSET}`;

  return { date: dateStr, timezone, from, to };
}

/**
 * Given any date/time string or value, return a canonical IST timestamp string
 * suitable for Zoho API criteria WITHOUT conversion to UTC.
 * Handles:
 *   - "2026-08-14"                         → "2026-08-14T00:00:00+05:30"
 *   - "2026-08-14T00:00:00+05:30"          → unchanged
 *   - "2026-08-13T18:30:00Z" (UTC equiv)   → converted to IST string
 *   - "2026-08-14T00:00:00.000Z"           → converted to IST string
 */
function toISTString(dateInput) {
  if (!dateInput) return null;
  const raw = String(dateInput).trim();

  // Pure date — anchor to IST midnight
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T00:00:00${IST_OFFSET}`;

  // Already has +05:30 or an explicit offset that isn't Z — keep as-is
  if (/\+\d{2}:\d{2}$/.test(raw) || /-\d{2}:\d{2}$/.test(raw)) return raw;

  // UTC Z or no offset — parse and re-express in IST
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return raw; // can't parse, return raw

  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const istMs = ms + IST_OFFSET_MS;
  const d = new Date(istMs);
  const pad = (n) => String(n).padStart(2, '0');
  return [
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
    IST_OFFSET,
  ].join('');
}

// ---------------------------------------------------------------------------
// Module / record helpers
// ---------------------------------------------------------------------------

function mapModuleToActivityType(moduleApiName) {
  const n = String(moduleApiName || '').toLowerCase();
  if (n.includes('deal')) return 'deal';
  if (n.includes('meeting') || n.includes('event')) return 'meeting';
  if (n.includes('note')) return 'note';
  if (n.includes('task')) return 'task';
  if (n.includes('call')) return 'call';
  if (n.includes('lead')) return 'lead';
  if (n.includes('contact')) return 'contact';
  if (n.includes('account')) return 'account';
  return 'record_change';
}

function getRecordDisplayName(record) {
  if (!record) return 'Untitled Record';
  return (
    record.Deal_Name ||
    record.Event_Title ||
    record.Subject ||
    record.Note_Title ||
    record.Parent_Id?.name ||
    record.Account_Name ||
    record.Company_Name ||
    record.Company ||
    record.Full_Name ||
    (record.First_Name || record.Last_Name
      ? `${record.First_Name || ''} ${record.Last_Name || ''}`.trim()
      : null) ||
    record.Vendor_Name ||
    record.Partner_Name ||
    (record.Note_Content ? record.Note_Content.slice(0, 50) : null) ||
    record.name ||
    `Record #${record.id || 'N/A'}`
  );
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

/**
 * Normalizes a Zoho __timeline / audit-log entry into our standard shape.
 */
function normalizeAuditEntry(entry, fallbackModuleApiName = 'Unknown') {
  if (!entry) return null;

  const doneBy = entry.done_by || entry.audited_by || entry.user || {};
  const userId = String(doneBy.id || entry.user_id || '');
  const userName = doneBy.name || doneBy.user_name || entry.user_name || 'Unknown User';

  const rec = entry.record || entry.related_record || {};
  const recordId = String(rec.id || entry.record_id || '');
  const rawModule =
    entry.module?.api_name ||
    rec.module?.api_name ||
    entry.module ||
    rec.module ||
    entry.module_api_name ||
    fallbackModuleApiName;
  const moduleLabel = metadataService.resolveModuleLabel(rawModule);

  const rawAction = String(entry.action || 'created').toLowerCase();
  let action = 'created';
  if (rawAction.includes('add') || rawAction.includes('note')) action = 'added';
  else if (rawAction.includes('updat') || rawAction.includes('edit') || rawAction.includes('change')) action = 'updated';
  else if (rawAction.includes('delet')) action = 'deleted';

  const auditedTime = entry.audited_time || entry.created_time || entry.timestamp || new Date().toISOString();

  const item = {
    user_id: userId,
    user_name: userName,
    module: moduleLabel,
    module_api_name: rawModule,
    record_id: recordId,
    record_name: rec.name || getRecordDisplayName(rec),
    action,
    activity_type: mapModuleToActivityType(rawModule),
    time: auditedTime,
    audited_time: auditedTime,
    source: entry.source || 'crm_ui',
  };

  if (Array.isArray(entry.field_history) && entry.field_history.length > 0) {
    const stageField = entry.field_history.find((f) =>
      String(f.api_name || f.field || '').toLowerCase() === 'stage'
    );
    const primary = stageField || entry.field_history[0];
    if (primary) {
      item.field = primary.api_name || primary.field || null;
      item.old_value = primary._value?.old ?? primary.old_value ?? null;
      item.new_value = primary._value?.new ?? primary.new_value ?? null;
    }
  }

  return item;
}

/**
 * Normalizes a raw CRM module record (from /search) into our standard shape.
 */
function normalizeModuleRecord(record, moduleApiName, actionType = 'created') {
  const isUpdated =
    actionType === 'updated' ||
    (record.Modified_Time && record.Modified_Time !== record.Created_Time);
  const activeUser = isUpdated
    ? record.Modified_By || record.Created_By || record.Owner || {}
    : record.Created_By || record.Owner || record.Modified_By || {};

  const userId = String(activeUser.id || record.Owner?.id || '');
  const userName = activeUser.name || record.Owner?.name || 'Unknown User';
  const moduleLabel = metadataService.resolveModuleLabel(moduleApiName);
  const activityType = mapModuleToActivityType(moduleApiName);

  let action = isUpdated ? (record.Stage ? 'Stage changed' : 'updated') :
    (activityType === 'note' ? 'added' : 'created');

  const auditedTime = isUpdated
    ? record.Modified_Time || record.Created_Time || new Date().toISOString()
    : record.Created_Time || record.Modified_Time || new Date().toISOString();

  const item = {
    user_id: userId,
    user_name: userName,
    module: moduleLabel,
    module_api_name: moduleApiName,
    record_id: String(record.id || ''),
    record_name: getRecordDisplayName(record),
    action,
    activity_type: activityType,
    time: auditedTime,
    audited_time: auditedTime,
    source: 'crm_ui',
  };

  if (record.Stage) {
    item.field = 'Stage';
    item.new_value = record.Stage;
  }

  return item;
}

// ---------------------------------------------------------------------------
// Zoho Audit Log Export (primary strategy)
// ---------------------------------------------------------------------------

/**
 * Detects whether an Axios error is an OAuth scope mismatch.
 */
function isScopeMismatch(error) {
  const status = error?.response?.status;
  const code = error?.response?.data?.code;
  const msg = String(error?.response?.data?.message || error?.message || '').toLowerCase();
  return (
    status === 401 ||
    code === 'OAUTH_SCOPE_MISMATCH' ||
    msg.includes('scope') ||
    msg.includes('oauth')
  );
}

/**
 * Builds the criteria array for the Zoho audit log export API.
 * from / to must be in IST offset format already.
 * Returns the criteria group object.
 */
function buildAuditExportCriteria(from, to, { user_id, module, action } = {}) {
  const group = [
    {
      field: { api_name: 'audited_time' },
      comparator: 'between',
      value: [from, to],
    },
  ];

  if (user_id) {
    group.push({ field: { api_name: 'done_by' }, comparator: 'equal', value: user_id });
  }
  if (module && module !== 'all') {
    group.push({ field: { api_name: 'module' }, comparator: 'equal', value: module });
  }
  if (action && action !== 'all') {
    group.push({ field: { api_name: 'action' }, comparator: 'equal', value: action });
  }

  return { group, group_operator: 'and' };
}

/**
 * Submits a Zoho audit log export job.
 * Returns { job_id } on success.
 * Throws CRMActivityError on scope error or Zoho API failure.
 */
async function createAuditExportJob(from, to, filterOptions = {}) {
  const criteria = buildAuditExportCriteria(from, to, filterOptions);

  logger.info('[ACTIVITY EXPORT]', {
    from,
    to,
    user_id: filterOptions.user_id || null,
    module: filterOptions.module || null,
    action: filterOptions.action || null,
  });

  const payload = {
    audit_log_export: [{ criteria }],
  };

  let response;
  try {
    response = await zohoClient.post('/crm/v8/settings/audit_log_export', payload);
  } catch (error) {
    if (isScopeMismatch(error)) {
      const err = new CRMActivityError(
        'The Zoho OAuth token is missing the required scope: ZohoCRM.settings.audit_logs.CREATE. ' +
        'Please regenerate the token with the ZohoCRM.settings.audit_logs.ALL scope. ' +
        'The current token cannot be used to access the Audit Log export API.',
        403,
        {
          scope_required: 'ZohoCRM.settings.audit_logs.CREATE',
          fallback: 'multi_module_search',
        }
      );
      err.isScopeMismatch = true;
      throw err;
    }
    throw new CRMActivityError(
      `Zoho audit log export job creation failed: ${error.message}`,
      error.response?.status || 500,
      error.response?.data || null
    );
  }

  const jobs = response.data?.audit_log_export || [];
  const job = jobs[0];
  if (!job?.id) {
    throw new CRMActivityError(
      'Zoho audit log export API did not return a job ID.',
      500,
      response.data
    );
  }

  logger.info('[ACTIVITY EXPORT JOB]', { job_id: job.id, status: job.status || 'submitted' });
  return { job_id: job.id };
}

/**
 * Polls Zoho for audit log export job status until Finished or Failed.
 * Returns { status, download_url } on Finished.
 * Throws CRMActivityError on failure or timeout.
 */
async function pollAuditExportJob(jobId) {
  for (let poll = 0; poll < EXPORT_MAX_POLLS; poll++) {
    await new Promise((resolve) => setTimeout(resolve, EXPORT_POLL_MS));

    let resp;
    try {
      resp = await zohoClient.get(`/crm/v8/settings/audit_log_export/${jobId}`);
    } catch (error) {
      if (isScopeMismatch(error)) {
        const err = new CRMActivityError(
          'The Zoho OAuth token is missing the required scope: ZohoCRM.settings.audit_logs.READ.',
          403
        );
        err.isScopeMismatch = true;
        throw err;
      }
      throw new CRMActivityError(
        `Polling audit log export job failed: ${error.message}`,
        error.response?.status || 500
      );
    }

    const jobs = resp.data?.audit_log_export || [];
    const job = jobs[0] || {};
    const status = String(job.status || '').toLowerCase();

    logger.info('[ACTIVITY EXPORT JOB]', { job_id: jobId, status });

    if (status === 'completed' || status === 'finished') {
      return { status, download_url: job.download_url || null };
    }
    if (status === 'failed' || status === 'error') {
      throw new CRMActivityError(
        `Zoho audit log export job failed with status: ${job.status}`,
        500,
        job
      );
    }
    // still in_progress / queued — keep polling
  }

  throw new CRMActivityError(
    `Zoho audit log export job timed out after ${EXPORT_MAX_POLLS * EXPORT_POLL_MS / 1000} seconds.`,
    504
  );
}

/**
 * Downloads a CSV from the given URL and parses it into rows.
 * Returns Array<Object> with CSV column names as keys.
 */
async function downloadAndParseCSV(downloadUrl) {
  const https = require('https');
  const http = require('http');
  const zlib = require('zlib');
  const { Readable } = require('stream');

  const rawBuffer = await new Promise((resolve, reject) => {
    const client = downloadUrl.startsWith('https') ? https : http;
    client.get(downloadUrl, (res) => {
      const chunks = [];
      const stream = res.headers['content-encoding'] === 'gzip'
        ? res.pipe(zlib.createGunzip())
        : res;
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    }).on('error', reject);
  });

  const csvText = rawBuffer.toString('utf-8');
  const lines = csvText.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  const rows = lines.slice(1).map((line) => {
    // Simple CSV parse (handles quoted fields containing commas)
    const values = [];
    let current = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQuote = !inQuote;
      } else if (ch === ',' && !inQuote) {
        values.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    values.push(current.trim());
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = values[idx] !== undefined ? values[idx] : ''; });
    return obj;
  });

  logger.info('[ACTIVITY DOWNLOAD]', { format: 'csv', rows: rows.length });
  return rows;
}

/**
 * Maps a raw CSV row from the audit log export into our normalized activity shape.
 * Column names vary slightly by Zoho plan — we try several known variants.
 */
function normalizeAuditCSVRow(row) {
  if (!row) return null;

  const get = (...keys) => {
    for (const k of keys) {
      const val = row[k];
      if (val !== undefined && val !== null && val !== '') return val;
    }
    return null;
  };

  const userId = get('User ID', 'user_id', 'done_by_id', 'Done By ID');
  const userName = get('User Name', 'user_name', 'done_by', 'Done By', 'User');
  if (!userName) return null; // skip header/corrupt rows

  const rawModule = get('Module', 'module', 'Module Name', 'module_name') || 'Unknown';
  const moduleLabel = metadataService.resolveModuleLabel(rawModule);

  const rawAction = String(get('Action', 'action', 'Action Type') || 'created').toLowerCase();
  let action = 'created';
  if (rawAction.includes('add') || rawAction.includes('note')) action = 'added';
  else if (rawAction.includes('updat') || rawAction.includes('edit') || rawAction.includes('change')) action = 'updated';
  else if (rawAction.includes('delet')) action = 'deleted';

  const auditedTime = get('Audited Time', 'audited_time', 'Time', 'Date/Time', 'Timestamp') || new Date().toISOString();
  const recordId = get('Record ID', 'record_id', 'id') || '';
  const recordName = get('Record Name', 'record_name', 'Record Title') || `Record #${recordId}`;
  const fieldName = get('Field', 'field_name', 'Field Name', 'api_name') || null;
  const oldValue = get('Old Value', 'old_value', 'Before Value') || null;
  const newValue = get('New Value', 'new_value', 'After Value') || null;
  const source = get('Source', 'source', 'Action Source') || 'crm_ui';

  const item = {
    user_id: userId || '',
    user_name: userName,
    module: moduleLabel,
    module_api_name: rawModule,
    record_id: recordId,
    record_name: recordName,
    action,
    activity_type: mapModuleToActivityType(rawModule),
    time: auditedTime,
    audited_time: auditedTime,
    source,
  };

  if (fieldName) {
    item.field = fieldName;
    item.old_value = oldValue;
    item.new_value = newValue;
  }

  return item;
}

// ---------------------------------------------------------------------------
// Multi-module search + timeline (fallback strategy)
// ---------------------------------------------------------------------------

const MODULE_DEFINITIONS_FOR_ACTIVITY = [
  { key: 'deals', endpoint: 'Deals', label: 'Deals', hasTimeline: true },
  { key: 'notes', endpoint: 'Notes', label: 'Notes', hasTimeline: false },
  { key: 'meetings', endpoint: 'Events', label: 'Meetings', hasTimeline: true },
  { key: 'tasks', endpoint: 'Tasks', label: 'Tasks', hasTimeline: true },
  { key: 'calls', endpoint: 'Calls', label: 'Calls', hasTimeline: true },
  { key: 'leads', endpoint: 'Leads', label: 'Leads', hasTimeline: true },
  { key: 'contacts', endpoint: 'Contacts', label: 'Contacts', hasTimeline: true },
  { key: 'accounts', endpoint: 'Accounts', label: 'Accounts', hasTimeline: true },
];

async function fetchRecordTimelineSafe(moduleEndpoint, recordId, options = {}) {
  try {
    const response = await zohoClient.get(`/crm/v8/${moduleEndpoint}/${recordId}/__timeline`, {
      ...(options.signal ? { signal: options.signal } : {}),
      params: { per_page: 50 },
    });

    return Array.isArray(response.data?.__timeline)
      ? response.data.__timeline
      : Array.isArray(response.data?.data)
        ? response.data.data
        : [];
  } catch {
    return [];
  }
}

async function fetchModuleActivityRecords(moduleDef, from, to, options = {}) {
  const endpoint = moduleDef.endpoint;
  const criteria = `(((Created_Time:greater_equal:${from})and(Created_Time:less_than:${to}))or((Modified_Time:greater_equal:${from})and(Modified_Time:less_than:${to})))`;

  logger.info('[ZOHO ACTIVITY REQUEST]', {
    endpoint: `/crm/v8/${endpoint}/search`,
    filters: criteria,
  });

  try {
    const response = await zohoClient.get(`/crm/v8/${endpoint}/search`, {
      ...(options.signal ? { signal: options.signal } : {}),
      params: { criteria, per_page: Math.min(options.limit || DEFAULT_LIMIT, 200) },
    });

    if (response.status === 204 || !response.data) return [];

    const rawRecords = Array.isArray(response.data?.data) ? response.data.data : [];
    if (rawRecords.length === 0) return [];

    const fromTime = new Date(from).valueOf();
    const toTime = new Date(to).valueOf();

    const results = [];
    for (const record of rawRecords) {
      const createdTime = record.Created_Time ? new Date(record.Created_Time).valueOf() : null;
      const modifiedTime = record.Modified_Time ? new Date(record.Modified_Time).valueOf() : null;
      const isCreatedInRange = createdTime && createdTime >= fromTime && createdTime < toTime;
      const isModifiedInRange = modifiedTime && modifiedTime >= fromTime && modifiedTime < toTime;

      if (moduleDef.hasTimeline && (isCreatedInRange || isModifiedInRange)) {
        const entries = await fetchRecordTimelineSafe(endpoint, record.id, options);
        const inRange = entries.filter((e) => {
          const t = e.audited_time ? new Date(e.audited_time).valueOf() : null;
          return t && t >= fromTime && t < toTime;
        });

        if (inRange.length > 0) {
          for (const entry of inRange) {
            const normalized = normalizeAuditEntry(entry, endpoint);
            if (normalized) {
              if (!normalized.record_name || normalized.record_name === 'Untitled Record') {
                normalized.record_name = getRecordDisplayName(record);
              }
              results.push(normalized);
            }
          }
          continue;
        }
      }

      if (isCreatedInRange) results.push(normalizeModuleRecord(record, endpoint, 'created'));
      if (isModifiedInRange && modifiedTime !== createdTime) {
        results.push(normalizeModuleRecord(record, endpoint, 'updated'));
      }
    }

    return results;
  } catch (error) {
    if (error?.response?.status === 204 || error?.response?.status === 404) return [];
    logger.warn('[CRM Activity Service]', {
      event: 'module_activity_fetch_error',
      module: endpoint,
      error: error.message,
    });
    return [];
  }
}

async function fetchViaMultiModuleSearch(from, to, options = {}) {
  let targetDefs = MODULE_DEFINITIONS_FOR_ACTIVITY;

  if (options.module && options.module !== 'all') {
    const norm = String(options.module).trim().toLowerCase();
    targetDefs = MODULE_DEFINITIONS_FOR_ACTIVITY.filter(
      (m) => m.key === norm || m.endpoint.toLowerCase() === norm || m.label.toLowerCase() === norm
    );
    if (targetDefs.length === 0) {
      targetDefs = [{
        key: norm,
        endpoint: metadataService.resolveModuleApiName(options.module),
        label: options.module,
        hasTimeline: true,
      }];
    }
  }

  const results = await Promise.all(
    targetDefs.map((mDef) => fetchModuleActivityRecords(mDef, from, to, options))
  );
  return results.flat();
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function getActivity(options = {}) {
  const timezone = options.timezone || DEFAULT_TIMEZONE;
  const todayRange = getTodayDateRange(timezone);

  // Always resolve dates to IST strings — handles UTC input from Copilot
  const from = options.from ? toISTString(options.from) : todayRange.from;
  const to = options.to ? toISTString(options.to) : todayRange.to;
  const dateStr = options.from ? String(options.from).slice(0, 10) : todayRange.date;
  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
    ? Math.min(Number(options.limit), 200)
    : DEFAULT_LIMIT;

  logger.info('[ACTIVITY DEBUG]', {
    date_from: from,
    date_to: to,
    user_id: options.user_id || options.user || null,
    module: options.module || null,
  });

  // Resolve user filter
  let resolvedUser = null;
  if (options.user_id || options.user) {
    resolvedUser = await metadataService.resolveUser(options.user_id || options.user, options);
  }

  const filterOptions = {
    user_id: resolvedUser?.id || null,
    module: options.module || null,
    action: options.action || null,
    signal: options.signal || null,
    limit,
  };

  // ------------------------------------------------------------------
  // Strategy 1: Zoho Audit Log Export (async job → CSV download)
  // Requires ZohoCRM.settings.audit_logs.CREATE + READ scopes.
  // Falls back to Strategy 2 on scope mismatch.
  // ------------------------------------------------------------------
  let activities = [];
  let strategy = 'multi_module_search';

  try {
    const { job_id } = await createAuditExportJob(from, to, filterOptions);
    const { download_url } = await pollAuditExportJob(job_id);

    if (!download_url) {
      throw new CRMActivityError('Audit log export job completed but no download URL was returned.', 500);
    }

    const rows = await downloadAndParseCSV(download_url);
    activities = rows.map(normalizeAuditCSVRow).filter(Boolean);
    strategy = 'audit_log_export';

    logger.info('[ACTIVITY EXPORT]', { event: 'export_parsed', rows: rows.length, activities: activities.length });
  } catch (exportError) {
    if (exportError.isScopeMismatch) {
      // Expected — token lacks audit_log scope. Fall through to multi-module search.
      logger.info('[ACTIVITY EXPORT]', {
        event: 'audit_log_scope_missing',
        detail: exportError.message,
        fallback: 'multi_module_search',
      });
    } else {
      // Real export failure — propagate as error, do not silently return 0
      logger.error('[ACTIVITY EXPORT]', { event: 'export_failed', error: exportError.message });
      throw exportError;
    }
  }

  // ------------------------------------------------------------------
  // Strategy 2 (fallback): Multi-module /search + /__timeline
  // Uses only ZohoCRM.modules.ALL scope which the existing token has.
  // ------------------------------------------------------------------
  if (strategy === 'multi_module_search') {
    activities = await fetchViaMultiModuleSearch(from, to, { ...filterOptions, timezone, signal: options.signal });
  }

  // ------------------------------------------------------------------
  // Post-fetch filtering
  // ------------------------------------------------------------------
  const fromTime = new Date(from).valueOf();
  const toTime = new Date(to).valueOf();

  // Strict half-open date boundary filter [from, to)
  activities = activities.filter((act) => {
    const t = act.audited_time || act.time;
    if (!t) return false;
    const ms = new Date(t).valueOf();
    return ms >= fromTime && ms < toTime;
  });

  // User filter (when strategy=audit_log_export, Zoho already filters by user in criteria;
  // for fallback multi-module strategy, apply client-side filter)
  if (resolvedUser && strategy === 'multi_module_search') {
    const targetId = String(resolvedUser.id).toLowerCase();
    const targetName = String(resolvedUser.name).toLowerCase();
    activities = activities.filter((act) => {
      const id = String(act.user_id || '').toLowerCase();
      const name = String(act.user_name || '').toLowerCase();
      return id === targetId || name === targetName || name.includes(targetName) || targetName.includes(name);
    });
  }

  // Action filter
  if (options.action && options.action !== 'all') {
    const targetAction = String(options.action).toLowerCase();
    activities = activities.filter((act) => String(act.action).toLowerCase().includes(targetAction));
  }

  // Module filter (for audit log export results, if module not filtered server-side)
  if (options.module && options.module !== 'all' && strategy === 'audit_log_export') {
    const targetModule = metadataService.resolveModuleLabel(options.module).toLowerCase();
    activities = activities.filter((act) => String(act.module || '').toLowerCase() === targetModule);
  }

  // Sort ascending by time
  activities.sort((a, b) =>
    new Date(a.audited_time || a.time).valueOf() - new Date(b.audited_time || b.time).valueOf()
  );

  const bounded = activities.slice(0, limit);

  logger.info('[ACTIVITY RESULT]', { count: bounded.length, strategy });

  return {
    success: true,
    date: dateStr,
    timezone,
    count: bounded.length,
    data: bounded,
    strategy,
  };
}

module.exports = {
  CRMActivityError,
  getActivity,
  getTodayDateRange,
  toISTString,
  mapModuleToActivityType,
  normalizeAuditEntry,
  normalizeModuleRecord,
  normalizeAuditCSVRow,
  buildAuditExportCriteria,
};
