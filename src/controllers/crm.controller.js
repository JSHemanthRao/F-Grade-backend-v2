const { CrmService } = require('../services/crm.service');
const { createAppError } = require('../utils/errors');
const { CRM_API_NAMES, CRM_MODULES } = require('../constants/crmModules');
const { resolveRelativePeriod, relativePeriodFromText } = require('../utils/relativeDate');
const { createCrmDiagnostics, recordCrmEvent, runWithCrmDiagnostics, updateDiagnostics, diagnosticsFromError, publicCrmDiagnostics } = require('../utils/crmDiagnostics');
const { env } = require('../config/env');
const { createCrmQueryPlanner } = require('../planners/crmQueryPlanner');

const MAX_QUESTION_LENGTH = 2000;

const planCrmQuestion = createCrmQueryPlanner(planQuestion);

function createCrmController(crmService = new CrmService()) {
  const conversationContext = new Map();
  return {
    test: async (req, res, next) => {
      try {
        const module = req.body?.module || 'Meetings';
        const mock = {
          success: true,
          status: 'ok',
          module,
          request_type: 'records',
          data: [{ id: 'mock-1', title: 'Mock record' }],
          count: 1,
          answer: `Mock response for module ${module}`
        };
        res.status(200).json(mock);
      } catch (err) {
        next(err);
      }
    },
    diagnostics: async (req, res, next) => {
      try {
        if (typeof crmService.runDiagnostics !== 'function') {
          return res.status(501).json({ success: false, status: 'error', error: { code: 'NOT_IMPLEMENTED', message: 'Diagnostics are not available.' } });
        }
        const result = await crmService.runDiagnostics();
        res.status(200).json({ success: true, status: 'ok', result });
      } catch (err) {
        next(err);
      }
    },
    query: async (req, res, next) => {
      try {
        const result = await crmService.query(req.body);
        // Ensure structured summary objects are serialized to strings for connector compatibility
        const safe = stringifySummary(Object.assign({}, result));
        res.status(200).json({ success: true, status: 'ok', ...safe });
      } catch (error) {
        next(error);
      }
    },
    assistant: async (req, res, next) => {
      const diagnostics = req.crmDiagnostics || createCrmDiagnostics();
      req.crmDiagnostics = diagnostics;
      recordCrmEvent('REQUEST_RECEIVED', diagnostics, { method: req.method, path: req.originalUrl });
      return runWithCrmDiagnostics(diagnostics, async () => {
       try {
        const question = req.body?.question;
        updateDiagnostics(diagnostics, { question: typeof question === 'string' ? question : 'not_reached', stage: 'question_parsed' });
        recordCrmEvent('QUESTION_PARSED', diagnostics, { question: diagnostics.question });
        if (typeof question !== 'string' || question.trim().length === 0) {
          const error = new Error('One of question, prompt, or message is required.');
          error.code = 'QUESTION_REQUIRED';
          error.statusCode = 400;
          throw error;
        }
        if (question.length > MAX_QUESTION_LENGTH) {
          const error = new Error(`Question must not exceed ${MAX_QUESTION_LENGTH} characters.`);
          error.code = 'QUESTION_TOO_LONG';
          error.statusCode = 400;
          throw error;
        }
        const conversationId = typeof req.body?.conversation_id === 'string' && req.body.conversation_id.trim()
  ? req.body.conversation_id.trim()
  : null;

const previous = conversationId
  ? conversationContext.get(conversationId)
  : null;
        const resolvedQuestion = resolveFollowUpQuestion(question, previous);
        const explicitModule = extractExplicitModule(resolvedQuestion.toLowerCase());
        const plannedRequest = planContinuationAwareRequest(planCrmQuestion(resolvedQuestion), question, previous);
        updateDiagnostics(diagnostics, {
          resolved_module: plannedRequest.module || explicitModule || 'not_reached',
          module_api_name: plannedRequest.module_api_name || 'not_reached',
          resolved_fields: Array.isArray(plannedRequest.fields) ? plannedRequest.fields : [],
          resolved_filters: Array.isArray(plannedRequest.filters) ? plannedRequest.filters : [],
          intent: plannedRequest.intent || plannedRequest.request_type || 'records',
          pagination: plannedRequest.pagination || { limit: plannedRequest.limit, offset: plannedRequest.offset },
          request_type: plannedRequest.request_type || 'records',
          stage: 'query_planned'
        });
        recordCrmEvent('QUERY_PLANNED', diagnostics, {
          module: diagnostics.resolved_module,
          module_api_name: diagnostics.module_api_name,
          fields: diagnostics.resolved_fields,
          filters: diagnostics.resolved_filters
        });
        assertExplicitModuleRouting(explicitModule, plannedRequest.module);
        const result = await crmService.query(plannedRequest, undefined, diagnostics);
        updateDiagnostics(diagnostics, {
          resolved_module: result.module || diagnostics.resolved_module,
          module_api_name: result.module_api_name || diagnostics.module_api_name,
          resolved_fields: Array.isArray(result.fields) ? result.fields : diagnostics.resolved_fields,
          resolved_filters: Array.isArray(result.filters) ? result.filters : diagnostics.resolved_filters,
          request_type: result.request_type || diagnostics.request_type,
          zoho_error_code: null,
          zoho_error_message: null,
          stage: 'response_normalized'
        });
        recordCrmEvent('RESPONSE_NORMALIZED', diagnostics, { module: diagnostics.resolved_module, request_type: diagnostics.request_type });
        if (conversationId) {
  const canonicalState = buildCanonicalConversationState(
    resolvedQuestion,
    plannedRequest,
    result,
    diagnostics.request_id
  );

  const previousState = previous?.canonicalState;

  if (
    previousState &&
    isSameQueryShape(previousState, plannedRequest) &&
    isDuplicatePage(previousState, canonicalState) &&
    canonicalState.pagination.offset > previousState.pagination.offset
  ) {
    const error = new Error(
      'The requested next page returned the same records as the previous page.'
    );

    error.code = 'PAGINATION_DUPLICATE_PAGE';
    error.statusCode = 409;
    error.details = {
      request_id: diagnostics.request_id,
      previous_offset: previousState.pagination.offset,
      current_offset: canonicalState.pagination.offset
    };

    throw error;
  }

  conversationContext.set(conversationId, {
    question: resolvedQuestion,
    plannedRequest,
    canonicalState
  });

  if (conversationContext.size > 1000) {
    conversationContext.delete(
      conversationContext.keys().next().value
    );
  }
}
        const answer = isDashboardRequest(resolvedQuestion)
          ? JSON.stringify(buildDashboardSpecification(resolvedQuestion, result), null, 2)
          : buildAssistantAnswer(resolvedQuestion, result);
        const safe = stringifySummary(Object.assign({}, result));
        const publicDiagnostics = publicCrmDiagnostics(diagnostics, env.crmDebug);
        res.status(200).json({ success: true, status: 'ok', request_id: diagnostics.request_id, question, answer, diagnostics: publicDiagnostics, ...safe });
        } catch (error) {
        diagnosticsFromError(error, diagnostics);
        error.crmDiagnostics = diagnostics;
        diagnostics.stage = 'request_failed';
        recordCrmEvent('REQUEST_FAILED', diagnostics, { error_code: error.code || 'INTERNAL_SERVER_ERROR' });
         next(error);
       }
      });
    }
    ,
    fastSummary: async (req, res, next) => {
      try {
        const result = await crmService.fastSummary(req.body);
        const safe = stringifySummary(Object.assign({}, result));
        res.status(200).json({ success: true, status: 'ok', ...safe });
      } catch (error) {
        next(error);
      }
    }
    ,
    metadata: async (req, res, next) => {
      try {
        // Return a compact view of live modules and optionally fields for a module
        const module = req.query?.module;
        if (module) {
          const apiName = await crmService.zohoService.resolveModuleApiName(module);
          const fields = await crmService.zohoService.getFieldMetadata(apiName);
          return res.status(200).json({ success: true, status: 'ok', module: module, module_api_name: apiName, fields: fields.fields.slice(0, 200), metadata_sample: fields.metadata.slice(0, 10) });
        }
        const modules = await crmService.zohoService.getModulesMetadata();
        const list = (modules.modules || []).map((m) => ({ api_name: m.api_name, module_name: m.module_name, plural_label: m.plural_label, viewable: m.viewable, api_supported: m.api_supported }));
        res.status(200).json({ success: true, status: 'ok', modules: list });
      } catch (error) {
        next(error);
      }
    },
    refreshMetadata: async (req, res, next) => {
      try {
        const module = req.body?.module;
        if (module) {
          await crmService.zohoService.refreshMetadata(module);
          return res.status(200).json({ success: true, status: 'ok', module, refreshed: true });
        }
        await crmService.zohoService.refreshMetadata();
        res.status(200).json({ success: true, status: 'ok', refreshed: true });
      } catch (error) {
        next(error);
      }
    }
  };
}

function stringifySummary(obj) {
  try {
    if (!obj || typeof obj !== 'object') return obj;
    if (obj.summary && typeof obj.summary === 'object') {
      obj.summary = JSON.stringify(obj.summary);
    }
    // Also stringify any nested 'metrics' or other complex properties used by connectors
    if (obj.metrics && typeof obj.metrics === 'object') obj.metrics = JSON.stringify(obj.metrics);
    return obj;
  } catch (err) {
    return obj;
  }
}

function resolveFollowUpQuestion(question, previous) {
  const text = String(question || '').trim();
  if (!previous || hasExplicitModuleIntent(text) || extractExplicitModule(text.toLowerCase()) || isClarification(text)) return text;
  if (!isFollowUpQuestion(text)) return text;
  if (/(this year|current year|last year|previous year|next year|this quarter|last quarter|next quarter|this month|current month|last month|previous month|next month|this week|last week|next week|today|yesterday|tomorrow|\b20\d{2}\b|january|february|march|april|may|june|july|august|september|october|november|december)/i.test(text)) {
    const withoutPreviousPeriod = previous.question.replace(/\b(?:today|yesterday|tomorrow|this week|last week|next week|this month|last month|next month|this quarter|last quarter|next quarter|this year|last year|next year)\b/gi, '').replace(/\s+/g, ' ').trim();
    return `${withoutPreviousPeriod} created ${text}`;
  }
  return previous.question;
}

function applyPaginationFollowUp(plannedRequest, originalQuestion, previous) {
  return planContinuationAwareRequest(plannedRequest, originalQuestion, previous);
}

function planContinuationAwareRequest(plannedRequest, originalQuestion, previous) {
  const text = String(originalQuestion || '').trim();
  if (!previous?.canonicalState) return plannedRequest;
  if (!isPaginationContinuation(text) && !isExplicitPageRequest(text)) return plannedRequest;

  const priorRequest = previous.plannedRequest || plannedRequest;
  const previousLimit = Number(previous.canonicalState.pagination.limit) || Number(priorRequest.limit) || 20;
  const requestedLimit = extractPageSize(text) || previousLimit;
  const nextOffset = isExplicitPageRequest(text)
    ? Math.max(0, (extractPageNumber(text) - 1) * requestedLimit)
    : (Number(previous.canonicalState.pagination.offset) || 0) + previousLimit;

  return {
    ...priorRequest,
    limit: requestedLimit,
    offset: nextOffset,
    pagination: { ...(priorRequest.pagination || plannedRequest.pagination || {}), limit: requestedLimit, offset: nextOffset }
  };
}

function isPaginationContinuation(text) {
  return /^(?:proceed|continue|next(?:\s+\d+)?|show me the next \d+|next page)\b/i.test(text);
}

function isExplicitPageRequest(text) {
  return /\bpage\s+\d+\b/i.test(text);
}

function extractPageSize(text) {
  const match = String(text || '').match(/(?:next|show me the next|show me|show|give me)\s+(\d+)\b/i);
  return match ? Math.min(Math.max(Number(match[1]), 1), 200) : null;
}

function extractPageNumber(text) {
  const match = String(text || '').match(/\bpage\s+(\d+)\b/i);
  return match ? Math.min(Math.max(Number(match[1]), 1), 1000) : 1;
}

function buildCanonicalConversationState(question, plannedRequest, result, requestId) {
  const pagination = plannedRequest?.pagination || { limit: plannedRequest?.limit, offset: plannedRequest?.offset };
  const recordIds = Array.isArray(result?.data)
    ? result.data.map((record) => String(record?.id || record?.ID || '')).filter(Boolean)
    : [];
  return {
    request_id: requestId,
    original_question: question,
    domain: plannedRequest?.domain || 'CRM',
    module: plannedRequest?.module || null,
    module_api_name: plannedRequest?.module_api_name || null,
    filters: Array.isArray(plannedRequest?.filters) ? plannedRequest.filters : [],
    sort: normalizeSortForFingerprint(plannedRequest?.sort),
    group_by: plannedRequest?.group_by || null,
    aggregate: plannedRequest?.aggregate || null,
    response_fields: Array.isArray(plannedRequest?.response_fields) ? plannedRequest.response_fields : Array.isArray(plannedRequest?.fields) ? plannedRequest.fields : [],
    pagination: {
      limit: Number(pagination?.limit) || 20,
      offset: Number(pagination?.offset) || 0,
      returned: Number(result?.returned ?? recordIds.length ?? 0),
      more_records: Boolean(result?.more_records ?? result?.pagination?.more_records)
    },
    record_ids: recordIds
  };
}

function normalizeSortForFingerprint(sort) {
  if (!sort) return [];
  const sorts = Array.isArray(sort) ? sort : [sort];
  return sorts.map((item) => ({ field: item.field, order: item.order || item.direction || 'asc' }));
}

function isSameQueryShape(previousState, plannedRequest) {
  if (!previousState || !plannedRequest) return false;
  return stableStringify({
    domain: previousState.domain,
    module: previousState.module,
    module_api_name: previousState.module_api_name,
    filters: previousState.filters,
    sort: previousState.sort,
    group_by: previousState.group_by,
    aggregate: previousState.aggregate,
    response_fields: previousState.response_fields
  }) === stableStringify({
    domain: plannedRequest.domain || 'CRM',
    module: plannedRequest.module || null,
    module_api_name: plannedRequest.module_api_name || null,
    filters: Array.isArray(plannedRequest.filters) ? plannedRequest.filters : [],
    sort: normalizeSortForFingerprint(plannedRequest.sort),
    group_by: plannedRequest.group_by || null,
    aggregate: plannedRequest.aggregate || null,
    response_fields: Array.isArray(plannedRequest.response_fields) ? plannedRequest.response_fields : Array.isArray(plannedRequest.fields) ? plannedRequest.fields : []
  });
}

function isDuplicatePage(previousState, currentState) {
  return previousState.pagination.offset !== currentState.pagination.offset
    && previousState.pagination.limit === currentState.pagination.limit
    && stableStringify(previousState.record_ids) === stableStringify(currentState.record_ids)
    && previousState.record_ids.length > 0;
}

function stableStringify(value) {
  return JSON.stringify(value, (_key, innerValue) => {
    if (!innerValue || typeof innerValue !== 'object' || Array.isArray(innerValue)) return innerValue;
    return Object.keys(innerValue).sort().reduce((acc, key) => {
      acc[key] = innerValue[key];
      return acc;
    }, {});
  });
}

function hasExplicitModuleIntent(text) {
  return Object.keys(CRM_API_NAMES).some((module) => {
    const words = module.toLowerCase().split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`\\b${words.join('\\s+')}\\b`, 'i').test(text);
  }) || /\b(?:meeting|meetings|event|events|call|calls|task|tasks|product|products)\b/i.test(text);
}

function isClarification(text) {
  return /^(?:i\s+mean|i\s+meant|actually|no,?\s+i\s+mean|not\s+leads?,?\s+deals?|give me\s+deals?\s+instead)\b/i.test(text);
}

function isFollowUpQuestion(text) {
  return /^(?:give me|show me|what about|how about|only|just|and|also|now|for)\b/i.test(text)
    && !/(lead|deal|account|contact|crm|amount|revenue|pipeline|owner|source)/i.test(text);
}

function isDashboardRequest(question) {
  return /(dashboard|visuali[sz]e|kpi|charts?|management report|analytics dashboard|performance dashboard)/i.test(question);
}

function isTodayActivityQuestion(lowerText) {
  if (/\b(?:meeting|meetings|event|events|call|calls|task|tasks)\b/.test(lowerText)
    && !/(activity|activities|logs?|audit)/.test(lowerText)) return false;
  return /(today'?s activity|today activity|activity for today|what happened today|today's meetings|today meetings|today's logs|today logs|audit logs?|audit trail|daily activity|daily logs?)/.test(lowerText)
    || (/\b(?:today|toda)\b/.test(lowerText) && /(activity|activities|meeting|meetings|event|events|call|calls|task|tasks|log|logs|audit)/.test(lowerText));
}

function buildDashboardSpecification(question, result) {
  const module = result?.module || 'CRM';

  if (result?.analysis === 'sales_performance') {
    const totals = result.totals || {};
    const year = result.year || new Date().getFullYear();
    return `${year} sales performance: ${totals.leads || 0} leads, ${totals.converted_leads || 0} converted leads, ${totals.accounts || 0} accounts, ${totals.contacts || 0} contacts, and ${totals.deals || 0} deals. Lead conversion rate: ${formatPercent(result.lead_conversion_rate)}. Deal Closed Won rate: ${formatPercent(result.comparison?.deal_closed_won_rate)}.`;
  }
  const sourceBreakdown = Array.isArray(result?.source_breakdown) ? result.source_breakdown : [];
  const rows = Array.isArray(result?.data) ? result.data : [];
  const isLeadSourceReport = result?.analysis === 'lead_source_report';
  const isGroupedResult = result?.request_type === 'aggregate' && rows.length > 0;
  const filters = extractDashboardFilters(result);
  const dashboard = {
    dashboard: {
      title: isLeadSourceReport ? 'Lead Source Performance Dashboard' : `${module} Performance Dashboard`,
      description: String(question).trim(),
      type: isLeadSourceReport ? 'lead_source' : isGroupedResult ? 'performance' : 'crm_records',
      kpis: buildDashboardKpis(result, sourceBreakdown, rows),
      charts: buildDashboardCharts(result, sourceBreakdown, rows),
      tables: buildDashboardTables(result, sourceBreakdown, rows),
      filters,
      insights: buildDashboardInsights(result, sourceBreakdown, rows),
      layout: buildDashboardLayout(result, sourceBreakdown, rows)
    }
  };
  return dashboard;
}

function buildDashboardKpis(result, sourceBreakdown, rows) {
  const kpis = [];
  if (Number.isFinite(Number(result?.total))) kpis.push({ title: 'Total Records', value: String(result.total), unit: 'records', comparison: '', trend: '', description: 'Verified records in the requested population.' });
  if (Number.isFinite(Number(result?.count)) && !Number.isFinite(Number(result?.total))) kpis.push({ title: 'Total Records', value: String(result.count), unit: 'records', comparison: '', trend: '', description: 'Verified CRM result count.' });
  if (sourceBreakdown.length > 0) kpis.push({ title: 'Top Source', value: String(result.top_source || sourceBreakdown[0].source), unit: 'lead source', comparison: '', trend: '', description: 'Highest-volume source in the selected population.' });
  if (rows.length > 0 && rows.every((row) => Number.isFinite(Number(row.value)))) {
    kpis.push({ title: 'Total Value', value: formatAmount(rows.reduce((total, row) => total + Number(row.value || 0), 0)), unit: 'currency', comparison: '', trend: '', description: 'Sum of the supplied grouped CRM values.' });
  }
  return kpis;
}

function buildDashboardCharts(result, sourceBreakdown, rows) {
  if (sourceBreakdown.length > 0) return [{
    title: 'Leads by Source', type: 'horizontal_bar', purpose: 'Compare lead volume and contribution by source.', x_axis: 'Lead Source', y_axis: 'Lead Count',
    series: [{ name: 'Leads', field: 'count' }, { name: 'Percentage', field: 'percentage' }], data: sourceBreakdown, sort: 'count descending', interaction: 'Select a source to inspect its top leads.'
  }];
  if (rows.length > 0) return [{
    title: 'Performance by Group', type: 'horizontal_bar', purpose: 'Compare verified grouped CRM values.', x_axis: 'Group', y_axis: 'Value', series: [{ name: 'Value', field: 'value' }], data: rows, sort: 'value descending', interaction: 'Sort by value.'
  }];
  return [];
}

function buildDashboardTables(result, sourceBreakdown, rows) {
  const tables = [];
  if (sourceBreakdown.length > 0) tables.push({ title: 'Source Breakdown', columns: ['source', 'count', 'percentage'], rows: sourceBreakdown, sort: 'count descending', page_size: 10, searchable: true });
  if (Array.isArray(result?.top_leads) && result.top_leads.length > 0) tables.push({ title: `Top Leads from ${result.top_source || 'highest-volume source'}`, columns: ['name', 'company', 'email', 'lead_status', 'lead_source', 'created_time'], rows: result.top_leads, sort: 'created_time descending', page_size: 5, searchable: true });
  if (sourceBreakdown.length === 0 && rows.length === 0 && Array.isArray(result?.data) && result.data.length === 0) tables.push({ title: 'CRM Records', columns: [], rows: [], sort: '', page_size: 10, searchable: true, empty_state: 'No data available for the selected request.' });
  return tables;
}

function buildDashboardInsights(result, sourceBreakdown, rows) {
  if (sourceBreakdown.length > 0) return [`${sourceBreakdown[0].source} is the highest-volume source with ${sourceBreakdown[0].count} leads (${sourceBreakdown[0].percentage}%).`];
  if (rows.length > 0) return ['The dashboard is based on the verified grouped CRM values returned for this request.'];
  return [];
}

function buildDashboardLayout(result, sourceBreakdown, rows) {
  const layout = [];
  if (buildDashboardKpis(result, sourceBreakdown, rows).length > 0) layout.push({ type: 'kpi_row', components: ['kpis'] });
  if (buildDashboardCharts(result, sourceBreakdown, rows).length > 0) layout.push({ type: 'chart_row', components: ['charts'] });
  if (buildDashboardTables(result, sourceBreakdown, rows).length > 0) layout.push({ type: 'table_row', components: ['tables'] });
  if (buildDashboardInsights(result, sourceBreakdown, rows).length > 0) layout.push({ type: 'insight_row', components: ['insights'] });
  return layout;
}

function extractDashboardFilters(result) {
  const filters = [];
  if (result?.top_source) filters.push({ field: 'Lead Source', value: result.top_source });
  return filters;
}

function planQuestion(question) {
  const text = String(question || '').trim();
  if (!text) {
    const error = new Error('One of question, prompt, or message is required.');
    error.code = 'QUESTION_REQUIRED';
    error.statusCode = 400;
    throw error;
  }

  const lower = text.toLowerCase();
  if (!/\bprice\s+books?\b/.test(lower) && /\b(?:zoho\s+books?|books?|bills?|expenses?|payments?|banking|books?\s+invoices?|books?\s+items?)\b/.test(lower)) {
    throw createAppError('DOMAIN_AMBIGUOUS', 'This backend handles Zoho CRM only. Books resources must use the Books integration.', 400, { requested_domain: 'Books', supported_domain: 'CRM' });
  }
  const detectedModule = extractExplicitModule(lower) || detectModule(lower);
  const comparedModules = extractComparedModules(lower);
  if (comparedModules.length > 1 && !isComprehensiveSalesPerformanceRequest(lower) && /\b(?:compare|versus|vs|difference|higher|lower|more|less)\b/.test(lower)) {
    const period = relativePeriodFromText(lower) || 'this week';
    return {
      module: comparedModules[0],
      complexity: 'MULTI-STEP',
      request_type: 'comparison',
      fields: ['id'],
      filters: [],
      aggregate: { operation: 'count', field: 'id' },
      comparison: { multi_module: comparedModules.map((module) => ({ module, date_field_role: dateFieldRoleForQuestion(lower, module) })), operation: 'count', period },
      date_range: { current: resolveRelativePeriod(period) },
      limit: extractRecordLimit(lower),
      offset: 0
    };
  }
  if (/\b(?:bulk read|bulk|export|very large|large dataset)\b/.test(lower)) {
    return { module: detectedModule, complexity: 'COMPLEX', request_type: 'bulk_read', fields: defaultFields(detectedModule), fields_source: 'planner_default', filters: [], limit: 200, offset: 0 };
  }
  if (!isComprehensiveSalesPerformanceRequest(lower) && /\b(?:sales performance|sales performance report|sales performance reports)\b/.test(lower)) {
    return {
      module: 'CRM',
      complexity: 'MULTI-STEP',
      request_type: 'analysis',
      analysis: { type: 'sales_performance' },
      fields: ['id'],
      filters: [],
      limit: 20,
      offset: 0
    };
  }
  if (/(?:available|list|show|get)\s+(?:the\s+)?fields?\b|field\s+metadata/.test(lower)
    || /(?:show|list|get)\s+(?:the\s+)?[a-z0-9_, ]+fields?\s+for\b/.test(lower)) {
    return { module: detectedModule, module_name: detectedModule, complexity: 'MODERATE', request_type: 'analysis', analysis: { type: 'metadata_fields' }, fields: ['id'], filters: [], limit: 200, offset: 0 };
  }
  if (/\b(?:show|list|get)\s+(?:all\s+)?(?:crm\s+)?users?\b|\bactive users?\b/.test(lower)) {
    return { module: 'CRM', complexity: 'MODERATE', request_type: 'analysis', analysis: { type: 'users' }, fields: ['id'], filters: [], limit: 200, offset: 0 };
  }
  if (/\b(?:organization|organisation|org)\s+(?:details|information|info)\b/.test(lower)) {
    return { module: 'CRM', complexity: 'MODERATE', request_type: 'analysis', analysis: { type: 'organization' }, fields: ['id'], filters: [], limit: 20, offset: 0 };
  }
  if (/\b(?:audit logs?|audit trail)\b/.test(lower)) {
    return { module: 'CRM', complexity: 'MODERATE', request_type: 'analysis', analysis: { type: 'audit_logs' }, audit: {}, fields: ['id'], filters: [], limit: 200, offset: 0 };
  }
  if (/\b(?:files?|documents?)\b/.test(lower) && /\b(?:show|list|get|read|find)\b/.test(lower)) {
    return { module: 'CRM', complexity: 'MODERATE', request_type: 'analysis', analysis: { type: 'files' }, files: {}, fields: ['id'], filters: [], limit: 200, offset: 0 };
  }
  if (isTodayActivityQuestion(lower)) {
    return {
      module: 'CRM',
      complexity: 'MULTI-STEP',
      request_type: 'analysis',
      analysis: { type: 'today_activity' },
      fields: ['id'],
      filters: [],
      limit: 200,
      offset: 0
    };
  }
  const module = detectedModule;
  const requestedLimit = extractRecordLimit(lower);
  const recordSort = detectRecordSort(lower, module);
  const sortPlan = detectMultiSort(lower, module) || recordSort;
  const filters = [];
  const fieldLabels = extractFieldLabels(lower);
  const searchTerm = extractSearchTerm(text);
  if (searchTerm) {
    return {
      module,
      complexity: 'MODERATE',
      request_type: 'search',
      fields: ['id'],
      filters: [],
      search: { word: searchTerm },
      limit: requestedLimit,
      offset: 0
    };
  }
  const dateFilter = detectDateFilter(lower, module);
  if (dateFilter) filters.push(dateFilter);
  const dateFieldRole = dateFieldRoleForQuestion(lower, module);

  const comparison = detectPeriodComparison(lower);
  if (comparison) {
    const aggregateOperation = detectAggregateOperation(lower) || { operation: 'count', field: 'id' };
    return {
      module,
      complexity: 'MODERATE',
      request_type: 'comparison',
      fields: ['id'],
      filters: filters.filter((filter) => filter.field !== dateFieldForQuestion(lower, module)),
      date_range: { current: resolveRelativePeriod(comparison.current), previous: resolveRelativePeriod(comparison.previous) },
      comparison: { current_period: comparison.current, previous_period: comparison.previous, date_field: dateFieldForQuestion(lower, module), operation: aggregateOperation.operation, field: aggregateOperation.field },
      date_field_role: dateFieldRole,
      aggregate: aggregateOperation,
      limit: requestedLimit,
      offset: 0
    };
  }

  if (isComprehensiveSalesPerformanceRequest(lower)) {
    return {
      module: 'Deals',
      complexity: 'MULTI-STEP',
      request_type: 'analysis',
      analysis: { type: 'sales_performance' },
      fields: ['id'],
      filters: [{ field: 'Created_Time', operator: 'between', value: [`${extractRequestedYear(lower)}-01-01`, `${extractRequestedYear(lower) + 1}-01-01`], exclusive_end: true }],
      limit: 20,
      offset: 0
    };
  }

  if (module === 'Leads' && /lead source/.test(lower) && /(conversion rate|converted)/.test(lower)) {
    return {
      module: 'Leads',
      complexity: 'MULTI-STEP',
      request_type: 'analysis',
      analysis: { type: 'lead_source_conversion_report' },
      fields: ['id', 'Lead_Source', 'Converted__s'],
      filters: [...filters, { field: 'Lead_Source', operator: 'is_not_null' }],
      limit: 20,
      offset: 0
    };
  }

  if (isConversionFunnelQuestion(lower)) {
    return {
      module: 'Leads',
      complexity: 'MULTI-STEP',
      request_type: 'analysis',
      analysis: { type: 'conversion_funnel' },
      fields: ['id'],
      filters,
      limit: 20,
      offset: 0
    };
  }

  if (isLeadConversionQuestion(lower)) {
    return {
      module: 'Leads',
      complexity: 'MULTI-STEP',
      request_type: 'analysis',
      analysis: { type: isLeadToClosedWonQuestion(lower) ? 'lead_closed_won_conversion' : 'lead_conversion' },
      fields: ['id'],
      filters,
      limit: 20,
      offset: 0
    };
  }

  if (module === 'Leads' && isHighestLeadCreationDayQuestion(lower)) {
    return {
      module: 'Leads',
      complexity: 'MODERATE',
      request_type: 'analysis',
      analysis: { type: 'highest_creation_day' },
      fields: ['id', 'Created_Time'],
      filters,
      limit: 200,
      offset: 0
    };
  }

  const ownerName = extractOwnerName(text);
  if (ownerName) filters.push({ field: 'Owner', operator: 'equals', value: ownerName });

  const fieldComparison = extractFieldComparison(lower);
  if (fieldComparison && !filters.some((filter) => filter.field === fieldComparison.field)) filters.push(fieldComparison);
  const amountThreshold = extractAmountThreshold(lower);
  if (amountThreshold && !fieldComparison) filters.push({ field: 'Amount', operator: 'greater_than', value: amountThreshold.value });
  const excludedPicklist = extractExcludedPicklistFilter(lower);
  if (excludedPicklist) filters.push(excludedPicklist);
  const semanticFilter = extractSemanticFilter(lower);
  if (semanticFilter && !excludedPicklist && !fieldComparison && !amountThreshold) filters.push(semanticFilter);

  if (/(closed won|closed-won|won deals|won deal)/.test(lower)) {
    filters.push({ field: 'Stage', operator: 'equals', value: 'Closed Won' });
  }

  if (/(closed lost|closed-lost|lost deals|lost deal)/.test(lower)
    && !/not\s+closed\s+lost|is\s+not\s+closed\s+lost|!=\s*closed\s+lost|not_equals/.test(lower)
    && !filters.some((filter) => filter.field === 'Stage' && (filter.operator === 'not_equals' || filter.operator === 'not_in' || String(filter.value || '').toLowerCase() === 'closed lost')) ) {
    filters.push({ field: 'Stage', operator: 'equals', value: 'Closed Lost' });
  }

  if (/(not converted|unconverted|have not been converted)/.test(lower)) {
    filters.push({ field: 'Converted__s', operator: 'equals', value: false });
  }

  if (/(linkedin|linkedin)/.test(lower) && module === 'Leads') {
    filters.push({ field: 'Lead_Source', operator: 'equals', value: 'LinkedIn' });
  }

  if (module === 'Deals' && /\b(?:count|how many)\b/.test(lower) && /\b(?:list|show|give me)\b/.test(lower)) {
    return {
      module: 'Deals',
      complexity: 'MULTI-STEP',
      request_type: 'analysis',
      analysis: { type: 'count_and_records' },
      fields: defaultFields('Deals'),
      fields_source: 'planner_default',
      filters,
      retrieve_all: /\b(?:all|every|complete|entire)\b/.test(lower),
      limit: extractRecordLimit(lower),
      offset: 0
    };
  }

  if (module === 'Deals' && /(top|highest|best|rank).*(owner|owners|person|persons).*(total deal value|total deal amount|deal value|revenue|amount)/.test(lower)) {
    return {
      module,
      complexity: 'MULTI-STEP',
      request_type: 'analysis',
      analysis: { type: 'owner_performance' },
      ranking: { dimension: 'Owner', metric: 'Amount', operation: 'sum', limit: requestedLimit },
      filters,
      limit: requestedLimit,
      offset: 0
    };
  }

  if (module === 'Deals' && /\b(?:pipeline|pipeline analysis)\b/.test(lower)) {
    return {
      module,
      complexity: 'MODERATE',
      request_type: 'aggregate',
      aggregate: { operation: 'count', field: 'id' },
      group_by: 'Stage',
      group_by_label: 'stage',
      filters,
      limit: requestedLimit,
      offset: 0
    };
  }

  if (module === 'Leads' && (/(percentage|top 5|highest-volume)/.test(lower) || (/lead source/.test(lower) && !/group(?:ed)?\s+by\s+source/.test(lower)))) {
    if (!filters.some((filter) => filter.field === 'Lead_Source' && filter.operator === 'equals')) {
      filters.push({ field: 'Lead_Source', operator: 'is_not_null' });
    }
    return {
      module,
      complexity: 'MULTI-STEP',
      request_type: 'analysis',
      analysis: { type: 'lead_source_report' },
      fields: ['First_Name', 'Last_Name', 'Company', 'Email', 'Lead_Status', 'Lead_Source', 'Created_Time'],
      filters,
      limit: 20,
      offset: 0
    };
  }

  if (module === 'Deals' && /(dashboard|report)/.test(lower) && /(by all persons|by all owners|per owner|by owner|each owner|all persons|all owners)/.test(lower)) {
    return {
      module,
      complexity: 'COMPLEX',
      request_type: 'aggregate',
      aggregate: { operation: 'sum', field: 'Amount' },
      group_by: 'Owner',
      filters,
      limit: 20,
      offset: 0
    };
  }

  if (module === 'Deals' && /(closed won|closed-won)/.test(lower) && /(this month|current month|last month|previous month)/.test(lower)) {
    return {
      module: 'Deals',
      complexity: 'MODERATE',
      request_type: 'analysis',
      analysis: { type: 'closed_won_summary' },
      fields: ['id', 'Amount', 'Closing_Date', 'Stage'],
      filters,
      limit: 1,
      offset: 0
    };
  }

  const groupBy = extractGroupBy(lower);
  if (groupBy && !/(dashboard|report)/.test(lower)) {
    return {
      module,
      complexity: 'MODERATE',
      request_type: 'aggregate',
      aggregate: { operation: 'count', field: 'id' },
      group_by: groupBy.field,
      ...(groupBy.label ? { group_by_label: groupBy.label } : {}),
      date_field_role: dateFieldRole,
      filters,
      limit: requestedLimit,
      offset: 0
    };
  }

  const aggregateOperation = module === 'Leads' ? null : detectAggregateOperation(lower);
  if (aggregateOperation) {
    return {
      module,
      complexity: 'MODERATE',
      request_type: 'aggregate',
      aggregate: { operation: aggregateOperation.operation, field: aggregateOperation.field },
      date_field_role: dateFieldRole,
      filters,
      limit: 20,
      offset: 0
    };
  }

  if (isLeadConversionQuestion(lower)) {
    return {
      module: 'Leads',
      complexity: 'MULTI-STEP',
      request_type: 'analysis',
      analysis: { type: 'lead_conversion' },
      fields: ['id'],
      filters,
      date_field_role: dateFieldRole,
      limit: 20,
      offset: 0
    };
  }

  if (/\b(?:count|how many|number of|total number|many)\b/.test(lower) || /(?:lead|deal)s? created/.test(lower)) {
    return {
      module,
      complexity: 'SIMPLE',
      request_type: 'count',
      fields: ['id'],
      filters,
      limit: 20,
      offset: 0
    };
  }

  if (/(latest|recent|most recent|newest)/.test(lower)) {
    return {
      module,
      request_type: 'records',
      fields: fieldLabels.length > 0 ? ['id'] : defaultFields(module),
      ...(fieldLabels.length > 0 ? {} : { fields_source: 'planner_default' }),
      ...(fieldLabels.length > 0 ? { field_labels: fieldLabels } : {}),
      filters,
      date_field_role: dateFieldRole,
      ...(Array.isArray(sortPlan) ? { sort: sortPlan } : { sort_field: sortPlan.field, sort_order: sortPlan.order }),
      limit: requestedLimit,
      offset: 0
    };
  }

  return {
    module,
    complexity: 'SIMPLE',
    request_type: 'records',
    fields: fieldLabels.length > 0 ? ['id'] : defaultFields(module),
    ...(fieldLabels.length > 0 ? {} : { fields_source: 'planner_default' }),
    ...(fieldLabels.length > 0 ? { field_labels: fieldLabels } : {}),
    filters,
    date_field_role: dateFieldRole,
    ...(Array.isArray(sortPlan) ? { sort: sortPlan } : { sort_field: sortPlan.field, sort_order: sortPlan.order }),
    limit: requestedLimit,
    offset: 0
  };
}

function extractRecordLimit(lowerText) {
  const match = lowerText.match(/(?:first|latest|last|oldest|top|show(?:\s+me)?|give me)\s+(\d+)\b/i);
  if (!match) return 20;
  return Math.min(Math.max(Number(match[1]), 1), 200);
}

function isComprehensiveSalesPerformanceRequest(lowerText) {
  const modules = ['leads', 'converted', 'accounts', 'contacts', 'deals'];
  const metrics = ['lead source', 'owner', 'closed won', 'conversion rate', 'created'];
  const moduleCount = modules.filter((term) => lowerText.includes(term)).length;
  const metricCount = metrics.filter((term) => lowerText.includes(term)).length;
  return moduleCount >= 4 && (metricCount >= 3 || /sales performance|compare|overall/.test(lowerText));
}

function isLeadConversionQuestion(lowerText) {
  return /\b(?:conversion rate|conversion|converted|converted to deals?|became deals?|lead to deal)\b/.test(lowerText)
    && /\b(?:lead|leads)\b/.test(lowerText);
}

function isConversionFunnelQuestion(lowerText) {
  return /\b(?:conversion rate|conversion funnel|funnel conversion)\b/.test(lowerText)
    && /\b(?:lead|leads)\b/.test(lowerText)
    && /\b(?:contact|contacts)\b/.test(lowerText)
    && /\b(?:account|accounts)\b/.test(lowerText)
    && /\b(?:deal|deals)\b/.test(lowerText)
    && /\b(?:closed won|closed-won|won deals?|won deal)\b/.test(lowerText);
}

function isLeadToClosedWonQuestion(lowerText) {
  return /\b(?:closed won|closed-won)\b/.test(lowerText)
    && /\b(?:lead|leads)\b/.test(lowerText);
}

function isHighestLeadCreationDayQuestion(lowerText) {
  return /\bday\b/.test(lowerText)
    && /(highest|most|maximum|max|busiest|top)/.test(lowerText)
    && /\bleads?\b/.test(lowerText)
    && /\bcreated\b/.test(lowerText);
}

function extractRequestedYear(lowerText) {
  const match = lowerText.match(/\b(?:created\s+in\s+|during\s+|for\s+)(20\d{2})\b/);
  return match ? Number(match[1]) : new Date().getFullYear();
}

function detectRecordSort(lowerText, module) {
  if (/(oldest|first created|earliest)/.test(lowerText)) return { field: 'Created_Time', field_role: 'date', order: 'asc' };
  if (/(modified|updated)/.test(lowerText)) return { field: 'Modified_Time', field_role: 'modified', order: 'desc' };
  if (/(highest|largest|maximum|top|most expensive)/.test(lowerText) && /(amount|value|revenue|deal|price|cost)/.test(lowerText)) {
    const label = /price|cost/.test(lowerText) ? 'price' : 'amount';
    return { field: label, field_label: label, field_role: 'numeric', order: 'desc' };
  }
  return { field: defaultSortField(module), field_role: 'date', order: 'desc' };
}

function detectMultiSort(lowerText, module) {
  const match = lowerText.match(/sort(?:ed)?\s+by\s+(.+?)(?=\s+(?:limit|top|offset)\b|[?.!]|$)/i);
  if (!match || !/\b(?:then|and)\b/.test(match[1])) return null;
  const aliases = { amount: 'amount', value: 'amount', 'deal value': 'amount', price: 'price', cost: 'cost', stage: 'stage', 'closing date': 'closing date', 'created time': 'created time', created: 'created', modified: 'modified', updated: 'updated' };
  const fields = match[1].split(/\s+(?:then|and)\s+/i).map((part) => part.trim()).map((part) => {
    const direction = /\b(?:asc|ascending|lowest|oldest|first)\b/i.test(part) ? 'asc' : 'desc';
    const label = part.replace(/\b(?:asc|ascending|desc|descending|highest|lowest|oldest|newest|first|last)\b/gi, '').trim();
    const field = aliases[label] || aliases[label.replace(/\s+/g, ' ')];
    return field ? { field, order: direction } : null;
  }).filter(Boolean);
  return fields.length > 1 ? fields : null;
}

function buildAssistantAnswer(question, result) {
  const text = String(question || '').trim();
  const count = Number(result?.count ?? result?.summary?.leads_created ?? result?.summary?.leads_converted ?? 0);
  const summary = result?.summary || {};
  const module = result?.module || 'CRM';

  if (result?.analysis === 'closed_won_summary') {
    const range = result.filters?.find((filter) => filter.field === 'Closing_Date')?.value || [];
    return `Closed Won Deals for ${range[0] || 'the selected period'} through ${range[1] || 'the selected period'}: ${result.count} deals, ${formatAmount(result.total_amount, result.currency)} total amount, and ${formatAmount(result.average_amount, result.currency)} average deal value.`;
  }

  if (result?.analysis === 'count_and_records') {
    return `I found ${result.count} matching ${module.toLowerCase()} records and retrieved ${result.data?.length || 0} for display.`;
  }

  if (result?.analysis === 'lead_conversion') {
  const metrics = result.metrics || {};

  if (metrics.leads_converted_to_deals === null) {
    return [
      `Lead-to-Deal Conversion Rate`,
      '',
      `Leads Created: ${metrics.leads_created ?? 0}`,
      `Leads Converted: ${metrics.leads_converted ?? 0}`,
      `Leads Converted to Deals: unavailable`,
      '',
      `Conversion rate cannot be calculated reliably because the Lead-to-Deal relationship could not be verified.`
    ].join('\n');
  }

  return [
    `Lead-to-Deal Conversion Rate`,
    '',
    `Leads Created: ${metrics.leads_created ?? 0}`,
    `Leads Converted: ${metrics.leads_converted ?? 0}`,
    `Leads Converted to Deals: ${metrics.leads_converted_to_deals ?? 0}`,
    `Conversion Rate: ${formatPercent(metrics.conversion_rate)}`
  ].join('\n');
}

  if (result?.analysis === 'lead_closed_won_conversion') {
    const metrics = result.metrics || {};
    return `Total Leads: ${metrics.total_leads}. Converted Leads: ${metrics.converted_leads}. Closed Won Deals: ${metrics.closed_won_deals}. Lead Conversion Rate: ${metrics.converted_leads} / ${metrics.total_leads} x 100 = ${formatPercent(metrics.lead_conversion_rate)}. Lead-to-Closed-Won Rate: ${metrics.closed_won_deals} / ${metrics.total_leads} x 100 = ${formatPercent(metrics.lead_to_closed_won_rate)}.`;
  }

  if (result?.analysis === 'highest_creation_day') {
    return result.top_date
      ? `${result.top_date} had the highest number of Leads created: ${result.top_count} (out of ${result.total_leads_checked} Leads checked for the selected period).`
      : `No Leads were created in the selected period.`;
  }

  if (result?.analysis === 'conversion_funnel') {
    const totals = result.totals || {};
    const rates = result.conversion_rates || {};
    return `Conversion funnel: ${totals.leads} leads, ${totals.contacts} contacts, ${totals.accounts} accounts, ${totals.deals} deals, and ${totals.closed_won_deals} Closed Won deals. Lead-to-Contact: ${formatPercent(rates.lead_to_contact)}. Contact-to-Account: ${formatPercent(rates.contact_to_account)}. Account-to-Deal: ${formatPercent(rates.account_to_deal)}. Deal-to-Closed-Won: ${formatPercent(rates.deal_to_closed_won)}.`;
  }

if (result?.analysis === 'today_activity') {
  const summary = result.summary || {};

  if (!result.total_count) {
    return 'No verified CRM activity was recorded in the Audit Log today.';
  }

  return [
    `Today's CRM Activity Report`,
    '',
    `Calls: ${summary.calls || 0}`,
    `Meetings: ${summary.meetings || 0}`,
    `Tasks: ${summary.tasks || 0}`,
    `Total Activities: ${summary.total_activities || 0}`
  ].join('\n');
}

  if (result?.request_type === 'aggregate') {
    const rows = Array.isArray(result.data) ? result.data : [];
    const lines = rows.map((row) => `${row.Owner ?? 'Unassigned'}: ${formatAmount(row.value, row.currency)}`);
    return lines.length > 0
      ? `CRM dashboard for ${module}:\n${lines.join('\n')}\nTotal: ${formatAmount(rows.reduce((total, row) => total + Number(row.value || 0), 0), result.currency)}`
      : `CRM dashboard for ${module}: no matching records were found.`;
  }

  if (result?.request_type === 'analysis' && result?.analysis === 'lead_source_report') {
    const lines = (result.source_breakdown || []).map((row) => `${row.source}: ${row.count} (${row.percentage}%)`);
    const leads = (result.top_leads || []).map((lead, index) => `${index + 1}. ${lead.name} | ${lead.company || 'No company'} | ${lead.email || 'No email'} | ${lead.lead_status || 'No status'} | ${lead.created_time || 'No date'}`);
    return `Lead Source Dashboard\n\n${lines.join('\n')}\n\nTop 5 leads from ${result.top_source || 'the highest-volume source'}:\n${leads.join('\n')}`;
  }

  if (result?.request_type === 'analysis' && result?.analysis === 'lead_source_conversion_report') {
    const lines = (result.source_breakdown || []).map((row) => `${row.source}: ${row.converted} converted of ${row.leads} leads (${row.conversion_rate}%)`);
    return `Lead Source Conversion Report\n\n${lines.join('\n')}`;
  }

  if (result?.request_type === 'analysis' && result?.analysis === 'owner_performance') {
    const lines = (result.owners || []).map((owner, index) => `${index + 1}. ${owner.owner}: ${formatAmount(owner.total_value, owner.currency || result.currency)} total value, ${owner.deals} deals, ${owner.closed_won} Closed Won, ${owner.win_rate == null ? 'not calculable' : `${owner.win_rate}%`} win rate`);
    const overall = result.overall || {};
    return `Owner performance for ${result.year}:\n${lines.join('\n')}\n\nOverall: ${overall.deals} deals, ${overall.closed_won} Closed Won, ${overall.win_rate == null ? 'win rate not calculable' : `${overall.win_rate}% win rate`}.`;
  }

  if (result?.request_type === 'analysis' && summary.conversion_rate != null) {
    const convertedToDeals = summary.leads_converted_to_deals ?? summary.leads_converted ?? 0;
    const createdLeads = summary.leads_created ?? 0;
    const rate = formatPercent(summary.conversion_rate);
    return `CRM summary: the live ${module} dataset shows ${createdLeads} leads created and ${convertedToDeals} converted-to-deal outcomes. Key metric: the conversion rate is ${rate}. Explanation: this was calculated from verified CRM records and reflects the actual relationship between created leads and converted deals in the selected date window.`;
  }

  if (Array.isArray(result?.data) && result.data.length > 0) {
    return `CRM summary: I reviewed the matching ${module} records for "${text}" and found ${result.data.length} relevant entries. Key metric: the result set is the latest matching data from the selected CRM filters. Explanation: the backend retrieved the exact records and kept the relevant fields needed for the question.`;
  }

  if (result?.request_type === 'records' && module === 'Accounts' && Number.isInteger(count) && count > 0) {
    return `CRM summary: I checked the live Accounts records for "${text}" and found ${count} matching account records, but the detailed rows were not returned in this response. Key metric: the module is available and contains records; the current response did not include the record list. Explanation: the backend should keep the request on record retrieval rather than summarizing it as count-only.`;
  }

  if (result?.request_type === 'count' || Number.isInteger(count)) {
    return `CRM summary: I checked the live ${module} records for "${text}" and found ${count} matching ${module.toLowerCase()} records. Key metric: this is the total count for the current filters and date window. Explanation: the result is based on the exact Zoho CRM filters applied in the backend.`;
  }

  return `CRM summary: I reviewed the live ${module} data for "${text}" and did not find any records that match the exact filters applied. Key metric: zero matching results. Explanation: the query was executed using the backend’s CRM filters, and no verified data was returned for that request.`;
}

function formatPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0%';
  return `${numeric.toFixed(2)}%`;
}

function formatAmount(value, currency) {
  const amount = Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (!currency) return amount;
  const symbols = { INR: '₹', USD: '$', EUR: '€', GBP: '£' };
  const symbol = symbols[String(currency).toUpperCase()] || String(currency);
  return `${symbol} ${amount}`;
}

function detectModule(lowerText) {
  const aliases = [
    ['Renewal Accounts', /\brenewal accounts?\b/],
    ['Price Books', /\bprice books?\b/],
    ['Remote Assist', /\bremote assist\b/],
    ['ZohoSign Documents', /\bzohosign documents?\b/],
    ['ZohoSign Recipients', /\bzohosign recipients?\b/],
    ['ZohoSign Document Events', /\bzohosign document events?\b/],
    ['Google Ads', /\bgoogle ads?\b/],
    ['Enterprise leads', /\benterprise leads?\b/],
    ['Service Provider', /\bservice providers?\b/],
    ['Co-operative Banks', /\bco-?operative banks?\b/],
    ['Voice of the Customer', /\bvoice of the customer\b/],
    ['Meetings', /\b(?:meeting|meetings|event|events|appointment|appointments)\b/],
    ['Calls', /\b(?:call|calls)\b/],
    ['Tasks', /\b(?:task|tasks)\b/],
    ['Products', /\b(?:product|products)\b/],
    ['Reports', /\breports?\b/],
    ['Analytics', /\banalytics\b/],
    ['SalesInbox', /\bsales\s*inbox\b/],
    ['Leads', /\b(?:lead|leads)\b/],
    ['Deals', /\b(?:deal|deals)\b/],
    ['Accounts', /\b(?:account|accounts)\b/],
    ['Contacts', /\b(?:contact|contacts)\b/],
    ['Vendors', /\b(?:vendor|vendors)\b/],
    ['Campaigns', /\bcampaigns?\b/],
    ['Cases', /\bcases?\b/],
    ['Solutions', /\bsolutions?\b/],
    ['Documents', /\bdocuments?\b/],
    ['Forecasts', /\bforecasts?\b/],
    ['Visits', /\bvisits?\b/],
    ['Social', /\bsocial\b/],
    ['Users', /\busers?\b/],
    ['Desk', /\bdesk\b/],
    ['My Jobs', /\bmy jobs?\b/],
    ['Messages', /\bmessages?\b/],
    ['Partners', /\bpartners?\b/],
    ['Projects', /\bprojects?\b/],
    ['Zoho Finance', /\bzoho finance\b/]
  ];
  const match = aliases
    .map(([module, pattern]) => ({ module, index: lowerText.search(pattern) }))
    .filter((candidate) => candidate.index >= 0)
    .sort((left, right) => left.index - right.index)[0];
  if (match) return match.module;
  return null;
}

function extractComparedModules(lowerText) {
  const candidates = [
    ['Meetings', /\b(?:meeting|meetings|event|events)\b/],
    ['Calls', /\b(?:call|calls)\b/],
    ['Tasks', /\b(?:task|tasks)\b/],
    ['Products', /\b(?:product|products)\b/],
    ['Leads', /\b(?:lead|leads)\b/],
    ['Contacts', /\b(?:contact|contacts)\b/],
    ['Accounts', /\b(?:account|accounts)\b/],
    ['Deals', /\b(?:deal|deals)\b/],
    ['Quotes', /\b(?:quote|quotes)\b/]
  ];
  return candidates
    .map(([module, pattern]) => ({ module, index: lowerText.search(pattern) }))
    .filter((match) => match.index >= 0)
    .sort((left, right) => left.index - right.index)
    .map((match) => match.module)
    .filter((module, index, modules) => modules.indexOf(module) === index);
}

function extractExplicitModule(lowerText) {
  const modulePatterns = [
    ['Meetings', /\b(?:meeting|meetings|event|events|appointment|appointments)\b/i],
    ['Calls', /\b(?:call|calls)\b/i],
    ['Tasks', /\b(?:task|tasks)\b/i],
    ['Products', /\b(?:product|products)\b/i],
    ['Leads', /\b(?:lead|leads)\b/i],
    ['Contacts', /\b(?:contact|contacts)\b/i],
    ['Accounts', /\b(?:account|accounts)\b/i],
    ['Deals', /\b(?:deal|deals)\b/i],
    ['Vendors', /\b(?:vendor|vendors)\b/i],
    ['Quotes', /\b(?:quote|quotes)\b/i],
    ['Campaigns', /\b(?:campaign|campaigns)\b/i],
    ['Renewal Accounts', /\brenewal accounts?\b/i],
    ['Sales Orders', /\bsales orders?\b/i],
    ['Purchase Orders', /\bpurchase orders?\b/i]
  ];
  const matches = modulePatterns
    .map(([module, pattern]) => ({ module, index: lowerText.search(pattern) }))
    .filter((match) => match.index >= 0)
    .sort((left, right) => left.index - right.index);
  if (matches.length > 0) return matches[0].module;

  const match = lowerText.match(/\b(?:module|object|records? from)\s+([a-z][a-z0-9 _-]{1,80})/i);
  if (!match) {
    const naturalModule = lowerText.match(/\b(?:show|list|find|get|search)\s+(?:me\s+)?(?:the\s+)?(?:(?:latest|recent|all|first|top)\s+\d*\s*)?([a-z][a-z0-9 _-]{1,80}?)(?=\s+(?:created|updated|where|with|containing|this|last|next|today|yesterday|tomorrow)\b|[?.!]|$)/i);
    return naturalModule ? naturalModule[1].trim() : null;
  }
  const requested = match[1].trim().replace(/\b(?:with|where|today|this|that|records?)\b.*$/i, '').trim();
  if (requested) return Object.keys(CRM_MODULES).find((module) => module.toLowerCase() === requested.toLowerCase()) || requested;
  const naturalModule = lowerText.match(/\b(?:show|list|find|get|search)\s+(?:me\s+)?(?:the\s+)?(?:(?:latest|recent|all|first|top)\s+\d*\s*)?([a-z][a-z0-9 _-]{1,80}?)(?=\s+(?:created|updated|where|with|containing|this|last|next|today|yesterday|tomorrow)\b|[?.!]|$)/i);
  return naturalModule ? naturalModule[1].trim() : null;
}

function assertExplicitModuleRouting(explicitModule, plannedModule) {
  if (!explicitModule || explicitModule === plannedModule) return;
  throw createAppError(
    'CRM_MODULE_ROUTING_ERROR',
    `Explicit CRM module '${explicitModule}' could not be preserved; planner selected '${plannedModule}'.`,
    500,
    { explicit_module: explicitModule, planned_module: plannedModule }
  );
}

function defaultFields(module) {
  if (module === 'Deals') return ['Deal_Name', 'Amount', 'Stage', 'Closing_Date', 'Owner', 'Created_Time'];
  if (module === 'Leads') return ['First_Name', 'Last_Name', 'Company', 'Created_Time', 'Lead_Source', 'Owner'];
  if (module === 'Accounts') return ['Account_Name', 'Industry', 'Owner', 'Created_Time'];
  if (module === 'Contacts') return ['First_Name', 'Last_Name', 'Account_Name', 'Email', 'Owner'];
  if (module === 'Meetings') return ['Event_Title', 'Venue', 'Start_DateTime', 'End_DateTime', 'Owner', 'Participants'];
  if (module === 'Calls') return ['Subject', 'Call_Type', 'Call_Start_Time', 'Call_Result', 'Owner', 'Created_Time'];
  if (module === 'Tasks') return ['Subject', 'Status', 'Priority', 'Due_Date', 'Owner', 'Created_Time'];
  if (module === 'Products') return ['Product_Name', 'Product_Code', 'Unit_Price', 'Created_Time', 'Owner'];
  return ['id'];
}

function defaultSortField(module) {
  if (module === 'Deals') return 'Created_Time';
  if (module === 'Leads') return 'Created_Time';
  if (module === 'Accounts') return 'Created_Time';
  if (module === 'Contacts') return 'Created_Time';
  if (module === 'Meetings') return 'Start_DateTime';
  if (module === 'Calls') return 'Call_Start_Time';
  return 'Created_Time';
}

function extractOwnerName(text) {
  const patterns = [
    /(?:owned by|owner is|assigned to|belongs to)\s+([A-Za-z][A-Za-z .'-]*?)(?=\s+(?:above|below|greater than|less than|more than|for|\.|$))/i,
    /(?:by)\s+([A-Za-z][A-Za-z .'-]*?)(?=\s+(?:above|below|greater than|less than|more than|for|\.|$))/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const value = match[1].trim();
      if (!/^(this|that|these|those|next|latest|month|week|quarter|year|all|all persons|all owners|persons|owners|owner)$/i.test(value)) return value;
    }
  }
  return null;
}

function extractAmountThreshold(lowerText) {
  const match = lowerText.match(/(?:above|greater than|more than|over|at least|min(?:imum)?|>=)\s*₹?\s*([0-9][0-9,]*(?:\.\d+)?)/i);
  if (match) {
    return { field: 'Amount', operator: 'greater_than', value: Number(match[1].replace(/,/g, '')) };
  }
  return null;
}

function extractFieldComparison(lowerText) {
  const fieldPattern = '(amount|deal\\s+value|value|probability|price|unit\\s+price|cost|qty_in_stock)';
  const between = lowerText.match(new RegExp(`\\b${fieldPattern}\\s+(?:is\\s+)?between\\s+₹?\\s*([0-9][0-9,]*(?:\\.\\d+)?)\\s+and\\s+₹?\\s*([0-9][0-9,]*(?:\\.\\d+)?)`, 'i'));
  if (between) {
    const fieldAliases = { amount: 'amount', 'deal value': 'amount', value: 'amount', probability: 'probability', price: 'price', 'unit price': 'price', cost: 'cost', qty_in_stock: 'qty_in_stock' };
    const semanticField = fieldAliases[between[1].replace(/\\s+/g, ' ').toLowerCase()];
    return semanticField ? { field: semanticField, operator: 'between', value: [Number(between[2].replace(/,/g, '')), Number(between[3].replace(/,/g, ''))] } : null;
  }
  const symbols = lowerText.match(new RegExp(`${fieldPattern}\\s*(>=|<=|!=|=|>|<)\\s*₹?\\s*([0-9][0-9,]*(?:\\.\\d+)?)`, 'i'));
  const words = lowerText.match(new RegExp(`\\b${fieldPattern}\\s+(greater than|more than|at least|less than|at most|equal to|not equal to)\\s*₹?\\s*([0-9][0-9,]*(?:\\.\\d+)?)`, 'i'));
  const match = symbols || words;
  if (!match) return null;
  const operatorMap = { '>': 'greater_than', '>=': 'greater_equal', '<': 'less_than', '<=': 'less_equal', '=': 'equals', '!=': 'not_equals', 'greater than': 'greater_than', 'more than': 'greater_than', 'at least': 'greater_equal', 'less than': 'less_than', 'at most': 'less_equal', 'equal to': 'equals', 'not equal to': 'not_equals' };
  const fieldAliases = {
    amount: 'amount',
    'deal value': 'amount',
    value: 'amount',
    probability: 'probability',
    price: 'price',
    'unit price': 'price',
    cost: 'cost',
    qty_in_stock: 'qty_in_stock'
  };
  const field = fieldAliases[match[1].replace(/\s+/g, ' ').toLowerCase()];
  return field ? { field, operator: operatorMap[match[2].toLowerCase()], value: Number(match[3].replace(/,/g, '')) } : null;
}

function extractSemanticFilter(lowerText) {
  const match = lowerText.match(/(?:where|with)\s+([a-z][a-z0-9 _-]*?)\s+(is\s+not\s+equal\s+to|not\s+equal\s+to|is\s+not|is|equals?|contains|starts\s+with|=)\s+([^?.!,]+?)(?=\s+(?:and|created|updated|sorted|ordered|show|list|limit|where)\b|[?.!,]|$)/i);
  if (!match) return null;
  const operatorText = match[2].toLowerCase().replace(/\s+/g, ' ').trim();
  const operators = {
    is: 'equals',
    equal: 'equals',
    equals: 'equals',
    '=': 'equals',
    'is not': 'not_equals',
    'not equal to': 'not_equals',
    'is not equal to': 'not_equals',
    contains: 'contains',
    'starts with': 'starts_with'
  };
  const fieldName = match[1].trim().toLowerCase();
  const directFieldMap = { stage: 'Stage', 'the stage': 'Stage', 'deal stage': 'Stage', 'sales stage': 'Stage', status: 'Stage', 'lead status': 'Lead_Status' };
  const value = match[3].trim();
  const field = directFieldMap[fieldName];
  if (!field) {
    const fieldLabel = match[1].trim();
    const normalizedValue = /^(?:stage|status)$/i.test(fieldLabel) ? value.replace(/^\s*['"]|['"]\s*$/g, '').replace(/\s+/g, ' ').trim() : value.trim();
    return value ? { field: '__field__', field_label: fieldLabel, operator: operators[operatorText] || 'equals', value: normalizedValue } : null;
  }
  const normalizedValue = field === 'Stage' ? value.replace(/^\s*['"]|['"]\s*$/g, '').replace(/\s+/g, ' ').trim() : value.trim();
  return value ? { field, operator: operators[operatorText] || 'equals', value: normalizedValue } : null;
}

function extractExcludedPicklistFilter(lowerText) {
  const match = lowerText.match(/(?:exclude|excluding|not\s+in)\s+(?:the\s+)?(stage|status)\s+(?:values?\s+)?(.+?)(?=\s+(?:sort|created|updated|limit)\b|[?.!]|$)/i);
  if (!match) return null;
  const values = match[2].split(/\s*(?:,|\bor\b)\s*/i).map((value) => value.replace(/^and\s+/i, '').trim()).filter(Boolean);
  return values.length > 0 ? { field: match[1].toLowerCase() === 'stage' ? 'Stage' : 'Status', operator: 'not_in', value: values } : null;
}

function extractFieldLabels(lowerText) {
  const match = lowerText.match(/\bwith\s+(.+?)(?=\s+(?:fields?|where|for|created|sorted|ordered|limit|top)\b|[?.!]|$)/i);
  if (!match) return [];
  return match[1].split(/\s*(?:,|\band\b)\s*/i).map((value) => value.trim()).filter(Boolean);
}

function extractSearchTerm(text) {
  const match = text.match(/\b(?:named|called|matching)\s+["']?([^"']+?)["']?(?:\s+in\s+(?:leads?|contacts?|accounts?|deals?))?\s*$/i)
    || text.match(/\b(?:search(?:\s+for)?|find)\s+(?:(?:a|an|the)\s+)?(?:(?:lead|contact|account|deal|customer|product|item)s?\s+)?(?:(?:named|called|matching|containing|with|for)\s+)?["']?([^"']+?)["']?\s*$/i);
  if (!match) return null;
  const value = match[1].trim().replace(/[?.!]$/, '');
  return value.length >= 2 ? value : null;
}

function detectDateFilter(lowerText, module) {
  const currentDate = new Date();
  const dateField = dateFieldForQuestion(lowerText, module);

  if (/(today)/.test(lowerText)) {
    return calendarFilter(dateField, dayRange(currentDate));
  }

  if (/(yesterday)/.test(lowerText)) {
    const yesterday = new Date(currentDate);
    yesterday.setDate(currentDate.getDate() - 1);
    return calendarFilter(dateField, dayRange(yesterday));
  }

  if (/(tomorrow)/.test(lowerText)) {
    const tomorrow = new Date(currentDate);
    tomorrow.setDate(currentDate.getDate() + 1);
    return calendarFilter(dateField, dayRange(tomorrow));
  }

  if (/(this month|current month)/.test(lowerText)) {
    return calendarFilter(dateField, monthRange(currentDate, 0));
  }

  if (/(last month|previous month)/.test(lowerText)) {
    return calendarFilter(dateField, monthRange(currentDate, -1));
  }

  if (/(next month)/.test(lowerText)) return calendarFilter(dateField, monthRange(currentDate, 1));

  if (/(this week|current week)/.test(lowerText)) {
    return calendarFilter(dateField, weekRange(currentDate, 0));
  }

  if (/(last week|previous week)/.test(lowerText)) {
    return calendarFilter(dateField, weekRange(currentDate, -1));
  }

  if (/(next week)/.test(lowerText)) return calendarFilter(dateField, weekRange(currentDate, 1));

  if (/(this quarter|current quarter)/.test(lowerText)) {
    return calendarFilter(dateField, quarterRange(currentDate, 0));
  }

  if (/(last quarter|previous quarter)/.test(lowerText)) {
    return calendarFilter(dateField, quarterRange(currentDate, -1));
  }

  if (/(next quarter)/.test(lowerText)) return calendarFilter(dateField, quarterRange(currentDate, 1));

  if (/(this year|current year)/.test(lowerText)) {
    const start = new Date(currentDate.getFullYear(), 0, 1);
    const end = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate());
    return calendarFilter(dateField, [toIsoDate(start), toIsoDate(end)]);
  }

  if (/(last year|previous year)/.test(lowerText)) {
    const start = new Date(currentDate.getFullYear() - 1, 0, 1);
    const end = new Date(currentDate.getFullYear() - 1, 11, 31);
    return calendarFilter(dateField, [toIsoDate(start), toIsoDate(end)]);
  }

  if (/(next year)/.test(lowerText)) {
    const start = new Date(currentDate.getFullYear() + 1, 0, 1);
    const end = new Date(currentDate.getFullYear() + 1, 11, 31);
    return calendarFilter(dateField, [toIsoDate(start), toIsoDate(end)]);
  }

  const yearMatch = lowerText.match(/\b(?:created\s+in\s+|during\s+|for\s+)(20\d{2})\b/);
  if (yearMatch) {
    const year = Number(yearMatch[1]);
    return calendarFilter(dateField, [`${year}-01-01`, `${year}-12-31`]);
  }

  const exactRange = lowerText.match(/between\s+(\d{4}-\d{2}-\d{2})\s+and\s+(\d{4}-\d{2}-\d{2})/i);
  if (exactRange) {
    return calendarFilter(dateField, [exactRange[1], exactRange[2]]);
  }

  const openRange = lowerText.match(/\b(before|after|since|until)\s+(\d{4}-\d{2}-\d{2})\b/i);
  if (openRange) {
    const operator = { before: 'less_than', until: 'less_equal', after: 'greater_than', since: 'greater_equal' }[openRange[1].toLowerCase()];
    return { field: dateField, operator, value: openRange[2] };
  }

  const namedRange = lowerText.match(/between\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})\s+and\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})/i);
  if (namedRange) {
    const start = new Date(`${namedRange[1]} ${namedRange[2]}, ${namedRange[3]}`);
    const end = new Date(`${namedRange[4]} ${namedRange[5]}, ${namedRange[6]}`);
    return calendarFilter(dateField, [toIsoDate(start), toIsoDate(end)]);
  }

  if (lowerText.includes('created this month') || lowerText.includes('created in this month')) {
    return calendarFilter('Created_Time', monthRange(currentDate, 0));
  }

  if (/(created|date)\s+(this month|last month|this quarter|last quarter)/.test(lowerText)) {
    return calendarFilter('Created_Time', monthRange(currentDate, /last month|previous month/.test(lowerText) ? -1 : 0));
  }

  return null;
}

function detectPeriodComparison(lowerText) {
  const periods = [...lowerText.matchAll(/\b(today|yesterday|tomorrow|this week|last week|next week|this month|last month|next month|this quarter|last quarter|next quarter|this year|last year|next year)\b/g)].map((match) => match[1]);
  if (periods.length >= 2 && /\b(?:vs|versus|compared? with|than|against)\b/.test(lowerText)) return { current: periods[0], previous: periods[1] };
  if (/(increase|decrease|more|less|compare)/.test(lowerText) && periods.length >= 2) return { current: periods[0], previous: periods[1] };
  return null;
}

function dateFieldForQuestion(lowerText, module) {
  if (module === 'Meetings') {
    if (/(created|creation|new|added|entered)/.test(lowerText)) return 'Created_Time';
    return 'Start_DateTime';
  }
  if (module === 'Tasks') {
    if (/(due|deadline)/.test(lowerText)) return 'Due_Date';
    return 'Created_Time';
  }
  if (module === 'Calls') {
    if (/(created|creation|new|added|entered)/.test(lowerText)) return 'Created_Time';
    return 'Call_Start_Time';
  }
  if (module !== 'Deals') return 'Created_Time';
  const closeDatePhrase = /(closing\s+date|close\s+date|closed\s+date|deal\s+close|deal close)/i;
  if (/(created|creation|new|added|entered|today|yesterday|tomorrow|this week|last week|next week|this month|last month|next month|this quarter|last quarter|next quarter|this year|last year|next year)/.test(lowerText)
    && !closeDatePhrase.test(lowerText)) return 'Created_Time';
  return 'Closing_Date';
}

function dateFieldRoleForQuestion(lowerText, module) {
  if (module === 'Tasks' && /(due|deadline)/.test(lowerText)) return 'due';
  if (/(due|deadline)/.test(lowerText)) return 'due';
  if (/(modified|updated)/.test(lowerText)) return 'modified';
  if (['Calls', 'Meetings'].includes(module) && !/(created|creation|new|added|entered)/.test(lowerText)) return 'activity';
  const closeDatePhrase = /(closing\s+date|close\s+date|closed\s+date|deal\s+close|deal close)/i;
  if (/(created|creation|new|added|entered|today|yesterday|tomorrow|this week|last week|next week|this month|last month|next month|this quarter|last quarter|next quarter|this year|last year|next year)/.test(lowerText)
    && !closeDatePhrase.test(lowerText)) return 'created';
  if (module === 'Deals') return 'closing';
  if (['Calls', 'Meetings'].includes(module)) return 'activity';
  return 'created';
}

function calendarFilter(field, value) {
  const datetimeFields = new Set(['Created_Time', 'Modified_Time', 'Call_Start_Time', 'Start_DateTime', 'End_DateTime']);
  if (!datetimeFields.has(field)) return { field, operator: 'between', value };
  const exclusiveEnd = new Date(`${value[1]}T00:00:00Z`);
  exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
  return { field, operator: 'between', value: [value[0], exclusiveEnd.toISOString().slice(0, 10)], exclusive_end: true };
}

function dayRange(date) {
  return [toIsoDate(date), toIsoDate(date)];
}

function monthRange(referenceDate, offsetMonths) {
  const start = new Date(referenceDate.getFullYear(), referenceDate.getMonth() + offsetMonths, 1);
  const end = new Date(referenceDate.getFullYear(), referenceDate.getMonth() + offsetMonths + 1, 1);
  end.setDate(end.getDate() - 1);
  return [toIsoDate(start), toIsoDate(end)];
}

function weekRange(referenceDate, offsetWeeks) {
  const start = new Date(referenceDate);
  const day = start.getDay();
  start.setDate(start.getDate() - (day === 0 ? 6 : day - 1) + (offsetWeeks * 7));
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return [toIsoDate(start), toIsoDate(end)];
}

function quarterRange(referenceDate, offsetQuarters) {
  const year = referenceDate.getFullYear();
  const quarterIndex = Math.floor(referenceDate.getMonth() / 3) + offsetQuarters;
  const startMonth = (quarterIndex * 3) % 12;
  const targetYear = year + Math.floor((quarterIndex * 3) / 12);
  const start = new Date(targetYear, startMonth, 1);
  const end = new Date(targetYear, startMonth + 3, 1);
  end.setDate(end.getDate() - 1);
  return [toIsoDate(start), toIsoDate(end)];
}

function toIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function detectAggregateOperation(lowerText) {
  if (/(sort(?:ed)? by|order(?:ed)? by).*?(amount|deal value|revenue|price).*?(highest|lowest|top|largest|smallest)/.test(lowerText)) {
    return null;
  }
  const hasMeasure = /(amount|deal\s+value|revenue|unit\s+price|price|cost|quantity|qty)/.test(lowerText);
  if (!hasMeasure) return null;
  const field = /(unit\s+price|price|cost)/.test(lowerText) ? 'price' : 'amount';
  if (/(average|avg)/.test(lowerText)) {
    return { operation: 'avg', field };
  }
  if (/(total|sum|combined)/.test(lowerText)) {
    return { operation: 'sum', field };
  }
  if (/(highest|largest|max)/.test(lowerText)) {
    return { operation: 'max', field };
  }
  if (/(lowest|smallest|min)/.test(lowerText)) {
    return { operation: 'min', field };
  }
  return null;
}

function extractGroupBy(lowerText) {
  const match = lowerText.match(/\bgroup(?:ed)?\s+by\s+([a-z][a-z0-9 _-]*?)(?=\s+(?:for|where|this|last|next|today|created)\b|[?.!,]|$)/i);
  if (!match) return null;
  const label = match[1].trim();
  return { field: 'Stage', label };
}

module.exports = { createCrmController, planQuestion };
