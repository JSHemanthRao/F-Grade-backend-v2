const { getModuleDefinition } = require('./module-definition.service');

const DATE_WORDS = /\b(created[_\s]*time|created|closing[_\s]*date|modified[_\s]*time|modified|converted[_\s]*time|converted|this\s+month|current\s+month|month[-\s]+to[-\s]+date|last\s+month|previous\s+month|last\s+\d+\s+months?|last\s+year|between\s+dates?|date\s+range|january|february|march|april|may|june|july|august|september|october|november|december)\b/i;
const ANALYTICS_WORDS = /\b(average|avg|sum|total\s+(?:value|revenue)|revenue|comparison|compare|trend|analytics|distribution|growth|rate|top|bottom|ranking|between|join|conver(?:ted|sion|sions)|qualified|became\s+a\s+deal)\b/i;

function normalizeText(value) {
  return String(value || '').trim();
}

function getRequestText(options = {}) {
  return normalizeText(options.requestText || options.request_text || options.userQuery || options.question || options.prompt || options.message);
}

function shouldUseCoql(options = {}) {
  if (options.force_search) return false;
  if (options.queryPlan || options.intentPlan) {
    const structured = options.queryPlan || options.intentPlan;
    const mode = String(options.retrieval_mode || options.retrievalMode || '').toLowerCase();
    return Boolean(
      options.force_coql
      || ['SUM', 'AVG', 'MIN', 'MAX', 'COUNT'].includes(String(structured.operation || '').toUpperCase()) && mode !== 'page'
      || structured.startDate && structured.endDate && mode !== 'page'
      || structured.criteria && mode === 'all',
    );
  }
  const requestText = getRequestText(options);
  const criteria = normalizeText(options.criteria || options.filter || options.filters);
  const completeRetrieval = String(options.retrieval_mode || options.retrievalMode || '').toLowerCase() === 'all';
  const aggregateRetrieval = String(options.retrieval_mode || options.retrievalMode || '').toLowerCase() === 'aggregate';
  // Criteria-bearing list requests must stay on the Search API so the
  // retrieval engine can walk every Zoho page. Complete filtered requests
  // use COQL instead: Zoho permits a 2,000-row batch there, which preserves
  // complete-search semantics while avoiding dozens of 200-row calls.
  return Boolean(options.force_coql || aggregateRetrieval || ANALYTICS_WORDS.test(requestText)
    || (completeRetrieval && Boolean(criteria))
    || (DATE_WORDS.test(requestText) && !criteria));
}

function getQuarterWindow(quarterOffset = 0) {
  const now = new Date();
  const currentQuarter = Math.floor(now.getUTCMonth() / 3);
  const start = new Date(Date.UTC(now.getUTCFullYear(), (currentQuarter + quarterOffset) * 3, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), (currentQuarter + quarterOffset + 1) * 3, 1));
  return { start: start.toISOString().replace('.000Z', 'Z'), end: end.toISOString().replace('.000Z', 'Z') };
}

function getWeekWindow(weekOffset = 0) {
  const now = new Date();
  const day = now.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + mondayOffset + (weekOffset * 7)));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 7));
  return { start: start.toISOString().replace('.000Z', 'Z'), end: end.toISOString().replace('.000Z', 'Z') };
}

function getDateField(moduleKey, requestText, conversionFields = []) {
  const text = normalizeText(requestText).toLowerCase();
  if (moduleKey === 'leads' && /conver/.test(text)) {
    return conversionFields.find((field) => /converted.*(date|time)|converted_time/i.test(field)) || 'Converted_Date_Time';
  }
  if (moduleKey === 'deals' && /closed|closing/.test(text)) return 'Closing_Date';
  if (/modified/.test(text)) return 'Modified_Time';
  if (/created/.test(text)) return 'Created_Time';
  if (moduleKey === 'deals') return 'Closing_Date';
  return 'Created_Time';
}

function getMonthWindow(monthOffset = 0) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset + 1, 1));
  return { start: start.toISOString().replace('.000Z', 'Z'), end: end.toISOString().replace('.000Z', 'Z') };
}

function formatDateWindow(start, end) {
  return {
    start: start.toISOString().replace('.000Z', 'Z'),
    end: end.toISOString().replace('.000Z', 'Z'),
  };
}

function getRequestedDateWindow(requestText) {
  const text = normalizeText(requestText).toLowerCase();
  const now = new Date();
  const year = now.getUTCFullYear();
  const monthNames = 'january february march april may june july august september october november december'.split(' ');

  const rollingMonths = text.match(/last\s+(\d+)\s+months?/i);
  if (rollingMonths) {
    const start = new Date(Date.UTC(year, now.getUTCMonth() - Number(rollingMonths[1]), 1));
    // "Last N months" means completed months; the current month is not part
    // of this historical-only range.
    const end = new Date(Date.UTC(year, now.getUTCMonth(), 1));
    return formatDateWindow(start, end);
  }

  if (/\blast\s+year\b/i.test(text)) {
    return formatDateWindow(new Date(Date.UTC(year - 1, 0, 1)), new Date(Date.UTC(year, 0, 1)));
  }

  const explicit = text.match(/(?:between|from)\s+([a-z]+\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2})\s+(?:and|to)\s+([a-z]+\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2})/i);
  if (explicit) {
    const start = new Date(explicit[1]);
    const end = new Date(explicit[2]);
    if (!Number.isNaN(start.valueOf()) && !Number.isNaN(end.valueOf())) {
      end.setUTCDate(end.getUTCDate() + 1);
      return formatDateWindow(start, end);
    }
  }

  const namedMonth = monthNames.findIndex((name) => new RegExp(`\\b${name}\\b`, 'i').test(text));
  if (namedMonth >= 0) {
    const explicitYear = text.match(new RegExp(`\\b${monthNames[namedMonth]}\\s+(\\d{4})\\b`, 'i'));
    const targetYear = explicitYear ? Number(explicitYear[1]) : year;
    return formatDateWindow(new Date(Date.UTC(targetYear, namedMonth, 1)), new Date(Date.UTC(targetYear, namedMonth + 1, 1)));
  }

  return null;
}

function buildWhereClause(moduleKey, requestText, criteria, options = {}) {
  const text = normalizeText(requestText).toLowerCase();
  const conversionFields = options.conversion_fields || [];
  const clauses = [];
  if (/closed\s+won/.test(text)) clauses.push("Stage = 'Closed Won'");
  if (moduleKey === 'leads' && /conver/.test(text) && options.conversion_metric !== 'rate') {
    if (conversionFields.includes('Converted__s') || conversionFields.includes('Converted')) clauses.push(`${conversionFields.includes('Converted__s') ? 'Converted__s' : 'Converted'} = true`);
    if (/into\s+deals?|to\s+deals?/.test(text) && conversionFields.includes('Converted_Deal')) clauses.push('Converted_Deal is not null');
  }
  const requestedDateWindow = getRequestedDateWindow(text);
  if (requestedDateWindow) {
    const field = getDateField(moduleKey, text, conversionFields);
    clauses.push(`${field} >= '${requestedDateWindow.start}'`, `${field} < '${requestedDateWindow.end}'`);
  } else if (/this\s+week|this\s+month|current\s+month|month[-\s]+to[-\s]+date|last\s+month|previous\s+month|this\s+quarter|last\s+quarter/.test(text)) {
    const window = /week/.test(text)
      ? getWeekWindow(/last\s+week/.test(text) ? -1 : 0)
      : /quarter/.test(text)
      ? getQuarterWindow(/last\s+quarter/.test(text) ? -1 : 0)
      : getMonthWindow(/last\s+month|previous\s+month/.test(text) ? -1 : 0);
    const field = getDateField(moduleKey, text, conversionFields);
    clauses.push(`${field} >= '${window.start}'`, `${field} < '${window.end}'`);
  }
  if (criteria) {
    const translated = String(criteria).replace(
      /\(?([A-Za-z0-9_]+):(equals|greater_equal|greater_than|less_equal|less_than):([^\)]+)\)?/gi,
      (_match, field, operator, rawValue) => {
        const value = rawValue.trim().replace(/'/g, "\\'");
        const operators = { equals: '=', greater_equal: '>=', greater_than: '>', less_equal: '<=', less_than: '<' };
        return `${field} ${operators[operator.toLowerCase()]} '${value}'`;
      },
    );
    if (!translated) return null;

    // Period-specific comparison requests reuse the non-date criteria and
    // carry the date window in request text. Preserve both parts instead of
    // dropping the date whenever a reusable CRM criterion is present.
    const criteriaFields = new Set(
      [...translated.matchAll(/(?:^|and)([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|>=|<=|>|<)\s*/gi)]
        .map((match) => match[1].toLowerCase()),
    );
    const missingTextClauses = clauses.filter((clause) => {
      const field = clause.match(/^\(?\s*([A-Za-z_][A-Za-z0-9_]*)\s/);
      return field && !criteriaFields.has(field[1].toLowerCase());
    });
    return [translated, ...missingTextClauses].join(' and ');
  }
  return clauses.length ? clauses.map((clause) => `(${clause})`).join(' and ') : null;
}

function criteriaFromStructuredFilters(filters = []) {
  const clauses = [];
  filters.forEach((filter) => {
    if (!filter || filter.field === '*') return;
    const field = filter.field || filter.logicalField;
    if (!field) return;
    if (filter.operator === 'between' && Array.isArray(filter.value)) {
      clauses.push(`(${field}:greater_equal:${filter.value[0]})`, `(${field}:less_than:${filter.value[1]})`);
      return;
    }
    if (filter.operator === 'in' && Array.isArray(filter.value)) {
      clauses.push(`(${filter.value.map((value) => `${field}:equals:${value}`).join('or')})`);
      return;
    }
    if (filter.value !== undefined && filter.value !== null && filter.value !== '') {
      clauses.push(`(${field}:${filter.operator || 'equals'}:${filter.value})`);
    }
  });
  return clauses.join('and') || null;
}

function buildStructuredWhereClause(structuredPlan = {}, criteria) {
  const structuredCriteria = criteria || structuredPlan.criteria || criteriaFromStructuredFilters(structuredPlan.filters);
  let whereClause = structuredCriteria ? buildWhereClause('', '', structuredCriteria, {}) : null;
  const dateField = structuredPlan.dateField;
  const startDate = structuredPlan.startDate;
  const endDate = structuredPlan.endDate;
  if (dateField && startDate && endDate && !new RegExp(`\\b${dateField}\\b`, 'i').test(whereClause || '')) {
    const dateClauses = `${dateField} >= '${startDate}' and ${dateField} < '${endDate}'`;
    whereClause = whereClause ? `${whereClause} and ${dateClauses}` : dateClauses;
  }
  return whereClause;
}

function buildQueryPlan(moduleKey, options = {}) {
  const moduleDefinition = getModuleDefinition(moduleKey);
  if (!moduleDefinition) throw new Error(`Unsupported CRM module: ${moduleKey}`);
  const requestText = getRequestText(options);
  const useCoql = shouldUseCoql(options);
  const conversionFields = options.conversion_fields || (/conver|qualified|became\s+a\s+deal/i.test(requestText)
    ? ['Converted_Date_Time', 'Converted__s', 'Converted_Deal']
    : []);
  const structuredPlan = options.queryPlan || options.intentPlan || null;
  const requestedFields = Array.isArray(options.fields)
    ? options.fields
    : Array.isArray(structuredPlan?.fields)
      ? structuredPlan.fields
      : String(options.fields || '').split(',').map((field) => field.trim()).filter(Boolean);
  const baseFields = requestedFields.length > 0 ? requestedFields : (moduleDefinition.defaultFields || []);
  const fields = Array.from(new Set([...baseFields, ...conversionFields, 'id']));
  const whereClause = structuredPlan
    ? buildStructuredWhereClause(structuredPlan, options.criteria || options.filter || options.filters)
    : buildWhereClause(moduleKey, requestText, options.criteria || options.filter || options.filters, options);
  const selectExpression = fields.join(', ');
  const query = `select ${selectExpression} from ${moduleDefinition.endpoint}${whereClause ? ` where ${whereClause}` : ''}`;
  return {
    mode: useCoql ? 'coql' : 'search',
    moduleKey,
    endpoint: moduleDefinition.endpoint,
    fields,
    whereClause,
    query,
    structured: Boolean(structuredPlan),
  };
}

function isInvalidQueryError(error) {
  const data = error?.response?.data;
  return error?.response?.status === 400
    && (data?.code === 'INVALID_QUERY' || data?.code === 'INVALID_DATA' || /field is not available for search|invalid_query/i.test(data?.message || error?.message || ''));
}

module.exports = {
  buildQueryPlan,
  shouldUseCoql,
  isInvalidQueryError,
  getRequestText,
};
