const { createAppError } = require('../utils/errors');
const { createQueryIdentity, isPaginationAffirmation, isPaginationDecline } = require('../query/pagination');
const { PaginationManager } = require('../pagination/paginationManager');
const { updateDiagnostics } = require('../utils/crmDiagnostics');

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

  async execute({ question, conversationId, diagnostics }) {
    updateDiagnostics(diagnostics, { question, conversation_id_present: Boolean(conversationId), conversation_id: conversationId });
    const previous = this.paginationManager.get(conversationId);
    const continuationDetected = this.paginationManager.isContinuation(question) || Boolean(previous && isPaginationAffirmation(question));
    if (previous && isPaginationDecline(question)) return paginationTerminalResponse(previous, conversationId, question, 'Pagination stopped.');
    const detailsFollowUp = !continuationDetected && isDetailsFollowUp(question, previous);
    if (continuationDetected && !conversationId) throw createAppError('PAGINATION_CONVERSATION_REQUIRED', 'A stable conversation_id is required to continue pagination.', 409);
    if (continuationDetected && !previous) throw createAppError('PAGINATION_STATE_NOT_FOUND', 'No previous CRM page is available for this conversation.', 409);
    if (continuationDetected && previous.more_records === false) return paginationTerminalResponse(previous, conversationId, question, 'No more CRM records are available.');

    const resolvedQuestion = this.resolveFollowUpQuestion(question, previous);
    const plannedRequest = continuationDetected
      ? this.paginationManager.planContinuation(question, previous)
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
    const isTodayActivityPlan = plannedRequest.module === 'CRM' && plannedRequest.analysis?.type === 'today_activity';
    const explicitModule = isTodayActivityPlan
      ? null
      : continuationDetected && previous && !this.hasExplicitModuleIntent(question)
      ? null
      : this.extractExplicitModule(resolvedQuestion.toLowerCase());
    this.assertExplicitModuleRouting(explicitModule, plannedRequest.module);

    const result = await this.crmService.query(plannedRequest, undefined, diagnostics);
    const statePlan = mergeResolvedPlan(plannedRequest, result);
    const state = this.paginationManager.save(conversationId, statePlan, result, diagnostics?.request_id, resolvedQuestion);
    const queryIdentity = createQueryIdentity(statePlan);
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
      question,
      pagination: state?.pagination || null
    };
  }
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
