const { CRM_MODULES } = require('../constants/crmModules');

const CRM_FIELD_METADATA = Object.freeze({
  Leads: {
    First_Name: { aliases: ['first name', 'first'], data_type: 'text' },
    Last_Name: { aliases: ['last name', 'last'], data_type: 'text' },
    Company: { aliases: ['company', 'organization'], data_type: 'text' },
    Email: { aliases: ['email', 'email address'], data_type: 'email' },
    Phone: { aliases: ['phone', 'mobile'], data_type: 'phone' },
    Lead_Status: { aliases: ['lead status', 'status'], data_type: 'picklist' },
    Lead_Source: { aliases: ['lead source', 'source'], data_type: 'picklist' },
    Owner: { aliases: ['owner', 'lead owner'], data_type: 'lookup' },
    Created_Time: { aliases: ['created time', 'created date', 'created at'], data_type: 'datetime' },
    Modified_Time: { aliases: ['modified time', 'updated time'], data_type: 'datetime' },
    Converted__s: { aliases: ['converted', 'is converted'], data_type: 'boolean' },
    Converted_Date_Time: { aliases: ['conversion date', 'converted date', 'converted on'], data_type: 'datetime' }
  },
  Contacts: {
    First_Name: { aliases: ['first name', 'first'], data_type: 'text' },
    Last_Name: { aliases: ['last name', 'last'], data_type: 'text' },
    Account_Name: { aliases: ['account name', 'account'], data_type: 'lookup' },
    Email: { aliases: ['email', 'email address'], data_type: 'email' },
    Phone: { aliases: ['phone', 'mobile'], data_type: 'phone' },
    Title: { aliases: ['title', 'job title'], data_type: 'text' },
    Owner: { aliases: ['owner', 'contact owner'], data_type: 'lookup' },
    Created_Time: { aliases: ['created time', 'created date', 'created at'], data_type: 'datetime' },
    Modified_Time: { aliases: ['modified time', 'updated time'], data_type: 'datetime' }
  },
  Accounts: {
    Account_Name: { aliases: ['account name', 'company name', 'name'], data_type: 'text' },
    Industry: { aliases: ['industry', 'business sector'], data_type: 'picklist' },
    Owner: { aliases: ['owner', 'account owner'], data_type: 'lookup' },
    Created_Time: { aliases: ['created time', 'created date', 'created at'], data_type: 'datetime' },
    Modified_Time: { aliases: ['modified time', 'updated time'], data_type: 'datetime' }
  },
  Deals: {
    Deal_Name: { aliases: ['deal name', 'deal', 'name'], data_type: 'text' },
    Amount: { aliases: ['amount', 'deal amount', 'value'], data_type: 'currency' },
    Stage: { aliases: ['stage', 'deal stage'], data_type: 'picklist' },
    Closing_Date: { aliases: ['closing date', 'close date', 'expected close date'], data_type: 'date' },
    Owner: { aliases: ['owner', 'deal owner'], data_type: 'lookup' },
    Created_Time: { aliases: ['created time', 'created date', 'created at'], data_type: 'datetime' },
    Modified_Time: { aliases: ['modified time', 'updated time'], data_type: 'datetime' },
    Account_Name: { aliases: ['account name', 'account'], data_type: 'lookup' },
    Contact_Name: { aliases: ['contact name', 'contact'], data_type: 'lookup' }
  },
  Tasks: {
    Subject: { aliases: ['subject', 'task subject', 'title'], data_type: 'text' },
    Status: { aliases: ['status', 'task status'], data_type: 'picklist' },
    Due_Date: { aliases: ['due date', 'due on', 'due'], data_type: 'date' },
    Priority: { aliases: ['priority', 'task priority'], data_type: 'picklist' },
    Owner: { aliases: ['owner', 'task owner'], data_type: 'lookup' },
    Created_Time: { aliases: ['created time', 'created date', 'created at'], data_type: 'datetime' },
    Modified_Time: { aliases: ['modified time', 'updated time'], data_type: 'datetime' }
  },
  Calls: {
    Subject: { aliases: ['subject', 'call subject', 'title'], data_type: 'text' },
    Call_Start_Time: { aliases: ['call start time', 'start time', 'call time'], data_type: 'datetime' },
    Call_Duration: { aliases: ['call duration', 'duration'], data_type: 'number' },
    Description: { aliases: ['description', 'notes'], data_type: 'text' },
    Call_Status: { aliases: ['call status', 'status'], data_type: 'picklist' },
    Owner: { aliases: ['owner', 'call owner'], data_type: 'lookup' },
    Created_Time: { aliases: ['created time', 'created date', 'created at'], data_type: 'datetime' },
    Modified_Time: { aliases: ['modified time', 'updated time'], data_type: 'datetime' }
  },
  Meetings: {
    Event_Title: { aliases: ['event title', 'meeting title', 'title'], data_type: 'text' },
    Start_DateTime: { aliases: ['start date time', 'start time', 'from', 'meeting start', 'scheduled start'], data_type: 'datetime' },
    End_DateTime: { aliases: ['end date time', 'end time', 'to', 'meeting end'], data_type: 'datetime' },
    Owner: { aliases: ['owner', 'meeting owner'], data_type: 'lookup' },
    Created_Time: { aliases: ['created time', 'created date', 'created at'], data_type: 'datetime' },
    Modified_Time: { aliases: ['modified time', 'updated time'], data_type: 'datetime' }
  },
  Notes: {
    Title: { aliases: ['title', 'note title'], data_type: 'text' },
    Note_Content: { aliases: ['content', 'note content', 'body'], data_type: 'text' },
    Parent_Id: { aliases: ['parent id', 'record id'], data_type: 'lookup' },
    Created_Time: { aliases: ['created time', 'created date', 'created at'], data_type: 'datetime' },
    Modified_Time: { aliases: ['modified time', 'updated time'], data_type: 'datetime' }
  },
  Products: {
    Product_Name: { aliases: ['product name', 'name'], data_type: 'text' },
    Product_Code: { aliases: ['product code', 'code'], data_type: 'text' },
    Description: { aliases: ['description'], data_type: 'text' },
    Owner: { aliases: ['owner', 'product owner'], data_type: 'lookup' },
    Created_Time: { aliases: ['created time', 'created date', 'created at'], data_type: 'datetime' },
    Modified_Time: { aliases: ['modified time', 'updated time'], data_type: 'datetime' }
  },
  Accounts: {
    Industry: { aliases: ['industry', 'business sector'], data_type: 'picklist' },
    Account_Name: { aliases: ['account name', 'company name', 'name'], data_type: 'text' },
    Owner: { aliases: ['owner', 'account owner'], data_type: 'lookup' },
    Created_Time: { aliases: ['created time', 'created date', 'created at'], data_type: 'datetime' },
    Modified_Time: { aliases: ['modified time', 'updated time'], data_type: 'datetime' }
  }
});

const FIELD_ALIAS_LOOKUP = createFieldAliasLookup();

function createFieldAliasLookup() {
  const lookup = new Map();
  for (const [moduleName, fieldMap] of Object.entries(CRM_FIELD_METADATA)) {
    for (const [fieldName, metadata] of Object.entries(fieldMap)) {
      const aliases = new Set([fieldName, ...(metadata.aliases || [])]);
      for (const alias of aliases) {
        if (!alias) continue;
        lookup.set(normalizeFieldKey(alias, moduleName), { module: moduleName, field: fieldName, api_name: fieldName });
      }
    }
  }
  return lookup;
}

function normalizeFieldKey(value, moduleName = null) {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}

function moduleFieldMap(module) {
  const moduleName = resolveModuleName(module);
  if (!moduleName) return {};
  const staticFields = CRM_FIELD_METADATA[moduleName] || {};
  const fallback = CRM_MODULES[moduleName] || [];
  const merged = { ...fallback.reduce((acc, field) => ({ ...acc, [field]: { aliases: [field] } }), {}) };
  Object.entries(staticFields).forEach(([field, metadata]) => {
    merged[field] = { ...(merged[field] || {}), ...(metadata || {}) };
  });
  return merged;
}

function resolveModuleName(module) {
  if (!module || typeof module !== 'string') return null;
  const direct = CRM_MODULES[module] ? module : null;
  if (direct) return direct;
  const match = Object.keys(CRM_MODULES).find((name) => name.toLowerCase() === module.trim().toLowerCase());
  return match || null;
}

function resolveCrmField(module, inputField) {
  if (typeof inputField !== 'string' || !inputField.trim()) return inputField;
  const trimmed = inputField.trim();
  const moduleName = resolveModuleName(module) || 'Deals';
  const moduleMap = moduleFieldMap(moduleName);
  if (moduleMap[trimmed]) return trimmed;
  const exactApi = Object.keys(moduleMap).find((field) => field.toLowerCase() === trimmed.toLowerCase());
  if (exactApi) return exactApi;
  const aliasKey = normalizeFieldKey(trimmed, moduleName);
  const directMatch = FIELD_ALIAS_LOOKUP.get(aliasKey);
  if (directMatch && (!module || directMatch.module === moduleName)) return directMatch.field;
  const moduleSpecific = Object.entries(moduleMap).find(([fieldName, metadata]) => {
    const aliases = [fieldName, ...(metadata.aliases || [])];
    return aliases.some((alias) => normalizeFieldKey(alias, moduleName) === aliasKey);
  });
  if (moduleSpecific) return moduleSpecific[0];
  return trimmed;
}

function normalizeCrmOperator(rawOperator) {
  if (typeof rawOperator !== 'string') return 'equals';
  const normalized = rawOperator.trim().toLowerCase();
  const aliases = {
    eq: 'equals', '==': 'equals', '=': 'equals', equals: 'equals',
    neq: 'not_equals', '!=': 'not_equals', 'not equal': 'not_equals',
    contains: 'contains', 'starts with': 'starts_with', startswith: 'starts_with',
    gt: 'greater_than', '>': 'greater_than', greater: 'greater_than',
    gte: 'greater_equal', '>=': 'greater_equal', 'greater or equal': 'greater_equal',
    lt: 'less_than', '<': 'less_than', less: 'less_than',
    lte: 'less_equal', '<=': 'less_equal', 'less or equal': 'less_equal',
    in: 'in', 'not in': 'not_in', notin: 'not_in',
    between: 'between',
    isnull: 'is_null', 'is null': 'is_null',
    isnotnull: 'is_not_null', 'is not null': 'is_not_null',
    isempty: 'is_empty', 'is empty': 'is_empty',
    isnotempty: 'is_not_empty', 'is not empty': 'is_not_empty'
  };
  return aliases[normalized] || normalized;
}

function inferOperatorFromValue(value, knownOperator) {
  if (knownOperator && typeof knownOperator === 'string' && knownOperator.trim()) return normalizeCrmOperator(knownOperator);
  if (value === null || value === undefined) return 'is_null';
  if (Array.isArray(value)) {
    if (value.length === 2) return 'between';
    return 'in';
  }
  if (typeof value === 'string' && value.trim() === '') return 'is_null';
  return 'equals';
}

function normalizeCrmFilterEntry(module, rawEntry, fallbackField = null) {
  if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
    if (fallbackField && rawEntry !== undefined) {
      return { field: resolveCrmField(module, fallbackField), operator: inferOperatorFromValue(rawEntry, null), value: rawEntry };
    }
    return null;
  }

  const explicitField = typeof rawEntry.field === 'string' ? rawEntry.field : fallbackField;
  const field = explicitField ? resolveCrmField(module, explicitField) : null;
  if (!field) return null;

  const value = Object.prototype.hasOwnProperty.call(rawEntry, 'value') ? rawEntry.value : undefined;
  let operator = normalizeCrmOperator(rawEntry.operator || '');
  if (!operator || operator === 'null') {
    operator = inferOperatorFromValue(value, rawEntry.operator);
  }

  if (operator === 'not_in' && value !== undefined && !Array.isArray(value)) {
    return { field, operator, value: [value] };
  }

  if (operator === 'between' && value !== undefined) {
    const values = Array.isArray(value) ? value : String(value).split(',').map((part) => part.trim()).filter((part) => part !== '');
    if (values.length === 2) return { field, operator, value: values };
  }

  if (operator === 'in' && value !== undefined && !Array.isArray(value)) {
    return { field, operator, value: [value] };
  }

  if (value === undefined && ['equals', 'not_equals', 'greater_than', 'less_than', 'greater_equal', 'less_equal', 'contains', 'starts_with', 'in', 'not_in', 'between'].includes(operator)) {
    return null;
  }

  return { field, operator, ...(value === undefined ? {} : { value }) };
}

function normalizeCrmFilters(module, filters) {
  if (filters === undefined || filters === null) return [];
  if (Array.isArray(filters)) {
    return filters.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const fieldKey = Object.keys(entry).find((key) => key !== 'operator' && key !== 'value' && key !== 'field' && key !== 'value_type' && key !== 'date_range');
      const normalized = fieldKey ? normalizeCrmFilterEntry(module, { ...(entry || {}), field: entry.field || fieldKey }, fieldKey) : normalizeCrmFilterEntry(module, entry, null);
      return normalized ? [normalized] : [];
    });
  }

  if (typeof filters !== 'object') return [];

  return Object.entries(filters).flatMap(([fieldKey, definition]) => {
    if (definition === undefined || definition === null) return [];
    if (Array.isArray(definition) || typeof definition === 'string' || typeof definition === 'number' || typeof definition === 'boolean') {
      return [normalizeCrmFilterEntry(module, { field: fieldKey, operator: inferOperatorFromValue(definition, null), value: definition }, fieldKey)].filter(Boolean);
    }
    if (typeof definition === 'object') {
      const field = definition.field || fieldKey;
      const rawEntry = { ...definition, field };
      if (Object.prototype.hasOwnProperty.call(rawEntry, 'operator') && (!rawEntry.operator || rawEntry.operator === '')) {
        rawEntry.operator = inferOperatorFromValue(rawEntry.value, null);
      }
      return [normalizeCrmFilterEntry(module, rawEntry, fieldKey)].filter(Boolean);
    }
    return [];
  });
}

module.exports = {
  CRM_FIELD_METADATA,
  normalizeCrmFilters,
  normalizeCrmOperator,
  resolveCrmField,
  resolveModuleName,
  normalizeFieldKey
};
