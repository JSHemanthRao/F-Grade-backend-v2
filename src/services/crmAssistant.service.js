const { createAppError } = require('../utils/errors');
const { createQueryIdentity } = require('../query/pagination');
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
    const continuationDetected = this.paginationManager.isContinuation(question);
    if (continuationDetected && !conversationId) throw createAppError('PAGINATION_CONVERSATION_REQUIRED', 'A stable conversation_id is required to continue pagination.', 409);
    if (continuationDetected && !previous) throw createAppError('PAGINATION_STATE_NOT_FOUND', 'No previous CRM page is available for this conversation.', 409);
    if (continuationDetected && previous.more_records === false) throw createAppError('PAGINATION_EXHAUSTED', 'No more CRM records are available for this conversation.', 409);

    const resolvedQuestion = this.resolveFollowUpQuestion(question, previous);
    const plannedRequest = continuationDetected
      ? this.paginationManager.planContinuation(question, previous)
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
    const state = this.paginationManager.save(conversationId, plannedRequest, result, diagnostics?.request_id, resolvedQuestion);
    const queryIdentity = createQueryIdentity(plannedRequest);
    if (diagnostics) {
      diagnostics.previous_module = previous?.canonical_plan?.module || null;
      diagnostics.current_module = plannedRequest.module || result.module || null;
      diagnostics.query_identity = queryIdentity;
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

module.exports = { CrmAssistantService };
