const DEFAULT_PER_PAGE = 200;
const MAX_PAGE_RECORDS = 2000;
const DEFAULT_LIMITED_PER_PAGE = 25;
const SINGLE_RECORD_PER_PAGE = 1;

const RETRIEVAL_STRATEGIES = {
  COUNT: 'count',
  AGGREGATE: 'aggregate',
  SINGLE_RECORD: 'single_record',
  PAGINATED_LIST: 'paginated_list',
  FULL_DATASET: 'full_dataset',
  COMPLETE_MATCHING_DATASET: 'full_dataset',
};

const RETRIEVAL_MODES = {
  AUTO: 'auto',
  PAGE: 'page',
  ALL: 'all',
  COUNT: 'count',
  AGGREGATE: 'aggregate',
};

const FULL_RETRIEVAL_PATTERNS = [
  /\ball\b/,
  /\bevery\b/,
  /\bcomplete\b/,
  /\bentire\b/,
  /\bsum\b/,
  /\bsummary\b/,
  /\bfiltered\b/,
  /\bgrouped\b/,
  /\breport\b/,
  /\banalytics?\b/,
  /\bdashboard\b/,
  /\bcompare\b/,
  /\bcomparison\b/,
  /\bconversion\b/,
  /\brate\b/,
  /\brevenue\b/,
  /\bamount\b/,
  /\baverage\b/,
  /\bhighest\b/,
  /\blowest\b/,
  /\btop\b/,
  /\bmonthly\b/,
  /\boverall\b/,
  /\bcomplete\s+list\b/,
  /\bfrom\b/,
  /\bbusiness\s+summary\b/,
  /\boverdue\b/,
  /\bclosed\b/,
  /\bactive\b/,
  /\bcreated\b/,
  /\bowned\s+by\b/,
  /\bowner\b/,
  /\bstage\b/,
  /\bassigned\s+to\b/,
  /\bwhere\b/,
  /\bwith\b/,
  /\bmatching\b/,
  /\b(this|last)\s+month\b/,
  /\blast\s+\d+\s+months?\b/,
  /\blast\s+year\b/,
  /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/,
  /\b(?:between|from)\b.*\b(?:and|to)\b/,
  /\b(?:search|find|lookup|look\s+for)\b/,
  /\b(?:above|below|greater\s+than|less\s+than|over|under)\b/,
];

const COUNT_INTENT_PATTERNS = [
  /\bhow\s+many\b/,
  /\bnumber\s+of\b/,
  /\bcount\b/,
  /\btotal\b/,
];

const LIMITED_COUNT_PATTERN = /\b(?:first|latest|recent|newest|last|only|limit(?:ed)?\s+to|show)\s+(\d{1,3})\b/i;
const NEXT_COUNT_PATTERN = /\bnext\s+(\d{1,3})\b/i;
const PAGE_PATTERN = /\bpage\s+(\d{1,6})\b/i;
const PER_PAGE_PATTERN = /\bper_page\s*=\s*(\d{1,6})\b/i;
const FIELD_EQUALS_PATTERN = /\b(?:where|with)\s+([a-z][a-z0-9_\s]*?)\s*(?:=|equals|is)\s*["']?([^"',?]+)["']?/i;

function isValue(value, expected) {
  return value !== undefined && value !== null && value !== '' && Number(value) === expected;
}

function hasExplicitPagination(options = {}, requestText = getRequestText(options)) {
  const hasPage = options.page !== undefined && options.page !== null && options.page !== '';
  const hasPerPage = options.per_page !== undefined && options.per_page !== null && options.per_page !== '';
  const isCopilotDefault = isValue(options.page, 1) && isValue(options.per_page, 25);

  // Copilot Studio adds these values to every request. They are transport
  // defaults, not evidence that the user asked for a one-page result.
  if (isCopilotDefault) {
    return false;
  }

  return hasPage || hasPerPage;
}

function normalizeText(value) {
  if (value === undefined || value === null) {
    return '';
  }

  if (Array.isArray(value)) {
    return value.map(normalizeText).filter(Boolean).join(' ');
  }

  if (typeof value === 'object') {
    return Object.values(value).map(normalizeText).filter(Boolean).join(' ');
  }

  return String(value).trim();
}

function getRequestText(options = {}) {
  return normalizeText(
    options.requestText
    || options.request_text
    || options.userQuery
    || options.user_query
    || options.question
    || options.prompt
    || options.message
    || options.search
  );
}

function hasFullRetrievalIntent(requestText) {
  const normalizedRequestText = String(requestText || '').toLowerCase();

  return FULL_RETRIEVAL_PATTERNS.some((pattern) => pattern.test(normalizedRequestText));
}

function hasCountIntent(requestText) {
  const normalizedRequestText = String(requestText || '').toLowerCase();

  return COUNT_INTENT_PATTERNS.some((pattern) => pattern.test(normalizedRequestText));
}

function hasExplicitFilter(options = {}) {
  return options.criteria !== undefined && options.criteria !== null && options.criteria !== ''
    || options.filters !== undefined && options.filters !== null && options.filters !== '';
}

function parsePositiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function clampPerPage(value) {
  const parsed = parsePositiveInteger(value);

  if (!parsed) {
    return null;
  }

  return Math.min(parsed, DEFAULT_PER_PAGE);
}

function getSingularModuleTerms(moduleDefinition = {}) {
  const label = normalizeText(moduleDefinition.label).toLowerCase();
  const endpoint = normalizeText(moduleDefinition.endpoint).replace(/_/g, ' ').toLowerCase();
  const terms = new Set([label, endpoint]);

  Array.from(terms).forEach((term) => {
    if (term.endsWith('ies')) {
      terms.add(`${term.slice(0, -3)}y`);
    } else if (term.endsWith('s')) {
      terms.add(term.slice(0, -1));
    }
  });

  return Array.from(terms).filter(Boolean).sort((a, b) => b.length - a.length);
}

function getSpecificRecordSearchTerm(requestText, moduleDefinition) {
  if (!requestText) {
    return null;
  }

  const moduleTerms = getSingularModuleTerms(moduleDefinition);

  for (const term of moduleTerms) {
    const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b(?:show|get|find|lookup|display)\\s+(?:the\\s+)?${escapedTerm}\\s+(.+)$`, 'i');
    const match = requestText.match(pattern);

    if (match?.[1]) {
      const searchTerm = match[1]
        .replace(/[?.!,]+$/g, '')
        .trim();

      if (searchTerm) {
        return searchTerm;
      }
    }
  }

  return null;
}

function getSearchableFields(moduleDefinition = {}) {
  const fields = Array.isArray(moduleDefinition.defaultFields)
    ? moduleDefinition.defaultFields
    : [];

  const preferredFields = fields.filter((field) => (
    /(^|_)name$/i.test(field)
    || /name/i.test(field)
    || /email/i.test(field)
    || /^subject$/i.test(field)
    || /title/i.test(field)
    || /company/i.test(field)
  ));

  return preferredFields.length > 0 ? preferredFields.slice(0, 4) : fields.slice(0, 2);
}

function escapeCriteriaValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').trim();
}

function buildOrCriteria(fields, value) {
  const escapedValue = escapeCriteriaValue(value);
  const clauses = fields
    .filter(Boolean)
    .map((field) => `(${field}:equals:${escapedValue})`);

  if (clauses.length === 0) {
    return null;
  }

  return clauses.reduce((criteria, clause) => (
    criteria ? `(${criteria}or${clause})` : clause
  ), '');
}

function normalizeFieldName(fieldLabel) {
  return String(fieldLabel)
    .trim()
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('_')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');
}

function inferEqualityCriteria(requestText) {
  const match = requestText.match(FIELD_EQUALS_PATTERN);

  if (!match?.[1] || !match?.[2]) {
    return null;
  }

  const fieldName = normalizeFieldName(match[1]);
  const value = escapeCriteriaValue(match[2]);

  if (!fieldName || !value) {
    return null;
  }

  return `(${fieldName}:equals:${value})`;
}

function normalizeRetrievalMode(value) {
  const normalizedValue = String(value || '').trim().toLowerCase();

  if (
    normalizedValue === RETRIEVAL_MODES.AUTO
    || normalizedValue === RETRIEVAL_MODES.PAGE
    || normalizedValue === RETRIEVAL_MODES.ALL
    || normalizedValue === RETRIEVAL_MODES.COUNT
    || normalizedValue === RETRIEVAL_MODES.AGGREGATE
  ) {
    return normalizedValue;
  }

  return RETRIEVAL_MODES.AUTO;
}

function getEffectiveRetrievalMode(retrievalPlan, explicitMode) {
  if (explicitMode) {
    return normalizeRetrievalMode(explicitMode);
  }

  if (retrievalPlan.strategy === RETRIEVAL_STRATEGIES.COUNT) {
    return RETRIEVAL_MODES.COUNT;
  }

  if (retrievalPlan.strategy === RETRIEVAL_STRATEGIES.AGGREGATE) {
    return RETRIEVAL_MODES.AGGREGATE;
  }

  if (retrievalPlan.strategy === RETRIEVAL_STRATEGIES.FULL_DATASET) {
    return RETRIEVAL_MODES.ALL;
  }

  return RETRIEVAL_MODES.PAGE;
}

function logPageResponseDebug({ moduleKey, page, pageToken, info, recordsFetched }) {
  logger.debug('Retrieval Engine', {
    Module: moduleKey,
    'Zoho page fetched': page,
    'Records on page': recordsFetched,
    'info.count': info?.count ?? null,
    'info.more_records': info?.more_records ?? null,
    next_page_token: info?.next_page_token ?? null,
    page_token: pageToken || null,
  });
}

function logPaginationStopDebug({ moduleKey, page, pageToken, reason, info }) {
  logger.debug('Retrieval Engine', {
    Module: moduleKey,
    'Zoho page fetched': page,
    reason,
    'info.count': info?.count ?? null,
    'info.more_records': info?.more_records ?? null,
    next_page_token: info?.next_page_token ?? null,
    page_token: pageToken || null,
  });
}

function getRetrievalPlan(moduleDefinition, options = {}) {
  const requestText = getRequestText(options);
  const retrievalMode = normalizeRetrievalMode(options.retrieval_mode ?? options.retrievalMode);

  if (retrievalMode === RETRIEVAL_MODES.COUNT) {
    return {
      strategy: RETRIEVAL_STRATEGIES.COUNT,
      fetchAll: false,
      params: {},
      reason: 'retrieval_mode_count',
      retrievalMode,
    };
  }

  if (retrievalMode === RETRIEVAL_MODES.AGGREGATE) {
    return {
      strategy: RETRIEVAL_STRATEGIES.AGGREGATE,
      fetchAll: false,
      params: {},
      reason: 'retrieval_mode_aggregate',
      retrievalMode,
    };
  }

  if (retrievalMode === RETRIEVAL_MODES.ALL) {
    return {
      strategy: RETRIEVAL_STRATEGIES.FULL_DATASET,
      fetchAll: true,
      params: {},
      reason: 'retrieval_mode_all_full_dataset',
      retrievalMode,
    };
  }

  if (retrievalMode === RETRIEVAL_MODES.PAGE) {
    const pageMatch = requestText.match(PAGE_PATTERN);
    const requestedPage = pageMatch ? parsePositiveInteger(pageMatch[1]) : null;
    const perPageMatch = requestText.match(PER_PAGE_PATTERN);
    const requestedPerPage = perPageMatch ? clampPerPage(perPageMatch[1]) : null;
    const nextCountMatch = requestText.match(NEXT_COUNT_PATTERN);
    const requestedNextLimit = nextCountMatch ? clampPerPage(nextCountMatch[1]) : null;
    const limitMatch = requestText.match(LIMITED_COUNT_PATTERN);
    const requestedLimit = limitMatch ? clampPerPage(limitMatch[1]) : null;
    const hasNonDefaultPagination = hasExplicitPagination(options, requestText);

    if (!hasNonDefaultPagination && requestedNextLimit) {
      return {
        strategy: RETRIEVAL_STRATEGIES.PAGINATED_LIST,
        fetchAll: false,
        params: {
          page: 2,
          per_page: requestedNextLimit,
        },
        reason: 'requested_next_page',
        retrievalMode,
      };
    }

    if (!hasNonDefaultPagination && (requestedPage || requestedPerPage || requestedLimit)) {
      return {
        strategy: RETRIEVAL_STRATEGIES.PAGINATED_LIST,
        fetchAll: false,
        params: {
          page: requestedPage || 1,
          per_page: requestedPerPage || requestedLimit || DEFAULT_LIMITED_PER_PAGE,
        },
        reason: requestedPage ? 'requested_page' : 'requested_per_page',
        retrievalMode,
      };
    }

    return {
      strategy: RETRIEVAL_STRATEGIES.PAGINATED_LIST,
      fetchAll: false,
      params: {
        page: Number(options.page || 1),
        per_page: Number(options.per_page || DEFAULT_LIMITED_PER_PAGE),
      },
      reason: 'retrieval_mode_page',
      retrievalMode,
    };
  }

  if (hasCountIntent(requestText)) {
    return {
      strategy: RETRIEVAL_STRATEGIES.COUNT,
      fetchAll: false,
      params: {},
      reason: 'count_intent',
      retrievalMode,
    };
  }

  if (hasExplicitPagination(options, requestText)) {
    return {
      strategy: RETRIEVAL_STRATEGIES.PAGINATED_LIST,
      fetchAll: false,
      params: {},
      reason: 'explicit_pagination',
      retrievalMode,
    };
  }

  if (options.ids !== undefined && options.ids !== null && options.ids !== '') {
    return {
      strategy: RETRIEVAL_STRATEGIES.SINGLE_RECORD,
      fetchAll: false,
      params: {},
      reason: 'explicit_ids',
      retrievalMode,
    };
  }

  const inferredCriteria = !hasExplicitFilter(options) && requestText
    ? inferEqualityCriteria(requestText)
    : null;

  if (hasExplicitFilter(options) || inferredCriteria || (requestText && hasFullRetrievalIntent(requestText))) {
    return {
      strategy: RETRIEVAL_STRATEGIES.FULL_DATASET,
      fetchAll: true,
      params: inferredCriteria ? { criteria: inferredCriteria } : {},
      reason: hasExplicitFilter(options) || inferredCriteria
        ? 'filtered_complete_dataset'
        : 'complete_analysis_intent',
      retrievalMode,
    };
  }

  const pageMatch = requestText.match(PAGE_PATTERN);
  const requestedPage = pageMatch ? parsePositiveInteger(pageMatch[1]) : null;
  const perPageMatch = requestText.match(PER_PAGE_PATTERN);
  const requestedPerPage = perPageMatch ? clampPerPage(perPageMatch[1]) : null;

  if (requestedPage || requestedPerPage) {
    return {
      strategy: RETRIEVAL_STRATEGIES.PAGINATED_LIST,
      fetchAll: false,
      params: {
        page: requestedPage || 1,
        per_page: requestedPerPage || DEFAULT_PER_PAGE,
      },
      reason: requestedPage ? 'requested_page' : 'requested_per_page',
      retrievalMode,
    };
  }

  const limitMatch = requestText.match(LIMITED_COUNT_PATTERN);
  const requestedLimit = limitMatch ? clampPerPage(limitMatch[1]) : null;

  if (requestedLimit) {
    return {
      strategy: RETRIEVAL_STRATEGIES.PAGINATED_LIST,
      fetchAll: false,
      params: {
        page: 1,
        per_page: requestedLimit,
      },
      reason: 'requested_limited_count',
      retrievalMode,
    };
  }

  const specificSearchTerm = getSpecificRecordSearchTerm(requestText, moduleDefinition);

  if (specificSearchTerm) {
    const criteria = hasExplicitFilter(options)
      ? null
      : buildOrCriteria(getSearchableFields(moduleDefinition), specificSearchTerm);

    return {
      // A specifically named CRM record is a bounded lookup. The criteria
      // narrows the requested dataset to the matching record itself; this is
      // distinct from a filtered collection query such as "all Closed Won".
      strategy: RETRIEVAL_STRATEGIES.PAGINATED_LIST,
      fetchAll: false,
      params: {
        page: 1,
        per_page: SINGLE_RECORD_PER_PAGE,
        ...(criteria ? { criteria } : {}),
      },
      reason: 'specific_record_search',
      retrievalMode,
    };
  }

  return {
    strategy: RETRIEVAL_STRATEGIES.PAGINATED_LIST,
    fetchAll: false,
    params: {
      page: 1,
      per_page: DEFAULT_LIMITED_PER_PAGE,
    },
    reason: 'default_paginated_list',
    retrievalMode,
  };
}

async function fetchAllPages({
  moduleKey = null,
  fetchPage,
  baseParams = {},
  dataKey = 'data',
  perPage = DEFAULT_PER_PAGE,
  onPageFetched,
}) {
  const allRecords = [];
  const seenRecordIds = new Set();
  let duplicateRecordsRemoved = 0;
  let page = 1;
  let pagesFetched = 0;
  let pageToken = null;
  let lastPayload = null;
  let complete = false;
  const recordsPerCall = [];

  while (true) {
    const params = {
      ...baseParams,
      per_page: perPage,
    };
    const hasPageToken = Boolean(pageToken);
    const mode = hasPageToken ? 'page_token' : 'page';

    if (hasPageToken) {
      delete params.page;
      params.page_token = pageToken;
    } else {
      params.page = page;
    }

    const payload = await fetchPage(params);
    pagesFetched += 1;
    const pageRecords = Array.isArray(payload?.[dataKey]) ? payload[dataKey] : [];
    const info = payload?.info || {};
    recordsPerCall.push(pageRecords.length);

    lastPayload = payload || {};

    logger.debug('Retrieval Engine', {
      Module: moduleKey,
      mode,
      page: params.page ?? null,
      hasPageToken,
      recordsReceived: pageRecords.length,
    });

    logPageResponseDebug({
      moduleKey,
      page,
      pageToken,
      info,
      recordsFetched: pageRecords.length,
    });

    if (onPageFetched) {
      onPageFetched({ page, pageToken, recordsFetched: pageRecords.length });
    }

    const hasMore = info.more_records === true || info.has_more === true;

    if (pageRecords.length === 0) {
      if (hasMore) {
        const error = new Error(`Incomplete CRM retrieval for ${moduleKey || 'module'}: an empty page reported more records`);
        error.code = 'RETRIEVAL_INCOMPLETE';
        throw error;
      }
      logPaginationStopDebug({
        moduleKey,
        page,
        pageToken,
        reason: 'empty_page',
        info,
      });
      complete = true;
      break;
    }

    pageRecords.forEach((record) => {
      const recordId = record?.id ?? record?.ID;
      if (recordId === undefined || recordId === null || !seenRecordIds.has(String(recordId))) {
        if (recordId !== undefined && recordId !== null) seenRecordIds.add(String(recordId));
        allRecords.push(record);
      } else {
        duplicateRecordsRemoved += 1;
      }
    });

    if (!hasMore) {
      logPaginationStopDebug({
        moduleKey,
        page,
        pageToken,
        reason: 'info.more_records=false',
        info,
      });
      complete = true;
      break;
    }

    const nextPageToken = info.next_page_token;

    if (hasPageToken) {
      if (!nextPageToken) {
        const error = new Error(`Incomplete CRM retrieval for ${moduleKey || 'module'}: next page token is missing`);
        error.code = 'RETRIEVAL_INCOMPLETE';
        throw error;
      }
      pageToken = nextPageToken;
      page += 1;
      continue;
    }

    if (page * perPage >= MAX_PAGE_RECORDS) {
      if (!nextPageToken) {
        const error = new Error(`Incomplete CRM retrieval for ${moduleKey || 'module'}: Zoho did not provide a continuation token`);
        error.code = 'RETRIEVAL_INCOMPLETE';
        throw error;
      }

      pageToken = nextPageToken;
      page += 1;
      continue;
    }

    page += 1;
  }

  const mergedInfo = {
    ...((lastPayload && lastPayload.info) || {}),
    count: allRecords.length,
    page: 1,
    per_page: perPage,
    more_records: !complete,
  };
  Object.defineProperties(mergedInfo, {
    retrievalComplete: { value: complete, enumerable: false, configurable: true },
    pagesFetched: { value: pagesFetched, enumerable: false, configurable: true },
    duplicateRecordsRemoved: { value: duplicateRecordsRemoved, enumerable: false, configurable: true },
    recordsPerCall: { value: recordsPerCall, enumerable: false, configurable: true },
  });

  return {
    ...(lastPayload || {}),
    [dataKey]: allRecords,
    info: mergedInfo,
  };
}

module.exports = {
  DEFAULT_LIMITED_PER_PAGE,
  DEFAULT_PER_PAGE,
  fetchAllPages,
  getRetrievalPlan,
  hasExplicitPagination,
  RETRIEVAL_STRATEGIES,
  RETRIEVAL_MODES,
  SINGLE_RECORD_PER_PAGE,
  getRequestText,
  normalizeRetrievalMode,
  getEffectiveRetrievalMode,
  hasCountIntent,
  hasFullRetrievalIntent,
  inferEqualityCriteria,
};
const logger = require('../../common/logging/logger');
