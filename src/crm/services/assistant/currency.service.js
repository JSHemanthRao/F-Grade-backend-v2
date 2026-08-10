const INR_SYMBOL = '\u20B9';

const MONETARY_FIELD_PATTERN = /(?:amount|revenue|pipeline|price|cost|budget|subtotal|grand[ _-]?total|deal[ _-]?(?:amount|value)|closed[ _-]?(?:won|lost)[ _-]?value|total[ _-]?(?:amount|value|revenue)|^total$|value$)/i;
const NON_MONETARY_FIELD_PATTERN = /(?:count|number|records?|quantity|units?|percent(?:age)?|rate|margin|score|id)$/i;

function numericValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  const source = value.trim();
  if (!source) return null;
  const directNumber = Number(source);
  if (Number.isFinite(directNumber)) return directNumber;

  // CRM connectors may return a currency label or symbol even though the
  // numeric value itself is already in the CRM's reporting currency. Strip
  // presentation-only characters; never apply an exchange-rate conversion.
  const negative = /^\s*\(.*\)\s*$/.test(source) || /^\s*-/.test(source);
  const digits = source
    .replace(/[()]/g, '')
    .replace(/(?:inr|usd|eur|gbp|rs\.?|[\u20B9$\u20AC\u00A3])/gi, '')
    .replace(/,/g, '')
    .replace(/[^\d.]/g, '');
  if (!digits || (digits.match(/\./g) || []).length > 1) return null;

  const number = Number(digits);
  if (!Number.isFinite(number)) return null;
  return negative ? -number : number;
}

function formatNumber(value) {
  const number = numericValue(value);
  if (number === null) return String(value ?? '');
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 6 }).format(number);
}

function formatCurrency(value) {
  const number = numericValue(value);
  if (number === null) return String(value ?? '');
  return number < 0
    ? `-${INR_SYMBOL}${formatNumber(Math.abs(number))}`
    : `${INR_SYMBOL}${formatNumber(number)}`;
}

function isMonetaryField(field) {
  const name = String(field || '');
  return MONETARY_FIELD_PATTERN.test(name) && !NON_MONETARY_FIELD_PATTERN.test(name);
}

module.exports = {
  INR_SYMBOL,
  numericValue,
  formatNumber,
  formatCurrency,
  isMonetaryField,
};
