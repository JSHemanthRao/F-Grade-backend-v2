function generateTasks({ question, intents, modules, timeRange, metrics, pagination, report, entities, relationships }) {
  const tasks = [];
  const hasValueMetric = metrics.some((metric) => ['sum', 'revenue', 'average', 'median', 'maximum', 'minimum', 'growth', 'pipeline', 'win_rate'].includes(metric));
  const primaryModule = modules[0] || null;
  const analyticsModule = modules.includes('accounts') && /customer|account|company/i.test(question)
    ? 'accounts'
    : primaryModule;
  const needsMonthlyAnalysis = metrics.includes('trend')
    && /\bmonthly\b|\blast\s+\d+\s+months?\b|\blast\s+year\b/i.test(question);
  const comparisonPeriods = timeRange.periods?.length > 1 ? timeRange.periods : undefined;

  if (report) {
    modules.filter((module) => module !== 'deals').forEach((module) => tasks.push({ type: 'query', module, timeRange, entities }));
    tasks.push({ type: 'analytics', module: 'deals', timeRange, entities, reportTasks: ['pipeline', 'closed_won', 'closed_lost', 'stage_distribution', 'top_customers', 'top_reps'] });
    return tasks;
  }

  if (relationships.includes('contact_to_deal')) {
    tasks.push({
      type: 'relationship',
      module: 'contacts',
      modules: ['deals', 'contacts'],
      relationship: 'contact_to_deal',
      timeRange,
      entities,
      relationships,
    });
  } else if (intents.includes('CONVERSION')) {
    tasks.push({
      type: 'conversion_count',
      sourceModule: modules.includes('leads') ? 'leads' : primaryModule,
      targetModule: modules.includes('deals') ? 'deals' : 'deals',
      module: modules.includes('leads') ? 'leads' : primaryModule,
      timeRange: timeRange.range,
      normalizedTimeRange: timeRange,
      metric: metrics.includes('conversion_rate') ? 'rate' : 'count',
      entities,
      relationships,
    });
  } else if (intents.includes('COUNT') && !hasValueMetric) {
    modules.forEach((module) => tasks.push({ type: 'count', module, timeRange, entities }));
  }

  if (!intents.includes('CONVERSION') && intents.includes('COMPARE')) {
    tasks.push({ type: 'compare', module: primaryModule, modules, timeRange, ...(comparisonPeriods ? { periods: comparisonPeriods } : {}), metrics, entities });
  }
  if (!intents.includes('CONVERSION') && !intents.includes('COMPARE') && needsMonthlyAnalysis) {
    tasks.push({ type: 'compare', module: primaryModule, modules, timeRange, ...(comparisonPeriods ? { periods: comparisonPeriods } : {}), metrics, entities, comparison: 'monthly' });
  }
  if (!intents.includes('CONVERSION') && !intents.includes('COMPARE') && !needsMonthlyAnalysis && intents.includes('AGGREGATION') && hasValueMetric) {
    tasks.push({ type: 'aggregate', module: primaryModule, timeRange, metrics, entities });
  }
  if (!intents.includes('CONVERSION') && intents.includes('ANALYTICS')) {
    tasks.push({ type: 'analytics', module: analyticsModule, timeRange, ...(comparisonPeriods ? { periods: comparisonPeriods } : {}), metrics, entities });
  }
  if (intents.includes('LIST') && tasks.length === 0) tasks.push({ type: 'query', module: primaryModule, timeRange, ...pagination });
  if (tasks.length === 0) tasks.push({ type: 'query', module: primaryModule, timeRange, ...pagination });
  return tasks;
}

module.exports = { generateTasks };
