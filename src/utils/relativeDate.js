const { env } = require('../config/env');

const DEFAULT_TIMEZONE = env.crmTimezone;

const WEEKDAYS = Object.freeze({
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6
});

const PERIOD_ALIASES = Object.freeze({
  today: 'today', yesterday: 'yesterday', tomorrow: 'tomorrow',
  'this week': 'this week', 'last week': 'last week', 'next week': 'next week',
  'this month': 'this month', 'last month': 'last month', 'next month': 'next month', 'past month': 'past month',
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
  const raw = String(period || '').toLowerCase().trim();
  const normalized = PERIOD_ALIASES[raw] || resolveWeekdayPeriodAlias(raw);
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
  } else if (isWeekdayPeriod(normalized)) {
    const weekdayRange = calculateWeekdayRange(normalized, today);
    start = weekdayRange.start;
    end = weekdayRange.end;
  } else if (normalized.endsWith('week')) {
    const offset = normalized.startsWith('last') ? -7 : normalized.startsWith('next') ? 7 : 0;
    start = addDays(today, 1 - dayOfWeek + offset);
    end = addDays(start, 7);
  } else if (normalized === 'past month') {
    start = addDays(today, -31);
    end = today;
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

function resolveWeekdayPeriodAlias(text) {
  const match = String(text || '').toLowerCase().match(/\b(?:(next|this|last)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (!match) return null;
  const modifier = match[1] ? match[1].toLowerCase() : 'next';
  const weekday = match[2].toLowerCase();
  return `${modifier} ${weekday}`;
}

function isWeekdayPeriod(normalized) {
  return /^(?:next|this|last)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/.test(normalized);
}

function calculateWeekdayRange(normalized, today) {
  const match = normalized.match(/^(next|this|last)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/);
  const modifier = match[1];
  const targetDay = WEEKDAYS[match[2]];
  const currentDay = today.getUTCDay(); // 0 = Sunday, 1 = Monday, ... 6 = Saturday

  let start;
  if (modifier === 'next') {
    let diff = (targetDay - currentDay + 7) % 7;
    if (diff === 0) diff = 7;
    start = addDays(today, diff);
  } else if (modifier === 'last') {
    let diff = (currentDay - targetDay + 7) % 7;
    if (diff === 0) diff = 7;
    start = addDays(today, -diff);
  } else { // this
    const dayOfWeekMonday = currentDay || 7;
    const targetMondayBased = targetDay === 0 ? 7 : targetDay;
    const diff = targetMondayBased - dayOfWeekMonday;
    start = addDays(today, diff);
  }
  const end = addDays(start, 1);
  return { start, end };
}

function relativePeriodFromText(text) {
  const lower = String(text || '').toLowerCase();
  const directMatch = Object.keys(PERIOD_ALIASES).find((period) => new RegExp(`\\b${period.replace(' ', '\\s+')}\\b`).test(lower));
  if (directMatch) return directMatch;
  const weekdayMatch = lower.match(/\b(?:(next|this|last)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (weekdayMatch) {
    const modifier = weekdayMatch[1] ? weekdayMatch[1].toLowerCase() : 'next';
    const weekday = weekdayMatch[2].toLowerCase();
    return `${modifier} ${weekday}`;
  }
  return null;
}

module.exports = { DEFAULT_TIMEZONE, resolveRelativePeriod, relativePeriodFromText, WEEKDAYS };
