const { zohoClient } = require('../../common/config/axios');
const logger = require('../../common/logging/logger');
const metadataService = require('./crm-metadata.service');

const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const DEFAULT_LIMIT = 100;

class CRMActivityError extends Error {
  constructor(message, status = 500, details = null) {
    super(message);
    this.name = 'CRMActivityError';
    this.status = status;
    this.details = details;
  }
}

/**
 * Calculates half-open date range for today in the given timezone (default Asia/Kolkata).
 * start = today 00:00:00+05:30
 * end   = tomorrow 00:00:00+05:30
 */
function getTodayDateRange(timezone = DEFAULT_TIMEZONE, referenceDate = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const dateStr = formatter.format(referenceDate); // e.g. "2026-08-14"
  const [y, m, d] = dateStr.split('-').map(Number);

  const tomorrowDate = new Date(Date.UTC(y, m - 1, d + 1));
  const tomorrowStr = tomorrowDate.toISOString().slice(0, 10);

  const offset = '+05:30';
  const from = `${dateStr}T00:00:00${offset}`;
  const to = `${tomorrowStr}T00:00:00${offset}`;

  return { date: dateStr, timezone, from, to };
}

function formatIsoInTimezone(dateInput, offset = '+05:30') {
  if (!dateInput) return null;
  const raw = String(dateInput).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return `${raw}T00:00:00${offset}`;
  }
  const date = new Date(raw);
  if (Number.isNaN(date.valueOf())) return raw;
  return date.toISOString();
}

function mapModuleToActivityType(moduleApiName) {
  const normalized = String(moduleApiName || '').toLowerCase();
  if (normalized.includes('deal')) return 'deal';
  if (normalized.includes('meeting') || normalized.includes('event')) return 'meeting';
  if (normalized.includes('note')) return 'note';
  if (normalized.includes('task')) return 'task';
  if (normalized.includes('call')) return 'call';
  if (normalized.includes('lead')) return 'lead';
  if (normalized.includes('contact')) return 'contact';
  if (normalized.includes('account')) return 'account';
  return 'record_change';
}

function getRecordDisplayName(record, moduleApiName) {
  if (!record) return 'Untitled Record';
  return (
    record.Deal_Name ||
    record.Subject ||
    record.Title ||
    record.Account_Name ||
    record.Company_Name ||
    record.Company ||
    record.Full_Name ||
    (record.First_Name || record.Last_Name ? `${record.First_Name || ''} ${record.Last_Name || ''}`.trim() : null) ||
    record.Vendor_Name ||
    record.Partner_Name ||
    record.Enterprise_Name ||
    record.name ||
    `Record #${record.id || 'N/A'}`
  );
}

function normalizeAuditEntry(entry) {
  if (!entry) return null;

  const doneBy = entry.done_by || entry.audited_by || entry.user || {};
  const userId = String(doneBy.id || entry.user_id || doneBy.ID || '');
  const userName = doneBy.name || doneBy.user_name || entry.user_name || 'Unknown User';

  const record = entry.record || entry.related_record || {};
  const recordId = String(record.id || entry.record_id || '');
  const moduleApiName = entry.module || entry.module_api_name || record.module || 'Deals';
  const moduleLabel = metadataService.resolveModuleLabel(moduleApiName);

  const rawAction = String(entry.action || entry.audit_action || 'created').toLowerCase();
  let action = 'created';
  if (rawAction.includes('add') || rawAction.includes('note')) action = 'added';
  else if (rawAction.includes('update') || rawAction.includes('change') || rawAction.includes('edit')) action = 'updated';
  else if (rawAction.includes('delete')) action = 'deleted';

  return {
    user_id: userId,
    user_name: userName,
    module: moduleLabel,
    module_api_name: moduleApiName,
    record_id: recordId,
    record_name: record.name || getRecordDisplayName(record, moduleApiName),
    action,
    activity_type: mapModuleToActivityType(moduleApiName),
    audited_time: entry.audited_time || entry.created_time || entry.timestamp || new Date().toISOString(),
    source: entry.source || 'crm_ui',
  };
}

function normalizeModuleRecord(record, moduleApiName, actionType = 'created') {
  const createdBy = record.Created_By || record.Owner || record.Modified_By || {};
  const userId = String(createdBy.id || record.Owner?.id || record.Modified_By?.id || '');
  const userName = createdBy.name || record.Owner?.name || record.Modified_By?.name || 'Unknown User';
  const moduleLabel = metadataService.resolveModuleLabel(moduleApiName);
  const activityType = mapModuleToActivityType(moduleApiName);

  let action = actionType;
  if (actionType === 'created') {
    if (activityType === 'note') action = 'added';
    else action = 'created';
  } else if (actionType === 'updated') {
    action = record.Stage ? 'Stage changed' : 'updated';
  }

  const auditedTime = actionType === 'updated'
    ? (record.Modified_Time || record.Created_Time || new Date().toISOString())
    : (record.Created_Time || record.Modified_Time || new Date().toISOString());

  return {
    user_id: userId,
    user_name: userName,
    module: moduleLabel,
    module_api_name: moduleApiName,
    record_id: String(record.id || ''),
    record_name: getRecordDisplayName(record, moduleApiName),
    action,
    activity_type: activityType,
    audited_time: auditedTime,
    source: 'crm_ui',
  };
}

function isScopeError(error) {
  const status = error?.response?.status;
  const message = String(error?.response?.data?.message || error?.message || '').toLowerCase();
  return status === 401 || status === 403 || message.includes('scope') || message.includes('oauth');
}

function extractMissingScope(error) {
  const message = String(error?.response?.data?.message || error?.message || '');
  if (/settings\.audit_logs/i.test(message)) return 'ZohoCRM.settings.audit_logs.READ';
  if (/settings\.modules/i.test(message)) return 'ZohoCRM.settings.modules.READ';
  if (/settings\.fields/i.test(message)) return 'ZohoCRM.settings.fields.READ';
  if (/users/i.test(message)) return 'ZohoCRM.users.READ';
  if (/modules/i.test(message)) return 'ZohoCRM.modules.ALL';
  return 'ZohoCRM.settings.audit_logs.READ';
}

async function fetchAuditLogsFromZoho(from, to, options = {}) {
  try {
    // Try Audit API endpoint if supported
    const response = await zohoClient.get('/crm/v8/settings/audit_log_records', {
      ...(options.signal ? { signal: options.signal } : {}),
      params: {
        start_time: from,
        end_time: to,
        ...(options.user_id ? { user_id: options.user_id } : {}),
      },
    });

    const rawRecords = Array.isArray(response.data?.audit_log_records)
      ? response.data.audit_log_records
      : Array.isArray(response.data?.data)
        ? response.data.data
        : [];

    return rawRecords.map(normalizeAuditEntry).filter(Boolean);
  } catch (error) {
    if (isScopeError(error)) {
      const missingScope = extractMissingScope(error);
      logger.warn('CRM Activity Service', {
        event: 'audit_log_scope_missing',
        missingScope,
        error: error.message,
      });
      // Return null to signal fallback to module records
      return null;
    }
    logger.warn('CRM Activity Service', {
      event: 'audit_log_api_skipped',
      message: error.message,
    });
    return null;
  }
}

async function fetchModuleActivityRecords(moduleKey, from, to, options = {}) {
  const moduleEndpoint = metadataService.resolveModuleApiName(moduleKey);
  const criteria = `(Created_Time:greater_equal:${from})and(Created_Time:less_than:${to})`;

  try {
    const response = await zohoClient.get(`/crm/v8/${moduleEndpoint}`, {
      ...(options.signal ? { signal: options.signal } : {}),
      params: {
        criteria,
        per_page: Math.min(options.limit || DEFAULT_LIMIT, 200),
      },
    });

    const rawRecords = Array.isArray(response.data?.data)
      ? response.data.data
      : Array.isArray(response.data?.users)
        ? response.data.users
        : [];

    return rawRecords.map((r) => normalizeModuleRecord(r, moduleEndpoint, 'created'));
  } catch (error) {
    if (isScopeError(error)) {
      logger.warn('CRM Activity Service', {
        event: 'module_activity_scope_error',
        module: moduleEndpoint,
        error: error.message,
      });
    }
    // Return empty list on single module fetch error rather than crashing whole list
    return [];
  }
}

async function getActivity(options = {}) {
  const timezone = options.timezone || DEFAULT_TIMEZONE;
  const todayRange = getTodayDateRange(timezone);

  const from = options.from ? formatIsoInTimezone(options.from) : todayRange.from;
  const to = options.to ? formatIsoInTimezone(options.to) : todayRange.to;
  const dateStr = options.from ? String(options.from).slice(0, 10) : todayRange.date;
  const limit = Number.isInteger(Number(options.limit)) && Number(options.limit) > 0
    ? Math.min(Number(options.limit), 200)
    : DEFAULT_LIMIT;

  // Resolve user filter if provided
  let resolvedUser = null;
  if (options.user_id || options.user) {
    resolvedUser = await metadataService.resolveUser(options.user_id || options.user, options);
  }

  let activities = [];
  let fetchedFromAuditLog = false;

  // 1. Attempt Audit Log API
  const auditLogs = await fetchAuditLogsFromZoho(from, to, { ...options, user_id: resolvedUser?.id });
  if (Array.isArray(auditLogs) && auditLogs.length > 0) {
    activities = auditLogs;
    fetchedFromAuditLog = true;
  } else {
    // 2. Query key CRM modules for activity records
    const targetModules = options.module && options.module !== 'all'
      ? [options.module]
      : ['Deals', 'Meetings', 'Notes', 'Tasks', 'Calls', 'Leads', 'Contacts', 'Accounts'];

    const modulePromises = targetModules.map((m) => fetchModuleActivityRecords(m, from, to, { ...options, limit }));
    const moduleResults = await Promise.all(modulePromises);
    activities = moduleResults.flat();
  }

  // 3. Filter by User if specified
  if (resolvedUser) {
    const targetIdStr = String(resolvedUser.id).toLowerCase();
    const targetNameStr = String(resolvedUser.name).toLowerCase();

    activities = activities.filter((act) => {
      const actUserId = String(act.user_id || '').toLowerCase();
      const actUserName = String(act.user_name || '').toLowerCase();

      return (
        actUserId === targetIdStr ||
        actUserName.includes(targetNameStr) ||
        targetNameStr.includes(actUserName)
      );
    });
  }

  // 4. Filter by Action if specified (e.g. "created", "updated", "added")
  if (options.action && options.action !== 'all') {
    const targetAction = String(options.action).toLowerCase();
    activities = activities.filter((act) => String(act.action).toLowerCase().includes(targetAction));
  }

  // 5. Filter by Module if specified
  if (options.module && options.module !== 'all') {
    const targetModule = metadataService.resolveModuleLabel(options.module).toLowerCase();
    activities = activities.filter((act) => String(act.module).toLowerCase() === targetModule);
  }

  // Sort by audited_time ascending
  activities.sort((a, b) => new Date(a.audited_time).valueOf() - new Date(b.audited_time).valueOf());

  // Apply limit
  const boundedActivities = activities.slice(0, limit);

  return {
    success: true,
    date: dateStr,
    timezone,
    count: boundedActivities.length,
    data: boundedActivities,
  };
}

module.exports = {
  CRMActivityError,
  getActivity,
  getTodayDateRange,
  mapModuleToActivityType,
  normalizeAuditEntry,
  normalizeModuleRecord,
};
