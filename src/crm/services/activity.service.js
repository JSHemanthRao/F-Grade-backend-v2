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
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\+\d{2}:\d{2}|-\d{2}:\d{2})?$/.test(raw)) {
    return (raw.includes('+') || (raw.includes('-') && raw.lastIndexOf('-') > 10)) ? raw : `${raw}${offset}`;
  }
  return raw;
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
    record.Event_Title ||
    record.Subject ||
    record.Note_Title ||
    record.Parent_Id?.name ||
    record.Account_Name ||
    record.Company_Name ||
    record.Company ||
    record.Full_Name ||
    (record.First_Name || record.Last_Name ? `${record.First_Name || ''} ${record.Last_Name || ''}`.trim() : null) ||
    record.Vendor_Name ||
    record.Partner_Name ||
    record.Enterprise_Name ||
    (record.Note_Content ? record.Note_Content.slice(0, 50) : null) ||
    record.name ||
    `Record #${record.id || 'N/A'}`
  );
}

function normalizeAuditEntry(entry, moduleApiName = 'Deals') {
  if (!entry) return null;

  const doneBy = entry.done_by || entry.audited_by || entry.user || {};
  const userId = String(doneBy.id || entry.user_id || doneBy.ID || '');
  const userName = doneBy.name || doneBy.user_name || entry.user_name || 'Unknown User';

  const record = entry.record || entry.related_record || {};
  const recordId = String(record.id || entry.record_id || '');
  const rawModuleName = entry.module?.api_name || entry.module || record.module?.api_name || record.module || entry.module_api_name || moduleApiName || 'Deals';
  const moduleLabel = metadataService.resolveModuleLabel(rawModuleName);

  const rawAction = String(entry.action || entry.audit_action || 'created').toLowerCase();
  let action = 'created';
  if (rawAction.includes('add') || rawAction.includes('note')) action = 'added';
  else if (rawAction.includes('update') || rawAction.includes('change') || rawAction.includes('edit')) action = 'updated';
  else if (rawAction.includes('delete')) action = 'deleted';

  const auditedTime = entry.audited_time || entry.created_time || entry.timestamp || new Date().toISOString();

  const item = {
    user_id: userId,
    user_name: userName,
    module: moduleLabel,
    module_api_name: rawModuleName,
    record_id: recordId,
    record_name: record.name || getRecordDisplayName(record, rawModuleName),
    action,
    activity_type: mapModuleToActivityType(rawModuleName),
    time: auditedTime,
    audited_time: auditedTime,
    source: entry.source || 'crm_ui',
  };

  if (Array.isArray(entry.field_history) && entry.field_history.length > 0) {
    const stageChange = entry.field_history.find((f) => String(f.api_name || f.field).toLowerCase() === 'stage');
    const primary = stageChange || entry.field_history[0];
    if (primary) {
      item.field = primary.api_name || primary.field || 'Stage';
      item.old_value = primary._value?.old ?? primary.old_value ?? null;
      item.new_value = primary._value?.new ?? primary.new_value ?? null;
    }
  }

  return item;
}

function normalizeModuleRecord(record, moduleApiName, actionType = 'created') {
  const createdBy = record.Created_By || record.Owner || record.Modified_By || {};
  const modifiedBy = record.Modified_By || record.Created_By || record.Owner || {};

  const isUpdated = actionType === 'updated' || (record.Modified_Time && record.Modified_Time !== record.Created_Time);
  const activeUser = isUpdated ? modifiedBy : createdBy;

  const userId = String(activeUser.id || record.Owner?.id || '');
  const userName = activeUser.name || record.Owner?.name || 'Unknown User';
  const moduleLabel = metadataService.resolveModuleLabel(moduleApiName);
  const activityType = mapModuleToActivityType(moduleApiName);

  let action = actionType;
  if (!isUpdated) {
    if (activityType === 'note') action = 'added';
    else action = 'created';
  } else {
    action = record.Stage ? 'Stage changed' : 'updated';
  }

  const auditedTime = isUpdated
    ? (record.Modified_Time || record.Created_Time || new Date().toISOString())
    : (record.Created_Time || record.Modified_Time || new Date().toISOString());

  const item = {
    user_id: userId,
    user_name: userName,
    module: moduleLabel,
    module_api_name: moduleApiName,
    record_id: String(record.id || ''),
    record_name: getRecordDisplayName(record, moduleApiName),
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

    const entries = Array.isArray(response.data?.__timeline)
      ? response.data.__timeline
      : Array.isArray(response.data?.data)
        ? response.data.data
        : [];

    return entries;
  } catch (error) {
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
      params: {
        criteria,
        per_page: Math.min(options.limit || DEFAULT_LIMIT, 200),
      },
    });

    if (response.status === 204 || !response.data) {
      return [];
    }

    const rawRecords = Array.isArray(response.data?.data)
      ? response.data.data
      : Array.isArray(response.data?.users)
        ? response.data.users
        : [];

    if (rawRecords.length === 0) return [];

    const fromTime = new Date(from).valueOf();
    const toTime = new Date(to).valueOf();

    // Check if timeline enrichment is available for modified records
    const results = [];
    for (const record of rawRecords) {
      const createdTime = record.Created_Time ? new Date(record.Created_Time).valueOf() : null;
      const modifiedTime = record.Modified_Time ? new Date(record.Modified_Time).valueOf() : null;

      const isCreatedInRange = createdTime && createdTime >= fromTime && createdTime < toTime;
      const isModifiedInRange = modifiedTime && modifiedTime >= fromTime && modifiedTime < toTime;

      // For deals or records updated in range, try timeline for rich field history
      if (moduleDef.hasTimeline && (isModifiedInRange || isCreatedInRange)) {
        const timelineEntries = await fetchRecordTimelineSafe(endpoint, record.id, options);
        const inRangeTimeline = timelineEntries.filter((entry) => {
          const t = entry.audited_time ? new Date(entry.audited_time).valueOf() : null;
          return t && t >= fromTime && t < toTime;
        });

        if (inRangeTimeline.length > 0) {
          for (const entry of inRangeTimeline) {
            const normalized = normalizeAuditEntry(entry, endpoint);
            if (normalized) {
              if (!normalized.record_name || normalized.record_name === 'Record') {
                normalized.record_name = getRecordDisplayName(record, endpoint);
              }
              results.push(normalized);
            }
          }
          continue;
        }
      }

      // Fallback: direct module record normalization
      if (isCreatedInRange) {
        results.push(normalizeModuleRecord(record, endpoint, 'created'));
      }
      if (isModifiedInRange && modifiedTime !== createdTime) {
        results.push(normalizeModuleRecord(record, endpoint, 'updated'));
      }
    }

    return results;
  } catch (error) {
    // If search endpoint returned 204 or empty
    if (error?.response?.status === 204 || error?.response?.status === 404) {
      return [];
    }

    logger.warn('CRM Activity Service', {
      event: 'module_activity_fetch_error',
      module: endpoint,
      error: error.message,
    });
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

  logger.info('[ACTIVITY DEBUG]', {
    date_from: from,
    date_to: to,
    user_id: options.user_id || options.user || null,
    module: options.module || null,
  });

  // Resolve user filter if provided
  let resolvedUser = null;
  if (options.user_id || options.user) {
    resolvedUser = await metadataService.resolveUser(options.user_id || options.user, options);
  }

  // Determine target modules
  let targetDefs = MODULE_DEFINITIONS_FOR_ACTIVITY;
  if (options.module && options.module !== 'all') {
    const norm = String(options.module).trim().toLowerCase();
    targetDefs = MODULE_DEFINITIONS_FOR_ACTIVITY.filter(
      (m) => m.key === norm || m.endpoint.toLowerCase() === norm || m.label.toLowerCase() === norm
    );
    if (targetDefs.length === 0) {
      targetDefs = [{ key: norm, endpoint: metadataService.resolveModuleApiName(options.module), label: options.module, hasTimeline: true }];
    }
  }

  // Fetch activities from target modules in parallel
  const modulePromises = targetDefs.map((mDef) => fetchModuleActivityRecords(mDef, from, to, { ...options, limit }));
  const moduleResults = await Promise.all(modulePromises);
  let activities = moduleResults.flat();

  // Filter strictly to the half-open interval [from, to)
  const fromTime = new Date(from).valueOf();
  const toTime = new Date(to).valueOf();

  activities = activities.filter((act) => {
    const actTime = act.audited_time || act.time ? new Date(act.audited_time || act.time).valueOf() : null;
    return actTime && actTime >= fromTime && actTime < toTime;
  });

  // Filter by User if specified
  if (resolvedUser) {
    const targetIdStr = String(resolvedUser.id).toLowerCase();
    const targetNameStr = String(resolvedUser.name).toLowerCase();

    activities = activities.filter((act) => {
      const actUserId = String(act.user_id || '').toLowerCase();
      const actUserName = String(act.user_name || '').toLowerCase();

      return (
        actUserId === targetIdStr ||
        actUserName === targetNameStr ||
        actUserName.includes(targetNameStr) ||
        targetNameStr.includes(actUserName)
      );
    });
  }

  // Filter by Action if specified (e.g. "created", "updated", "added")
  if (options.action && options.action !== 'all') {
    const targetAction = String(options.action).toLowerCase();
    activities = activities.filter((act) => String(act.action).toLowerCase().includes(targetAction));
  }

  // Sort by audited_time ascending
  activities.sort((a, b) => new Date(a.audited_time || a.time).valueOf() - new Date(b.audited_time || b.time).valueOf());

  // Apply limit
  const boundedActivities = activities.slice(0, limit);

  logger.info('[ACTIVITY RESULT]', {
    count: boundedActivities.length,
  });

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

