const { DEBUG_ASSISTANT } = require('../../../common/config/env');
const logger = require('../../../common/logging/logger');

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_PATTERN = '(january|february|march|april|may|june|july|august|september|october|november|december)';

function iso(date) {
  return date.toISOString().replace('.000Z', 'Z');
}

function monthStart(year, month) {
  return new Date(Date.UTC(year, month, 1));
}

function dateWindow(start, end) {
  return { start, end };
}

function monthPeriod(monthIndex, year) {
  return {
    label: `${MONTHS[monthIndex]}${year ? ` ${year}` : ''}`,
    start: monthStart(year, monthIndex),
    end: monthStart(year, monthIndex + 1),
  };
}

function monthPeriods(start, end) {
  const periods = [];
  let cursor = new Date(start.valueOf());
  while (cursor < end) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    periods.push(monthPeriod(month, year));
    cursor = monthStart(year, month + 1);
  }
  return periods;
}

function parseDate(value) {
  const text = String(value || '').trim();
  const isoDate = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDate) return new Date(Date.UTC(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3])));
  const namedDate = text.match(/^([a-z]+)\s+(\d{1,2}),?\s+(\d{4})$/i);
  if (namedDate) {
    const month = MONTHS.indexOf(namedDate[1].toLowerCase());
    if (month >= 0) return new Date(Date.UTC(Number(namedDate[3]), month, Number(namedDate[2])));
  }
  return null;
}

function parseCustomRange(text, now) {
  const fullDate = '(?:[a-z]+\\s+\\d{1,2},?\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2})';
  const fullDateMatch = text.match(new RegExp(`(?:between|from)\\s+(${fullDate})\\s+(?:and|to)\\s+(${fullDate})`, 'i'));
  if (fullDateMatch) {
    const start = parseDate(fullDateMatch[1]);
    const end = parseDate(fullDateMatch[2]);
    if (start && end && start <= end) return dateWindow(start, new Date(end.valueOf() + 24 * 60 * 60 * 1000));
  }

  const monthRange = text.match(new RegExp(`(?:between|from)\\s+${MONTH_PATTERN}(?:\\s+(\\d{4}))?\\s+(?:and|to)\\s+${MONTH_PATTERN}(?:\\s+(\\d{4}))?`, 'i'));
  if (!monthRange) return null;
  const startMonth = MONTHS.indexOf(monthRange[1].toLowerCase());
  const endMonth = MONTHS.indexOf(monthRange[3].toLowerCase());
  const startYear = Number(monthRange[2] || now.getUTCFullYear());
  const endYear = Number(monthRange[4] || startYear);
  const start = monthStart(startYear, startMonth);
  const end = monthStart(endYear, endMonth + 1);
  return start < end ? dateWindow(start, end) : null;
}

function resolveWindow(label, now, rollingMonths, namedMonth, customRange) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  if (customRange) return customRange;
  if (label === 'today') return dateWindow(new Date(Date.UTC(year, month, now.getUTCDate())), new Date(Date.UTC(year, month, now.getUTCDate() + 1)));
  if (label === 'yesterday') return dateWindow(new Date(Date.UTC(year, month, now.getUTCDate() - 1)), new Date(Date.UTC(year, month, now.getUTCDate())));
  if (label === 'tomorrow') return dateWindow(new Date(Date.UTC(year, month, now.getUTCDate() + 1)), new Date(Date.UTC(year, month, now.getUTCDate() + 2)));
  if (label === 'this week' || label === 'last week') {
    const day = now.getUTCDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const start = new Date(Date.UTC(year, month, now.getUTCDate() + mondayOffset + (label === 'last week' ? -7 : 0)));
    return dateWindow(start, new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 7)));
  }
  if (label === 'this month') return dateWindow(monthStart(year, month), now);
  if (label === 'last month') return dateWindow(monthStart(year, month - 1), monthStart(year, month));
  if (label === 'next month') return dateWindow(monthStart(year, month + 1), monthStart(year, month + 2));
  if (label === 'this quarter' || label === 'last quarter') {
    const quarter = Math.floor(month / 3) + (label === 'last quarter' ? -1 : 0);
    return dateWindow(monthStart(year, quarter * 3), monthStart(year, (quarter + 1) * 3));
  }
  if (label === 'this year' || label === 'last year') {
    const offset = label === 'last year' ? -1 : 0;
    return dateWindow(new Date(Date.UTC(year + offset, 0, 1)), new Date(Date.UTC(year + offset + 1, 0, 1)));
  }
  if (label === 'last 30 days') return dateWindow(new Date(now.valueOf() - 30 * 24 * 60 * 60 * 1000), now);
  if (rollingMonths) return dateWindow(monthStart(year, month - Number(rollingMonths[1])), monthStart(year, month));
  if (namedMonth) {
    const targetYear = Number(namedMonth[2] || year);
    const targetMonth = MONTHS.indexOf(namedMonth[1].toLowerCase());
    return dateWindow(monthStart(targetYear, targetMonth), monthStart(targetYear, targetMonth + 1));
  }
  return null;
}

function isCurrentMonth(period, now) {
  return period.start.getUTCFullYear() === now.getUTCFullYear() && period.start.getUTCMonth() === now.getUTCMonth();
}

function selectedNamedPeriods(namedMonths) {
  return namedMonths.map(({ month, year }) => monthPeriod(MONTHS.indexOf(month), year));
}

function detectTimeRange(question) {
  const normalizedQuestion = String(question || '').trim().toLowerCase();
  const now = new Date();

  // --- Specific single-day: "July 26, 2026" / "26 July 2026" / "26th july 2026" ---
  // Only when the question is NOT a multi-date custom range (from...to / between...and)
  const isCustomRangeQuery = /\b(?:from|between)\b.+\b(?:to|and)\b/i.test(normalizedQuestion);
  if (!isCustomRangeQuery) {
    const specificDayPatterns = [
      // "Month DD, YYYY" or "Month DD YYYY"
      new RegExp(`\\b${MONTH_PATTERN}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'i'),
      // "DD Month YYYY" or "DDth Month YYYY"
      new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_PATTERN}\\s+(\\d{4})\\b`, 'i'),
    ];
    for (const pattern of specificDayPatterns) {
      const m = normalizedQuestion.match(pattern);
      if (m) {
        let monthStr, dayStr, yearStr;
        // First pattern: Month DD YYYY
        if (MONTHS.indexOf(m[1].toLowerCase()) >= 0) {
          monthStr = m[1]; dayStr = m[2]; yearStr = m[3];
        } else {
          // Second pattern: DD Month YYYY
          dayStr = m[1]; monthStr = m[2]; yearStr = m[3];
        }
        const monthIdx = MONTHS.indexOf(monthStr.toLowerCase());
        if (monthIdx >= 0) {
          const year = Number(yearStr);
          const day = Number(dayStr);
          if (year > 2000 && day >= 1 && day <= 31) {
            const start = new Date(Date.UTC(year, monthIdx, day));
            const end = new Date(Date.UTC(year, monthIdx, day + 1));
            const startIso = iso(start);
            const endIso = iso(end);
            const result = {
              label: `${monthStr} ${day}, ${year}`,
              range: 'specific_day',
              includesCurrentMonth: isCurrentMonth({ start }, now),
              historicalOnly: !isCurrentMonth({ start }, now),
              startDate: startIso,
              endDate: endIso,
              year,
              periods: [{ label: `${monthStr} ${day}, ${year}`, startDate: startIso, endDate: endIso, isCurrentMonth: isCurrentMonth({ start }, now) }],
            };
            if (DEBUG_ASSISTANT) logger.info('Date Detector', { originalQuestion: question, mode: 'specific_day', result });
            return result;
          }
        }
      }
    }
  }


  const rollingMonths = normalizedQuestion.match(/last\s+(\d+)\s+months?/i);
  const namedMonths = [...normalizedQuestion.matchAll(new RegExp(`\\b${MONTH_PATTERN}(?:\\s+(\\d{4}))?\\b`, 'gi'))]
    .map((match) => ({ month: match[1].toLowerCase(), year: match[2] ? Number(match[2]) : now.getUTCFullYear() }));

  const customRange = parseCustomRange(normalizedQuestion, now);
  const detectedKeywords = [];
  const relativeTerms = ['today', 'yesterday', 'tomorrow', 'this week', 'last week', 'this month', 'last month', 'next month', 'this quarter', 'last quarter', 'this year', 'last year', 'last 30 days'];
  relativeTerms.forEach((term) => { if (normalizedQuestion.includes(term)) detectedKeywords.push(term); });
  if (/current\s+month|month[-\s]+to[-\s]+date/.test(normalizedQuestion)) detectedKeywords.push('this month');
  if (/previous\s+month/.test(normalizedQuestion)) detectedKeywords.push('last month');
  if (rollingMonths) detectedKeywords.push(`last ${rollingMonths[1]} months`);
  if (customRange) detectedKeywords.push('custom date range');
  if (!customRange) namedMonths.forEach(({ month }) => detectedKeywords.push(month));

  const explicitRelative = detectedKeywords.find((term) => relativeTerms.includes(term));
  const label = customRange ? 'custom date range' : explicitRelative || (rollingMonths ? `last ${rollingMonths[1]} months` : namedMonths.length > 1 ? 'named months' : namedMonths[0]?.month);
  const namedPeriodWindows = !customRange && namedMonths.length > 1 ? selectedNamedPeriods(namedMonths) : [];
  const namedWindow = namedPeriodWindows.length > 1
    ? dateWindow(namedPeriodWindows[0].start, namedPeriodWindows.at(-1).end)
    : null;
  const window = customRange || namedWindow || resolveWindow(label, now, rollingMonths, namedMonths[0] && [null, namedMonths[0].month, namedMonths[0].year], customRange);
  const periods = namedPeriodWindows.length > 1 ? namedPeriodWindows : window ? monthPeriods(window.start, window.end) : [];
  const currentMonthIncluded = window ? periods.some((period) => isCurrentMonth(period, now)) : false;
  const result = label
    ? {
      label,
      range: label === 'custom date range' ? 'custom_range' : label.replace(/\s+/g, '_'),
      includesCurrentMonth: currentMonthIncluded,
      historicalOnly: !currentMonthIncluded,
      ...(rollingMonths ? { monthCount: Number(rollingMonths[1]) } : {}),
      ...(namedMonths[0] ? { year: namedMonths[0].year } : {}),
      ...(window ? { startDate: iso(window.start), endDate: iso(window.end) } : {}),
      ...(periods.length > 0 ? { periods: periods.map((period) => ({ label: period.label, startDate: iso(period.start), endDate: iso(period.end), isCurrentMonth: isCurrentMonth(period, now) })) } : {}),
    }
    : { label: 'all time', range: 'all_time' };

  if (DEBUG_ASSISTANT) logger.info('Date Detector', {
    originalQuestion: question,
    detectedTimeKeywords: detectedKeywords,
    resolvedStartDate: result.startDate || null,
    resolvedEndDate: result.endDate || null,
    result,
  });
  return result;
}

module.exports = { detectTimeRange };
