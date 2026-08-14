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
    text: `Data: ${JSON.stringify(data)}`,
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
  const retrievalMode = requestSource?.retrieval_mode ?? requestSource?.retrievalMode;
  const operation = String(requestSource?.operation || 'query').trim().toLowerCase();

  return {
    page: requestSource?.page,
    per_page: requestSource?.per_page ?? requestSource?.limit,
    limit: requestSource?.limit,
    operation,
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
    force_coql: String(retrievalMode || '').trim().toLowerCase() === 'all'
      && Boolean(requestSource?.criteria || requestSource?.filter || requestSource?.filters),
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
    const isCountOperation = String(options.operation || '').toLowerCase() === 'count';

    if (!isCountOperation) {
      logger.info('QUERY DATE DEBUG', {
        module: moduleDefinition.label,
        date_field: options.date_field ?? null,
        from: options.from ?? null,
        to: options.to ?? null,
        limit: options.limit ?? options.per_page ?? null,
      });
    }

    logger.info('Retrieval Engine', {
      module: moduleDefinition.label,
      operation: isCountOperation ? 'count' : 'query',
    });

    let result;
    try {
      result = await (isCountOperation ? recordsService.getCount : recordsService.getRecords)(moduleKey, {
        ...options,
        ...(isCountOperation ? { retrieval_mode: 'count' } : {}),
        ...(requestContext.signal ? { signal: requestContext.signal } : {}),
      });
    } finally {
      requestContext.cleanup();
    }

    if (isCountOperation) {
      return sendCountResponse(req, res, moduleDefinition, result, formatExecutionTime(startTime));
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

async function getCRMActivity(req, res, next) {
  try {
    const startTime = process.hrtime.bigint();
    const requestSource = req.method === 'POST' ? req.body : req.query;
    const requestContext = createRequestAbortSignal(req, res);

    const activityService = require('../services/activity.service');

    const options = {
      module: requestSource?.module,
      user_id: requestSource?.user_id ?? requestSource?.userId ?? requestSource?.user,
      from: requestSource?.from,
      to: requestSource?.to,
      action: requestSource?.action,
      limit: requestSource?.limit,
      timezone: requestSource?.timezone,
      signal: requestContext.signal,
    };

    let result;
    try {
      result = await activityService.getActivity(options);
    } finally {
      requestContext.cleanup();
    }

    logger.info('CRM Controller', {
      event: 'activity_response_constructed',
      count: result.count,
      executionTime: formatExecutionTime(startTime),
    });

    return res.json({
      ...result,
      executionTime: formatExecutionTime(startTime),
      source: 'Zoho CRM',
    });
  } catch (error) {
    return next(error);
  }
}

async function getDashboardData(req, res, next) {
  try {
    const startTime = process.hrtime.bigint();
    const requestSource = req.method === 'POST' ? req.body : req.query;
    const requestContext = createRequestAbortSignal(req, res);
    const dashboardService = require('../services/dashboard.service');

    const inputData = requestSource?.data
      || requestSource?.records
      || requestSource?.deals
      || requestSource?.items
      || requestSource?.queryResult?.data
      || requestSource?.queryResult;

    const fromVal = requestSource?.from || requestSource?.date_from || requestSource?.dateRange?.from || requestSource?.startDate;
    const toVal = requestSource?.to || requestSource?.date_to || requestSource?.dateRange?.to || requestSource?.endDate;
    const question = requestSource?.request || requestSource?.question || requestSource?.prompt;

    logger.info('[DASHBOARD REQUEST]', {
      request: question || '(none)',
      from: fromVal || null,
      to: toVal || null,
      date_field: requestSource?.date_field || requestSource?.dateField || null,
      type: requestSource?.type || null,
      employee: requestSource?.employee || requestSource?.user_id || null,
      hasProvidedData: Array.isArray(inputData) && inputData.length > 0,
    });

    const options = {
      title: requestSource?.title,
      type: requestSource?.type,
      theme: requestSource?.theme,
      dateRange: (fromVal && toVal) ? { from: fromVal, to: toVal } : requestSource?.dateRange,
      from: fromVal,
      to: toVal,
      date_field: requestSource?.date_field || requestSource?.dateField,
      data: Array.isArray(inputData) ? inputData : undefined,
      records: Array.isArray(inputData) ? inputData : undefined,
      leads: Array.isArray(requestSource?.leads) ? requestSource.leads : undefined,
      activities: Array.isArray(requestSource?.activities) ? requestSource.activities : undefined,
      modules: requestSource?.modules,
      metrics: requestSource?.metrics,
      groupings: requestSource?.groupings,
      employee: requestSource?.employee || requestSource?.user_id,
      user_id: requestSource?.user_id || requestSource?.employee,
      question,
      signal: requestContext.signal,
    };

    let result;
    try {
      result = await dashboardService.getDashboard(options);
    } finally {
      requestContext.cleanup();
    }

    logger.info('CRM Controller', {
      event: 'dashboard_response_constructed',
      title: result.dashboard?.title,
      widgetCount: result.dashboard?.widgets?.length,
      recordsCount: result.data?.length || result.dashboard?.data?.length || 0,
      crmError: result.crmError || false,
      executionTime: formatExecutionTime(startTime),
    });

    // CRM API failure: return success=false with a clear error — never fake zero metrics
    if (result.crmError) {
      logger.error('[DASHBOARD ERROR]', {
        event: 'returning_crm_failure_to_client',
        message: result.errorMessage,
      });
      return res.status(502).json({
        success: false,
        error: {
          code: 'CRM_API_ERROR',
          message: result.errorMessage || 'The CRM API returned an error. The dashboard could not be generated.',
        },
        dashboard: result.dashboard,
        executionTime: formatExecutionTime(startTime),
        source: 'Zoho CRM',
      });
    }

    const rawRecords = result.data || result.records || result.dashboard?.data || [];
    const dataJsonStr = JSON.stringify(rawRecords);
    const dataHeader = rawRecords.length > 0 ? `Data: ${dataJsonStr}\n\n` : '';

    return res.json({
      success: true,
      ...result,
      text: `${dataHeader}${result.dashboard?.summary || ''}`.trim(),
      executionTime: formatExecutionTime(startTime),
      source: 'Zoho CRM',
    });
  } catch (error) {
    return next(error);
  }
}

async function renderDashboardView(req, res, next) {
  try {
    const requestSource = req.method === 'POST' ? req.body : req.query;
    const requestContext = createRequestAbortSignal(req, res);
    const dashboardService = require('../services/dashboard.service');
    const { generateDashboardHtml } = require('../dashboard/dashboard-renderer');

    const options = {
      title: requestSource?.title,
      type: requestSource?.type,
      theme: requestSource?.theme,
      dateRange: requestSource?.dateRange || {
        from: requestSource?.from || requestSource?.date_from,
        to: requestSource?.to || requestSource?.date_to,
      },
      employee: requestSource?.employee || requestSource?.user_id,
      question: requestSource?.question || requestSource?.prompt,
      signal: requestContext.signal,
    };

    let result;
    try {
      result = await dashboardService.getDashboard(options);
    } finally {
      requestContext.cleanup();
    }

    const html = generateDashboardHtml(result);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getCRMActivity,
  getDashboardData,
  getModuleCount,
  getModuleQuery,
  getModuleRecords: getModuleQuery,
  handleAssistantRequest,
  renderDashboardView,
};

