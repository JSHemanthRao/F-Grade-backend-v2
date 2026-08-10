const { getModuleDefinition } = require('../module-definition.service');
const { parseQuestionFilters } = require('../filtering-engine.service');

const DISPLAY_LIMIT = 25;
const AMOUNT_FIELDS = ['Amount', 'Grand_Total', 'Annual_Revenue', 'Unit_Price', 'Revenue', 'Total_Revenue'];
const DATE_FIELDS_BY_MODULE = {
  deals: 'Closing_Date',
  events: 'Start_DateTime',
  meetings: 'Start_DateTime',
  tasks: 'Due_Date',
  campaigns: 'Start_Date',
  calls: 'Call_Start_Time',
};
const LABEL_FIELDS_BY_MODULE = {
  leads: ['First_Name', 'Last_Name', 'Company'],
  contacts: ['First_Name', 'Last_Name', 'Email'],
  accounts: ['Account_Name'],
  deals: ['Deal_Name'],
  tasks: ['Subject'],
  events: ['Subject'],
  meetings: ['Subject'],
  calls: ['Subject'],
  products: ['Product_Name'],
  vendors: ['Vendor_Name'],
  quotes: ['Subject', 'Quote_Number'],
  'sales-orders': ['Subject', 'Sales_Order_Number'],
  'purchase-orders': ['Subject', 'Purchase_Order_Number'],
  campaigns: ['Campaign_Name'],
};

function dateFieldFor(moduleKey, question) {
  const text = String(question || '').toLowerCase();
  if (/converted|conversion/.test(text)) return 'Converted_Date_Time';
  if (/modified|updated/.test(text)) return 'Modified_Time';
  if (/created|creation|added/.test(text)) return 'Created_Time';
  if (/closed|closing/.test(text) && moduleKey === 'deals') return 'Closing_Date';
  return DATE_FIELDS_BY_MODULE[moduleKey] || 'Created_Time';
}

function amountFieldFor(moduleDefinition) {
  return AMOUNT_FIELDS.find((field) => (moduleDefinition.defaultFields || [])
    .some((available) => String(available).toLowerCase() === field.toLowerCase())) || null;
}

function operationFor(intents = [], metrics = [], question = '') {
  const text = String(question || '').toLowerCase();
  if (intents.includes('COMPARE')) return 'COMPARE';
  if (metrics.includes('average')) return 'AVG';
  if (metrics.includes('maximum')) return 'MAX';
  if (metrics.includes('minimum')) return 'MIN';
  if (intents.includes('AGGREGATION') || metrics.some((metric) => ['sum', 'revenue', 'pipeline'].includes(metric))) return 'SUM';
  if (intents.includes('COUNT') || /\bhow many\b|\bnumber of\b|\bcount\b/i.test(text)) return 'COUNT';
  return intents.includes('SEARCH') ? 'SEARCH' : 'LIST';
}

function aggregationFor(operation, moduleDefinition, metrics = []) {
  if (!['SUM', 'AVG', 'MIN', 'MAX'].includes(operation)) return null;
  const metric = operation === 'AVG' ? 'average' : operation === 'MIN' ? 'minimum' : operation === 'MAX' ? 'maximum' : 'sum';
  return { function: metric, field: amountFieldFor(moduleDefinition), metrics: [metric, ...metrics.filter((item) => ['sum', 'average', 'minimum', 'maximum'].includes(item))] };
}

function fieldsFor({ moduleKey, moduleDefinition, operation, question, timeRange, entities, metrics }) {
  if (operation === 'COUNT') return ['id'];
  const fields = new Set(['id']);
  (LABEL_FIELDS_BY_MODULE[moduleKey] || moduleDefinition.defaultFields || []).forEach((field) => fields.add(field));
  const text = String(question || '').toLowerCase();
  if (moduleKey === 'deals' && ['LIST', 'SEARCH'].includes(operation)) {
    ['Deal_Name', 'Account_Name', 'Amount', 'Closing_Date', 'Stage', 'Owner'].forEach((field) => fields.add(field));
  }
  const needsAmount = ['SUM', 'AVG', 'MIN', 'MAX'].includes(operation)
    || /amount|value|revenue|pipeline|average|maximum|minimum|highest|lowest/i.test(text);
  if (needsAmount) {
    const amount = amountFieldFor(moduleDefinition);
    if (amount) fields.add(amount);
  }
  if (entities?.stages?.length || /stage|closed\s+(?:won|lost)|pipeline/i.test(text)) fields.add('Stage');
  if (entities?.owners?.length || /owner|assigned|representative|rep/i.test(text)) fields.add('Owner');
  if (entities?.companies?.length || /account|company|customer/i.test(text)) fields.add(moduleKey === 'deals' ? 'Account_Name' : 'Company');
  if (entities?.leadSources?.length || /lead\s+source|source/i.test(text)) fields.add(moduleKey === 'deals' ? 'Deal_Source' : 'Lead_Source');
  if (timeRange?.range && timeRange.range !== 'all_time') fields.add(dateFieldFor(moduleKey, question));
  if (/email/i.test(text)) fields.add('Email');
  if (/phone|mobile|telephone/i.test(text)) fields.add('Phone');
  if (metrics.includes('ranking') || metrics.includes('top_n')) fields.add('Owner');
  return [...fields].filter((field) => (moduleDefinition.defaultFields || []).includes(field) || field === 'id');
}

function normalizePeriod(period) {
  if (!period) return null;
  return {
    label: period.label,
    startDate: period.startDate,
    endDate: period.endDate,
  };
}

function buildIntentQueryPlan({ question, moduleKey, intents = [], metrics = [], timeRange = {}, entities = {}, pagination = {}, relationships = [] } = {}) {
  const moduleDefinition = getModuleDefinition(moduleKey);
  if (!moduleDefinition) throw new Error(`Unsupported CRM module: ${moduleKey}`);
  const operation = operationFor(intents, metrics, question);
  const dateRequested = Boolean(timeRange.startDate && timeRange.endDate);
  const dateField = dateRequested ? dateFieldFor(moduleKey, question) : null;
  const parsedFilters = parseQuestionFilters(question, moduleKey, timeRange);
  const fields = fieldsFor({ moduleKey, moduleDefinition, operation, question, timeRange, entities, metrics });
  const amountField = amountFieldFor(moduleDefinition);
  const periods = Array.isArray(timeRange.periods) ? timeRange.periods.map(normalizePeriod).filter(Boolean) : [];
  const displayLimit = Number.isInteger(pagination.per_page) && pagination.per_page > 0
    ? pagination.per_page
    : DISPLAY_LIMIT;

  return {
    module: moduleDefinition.label,
    moduleKey,
    operation,
    requestedFields: fields,
    fields,
    filters: parsedFilters,
    dateField,
    startDate: dateRequested ? timeRange.startDate : null,
    endDate: dateRequested ? timeRange.endDate : null,
    stage: entities.stages?.length === 1 ? entities.stages[0] : null,
    owner: entities.owners?.length === 1 ? entities.owners[0] : null,
    account: entities.companies?.length === 1 ? entities.companies[0] : null,
    leadSource: entities.leadSources?.length === 1 ? entities.leadSources[0] : null,
    amountConditions: parsedFilters.filter((filter) => filter.logicalField === 'amount'),
    requestedRecordCount: pagination.per_page || null,
    sort: pagination.sort || null,
    aggregation: aggregationFor(operation, moduleDefinition, metrics),
    grouping: relationships.includes('grouped_analysis') ? { requested: true } : null,
    comparisonPeriods: periods,
    relationshipRequirements: relationships,
    displayLimit,
    searchScope: pagination.explicit ? 'bounded_requested_page' : 'all_matching_records',
    criteria: null,
    queryValidated: false,
    ...(amountField ? { aggregateField: amountField } : {}),
  };
}

module.exports = {
  DISPLAY_LIMIT,
  buildIntentQueryPlan,
  dateFieldFor,
  operationFor,
};
