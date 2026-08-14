const INR_SYMBOL = '\u20B9';

const CURRENCY_CONFIGS = {
  INR: { symbol: '\u20B9', locale: 'en-IN', code: 'INR' },
  USD: { symbol: '$', locale: 'en-US', code: 'USD' },
  EUR: { symbol: '\u20AC', locale: 'en-IE', code: 'EUR' },
  GBP: { symbol: '\u00A3', locale: 'en-GB', code: 'GBP' },
};

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

function resolveCurrency(currencyCode, currencySymbol) {
  if (currencyCode) {
    const code = String(currencyCode).trim().toUpperCase();
    if (CURRENCY_CONFIGS[code]) return CURRENCY_CONFIGS[code];
    return { symbol: currencySymbol || code, locale: 'en-US', code };
  }
  if (currencySymbol) {
    const sym = String(currencySymbol).trim();
    if (sym === '$') return CURRENCY_CONFIGS.USD;
    if (sym === '\u20AC' || sym === '€') return CURRENCY_CONFIGS.EUR;
    if (sym === '\u00A3' || sym === '£') return CURRENCY_CONFIGS.GBP;
    if (sym === '\u20B9' || sym === '₹' || sym.toLowerCase() === 'rs' || sym.toLowerCase() === 'rs.') return CURRENCY_CONFIGS.INR;
    return { symbol: sym, locale: 'en-US', code: 'UNKNOWN' };
  }
  return CURRENCY_CONFIGS.INR;
}

function formatNumber(value, options = {}) {
  const number = numericValue(value);
  if (number === null) return String(value ?? '');

  const locale = options.locale || 'en-IN';
  let minFraction = options.minimumFractionDigits;
  let maxFraction = options.maximumFractionDigits ?? 2;

  if (minFraction === undefined) {
    if (typeof value === 'string' && /\.\d{2}$/.test(value.trim())) {
      minFraction = 2;
    } else if (number % 1 !== 0) {
      const decimalStr = String(number).split('.')[1] || '';
      minFraction = Math.min(Math.max(decimalStr.length, 2), 2);
    } else {
      minFraction = 0;
    }
  }

  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: minFraction,
    maximumFractionDigits: maxFraction,
  }).format(number);
}

function formatCurrency(value, currencyCode, currencySymbol, options = {}) {
  const number = numericValue(value);
  if (number === null) return String(value ?? '');

  let detectedCode = currencyCode;
  let detectedSymbol = currencySymbol;

  // Support record objects passed directly to extract currency fields if present
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    detectedCode = value.Currency || value.currency || value.Currency_Code || detectedCode;
    detectedSymbol = value.Currency_Symbol || value.currency_symbol || detectedSymbol;
  }

  const config = resolveCurrency(detectedCode, detectedSymbol);
  const formattedNum = formatNumber(Math.abs(number), { ...options, locale: config.locale });

  return number < 0
    ? `-${config.symbol}${formattedNum}`
    : `${config.symbol}${formattedNum}`;
}

function isMonetaryField(field) {
  const name = String(field || '');
  return MONETARY_FIELD_PATTERN.test(name) && !NON_MONETARY_FIELD_PATTERN.test(name);
}

module.exports = {
  INR_SYMBOL,
  CURRENCY_CONFIGS,
  numericValue,
  resolveCurrency,
  formatNumber,
  formatCurrency,
  isMonetaryField,
};
