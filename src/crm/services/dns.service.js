const dns = require('dns').promises;

const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\.?$/i;
const FALLBACK_RECORD_TYPES = ['A', 'AAAA', 'MX', 'NS', 'CNAME', 'TXT', 'SOA', 'CAA', 'SRV', 'NAPTR', 'PTR', 'TLSA'];
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
    throw new Error('A valid domain name is required for DNS lookup.');
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

function aggregateDnsRecords(records = []) {
  const aggregated = {};

  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const type = buildRecordKey(record.type || record.TYPE || null);
    if (!type) continue;

    if (!aggregated[type]) aggregated[type] = [];

    switch (type) {
      case 'A':
      case 'AAAA':
        if (record.address) aggregated[type].push(record.address);
        break;
      case 'MX':
        aggregated[type].push({ exchange: record.exchange || record.value || null, priority: record.priority });
        break;
      case 'NS':
      case 'CNAME':
        aggregated[type].push(record.value || record.nsname || record.hostname || record.host || null);
        break;
      case 'TXT':
        if (Array.isArray(record.entries)) {
          aggregated[type].push(record.entries);
        } else if (Array.isArray(record.text)) {
          aggregated[type].push(record.text);
        } else if (record.value) {
          aggregated[type].push(record.value);
        } else {
          aggregated[type].push(record);
        }
        break;
      default:
        aggregated[type].push(record);
        break;
    }
  }

  for (const type of Object.keys(aggregated)) {
    aggregated[type] = aggregated[type].filter((item) => item !== undefined && item !== null);
  }

  return aggregated;
}

async function queryRecord(domain, type) {
  try {
    switch (type) {
      case 'A': return { [type]: await dns.resolve4(domain) };
      case 'AAAA': return { [type]: await dns.resolve6(domain) };
      case 'MX': return { [type]: await dns.resolveMx(domain) };
      case 'NS': return { [type]: await dns.resolveNs(domain) };
      case 'CNAME': return { [type]: await dns.resolveCname(domain) };
      case 'TXT': return { [type]: await dns.resolveTxt(domain) };
      case 'SOA': return { [type]: await dns.resolveSoa(domain) };
      case 'CAA': return { [type]: await dns.resolveCaa(domain) };
      case 'SRV': return { [type]: await dns.resolveSrv(domain) };
      case 'NAPTR': return { [type]: await dns.resolveNaptr(domain) };
      case 'PTR': return { [type]: await dns.resolvePtr(domain) };
      case 'TLSA': return { [type]: await dns.resolveTlsa(domain) };
      default: return {}; 
    }
  } catch (error) {
    const suppressedDnsErrors = new Set([
      'ENODATA', 'ENOTFOUND', 'ENODOMAIN', 'EAI_NONAME', 'ENOTIMP', 'ENOTTL', 'EBADRESP',
      'ECONNREFUSED', 'ETIMEOUT', 'ECONNRESET', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_SERVICE',
      'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'ECONNABORTED', 'EAI_MEMORY', 'EAI_OVERFLOW',
    ]);
    if (!error || !error.code || suppressedDnsErrors.has(error.code)) {
      return { [type]: [] };
    }
    return { [type]: [] };
  }
}

async function resolveDnsRecordSet(domain) {
  const results = {};

  for (const type of FALLBACK_RECORD_TYPES) {
    const answer = await queryRecord(domain, type);
    if (Array.isArray(answer[type]) && answer[type].length > 0) {
      results[type] = answer[type];
    } else if (answer[type] && typeof answer[type] === 'object' && Object.keys(answer[type]).length > 0) {
      results[type] = [answer[type]];
    }
  }

  return results;
}

async function resolveDnsRecords(domain) {
  const normalizedDomain = normalizeDomain(domain);
  let aggregated = {};
  let resolveAnyError = null;

  try {
    const anyAnswers = await dns.resolveAny(normalizedDomain);
    aggregated = aggregateDnsRecords(anyAnswers);
  } catch (error) {
    resolveAnyError = error;
  }

  const missingTypes = FALLBACK_RECORD_TYPES.filter((type) => !Object.prototype.hasOwnProperty.call(aggregated, type));
  if (missingTypes.length > 0) {
    const fallback = await resolveDnsRecordSet(normalizedDomain);
    Object.assign(aggregated, fallback);
  }

  if (Object.keys(aggregated).length === 0) {
    if (resolveAnyError && ['ENOTFOUND', 'ENODOMAIN', 'EAI_NONAME'].includes(resolveAnyError.code)) {
      throw new Error(`Domain ${normalizedDomain} could not be resolved.`);
    }
    return {};
  }

  return aggregated;
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

function serializeDnsRecord(record) {
  if (record === undefined || record === null) return '';
  if (Array.isArray(record)) return record.map(serializeDnsRecord).join(' ');
  if (typeof record === 'object') {
    if (record.exchange || record.priority !== undefined) {
      return `${record.exchange || ''}${record.priority !== undefined ? ` (priority ${record.priority})` : ''}`.trim();
    }
    if (record.value || record.nsname || record.hostname || record.host) {
      return String(record.value || record.nsname || record.hostname || record.host);
    }
    return JSON.stringify(record);
  }
  return String(record);
}

function buildDnsTables(records, requestedRecords = []) {
  const recordTypes = normalizeRequestedTypes(requestedRecords).length > 0
    ? normalizeRequestedTypes(requestedRecords)
    : Object.keys(records).sort();

  const rows = [];
  recordTypes.forEach((type) => {
    const values = records[type] || [];
    if (values.length === 0) {
      rows.push([type, '']);
      return;
    }

    values.forEach((value, index) => {
      rows.push([index === 0 ? type : '', serializeDnsRecord(value)]);
    });
  });

  const columns = ['Record Type', 'Value'];
  const markdown = [
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map(([type, value]) => `| ${type} | ${String(value).replace(/\|/g, '\\|')} |`),
  ].join('\n');

  return [{
    title: 'DNS Records',
    columns,
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

  return {
    success: true,
    source: 'DNS Checker',
    domain,
    summary,
    data: filteredRecords,
    completeRecords,
    requestedRecords: normalizedTypes,
    tables: buildDnsTables(filteredRecords, normalizedTypes),
  };
}

module.exports = {
  normalizeDomain,
  resolveDnsRecords,
  filterDnsRecords,
  formatDnsResponse,
  normalizeRequestedTypes,
};
