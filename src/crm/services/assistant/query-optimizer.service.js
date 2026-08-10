const { getModuleDefinition } = require('../module-definition.service');
const UNIVERSAL_CRM_FIELDS = new Set(['id', 'Created_Time', 'Modified_Time', 'Converted_Date_Time', 'Converted__s', 'Converted_Deal']);

function addIfPresent(fields, definition, candidates) {
  candidates.forEach((candidate) => {
    const actual = definition.defaultFields.find((field) => field.toLowerCase() === candidate.toLowerCase());
    if (actual) fields.add(actual);
  });
}

function getRequiredFields(moduleKey, plan, step, question) {
  const definition = getModuleDefinition(moduleKey);
  if (!definition) return [];
  if (step.type === 'count') return [];

  const structuredPlan = step.queryPlan
    || plan.queryPlansByModule?.[moduleKey]
    || (plan.queryPlan?.moduleKey === moduleKey ? plan.queryPlan : null);
  if (step.type === 'query' && Array.isArray(structuredPlan?.fields) && structuredPlan.fields.length > 0) {
    return structuredPlan.fields.filter((field) => definition.defaultFields.includes(field) || UNIVERSAL_CRM_FIELDS.has(field));
  }

  const fields = new Set(['id']);
  const text = String(question || '').toLowerCase();
  const needsAmount = step.type === 'aggregate'
    || step.type === 'compare'
    || /revenue|amount|value|average|sum|highest|lowest|maximum|minimum|growth|decline/i.test(text);
  const needsOwner = step.type === 'analytics' || /owner|performer|ranking|top|bottom/i.test(text);
  const needsStage = /stage|closed\s+won|pipeline|win\s+rate/i.test(text);
  const needsDate = plan.timeRange.range !== 'all_time' || /month|year|date|created|closing/i.test(text);

  if (needsAmount) addIfPresent(fields, definition, ['Amount', 'Grand_Total', 'Unit_Price', 'value']);
  if (needsOwner) addIfPresent(fields, definition, ['Owner', 'Deal_Owner', 'Partner_Owner', 'Enterprise_Owner']);
  if (needsStage) addIfPresent(fields, definition, ['Stage', 'Status']);
  if (needsDate) addIfPresent(fields, definition, ['Closing_Date', 'Created_Time', 'Modified_Time', 'Created_Date', 'Start_Date', 'End_Date']);

  if (fields.size === 1 || step.type === 'query') {
    definition.defaultFields.slice(0, step.type === 'query' ? definition.defaultFields.length : 2).forEach((field) => fields.add(field));
  }

  return Array.from(fields);
}

function optimizeExecutionPlan(plan) {
  const optimizedSteps = plan.steps.map((step) => ({
    ...step,
    requiredFieldsByModule: Object.fromEntries(
      (step.modules || [step.module]).filter(Boolean)
        .map((moduleKey) => [moduleKey, getRequiredFields(moduleKey, plan, step, plan.question)]),
    ),
  }));

  return {
    ...plan,
    steps: optimizedSteps,
    optimization: {
      fieldSelection: true,
      compatibleQueriesMerged: true,
      requestCacheEnabled: true,
    },
  };
}

module.exports = {
  getRequiredFields,
  optimizeExecutionPlan,
};
