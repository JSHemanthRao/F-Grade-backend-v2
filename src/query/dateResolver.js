const { env } = require('../config/env');

const DATE_TYPES = new Set(['date', 'datetime']);

function isDateType(field) {
  return DATE_TYPES.has(String(field?.data_type || '').toLowerCase());
}

function timezoneOffset(dateValue, timeZone = env.crmTimezone) {
  const sample = new Date(`${dateValue}T12:00:00Z`);
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(sample)
    .find((part) => part.type === 'timeZoneName')?.value || 'GMT';
  if (name === 'GMT' || name === 'UTC') return '+00:00';
  const match = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  return match ? `${match[1]}${match[2].padStart(2, '0')}:${match[3] || '00'}` : '+00:00';
}

function datePart(value) {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})(?:T.*)?$/);
  if (!match) throw typedDateError(value, 'YYYY-MM-DD or ISO-8601 date-time');
  return match[1];
}

function formatDateBoundary(value, fieldType, timeZone = env.crmTimezone) {
  const date = datePart(value);
  if (fieldType === 'date') return date;
  if (fieldType !== 'datetime') throw typedDateError(value, 'a known Date or DateTime field type');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(String(value))) return String(value);
  return `${date}T00:00:00${timezoneOffset(date, timeZone)}`;
}

/**
 * Converts semantic date boundaries only after live field metadata identifies
 * the physical Zoho type. The returned filter is the sole API-ready date
 * representation consumed by criteria and COQL builders.
 */
function normalizeDateFilter(filter, fieldMetadata, timeZone = env.crmTimezone) {
  const fieldType = String(fieldMetadata?.data_type || '').toLowerCase();
  if (!isDateType(fieldMetadata) || !Object.prototype.hasOwnProperty.call(filter, 'value')) return filter;
  const format = (value) => formatDateBoundary(value, fieldType, timeZone);
  const value = Array.isArray(filter.value) ? filter.value.map(format) : format(filter.value);
  const range = Array.isArray(value) && value.length === 2 ? {
    semantic: filter.date_range?.semantic || filter.semantic_date || null,
    field: filter.field,
    field_type: fieldType,
    timezone: timeZone,
    start: value[0],
    end: value[1],
    end_operator: filter.exclusive_end === true ? 'less_than' : 'less_equal'
  } : undefined;
  return {
    ...filter,
    value,
    value_type: fieldType,
    ...(range ? { date_range: range } : {})
  };
}

function typedDateError(value, expected) {
  const error = new Error(`Typed CRM date value '${value}' must use ${expected}.`);
  error.code = 'INVALID_TYPED_DATE';
  return error;
}

module.exports = { formatDateBoundary, isDateType, normalizeDateFilter, timezoneOffset };
