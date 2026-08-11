const { DEBUG_ASSISTANT } = require('../../common/config/env');
const recordsService = require('../services/retrieval-engine.service');
const { resolveRequestedModule } = require('../validators/crm.validator');
const { getModuleDefinition } = require('../services/module-definition.service');
const assistantEngine = require('../services/assistant-engine.service');
const logger = require('../../common/logging/logger');

function formatExecutionTime(startTime) {
  const elapsedNanoSeconds = process.hrtime.bigint() - startTime;
  return `${Number(elapsedNanoSeconds / 1000000n).toFixed(2)}ms`;
}

function createRequestAbortSignal(req, res) {
  const controller = new AbortController();
  const supportsAbortEvents = typeof req.on === 'function' || typeof res.on === 'function';
  const abort = () => controller.abort();
  const onResponseClose = () => {
    if (!res.writableEnded) controller.abort();
  };

  if (supportsAbortEvents) {
    req.on?.('aborted', abort);
    res.on?.('close', onResponseClose);
  }

  return {
    signal: supportsAbortEvents ? controller.signal : undefined,
    cleanup: () => {
      req.off?.('aborted', abort);
      res.off?.('close', onResponseClose);
    },
  };
}

function sendQueryResponse(req, res, moduleDefinition, result, executionTime) {
  const data = Array.isArray(result?.data)
    ? result.data
    : Array.isArray(result?.users)
      ? result.users
      : [];
  const info = result?.info || {};

  const count = Number.isFinite(info.count)
    ? info.count
    : data.length;
  const requestSource = req.method === 'POST' ? req.body : req.query;
  const pageValue = requestSource?.page ?? info.page;
  const perPageValue = requestSource?.per_page ?? info.per_page;

  const page = Number.isFinite(Number(pageValue))
    ? Number(pageValue)
    : 1;
  const per_page = Number.isFinite(Number(perPageValue))
    ? Number(perPageValue)
    : data.length;

  logger.info('CRM Controller', {
    event: 'response_constructed',
    module: moduleDefinition.label,
    responseRecords: data.length,
    totalMatchingRecords: count,
    page,
    per_page,
    executionTime,
  });

  res.json({
    success: true,
    module: moduleDefinition.label,
    count,
    page,
    per_page,
    executionTime,
    source: 'Zoho CRM',
    data,
  });
}

function sendCountResponse(req, res, moduleDefinition, result, executionTime) {
  const info = result?.info || {};
  const count = Number.isFinite(info.count) ? info.count : 0;

  logger.info('CRM Controller', {
    event: 'count_response_constructed',
    module: moduleDefinition.label,
    totalMatchingRecords: count,
    executionTime,
  });

  res.json({
    success: true,
    module: moduleDefinition.label,
    count,
    executionTime,
    source: 'Zoho CRM',
  });
}

function buildCommonOptions(req) {
  const requestSource = req.method === 'POST' ? req.body : req.query;
  const hasExplicitApiPage = requestSource?.page !== undefined && requestSource?.page !== null && requestSource?.page !== ''
    && !(Number(requestSource?.page) === 1 && Number(requestSource?.per_page) === 25);
  const retrievalMode = hasExplicitApiPage ? undefined : 'all';

  return {
    page: requestSource?.page,
    per_page: requestSource?.per_page,
    ids: requestSource?.ids,
    fields: requestSource?.fields,
    criteria: requestSource?.criteria,
    filter: requestSource?.filter,
    filters: requestSource?.filters,
    search: requestSource?.search,
    requestText: requestSource?.requestText ?? requestSource?.request_text,
    userQuery: requestSource?.userQuery ?? requestSource?.user_query,
    question: requestSource?.question,
    prompt: requestSource?.prompt,
    message: requestSource?.message,
    date_field: requestSource?.date_field ?? requestSource?.dateField,
    from: requestSource?.from,
    to: requestSource?.to,
    sort_by: requestSource?.sort_by,
    sort_order: requestSource?.sort_order,
    force_coql: !hasExplicitApiPage && Boolean(requestSource?.criteria || requestSource?.filter || requestSource?.filters),
    retrieval_mode: retrievalMode,
  };
}

async function getModuleQuery(req, res, next) {
  try {
    const moduleKey = resolveRequestedModule(req);
    const moduleDefinition = getModuleDefinition(moduleKey);
    const startTime = process.hrtime.bigint();
    const options = buildCommonOptions(req);
    const requestContext = createRequestAbortSignal(req, res);

    logger.info('Retrieval Engine', {
      module: moduleDefinition.label,
      operation: 'query',
    });

    let result;
    try {
      result = await recordsService.getRecords(moduleKey, {
        ...options,
        ...(requestContext.signal ? { signal: requestContext.signal } : {}),
      });
    } finally {
      requestContext.cleanup();
    }

    sendQueryResponse(req, res, moduleDefinition, result, formatExecutionTime(startTime));
  } catch (error) {
    return next(error);
  }
}

async function getModuleCount(req, res, next) {
  try {
    const moduleKey = resolveRequestedModule(req);
    const moduleDefinition = getModuleDefinition(moduleKey);
    const startTime = process.hrtime.bigint();
    const requestSource = req.method === 'POST' ? req.body : req.query;
    const requestContext = createRequestAbortSignal(req, res);
    const options = {
      filter: requestSource?.filter ?? requestSource?.filters,
      filters: requestSource?.filter ?? requestSource?.filters,
      criteria: requestSource?.criteria,
      date_field: requestSource?.date_field ?? requestSource?.dateField,
      from: requestSource?.from,
      to: requestSource?.to,
      search: requestSource?.search,
      requestText: requestSource?.requestText ?? requestSource?.request_text,
      userQuery: requestSource?.userQuery ?? requestSource?.user_query,
      question: requestSource?.question,
      prompt: requestSource?.prompt,
      message: requestSource?.message,
      retrieval_mode: 'count',
    };

    logger.info('Retrieval Engine', {
      module: moduleDefinition.label,
      operation: 'count',
    });

    let result;
    try {
      result = await recordsService.getCount(moduleKey, {
        ...options,
        ...(requestContext.signal ? { signal: requestContext.signal } : {}),
      });
    } finally {
      requestContext.cleanup();
    }

    sendCountResponse(req, res, moduleDefinition, result, formatExecutionTime(startTime));
  } catch (error) {
    return next(error);
  }
}

async function handleAssistantRequest(req, res, next) {
  try {
    const requestSource = req.method === 'POST' ? req.body : req.query;
    const question = String(requestSource?.question || requestSource?.prompt || requestSource?.message || '').trim();
    const startTime = process.hrtime.bigint();

    if (!question) {
      return res.status(400).json({ success: false, message: 'A question is required.' });
    }

    const requestContext = createRequestAbortSignal(req, res);

    if (DEBUG_ASSISTANT) {
      logger.info('Assistant Controller', {
        receivedRequest: {
          method: req.method,
          url: req.originalUrl || req.url,
          headers: req.headers,
          body: req.body,
          query: req.query,
          params: req.params,
          ip: req.ip,
        },
        question,
        questionType: 'assistant',
        questionLength: question.length,
      });
    }

    let engineResponse;
    try {
      engineResponse = await assistantEngine.handleAssistantRequest({
        question,
        ...(requestContext.signal ? { signal: requestContext.signal } : {}),
      });
    } finally {
      requestContext.cleanup();
    }

    return res.json({
      ...engineResponse,
      executionTime: formatExecutionTime(startTime),
      source: engineResponse.source || 'Zoho CRM',
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getModuleCount,
  getModuleQuery,
  getModuleRecords: getModuleQuery,
  handleAssistantRequest,
};
