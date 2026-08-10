const ENGINE_BY_TYPE = {
  query: 'RetrievalEngine',
  count: 'RetrievalEngine',
  conversion_count: 'AnalyticsEngine',
  compare: 'AnalyticsEngine',
  aggregate: 'AnalyticsEngine',
  analytics: 'AnalyticsEngine',
};

function taskSignature(step) {
  return JSON.stringify({
    type: step.type,
    module: step.module,
    modules: step.modules,
    sourceModule: step.sourceModule,
    targetModule: step.targetModule,
    timeRange: step.timeRange,
    metric: step.metric,
    periods: step.periods,
    page: step.page,
    per_page: step.per_page,
    offset: step.offset,
  });
}

function resolveDependencies(steps = []) {
  const uniqueSteps = [];
  const seen = new Set();
  steps.forEach((step) => {
    const signature = taskSignature(step);
    if (seen.has(signature)) return;
    seen.add(signature);
    uniqueSteps.push(step);
  });

  const retrievalTaskIds = [];
  const retrievalByModule = new Map();
  const tasks = [];
  let sequence = 1;
  const modulesFor = (step) => (Array.isArray(step.modules) && step.modules.length > 0
    ? step.modules
    : [step.module || step.sourceModule].filter(Boolean));
  const ensureRetrieval = (module, timeRange) => {
    const key = `${module}:${JSON.stringify(timeRange || null)}`;
    if (retrievalByModule.has(key)) return retrievalByModule.get(key);
    const id = `task-${sequence}`;
    sequence += 1;
    tasks.push({
      id,
      engine: 'RetrievalEngine',
      type: 'retrieve',
      module,
      dependencies: [],
      step: { type: 'retrieve', module, timeRange },
    });
    retrievalByModule.set(key, id);
    retrievalTaskIds.push(id);
    return id;
  };

  const retrievalWindowsFor = (step) => (Array.isArray(step.periods) && step.periods.length > 0
    ? step.periods
    : [step.timeRange]);
  const usesCrmAggregate = (step) => step.type === 'aggregate'
    || (step.type === 'compare' && !step.intents?.includes('LIST')
      && step.metrics?.some((metric) => ['sum', 'revenue', 'average', 'maximum', 'minimum', 'pipeline'].includes(metric))
      && !step.metrics?.some((metric) => ['top_n', 'ranking', 'distribution', 'trend', 'growth', 'win_rate'].includes(metric)));

  uniqueSteps.forEach((step) => {
    const modules = modulesFor(step);
    if (!['query', 'count'].includes(step.type) && !usesCrmAggregate(step)) {
      modules.forEach((module) => retrievalWindowsFor(step).forEach((timeRange) => ensureRetrieval(module, timeRange)));
    }
    const id = `task-${sequence}`;
    sequence += 1;
    const engine = ENGINE_BY_TYPE[step.type] || 'Planner';
    const dependencies = ['query', 'count'].includes(step.type) || usesCrmAggregate(step)
      ? []
      : modules.flatMap((module) => retrievalWindowsFor(step)
        .map((timeRange) => retrievalByModule.get(`${module}:${JSON.stringify(timeRange || null)}`)))
        .filter(Boolean);
    if (['query', 'count'].includes(step.type)) {
      retrievalTaskIds.push(id);
      modules.forEach((module) => retrievalByModule.set(`${module}:${JSON.stringify(step.timeRange || null)}`, id));
    }
    tasks.push({ id, engine, type: step.type, module: step.module || null, dependencies, step });
  });

  return {
    steps: uniqueSteps,
    tasks,
    executionOrder: tasks.map((task) => task.id),
    dependencies: Object.fromEntries(tasks.map((task) => [task.id, task.dependencies])),
  };
}

module.exports = { resolveDependencies };
