const { createAppError } = require('../utils/errors');
const { createQueryIdentity, extractPageSize, isExplicitPageRequest, isPaginationAffirmation, isPaginationDecline } = require('../query/pagination');
const { PaginationManager } = require('../pagination/paginationManager');
const { updateDiagnostics, recordCrmEvent } = require('../utils/crmDiagnostics');
const { createHash } = require('node:crypto');

class CrmAssistantService {
  constructor({
    crmService,
    planner,
    paginationManager = new PaginationManager(),
    resolveFollowUpQuestion,
    extractExplicitModule,
    hasExplicitModuleIntent,
    assertExplicitModuleRouting,
    buildAnswer,
    isDashboardRequest,
    buildDashboardSpecification,
    stringifySummary,
    diagnostics
  }) {
    this.crmService = crmService;
    this.planner = planner;
    this.paginationManager = paginationManager;
    this.resolveFollowUpQuestion = resolveFollowUpQuestion;
    this.extractExplicitModule = extractExplicitModule;
    this.hasExplicitModuleIntent = hasExplicitModuleIntent;
    this.assertExplicitModuleRouting = assertExplicitModuleRouting;
    this.buildAnswer = buildAnswer;
    this.isDashboardRequest = isDashboardRequest;
    this.buildDashboardSpecification = buildDashboardSpecification;
    this.stringifySummary = stringifySummary;
    this.diagnostics = diagnostics;
  }

  async execute({ question, conversationId, continuationToken, diagnostics }) {
    const tokenHash = continuationToken ? createHash('sha256').update(continuationToken).digest('hex') : null;
    updateDiagnostics(diagnostics, { question, conversation_id_present: Boolean(conversationId), conversation_id: conversationId, continuation_token_present: Boolean(continuationToken), continuation_token_hash: tokenHash });
    const tokenState = continuationToken ? await this.paginationManager.getByTokenAsync(continuationToken) : null;
    const previous = tokenState || await this.paginationManager.getConversationStateAsync(conversationId);
    const continuationRequested = this.paginationManager.isContinuation(question) || Boolean(previous && isPaginationAffirmation(question));
    const continuationDetected = Boolean(tokenState) || Boolean(previous && continuationRequested);
    if (continuationRequested && !previous) {
      throw createAppError('PAGINATION_STATE_NOT_FOUND', 'No previous CRM page is available. Pass the continuation_token from the previous CRM response.', 409);
    }
    if (previous && isPaginationDecline(question)) return paginationTerminalResponse(previous, conversationId, question, 'Pagination stopped.');
    const detailsFollowUp = !continuationDetected && isDetailsFollowUp(question, previous);
    if (continuationDetected && previous && previous.more_records === false) return paginationTerminalResponse(previous, conversationId, question, 'No more CRM records are available.');

    const resolvedQuestion = this.resolveFollowUpQuestion(question, previous);
    const plannedRequest = continuationDetected
      ? isExplicitPageRequest(question)
        ? this.paginationManager.planContinuation(question, previous)
        : buildContinuationPlan(previous, this.paginationManager.advance(previous, extractPageSize(question)))
      : detailsFollowUp
        ? convertToDetailPlan(previous.canonical_plan)
      : this.planner(resolvedQuestion);
    updateDiagnostics(diagnostics, {
      continuation_detected: continuationDetected,
      previous_state_found: Boolean(previous),
      previous_module: previous?.canonical_plan?.module || null,
      previous_offset: previous?.pagination?.offset ?? null,
      previous_returned: previous?.pagination?.returned ?? null,
      resolved_module: plannedRequest.module || null,
      resolved_fields: Array.isArray(plannedRequest.fields) ? plannedRequest.fields : [],
      resolved_filters: Array.isArray(plannedRequest.filters) ? plannedRequest.filters : [],
      request_type: plannedRequest.request_type || plannedRequest.intent || 'records',
      new_offset: plannedRequest.offset ?? plannedRequest.pagination?.offset ?? 0,
      stage: 'query_planned'
    });
    const isAuditLogPlan = plannedRequest.intent === 'audit_log' || plannedRequest.request_type === 'audit_log';
    const isTodayActivityPlan = plannedRequest.module === 'CRM' && plannedRequest.analysis?.type === 'today_activity';
    const explicitModule = isAuditLogPlan || isTodayActivityPlan
      ? null
      : continuationDetected && previous && !this.hasExplicitModuleIntent(question)
      ? null
      : this.extractExplicitModule(resolvedQuestion.toLowerCase());
    this.assertExplicitModuleRouting(explicitModule, plannedRequest.module);

    const result = await this.crmService.query(plannedRequest, undefined, diagnostics);
    const statePlan = mergeResolvedPlan(plannedRequest, result);
    const state = await this.paginationManager.saveAsync(conversationId, statePlan, result, diagnostics?.request_id, resolvedQuestion, continuationDetected ? previous : null);
    const queryIdentity = createQueryIdentity(statePlan);
    recordCrmEvent('PAGINATION_STATE', diagnostics, {
      conversation_id: conversationId,
      continuation_token_hash: state?.continuation_token ? hashToken(state.continuation_token) : null,
      query_identity: queryIdentity,
      module: plannedRequest.module || result.module || null,
      previous_offset: previous?.pagination?.offset ?? null,
      previous_limit: previous?.pagination?.limit ?? null,
      previous_returned: previous?.pagination?.returned ?? null,
      previous_more_records: previous?.pagination?.more_records ?? null,
      requested_limit: plannedRequest.pagination?.limit ?? plannedRequest.limit ?? null,
      next_offset: state?.pagination?.offset ?? plannedRequest.offset ?? 0,
      next_limit: state?.pagination?.limit ?? plannedRequest.limit ?? null,
      new_returned: state?.pagination?.returned ?? 0,
      new_more_records: state?.pagination?.more_records ?? false
    });
    if (diagnostics) {
      diagnostics.previous_module = previous?.canonical_plan?.module || null;
      diagnostics.current_module = plannedRequest.module || result.module || null;
      diagnostics.query_identity = queryIdentity;
      diagnostics.query_fingerprint = queryIdentity;
      diagnostics.continuation_detected = continuationDetected;
      diagnostics.previous_offset = previous?.pagination?.offset ?? null;
      diagnostics.previous_returned = previous?.pagination?.returned ?? null;
      diagnostics.new_offset = state?.pagination?.offset ?? plannedRequest.offset ?? 0;
      updateDiagnostics(diagnostics, {
        resolved_module: result.module || plannedRequest.module,
        module_api_name: result.module_api_name || plannedRequest.module_api_name,
        resolved_fields: result.fields || diagnostics.resolved_fields,
        resolved_filters: result.filters || diagnostics.resolved_filters,
        request_type: result.request_type || diagnostics.request_type,
        zoho_error_code: null,
        zoho_error_message: null,
        stage: 'response_normalized'
      });
    }

    const answer = this.isDashboardRequest(resolvedQuestion)
      ? JSON.stringify(this.buildDashboardSpecification(resolvedQuestion, result), null, 2)
      : this.buildAnswer(resolvedQuestion, result);
    return {
      result: this.stringifySummary(Object.assign({}, result)),
      answer,
      conversation_id: conversationId,
      continuation_token: state?.continuation_token || null,
      question,
      pagination: state?.pagination || null
    };
  }
}

function hashToken(token) {
  return token ? createHash('sha256').update(token).digest('hex') : null;
}

function buildContinuationPlan(previous, pagination) {
  return {
    ...previous.canonical_plan,
    ...pagination,
    pagination: { ...(previous.canonical_plan.pagination || {}), ...pagination }
  };
}

function paginationTerminalResponse(previous, conversationId, question, answer) {
  const pagination = { ...(previous.pagination || {}), more_records: false, returned: 0 };
  return {
    result: {
      module: previous.canonical_plan?.module || null,
      module_api_name: previous.canonical_plan?.module_api_name || null,
      request_type: previous.canonical_plan?.request_type || 'records',
      fields: previous.canonical_plan?.response_fields || previous.canonical_plan?.fields || [],
      filters: previous.canonical_plan?.filters || [],
      data: [],
      records: [],
      count: 0,
      more_records: false,
      pagination
    },
    answer,
    conversation_id: conversationId,
    question,
    pagination
  };
}

function isDetailsFollowUp(question, previous) {
  if (!previous?.canonical_plan) return false;
  const text = String(question || '').trim();
  return /^(?:give|show|list|get)\b/i.test(text)
    && /\b(?:details?|records?|results?|them|their)\b/i.test(text)
    && !/\b(?:today|yesterday|tomorrow|this|last|next|before|after|since|until|between)\b/i.test(text);
}

function convertToDetailPlan(previousPlan) {
  return {
    ...previousPlan,
    intent: 'records',
    request_type: 'records',
    fields: ['id'],
    fields_source: 'planner_default',
    field_labels: undefined,
    aggregate: null,
    group_by: [],
    having_filter: undefined,
    pagination: { ...(previousPlan.pagination || {}), offset: 0 },
    offset: 0
  };
}

function mergeResolvedPlan(plan, result) {
  const resultDateRange = result?.date_range || result?.filters?.find((filter) => filter?.date_range)?.date_range;
  return {
    ...plan,
    module: result?.module || plan.module,
    module_api_name: result?.module_api_name || plan.module_api_name,
    fields: result?.fields || plan.fields,
    response_fields: result?.fields || plan.response_fields,
    filters: result?.filters || plan.filters,
    relationships: result?.relationships || plan.relationships || [],
    sort: result?.sort || plan.sort || null,
    group_by: result?.group_by || plan.group_by || [],
    aggregate: result?.aggregate || plan.aggregate || null,
    analysis: result?.analysis || plan.analysis || null,
    date_range: resultDateRange || plan.date_range || null
  };
}

module.exports = { CrmAssistantService };
