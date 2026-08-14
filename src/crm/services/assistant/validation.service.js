const BANNED_LANGUAGE = /\b(approx\.?|approximately|around|roughly|healthy pipeline|strong performance|excellent growth|good momentum|robust pipeline)\b/i;
const { numericValue } = require('./currency.service');
const SUPPORTED_METRICS_BY_STEP = {
  count: ['count', 'counts'],
  aggregate: ['sum', 'average', 'minimum', 'maximum', 'total_revenue'],
  compare: ['comparison', 'multi_module_comparison'],
  conversion_count: ['conversion_count', 'conversion_rate', 'conversion_unavailable'],
  analytics: [
    'owner_distribution', 'top_owners', 'top_sales_representatives',
    'stage_distribution', 'top_stages', 'customer_ranking', 'top_customers',
    'product_ranking', 'top_products', 'lead_source_distribution', 'top_lead_sources',
    'closed_won_value', 'closed_lost_count', 'pipeline', 'pipeline_value', 'win_rate',
    'month_wise_metrics', 'quarter_wise_metrics', 'year_wise_metrics',
    'month_over_month_growth', 'quarter_over_quarter_growth', 'year_over_year_growth',
  ],
};

function getRecords(dataset) {
  return dataset?.result?.data || dataset?.data || [];
}

function flattenRecords(datasets) {
  return datasets.flatMap(getRecords);
}

function groupCount(records, keyFn) {
  return records.reduce((acc, record) => {
    const key = keyFn(record);
    if (!key) return acc;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function sumAmounts(records, predicate = () => true) {
  return records.reduce((sum, record) => {
    if (!predicate(record)) return sum;
    const value = numericValue(record?.Amount ?? record?.amount ?? record?.value ?? record?.Grand_Total ?? record?.Revenue ?? record?.Total_Revenue);
    return sum + (value ?? 0);
  }, 0);
}

function normalizeLabel(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') {
    return String(value.name ?? value.Name ?? value.full_name ?? value.fullName ?? value.company ?? value.Company ?? value.label ?? value.Label ?? value);
  }
  return String(value);
}

function getTrainingFields(record, fields) {
  return fields.map((field) => record?.[field]).find((value) => value !== undefined && value !== null && value !== '');
}

function validateRankingMetric(calculation, records, fields) {
  const values = calculation.value;
  if (!Array.isArray(values) || values.length === 0) return { valid: false };
  const counts = groupCount(records, (record) => normalizeLabel(getTrainingFields(record, fields)));
  const seenLabels = new Set();
  for (const item of values) {
    if (!item || typeof item !== 'object' || typeof item.count !== 'number') return { valid: false };
    const labelKeys = Object.keys(item).filter((key) => key !== 'count');
    if (labelKeys.length !== 1) return { valid: false };
    const rawLabel = item[labelKeys[0]];
    const label = normalizeLabel(rawLabel);
    if (label === null || label === '') return { valid: false };
    if (seenLabels.has(label)) return { valid: false };
    seenLabels.add(label);
    if (!Object.prototype.hasOwnProperty.call(counts, label)) return { valid: false };
    if (counts[label] !== item.count) return { valid: false };
  }
  return { valid: true };
}

function hasStage(record) {
  return getTrainingFields(record, ['Stage', 'Status', 'Deal_Stage', 'Stage_Name']) != null;
}

function getStage(record) {
  return record?.Stage ?? record?.Status ?? record?.Deal_Stage ?? record?.Stage_Name;
}

function isClosedWon(stage) {
  return typeof stage === 'string' && /closed\s*won|\bwon\b/i.test(stage);
}

function isClosedLost(stage) {
  return typeof stage === 'string' && /closed\s*lost|\blost\b/i.test(stage);
}

function getMetricTypesAllowedByPlan(plan) {
  const allowed = new Set();
  (plan.steps || []).forEach((step) => {
    const types = SUPPORTED_METRICS_BY_STEP[step.type];
    if (types) types.forEach((type) => allowed.add(type));
    if (step.type === 'analytics') {
      SUPPORTED_METRICS_BY_STEP.analytics.forEach((type) => allowed.add(type));
    }
  });
  if (plan.report) {
    SUPPORTED_METRICS_BY_STEP.analytics.forEach((type) => allowed.add(type));
  }
  return allowed;
}

function expectedTaskCount(plan, question) {
  const explicitPeriodComparison = /\bthis month\b[\s\S]*\blast month\b|\blast month\b[\s\S]*\bthis month\b/i.test(question)
    || (plan.steps.some((step) => step.type === 'compare') && /\blast month\b/i.test(question));
  return plan.steps.reduce((total, step) => {
    const modules = step.modules?.length ? step.modules.length : 1;
    const periods = (step.type === 'compare' && explicitPeriodComparison)
      || (step.type === 'conversion_count' && plan.intents.includes('COMPARE')) ? 2 : 1;
    return total + (modules * periods);
  }, 0);
}

function calculateCounts(records) {
  return records.reduce((acc, record) => {
    const stage = getStage(record);
    if (stage) acc.stages[stage] = (acc.stages[stage] || 0) + 1;
    if (isClosedWon(stage)) acc.closedWonCount += 1;
    if (isClosedLost(stage)) acc.closedLostCount += 1;
    if (isClosedWon(stage)) acc.closedWonValue += numericValue(record?.Amount ?? record?.amount ?? record?.value ?? record?.Grand_Total ?? record?.Revenue ?? record?.Total_Revenue) || 0;
    if (!isClosedWon(stage) && !isClosedLost(stage)) acc.openPipelineValue += numericValue(record?.Amount ?? record?.amount ?? record?.value ?? record?.Grand_Total ?? record?.Revenue ?? record?.Total_Revenue) || 0;
    return acc;
  }, { stages: {}, closedWonCount: 0, closedLostCount: 0, closedWonValue: 0, openPipelineValue: 0 });
}

function aggregateValueFromDatasets(datasets, metric) {
  for (const dataset of datasets || []) {
    const info = dataset?.result?.info || dataset?.info || {};
    const values = info.aggregateValues || {};
    const value = values[metric] ?? (metric === 'sum' ? info.aggregateValue : undefined);
    if (value !== undefined && value !== null) return numericValue(value);
  }
  return null;
}

function countFromDatasets(datasets) {
  const counted = (datasets || []).filter((dataset) => dataset?.step?.type === 'count' || dataset?.result?.info?.retrievalStrategy === 'count');
  if (!counted.length) return null;
  return counted.reduce((total, dataset) => {
    const info = dataset?.result?.info || dataset?.info || {};
    const count = info.count === undefined || info.count === null
      ? (dataset?.result?.data || dataset?.data || []).length
      : Number(info.count);
    return total + (Number.isFinite(count) ? count : 0);
  }, 0);
}

function validateMetric(calculation, records, datasets, plan) {
  const actualRecords = records || [];
  const type = calculation.type;
  const value = calculation.value;

  if (type === 'count') {
    const aggregateCount = countFromDatasets(datasets);
    return { valid: value === (aggregateCount === null ? actualRecords.length : aggregateCount) };
  }
  if (type === 'counts') {
    return { valid: Object.values(value || {}).reduce((sum, item) => sum + Number(item || 0), 0) === actualRecords.length };
  }
  if (type === 'sum' || type === 'total_revenue') {
    const aggregate = aggregateValueFromDatasets(datasets, 'sum');
    return { valid: value === (aggregate === null ? sumAmounts(actualRecords) : aggregate) };
  }
  if (type === 'average') {
    const aggregate = aggregateValueFromDatasets(datasets, 'average');
    if (aggregate !== null) return { valid: Math.abs(value - aggregate) < 1e-6 };
    const amounts = actualRecords.map((record) => numericValue(record?.Amount ?? record?.amount ?? record?.value ?? record?.Grand_Total ?? record?.Revenue ?? record?.Total_Revenue)).filter((num) => num !== null);
    const expected = amounts.length ? amounts.reduce((sum, num) => sum + num, 0) / amounts.length : 0;
    return { valid: Math.abs(value - expected) < 1e-6 };
  }
  if (type === 'minimum') {
    const aggregate = aggregateValueFromDatasets(datasets, 'minimum');
    if (aggregate !== null) return { valid: Math.abs(value - aggregate) < 1e-6 };
    const amounts = actualRecords.map((record) => numericValue(record?.Amount ?? record?.amount ?? record?.value ?? record?.Grand_Total ?? record?.Revenue ?? record?.Total_Revenue)).filter((num) => num !== null);
    return { valid: amounts.length === 0 ? value === 0 : value === Math.min(...amounts) };
  }
  if (type === 'maximum') {
    const aggregate = aggregateValueFromDatasets(datasets, 'maximum');
    if (aggregate !== null) return { valid: Math.abs(value - aggregate) < 1e-6 };
    const amounts = actualRecords.map((record) => numericValue(record?.Amount ?? record?.amount ?? record?.value ?? record?.Grand_Total ?? record?.Revenue ?? record?.Total_Revenue)).filter((num) => num !== null);
    return { valid: amounts.length === 0 ? value === 0 : value === Math.max(...amounts) };
  }
  if (type === 'stage_distribution') {
    const expected = calculateCounts(actualRecords).stages;
    return { valid: JSON.stringify(value) === JSON.stringify(expected) };
  }
  if (type === 'closed_won_value') {
    const { closedWonValue } = calculateCounts(actualRecords);
    return { valid: value === closedWonValue };
  }
  if (type === 'closed_lost_count') {
    const { closedLostCount } = calculateCounts(actualRecords);
    return { valid: value === closedLostCount };
  }
  if (type === 'pipeline_value') {
    const { openPipelineValue } = calculateCounts(actualRecords);
    return { valid: value === openPipelineValue };
  }
  if (type === 'win_rate') {
    const { closedWonCount, closedLostCount } = calculateCounts(actualRecords);
    const expected = closedWonCount + closedLostCount ? closedWonCount / (closedWonCount + closedLostCount) : 0;
    return { valid: Math.abs(value - expected) < 1e-6 };
  }
  if (type === 'comparison') {
    if (!value || typeof value !== 'object') return { valid: false };
    const periods = Object.entries(value).filter(([key]) => key !== 'difference');
    if (periods.length < 2) return { valid: false };
    const hasRelativePeriods = Object.prototype.hasOwnProperty.call(value, 'this month')
      && Object.prototype.hasOwnProperty.call(value, 'last month');
    const orderedPeriods = hasRelativePeriods
      ? periods
      : periods.slice().sort(([left], [right]) => new Date(`${left} 1`).valueOf() - new Date(`${right} 1`).valueOf());
    const previous = numericValue(hasRelativePeriods ? value['last month'] : orderedPeriods[0][1]);
    const current = numericValue(hasRelativePeriods ? value['this month'] : orderedPeriods[orderedPeriods.length - 1][1]);
    return { valid: previous !== null && current !== null && value.difference === current - previous };
  }
  if (type === 'multi_module_comparison') {
    if (!value || typeof value !== 'object') return { valid: false };
    return { valid: Object.values(value).every((moduleValue) => {
      if (moduleValue && moduleValue.value !== undefined) return numericValue(moduleValue.value) !== null;
      const expected = numericValue(moduleValue['this month']) - numericValue(moduleValue['last month']);
      return moduleValue.difference === expected;
    }) };
  }
  if (type === 'conversion_count') {
    const converted = actualRecords.filter((record) => record.Converted__s === true || String(record.Converted__s).toLowerCase() === 'true' || record.Converted_Deal || record.Converted_Date_Time || record.Converted_Time || record.Conversion_Date);
    return { valid: value === converted.length };
  }
  if (type === 'conversion_rate') {
    const converted = actualRecords.filter((record) => record.Converted__s === true || String(record.Converted__s).toLowerCase() === 'true' || record.Converted_Deal || record.Converted_Date_Time || record.Converted_Time || record.Conversion_Date);
    const expected = actualRecords.length ? converted.length / actualRecords.length : 0;
    return { valid: Math.abs(value - expected) < 1e-6 };
  }
  if (type === 'month_over_month_growth' || type === 'quarter_over_quarter_growth' || type === 'year_over_year_growth') {
    if (!value || typeof value !== 'object') return { valid: false };
    const currentValue = numericValue(value.currentValue);
    const previousValue = numericValue(value.previousValue);
    if (previousValue === 0) return { valid: false };
    const expected = (currentValue - previousValue) / Math.abs(previousValue);
    return { valid: Math.abs(value.growth - expected) < 1e-6 };
  }
  if (type === 'top_owners' || type === 'top_sales_representatives') {
    return validateRankingMetric(calculation, actualRecords, ['Owner', 'Owner_Name', 'owner', 'owner_name']);
  }
  if (type === 'top_stages') {
    return validateRankingMetric(calculation, actualRecords, ['Stage', 'Status', 'Deal_Stage', 'Stage_Name']);
  }
  if (type === 'top_products') {
    return validateRankingMetric(calculation, actualRecords, ['Product_Name', 'Product', 'product_name', 'product']);
  }
  if (type === 'top_lead_sources') {
    return validateRankingMetric(calculation, actualRecords, ['Lead_Source', 'LeadSource', 'lead_source']);
  }
  if (type === 'top_customers') {
    return validateRankingMetric(calculation, actualRecords, ['Account_Name', 'Customer_Name', 'Company', 'account_name', 'customer_name', 'company']);
  }
  return { valid: true };
}

function validateResponse({ response, plan, datasets, calculations, limitations = [] }) {
  const issues = [];
  const warnings = [];
  if (!response || typeof response !== 'object') return { valid: false, issues: ['response_not_object'], warnings };
  if (!response.summary || typeof response.summary !== 'string') issues.push('missing_summary');
  if (response.requestedInformation !== plan.question) issues.push('requested_information_mismatch');
  if (!Array.isArray(response.keyMetrics)) issues.push('missing_key_metrics');
  if (limitations.length > 0 && !Array.isArray(response.limitations)) issues.push('missing_limitations');
  if (!Array.isArray(response.suggestedNextAnalysis)) issues.push('missing_suggested_next_analysis');

  const textToCheck = [response.summary, response.businessObservations?.map((item) => item.message).join(' ')].filter(Boolean).join(' ');
  if (BANNED_LANGUAGE.test(textToCheck)) issues.push('language_rules_violation');

  const allowedMetricTypes = getMetricTypesAllowedByPlan(plan);
  calculations.forEach((calculation) => {
    if (!allowedMetricTypes.has(calculation.type)) {
      warnings.push(`Unsupported calculation persisted: ${calculation.type}`);
    }
  });

  return { valid: issues.length === 0, issues: [...new Set(issues)], warnings };
}

function validateExecution({ plan, question, datasets, calculations, limitations = [] }) {
  const issues = [];
  const warnings = [];
  const records = flattenRecords(datasets);
  const expected = expectedTaskCount(plan, question);
  if (datasets.length < expected) issues.push('required_tasks_incomplete');

  const plannedModules = new Set(plan.modules || []);
  if (datasets.some((dataset) => dataset.module && plannedModules.size > 0 && !plannedModules.has(dataset.module))) issues.push('unexpected_dataset');

  const allIds = [];
  datasets.forEach((dataset) => {
    if (!dataset?.result || typeof dataset.result !== 'object') issues.push('dataset_missing');
    const retrievalInfo = dataset?.result?.info || {};
    if ((retrievalInfo.more_records === true || retrievalInfo.retrievalComplete === false)
      && !dataset.step?.explicit) issues.push('dataset_incomplete');
    const ids = getRecords(dataset).map((record) => record?.id ?? record?.ID).filter(Boolean).map(String);
    allIds.push(...ids);
    if (new Set(ids).size !== ids.length) issues.push('duplicate_records');
  });
  if (new Set(allIds).size !== allIds.length) issues.push('duplicate_records');

  const filterModules = Object.keys(plan.filterPlans || {});
  const filteredModules = datasets.filter((dataset) => dataset.module && filterModules.includes(dataset.module)).map((dataset) => dataset.module);
  if (filterModules.length > 0 && new Set(filteredModules).size !== filterModules.length) issues.push('required_filters_not_applied');

  const supportedMetrics = getMetricTypesAllowedByPlan(plan);
  const sanitizedCalculations = [];
  const correctedLimitations = [...limitations];
  const removedMetrics = [];

  calculations.forEach((calculation) => {
    if (!supportedMetrics.has(calculation.type)) {
      removedMetrics.push(calculation.type);
      correctedLimitations.push({ metric: calculation.type, reason: 'Unsupported metric type for this request.' });
      return;
    }
    const validation = validateMetric(calculation, records, datasets, plan);
    if (!validation.valid) {
      removedMetrics.push(calculation.type);
      correctedLimitations.push({ metric: calculation.type, reason: 'Metric value could not be validated against the retrieved CRM data.' });
      return;
    }
    sanitizedCalculations.push(calculation);
  });

  if (removedMetrics.length > 0) warnings.push(`Removed unsupported or invalid metrics: ${removedMetrics.join(', ')}`);
  if (plan.steps.some((step) => ['aggregate', 'compare', 'analytics', 'conversion_count'].includes(step.type)) && sanitizedCalculations.length === 0 && correctedLimitations.length === 0) issues.push('calculations_missing');

  return {
    valid: issues.length === 0,
    issues: [...new Set(issues)],
    warnings,
    calculations: sanitizedCalculations,
    limitations: correctedLimitations,
    removedMetrics,
  };
}

module.exports = {
  expectedTaskCount,
  validateExecution,
  validateResponse,
};
