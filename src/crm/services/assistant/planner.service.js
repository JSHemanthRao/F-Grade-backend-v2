const { DEBUG_ASSISTANT } = require('../../../common/config/env');
const { detectIntents } = require('./intent-detector.service');
const { detectModules, normalizeQuestion, tokenizeQuestion } = require('./module-detector.service');
const { detectTimeRange } = require('./date-detector.service');
const { resolveConversationContext } = require('./conversation-context.service');
const { detectEntities } = require('./entity-detector.service');
const { detectMetrics } = require('./metric-detector.service');
const { detectRelationships } = require('./relationship-detector.service');
const { generateTasks } = require('./task-generator.service');
const { resolveDependencies } = require('./dependency-resolver.service');
const { buildIntentQueryPlan } = require('./intent-query-planner.service');
const { resolveBusinessRequest } = require('../intent-resolution.service');
const logger = require('../../../common/logging/logger');

function detectPagination(question, module, conversation = {}) {
  const text = String(question || '').trim().toLowerCase();
  const pageMatch = text.match(/\bpage\s+(\d{1,6})(?:\s+(?:with|at)\s+(\d{1,3})\s+records?)?/i);
  const directionMatch = text.match(/\b(first|next|previous|last)\s+(\d{1,3})\b/i);
  const showMatch = text.match(/\bshow\s+(\d{1,3})\b/i);
  const giveMeMatch = text.match(/\bgive\s+me\s+(\d{1,3})\b/i);
  const requestedCount = pageMatch?.[2]
    ? Number(pageMatch[2])
    : directionMatch?.[2]
      ? Number(directionMatch[2])
      : showMatch?.[1]
        ? Number(showMatch[1])
        : giveMeMatch?.[1]
          ? Number(giveMeMatch[1])
        : null;
  const direction = pageMatch
    ? 'page'
    : directionMatch?.[1]?.toLowerCase() || (showMatch || giveMeMatch ? 'first' : /\b(?:remaining|continue|again)\b/i.test(text) ? 'next' : 'first');
  const page = pageMatch
    ? Number(pageMatch[1])
    : direction === 'next'
      ? 2
      : 1;
  const priorPagination = conversation.previousPagination || conversation.pagination;
  const isContinuation = !pageMatch && !directionMatch && !showMatch && !giveMeMatch && /\b(?:remaining|continue|again)\b/i.test(text);
  const continuationPage = Number.isInteger(priorPagination?.page) && (direction === 'next' || direction === 'previous' || isContinuation)
    ? Math.max(1, priorPagination.page + (direction === 'previous' ? -1 : 1))
    : page;
  const continuationSize = isContinuation && Number.isInteger(priorPagination?.per_page)
    ? priorPagination.per_page
    : requestedCount;

  return {
    action: 'query',
    module: module || null,
    page: continuationPage,
    per_page: continuationSize || null,
    offset: continuationSize ? (continuationPage - 1) * continuationSize : 0,
    direction,
    explicit: Boolean(pageMatch || directionMatch || showMatch || giveMeMatch || isContinuation),
  };
}

function buildExecutionPlan(question, context = {}) {
  const startedAt = process.hrtime.bigint();
  const originalQuestion = String(question || '').trim();
  const businessRequest = resolveBusinessRequest(originalQuestion, context);
  const semanticQuestion = businessRequest.corrected_question || originalQuestion;
  const normalizedQuestion = normalizeQuestion(semanticQuestion);
  const tokens = tokenizeQuestion(semanticQuestion);
  const conversation = resolveConversationContext(semanticQuestion, context);
  const intents = detectIntents(semanticQuestion);
  const detectedModules = detectModules(semanticQuestion);
  const isPerformanceReport = /complete\s+crm\s+performance\s+report|crm\s+performance\s+report|performance\s+report/i.test(originalQuestion);
  const modules = isPerformanceReport
    ? ['leads', 'contacts', 'accounts', 'deals']
    : detectedModules.length > 0
      ? detectedModules
      : conversation.effectiveModules;
  const timeRange = detectTimeRange(semanticQuestion);
  const pagination = detectPagination(semanticQuestion, modules[0], conversation);
  const entities = detectEntities(semanticQuestion);
  const metrics = detectMetrics(semanticQuestion);
  const relationships = detectRelationships(semanticQuestion, modules);
  const queryPlansByModule = Object.fromEntries(modules.map((moduleKey) => [moduleKey, buildIntentQueryPlan({
    question: semanticQuestion,
    moduleKey,
    intents,
    metrics,
    timeRange,
    entities,
    pagination,
    relationships,
    businessRequest,
  })]));
  const queryPlan = queryPlansByModule[modules[0]] || null;
  const generatedTasks = generateTasks({
    question: semanticQuestion,
    businessRequest,
    intents,
    modules,
    timeRange,
    metrics,
    pagination,
    report: isPerformanceReport,
    entities,
    relationships,
  });
  const resolved = resolveDependencies(generatedTasks);
  const plan = {
    question: originalQuestion,
    businessRequest,
    normalizedQuestion,
    tokens,
    intents,
    modules,
    timeRange,
    pagination,
    entities,
    metrics,
    relationships,
    conversation,
    steps: resolved.steps,
    tasks: resolved.tasks,
    executionOrder: resolved.executionOrder,
    dependencies: resolved.dependencies,
    engines: [...new Set(resolved.tasks.map((task) => task.engine))],
    report: isPerformanceReport,
    queryPlan,
    queryPlansByModule,
    plannerVersion: '3.0.0',
  };

  if (DEBUG_ASSISTANT) logger.info('Planner Engine', {
    question: originalQuestion,
    normalizedQuestion,
    conversation,
    detectedIntents: intents,
    detectedModules: modules,
    detectedEntities: entities,
    detectedMetrics: metrics,
    detectedDates: timeRange,
    generatedTasks: plan.tasks,
    executionOrder: plan.executionOrder,
    dependencies: plan.dependencies,
    plannerVersion: plan.plannerVersion,
    executionTimeMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
  });

  return plan;
}

module.exports = { buildExecutionPlan, detectPagination };
