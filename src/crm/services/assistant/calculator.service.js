const { DEBUG_ASSISTANT } = require('../../../common/config/env');
const logger = require('../../../common/logging/logger');
const { numericValue } = require('./currency.service');

const AMOUNT_FIELDS = ['Amount', 'amount', 'value', 'Grand_Total', 'Revenue', 'Total_Revenue', 'Deal_Value', 'Deal_Amount'];
const STAGE_FIELDS = ['Stage', 'Status', 'Deal_Stage', 'Stage_Name'];
const OWNER_FIELDS = ['Owner', 'Owner_Name', 'owner', 'owner_name'];
const CUSTOMER_FIELDS = ['Account_Name', 'Customer_Name', 'Company', 'account_name', 'customer_name', 'company'];
const PRODUCT_FIELDS = ['Product_Name', 'Product', 'product_name', 'product'];
const LEAD_SOURCE_FIELDS = ['Lead_Source', 'LeadSource', 'lead_source'];
const DATE_FIELDS = ['Closing_Date', 'Created_Time', 'CreatedDate', 'created_time', 'Created_Date', 'Modified_Time', 'CloseDate', 'Close_Date', 'Close_DateTime', 'Date', 'CreatedAt', 'UpdatedAt'];
const CONVERSION_FIELDS = ['Converted', 'Converted__s', 'Converted_Deal', 'Converted_Date', 'Converted_Time', 'Converted_Date_Time', 'Conversion_Date'];
const GROWTH_UNAVAILABLE_MESSAGE = 'Growth cannot be calculated because one or more comparison periods are unavailable.';

function getFirstExistingField(record, fields) {
  if (!record || typeof record !== 'object') return null;
  for (const field of fields) {
    const value = record[field];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function normalizeString(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') return value.name || value.Name || value.full_name || value.fullName || value.company || value.Company || null;
  return null;
}

function getAmount(record) {
  return numericValue(getFirstExistingField(record, AMOUNT_FIELDS));
}

function datasetInfo(dataset) {
  return dataset?.result?.info || dataset?.info || {};
}

function datasetCount(dataset) {
  const info = datasetInfo(dataset);
  return info.count !== undefined && info.count !== null && Number.isFinite(Number(info.count))
    ? Number(info.count)
    : (dataset?.result?.data || dataset?.data || []).length;
}

function datasetAggregateValue(dataset, metric = 'sum') {
  const info = datasetInfo(dataset);
  const values = info.aggregateValues || {};
  const value = values[metric] ?? (metric === 'sum' ? info.aggregateValue : undefined);
  return value === undefined || value === null ? null : numericValue(value);
}

function datasetAmount(dataset) {
  const aggregate = datasetAggregateValue(dataset, 'sum');
  if (aggregate !== null) return aggregate;
  return (dataset?.result?.data || dataset?.data || []).reduce((sum, record) => sum + (getAmount(record) ?? 0), 0);
}

function getStage(record) {
  return normalizeString(getFirstExistingField(record, STAGE_FIELDS));
}

function normalizeOwner(record) {
  return normalizeString(getFirstExistingField(record, OWNER_FIELDS));
}

function normalizeCustomer(record) {
  return normalizeString(getFirstExistingField(record, CUSTOMER_FIELDS));
}

function normalizeProduct(record) {
  return normalizeString(getFirstExistingField(record, PRODUCT_FIELDS));
}

function normalizeLeadSource(record) {
  return normalizeString(getFirstExistingField(record, LEAD_SOURCE_FIELDS));
}

function getRecordDate(record) {
  const raw = getFirstExistingField(record, DATE_FIELDS);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function quarterKey(date) {
  return `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
}

function yearKey(date) {
  return String(date.getUTCFullYear());
}

function isClosedWon(stage) {
  return typeof stage === 'string' && /closed\s*won|\bwon\b/i.test(stage);
}

function isClosedLost(stage) {
  return typeof stage === 'string' && /closed\s*lost|\blost\b/i.test(stage);
}

function isOpenStage(stage) {
  return stage && !isClosedWon(stage) && !isClosedLost(stage);
}

function topRankings(groups, labelField = 'name', valueField = 'count', size = 5) {
  return Object.entries(groups)
    .map(([key, value]) => ({ [labelField]: key, [valueField]: value }))
    .sort((a, b) => Number(b[valueField] ?? 0) - Number(a[valueField] ?? 0))
    .slice(0, size);
}

function buildPeriodTotals(records, keyFn) {
  return records.reduce((acc, record) => {
    const date = getRecordDate(record);
    if (!date) return acc;
    const key = keyFn(date);
    acc.counts[key] = (acc.counts[key] || 0) + 1;
    const amount = getAmount(record);
    if (amount !== null) acc.totals[key] = (acc.totals[key] || 0) + amount;
    return acc;
  }, { counts: {}, totals: {} });
}

function parsePeriodKey(key, periodType) {
  if (periodType === 'month') {
    const [year, month] = key.split('-').map(Number);
    if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
    return new Date(Date.UTC(year, month - 1, 1));
  }
  if (periodType === 'quarter') {
    const [yearPart, quarterPart] = key.split('-Q');
    const year = Number(yearPart);
    const quarter = Number(quarterPart);
    if (!Number.isFinite(year) || !Number.isFinite(quarter) || quarter < 1 || quarter > 4) return null;
    return new Date(Date.UTC(year, (quarter - 1) * 3, 1));
  }
  if (periodType === 'year') {
    const year = Number(key);
    if (!Number.isFinite(year)) return null;
    return new Date(Date.UTC(year, 0, 1));
  }
  return null;
}

function sortPeriodKeys(keys, periodType) {
  return keys
    .map((key) => ({ key, date: parsePeriodKey(key, periodType) }))
    .filter((entry) => entry.date)
    .sort((a, b) => a.date - b.date)
    .map((entry) => entry.key);
}

function isConsecutivePeriod(periodType, previousKey, currentKey) {
  const previousDate = parsePeriodKey(previousKey, periodType);
  const currentDate = parsePeriodKey(currentKey, periodType);
  if (!previousDate || !currentDate) return false;
  if (periodType === 'month') {
    return (currentDate.getUTCFullYear() - previousDate.getUTCFullYear()) * 12
      + (currentDate.getUTCMonth() - previousDate.getUTCMonth()) === 1;
  }
  if (periodType === 'quarter') {
    return (currentDate.getUTCFullYear() - previousDate.getUTCFullYear()) * 4
      + (Math.floor(currentDate.getUTCMonth() / 3) - Math.floor(previousDate.getUTCMonth() / 3)) === 1;
  }
  if (periodType === 'year') {
    return currentDate.getUTCFullYear() - previousDate.getUTCFullYear() === 1;
  }
  return false;
}

function calculateGrowth(totals, periodType) {
  const sortedKeys = sortPeriodKeys(Object.keys(totals), periodType);
  if (sortedKeys.length < 2) return null;
  for (let index = sortedKeys.length - 1; index > 0; index -= 1) {
    const currentKey = sortedKeys[index];
    const previousKey = sortedKeys[index - 1];
    if (!isConsecutivePeriod(periodType, previousKey, currentKey)) continue;
    const previousValue = totals[previousKey] ?? 0;
    if (previousValue === 0) return null;
    const currentValue = totals[currentKey] ?? 0;
    return {
      previousPeriod: previousKey,
      currentPeriod: currentKey,
      previousValue,
      currentValue,
      growth: (currentValue - previousValue) / Math.abs(previousValue),
    };
  }
  return null;
}

function calculateResult(plan, datasets) {
  const startAt = Date.now();
  const records = datasets.flatMap((dataset) => (dataset?.result?.data || dataset?.data || []));
  const calculations = [];
  const limitations = [];
  const requestedMetrics = [...new Set((plan.steps || []).map((step) => step.type))];

  const amountValues = records.map(getAmount).filter((value) => value !== null);
  const stageValues = records.map(getStage).filter(Boolean);
  const ownerValues = records.map(normalizeOwner).filter(Boolean);
  const customerValues = records.map(normalizeCustomer).filter(Boolean);
  const productValues = records.map(normalizeProduct).filter(Boolean);
  const leadSourceValues = records.map(normalizeLeadSource).filter(Boolean);
  const datedRecords = records.filter((record) => getRecordDate(record));
  const hasStageField = records.some((record) => getFirstExistingField(record, STAGE_FIELDS) !== null);

  function addLimitation(metric, reason) {
    limitations.push({ metric, reason });
  }

  function countRecords() {
    const countDatasets = datasets.filter((dataset) => dataset.step?.type === 'count' || (plan.steps || []).length === 1);
    if (countDatasets.length <= 1) {
      const count = countDatasets.length ? datasetCount(countDatasets[0]) : records.length;
      calculations.push({ label: 'Count', type: 'count', value: count });
    } else {
      const counts = {};
      countDatasets.forEach((dataset) => {
        const module = dataset.module || 'crm';
        counts[module] = datasetCount(dataset);
      });
      calculations.push({ label: 'Counts', type: 'counts', value: counts });
    }
  }

  function addAggregations() {
    const aggregateInfo = datasets.map((dataset) => datasetInfo(dataset).aggregateValues || {}).find((values) => Object.keys(values).length > 0);
    if (aggregateInfo) {
      if (aggregateInfo.sum !== undefined) {
        calculations.push({ label: 'Sum', type: 'sum', value: aggregateInfo.sum });
        calculations.push({ label: 'Total revenue', type: 'total_revenue', value: aggregateInfo.sum });
      }
      if (aggregateInfo.average !== undefined) calculations.push({ label: 'Average', type: 'average', value: aggregateInfo.average });
      if (aggregateInfo.minimum !== undefined) calculations.push({ label: 'Minimum', type: 'minimum', value: aggregateInfo.minimum });
      if (aggregateInfo.maximum !== undefined) calculations.push({ label: 'Maximum', type: 'maximum', value: aggregateInfo.maximum });
      return;
    }
    if (!amountValues.length) {
      addLimitation('sum', 'Amount fields are missing or invalid.');
      return;
    }
    const sum = amountValues.reduce((total, value) => total + value, 0);
    calculations.push({ label: 'Sum', type: 'sum', value: sum });
    calculations.push({ label: 'Average', type: 'average', value: sum / amountValues.length });
    calculations.push({ label: 'Minimum', type: 'minimum', value: Math.min(...amountValues) });
    calculations.push({ label: 'Maximum', type: 'maximum', value: Math.max(...amountValues) });
    calculations.push({ label: 'Total revenue', type: 'total_revenue', value: sum });
  }

  function addComparison() {
    const periodDatasets = datasets.filter((dataset) => dataset.period);
    const modules = [...new Set(datasets.map((dataset) => dataset.module).filter(Boolean))];

    if (modules.length > 1 && !periodDatasets.length) {
      const comparison = {};
      modules.forEach((module) => {
        const moduleRecords = datasets
          .filter((dataset) => dataset.module === module)
          .flatMap((dataset) => dataset.result?.data || dataset.data || []);
        comparison[module] = {
          value: moduleRecords.reduce((sum, record) => sum + (getAmount(record) ?? 0), 0),
        };
      });
      calculations.push({ label: 'Multi-module comparison', type: 'multi_module_comparison', value: comparison });
      return;
    }

    if (!periodDatasets.length) {
      addLimitation('comparison', 'Comparison periods are unavailable.');
      return;
    }

    const periods = periodDatasets.reduce((acc, dataset) => {
      const period = dataset.period || 'all time';
      const module = dataset.module || 'crm';
      acc[period] = acc[period] || {};
      acc[period][module] = dataset;
      return acc;
    }, {});
    const periodKeys = Object.keys(periods);
    if (modules.length > 1) {
      const comparison = {};
      modules.forEach((module) => {
        const thisDataset = periods['this month']?.[module] || periods[periodKeys[1]]?.[module];
        const lastDataset = periods['last month']?.[module] || periods[periodKeys[0]]?.[module];
        const thisValue = thisDataset ? datasetAmount(thisDataset) : 0;
        const lastValue = lastDataset ? datasetAmount(lastDataset) : 0;
        comparison[module] = { 'this month': thisValue, 'last month': lastValue, difference: thisValue - lastValue };
      });
      calculations.push({ label: 'Multi-module comparison', type: 'multi_module_comparison', value: comparison });
    } else {
      const module = modules[0] || 'crm';
      const thisKey = periods['this month'] ? 'this month' : periodKeys[1];
      const lastKey = periods['last month'] ? 'last month' : periodKeys[0];
      const thisValue = thisKey && periods[thisKey]?.[module] ? datasetAmount(periods[thisKey][module]) : 0;
      const lastValue = lastKey && periods[lastKey]?.[module] ? datasetAmount(periods[lastKey][module]) : 0;
      calculations.push({ label: 'Comparison', type: 'comparison', value: { [thisKey || 'this month']: thisValue, [lastKey || 'last month']: lastValue, difference: thisValue - lastValue } });
    }
  }

  function addConversionMetrics() {
    const hasConversion = records.some((record) => CONVERSION_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(record, field)));
    if (!hasConversion) {
      calculations.push({ label: 'Conversion data unavailable', type: 'conversion_unavailable', value: true });
      addLimitation('conversion_rate', 'Conversion fields were not available in the CRM records.');
      return;
    }
    const converted = records.filter((record) => (
      record.Converted__s === true
      || String(record.Converted__s).toLowerCase() === 'true'
      || record.Converted_Deal
      || record.Converted_Date_Time
      || record.Converted_Time
      || record.Conversion_Date
    ));
    calculations.push({ label: 'Conversion count', type: 'conversion_count', value: converted.length });
    const conversionStep = (plan.steps || []).find((step) => step.type === 'conversion_count');
    if (conversionStep?.metric === 'rate') {
      calculations.push({ label: 'Conversion rate', type: 'conversion_rate', value: records.length ? converted.length / records.length : 0 });
    }
  }

  function addAnalyticsMetrics() {
    if (ownerValues.length) {
      const ownerGroups = ownerValues.reduce((acc, owner) => {
        acc[owner] = (acc[owner] || 0) + 1;
        return acc;
      }, {});
      calculations.push({ label: 'Owner distribution', type: 'owner_distribution', value: ownerGroups });
      calculations.push({ label: 'Top owners', type: 'top_owners', value: topRankings(ownerGroups, 'owner', 'count', 5) });
      calculations.push({ label: 'Top sales representatives', type: 'top_sales_representatives', value: topRankings(ownerGroups, 'owner', 'count', 5) });
    } else {
      addLimitation('owner_distribution', 'Owner information is not available in the CRM records.');
    }

    if (stageValues.length) {
      const stageGroups = stageValues.reduce((acc, stage) => {
        acc[stage] = (acc[stage] || 0) + 1;
        return acc;
      }, {});
      calculations.push({ label: 'Stage distribution', type: 'stage_distribution', value: stageGroups });
      calculations.push({ label: 'Top stages', type: 'top_stages', value: topRankings(stageGroups, 'stage', 'count', 5) });
    } else {
      addLimitation('stage_distribution', 'Stage information is not available in the CRM records.');
    }

    if (customerValues.length) {
      const customerGroups = {};
      const customerAmounts = {};
      records.forEach((record) => {
        const customer = normalizeCustomer(record);
        if (!customer) return;
        customerGroups[customer] = (customerGroups[customer] || 0) + 1;
        const amount = getAmount(record);
        if (amount !== null) customerAmounts[customer] = (customerAmounts[customer] || 0) + amount;
      });
      calculations.push({ label: 'Customer ranking', type: 'customer_ranking', value: topRankings(customerGroups, 'customer', 'count', 5).map((entry) => ({ ...entry, totalAmount: customerAmounts[entry.customer] ?? 0 })) });
      calculations.push({ label: 'Top customers', type: 'top_customers', value: topRankings(customerGroups, 'customer', 'count', 5) });
    } else {
      addLimitation('customer_ranking', 'Customer information is not available in the CRM records.');
    }

    if (productValues.length) {
      const productGroups = {};
      const productAmounts = {};
      records.forEach((record) => {
        const product = normalizeProduct(record);
        if (!product) return;
        productGroups[product] = (productGroups[product] || 0) + 1;
        const amount = getAmount(record);
        if (amount !== null) productAmounts[product] = (productAmounts[product] || 0) + amount;
      });
      calculations.push({ label: 'Product ranking', type: 'product_ranking', value: topRankings(productGroups, 'product', 'count', 5).map((entry) => ({ ...entry, totalAmount: productAmounts[entry.product] ?? 0 })) });
      calculations.push({ label: 'Top products', type: 'top_products', value: topRankings(productGroups, 'product', 'count', 5) });
    } else {
      addLimitation('product_ranking', 'Product information is not available in the CRM records.');
    }

    if (leadSourceValues.length) {
      const sourceGroups = leadSourceValues.reduce((acc, source) => {
        acc[source] = (acc[source] || 0) + 1;
        return acc;
      }, {});
      calculations.push({ label: 'Lead source distribution', type: 'lead_source_distribution', value: sourceGroups });
      calculations.push({ label: 'Top lead sources', type: 'top_lead_sources', value: topRankings(sourceGroups, 'leadSource', 'count', 5) });
    } else {
      addLimitation('lead_source_distribution', 'Lead source information is not available in the CRM records.');
    }

    if (hasStageField) {
      const closedWonValue = records.filter((record) => isClosedWon(getStage(record))).map(getAmount).filter((value) => value !== null).reduce((total, value) => total + value, 0);
      const closedLostCount = records.filter((record) => isClosedLost(getStage(record))).length;
      const closedWonCount = records.filter((record) => isClosedWon(getStage(record))).length;
      calculations.push({ label: 'Closed won value', type: 'closed_won_value', value: closedWonValue });
      calculations.push({ label: 'Closed lost count', type: 'closed_lost_count', value: closedLostCount });
      const openPipelineAmounts = records.filter((record) => isOpenStage(getStage(record))).map(getAmount).filter((value) => value !== null);
      if (openPipelineAmounts.length) {
        const pipelineVal = openPipelineAmounts.reduce((total, value) => total + value, 0);
        calculations.push({ label: 'Pipeline value', type: 'pipeline', value: pipelineVal });
        calculations.push({ label: 'Pipeline value', type: 'pipeline_value', value: pipelineVal });
      } else {
        addLimitation('pipeline', 'Open deal amounts are unavailable for pipeline calculation.');
        addLimitation('pipeline_value', 'Open deal amounts are unavailable for pipeline calculation.');
      }
      if (closedWonCount > 0 && closedLostCount > 0) {
        calculations.push({ label: 'Win rate', type: 'win_rate', value: closedWonCount / (closedWonCount + closedLostCount) });
      } else {
        addLimitation('win_rate', 'Win rate cannot be calculated because closed won or closed lost counts are unavailable.');
      }
    } else {
      addLimitation('closed_won_value', 'Stage information is not available in the CRM records.');
      addLimitation('closed_lost_count', 'Stage information is not available in the CRM records.');
      addLimitation('pipeline_value', 'Stage information is not available in the CRM records.');
      addLimitation('win_rate', 'Stage information is not available in the CRM records.');
    }
  }

  function addPeriodMetrics() {
    if (!datedRecords.length) {
      addLimitation('month_wise_metrics', 'Date fields are not available in the CRM records.');
      addLimitation('quarter_wise_metrics', 'Date fields are not available in the CRM records.');
      addLimitation('year_wise_metrics', 'Date fields are not available in the CRM records.');
      addLimitation('month_over_month_growth', GROWTH_UNAVAILABLE_MESSAGE);
      addLimitation('quarter_over_quarter_growth', GROWTH_UNAVAILABLE_MESSAGE);
      addLimitation('year_over_year_growth', GROWTH_UNAVAILABLE_MESSAGE);
      return;
    }

    const monthly = buildPeriodTotals(datedRecords, monthKey);
    const quarterly = buildPeriodTotals(datedRecords, quarterKey);
    const yearly = buildPeriodTotals(datedRecords, yearKey);

    calculations.push({ label: 'Month-wise metrics', type: 'month_wise_metrics', value: { monthlyTotals: monthly.totals, monthlyCounts: monthly.counts } });
    calculations.push({ label: 'Quarter-wise metrics', type: 'quarter_wise_metrics', value: { quarterlyTotals: quarterly.totals, quarterlyCounts: quarterly.counts } });
    calculations.push({ label: 'Year-wise metrics', type: 'year_wise_metrics', value: { yearlyTotals: yearly.totals, yearlyCounts: yearly.counts } });

    const monthGrowth = calculateGrowth(monthly.totals, 'month');
    if (monthGrowth) {
      calculations.push({ label: 'Month-over-month growth', type: 'month_over_month_growth', value: monthGrowth });
    } else {
      addLimitation('month_over_month_growth', GROWTH_UNAVAILABLE_MESSAGE);
    }

    const quarterGrowth = calculateGrowth(quarterly.totals, 'quarter');
    if (quarterGrowth) {
      calculations.push({ label: 'Quarter-over-quarter growth', type: 'quarter_over_quarter_growth', value: quarterGrowth });
    } else {
      addLimitation('quarter_over_quarter_growth', GROWTH_UNAVAILABLE_MESSAGE);
    }

    const yearGrowth = calculateGrowth(yearly.totals, 'year');
    if (yearGrowth) {
      calculations.push({ label: 'Year-over-year growth', type: 'year_over_year_growth', value: yearGrowth });
    } else {
      addLimitation('year_over_year_growth', GROWTH_UNAVAILABLE_MESSAGE);
    }
  }

  if ((plan.steps || []).some((step) => step.type === 'count')) {
    countRecords();
  }
  if ((plan.steps || []).some((step) => step.type === 'aggregate')) {
    addAggregations();
  }
  if ((plan.steps || []).some((step) => step.type === 'compare')) {
    addComparison();
  }
  if ((plan.steps || []).some((step) => step.type === 'conversion_count')) {
    addConversionMetrics();
  }
  if ((plan.steps || []).some((step) => step.type === 'analytics') || plan.report) {
    addAnalyticsMetrics();
    addPeriodMetrics();
  }

  if (DEBUG_ASSISTANT) {
    logger.info('Analytics Engine', {
      metricsRequested: requestedMetrics,
      metricsCalculated: calculations.map((calculation) => calculation.type),
      metricsSkipped: limitations,
      executionTimeMs: Date.now() - startAt,
      validationFailures: limitations,
    });
  }

  return { calculations, limitations };
}

module.exports = {
  calculateResult,
};
