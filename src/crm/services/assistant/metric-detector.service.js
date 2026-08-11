const METRIC_PATTERNS = [
  ['conversion_rate', /conversion\s+rate/i],
  ['win_rate', /win\s+rate/i],
  ['count', /\b(how many|number of|count|total\s+(?:leads|deals|records|contacts|accounts))\b/i],
  ['sum', /\b(sum|value|total\s+(?:value|revenue|sales)|revenue|sales?|amount|deal\s+value)\b/i],
  ['revenue', /\b(revenue|sales?)\b/i],
  ['average', /\b(average|avg)\b/i],
  ['median', /\bmedian\b/i],
  ['maximum', /\b(maximum|max|highest)\b/i],
  ['minimum', /\b(minimum|min|lowest)\b/i],
  ['growth', /\b(growth|increase|decrease|decline)\b/i],
  ['comparison', /\b(compare|versus|vs|difference|better than|worse than|mom|yoy)\b/i],
  ['mom', /\bmom\b|month[-\s]+over[-\s]+month/i],
  ['yoy', /\byoy\b|year[-\s]+over[-\s]+year/i],
  ['top_n', /\b(top|bottom)(?:\s+\d+)?\b/i],
  ['ranking', /\b(ranking|rank|leader|performer|top\s+(?:customers|accounts|owners|reps)|bottom\s+(?:customers|accounts|owners|reps))\b/i],
  ['distribution', /\b(distribution|breakdown)\b/i],
  ['trend', /\b(trend|monthly|over time)\b/i],
  ['pipeline', /\bpipeline\b/i],
];

function detectMetrics(question = '') {
  const metrics = METRIC_PATTERNS.filter(([, pattern]) => pattern.test(question)).map(([metric]) => metric);
  return [...new Set(metrics)];
}

module.exports = { detectMetrics };
