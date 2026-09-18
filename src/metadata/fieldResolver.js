const { createAppError } = require('../utils/errors');
const { resolveRequestedFields } = require('../relationships/relationshipResolver');
const { selectMetadataDefaultFields, buildExecutionFields, capExecutionFields } = require('../query/fieldSelection');
const { isDateType, normalizeDateFilter } = require('../query/dateResolver');

/**
 * Converts semantic field terms in a canonical plan into verified Zoho API
 * fields. Live field metadata is the authority; aliases only help match a
 * user-facing term to a metadata field.
 */
async function materializeMetadataRequest(zohoService, input) {
  if (input.module === 'CRM' || typeof zohoService.getFieldMetadata !== 'function') return input;
  const moduleApiName = input.module_api_name || input.module;
  const metadata = await zohoService.getFieldMetadata(moduleApiName);
  const fields = Array.isArray(metadata?.metadata) ? metadata.metadata : [];
  const apiNames = new Set((metadata?.fields || []).filter(Boolean));
  if (apiNames.size === 0) {
    throw createAppError('ZOHO_METADATA_EMPTY', `Zoho field metadata for '${moduleApiName}' was unavailable.`, 502, { module_api_name: moduleApiName });
  }

  const aliases = new Map();
  const metadataByApiName = new Map();
  const resolvedFieldDiagnostics = [];
  for (const field of fields) {
    if (field.api_name) metadataByApiName.set(field.api_name, field);
    for (const value of [field.api_name, field.display_label, field.field_label, field.label]) {
      if (value) aliases.set(normalizeMetadataLabel(value), field.api_name);
    }
  }

  const semanticLabels = collectSemanticLabels(input);
  const relationshipPlan = semanticLabels.length > 0
    ? await resolveRequestedFields({
      module: input.module,
      fieldLabels: semanticLabels,
      metadata: fields,
      getFieldMetadata: (targetModule) => zohoService.getFieldMetadata(targetModule)
    })
    : { fields: [], relationships: [], resolved: [] };
  const resolvedByLabel = new Map((relationshipPlan.resolved || []).map((entry) => [normalizeMetadataLabel(entry.label), entry]));
  const relationshipMetadataByPath = new Map((relationshipPlan.resolved || [])
    .filter((entry) => entry.field && entry.field_metadata)
    .map((entry) => [entry.field, entry.field_metadata]));

  const resolveField = (field, role, label, dateRole) => {
    if (!field) return field;
    const relationshipMatch = label ? resolvedByLabel.get(normalizeMetadataLabel(label)) : null;
    if (relationshipMatch) {
      recordResolvedField(resolvedFieldDiagnostics, relationshipMatch.field_metadata, label, relationshipMatch.field);
      return relationshipMatch.field;
    }
    if (isForbiddenInternalFieldName(field)) {
      throw createAppError(
        'FIELD_NOT_AVAILABLE',
        `CRM field '${field}' is not a valid Zoho API field name for module '${input.module}'.`,
        400,
        { module: input.module, module_api_name: moduleApiName, field, reason: 'Internal metadata field name or placeholder was provided.' }
      );
    }
    let apiName = apiNames.has(field) ? field : null;
    const alias = aliases.get(normalizeMetadataLabel(field));
    if (!apiName && alias) apiName = alias;
    const semantic = !apiName ? findMetadataField(fields, aliases, label || field, role) : null;
    if (!apiName && semantic) apiName = semantic;
    if (role === 'date' && fields.length > 0 && (field === '__date__' || field === 'date' || dateRole || input.date_field_role)) {
      apiName = apiName || chooseMetadataDateField(fields, dateRole || input.date_field_role);
    }
    if (apiName) {
      const metadataField = metadataByApiName.get(apiName) || { api_name: apiName, data_type: null };
      recordResolvedField(resolvedFieldDiagnostics, metadataField, label || field, field);
      return metadataField.api_name;
    }
    throw createAppError(
      'FIELD_NOT_AVAILABLE',
      `CRM field '${field}' could not be resolved to a live Zoho API field for module '${input.module}'.`,
      400,
      {
        module: input.module,
        module_api_name: moduleApiName,
        field,
        user_term: label || field,
        candidate_fields: fields.filter((candidate) => candidate?.api_name).map((candidate) => ({ api_name: candidate.api_name, field_label: candidate.display_label || candidate.field_label || candidate.label || candidate.api_name })).slice(0, 50),
        reason: 'No match in live Zoho field metadata.'
      }
    );
  };

  const plannerDefaults = input.fields_source === 'planner_default' || !Array.isArray(input.fields) || input.fields.length === 0;
  const resolvedFields = input.request_type === 'search'
    ? selectMetadataSearchFields(fields, apiNames)
    : plannerDefaults
      ? selectMetadataDefaultFields(fields, apiNames)
      : input.field_labels?.length ? relationshipPlan.fields : input.fields.map((field) => resolveField(field));
  const resolvedFilters = (input.filters || []).map((filter) => {
    const field = resolveField(filter.field, filter.field === 'Created_Time' || filter.field === '__date__' ? 'date' : filter.field_role || semanticRoleForField(filter.field, filter.field_label), filter.field_label, filter.field_role);
    const metadataField = metadataByApiName.get(field) || relationshipMetadataByPath.get(field);
    const resolved = { ...filter, field };
    if (isLookupField(metadataField)) {
      resolved.value_type = 'lookup';
      const targetModule = lookupTargetModule(metadataField);
      if (targetModule) resolved.lookup_target_module = targetModule;
    }
    if (filter.semantic_value === 'closed') {
      const values = closedPicklistValues(metadataField);
      if (values.length === 0) {
        throw createAppError('AMBIGUOUS_SEMANTIC_FILTER', `CRM field '${field}' has no metadata-defined closed values.`, 400, { module: input.module, module_api_name: moduleApiName, field });
      }
      resolved.value = values;
      delete resolved.semantic_value;
    }
    return resolved;
  });
  const resolveExpression = (expression) => {
    if (!expression) return expression;
    if (expression.field) return {
      ...expression,
      field: resolveField(expression.field, expression.field_role || semanticRoleForField(expression.field, expression.field_label), expression.field_label)
    };
    return { ...expression, conditions: (expression.conditions || []).map(resolveExpression) };
  };
  const resolvedFilterExpression = resolveExpression(input.filter_expression);
  const rawSort = input.sort || (input.sort_field ? { field: input.sort_field, order: input.sort_order } : undefined);
  const resolvedSort = Array.isArray(rawSort)
    ? rawSort.map((sort) => ({ ...sort, field: resolveField(sort.field, sort.field === 'Created_Time' ? 'date' : sort.field_role || semanticRoleForField(sort.field, sort.field_label), sort.field_label, input.date_field_role) }))
    : rawSort;
  if (resolvedSort && !Array.isArray(resolvedSort)) {
    resolvedSort.field = resolveField(resolvedSort.field, resolvedSort.field === 'Created_Time' ? 'date' : resolvedSort.field_role || semanticRoleForField(resolvedSort.field, resolvedSort.field_label), resolvedSort.field_label, input.date_field_role);
  }
  const aggregate = input.aggregate ? { ...input.aggregate, field: resolveField(input.aggregate.field, input.aggregate.operation === 'count' ? undefined : 'numeric', input.aggregate.field_label) } : input.aggregate;
  const groupBy = input.group_by ? resolveField(input.group_by, undefined, input.group_by_label) : input.group_by;
  const havingFilter = input.having_filter ? {
    ...input.having_filter,
    field: resolveField(input.having_filter.field, input.having_filter.field_role || semanticRoleForField(input.having_filter.field, input.having_filter.field_label), input.having_filter.field_label)
  } : input.having_filter;
  const responseFields = resolvedFields.length > 0 ? resolvedFields : selectMetadataDefaultFields(fields, apiNames);
  const diagnosticFields = [
    ...(responseFields.includes('id') ? ['id'] : []),
    ...responseFields.filter((field) => field !== 'id'),
    ...resolvedFilters.map((filter) => filter.field),
    ...(Array.isArray(resolvedSort) ? resolvedSort.map((sort) => sort.field) : [resolvedSort?.field]),
    aggregate?.field,
    groupBy,
    havingFilter?.field
  ].filter(Boolean);
  const existingDiagnostics = new Map(resolvedFieldDiagnostics.map((entry) => [entry.api_name, entry]));
  resolvedFieldDiagnostics.length = 0;
  for (const apiName of [...new Set(diagnosticFields)]) {
    if (existingDiagnostics.has(apiName)) {
      resolvedFieldDiagnostics.push(existingDiagnostics.get(apiName));
      continue;
    }
    const metadataField = metadataByApiName.get(apiName) || relationshipMetadataByPath.get(apiName) || { api_name: apiName, data_type: null };
    recordResolvedField(resolvedFieldDiagnostics, metadataField, apiName, apiName);
  }
  const usedFields = [
    ...resolvedFields,
    ...resolvedFilters.map((filter) => filter.field),
    ...collectExpressionFields(resolvedFilterExpression),
    ...(Array.isArray(resolvedSort) ? resolvedSort.map((sort) => sort.field) : [resolvedSort?.field]),
    aggregate?.field,
    groupBy,
    havingFilter?.field
  ].filter(Boolean);
  const executionFields = capExecutionFields(buildExecutionFields(responseFields, resolvedFilters, resolvedSort, groupBy, aggregate, havingFilter));
  const metadataByResolvedName = new Map([...metadataByApiName, ...relationshipMetadataByPath]);
  for (const filter of resolvedFilters) {
    const metadataField = metadataByResolvedName.get(filter.field);
    if (isUnaryFilterOperator(filter.operator)) delete filter.value;
    else {
      filter.value = normalizeTypedFilterValue(input, filter, metadataField);
      Object.assign(filter, normalizeDateFilter(filter, metadataField));
    }
    validateFilterTypeCompatibility(input, filter, metadataField);
    if (metadataField?.filterable === false || metadataField?.searchable === false && ['contains', 'starts_with'].includes(filter.operator)) {
      throw createAppError('INVALID_QUERY', `CRM field '${filter.field}' cannot be used for this filter.`, 400, { module: input.module, module_api_name: moduleApiName, field: filter.field, operator: filter.operator, reason: 'Field metadata does not permit this filter.' });
    }
  }
  validateFieldCapabilities({ input, moduleApiName, metadataByResolvedName, resolvedSort, groupBy, aggregate });
  const missingField = usedFields.find((field) => !apiNames.has(field) && !String(field).includes('.'));
  if (fields.length > 0 && missingField) {
    if (!input._metadata_refreshed && typeof zohoService.getFieldMetadata === 'function') {
      await zohoService.getFieldMetadata(moduleApiName, { forceRefresh: true });
      return materializeMetadataRequest(zohoService, { ...input, _metadata_refreshed: true });
    }
    throw createAppError('FIELD_NOT_AVAILABLE', `CRM field '${missingField}' is not available on module '${input.module}'.`, 400, { module: input.module, module_api_name: moduleApiName, field: missingField });
  }

  let resolvedComparison = input.comparison && fields.length > 0 && resolvedFilters.length === 0 && input.date_field_role
    ? { ...input.comparison, date_field: chooseMetadataDateField(fields, input.date_field_role) }
    : input.comparison;
  if (resolvedComparison?.date_field) {
    const comparisonDateMetadata = metadataByResolvedName.get(resolvedComparison.date_field);
    if (isDateType(comparisonDateMetadata)) {
      resolvedComparison = {
        ...resolvedComparison,
        date_field_type: String(comparisonDateMetadata.data_type || '').toLowerCase()
      };
    }
  }
  return {
    ...input,
    fields: executionFields,
    requested_fields: input.field_labels || input.fields || [],
    execution_fields: executionFields,
    response_fields: responseFields,
    filters: resolvedFilters,
    filter_expression: resolvedFilterExpression,
    sort: resolvedSort,
    aggregate,
    group_by: groupBy,
    having_filter: havingFilter,
    comparison: resolvedComparison,
    relationships: [...(input.relationships || []), ...(relationshipPlan.relationships || [])],
    date_range: resolvedFilters.find((filter) => filter.date_range)?.date_range || input.date_range,
    sort_field: undefined,
    sort_order: undefined,
    _resolved_field_diagnostics: resolvedFieldDiagnostics,
    _available_metadata_fields: [...apiNames]
  };
}

function collectSemanticLabels(input) {
  const values = [
    ...(Array.isArray(input.field_labels) ? input.field_labels : []),
    ...(input.filters || []).map((filter) => filter?.field_label),
    ...normaliseSort(input.sort).map((sort) => sort?.field_label),
    input.aggregate?.field_label,
    input.group_by_label,
    input.having_filter?.field_label
  ].filter((value) => typeof value === 'string' && value.trim());
  return [...new Map(values.map((value) => [normalizeMetadataLabel(value), value.trim()])).values()];
}

function normaliseSort(sort) {
  return Array.isArray(sort) ? sort : sort ? [sort] : [];
}

function recordResolvedField(diagnostics, field, userTerm, fallbackApiName) {
  if (!field) return;
  const apiName = field.api_name || fallbackApiName;
  if (diagnostics.some((entry) => entry.api_name === apiName)) return;
  diagnostics.push({
    user_term: userTerm,
    field_label: field.display_label || field.field_label || field.label || userTerm || apiName,
    api_name: apiName,
    data_type: field.data_type || null,
    ...metadataCapabilityDetails(field)
  });
}

function validateFieldCapabilities({ input, moduleApiName, metadataByResolvedName, resolvedSort, groupBy, aggregate }) {
  if (resolvedSort) {
    for (const sort of normaliseSort(resolvedSort)) {
      const metadataField = metadataByResolvedName.get(sort.field);
      if (metadataField?.sortable === false) throw createAppError('INVALID_QUERY', `CRM field '${sort.field}' cannot be sorted.`, 400, { module: input.module, module_api_name: moduleApiName, field: sort.field, reason: 'Field metadata marks the field as non-sortable.' });
    }
  }
  if (groupBy) {
    const metadataField = metadataByResolvedName.get(groupBy);
    if (metadataField?.groupable === false) throw createAppError('INVALID_QUERY', `CRM field '${groupBy}' cannot be grouped.`, 400, { module: input.module, module_api_name: moduleApiName, field: groupBy, reason: 'Field metadata marks the field as non-groupable.' });
  }
  if (aggregate && aggregate.operation !== 'count') {
    const metadataField = metadataByResolvedName.get(aggregate.field);
    if (metadataField?.aggregatable === false) throw createAppError('FIELD_OPERATION_NOT_SUPPORTED', `CRM field '${aggregate.field}' cannot be aggregated.`, 400, { module: input.module, module_api_name: moduleApiName, field: aggregate.field, operation: aggregate.operation });
  }
}

function metadataCapabilityDetails(field) {
  const details = {};
  for (const capability of ['filterable', 'sortable', 'groupable', 'aggregatable']) {
    if (Object.prototype.hasOwnProperty.call(field || {}, capability)) details[capability] = field[capability] === true;
  }
  return details;
}

function normalizeTypedFilterValue(input, filter, metadataField) {
  if (!metadataField || !Object.prototype.hasOwnProperty.call(filter, 'value')) return filter.value;
  const type = String(metadataField.data_type || '').toLowerCase();
  const numeric = ['currency', 'double', 'decimal', 'integer', 'long', 'number', 'bigint'].includes(type);
  const boolean = ['boolean', 'checkbox'].includes(type);
  const normalizeNumber = (value) => {
    if (typeof value === 'number') return value;
    const text = String(value).trim().toLowerCase().replace(/[,$\u20b9\s]/g, '');
    const match = text.match(/^(-?\d+(?:\.\d+)?)(k|m|lakh|lakhs|crore|crores)?$/);
    if (!match) throw createAppError('INVALID_FILTER_VALUE', `Value '${value}' is not valid for numeric field '${filter.field}'.`, 400, { module: input.module, field: filter.field, data_type: metadataField.data_type, value });
    const multiplier = { k: 1000, m: 1000000, lakh: 100000, lakhs: 100000, crore: 10000000, crores: 10000000 }[match[2]] || 1;
    return Number(match[1]) * multiplier;
  };
  const normalizeBoolean = (value) => {
    if (typeof value === 'boolean') return value;
    if (/^(true|yes)$/i.test(String(value).trim())) return true;
    if (/^(false|no)$/i.test(String(value).trim())) return false;
    throw createAppError('INVALID_FILTER_VALUE', `Value '${value}' is not valid for boolean field '${filter.field}'.`, 400, { module: input.module, field: filter.field, data_type: metadataField.data_type, value });
  };
  const normalize = (value) => numeric ? normalizeNumber(value) : boolean ? normalizeBoolean(value) : value;
  return Array.isArray(filter.value) ? filter.value.map(normalize) : normalize(filter.value);
}

function isUnaryFilterOperator(operator) {
  return ['is_null', 'is_not_null', 'is_empty', 'is_not_empty'].includes(operator);
}

function validateFilterTypeCompatibility(input, filter, metadataField) {
  if (!metadataField?.data_type) return;
  const type = String(metadataField.data_type).toLowerCase();
  const numeric = ['currency', 'double', 'decimal', 'integer', 'long', 'number', 'bigint'].includes(type);
  const date = ['date', 'datetime'].includes(type);
  const text = ['text', 'string', 'email', 'phone', 'picklist', 'multiselectpicklist'].includes(type);
  const numericOperators = ['greater_than', 'less_than', 'greater_equal', 'less_equal'];
  const stringOperators = ['contains', 'starts_with'];
  const invalid = numericOperators.includes(filter.operator) && !numeric
    || filter.operator === 'between' && !numeric && !date
    || stringOperators.includes(filter.operator) && !text;
  if (invalid) throw createAppError('FIELD_OPERATION_NOT_SUPPORTED', `CRM field '${filter.field}' does not support operator '${filter.operator}'.`, 400, { module: input.module, module_api_name: input.module_api_name, field: filter.field, data_type: metadataField.data_type, operator: filter.operator });
}

function isLookupField(field) {
  return ['lookup', 'ownerlookup', 'userlookup'].includes(String(field?.data_type || '').toLowerCase());
}

function lookupTargetModule(field) {
  const lookup = field?.lookup?.module || field?.lookup_module || field?.associated_module || field?.module;
  if (typeof lookup === 'string') return lookup;
  if (lookup && typeof lookup === 'object') return lookup.api_name || lookup.module_name || lookup.name || null;
  return /(?:owner|user)/i.test(String(field?.data_type || '')) || /owner/i.test(String(field?.api_name || '')) ? 'users' : null;
}

function closedPicklistValues(field) {
  const values = field?.pick_list_values || field?.picklist_values || field?.values || [];
  return values
    .filter((value) => value && value.actual_value !== undefined && /\bclosed\b/i.test(String(value.display_value || value.actual_value)))
    .map((value) => value.actual_value);
}

function collectExpressionFields(expression) {
  if (!expression) return [];
  if (expression.field) return [expression.field];
  return (expression.conditions || []).flatMap(collectExpressionFields);
}

function selectMetadataSearchFields(metadata, apiNames) {
  const searchable = metadata
    .filter((field) => field && field.api_name && field.visible !== false && field.searchable !== false)
    .filter((field) => ['text', 'string', 'email', 'phone', 'picklist'].includes(String(field.data_type || '').toLowerCase()))
    .map((field) => field.api_name);
  return [...new Set(['id', ...searchable])].slice(0, 50).length > 1
    ? [...new Set(['id', ...searchable])].slice(0, 50)
    : [...new Set(['id', ...apiNames])].slice(0, 20);
}

function findMetadataField(metadata, aliases, requested, role) {
  const normalized = normalizeMetadataLabel(requested);
  if (!normalized) return null;
  const exact = aliases.get(normalized);
  if (exact) return exact;
  const candidates = metadata.filter((field) => field?.api_name && field.visible !== false && field.virtual_field !== true);
  const scored = candidates.map((field) => {
    const text = normalizeMetadataLabel([field.api_name, field.display_label, field.field_label, field.label].filter(Boolean).join(' '));
    const type = String(field.data_type || '').toLowerCase();
    let score = 0;
    if (text.includes(normalized) || normalized.includes(text)) score += 20;
    if (role === 'owner' && (text.includes('owner') || field.data_type === 'lookup' && text.includes('user'))) score += 100;
    if (role === 'numeric' && ['currency', 'double', 'decimal', 'integer', 'long', 'number'].includes(type)) score += 60;
    if (role === 'stage' && (text.includes('stage') || text.includes('status')) && (type === 'picklist' || type === 'text')) score += 90;
    if (role === 'source' && text.includes('source')) score += 90;
    if (role === 'modified' && /(modified|updated)/.test(text) && ['date', 'datetime'].includes(type)) score += 100;
    return { apiName: field.api_name, score };
  }).sort((left, right) => right.score - left.score);
  return scored[0]?.score > 0 ? scored[0].apiName : null;
}

function chooseMetadataDateField(metadata, role) {
  const fields = metadata.filter((field) => field && field.api_name && ['date', 'datetime'].includes(String(field.data_type || '').toLowerCase()));
  const normalizedRole = String(role || 'created').toLowerCase();
  const ranked = fields.map((field) => {
    const label = normalizeMetadataLabel([field.api_name, field.display_label, field.field_label, field.label].filter(Boolean).join(' '));
    let score = 0;
    if (normalizedRole === 'due' && /(due|deadline)/.test(label)) score += 100;
    if (normalizedRole === 'activity' && /(start|scheduled|call|meeting|event)/.test(label)) score += 100;
    if (normalizedRole === 'created' && /(created|creation)/.test(label)) score += 100;
    if (normalizedRole === 'closing' && /(closing|close|due|valid)/.test(label)) score += 100;
    if (normalizedRole === 'modified' && /(modified|updated)/.test(label)) score += 100;
    if (field.api_name === 'Created_Time') score += normalizedRole === 'created' ? 50 : 0;
    return { apiName: field.api_name, score };
  }).sort((left, right) => right.score - left.score);
  return ranked[0]?.apiName || null;
}

function normalizeMetadataLabel(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function semanticRoleForField(field, label) {
  const value = normalizeMetadataLabel(label || field);
  if (/(owner|assignee|assigneduser)/.test(value)) return 'owner';
  if (/(amount|value|revenue|price|cost|quantity|total)/.test(value)) return 'numeric';
  if (/(stage|status)/.test(value)) return 'stage';
  if (/source/.test(value)) return 'source';
  if (/(modified|updated)/.test(value)) return 'modified';
  return undefined;
}

function isForbiddenInternalFieldName(value) {
  if (value == null) return false;
  const normalized = String(value).trim();
  if (!normalized) return false;
  const forbidden = new Set(['semantic', '__semantic__', 'label', 'display_name', 'display_label', 'field_label', 'description', 'field_description', 'type', 'metadata']);
  return forbidden.has(normalized.toLowerCase()) || /^semantic$/i.test(normalized) || /^__semantic__$/i.test(normalized);
}

module.exports = {
  materializeMetadataRequest,
  collectExpressionFields,
  isForbiddenInternalFieldName,
  normalizeTypedFilterValue,
  validateFilterTypeCompatibility
};
