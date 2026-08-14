const { DEBUG_ASSISTANT } = require('../../../common/config/env');
const {
  FALLBACK_REASONS,
  chooseFallback,
  logFallbackReason,
} = require('./fallback-engine.service');
const logger = require('../../../common/logging/logger');
const {
  numericValue,
  formatNumber,
  formatCurrency,
  isMonetaryField,
} = require('./currency.service');
const { getCustomerRecordScope } = require('../business-criteria.service');

const DATE_FIELDS = ['Closing_Date', 'Created_Time', 'CreatedDate', 'created_time', 'Created_Date', 'Modified_Time'];
const AVAILABILITY_FIELDS = [
  'data_available_through', 'dataAvailableThrough', 'available_through', 'availableThrough',
  'through_date', 'throughDate', 'cutoff_date', 'cutoffDate', 'as_of_date', 'asOfDate',
];
const CURRENCY_METRIC_TYPES = new Set([
  'sum', 'total_revenue', 'pipeline', 'pipeline_value', 'closed_won_value', 'closed_lost_value',
  'average', 'maximum', 'minimum',
]);

function formatPercentage(value) {
  const number = numericValue(value);
  return number === null ? String(value ?? '') : `${formatNumber(number * 100)}%`;
}

function formatMetricValue(type, value) {
  if (type === 'conversion_rate') return formatPercentage(value);
  if (CURRENCY_METRIC_TYPES.has(type)) return formatCurrency(value);
  if (type === 'counts' && value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, formatNumber(item)]));
  }
  if (['monthly_performance', 'month_wise_metrics'].includes(type) && value) {
    const totalsKey = value.monthlyTotals ? 'monthlyTotals' : null;
    return totalsKey
      ? { ...value, [totalsKey]: Object.fromEntries(Object.entries(value[totalsKey]).map(([key, item]) => [key, formatCurrency(item)])) }
      : value;
  }
  if (['quarter_wise_metrics', 'year_wise_metrics'].includes(type) && value) {
    const totalsKey = type === 'quarter_wise_metrics' ? 'quarterlyTotals' : 'yearlyTotals';
    return { ...value, [totalsKey]: Object.fromEntries(Object.entries(value[totalsKey] || {}).map(([key, item]) => [key, formatCurrency(item)])) };
  }
  if (type === 'comparison' && value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, formatCurrency(item)]));
  }
  if (type === 'multi_module_comparison' && value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([module, metrics]) => {
      if (metrics && typeof metrics === 'object' && Number.isFinite(numericValue(metrics.value))) {
        return [module, { value: formatCurrency(metrics.value) }];
      }
      return [module, Object.fromEntries(Object.entries(metrics).map(([key, item]) => [key, formatCurrency(item)]))];
    }));
  }
  if (['month_over_month_growth', 'quarter_over_quarter_growth', 'year_over_year_growth'].includes(type)
    && value && typeof value === 'object') {
    return {
      ...value,
      currentValue: formatCurrency(value.currentValue),
      previousValue: formatCurrency(value.previousValue),
      growth: formatPercentage(value.growth),
    };
  }
  if (['customer_ranking', 'product_ranking'].includes(type) && Array.isArray(value)) {
    return value.map((item) => ({ ...item, totalAmount: formatCurrency(item.totalAmount) }));
  }
  if (['stage_distribution', 'conversion_by_owner'].includes(type) && value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, formatNumber(item)]));
  }
  if (type === 'top_owners' && Array.isArray(value)) {
    return value.map((item) => ({ ...item, count: formatNumber(item.count) }));
  }
  if (typeof value === 'number') return formatNumber(value);
  return value;
}

function formatDisplayedRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
  const recordCurrency = record.Currency || record.currency || record.Currency_Code || null;
  const recordSymbol = record.Currency_Symbol || record.currency_symbol || null;
  return Object.fromEntries(Object.entries(record).map(([field, value]) => {
    if (isMonetaryField(field) && numericValue(value) !== null) {
      return [field, formatCurrency(value, recordCurrency, recordSymbol)];
    }
    return [field, value];
  }));
}

function presentMetrics(calculations) {
  return calculations.map((calculation) => ({
    type: calculation.type,
    label: calculation.label,
    value: formatMetricValue(calculation.type, calculation.value),
  }));
}

function recordsFrom(datasets) {
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

function infoFrom(datasets) {
  return datasets.flatMap((dataset) => [dataset?.result?.info, dataset?.info]).filter(Boolean);
}

function crmReturnedDate(datasets) {
  return infoFrom(datasets)
    .map((info) => AVAILABILITY_FIELDS.map((field) => info[field]).find((value) => value !== undefined && value !== null && value !== ''))
    .find(Boolean) || null;
}

function retrievalComplete(datasets) {
  return datasets.length > 0 && datasets.every((dataset) => {
    const info = dataset?.result?.info || dataset?.info || {};
    return info.more_records === false || info.retrievalComplete === true;
  });
}

function retrievalExplicitlyIncomplete(datasets) {
  return datasets.some((dataset) => {
    const info = dataset?.result?.info || dataset?.info || {};
    return info.more_records === true || info.retrievalComplete === false;
  });
}

function exactEmptyResultSummary(plan) {
  const question = String(plan?.question || '');
  const timeRange = plan?.timeRange || {};
  if (!/closed\s+won/i.test(question) || !/\bdeal(?:s)?\b/i.test(question)) return null;

  const monthMatch = question.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(20\d{2}))?\b/i);
  if (!monthMatch) return null;

  const month = `${monthMatch[1].charAt(0).toUpperCase()}${monthMatch[1].slice(1).toLowerCase()}`;
  const year = monthMatch[2] || timeRange.year || new Date().getUTCFullYear();
  return `No Closed Won deals were found for ${month} ${year}.`;
}

function monthKey(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.valueOf()) ? date.toISOString().slice(0, 7) : null;
}

function requestedMonths(plan) {
  const range = plan.timeRange || {};
  const now = new Date();
  if (range.monthCount) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - range.monthCount, 1));
    return Array.from({ length: range.monthCount }, (_, index) => new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + index, 1)).toISOString().slice(0, 7));
  }
  if (range.range === 'this_month' || range.range === 'last_month') {
    const offset = range.range === 'last_month' ? -1 : 0;
    return [new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)).toISOString().slice(0, 7)];
  }
  const namedMonth = /^(january|february|march|april|may|june|july|august|september|october|november|december)$/.test(range.label || '');
  if (namedMonth) {
    const month = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'].indexOf(range.label);
    return [new Date(Date.UTC(range.year || now.getUTCFullYear(), month, 1)).toISOString().slice(0, 7)];
  }
  return [];
}

function buildCoverage(plan, datasets, records) {
  const requested = requestedMonths(plan);
  const dataMonths = [...new Set(records.flatMap((record) => DATE_FIELDS.map((field) => monthKey(record[field])).filter(Boolean)))].sort();
  const monthsWithData = requested.length ? requested.filter((month) => dataMonths.includes(month)) : dataMonths;
  const monthsWithoutData = requested.length && (records.length === 0 || dataMonths.length > 0)
    ? requested.filter((month) => !monthsWithData.includes(month))
    : [];
  const returnedThrough = crmReturnedDate(datasets);
  const complete = retrievalComplete(datasets) && !returnedThrough;
  const coverage = returnedThrough
    ? `Data available through ${returnedThrough}.`
    : complete
      ? 'CRM records cover the requested query.'
      : 'Coverage for the full requested period could not be confirmed.';

  return {
    requestedPeriod: plan.timeRange?.label || 'the requested period',
    retrievedDataCoverage: coverage,
    monthsWithData,
    monthsWithoutRetrievedRecords: monthsWithoutData,
    complete,
  };
}

function hasAmount(record) {
  const value = record?.Amount ?? record?.amount ?? record?.value ?? record?.Grand_Total;
  return numericValue(value) !== null;
}

function metricSummary(calculations, dataLength) {
  const conversionRate = calculations.find((item) => item.type === 'conversion_rate');
  const conversionCount = calculations.find((item) => item.type === 'conversion_count');
  const pipeline = calculations.find((item) => ['pipeline', 'pipeline_value'].includes(item.type));
  const stageDistribution = calculations.find((item) => item.type === 'stage_distribution');
  const monthly = calculations.find((item) => ['monthly_performance', 'month_wise_metrics'].includes(item.type));
  const comparison = calculations.find((item) => item.type === 'comparison');
  const multi = calculations.find((item) => item.type === 'multi_module_comparison');
  const sum = calculations.find((item) => item.type === 'sum');
  const totalRevenue = calculations.find((item) => item.type === 'total_revenue');
  const closedWon = calculations.find((item) => item.type === 'closed_won_value');
  const average = calculations.find((item) => item.type === 'average');
  const count = calculations.find((item) => item.type === 'count');
  const counts = calculations.find((item) => item.type === 'counts');

  if (conversionRate) return `Lead conversion rate: ${formatPercentage(conversionRate.value)}.`;
  if (conversionCount) return `${formatNumber(conversionCount.value)} converted leads.`;
  if (pipeline) return `Pipeline value: ${formatCurrency(pipeline.value)}.`;
  if (stageDistribution) return `Stage distribution: ${Object.entries(stageDistribution.value).map(([stage, value]) => `${stage} ${formatNumber(value)}`).join(', ')}.`;
  if (monthly) return `Monthly values: ${Object.entries(monthly.value.monthlyTotals).map(([month, value]) => `${month} ${formatCurrency(value)}`).join(', ')}.`;
  if (multi) {
    return `comparison: ${Object.entries(multi.value).map(([module, values]) => {
      if (values && typeof values === 'object' && Number.isFinite(numericValue(values.value))) {
        return `${module}: ${formatCurrency(values.value)}`;
      }
      return `${module}: this month ${formatCurrency(values['this month'])}, last month ${formatCurrency(values['last month'])}, difference ${formatCurrency(values.difference)}`;
    }).join('; ')}.`;
  }
  if (comparison) {
    const periods = Object.entries(comparison.value).filter(([key]) => key !== 'difference');
    return `comparison: ${periods.map(([period, value]) => `${period} ${formatCurrency(value)}`).join('; ')}; difference ${formatCurrency(comparison.value.difference)}.`;
  }
  if (average) return `Average deal value: ${formatCurrency(average.value)}.`;
  if (sum) return `Total value: ${formatCurrency(sum.value)}.`;
  if (totalRevenue) return `Total revenue: ${formatCurrency(totalRevenue.value)}.`;
  if (closedWon) return `Closed Won value: ${formatCurrency(closedWon.value)}.`;
  if (counts) return `Record counts: ${Object.entries(counts.value).map(([module, value]) => `${module} ${formatNumber(value)}`).join(', ')}.`;
  if (count) return `${formatNumber(count.value)} matching ${Number(count.value) === 1 ? 'record' : 'records'}.`;
  return `${formatNumber(dataLength)} ${dataLength === 1 ? 'record' : 'records'}.`;
}

function ownerName(record) {
  const owner = record?.Owner || record?.Owner_Name || record?.owner;
  if (typeof owner === 'string') return owner;
  return owner?.name || owner?.Name || owner?.full_name || null;
}

function dataBackedFollowUps(records, coverage) {
  const questions = [];
  const owners = [...new Set(records.map(ownerName).filter(Boolean))];
  const hasAmounts = records.some(hasAmount);
  if (owners.length > 0) questions.push(`Compare records by owner: ${owners.slice(0, 3).join(', ')}.`);
  if (coverage.monthsWithData.length > 1) questions.push(`Compare record counts across ${coverage.monthsWithData.join(', ')}.`);
  if (hasAmounts && questions.length < 2) questions.push('Show records with recorded amounts.');
  return questions.slice(0, 2);
}

function buildTables(records) {
  if (records.length === 0) return [];
  const columns = [...new Set(records.flatMap((record) => Object.keys(record || {})))]
    .filter((column) => !column.startsWith('_') && records.some((record) => record[column] !== undefined && record[column] !== null && record[column] !== ''))
    .slice(0, 12);
  const displayValue = (column, value) => {
    if (value === undefined || value === null || value === '') return '';
    if (isMonetaryField(column) && numericValue(value) !== null) return formatCurrency(value);
    if (typeof value === 'number') return formatNumber(value);
    if (typeof value === 'object') return value.name || value.Name || value.full_name || JSON.stringify(value);
    return String(value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
  };
  const rows = records.map((record) => columns.map((column) => displayValue(column, record[column])));
  const markdown = [
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
  return [{
    title: 'CRM Records',
    columns,
    rows,
    markdown,
  }];
}

function filtersAppliedFor(plan) {
  const queryPlan = plan?.queryPlan;
  const filterPlan = queryPlan && plan?.filterPlans?.[queryPlan.moduleKey];
  const filters = filterPlan?.filters || queryPlan?.filters || [];
  return filters.reduce((result, filter) => {
    if (!filter?.logicalField) return result;
    if (filter.operator === 'between' && Array.isArray(filter.value)) {
      result[filter.logicalField] = { field: filter.field, from: filter.value[0], to: filter.value[1] };
    } else {
      result[filter.logicalField] = { field: filter.field, operator: filter.operator, value: filter.value };
    }
    return result;
  }, {});
}

function matchingRecordTotal(datasets, displayTotal) {
  return Math.max(displayTotal, ...infoFrom(datasets).map((info) => Number(info.count)).filter(Number.isFinite), 0);
}

function dateInRange(value, startDate, endDate) {
  const date = value ? new Date(value) : null;
  const start = startDate ? new Date(startDate) : null;
  const end = endDate ? new Date(endDate) : null;
  if (!date || !start || !end || Number.isNaN(date.valueOf()) || Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf())) return null;
  return date >= start && date < end;
}

function amountTotal(records) {
  return records.reduce((total, record) => (
    total + (numericValue(record?.Amount ?? record?.amount ?? record?.value ?? record?.Grand_Total ?? record?.Revenue ?? record?.Total_Revenue) ?? 0)
  ), 0);
}

function aggregateTotal(calculations, records) {
  const calculation = calculations.find((item) => ['total_revenue', 'sum', 'closed_won_value', 'pipeline'].includes(item.type));
  const value = calculation ? numericValue(calculation.value) : null;
  return value === null ? amountTotal(records) : value;
}

function buildRetrievalMetadata(plan, datasets, records, calculations, matchingTotal) {
  const startDate = plan.timeRange?.startDate || null;
  const endDate = plan.timeRange?.endDate || null;
  const classified = records.reduce((counts, record) => {
    const isNew = dateInRange(record?.Created_Time ?? record?.Created_Date ?? record?.CreatedDate, startDate, endDate);
    if (isNew === true) counts.newRecords += 1;
    else if (isNew === false) counts.existingRecords += 1;
    else counts.unclassifiedRecords += 1;
    return counts;
  }, { newRecords: 0, existingRecords: 0, unclassifiedRecords: 0 });
  const total = aggregateTotal(calculations, records);
  const infos = infoFrom(datasets);

  return {
    requestedPeriod: {
      label: plan.timeRange?.label || 'the requested period',
      startDate,
      endDate,
    },
    businessDateField: plan.queryPlan?.dateField || null,
    customerScope: plan.queryPlan?.customerScope || getCustomerRecordScope(plan.question),
    totalRecordsRetrieved: matchingTotal,
    totalRecordsEvaluated: matchingTotal,
    newRecords: records.length ? classified.newRecords : null,
    existingRecords: records.length ? classified.existingRecords : null,
    unclassifiedRecords: records.length ? classified.unclassifiedRecords : null,
    duplicateRecordsRemoved: infos.reduce((totalRemoved, info) => totalRemoved + (Number(info.duplicateRecordsRemoved) || 0), 0),
    totalAmountRevenue: formatCurrency(total),
  };
}

const FACTUAL_OBSERVATION_TYPES = new Set([
  'highest_value',
  'lowest_value',
  'top_performer',
  'bottom_performer',
  'increase',
  'decrease',
]);

function factualObservations(observations) {
  return (Array.isArray(observations) ? observations : [])
    .filter((observation) => observation
      && FACTUAL_OBSERVATION_TYPES.has(observation.type)
      && typeof observation.message === 'string'
      && !/approx\.?|around|roughly|approximately|~|latest records|retrieved dataset|first page|pagination|backend|api|connector|surged|strong momentum|healthy growth|pipeline remains strong/i.test(observation.message))
    .map((observation) => ({ type: observation.type, message: observation.message }));
}

function formatResponse(plan, datasets, calculations, options = {}) {
  const records = recordsFrom(datasets);
  const displayRecords = Array.isArray(options.displayRecords) ? options.displayRecords : records.slice(0, 25);
  const displayStart = Number.isInteger(options.displayStart) ? options.displayStart : 0;
  const displayTotal = Number.isInteger(options.displayTotal) ? options.displayTotal : records.length;
  const coverage = buildCoverage(plan, datasets, records);
  const currentMonthLabel = plan.timeRange?.includesCurrentMonth ? 'Current Month (Month-to-Date): ' : '';
  const conversionUnavailable = Boolean(options.conversionFallback) || calculations.some((calculation) => calculation.type === 'conversion_unavailable');
  const limitations = [];
  if (options.limitation) limitations.push(options.limitation);
  if (Array.isArray(options.limitations)) limitations.push(...options.limitations);
  if (!coverage.complete && coverage.requestedPeriod !== 'the requested period') limitations.push('Available CRM data does not cover the entire requested period.');
  if (requestedMonths(plan).length > 0 && records.length > 0 && coverage.monthsWithData.length === 0) limitations.push('Available CRM records do not contain a usable date field for month coverage.');

  if (conversionUnavailable) {
    limitations.push('Lead conversion cannot be calculated because the required conversion fields were not available in the CRM records.');
    calculations = calculations.filter((calculation) => calculation.type !== 'conversion_unavailable');
  }

  if (options.limitation || options.conversionFallback) {
    calculations = calculations.filter((calculation) => calculation.type !== 'conversion_unavailable');
  }

  if (records.length === 0 && calculations.length === 0) {
    logFallbackReason(options.emptyReason || FALLBACK_REASONS.EMPTY_RESULT);
  }

  const incompleteRetrieval = retrievalExplicitlyIncomplete(datasets);
  const emptySummary = exactEmptyResultSummary(plan)
    || chooseFallback({ reason: options.emptyReason || FALLBACK_REASONS.EMPTY_RESULT }).answer;
  const summary = conversionUnavailable
    ? 'Lead conversion cannot be calculated from the CRM records.'
    : incompleteRetrieval
      ? 'The CRM search could not be completed, so I cannot confirm whether matching records exist.'
    : records.length === 0 && calculations.length === 0
      ? emptySummary
      : plan.intents?.includes('LIST') && calculations.length === 0
        ? plan.pagination?.explicit && displayStart === 0 && displayTotal === displayRecords.length
          ? `${currentMonthLabel}${displayRecords.length} records.`
          : `${currentMonthLabel}Showing ${displayRecords.length} of ${displayTotal} matching records.${displayTotal > displayRecords.length ? ` There are ${displayTotal - (displayStart + displayRecords.length)} more matching records available.` : ''}`
      : `${currentMonthLabel}${metricSummary(calculations, records.length)}`;
  const summaryWithAvailability = crmReturnedDate(datasets)
    ? `${summary} Data available through ${crmReturnedDate(datasets)}.`
    : summary;
  const remainingRecords = Math.max(0, displayTotal - (displayStart + displayRecords.length));
  const formattedRecords = displayRecords.map(formatDisplayedRecord);
  const matchingTotal = matchingRecordTotal(datasets, displayTotal);
  const retrievalMetadata = buildRetrievalMetadata(plan, datasets, records, calculations, matchingTotal);
  const structuredModule = plan.queryPlan?.module || (plan.modules?.length === 1 ? plan.modules[0] : plan.modules);
  const structuredOperation = plan.queryPlan?.operation || (plan.intents?.includes('LIST') ? 'LIST' : null);
  const observations = factualObservations(options.insights);
  const followUps = dataBackedFollowUps(records, coverage);
  const response = {
    success: true,
    summary: summaryWithAvailability,
    retrievedDataCoverage: {
      requestedPeriod: coverage.requestedPeriod,
      retrievedDataCoverage: coverage.retrievedDataCoverage,
      dataCoverage: coverage.retrievedDataCoverage,
      monthsWithData: coverage.monthsWithData,
      monthsWithoutRetrievedRecords: coverage.monthsWithoutRetrievedRecords,
      unavailablePeriods: coverage.monthsWithoutRetrievedRecords,
    },
    requestedInformation: plan.question,
    module: structuredModule,
    operation: structuredOperation,
    filtersApplied: filtersAppliedFor(plan),
    calculatedMetrics: calculations,
    businessObservations: observations,
    limitations,
    keyMetrics: presentMetrics(calculations),
    suggestedNextAnalysis: followUps,
    data: formattedRecords,
    records: formattedRecords,
    displayed: formattedRecords.length,
    totalMatching: matchingTotal,
    crmRetrievalMetadata: retrievalMetadata,
    retrievalMetadata,
    hasMore: remainingRecords > 0,
    tables: buildTables(formattedRecords),
    continuation: {
      available: remainingRecords > 0,
      remainingRecords,
      action: remainingRecords > 0 ? 'show more' : null,
    },
    calculations,
    insights: observations,
    followUpQuestions: followUps,
  };

  if (DEBUG_ASSISTANT) logger.info('Response Engine', {
    requestedInformation: plan.question,
    calculatedMetrics: calculations,
    limitations,
  });
  return response;
}

module.exports = { formatResponse };
