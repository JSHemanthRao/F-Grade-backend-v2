const { getModuleDefinition } = require('../module-definition.service');
const { parseQuestionFilters } = require('../filtering-engine.service');
const {
  getCustomerRecordScope,
  isExplicitCreationRequest,
  selectBusinessDateField,
} = require('../business-criteria.service');

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
const UNIVERSAL_CRM_FIELDS = new Set(['id', 'Created_Time', 'Modified_Time', 'Converted_Date_Time', 'Converted__s', 'Converted_Deal']);

function dateFieldFor(moduleKey, question, businessRequest = {}) {
  if (businessRequest.dateMeaning === 'actual_closed_won_date' || businessRequest.dateMeaning === 'ambiguous') return null;
  if (businessRequest.dateMeaning === 'closing_date' || businessRequest.dateMeaning === 'expected_closing_date') return 'Closing_Date';
  return selectBusinessDateField(moduleKey, question);
}

function amountFieldFor(moduleDefinition) {
  return AMOUNT_FIELDS.find((field) => (moduleDefinition.defaultFields || [])
    .some((available) => String(available).toLowerCase() === field.toLowerCase())) || null;
}

function operationFor(intents = [], metrics = [], question = '') {
  const text = String(question || '').toLowerCase();
  if (intents.includes('COMPARE')) return 'COMPARE';
  if (intents.includes('CONVERSION')) return 'COUNT';
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

function sortFor(question, moduleKey) {
  const text = String(question || '').toLowerCase();
  const explicit = text.match(/\bsort(?:ed)?\s+by\s+([a-z_ ]+?)(?:\s+(ascending|descending|asc|desc))?(?:\s|$)/i);
  const direction = /\b(descending|desc|highest|largest|top|newest|latest)\b/i.test(text) ? 'desc' : 'asc';
  const rawField = explicit?.[1]?.trim();
  const field = rawField
    ? (/amount|value|revenue|price/i.test(rawField) ? 'Amount'
      : /date|created|closing/i.test(rawField) ? dateFieldFor(moduleKey, text)
        : /name|deal/i.test(rawField) ? (moduleKey === 'deals' ? 'Deal_Name' : 'Name')
          : rawField)
    : /\b(top|bottom|highest|largest|newest|latest)\b/i.test(text)
      ? (/amount|value|revenue|deal/i.test(text) ? 'Amount' : dateFieldFor(moduleKey, text))
      : null;
  if (!field) return null;
  return { field, direction: explicit?.[2] ? (/desc/i.test(explicit[2]) ? 'desc' : 'asc') : direction };
}

function fieldsFor({ moduleKey, moduleDefinition, operation, question, timeRange, entities, metrics, businessRequest }) {
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
  const dateField = dateFieldFor(moduleKey, question, businessRequest);
  if (timeRange?.range && timeRange.range !== 'all_time' && dateField) fields.add(dateField);
  if (timeRange?.range && timeRange.range !== 'all_time' && !isExplicitCreationRequest(question)) fields.add('Created_Time');
  if (/email/i.test(text)) fields.add('Email');
  if (/phone|mobile|telephone/i.test(text)) fields.add('Phone');
  if (metrics.includes('ranking') || metrics.includes('top_n')) fields.add('Owner');
  return [...fields].filter((field) => (moduleDefinition.defaultFields || []).includes(field) || UNIVERSAL_CRM_FIELDS.has(field));
}

function normalizePeriod(period) {
  if (!period) return null;
  return {
    label: period.label,
    startDate: period.startDate,
    endDate: period.endDate,
  };
}

function buildIntentQueryPlan({ question, moduleKey, intents = [], metrics = [], timeRange = {}, entities = {}, pagination = {}, relationships = [], businessRequest = {} } = {}) {
  const moduleDefinition = getModuleDefinition(moduleKey);
  if (!moduleDefinition) throw new Error(`Unsupported CRM module: ${moduleKey}`);
  const operation = operationFor(intents, metrics, question);
  const dateRequested = Boolean(timeRange.startDate && timeRange.endDate);
  const dateField = dateRequested ? dateFieldFor(moduleKey, question, businessRequest) : null;
  const parsedFilters = parseQuestionFilters(question, moduleKey, timeRange);
  const fields = fieldsFor({ moduleKey, moduleDefinition, operation, question, timeRange, entities, metrics, businessRequest });
  const amountField = amountFieldFor(moduleDefinition);
  const customerScope = getCustomerRecordScope(question);
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
    sort: pagination.sort || sortFor(question, moduleKey),
    aggregation: aggregationFor(operation, moduleDefinition, metrics),
    grouping: relationships.includes('grouped_analysis') ? { requested: true } : null,
    comparisonPeriods: periods,
    relationshipRequirements: relationships,
    relationship: relationships.includes('contact_to_deal')
      ? { type: 'contact_to_deal', sourceModule: 'contacts', targetModule: 'deals', sourceKey: 'id', targetReferenceFields: ['Contact_Name', 'Contact', 'Contact_ID'] }
      : null,
    displayLimit,
    searchScope: pagination.explicit ? 'bounded_requested_page' : 'all_matching_records',
    customerScope,
    criteria: null,
    queryValidated: false,
    dateMeaning: businessRequest.dateMeaning || null,
    requiresStageHistory: Boolean(businessRequest.requires_stage_history),
    ...(amountField ? { aggregateField: amountField } : {}),
  };
}

module.exports = {
  DISPLAY_LIMIT,
  buildIntentQueryPlan,
  dateFieldFor,
  operationFor,
};
