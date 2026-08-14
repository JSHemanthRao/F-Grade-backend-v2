const { DEBUG_ASSISTANT } = require('../../common/config/env');
const recordsService = require('./retrieval-engine.service');
const { detectDnsRequest } = require('./assistant/dns-detector.service');
const { resolveDnsRecords, filterDnsRecords, formatDnsResponse } = require('./dns.service');
const { buildExecutionPlan } = require('./assistant/planner.service');
const { optimizeExecutionPlan } = require('./assistant/query-optimizer.service');
const { executePlan } = require('./assistant/execution-engine.service');
const { mergeDatasets } = require('./assistant/merge-engine.service');
const { calculateResult } = require('./assistant/calculator.service');
const { validateExecution, validateResponse } = require('./assistant/validation.service');
const { generateInsights } = require('./assistant/insight.service');
const { formatResponse } = require('./assistant/formatter.service');
const { discoverLeadConversionFields } = require('../services/conversion-discovery.service');
const { FALLBACK_REASONS, logFallbackReason } = require('./assistant/fallback-engine.service');
const { applyFilterToDataset, buildFilterPlans } = require('./filtering-engine.service');
const { validateIntentQueryPlans } = require('./assistant/query-plan-validator.service');
const {
  DISPLAY_LIMIT,
  createDisplayState,
  getDisplayBatch,
  isDisplayContinuation,
} = require('./assistant/display-batching.service');
const logger = require('../../common/logging/logger');
const activityService = require('./activity.service');
const dashboardService = require('./dashboard.service');
const { formatActivityResponse } = require('./assistant/activity-formatter.service');
const { detectTimeRange } = require('./assistant/date-detector.service');

const ACTIVITY_QUESTION_PATTERN = /(today'?s?\s+(?:crm\s+)?activity|crm\s+activity|what\s+did\s+.*\s+do\s+today|what\s+changes\s+did\s+.*\s+make\s+today|activity\s+for\s+all\s+employees|daily\s+activity|activity\s+report)/i;

const DASHBOARD_QUESTION_PATTERN = /\bdashboard\b|\b(?:deal-stage\s+donut|donut\s+chart|sales\s+performance\s+by\s+employee|revenue\s+by\s+employee\s+chart|change\s+(?:the\s+)?(?:this\s+)?dashboard\s+to\s+(?:dark|light)\s+mode|make\s+(?:the\s+dashboard\s+)?(?:dark|light)\s*mode)\b|^\s*compare\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+(?:with|and|versus|vs)\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\s*$/i;

function extractActivityUser(question) {
  const matchDid = question.match(/what\s+did\s+([A-Za-z\s.'-]+?)\s+do\s+today/i);
  if (matchDid) return matchDid[1].trim();
  const matchChanges = question.match(/what\s+changes\s+did\s+([A-Za-z\s.'-]+?)\s+make\s+today/i);
  if (matchChanges) return matchChanges[1].trim();
  const matchFor = question.match(/activity\s+(?:of|for)\s+([A-Za-z\s.'-]+?)(?:\s+today)?$/i);
  if (matchFor && !/all\s+employees|all/i.test(matchFor[1])) return matchFor[1].trim();
  return null;
}

function extractDashboardParams(question) {
  const isDarkMode = /\bdark\s*(?:mode|theme)?\b/i.test(question);
  const isLightMode = /\blight\s*(?:mode|theme)?\b/i.test(question);
  const theme = isDarkMode ? { mode: 'dark' } : isLightMode ? { mode: 'light' } : undefined;

  let employee = null;
  const matchExplicit = question.match(/(?:show\s+only|filter\s+by|employee\s+is|rep\s+is)\s+([A-Za-z]+)/i);
  if (matchExplicit && !/dashboard|month|week|year|sales|july|june|august|employee/i.test(matchExplicit[1])) {
    employee = matchExplicit[1].trim();
  } else {
    const matchBy = question.match(/(?:for|by)\s+([A-Za-z]+)(?:\s+only)?$/i);
    if (matchBy && !/dashboard|month|week|year|sales|july|june|august|employee|today/i.test(matchBy[1])) {
      employee = matchBy[1].trim();
    }
  }

  let type = 'sales';
  if (/activity/i.test(question)) type = 'activity';
  else if (/compare|versus|vs/i.test(question)) type = 'comparison';
  else if (/management/i.test(question)) type = 'sales';
  else if (/employee|performance/i.test(question)) type = 'sales';

  const timeRange = detectTimeRange(question);
  const dateRange = timeRange?.startDate && timeRange?.endDate
    ? { from: timeRange.startDate, to: timeRange.endDate }
    : undefined;

  return { theme, employee, type, dateRange };
}

let lastDisplayContext = null;

function completeRecordsFrom(datasets) {
  const seen = new Set();
  return datasets.flatMap((dataset) => dataset?.result?.data || dataset?.data || []).filter((record) => {
    const id = record?.id ?? record?.ID;
    if (id === undefined || id === null) return true;
    const key = String(id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function displayLimitFor(plan) {
  const requested = Number(plan?.pagination?.per_page);
  if (!Number.isInteger(requested) || requested <= 0) return DISPLAY_LIMIT;
  return plan?.pagination?.explicit ? requested : Math.min(requested, DISPLAY_LIMIT);
}

function displayContextFromPayload(context = {}) {
  if (!Array.isArray(context.datasets) || context.datasets.length === 0) return null;
  const records = completeRecordsFrom(context.datasets);
  const plan = context.lastPlan || context.plan || {
    question: context.lastQuestion || 'CRM records',
    modules: [...new Set(context.datasets.map((dataset) => dataset?.module).filter(Boolean))],
    intents: ['LIST'],
    timeRange: { label: 'all time' },
  };
  const limit = displayLimitFor(plan);
  const initial = getDisplayBatch(createDisplayState(records), limit);
  return {
    plan,
    datasets: context.datasets,
    calculations: Array.isArray(context.calculations) ? context.calculations : [],
    insights: Array.isArray(context.insights) ? context.insights : [],
    limitations: Array.isArray(context.limitations) ? context.limitations : [],
    limit,
    state: initial.nextState,
  };
}

async function handleAssistantRequest(payload = {}) {
  const question = String(payload?.question || '').trim();
  if (!question) return { success: false, message: 'A question is required.' };

  const dnsRequest = detectDnsRequest(question);
  if (dnsRequest?.domain) {
    const completeRecords = await resolveDnsRecords(dnsRequest.domain);
    const filteredRecords = filterDnsRecords(completeRecords, dnsRequest.requestedRecords);
    return formatDnsResponse({
      domain: dnsRequest.domain,
      completeRecords,
      filteredRecords,
      requestedRecords: dnsRequest.requestedRecords,
    });
  }

  if (ACTIVITY_QUESTION_PATTERN.test(question)) {
    const targetUser = extractActivityUser(question);
    try {
      const activityResult = await activityService.getActivity({
        user_id: targetUser,
        signal: payload.signal,
      });
      return formatActivityResponse(activityResult, { question });
    } catch (error) {
      logger.error('Assistant Engine Activity', { error: error.message });
      return {
        success: false,
        summary: 'No activity could be retrieved because the CRM activity API returned an error.',
        error: error.message,
      };
    }
  }

  if (DASHBOARD_QUESTION_PATTERN.test(question)) {
    const params = extractDashboardParams(question);
    const suppliedData = payload?.data
      || payload?.records
      || payload?.deals
      || payload?.context?.datasets?.flatMap((ds) => ds?.result?.data || ds?.data || [])
      || payload?.conversationContext?.datasets?.flatMap((ds) => ds?.result?.data || ds?.data || [])
      || undefined;

    try {
      const dashboardResult = await dashboardService.getDashboard({
        question,
        type: params.type,
        theme: params.theme,
        dateRange: params.dateRange,
        employee: params.employee,
        data: Array.isArray(suppliedData) && suppliedData.length > 0 ? suppliedData : undefined,
        signal: payload.signal,
      });

      const dashboardObj = dashboardResult.dashboard;
      const rawRecords = dashboardResult.data || dashboardObj.data || [];
      const dataJsonStr = JSON.stringify(rawRecords);
      const dataHeader = rawRecords.length > 0 ? `Data: ${dataJsonStr}\n\n` : '';
      const summary = dashboardObj.summary
        ? `${dataHeader}Here’s the ${dashboardObj.title}. ${dashboardObj.summary}`
        : `${dataHeader}Here’s the ${dashboardObj.title}.`;

      return {
        success: true,
        summary,
        text: `${dataHeader}${dashboardObj.summary || ''}`.trim(),
        dashboard: dashboardObj,
        data: rawRecords.length > 0 ? rawRecords : dashboardObj.widgets,
        records: rawRecords,
        metrics: dashboardResult.metrics || dashboardObj.metrics || {},
        tables: dashboardResult.tables || dashboardObj.tables || [],
      };
    } catch (error) {
      logger.error('Assistant Engine Dashboard', { error: error.message });
      return {
        success: false,
        summary: 'No dashboard could be generated because the CRM API returned an error.',
        error: error.message,
      };
    }
  }

  const suppliedContext = payload?.context || payload?.conversationContext || {};
  const continuation = isDisplayContinuation(question);
  const contextDisplay = displayContextFromPayload(suppliedContext);
  const activeDisplayContext = contextDisplay || lastDisplayContext;
  if (continuation && !suppliedContext.datasets?.length && !activeDisplayContext) {
    return { success: false, message: 'Please specify which CRM records you want to continue viewing.' };
  }
  if (continuation && activeDisplayContext) {
    const display = getDisplayBatch(activeDisplayContext.state, activeDisplayContext.limit);
    if (display.records.length === 0) {
      return { success: true, summary: 'No more matching records are available.', data: [], tables: [] };
    }
    lastDisplayContext = { ...activeDisplayContext, state: display.nextState };
    return formatResponse(activeDisplayContext.plan, activeDisplayContext.datasets, activeDisplayContext.calculations, {
      insights: activeDisplayContext.insights,
      limitations: activeDisplayContext.limitations,
      displayRecords: display.records,
      displayStart: display.start,
      displayTotal: display.total,
    });
  }
  const context = suppliedContext;
  const plan = optimizeExecutionPlan(buildExecutionPlan(question, context));
  const moduleCandidates = plan.modules;
  if (!moduleCandidates.length) return { success: false, message: 'I could not identify the CRM information needed to answer that question.' };
  const queryPlanValidation = validateIntentQueryPlans(plan.queryPlansByModule);
  if (!queryPlanValidation.valid) {
    return {
      success: false,
      message: 'The CRM request could not be converted into a valid query plan.',
      error: { code: 'QUERY_PLAN_VALIDATION_ERROR', details: queryPlanValidation.issues },
      requestedInformation: question,
    };
  }
  const filterPlans = buildFilterPlans({ question, modules: moduleCandidates, plan, context });
  if (!filterPlans.valid) {
    return {
      success: false,
      message: 'The requested filter is not valid for the selected CRM module.',
      error: { code: 'FILTER_VALIDATION_ERROR', details: filterPlans.validationErrors },
      requestedInformation: question,
    };
  }
  plan.filterPlans = filterPlans.byModule;
  Object.entries(filterPlans.byModule).forEach(([moduleKey, filterPlan]) => {
    const structuredPlan = plan.queryPlansByModule?.[moduleKey];
    if (!structuredPlan) return;
    Object.assign(structuredPlan, {
      filters: filterPlan.filters,
      criteria: filterPlan.serverCriteria,
      serverCriteria: filterPlan.serverCriteria,
      queryValidated: true,
    });
  });

  if (DEBUG_ASSISTANT) logger.info('Assistant Pipeline', { tasks: plan.steps.length, modules: plan.modules });

  let conversionDiscovery = null;
  if (plan.intents.includes('CONVERSION') && !plan.relationships.includes('contact_to_deal')) {
    conversionDiscovery = await discoverLeadConversionFields();
    const needsDate = plan.timeRange.range !== 'all_time';
    const hasDate = conversionDiscovery.fields.some((field) => /converted.*(?:date|time)|conversion.*(?:date|time)/i.test(field));
    const needsDealLink = /converted\s+(?:into|to)\s+deals?|became\s+a\s+deal/i.test(question);
    if (!conversionDiscovery.fields.length || (needsDate && !hasDate) || (needsDealLink && !conversionDiscovery.fields.includes('Converted_Deal'))) {
      logFallbackReason(FALLBACK_REASONS.UNSUPPORTED_METRIC);
      return formatResponse(plan, [], [], { conversionFallback: true });
    }
  }

  let datasets;
  try {
    datasets = await executePlan({
      plan,
      question,
      moduleCandidates,
      context,
      conversionDiscovery,
      filterPlans: filterPlans.byModule,
      signal: payload.signal,
    });
    datasets = datasets.map((dataset) => {
      if (dataset.skipQuestionFilter) return dataset;
      const filterPlan = filterPlans.byModule[dataset.module];
      // Period-specific retrieval already applies its date window on the
      // CRM side. The testable/local pass should enforce the remaining
      // filters without discarding records that do not repeat date fields.
      const localFilterPlan = dataset.period
        || dataset.step?.type !== 'query'
        ? {
          ...filterPlan,
          filters: filterPlan.filters.filter((filter) => filter.logicalField !== 'date'),
          canonicalFilters: filterPlan.canonicalFilters.filter((filter) => filter.logicalField !== 'date'),
          localFilters: filterPlan.localFilters.filter((filter) => filter.logicalField !== 'date'),
        }
        : filterPlan;
      const applied = applyFilterToDataset(dataset, localFilterPlan);
      if (!applied.valid) throw new Error('FILTER_VALIDATION_ERROR');
      return applied.dataset;
    });
  } catch (error) {
    logger.error('Assistant Pipeline', { module: moduleCandidates[0], message: 'Execution failed' });
    if (plan.steps.some((step) => step.type === 'conversion_count')) {
      return formatResponse(plan, [], [], { conversionFallback: true });
    }
    return { success: false, message: 'The CRM could not provide the requested information at this time.', requestedInformation: question };
  }

  let merged = mergeDatasets(datasets);
  const result = calculateResult(plan, merged.datasets);
  let validation = validateExecution({ plan, question, datasets: merged.datasets, calculations: result.calculations, limitations: result.limitations });
  let calculations = validation.hasOwnProperty('calculations') ? validation.calculations : result.calculations;
  let limitations = validation.hasOwnProperty('limitations') ? validation.limitations : result.limitations;
  if (!validation.valid && validation.issues.includes('dataset_incomplete')) {
    for (const dataset of merged.datasets.filter((item) => (
      item.result?.info?.more_records === true || item.result?.info?.retrievalComplete === false
    ) && !item.step?.explicit)) {
      const options = { question, fields: dataset.step.requiredFieldsByModule?.[dataset.module], retrieval_mode: 'all', force_coql: true };
      dataset.result = await recordsService.getRecords(dataset.module, options);
    }
    merged = mergeDatasets(merged.datasets);
    const retryResult = calculateResult(plan, merged.datasets);
    validation = validateExecution({ plan, question, datasets: merged.datasets, calculations: retryResult.calculations, limitations: retryResult.limitations });
    calculations = validation.hasOwnProperty('calculations') ? validation.calculations : retryResult.calculations;
    limitations = validation.hasOwnProperty('limitations') ? validation.limitations : retryResult.limitations;
  }
  if (!validation.valid) {
    return formatResponse(plan, merged.datasets, calculations, {
      closestAnswer: 'The CRM did not provide enough data to complete this analysis.',
      limitation: 'The requested analysis could not be completed from the available CRM data.',
      limitations,
    });
  }

    if (plan.steps.some((step) => step.type === 'conversion_count') && calculations.some((item) => item.type === 'conversion_unavailable')) {
    return formatResponse(plan, merged.datasets, [], { conversionFallback: true });
  }

  const completeRecords = completeRecordsFrom(merged.datasets);
  const initialDisplay = getDisplayBatch(createDisplayState(completeRecords), displayLimitFor(plan));
  const insights = generateInsights(plan, merged.datasets, calculations);
  const response = formatResponse(plan, merged.datasets, calculations, {
    insights,
    limitations,
    displayRecords: initialDisplay.records,
    displayStart: initialDisplay.start,
    displayTotal: initialDisplay.total,
  });
  lastDisplayContext = {
    plan,
    datasets: merged.datasets,
    calculations,
    insights,
    limitations,
    limit: displayLimitFor(plan),
    state: initialDisplay.nextState,
  };
  const validationResult = validateResponse({ response, plan, datasets: merged.datasets, calculations, limitations });
  if (!validationResult.valid) {
    if (DEBUG_ASSISTANT) logger.warn('Response Validation', { issues: validationResult.issues, warnings: validationResult.warnings });
    return formatResponse(plan, merged.datasets, [], {
      closestAnswer: 'The CRM did not provide a validated response for this request.',
      limitation: 'The generated response could not be fully validated against the CRM data.',
      limitations: [{ metric: 'response_validation', reason: 'Response content failed validation checks.' }],
      conversionFallback: plan.steps.some((step) => step.type === 'conversion_count'),
    });
  }
  if (DEBUG_ASSISTANT) logger.info('Response Validation', { issues: validationResult.issues, warnings: validationResult.warnings });
  return response;
}

module.exports = { handleAssistantRequest };
