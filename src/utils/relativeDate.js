const DEFAULT_TIMEZONE = process.env.CRM_TIMEZONE || process.env.APPLICATION_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const PERIOD_ALIASES = Object.freeze({
  today: 'today', yesterday: 'yesterday', tomorrow: 'tomorrow',
  'this week': 'this week', 'last week': 'last week', 'next week': 'next week',
  'this month': 'this month', 'last month': 'last month', 'next month': 'next month',
  'this quarter': 'this quarter', 'last quarter': 'last quarter', 'next quarter': 'next quarter',
  'this year': 'this year', 'last year': 'last year', 'next year': 'next year'
});

function zonedDateParts(date = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
}

function dateFromParts({ year, month, day }) {
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function resolveRelativePeriod(period, now = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const normalized = PERIOD_ALIASES[String(period || '').toLowerCase().trim()];
  if (!normalized) return null;
  const parts = zonedDateParts(now, timeZone);
  const today = dateFromParts(parts);
  const dayOfWeek = today.getUTCDay() || 7;
  let start;
  let end;
  if (normalized === 'today' || normalized === 'yesterday' || normalized === 'tomorrow') {
    const offset = normalized === 'yesterday' ? -1 : normalized === 'tomorrow' ? 1 : 0;
    start = addDays(today, offset);
    end = addDays(start, 1);
  } else if (normalized.endsWith('week')) {
    const offset = normalized.startsWith('last') ? -7 : normalized.startsWith('next') ? 7 : 0;
    start = addDays(today, 1 - dayOfWeek + offset);
    end = addDays(start, 7);
  } else if (normalized.endsWith('month')) {
    const offset = normalized.startsWith('last') ? -1 : normalized.startsWith('next') ? 1 : 0;
    start = new Date(Date.UTC(parts.year, parts.month - 1 + offset, 1));
    end = new Date(Date.UTC(parts.year, parts.month + offset, 1));
  } else if (normalized.endsWith('quarter')) {
    const offset = normalized.startsWith('last') ? -1 : normalized.startsWith('next') ? 1 : 0;
    const quarter = Math.floor((parts.month - 1) / 3) + offset;
    start = new Date(Date.UTC(parts.year, quarter * 3, 1));
    end = new Date(Date.UTC(parts.year, quarter * 3 + 3, 1));
  } else {
    const offset = normalized.startsWith('last') ? -1 : normalized.startsWith('next') ? 1 : 0;
    start = new Date(Date.UTC(parts.year + offset, 0, 1));
    end = new Date(Date.UTC(parts.year + offset + 1, 0, 1));
  }
  return { period: normalized, start: isoDate(start), end: isoDate(end), timeZone };
}

function relativePeriodFromText(text) {
  const lower = String(text || '').toLowerCase();
  return Object.keys(PERIOD_ALIASES).find((period) => new RegExp(`\\b${period.replace(' ', '\\s+')}\\b`).test(lower)) || null;
}

module.exports = { DEFAULT_TIMEZONE, resolveRelativePeriod, relativePeriodFromText };