function sanitizeZohoValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeZohoValue);
  if (value && typeof value === 'object') {
    if ('name' in value || 'value' in value) return value.name || value.value || value.id || null;
    return sanitizeZohoRecord(value);
  }
  return value;
}

function sanitizeZohoRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return {};
  return Object.fromEntries(Object.entries(record)
    .filter(([key]) => !key.startsWith('$') && !key.startsWith('@') && !key.startsWith('internal_') && !key.endsWith('_review_process'))
    .map(([key, value]) => [key === 'ID' ? 'id' : key, key === 'id' || key === 'ID' ? (value == null ? null : String(value)) : sanitizeZohoValue(value)]));
}

module.exports = { sanitizeZohoRecord };
