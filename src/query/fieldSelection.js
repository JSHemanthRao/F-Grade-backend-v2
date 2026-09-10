const MAX_DEFAULT_FIELDS = 12;
const MAX_EXECUTION_FIELDS = 50;

function selectMetadataDefaultFields(metadata = [], apiNames = new Set()) {
  const visible = metadata.filter((field) => field?.api_name && apiNames.has(field.api_name) && field.visible !== false && field.read_only !== true);
  const ranked = visible.map((field, index) => ({ field, score: fieldScore(field) - index / 1000 }));
  ranked.sort((left, right) => right.score - left.score);
  const selected = ranked.slice(0, MAX_DEFAULT_FIELDS).map(({ field }) => field.api_name);
  if (!selected.includes('id') && apiNames.has('id')) selected.push('id');
  return selected.slice(0, MAX_DEFAULT_FIELDS);
}

function buildExecutionFields(responseFields = [], filters = [], sort, groupBy, aggregate, havingFilter) {
  const fields = [...responseFields];
  for (const filter of filters || []) fields.push(filter.field);
  const sorts = Array.isArray(sort) ? sort : sort ? [sort] : [];
  for (const item of sorts) fields.push(item.field);
  if (groupBy) fields.push(...(Array.isArray(groupBy) ? groupBy : [groupBy]));
  if (aggregate?.field) fields.push(aggregate.field);
  if (havingFilter?.field) fields.push(havingFilter.field);
  return [...new Set(fields.filter(Boolean))];
}

function fieldScore(field) {
  const label = String(field.display_label || field.field_label || field.label || field.api_name || '').toLowerCase();
  const apiName = String(field.api_name || '').toLowerCase();
  let score = 0;
  if (field.primary_key || field.is_primary) score += 100;
  if (field.name_field || field.is_name_field) score += 90;
  if (/(name|title|subject|number|code)/.test(label) || /(name|title|subject|number|code)/.test(apiName)) score += 50;
  if (/(email|phone|status|stage|owner|created|modified|date|amount|price|total)/.test(label)) score += 20;
  if (field.visible !== false) score += 5;
  if (field.required) score += 3;
  return score;
}

function capExecutionFields(fields) {
  if (fields.length > MAX_EXECUTION_FIELDS) return fields.slice(0, MAX_EXECUTION_FIELDS);
  return fields;
}

module.exports = { selectMetadataDefaultFields, buildExecutionFields, capExecutionFields, MAX_EXECUTION_FIELDS };
