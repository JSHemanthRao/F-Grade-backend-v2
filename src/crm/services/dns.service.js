const axios = require('axios');

const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\.?$/i;
const RECORD_TYPE_ALIASES = {
  SPF: 'TXT',
  DMARC: 'TXT',
  NAMESERVER: 'NS',
  NAMESERVERS: 'NS',
};

function normalizeDomain(input) {
  if (!input) {
    throw new Error('A valid domain name is required for DNS lookup.');
  }

  const cleaned = String(input || '').trim()
    .replace(/^(?:https?:\/\/|dns:\/\/|ftp:\/\/)/i, '')
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, '')
    .replace(/\.$/, '')
    .trim();

  if (!cleaned || cleaned.includes(' ') || !HOSTNAME_PATTERN.test(cleaned)) {
    throw new Error(`Invalid domain: ${cleaned || input}`);
  }

  return cleaned.toLowerCase();
}

function buildRecordKey(type) {
  return String(type || '').trim().toUpperCase();
}

function normalizeRequestedTypes(requestedTypes = []) {
  const normalized = [];
  requestedTypes.forEach((type) => {
    const key = buildRecordKey(type);
    if (!key) return;
    normalized.push(RECORD_TYPE_ALIASES[key] || key);
  });
  return [...new Set(normalized)];
}

function normalizeApiRecords(records = []) {
  return records.map((record) => {
    const type = buildRecordKey(record.type || record.TYPE || '');
    const name = String(record.name || record.hostname || record.host || record.domain || '').trim();
    const ttl = Number.isFinite(Number(record.ttl)) ? Number(record.ttl) : null;
    const rawData = record.data ?? record.value ?? record.address ?? record.exchange ?? record.nsname ?? record.hostname ?? record.host;
    let value = '';
    let priority = null;

    if (rawData !== undefined && rawData !== null) {
      if (typeof rawData === 'object') {
        if (Number.isFinite(Number(rawData.priority))) {
          priority = Number(rawData.priority);
        }
        value = rawData.exchange || rawData.host || rawData.value || rawData.address || JSON.stringify(rawData);
      } else {
        value = String(rawData);
      }
    }

    if (!value && record.value !== undefined) {
      value = String(record.value);
    }

    if (!value && record.address !== undefined) {
      value = String(record.address);
    }

    return {
      type,
      name,
      value,
      ttl,
      priority,
    };
  }).filter((record) => record.type && record.name && record.value);
}

function aggregateDnsRecords(records = []) {
  const aggregated = {};

  normalizeApiRecords(records).forEach((record) => {
    if (!aggregated[record.type]) aggregated[record.type] = [];
    aggregated[record.type].push(record);
  });

  return aggregated;
}

async function queryLiveDnsApi(domain) {
  try {
    const response = await axios.get('https://dns-lookup.com/api/dns', {
      params: { domain },
      timeout: 10000,
    });

    if (response?.status !== 200 || !response?.data || !Array.isArray(response.data.records)) {
      throw new Error('DNS API returned invalid data.');
    }

    return response.data.records;
  } catch (error) {
    throw new Error(`Unable to retrieve DNS records for ${domain} at this time.`);
  }
}

async function resolveDnsRecords(domain) {
  const normalizedDomain = normalizeDomain(domain);
  const apiRecords = await queryLiveDnsApi(normalizedDomain);
  return aggregateDnsRecords(apiRecords);
}

function filterDnsRecords(records, requestedTypes = []) {
  if (!records || typeof records !== 'object') return {};

  const normalizedTypes = normalizeRequestedTypes(requestedTypes);
  if (normalizedTypes.length === 0) return { ...records };

  const filtered = {};
  normalizedTypes.forEach((type) => {
    filtered[type] = records[type] || [];
  });

  return filtered;
}

function flattenDnsRecords(records, requestedTypes = []) {
  const normalizedTypes = normalizeRequestedTypes(requestedTypes);
  const types = normalizedTypes.length > 0 ? normalizedTypes : Object.keys(records);
  const flattened = [];

  types.forEach((type) => {
    const entries = Array.isArray(records[type]) ? records[type] : [];
    entries.forEach((entry) => {
      const rawPriority = entry.priority;
      const priority = rawPriority === undefined || rawPriority === null ? null : Number(rawPriority);

      flattened.push({
        type,
        name: entry.name || '',
        value: entry.value || '',
        priority: Number.isFinite(priority) ? priority : null,
        ttl: Number.isFinite(Number(entry.ttl)) ? Number(entry.ttl) : null,
      });
    });
  });

  return flattened;
}

function buildDnsTables(records) {
  const rows = records.map((record) => [
    record.type || '',
    record.name || '',
    record.value || '',
    record.priority !== null && record.priority !== undefined ? String(record.priority) : '',
    record.ttl !== null && record.ttl !== undefined ? String(record.ttl) : '',
  ]);

  const markdown = [
    '| Type | Name | Value | Priority | TTL |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');

  return [{
    title: 'DNS Records',
    columns: ['Type', 'Name', 'Value', 'Priority', 'TTL'],
    rows,
    markdown,
  }];
}

function formatDnsResponse({ domain, completeRecords, filteredRecords, requestedRecords = [] }) {
  const normalizedTypes = normalizeRequestedTypes(requestedRecords);
  const recordList = normalizedTypes.length > 0 ? normalizedTypes : Object.keys(completeRecords).sort();
  const missingTypes = normalizedTypes.filter((type) => !(filteredRecords[type] && filteredRecords[type].length > 0));
  let summary;

  if (normalizedTypes.length > 0) {
    if (missingTypes.length === normalizedTypes.length) {
      if (missingTypes.length === 1) {
        summary = `No ${missingTypes[0]} record was found for ${domain}.`;
      } else {
        summary = `No ${missingTypes.join(' and ')} records were found for ${domain}.`;
      }
    } else {
      summary = `DNS ${recordList.join(', ')} records for ${domain}.`;
    }
  } else {
    summary = `DNS records for ${domain}.`;
  }

  const flattened = flattenDnsRecords(filteredRecords, requestedRecords);

  return {
    success: true,
    source: 'DNS Checker',
    domain,
    summary,
    data: filteredRecords,
    records: flattened,
    completeRecords,
    requestedRecords: normalizedTypes,
    tables: buildDnsTables(flattened),
  };
}

module.exports = {
  normalizeDomain,
  resolveDnsRecords,
  filterDnsRecords,
  formatDnsResponse,
  normalizeRequestedTypes,
};
