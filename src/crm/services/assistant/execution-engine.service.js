const { DEBUG_ASSISTANT } = require('../../../common/config/env');
const recordsService = require('../retrieval-engine.service');
const logger = require('../../../common/logging/logger');

function getPeriods(step, question, contextDatasets) {
  if (step.type === 'compare' && Array.isArray(step.periods) && step.periods.length > 1) {
    return step.periods.map((period) => typeof period === 'string' ? period : period.label).filter(Boolean);
  }
  const explicitPeriodComparison = /\bthis month\b[\s\S]*\blast month\b|\blast month\b[\s\S]*\bthis month\b/i.test(question)
    || (contextDatasets.length > 0 && /\blast month\b/i.test(question) && step.type === 'compare');
  return ((step.type === 'compare' && explicitPeriodComparison)
    || (step.type === 'conversion_count' && step.intents?.includes('COMPARE')))
    ? ['this month', 'last month']
    : [null];
}

async function executePlan({ plan, question, moduleCandidates, context = {}, conversionDiscovery = null, filterPlans = {}, signal }) {
  const datasets = [];
  const requestCache = new Map();
  const contextDatasets = Array.isArray(context.datasets) ? context.datasets : [];

  for (const step of plan.steps) {
    const stepModules = Array.isArray(step.modules) && step.modules.length > 0
      ? step.modules
      : [step.module || moduleCandidates[0]];
    const periods = getPeriods({ ...step, intents: plan.intents }, question, contextDatasets);

    for (const moduleKey of stepModules) {
      for (const period of periods) {
        const stepQuestion = period
          ? ` ${question.replace(/\b(this month|last month)\b/gi, '')} ${period}`
          : question;
        const filterPlan = filterPlans[moduleKey];
        if (!filterPlan || !filterPlan.valid) {
          throw new Error('FILTER_VALIDATION_ERROR');
        }

        const requestedPage = Number.isInteger(step.page) ? step.page : Number(plan.pagination?.page || 1);
        const requestedLimit = Number.isInteger(step.per_page) && step.per_page > 0
          ? step.per_page
          : Number.isInteger(plan.pagination?.per_page) && plan.pagination.per_page > 0
            ? plan.pagination.per_page
            : 25;
        const explicitList = step.type === 'query' && Boolean(plan.pagination?.explicit);
        const plainList = step.type === 'query'
          && !filterPlan.filters?.length
          && (plan.timeRange?.range || 'all_time') === 'all_time';
        const boundedList = explicitList || plainList;
        const aggregateMetrics = step.type === 'aggregate'
          ? (step.metrics?.filter((metric) => ['sum', 'average', 'minimum', 'maximum'].includes(metric)) || ['sum'])
          : step.type === 'compare' && !plan.intents?.includes('LIST') && step.metrics?.some((metric) => ['sum', 'revenue', 'average', 'maximum', 'minimum', 'pipeline'].includes(metric))
            ? ['sum']
            : null;
        const retrievalMode = step.type === 'count'
          ? 'count'
          : aggregateMetrics
            ? 'aggregate'
            : boundedList
              ? 'page'
              : 'all';

        const requestOptions = {
          question,
          ...(period ? { request_text: stepQuestion } : {}),
          ...(conversionDiscovery ? { conversion_fields: conversionDiscovery.fields, conversion_metric: step.metric } : {}),
          criteria: period ? filterPlan.serverCriteriaWithoutDate : filterPlan.serverCriteria,
          canonicalFilters: filterPlan.canonicalFilters,
          requestedFilters: filterPlan.requestedFilters,
          ...(step.requiredFieldsByModule?.[moduleKey]?.length ? { fields: step.requiredFieldsByModule[moduleKey] } : {}),
          ...(signal ? { signal } : {}),
          ...(retrievalMode === 'page' ? { page: requestedPage, per_page: requestedLimit, offset: Number(plan.pagination?.offset || 0) } : {}),
          ...(aggregateMetrics ? {
            aggregate_metrics: aggregateMetrics,
            aggregate_field: step.requiredFieldsByModule?.[moduleKey]?.find((field) => /amount|revenue|total|price|value/i.test(field)),
          } : {}),
          retrievalCache: requestCache,
          ...(filterPlan.serverCriteria ? { force_coql: true } : {}),
          retrieval_mode: retrievalMode,
        };
        const cacheKey = JSON.stringify({ moduleKey, period, type: step.type, options: requestOptions });
        const contextual = contextDatasets.find((dataset) => dataset.cacheKey === cacheKey
          || (dataset.module === moduleKey
            && dataset.requestFingerprint === context.lastQuestion
            && (dataset.period === period || (step.type === 'compare' && dataset.period == null && period === 'this month'))));
        const cached = requestCache.get(cacheKey) || contextual?.result;
        if (cached) {
          datasets.push({ step, period, module: moduleKey, result: cached, reused: true });
          continue;
        }

        if (DEBUG_ASSISTANT) logger.info('Execution Engine', { module: moduleKey, period, type: step.type });
        const execute = (options) => recordsService.getRecords(moduleKey, options);
        if (DEBUG_ASSISTANT) logger.info('Execution Engine', {
          module: moduleKey,
          period,
          type: step.type,
          criteria: requestOptions.criteria,
          canonicalFilters: requestOptions.canonicalFilters,
          requestedFilters: requestOptions.requestedFilters,
        });

        let result;
        try {
          result = await execute(requestOptions);
        } catch (error) {
          logger.warn('Execution Engine', { module: moduleKey, task: step.type, message: 'Retrying CRM task' });
          result = await execute({
            ...requestOptions,
            force_coql: true,
          });
        }
        requestCache.set(cacheKey, result);
        datasets.push({ step, period, module: moduleKey, result });
      }
    }
  }

  return datasets;
}

module.exports = { executePlan };
