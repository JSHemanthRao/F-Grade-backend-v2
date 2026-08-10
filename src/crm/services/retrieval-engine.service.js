const { zohoClient } = require('../../common/config/axios');
const { DEBUG_ASSISTANT, NODE_ENV } = require('../../common/config/env');
const { getModuleDefinition } = require('./module-definition.service');
const { buildQueryPlan, isInvalidQueryError } = require('./query-builder.service');
const logger = require('../../common/logging/logger');
const {
  DEFAULT_PER_PAGE,
  fetchAllPages,
  getRetrievalPlan,
  inferEqualityCriteria,
  getRequestText,
  hasExplicitPagination,
  normalizeRetrievalMode,
  getEffectiveRetrievalMode,
  RETRIEVAL_STRATEGIES,
} = require('./retrieval-policy.service');

function normalizeModuleKey(moduleKey) {
  if (!moduleKey) {
    throw new Error('Unsupported CRM module: module key is required');
  }

  const normalizedKey = String(moduleKey).trim().toLowerCase();
  const moduleDefinition = getModuleDefinition(normalizedKey);

  if (!moduleDefinition) {
    throw new Error(`Unsupported CRM module: ${moduleKey}`);
  }

  return normalizedKey;
}

function normalizeFields(fields) {
  if (!fields) {
    return [];
  }

  if (Array.isArray(fields)) {
    return fields.filter(Boolean).map((field) => String(field).trim()).filter(Boolean);
  }

  return String(fields)
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean);
}

function getRetrievalCache(options = {}) {
  return options.retrievalCache instanceof Map ? options.retrievalCache : null;
}

function buildCacheKey(moduleKey, options = {}) {
  const cacheOptions = Object.entries(options)
    .filter(([key]) => key !== 'retrievalCache')
    .sort(([left], [right]) => left.localeCompare(right))
    .reduce((result, [key, value]) => ({ ...result, [key]: value }), {});
  return JSON.stringify({ module: moduleKey, options: cacheOptions });
}

function getRecordDateRange(records = []) {
  const dates = records
    .flatMap((record) => Object.entries(record || {}))
    .filter(([field, value]) => /date|time/i.test(field) && value)
    .map(([, value]) => new Date(value))
    .filter((date) => !Number.isNaN(date.valueOf()))
    .sort((left, right) => left - right);

  return dates.length > 0
    ? { start: dates[0].toISOString(), end: dates[dates.length - 1].toISOString() }
    : null;
}

function addRetrievalMetadata(result, options = {}, pagesFetched = 1, complete = true, duplicateRecordsRemoved = 0) {
  const dataKey = Array.isArray(result?.data) ? 'data' : 'users';
  const records = Array.isArray(result?.[dataKey]) ? result[dataKey] : [];
  const info = result?.info || {};
  const enrichedInfo = { ...info };
  Object.defineProperties(enrichedInfo, {
    requestedRange: { value: options.requestedRange || options.range || getRequestText(options) || null, enumerable: false, configurable: true },
    retrievedRange: { value: getRecordDateRange(records), enumerable: false, configurable: true },
    coveragePercentage: { value: complete ? 100 : null, enumerable: false, configurable: true },
    recordCount: { value: records.length, enumerable: false, configurable: true },
    pagesFetched: { value: pagesFetched, enumerable: false, configurable: true },
    retrievalComplete: { value: complete, enumerable: false, configurable: true },
    duplicateRecordsRemoved: { value: duplicateRecordsRemoved, enumerable: false, configurable: true },
  });
  return {
    ...result,
    info: enrichedInfo,
  };
}

function buildQueryParams(moduleKey, options = {}) {
  const params = {};
  const moduleDefinition = getModuleDefinition(moduleKey);
  const {
    page,
    per_page,
    ids,
    fields: requestedFields,
    criteria,
    filter,
    filters,
    sort_by,
    sort_order,
  } = options;

  const normalizedFields = normalizeFields(requestedFields);
  const fields = normalizedFields.length > 0
    ? normalizedFields.slice(0, 50)
    : moduleDefinition.defaultFields || [];

  const pageValue = Number(page);
  const perPageValue = Number(per_page);

  if (Number.isFinite(pageValue) && pageValue > 0) {
    params.page = pageValue;
  }

  if (Number.isFinite(perPageValue) && perPageValue > 0) {
    params.per_page = perPageValue;
  }

  if (ids) {
    params.ids = Array.isArray(ids) ? ids.join(',') : String(ids);
  }

  if (fields.length > 0) {
    params.fields = fields.join(',');
  }

  const criteriaValue = criteria ?? filter ?? filters;

  if (criteriaValue !== undefined && criteriaValue !== null && criteriaValue !== '') {
    params.criteria = typeof criteriaValue === 'string' ? criteriaValue : JSON.stringify(criteriaValue);
  }

  if (sort_by !== undefined && sort_by !== null && sort_by !== '') {
    params.sort_by = String(sort_by);
  }

  if (sort_order !== undefined && sort_order !== null && sort_order !== '') {
    params.sort_order = String(sort_order);
  }

  return {
    params,
    fields,
  };
}


function getRequestedUrl(requestConfig = {}) {
  if (!requestConfig.baseURL || !requestConfig.url) {
    return requestConfig.url || null;
  }

  try {
    return new URL(requestConfig.url, requestConfig.baseURL).toString();
  } catch (error) {
    return requestConfig.url || null;
  }
}

function logRequestDebug(moduleKey, moduleConfig, queryParams, fields) {
  if (NODE_ENV === 'production') {
    return;
  }

  logger.debug('Retrieval Engine', {
    requestedModule: moduleKey,
    endpoint: moduleConfig.endpoint,
    queryParameters: queryParams,
    fields,
  });
}

function extractInvalidFields(error, fields = []) {
  const responseData = error?.response?.data;
  const responseText = typeof responseData === 'string'
    ? responseData
    : responseData?.message || error?.message || '';

  if (!responseText) {
    return [];
  }

  const fieldMatches = responseText.match(/field '([^']+)'/gi) || [];
  const invalidFields = fieldMatches
    .map((match) => match.replace(/^field\s+'|'+$/gi, '').trim())
    .filter(Boolean);

  return invalidFields.length > 0 ? invalidFields : [];
}

function logRequestError(error, moduleKey, moduleConfig, queryParams, fields) {
  const requestUrl = getRequestedUrl(error?.config || {});
  const invalidFields = extractInvalidFields(error, fields);

  logger.error('Retrieval Engine', {
    requestedModule: moduleKey,
    endpoint: moduleConfig.endpoint,
    queryParameters: queryParams,
    fields,
    invalidFields,
    httpStatus: error?.response?.status || null,
    responseBody: error?.response?.data || null,
    errorMessage: error?.message || null,
    requestedUrl: requestUrl,
    error,
  });

  if (invalidFields.length > 0) {
    error.invalidFields = invalidFields;
    error.message = `${error.message || 'Zoho rejected the request'} (invalid field(s): ${invalidFields.join(', ')})`;
  }
}

function logRetrievalPlan(moduleKey, options, retrievalPlan) {
  logger.debug('Retrieval Engine', {
    module: moduleKey,
    'Received page': options.page ?? null,
    'Received per_page': options.per_page ?? null,
    strategy: retrievalPlan.strategy,
    reason: retrievalPlan.reason,
  });
}

function logRetrievalComplete(moduleKey, pagesFetched, totalRecords, responseDetails = {}) {
  logger.debug('Retrieval Engine', {
    module: moduleKey,
    'Pages fetched': pagesFetched,
    'Total merged records': totalRecords,
    responseDetails,
  });

  if (DEBUG_ASSISTANT) {
    logger.info('Retrieval Engine', {
      module: moduleKey,
      pagesFetched,
      totalRecords,
      responseDetails,
    });
  }
}

function logCountComplete(moduleKey, count) {
  logger.debug('Retrieval Engine', {
    module: moduleKey,
    count,
  });
}

function logRetrievalTelemetry({ moduleKey, criteria, fields, calls, recordsPerCall, totalMatchingRecords, startedAt }) {
  if (!DEBUG_ASSISTANT) return;
  const perCall = Array.isArray(recordsPerCall) ? recordsPerCall : [];
  logger.info('CRM Retrieval Telemetry', {
    module: moduleKey,
    crmCalls: calls,
    criteria: criteria || null,
    fields,
    recordsReturnedPerCall: perCall,
    totalRecordsExamined: perCall.reduce((total, count) => total + count, 0),
    totalMatchingRecords,
    executionTimeMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
  });
}

function normalizeCriteriaValue(criteriaValue) {
  if (criteriaValue === undefined || criteriaValue === null || criteriaValue === '') {
    return null;
  }

  return typeof criteriaValue === 'string' ? criteriaValue : JSON.stringify(criteriaValue);
}

function formatZohoDate(date) {
  return date.toISOString().replace('.000Z', 'Z');
}

function getMonthRangeCriteria(fieldName, monthOffset = 0) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset + 1, 1, 0, 0, 0, 0));

  return `((${fieldName}:greater_equal:${formatZohoDate(start)})and(${fieldName}:less_than:${formatZohoDate(end)}))`;
}

function getPreferredField(moduleDefinition, candidates) {
  const fields = Array.isArray(moduleDefinition.defaultFields) ? moduleDefinition.defaultFields : [];

  for (const candidate of candidates) {
    if (fields.some((field) => String(field).toLowerCase() === String(candidate).toLowerCase())) {
      return candidate;
    }
  }

  return candidates[0] || null;
}

function buildCountCriteria(moduleKey, moduleDefinition, options = {}, requestText = '') {
  const explicitCriteria = normalizeCriteriaValue(options.criteria ?? options.filter ?? options.filters);

  if (explicitCriteria) {
    return explicitCriteria;
  }

  const inferredEqualityCriteria = inferEqualityCriteria(requestText);

  if (inferredEqualityCriteria) {
    return inferredEqualityCriteria;
  }

  const normalizedText = String(requestText || '').toLowerCase();

  const criteriaParts = [];

  if (/\bclosed\s+won\b/.test(normalizedText)) {
    const stageField = getPreferredField(moduleDefinition, ['Stage', 'Deal_Stage']);

    if (stageField) {
      criteriaParts.push(`(${stageField}:equals:Closed Won)`);
    }
  }

  if (/\b(this|last)\s+month\b/.test(normalizedText)) {
    const dateField = getPreferredField(moduleDefinition, ['Closing_Date', 'Created_Time', 'Modified_Time']);

    if (dateField) {
      criteriaParts.push(getMonthRangeCriteria(dateField, /\blast\s+month\b/.test(normalizedText) ? -1 : 0));
    }
  }

  if (/\bfrom\s+advertisement\b/.test(normalizedText) || /\bcame\s+from\s+advertisement\b/.test(normalizedText)) {
    const sourceField = getPreferredField(moduleDefinition, ['Lead_Source', 'Deal_Source', 'Source']);

    if (sourceField) {
      return `(${sourceField}:equals:Advertisement)`;
    }
  }

  if (moduleKey === 'leads' && /\badvertisement\b/.test(normalizedText)) {
    return '(Lead_Source:equals:Advertisement)';
  }

  return criteriaParts.length > 0 ? criteriaParts.join('and') : null;
}

async function executeCountRequest(moduleKey, moduleDefinition, options = {}) {
  const requestText = getRequestText(options);
  const criteria = buildCountCriteria(moduleKey, moduleDefinition, options, requestText);
  const params = {};

  if (criteria) {
    params.criteria = criteria;
  }

  logGeneratedQuery({
    mode: 'search',
    moduleKey,
    query: `/crm/v8/${moduleDefinition.endpoint}/actions/count${criteria ? `?criteria=${criteria}` : ''}`,
    whereClause: criteria || null,
  });

  logRequestDebug(moduleKey, moduleDefinition, params, []);

  if (DEBUG_ASSISTANT) {
    logger.info('Retrieval Engine', {
      module: moduleKey,
      requestText,
      criteria,
      params,
    });
  }

  const response = await zohoClient.get(
    `/crm/v8/${moduleDefinition.endpoint}/actions/count`,
    { params }
  );

  const count = Number(response.data?.count ?? 0);

  if (DEBUG_ASSISTANT) {
    logger.info('Retrieval Engine', {
      module: moduleKey,
      count,
      responseData: response.data,
    });
  }

  logCountComplete(moduleKey, count);

  return {
    data: [],
    info: {
      count,
      more_records: false,
      page: 1,
      per_page: 1,
      retrievalStrategy: RETRIEVAL_STRATEGIES.COUNT,
    },
  };
}

function logGeneratedQuery(queryPlan) {
  logger.info('Retrieval Engine', {
    mode: queryPlan.mode,
    module: queryPlan.moduleKey,
    query: queryPlan.query,
    whereClause: queryPlan.whereClause,
  });
}

async function executeCoqlCount(moduleKey, moduleDefinition, queryPlan) {
  const query = `select count(id) as result_value from ${moduleDefinition.endpoint}${queryPlan.whereClause ? ` where ${queryPlan.whereClause}` : ''}`;
  logger.info('Retrieval Engine', { mode: 'coql', module: moduleKey, query });
  const response = await zohoClient.post('/crm/v8/coql', { select_query: query });
  const row = response.data?.data?.[0] || {};
  const count = Number(row.result_value ?? row.count ?? 0);
  return {
    data: [],
    info: { count, more_records: false, page: 1, per_page: 1, retrievalStrategy: 'coql' },
  };
}

function getAggregateField(moduleDefinition, requestedField) {
  const availableFields = Array.isArray(moduleDefinition.defaultFields) ? moduleDefinition.defaultFields : [];
  if (requestedField && availableFields.some((field) => field.toLowerCase() === String(requestedField).toLowerCase())) {
    return availableFields.find((field) => field.toLowerCase() === String(requestedField).toLowerCase());
  }
  return ['Amount', 'Grand_Total', 'Annual_Revenue', 'Unit_Price', 'Revenue', 'Total_Revenue']
    .find((candidate) => availableFields.some((field) => field.toLowerCase() === candidate.toLowerCase())) || null;
}

function normalizeAggregateMetrics(options = {}) {
  const requested = Array.isArray(options.aggregate_metrics)
    ? options.aggregate_metrics
    : options.aggregate_metric
      ? [options.aggregate_metric]
      : ['sum'];
  return [...new Set(requested.map((metric) => String(metric).toLowerCase()))]
    .filter((metric) => ['sum', 'average', 'minimum', 'maximum'].includes(metric));
}

async function executeCoqlAggregate(moduleKey, moduleDefinition, queryPlan, options = {}) {
  const field = getAggregateField(moduleDefinition, options.aggregate_field);
  if (!field) throw new Error(`No aggregate field is available for CRM module ${moduleKey}`);

  const metricFunctions = {
    sum: 'sum',
    average: 'avg',
    minimum: 'min',
    maximum: 'max',
  };
  const metrics = normalizeAggregateMetrics(options);
  const expressions = metrics.map((metric) => `${metricFunctions[metric]}(${field}) as ${metric}_value`);
  const query = `select count(id) as record_count${expressions.length ? `, ${expressions.join(', ')}` : ''} from ${moduleDefinition.endpoint}${queryPlan.whereClause ? ` where ${queryPlan.whereClause}` : ''}`;
  logGeneratedQuery({ ...queryPlan, query, mode: 'coql_aggregate' });
  const response = await zohoClient.post('/crm/v8/coql', { select_query: query });
  const row = response.data?.data?.[0] || {};
  const recordCount = Number(row.record_count ?? row.count ?? 0);
  const aggregateValues = Object.fromEntries(metrics.map((metric) => {
    const rawValue = row[`${metric}_value`];
    const value = rawValue === null || rawValue === undefined || rawValue === '' ? 0 : Number(rawValue);
    return [metric, Number.isFinite(value) ? value : 0];
  }));

  return {
    data: [],
    info: {
      count: Number.isFinite(recordCount) ? recordCount : 0,
      more_records: false,
      retrievalComplete: true,
      page: 1,
      per_page: 1,
      retrievalStrategy: RETRIEVAL_STRATEGIES.AGGREGATE,
      aggregateField: field,
      aggregateValues,
      aggregateValue: aggregateValues.sum ?? aggregateValues.average ?? 0,
    },
  };
}

async function executeCoqlRecords(moduleKey, queryPlan, options = {}) {
  const requestedPage = Number(options.page || 1);
  const requestedPerPage = Number(options.per_page || 0);
  const completeRequest = normalizeRetrievalMode(options.retrieval_mode ?? options.retrievalMode) === 'all';
  const batchSize = completeRequest ? 2000 : requestedPerPage;
  const firstOffset = Number(options.offset ?? ((requestedPage - 1) * requestedPerPage));
  const records = [];
  const seenIds = new Set();
  let offset = firstOffset;
  let pagesFetched = 0;
  const recordsPerCall = [];
  let lastInfo = {};

  while (true) {
    let query = queryPlan.query;
    if (batchSize > 0) query += ` limit ${batchSize}${offset > 0 ? ` offset ${offset}` : ''}`;
    logGeneratedQuery({ ...queryPlan, query });
    const response = await zohoClient.post('/crm/v8/coql', { select_query: query });
    const pageData = Array.isArray(response.data?.data) ? response.data.data : [];
    lastInfo = response.data?.info || {};
    pagesFetched += 1;
    recordsPerCall.push(pageData.length);
    pageData.forEach((record) => {
      const id = record?.id ?? record?.ID;
      if (id === undefined || id === null || !seenIds.has(String(id))) {
        if (id !== undefined && id !== null) seenIds.add(String(id));
        records.push(record);
      }
    });

    const hasMore = lastInfo.more_records === true || lastInfo.has_more === true;
    if (!completeRequest || !batchSize || !hasMore && pageData.length < batchSize) break;
    if (pageData.length === 0) {
      const error = new Error(`Incomplete CRM retrieval for ${moduleKey || 'module'}: an empty COQL page reported more records`);
      error.code = 'RETRIEVAL_INCOMPLETE';
      throw error;
    }
    offset += batchSize;
  }

  return {
    data: records,
    info: {
      ...lastInfo,
      count: records.length,
      page: requestedPage,
      per_page: batchSize || requestedPerPage || records.length,
      retrievalStrategy: 'coql',
      more_records: false,
      retrievalComplete: true,
      pagesFetched,
      recordsPerCall,
    },
  };
}

async function getCount(moduleKey, options = {}) {
  const normalizedKey = normalizeModuleKey(moduleKey);
  const moduleDefinition = getModuleDefinition(normalizedKey);

  const queryPlan = buildQueryPlan(normalizedKey, options);
  if (queryPlan.mode === 'coql') {
    return executeCoqlCount(normalizedKey, moduleDefinition, queryPlan);
  }

  return executeCountRequest(normalizedKey, moduleDefinition, {
    ...options,
    retrieval_mode: 'count',
  });
}

function getPaginationInterpretation(options, requestText) {
  const hasPage = options.page !== undefined && options.page !== null && options.page !== '';
  const hasPerPage = options.per_page !== undefined && options.per_page !== null && options.per_page !== '';
  const copilotDefaultsApplied = Number(options.page) === 1 && Number(options.per_page) === 25;
  const explicitPaginationRequested = hasExplicitPagination(options, requestText);

  if (copilotDefaultsApplied && !explicitPaginationRequested) {
    return {
      copilotDefaultsApplied: true,
      explicitPaginationRequested: false,
      interpretation: 'copilot_defaults',
    };
  }

  if (hasPage || hasPerPage) {
    return {
      copilotDefaultsApplied,
      explicitPaginationRequested,
      interpretation: explicitPaginationRequested ? 'explicit_user_pagination' : 'copilot_defaults',
    };
  }

  return {
    copilotDefaultsApplied: false,
    explicitPaginationRequested: false,
    interpretation: 'not_applicable',
  };
}

function logPlannerDebug(moduleKey, options, retrievalPlan, moduleDefinition) {
  const originalUserPrompt = getRequestText(options);
  const paginationInterpretation = getPaginationInterpretation(options, originalUserPrompt);
  const retrievalMode = normalizeRetrievalMode(options.retrieval_mode ?? options.retrievalMode);

  logger.debug('Retrieval Engine', {
    module: moduleKey,
    endpoint: moduleDefinition.endpoint,
    'Original user prompt': originalUserPrompt || null,
    'retrieval_mode received': retrievalMode,
    'Detected retrieval intent': retrievalPlan.strategy,
    'Retrieval strategy selected': retrievalPlan.strategy,
    'Reason for selecting that strategy': retrievalPlan.reason,
    'page=1 and per_page=25 treated as Copilot defaults or explicit user pagination': paginationInterpretation.interpretation,
    'fetchAll=true or false': retrievalPlan.fetchAll,
    'Copilot defaults applied': paginationInterpretation.copilotDefaultsApplied,
    'Explicit pagination requested': paginationInterpretation.explicitPaginationRequested,
  });
}

async function getRecords(moduleKey, options = {}) {
  const retrievalStartedAt = process.hrtime.bigint();
  const normalizedKey = normalizeModuleKey(moduleKey);
  const retrievalCache = getRetrievalCache(options);
  const cacheKey = retrievalCache ? buildCacheKey(normalizedKey, options) : null;
  if (retrievalCache?.has(cacheKey)) return retrievalCache.get(cacheKey);
  const cacheResult = (result) => {
    if (retrievalCache) retrievalCache.set(cacheKey, result);
    return result;
  };
  const moduleDefinition = getModuleDefinition(normalizedKey);
  const retrievalPlan = getRetrievalPlan(moduleDefinition, options);
  const effectiveRetrievalMode = getEffectiveRetrievalMode(retrievalPlan, options.retrieval_mode ?? options.retrievalMode);
  const effectiveOptions = {
    ...options,
    ...retrievalPlan.params,
    retrieval_mode: effectiveRetrievalMode,
  };
  if (!effectiveOptions.criteria && !effectiveOptions.filter && !effectiveOptions.filters) {
    const inferredCriteria = buildCountCriteria(normalizedKey, moduleDefinition, effectiveOptions, getRequestText(effectiveOptions));
    if (inferredCriteria) effectiveOptions.criteria = inferredCriteria;
  }
  const queryPlan = buildQueryPlan(normalizedKey, {
    ...effectiveOptions,
    // Preserve the caller's mode for query selection. The retrieval policy
    // may upgrade auto -> all internally, but that must not unexpectedly
    // switch every direct Search request to COQL.
    retrieval_mode: options.retrieval_mode ?? options.retrievalMode,
  });
  const {
    page,
    per_page,
    ids,
    fields: requestedFields,
  } = effectiveOptions;
  const shouldFetchAllPages = retrievalPlan.fetchAll;
  logPlannerDebug(normalizedKey, options, retrievalPlan, moduleDefinition);
  logRetrievalPlan(normalizedKey, options, retrievalPlan);
  logger.debug('Retrieval Engine', {
    module: normalizedKey,
    'retrieval_mode received': normalizeRetrievalMode(options.retrieval_mode ?? options.retrievalMode),
    'retrieval strategy selected': retrievalPlan.strategy,
  });

  if (retrievalPlan.strategy === RETRIEVAL_STRATEGIES.COUNT) {
    try {
      if (queryPlan.mode === 'coql') {
        const result = await executeCoqlCount(normalizedKey, moduleDefinition, queryPlan);
        logRetrievalTelemetry({
          moduleKey: normalizedKey,
          criteria: effectiveOptions.criteria,
          fields: queryPlan.fields,
          calls: 1,
          recordsPerCall: [result.info.count],
          totalMatchingRecords: result.info.count,
          startedAt: retrievalStartedAt,
        });
        return cacheResult(result);
      }
      const result = await executeCountRequest(normalizedKey, moduleDefinition, options);
      logRetrievalTelemetry({
        moduleKey: normalizedKey,
        criteria: effectiveOptions.criteria,
        fields: [],
        calls: 1,
        recordsPerCall: [result.info.count],
        totalMatchingRecords: result.info.count,
        startedAt: retrievalStartedAt,
      });
      return cacheResult(result);
    } catch (error) {
      logRequestError(
        error,
        normalizedKey,
        moduleDefinition,
        error?.config?.params || {},
        []
      );
      throw error;
    }
  }

  if (retrievalPlan.strategy === RETRIEVAL_STRATEGIES.AGGREGATE) {
    try {
      const result = await executeCoqlAggregate(normalizedKey, moduleDefinition, queryPlan, effectiveOptions);
      logRetrievalTelemetry({
        moduleKey: normalizedKey,
        criteria: effectiveOptions.criteria,
        fields: queryPlan.fields,
        calls: 1,
        recordsPerCall: [0],
        totalMatchingRecords: result.info.count,
        startedAt: retrievalStartedAt,
      });
      return cacheResult(result);
    } catch (error) {
      logRequestError(error, normalizedKey, moduleDefinition, { select_query: error?.config?.data || queryPlan.query }, queryPlan.fields);
      throw error;
    }
  }

  if (queryPlan.mode === 'coql') {
    try {
      const coqlResult = await executeCoqlRecords(normalizedKey, queryPlan, effectiveOptions);
      logRetrievalTelemetry({
        moduleKey: normalizedKey,
        criteria: effectiveOptions.criteria,
        fields: queryPlan.fields,
        calls: coqlResult.info?.pagesFetched || 1,
        recordsPerCall: coqlResult.info?.recordsPerCall,
        totalMatchingRecords: coqlResult.data.length,
        startedAt: retrievalStartedAt,
      });
      return cacheResult(addRetrievalMetadata(
        coqlResult,
        effectiveOptions,
        coqlResult.info?.pagesFetched || 1,
        coqlResult.info?.retrievalComplete !== false,
      ));
    } catch (error) {
      logRequestError(error, normalizedKey, moduleDefinition, { select_query: queryPlan.query }, queryPlan.fields);
      throw error;
    }
  }

  if (normalizedKey === 'users') {
    logger.debug('Retrieval Engine', { message: 'Calling Users API' });

    try {
      const params = {
        type: 'AllUsers',
        ids: ids || undefined,
      };

      if (shouldFetchAllPages) {
        let pagesFetched = 0;
        const responseData = await fetchAllPages({
          moduleKey: normalizedKey,
          dataKey: 'users',
          baseParams: params,
          fetchPage: async (pageParams) => {
            const response = await zohoClient.get('/crm/v8/users', { params: pageParams });
            return response.data;
          },
          onPageFetched: () => { pagesFetched += 1; },
        });

        logRetrievalComplete(normalizedKey, pagesFetched, responseData.users?.length || 0, {
        source: 'users_api',
        resultPreview: responseData.users?.slice(0, 3) || [],
      });

        return cacheResult(addRetrievalMetadata({
          data: responseData.users || [],
          info: responseData.info || {},
        }, effectiveOptions, responseData.info?.pagesFetched || 1, responseData.info?.retrievalComplete !== false));
      }

      const response = await zohoClient.get('/crm/v8/users', {
        params: {
          ...params,
          page: Number(page || 1),
          per_page: Number(per_page || DEFAULT_PER_PAGE),
        },
      });

      logRetrievalComplete(normalizedKey, 1, response.data.users?.length || 0, {
        source: 'users_api',
        resultPreview: response.data.users?.slice(0, 3) || [],
      });

      return cacheResult(addRetrievalMetadata({
        data: response.data.users || [],
        info: response.data.info || {},
      }, effectiveOptions, 1, response.data.info?.more_records !== true));
    } catch (error) {
      logger.error('Retrieval Engine', {
        status: error.response?.status,
        data: error.response?.data,
      });

      throw error;
    }
  }

  const { params, fields: responseFields } = buildQueryParams(normalizedKey, effectiveOptions);

  logRequestDebug(normalizedKey, moduleDefinition, params, responseFields);

  try {
    if (shouldFetchAllPages) {
      let result;
      let pagesFetched = 0;
      let totalRecords = 0;
      let lastError;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          result = await fetchAllPages({
            moduleKey: normalizedKey,
            baseParams: params,
            fetchPage: async (pageParams) => {
              const response = await zohoClient.get(
                `/crm/v8/${moduleDefinition.endpoint}`,
                { params: pageParams }
              );
              return response.data;
            },
            onPageFetched: ({ recordsFetched }) => {
              pagesFetched += 1;
              totalRecords += recordsFetched;
            },
          });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < 2) logger.warn('Retrieval Engine', {
            module: normalizedKey,
            reason: error.code || 'request_error',
            message: 'Retrying complete dataset retrieval',
          });
        }
      }
      if (lastError) throw lastError;

      const merged = addRetrievalMetadata(
        result,
        effectiveOptions,
        result?.info?.pagesFetched || pagesFetched,
        result?.info?.retrievalComplete !== false,
        result?.info?.duplicateRecordsRemoved || 0,
      );

      logger.info('Retrieval', {
        module: normalizedKey,
        pagesFetched: merged.info.pagesFetched,
        mergedRecords: merged.info.recordCount,
        retrievalComplete: merged.info.retrievalComplete,
      });

      logRetrievalTelemetry({
        moduleKey: normalizedKey,
        criteria: effectiveOptions.criteria,
        fields: responseFields,
        calls: result?.info?.pagesFetched || pagesFetched,
        recordsPerCall: result?.info?.recordsPerCall,
        totalMatchingRecords: merged.data?.length || 0,
        startedAt: retrievalStartedAt,
      });

      logRetrievalComplete(normalizedKey, pagesFetched, totalRecords, {
        source: 'crm_records_api',
        resultPreview: merged.data?.slice(0, 3) || [],
      });
      return cacheResult(merged);
    }

    let response;
    try {
      logGeneratedQuery({ ...queryPlan, query: `/crm/v8/${moduleDefinition.endpoint}` });
      response = await zohoClient.get(`/crm/v8/${moduleDefinition.endpoint}`, { params });
    } catch (error) {
      if (!isInvalidQueryError(error) || queryPlan.mode !== 'search') throw error;
      const fallbackPlan = buildQueryPlan(normalizedKey, { ...effectiveOptions, force_coql: true });
      logger.warn('Retrieval Engine', { module: normalizedKey, reason: error.response?.data, message: 'Retrying with COQL' });
      return cacheResult(addRetrievalMetadata(
        await executeCoqlRecords(normalizedKey, fallbackPlan, effectiveOptions),
        effectiveOptions,
        1,
        true,
      ));
    }

    logRetrievalComplete(normalizedKey, 1, response.data?.data?.length || response.data?.users?.length || 0, {
      source: 'crm_records_api',
      resultPreview: response.data?.data?.slice(0, 3) || response.data?.users?.slice(0, 3) || [],
    });

    logRetrievalTelemetry({
      moduleKey: normalizedKey,
      criteria: effectiveOptions.criteria,
      fields: responseFields,
      calls: 1,
      recordsPerCall: [response.data?.data?.length || response.data?.users?.length || 0],
      totalMatchingRecords: response.data?.data?.length || response.data?.users?.length || 0,
      startedAt: retrievalStartedAt,
    });

    return cacheResult(addRetrievalMetadata(
      response.data,
      effectiveOptions,
      1,
      response.data?.info?.more_records !== true,
    ));
  } catch (error) {
    logRequestError(
      error,
      normalizedKey,
      moduleDefinition,
      error?.config?.params || params,
      requestedFields
    );
    throw error;
  }
}

async function getModuleFields(moduleKey = 'leads') {
  const normalizedKey = normalizeModuleKey(moduleKey);
  const moduleDefinition = getModuleDefinition(normalizedKey);
  const response = await zohoClient.get('/crm/v8/settings/fields', {
    params: { module: moduleDefinition.endpoint },
  });
  const rawFields = response.data?.fields || response.data?.data || [];
  return rawFields.map((field) => field.api_name || field.apiName || field.field_label || field.name || field).filter(Boolean);
}

module.exports = {
  getCount,
  getModuleFields,
  getRecords,
};
