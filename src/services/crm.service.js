const { validateCrmQuery, validateModuleFieldScope, validateAggregateQuery } = require('../validators/crmQuery.validator');
const { ZohoCrmService } = require('./zohoCrm.service');
const { sanitizeZohoRecord } = require('../utils/zohoRecord');
const { CRM_API_NAMES } = require('../constants/crmModules');
const { buildFilterClauses, buildWhereClause } = require('./coql.service');
const { createAppError } = require('../utils/errors');
const { log } = require('../utils/logger');
const { randomUUID } = require('node:crypto');
const { env } = require('../config/env');
const { resolveRelativePeriod } = require('../utils/relativeDate');
const { getCurrentCrmDiagnostics, recordCrmEvent, runWithCrmDiagnostics, updateDiagnostics } = require('../utils/crmDiagnostics');
const { createCanonicalPlan } = require('../query/canonicalPlan');
const { materializeMetadataRequest: materializeMetadataRequestFromLiveMetadata, collectExpressionFields: collectMetadataExpressionFields, isForbiddenInternalFieldName: isForbiddenMetadataFieldName } = require('../metadata/fieldResolver');
const { selectRetrievalStrategy } = require('../query/retrievalStrategy');

class CrmService {
  constructor(zohoService = new ZohoCrmService()) {
    this.zohoService = zohoService;
  }

  async runDiagnostics() {
    const modulesToCheck = ['Meetings', 'Events', 'Leads', 'Deals'];
    const modules = {};
    try {
      const meta = await this.zohoService.getModulesMetadata();
      modules.available = (meta.modules || []).map((m) => ({ api_name: m.api_name, module_name: m.module_name, plural_label: m.plural_label }));
      modules.lookup = {};
      for (const name of modulesToCheck) {
        try {
          const apiName = await this.zohoService.resolveModuleApiName(name);
          const fields = await this.zohoService.getFieldMetadata(apiName);
          modules.lookup[name] = { apiName, fields: fields.fields.slice(0, 50), metadataSample: fields.metadata.slice(0, 5) };
        } catch (err) {
          modules.lookup[name] = { error: err.message, details: err.details || null };
        }
      }
      return modules;
    } catch (err) {
      throw err;
    }
  }

  async query(input, executionContext = createExecutionContext(), diagnostics) {
    const canonicalPlan = createCanonicalPlan(input);
    input = {
      ...input,
      ...canonicalPlan,
      sort: canonicalPlan.sort || undefined,
      sort_field: undefined,
      sort_order: undefined,
      group_by: canonicalPlan.group_by.length === 1 ? canonicalPlan.group_by[0] : (canonicalPlan.group_by.length > 1 ? canonicalPlan.group_by : undefined)
    };
    if (input.original_question && input.module && input.module !== 'CRM' && typeof this.zohoService.resolveModuleReference === 'function') {
      const moduleReference = input.original_question;
      const resolvedModule = await this.zohoService.resolveModuleReference(moduleReference);
      input = {
        ...input,
        module: resolvedModule.semantic_name,
        module_api_name: resolvedModule.api_name,
        primary_entity: {
          ...(input.primary_entity || {}),
          module: resolvedModule.semantic_name,
          module_api_name: resolvedModule.api_name
        },
        module_resolution: {
          reference: moduleReference,
          semantic_name: resolvedModule.semantic_name,
          api_name: resolvedModule.api_name,
          confidence: resolvedModule.confidence,
          match_type: resolvedModule.match_type
        }
      };
    }
    const activeDiagnostics = diagnostics || getCurrentCrmDiagnostics();
    if (diagnostics && getCurrentCrmDiagnostics() !== diagnostics) {
      return runWithCrmDiagnostics(diagnostics, () => this.query(input, executionContext));
    }
    diagnostics = activeDiagnostics;
    if (input?.domain && input.domain !== 'CRM') throw createAppError('DOMAIN_AMBIGUOUS', 'Only the CRM domain is supported by this service.', 400, { requested_domain: input.domain, supported_domain: 'CRM' });
    rejectForbiddenInternalFieldNames(input);
    const executionId = randomUUID();
    const startedAt = Date.now();
    const statsAtStart = { ...(this.zohoService.executionStats || {}) };
    log('info', `[CRM EXECUTION START] executionId=${executionId}`);
    log('info', `[CRM request received] ${JSON.stringify({ module: input?.module, request_type: input?.request_type || 'records', query_type: input?.request_type || 'records', field_count: Array.isArray(input?.fields) ? input.fields.length : 0, filter_count: Array.isArray(input?.filters) ? input.filters.length : 0, date_range: input?.date_range || null })}`);
    updateDiagnostics(diagnostics, {
      crm_service_offset: Number.isInteger(input?.offset) ? input.offset : null
    });
    recordCrmEvent('CRM_SERVICE_INPUT', diagnostics, {
      module: input?.module || null,
      limit: input?.limit ?? null,
      offset: input?.offset ?? null
    });
    let normalizedInput = await this.resolveSemanticFields(input);
    updateDiagnostics(diagnostics, {
      resolved_module: normalizedInput?.module || diagnostics?.resolved_module,
      request_type: normalizedInput?.request_type || diagnostics?.request_type,
      resolved_fields: Array.isArray(normalizedInput?.fields) ? normalizedInput.fields : diagnostics?.resolved_fields,
      resolved_filters: Array.isArray(normalizedInput?.filters) ? normalizedInput.filters : diagnostics?.resolved_filters,
      stage: 'module_resolution'
    });
    recordCrmEvent('MODULE_RESOLVED', diagnostics, { module: diagnostics?.resolved_module, module_api_name: diagnostics?.module_api_name });
    const executionPlan = classifyExecution(normalizedInput);
    log('info', `[CRM execution plan] classification=${executionPlan.classification} steps=${executionPlan.steps.join(' | ')}`);
    rejectForbiddenInternalFieldNames(normalizedInput);
    if (normalizedInput.module !== 'CRM') {
      validateCrmQuery({ ...normalizedInput, metadata_driven: true });
    }
    if (normalizedInput.module !== 'CRM' && typeof this.zohoService.resolveModuleApiName === 'function') {
      recordCrmEvent('MODULE_METADATA_REQUEST', diagnostics, { module: normalizedInput.module });
      normalizedInput = {
        ...normalizedInput,
        metadata_driven: true,
        module_api_name: await this.zohoService.resolveModuleApiName(normalizedInput.module)
      };
      updateDiagnostics(diagnostics, { module_api_name: normalizedInput.module_api_name, stage: 'module_metadata_response' });
      recordCrmEvent('MODULE_METADATA_RESPONSE', diagnostics, { module: normalizedInput.module, module_api_name: normalizedInput.module_api_name });
      normalizedInput = await materializeMetadataRequestFromLiveMetadata(this.zohoService, normalizedInput);
      const normalizedDateRange = normalizedInput.date_range;
      updateDiagnostics(diagnostics, {
        resolved_fields: normalizedInput._resolved_field_diagnostics || diagnostics?.resolved_fields,
        available_metadata_fields: normalizedInput._available_metadata_fields || diagnostics?.available_metadata_fields,
        resolved_filters: Array.isArray(normalizedInput.filters) ? normalizedInput.filters : diagnostics?.resolved_filters,
        resolved_sort: normalizedInput.sort || (normalizedInput.sort_field ? { field: normalizedInput.sort_field, order: normalizedInput.sort_order } : null),
        date_field: normalizedDateRange?.field || normalizedInput.date_field || normalizedInput.filters?.find((filter) => filter.field_role === 'date')?.field || null,
        date_field_type: normalizedDateRange?.field_type || null,
        semantic_date: normalizedDateRange?.semantic || null,
        timezone: normalizedDateRange?.timezone || null,
        date_start: normalizedDateRange?.start || null,
        date_end: normalizedDateRange?.end || null,
        date_end_operator: normalizedDateRange?.end_operator || null,
        stage: 'fields_resolved'
      });
      recordCrmEvent('FIELDS_RESOLVED', diagnostics, { module: normalizedInput.module, module_api_name: normalizedInput.module_api_name, fields: diagnostics?.resolved_fields });
    }
    let request;
    try {
      request = validateCrmQuery({ ...normalizedInput, metadata_driven: true });
    } catch (error) {
      log('warn', `[CRM validation failure] ${JSON.stringify(error.details || { message: error.message })}`);
      throw error;
    }
    if (request.module !== 'CRM' && !request.module_api_name && typeof this.zohoService.resolveModuleApiName === 'function') {
      request.module_api_name = await this.zohoService.resolveModuleApiName(request.module);
    }
    await validateMetadataFields(this.zohoService, request);
    const retrievalStrategy = selectRetrievalStrategy(request);
    updateDiagnostics(diagnostics, {
      resolved_module: request.module,
      module_api_name: request.module_api_name || diagnostics?.module_api_name,
      resolved_fields: normalizedInput._resolved_field_diagnostics || request.fields,
      resolved_filters: request.filters,
      sort_field: request.sort?.field || request.sort_field || null,
      sort_order: request.sort?.order || request.sort_order || null,
      request_type: request.request_type,
      retrieval_strategy: retrievalStrategy,
      stage: 'filters_resolved'
    });
    recordCrmEvent('FILTERS_RESOLVED', diagnostics, { module: request.module, module_api_name: request.module_api_name, retrieval_strategy: retrievalStrategy, filters: request.filters });
    if (typeof this.zohoService.resolveOwnerFilters === 'function') {
      request.filters = await this.zohoService.resolveOwnerFilters(request.filters);
    }
    log('info', `[CRM normalized request] ${JSON.stringify({ module: request.module, module_api_name: request.module_api_name, request_type: request.request_type, query_type: request.request_type, field_count: request.fields.length, filter_count: request.filters.length, date_range: request.date_range || null })}`);
    if (request.request_type === 'comparison') {
      if (normalizedInput.comparison?.multi_module) {
        const result = await this.compareModules(normalizedInput.comparison, normalizedInput.date_range, executionContext);
        this.logExecution(executionId, startedAt, statsAtStart, 'comparison');
        return result;
      }
      const result = await this.compare(request, normalizedInput.comparison || request.comparison, normalizedInput.date_range || request.date_range);
      this.logExecution(executionId, startedAt, statsAtStart, 'comparison');
      return result;
    }
    if (request.request_type === 'count') {
      const result = await this.count(request);
      this.logExecution(executionId, startedAt, statsAtStart, 'count');
      return result;
    }
    if (request.request_type === 'bulk_read') {
      const result = await this.zohoService.bulkRead({ module: request.module, module_api_name: request.module_api_name, fields: request.fields, criteria: buildModuleCriteriaForBulk(request.filters) });
      this.logExecution(executionId, startedAt, statsAtStart, 'bulk_read');
      const data = normalizeBulkResult(result.result);
      return { module: request.module, module_api_name: request.module_api_name || await this.zohoService.resolveModuleApiName(request.module), request_type: 'bulk_read', job_id: result.job_id, status: result.status, download_url: result.download_url, returned: data.length, more_records: false, records: data, data, pagination: { limit: request.limit, offset: request.offset, returned: data.length, more_records: false } };
    }
    if (request.request_type === 'search') {
      const result = await this.search(request, normalizedInput.search || {});
      this.logExecution(executionId, startedAt, statsAtStart, 'search');
      return result;
    }
    if (request.request_type === 'aggregate') {
      const result = await this.aggregate(request, request.aggregate);
      this.logExecution(executionId, startedAt, statsAtStart, 'aggregate');
      return result;
    }
    if (request.request_type === 'analysis') {
      const analysisType = normalizedInput.analysis?.type;
      const activityType = normalizedInput.activity_type || normalizedInput.analysis?.activity_type || null;
      const analysisHandlers = {
        lead_conversion: () => this.leadConversionAnalysis(request),
        highest_creation_day: () => this.highestCreationDayAnalysis(request, executionContext),
        lead_closed_won_conversion: () => this.leadClosedWonConversionAnalysis(request, executionContext),
        conversion_funnel: () => this.conversionFunnelAnalysis(request, executionContext),
        lead_source_report: () => this.leadSourceReport(request, executionContext),
        lead_source_conversion_report: () => this.leadSourceConversionReport(request, executionContext),
        owner_performance: () => this.ownerPerformanceReport(request, executionContext),
        sales_performance: () => this.salesPerformanceAnalysis(request, executionContext),
        today_activity: () => this.todayActivityAnalysis({ ...request, activity_type: activityType }, executionContext),
        closed_won_summary: () => this.closedWonSummary(request, executionContext),
        count_and_records: () => this.countAndRecords(request, normalizedInput.retrieve_all === true, executionContext)
      };
      const handler = analysisHandlers[analysisType];
      if (handler) {
        const result = await handler();
        this.logExecution(executionId, startedAt, statsAtStart, analysisType);
        return result;
      }
    }
    if (request.request_type === 'analysis' && normalizedInput.analysis?.type === 'metadata_fields') {
      const moduleName = await this.zohoService.resolveModuleApiName(normalizedInput.module_name || normalizedInput.module);
      const metadata = await this.zohoService.getFieldMetadata(moduleName);
      this.logExecution(executionId, startedAt, statsAtStart, 'metadata_fields');
      return { module: normalizedInput.module_name || normalizedInput.module, module_api_name: moduleName, request_type: 'metadata', fields: metadata.metadata, data: metadata.metadata, pagination: { limit: request.limit, offset: request.offset, returned: metadata.metadata.length, more_records: false } };
    }
    if (request.request_type === 'analysis' && normalizedInput.analysis?.type === 'users') {
      const users = await this.zohoService.getUsers();
      this.logExecution(executionId, startedAt, statsAtStart, 'users');
      return { module: 'Users', module_api_name: 'users', request_type: 'users', count: users.length, data: users, pagination: { limit: request.limit, offset: request.offset, returned: users.length, more_records: false } };
    }
    if (request.request_type === 'analysis' && normalizedInput.analysis?.type === 'organization') {
      const organization = await this.zohoService.getOrganization();
      this.logExecution(executionId, startedAt, statsAtStart, 'organization');
      return { module: 'Organization', request_type: 'organization', data: Array.isArray(organization) ? organization : [organization], pagination: { limit: request.limit, offset: request.offset, returned: 1, more_records: false } };
    }
    if (request.request_type === 'analysis' && normalizedInput.analysis?.type === 'audit_logs') {
      const result = await this.zohoService.getAuditLogs(normalizedInput.audit || {});
      this.logExecution(executionId, startedAt, statsAtStart, 'audit_logs');
      return { module: 'Audit Logs', request_type: 'audit_logs', count: result.records.length, data: result.records, pagination: { limit: request.limit, offset: request.offset, returned: result.records.length, more_records: Boolean(result.info.more_records) } };
    }
    if (request.request_type === 'analysis' && normalizedInput.analysis?.type === 'files') {
      const result = await this.zohoService.getFiles(normalizedInput.files || {});
      this.logExecution(executionId, startedAt, statsAtStart, 'files');
      return { module: 'Files', request_type: 'files', count: result.files.length, data: result.files, pagination: { limit: request.limit, offset: request.offset, returned: result.files.length, more_records: Boolean(result.info.more_records) } };
    }
    const result = await this.zohoService.query(request);
    const acceptedResponseModules = new Set([request.module_api_name, request.module].filter(Boolean));
    if (result.module_api_name && request.module_api_name && !acceptedResponseModules.has(result.module_api_name)) {
      throw createAppError('MODULE_RESPONSE_MISMATCH', `Zoho returned module '${result.module_api_name}' for requested module '${request.module_api_name}'.`, 502, { requested_module: request.module, requested_module_api_name: request.module_api_name, response_module_api_name: result.module_api_name, stage: 'result_validation' });
    }
    const data = result.records.map(sanitizeZohoRecord).map((record) => projectResponseRecord(record, request.response_fields));
    const info = result.info || {};

    const response = {
      module: request.module,
      module_api_name: result.module_api_name || request.module_api_name || (typeof this.zohoService.resolveModuleApiName === 'function' ? await this.zohoService.resolveModuleApiName(request.module) : request.module),
      request_type: request.request_type,
      fields: request.response_fields || request.fields,
      filters: request.filters,
      ...(request.date_range ? { date_range: request.date_range } : {}),
      count: Number.isInteger(info.count) ? info.count : data.length,
      returned: data.length,
      more_records: Boolean(info.more_records),
      records: data,
      data,
      pagination: {
        limit: request.limit,
        offset: request.offset,
        returned: data.length,
        more_records: Boolean(info.more_records)
      }
    };
    this.logExecution(executionId, startedAt, statsAtStart, request.request_type);
    return response;
  }

  logExecution(executionId, startedAt, statsAtStart, operation) {
    const current = this.zohoService.executionStats || {};
    const delta = (key) => Math.max(0, (current[key] || 0) - (statsAtStart[key] || 0));
    log('info', `[CRM EXECUTION COMPLETE] executionId=${executionId} operation=${operation} durationMs=${Date.now() - startedAt} crmCalls=${delta('calls')} successfulCalls=${delta('successfulCalls')} failedCalls=${delta('failedCalls')} retries=${delta('retries')}`);
  }

  async compare(request, comparison = {}, dateRange = {}) {
    const current = dateRange.current;
    const previous = dateRange.previous;
    if (!current || !previous) throw createAppError('INVALID_CRM_COMPARISON', 'Comparison requests require current and previous date ranges.', 400);
    const dateField = comparison.date_field || 'Created_Time';
    const dateFieldType = comparison.date_field_type || dateRange.current?.field_type || dateRange.previous?.field_type;
    const operation = comparison.operation || request.aggregate?.operation || 'count';
    const aggregate = { operation, field: comparison.field || request.aggregate?.field || 'id' };
    const filtersFor = (period) => [...(request.filters || []), { field: dateField, operator: 'between', value: [period.start, period.end], exclusive_end: true, ...(dateFieldType ? { value_type: dateFieldType } : {}) }];
    const readValue = async (period) => {
      if (operation === 'count') return (await this.count({ ...request, request_type: 'count', filters: filtersFor(period) })).count;
      const result = await this.aggregate({ ...request, request_type: 'aggregate', filters: filtersFor(period) }, aggregate);
      return Number(result.data?.[0]?.value ?? result.summary?.rows?.[0]?.value ?? 0) || 0;
    };
    const [currentValue, previousValue] = await Promise.all([readValue(current), readValue(previous)]);
    const difference = currentValue - previousValue;
    const percentageChange = previousValue === 0 ? (currentValue === 0 ? 0 : null) : Number(((difference / previousValue) * 100).toFixed(2));
    const direction = difference > 0 ? 'increased' : difference < 0 ? 'decreased' : 'unchanged';
    const comparisonResult = { current_period: current.period, previous_period: previous.period, current_value: currentValue, previous_value: previousValue, difference, percentage_change: percentageChange, direction };
    return {
      request_type: 'comparison',
      module: request.module,
      module_api_name: request.module_api_name || await this.zohoService.resolveModuleApiName(request.module),
      fields: request.fields,
      filters: request.filters,
      comparison: comparisonResult,
      comparisons: [comparisonResult],
      date_range: { field: dateField, current, previous }
    };
  }

  async compareModules(comparison, dateRange = {}, executionContext = createExecutionContext()) {
    const period = dateRange.current || resolveComparisonPeriod(comparison.period);
    if (!period) throw createAppError('INVALID_CRM_COMPARISON', 'Multi-module comparisons require a relative date period.', 400);
    const entries = await Promise.all(comparison.multi_module.map(async ({ module, date_field_role }) => {
      const result = await executeCached(executionContext, `multi-module:${module}:${period.start}:${period.end}`, () => this.query({
        module,
        request_type: 'count',
        fields: ['id'],
        filters: [{ field: 'Created_Time', operator: 'between', value: [period.start, period.end], exclusive_end: true }],
        date_field_role,
        limit: 1,
        offset: 0,
        metadata_driven: true
      }, executionContext));
      return { module, module_api_name: result.module_api_name || module, count: Number(result.count || 0) };
    }));
    const comparisonData = Object.fromEntries(entries.map((entry) => [entry.module, entry.count]));
    const values = entries.map((entry) => entry.count);
    const difference = (values[0] || 0) - (values[1] || 0);
    const previous = values[1] || 0;
    const percentageChange = previous === 0 ? (difference === 0 ? 0 : null) : Number(((difference / previous) * 100).toFixed(2));
    const direction = difference > 0 ? 'increased' : difference < 0 ? 'decreased' : 'unchanged';
    const comparisons = entries.map((entry) => ({ module: entry.module, module_api_name: entry.module_api_name, value: entry.count }));
    return {
      request_type: 'comparison',
      module: entries[0]?.module || null,
      module_api_name: entries[0]?.module_api_name || (entries[0] && typeof this.zohoService.resolveModuleApiName === 'function' ? await this.zohoService.resolveModuleApiName(entries[0].module) : null),
      fields: ['id'],
      filters: [],
      comparison: { ...comparisonData, difference, percentage_change: percentageChange, direction, period: period.period },
      comparisons,
      date_range: { current: period },
      returned: 0,
      data: [],
      more_records: false
    };
  }

  async count(request) {
    const moduleApiName = request.module_api_name || request.module;
    const result = await this.zohoService.count(moduleApiName, request.filters);
    return { module: request.module, module_api_name: moduleApiName, request_type: request.request_type, fields: request.fields, filters: request.filters, ...(request.date_range ? { date_range: request.date_range } : {}), count: result.count, returned: 0, more_records: false, records: [], data: [], summary: { operation: 'count', value: result.count }, pagination: { limit: request.limit, offset: request.offset, returned: 0, more_records: false } };
  }

  async search(request, search = {}) {
    const result = await this.zohoService.searchRecords(request.module_api_name || request.module, request.fields, request.filters, Math.floor(request.offset / request.limit) + 1, request.limit, search);
    const data = result.records.map(sanitizeZohoRecord);
    return { module: request.module, module_api_name: result.module_api_name || await this.zohoService.resolveModuleApiName(request.module), request_type: 'search', count: data.length, data, pagination: { limit: request.limit, offset: request.offset, returned: data.length, more_records: Boolean(result.info.more_records) } };
  }

  async resolveSemanticFields(input) {
    if (!Array.isArray(input?.field_labels) || input.field_labels.length === 0 || !input.module || input.module === 'CRM' || typeof this.zohoService.getFieldMetadata === 'function') return input;
    const fields = await this.zohoService.resolveFieldApiNames(input.module, input.field_labels);
    return { ...input, fields, field_labels: undefined };
  }

  async aggregate(request, aggregate) {
    validateAggregateQuery({ module: request.module, fields: request.fields, filters: request.filters, aggregate, groupBy: request.group_by, sort: request.sort, metadataValidated: true });
    const expression = `${aggregate.operation.toUpperCase()}(${aggregate.field})`;
    const moduleApiName = request.module_api_name
      || (typeof this.zohoService.resolveModuleApiName === 'function' ? await this.zohoService.resolveModuleApiName(request.module) : CRM_API_NAMES[request.module]);
    if (!moduleApiName) throw createAppError('MODULE_UNAVAILABLE', `No Zoho API module mapping exists for '${request.module}'.`, 404, { requested_module: request.module, resolved_api_name: null, reason: 'No exact module mapping is available.' });
    const selectQuery = `select ${request.group_by ? `${request.group_by}, ` : ''}${expression} from ${moduleApiName} where ${buildWhereClause(buildFilterClauses(request.filters))}${request.group_by ? ` group by ${request.group_by}` : ''}${request.having_filter ? ` having ${buildWhereClause(buildFilterClauses([request.having_filter]))}` : ''}`;
    const result = await this.zohoService.aggregate(selectQuery);
    const aggregateKey = expression;
    const rows = result.rows.map((row) => ({
      ...row,
      ...(request.group_by ? { [request.group_by]: normalizeGroupValue(row[request.group_by]) } : {}),
      value: row.value ?? row[aggregateKey]
    }));
    log('info', `[CRM aggregate] module=${request.module} operation=${aggregate.operation} field=${aggregate.field} rows=${rows.length}`);
    return {
      module: request.module,
      module_api_name: request.module_api_name || (typeof this.zohoService.resolveModuleApiName === 'function' ? await this.zohoService.resolveModuleApiName(request.module) : request.module),
      fields: request.fields,
      filters: request.filters,
      count: aggregate.operation === 'count' ? Number(rows[0]?.value || 0) : rows.length,
      data: rows,
      summary: { operation: aggregate.operation, field: aggregate.field, rows },
      pagination: { limit: request.limit, offset: request.offset, returned: rows.length, more_records: false }
    };
  }

  async leadSourceReport(request, executionContext = createExecutionContext()) {
    validateAggregateQuery({ module: 'Leads', fields: ['id', 'Lead_Source'], filters: request.filters, aggregate: { operation: 'count', field: 'id' }, groupBy: 'Lead_Source' });
    const whereClause = buildWhereClause(buildFilterClauses(request.filters));
    const groupingQuery = `select Lead_Source, COUNT(id) from ${CRM_API_NAMES.Leads} where ${whereClause} group by Lead_Source`;
    log('info', '[CRM lead source report] executing grouped source count');
    const groupedResult = await executeCached(executionContext, `aggregate:${groupingQuery}`, () => this.zohoService.aggregate(groupingQuery));
    const counts = groupedResult.rows
      .map((row) => ({
        source: row.Lead_Source || row['Lead_Source'] || 'Unknown',
        count: Number(row['COUNT(id)'] ?? row.count ?? row.value ?? 0)
      }))
      .filter((row) => row.count > 0);
    const total = counts.reduce((sum, row) => sum + row.count, 0);
    const sourceBreakdown = counts
      .map((row) => ({ ...row, percentage: total ? Number(((row.count / total) * 100).toFixed(2)) : 0 }))
      .sort((left, right) => right.count - left.count || left.source.localeCompare(right.source));
    const topSource = sourceBreakdown[0]?.source;
    let topLeads = [];
    if (topSource) {
      const topRequest = {
        ...request,
        fields: request.fields,
        filters: [...request.filters, { field: 'Lead_Source', operator: 'equals', value: topSource }],
        limit: 5,
        offset: 0,
        sort: { field: 'Created_Time', order: 'desc' },
        sort_field: 'Created_Time',
        sort_order: 'desc'
      };
      const topResult = await executeCached(executionContext, `query:${JSON.stringify(topRequest)}`, () => this.zohoService.query(topRequest));
      topLeads = topResult.records
      .map((record) => ({
        id: record.id || null,
        name: [record.First_Name, record.Last_Name].filter(Boolean).join(' ') || 'Unnamed lead',
        company: record.Company || null,
        email: record.Email || null,
        lead_status: record.Lead_Status || null,
        lead_source: record.Lead_Source,
        created_time: record.Created_Time || null
      }))
      .filter((lead, index, leads) => !lead.id || leads.findIndex((item) => item.id === lead.id) === index);
    }
    const uniqueIds = new Set(topLeads.map((lead) => lead.id).filter(Boolean));
    const integrityWarnings = [];
    if (topSource && topLeads.some((lead) => lead.lead_source !== topSource)) integrityWarnings.push('Top lead results did not all match the highest-volume source.');
    if (uniqueIds.size !== topLeads.length && topLeads.some((lead) => lead.id)) integrityWarnings.push('Duplicate lead records were removed from the top-lead result.');
    return { module: 'Leads', request_type: 'analysis', analysis: 'lead_source_report', total, source_breakdown: sourceBreakdown, top_source: topSource || null, top_leads: topLeads, warnings: integrityWarnings };
  }

  async leadSourceConversionReport(request, executionContext = createExecutionContext()) {
    const filters = request.filters;
    const convertedFilters = [...filters, { field: 'Converted__s', operator: 'equals', value: true }];
    const buildGroupedQuery = (queryFilters) => `select Lead_Source, COUNT(id) from ${CRM_API_NAMES.Leads} where ${buildWhereClause(buildFilterClauses(queryFilters))} group by Lead_Source`;
    validateAggregateQuery({ module: 'Leads', fields: ['Lead_Source', 'id'], filters, aggregate: { operation: 'count', field: 'id' }, groupBy: 'Lead_Source' });
    validateAggregateQuery({ module: 'Leads', fields: ['Lead_Source', 'id'], filters: convertedFilters, aggregate: { operation: 'count', field: 'id' }, groupBy: 'Lead_Source' });
    const [totalResult, convertedResult] = await Promise.all([
      executeCached(executionContext, `source-total:${JSON.stringify(filters)}`, () => this.zohoService.aggregate(buildGroupedQuery(filters))),
      executeCached(executionContext, `source-converted:${JSON.stringify(convertedFilters)}`, () => this.zohoService.aggregate(buildGroupedQuery(convertedFilters)))
    ]);
    const convertedBySource = new Map(convertedResult.rows.map((row) => [normalizeGroupValue(row.Lead_Source) || 'Unknown', aggregateNumber(row, 'COUNT(id)')]));
    const sourceBreakdown = totalResult.rows.map((row) => {
      const source = normalizeGroupValue(row.Lead_Source) || 'Unknown';
      const leads = aggregateNumber(row, 'COUNT(id)');
      const converted = convertedBySource.get(source) || 0;
      return { source, leads, converted, conversion_rate: leads ? Number(((converted / leads) * 100).toFixed(2)) : 0 };
    }).filter((row) => row.leads >= 10).sort((left, right) => right.conversion_rate - left.conversion_rate || right.leads - left.leads);
    return { module: 'Leads', request_type: 'analysis', analysis: 'lead_source_conversion_report', source_breakdown: sourceBreakdown.slice(0, 3), data: [], pagination: { limit: request.limit, offset: request.offset, returned: sourceBreakdown.length, more_records: false } };
  }

  async ownerPerformanceReport(request, executionContext = createExecutionContext()) {
    validateModuleFieldScope({ module: 'Deals', filters: request.filters, group_by: 'Owner' });
    const year = new Date().getFullYear();
    const yearFilters = [...request.filters, { field: 'Created_Time', operator: 'between', value: [`${year}-01-01`, `${year + 1}-01-01`], exclusive_end: true }];
    const closedWonFilters = [...yearFilters, { field: 'Stage', operator: 'equals', value: 'Closed Won' }];
    const groupQuery = (filters, fields) => `select ${fields} from ${CRM_API_NAMES.Deals} where ${buildWhereClause(buildFilterClauses(filters))} group by Owner`;
    validateAggregateQuery({ module: 'Deals', fields: ['Owner', 'id', 'Amount'], filters: request.filters, aggregate: { operation: 'count', field: 'id' }, groupBy: 'Owner' });
    const [ownerCounts, ownerValues, ownerWon, totalDeals, wonDeals] = await Promise.all([
      executeCached(executionContext, `owner-count:${JSON.stringify(yearFilters)}`, () => this.zohoService.aggregate(groupQuery(yearFilters, 'Owner, COUNT(id)'))),
      executeCached(executionContext, `owner-value:${JSON.stringify(yearFilters)}`, () => this.zohoService.aggregate(groupQuery(yearFilters, 'Owner, SUM(Amount)'))),
      executeCached(executionContext, `owner-won:${JSON.stringify(closedWonFilters)}`, () => this.zohoService.aggregate(groupQuery(closedWonFilters, 'Owner, COUNT(id)'))),
      executeCached(executionContext, `deal-total:${JSON.stringify(yearFilters)}`, () => this.zohoService.aggregate(`select COUNT(id) from ${CRM_API_NAMES.Deals} where ${buildWhereClause(buildFilterClauses(yearFilters))}`)),
      executeCached(executionContext, `deal-won:${JSON.stringify(closedWonFilters)}`, () => this.zohoService.aggregate(`select COUNT(id) from ${CRM_API_NAMES.Deals} where ${buildWhereClause(buildFilterClauses(closedWonFilters))}`))
    ]);
    const wonByOwner = new Map(ownerWon.rows.map((row) => [ownerLabel(row.Owner), aggregateNumber(row, 'COUNT(id)')]));
    const valueByOwner = new Map(ownerValues.rows.map((row) => [ownerLabel(row.Owner), aggregateNumber(row, 'SUM(Amount)')]));
    const owners = ownerCounts.rows.map((row) => {
      const owner = ownerLabel(row.Owner);
      const ownerId = row.Owner && typeof row.Owner === 'object' ? row.Owner.id : row.Owner;
      const deals = aggregateNumber(row, 'COUNT(id)');
      const won = wonByOwner.get(owner) || 0;
      const totalValue = valueByOwner.get(owner) || 0;
      return { owner, owner_id: ownerId ? String(ownerId) : null, deals, total_value: totalValue, average_value: deals ? Number((totalValue / deals).toFixed(2)) : 0, closed_won: won, win_rate: deals ? Number(((won / deals) * 100).toFixed(2)) : null };
    }).sort((left, right) => right.total_value - left.total_value).slice(0, request.ranking?.limit || 20);
    const overallDeals = aggregateNumber(totalDeals.rows[0], 'COUNT(id)');
    const overallWon = aggregateNumber(wonDeals.rows[0], 'COUNT(id)');
    const topOwners = owners.slice(0, 3).filter((owner) => owner.owner_id);
    const topDeals = await Promise.all(topOwners.map((owner) => executeCached(
      executionContext,
      `top-deals:${owner.owner_id}:${year}`,
      () => this.zohoService.query({
        module: 'Deals',
        fields: ['Deal_Name', 'Account_Name', 'Amount', 'Stage', 'Closing_Date'],
        filters: [...yearFilters, { field: 'Owner', operator: 'equals', value: owner.owner_id }],
        sort: { field: 'Amount', order: 'desc' },
        limit: 3,
        offset: 0
      })
    )));
    const topDealsByOwner = new Map(topOwners.map((owner, index) => [owner.owner, (topDeals[index]?.records || []).map(sanitizeZohoRecord)]));
    const ownersWithDeals = owners.map((owner) => ({ ...owner, top_deals: topDealsByOwner.get(owner.owner) || [] }));
    return { module: 'Deals', request_type: 'analysis', analysis: 'owner_performance', year, owners: ownersWithDeals, overall: { deals: overallDeals, closed_won: overallWon, win_rate: overallDeals ? Number(((overallWon / overallDeals) * 100).toFixed(2)) : null } };
  }

  async salesPerformanceAnalysis(request, executionContext = createExecutionContext()) {
    const dateFilter = request.filters.find((filter) => filter.field === 'Created_Time');
    const moduleFilters = (module) => module === 'Deals'
      ? request.filters
      : request.filters.map((filter) => ({ ...filter }));
    const countRequest = (module) => ({ ...request, module, filters: moduleFilters(module), request_type: 'count', fields: ['id'] });
    const leadFilters = moduleFilters('Leads');
    const convertedFilters = [...leadFilters, { field: 'Converted__s', operator: 'equals', value: true }];
    const [leads, convertedLeads, accounts, contacts, deals, leadSources, owners] = await Promise.all([
      executeCached(executionContext, 'sales:leads', () => this.count(countRequest('Leads'))),
      executeCached(executionContext, 'sales:converted-leads', () => this.count({ ...countRequest('Leads'), filters: convertedFilters })),
      executeCached(executionContext, 'sales:accounts', () => this.count(countRequest('Accounts'))),
      executeCached(executionContext, 'sales:contacts', () => this.count(countRequest('Contacts'))),
      executeCached(executionContext, 'sales:deals', () => this.count(countRequest('Deals'))),
      executeCached(executionContext, 'sales:lead-sources', () => this.leadSourceReport({ ...request, module: 'Leads', fields: ['id', 'Lead_Source', 'Converted__s', 'Created_Time'], filters: leadFilters }, executionContext)),
      executeCached(executionContext, 'sales:owners', () => this.ownerPerformanceReport({ ...request, module: 'Deals', filters: moduleFilters('Deals') }, executionContext))
    ]);
    const leadConversionRate = leads.count ? Number(((convertedLeads.count / leads.count) * 100).toFixed(2)) : 0;
    const dealClosedWonRate = owners.overall?.deals ? Number(((owners.overall.closed_won / owners.overall.deals) * 100).toFixed(2)) : 0;
    return {
      module: 'CRM',
      request_type: 'analysis',
      analysis: 'sales_performance',
      year: dateFilter?.value?.[0]?.slice(0, 4) || new Date().getFullYear(),
      totals: { leads: leads.count, converted_leads: convertedLeads.count, accounts: accounts.count, contacts: contacts.count, deals: deals.count },
      lead_conversion_rate: leadConversionRate,
      lead_sources: leadSources.source_breakdown,
      top_lead_sources: leadSources.source_breakdown.filter((source) => source.count >= 10).sort((left, right) => right.percentage - left.percentage).slice(0, 3),
      deal_owners: owners.owners.slice(0, 3),
      top_deal_owners: owners.owners.slice(0, 3),
      comparison: { lead_conversion_rate: leadConversionRate, deal_closed_won_rate: dealClosedWonRate, strongest_lead_source: leadSources.source_breakdown[0]?.source || null, strongest_deal_owner: owners.owners[0]?.owner || null }
    };
  }

async todayActivityAnalysis(request, executionContext = createExecutionContext()) {
  const today = toIsoDate(new Date());
  const activityType = request?.activity_type || request?.analysis?.activity_type || 'ACTIVITY_HISTORY';

  const start = `${today}T00:00:00+05:30`;
  const end = `${today}T23:59:59+05:30`;

  log('info', `[CRM todayActivity] retrieving ${activityType.toLowerCase()} for ${today}`);

  const standardModules = ['Calls', 'Events', 'Tasks'];
  const customModuleSpecs = await discoverActivityModuleSpecs(this.zohoService);
  const allModules = [...new Set([...standardModules, ...customModuleSpecs.map((spec) => spec.module)])];

  if (activityType === 'SCHEDULED_ACTIVITY') {
    const scheduledActivity = await this.zohoService.query({
      module: 'Calls',
      fields: ['id', 'Subject', 'Call_Start_Time'],
      filters: [{ field: 'Call_Start_Time', operator: 'between', value: [start, end] }],
      limit: request.limit || 10,
      offset: request.offset || 0
    });
    const meetingActivity = await this.zohoService.query({
      module: 'Meetings',
      fields: ['id', 'Event_Title', 'Start_DateTime'],
      filters: [{ field: 'Start_DateTime', operator: 'between', value: [start, end] }],
      limit: request.limit || 10,
      offset: request.offset || 0
    });
    const taskActivity = await this.zohoService.query({
      module: 'Tasks',
      fields: ['id', 'Subject', 'Due_Date'],
      filters: [{ field: 'Due_Date', operator: 'between', value: [today, today] }],
      limit: request.limit || 10,
      offset: request.offset || 0
    });

    const rows = [
      ...(Array.isArray(scheduledActivity?.records) ? scheduledActivity.records : []).map((record) => ({ ...record, module: 'Calls' })),
      ...(Array.isArray(meetingActivity?.records) ? meetingActivity.records : []).map((record) => ({ ...record, module: 'Meetings' })),
      ...(Array.isArray(taskActivity?.records) ? taskActivity.records : []).map((record) => ({ ...record, module: 'Tasks' }))
    ];

    return {
      module: 'CRM',
      request_type: 'analysis',
      analysis: 'today_activity',
      activity_type: 'SCHEDULED_ACTIVITY',
      data_source: 'Zoho CRM Schedules',
      date: today,
      total_count: rows.length,
      summary: {
        calls: rows.filter((row) => row.module === 'Calls').length,
        meetings: rows.filter((row) => row.module === 'Meetings').length,
        tasks: rows.filter((row) => row.module === 'Tasks').length,
        total_activities: rows.length
      },
      activity_rows: rows,
      data: rows,
      pagination: {
        limit: request.limit,
        offset: request.offset,
        returned: rows.length,
        more_records: false
      }
    };
  }

  let activityLogs = [];
  if (typeof this.zohoService.getAuditLogs === 'function') {
    const result = await this.zohoService.getAuditLogs({
      date_range: {
        start,
        end
      },
      modules: allModules
    });

    const logs = Array.isArray(result?.records)
      ? result.records
      : [];

    activityLogs = logs.filter((logEntry) => {
      const moduleName =
        logEntry.module?.api_name ||
        logEntry.module?.name ||
        logEntry.module ||
        '';

      return standardModules.includes(String(moduleName));
    });
  }

  const customActivityLogs = [];
  let customActivityTotal = 0;
  for (const spec of customModuleSpecs) {
    try {
      const countResult = await this.zohoService.count(spec.module, [{ field: spec.dateField, operator: 'between', value: [start, end] }]);
      const queryResult = await this.zohoService.query({
        module: spec.module,
        fields: spec.fields || ['id'],
        filters: [{ field: spec.dateField, operator: 'between', value: [start, end] }],
        limit: request.limit || 10,
        offset: request.offset || 0
      });
      const rows = Array.isArray(queryResult?.records) ? queryResult.records : [];
      const mappedRows = rows.map((record) => ({ ...record, module: spec.module }));
      customActivityLogs.push(...mappedRows);
      customActivityTotal += Number(countResult?.count || mappedRows.length || 0);
      if (countResult?.count > 0 && mappedRows.length === 0) {
        customActivityLogs.push({ module: spec.module, count: countResult.count, date_field: spec.dateField, created_at: new Date().toISOString() });
      }
    } catch (_error) {
      continue;
    }
  }

  const allActivityLogs = [...activityLogs, ...customActivityLogs];
  const totalActivityCount = Math.max(allActivityLogs.length, customActivityTotal);

  const summary = {
    calls: 0,
    meetings: 0,
    tasks: 0,
    total_activities: totalActivityCount
  };

  for (const logEntry of activityLogs) {
    const moduleName =
      logEntry.module?.api_name ||
      logEntry.module?.name ||
      logEntry.module ||
      '';

    if (moduleName === 'Calls') summary.calls += 1;
    else if (moduleName === 'Events') summary.meetings += 1;
    else if (moduleName === 'Tasks') summary.tasks += 1;
  }

  return {
    module: 'CRM',
    request_type: 'analysis',
    analysis: 'today_activity',
    activity_type: 'ACTIVITY_HISTORY',
    data_source: 'Zoho CRM Audit Log',
    date: today,
    total_count: totalActivityCount,
    summary,
    activity_rows: allActivityLogs,
    data: allActivityLogs,
    pagination: {
      limit: request.limit,
      offset: request.offset,
      returned: allActivityLogs.length,
      more_records: false
    }
  };
}

  async fastSummary(request, executionContext = createExecutionContext()) {
    const today = toIsoDate(new Date());
    const moduleSpecs = [
      { module: 'Meetings', dateField: 'Start_DateTime' },
      { module: 'Calls', dateField: 'Created_Time' },
      { module: 'Tasks', dateField: 'Due_Date' },
      { module: 'Notes', dateField: 'Created_Time' }
    ];

    const customModuleSpecs = await discoverActivityModuleSpecs(this.zohoService);
    const allModuleSpecs = [...moduleSpecs, ...customModuleSpecs];

    // Parallel count-only requests to minimize latency (no record fetches)
    const counts = await Promise.allSettled(allModuleSpecs.map((spec) => {
      const filters = [{ field: spec.dateField, operator: 'between', value: [today, today] }];
      return this.count({ ...request, module: spec.module, filters, request_type: 'count', fields: ['id'] });
    }));

    const activityRows = allModuleSpecs.map((spec, idx) => {
      const settled = counts[idx];
      if (settled.status === 'fulfilled') {
        return { module: spec.module, count: settled.value.count, latest_record: null, date_field: spec.dateField };
      }
      log('warn', `[CRM fastSummary] module=${spec.module} count failed: ${String(settled.reason?.message || settled.reason)}`);
      return { module: spec.module, count: 0, latest_record: null, date_field: spec.dateField };
    });

    const totalCount = activityRows.reduce((sum, row) => sum + Number(row.count || 0), 0);
    return {
      module: 'CRM',
      request_type: 'analysis',
      analysis: 'today_activity_fast',
      date: today,
      total_count: totalCount,
      activity_rows: activityRows,
      data: activityRows,
      pagination: { limit: request.limit, offset: request.offset, returned: activityRows.length, more_records: false }
    };
  }

  async closedWonSummary(request, executionContext = createExecutionContext()) {
    validateAggregateQuery({
      module: 'Deals',
      fields: ['id', 'Amount'],
      filters: request.filters,
      aggregate: { operation: 'sum', field: 'Amount' }
    });
    const whereClause = buildWhereClause(buildFilterClauses(request.filters));
    const query = `select COUNT(id), SUM(Amount), AVG(Amount) from ${CRM_API_NAMES.Deals} where ${whereClause}`;
    const result = await executeCached(executionContext, `closed-won-summary:${query}`, () => this.zohoService.aggregate(query));
    const row = result.rows[0] || {};
    const count = aggregateNumber(row, 'COUNT(id)');
    const totalAmount = aggregateNumber(row, 'SUM(Amount)');
    const averageAmount = aggregateNumber(row, 'AVG(Amount)');
    const currency = row.currency || row.Currency || null;
    return {
      module: 'Deals',
      request_type: 'analysis',
      analysis: 'closed_won_summary',
      count,
      total_amount: totalAmount,
      average_amount: averageAmount,
      ...(currency ? { currency } : {}),
      filters: request.filters,
      data: [],
      pagination: { limit: request.limit, offset: request.offset, returned: 0, more_records: false }
    };
  }

  async countAndRecords(request, retrieveAll, executionContext = createExecutionContext()) {
    const countResult = await this.count(request);
    const records = [];
    let offset = request.offset;
    let moreRecords = true;
    while (moreRecords) {
      const page = await executeCached(executionContext, `count-records:${JSON.stringify({ ...request, offset })}`, () => this.zohoService.query({ ...request, request_type: 'records', offset, limit: retrieveAll ? 200 : request.limit }));
      records.push(...page.records.map(sanitizeZohoRecord));
      moreRecords = retrieveAll && Boolean(page.info?.more_records);
      offset += retrieveAll ? 200 : request.limit;
    }
    return {
      module: request.module,
      request_type: 'analysis',
      analysis: 'count_and_records',
      count: countResult.count,
      data: records,
      pagination: { limit: request.limit, offset: request.offset, returned: records.length, more_records: false }
    };
  }

  async leadClosedWonConversionAnalysis(request, executionContext = createExecutionContext()) {
    const leadFilters = request.filters.filter((filter) => filter.field !== 'Stage');
    const convertedFilters = [...leadFilters, { field: 'Converted__s', operator: 'equals', value: true }];
    const dealFilters = [
      ...request.filters.filter((filter) => filter.field !== 'Converted__s'),
      { field: 'Stage', operator: 'equals', value: 'Closed Won' }
    ];
    const countRequest = (module, filters) => ({ module, request_type: 'count', fields: ['id'], filters, limit: 1, offset: 0 });
    const [totalLeads, convertedLeads, closedWonDeals] = await Promise.all([
      executeCached(executionContext, `conversion-total-leads:${JSON.stringify(leadFilters)}`, () => this.count(countRequest('Leads', leadFilters))),
      executeCached(executionContext, `conversion-converted-leads:${JSON.stringify(convertedFilters)}`, () => this.count(countRequest('Leads', convertedFilters))),
      executeCached(executionContext, `conversion-closed-won-deals:${JSON.stringify(dealFilters)}`, () => this.count(countRequest('Deals', dealFilters)))
    ]);
    const leadCount = totalLeads.count;
    const convertedCount = convertedLeads.count;
    const closedWonCount = closedWonDeals.count;
    return {
      module: 'CRM',
      request_type: 'analysis',
      analysis: 'lead_closed_won_conversion',
      metrics: {
        total_leads: leadCount,
        converted_leads: convertedCount,
        closed_won_deals: closedWonCount,
        lead_conversion_rate: leadCount ? Number(((convertedCount / leadCount) * 100).toFixed(2)) : 0,
        lead_to_closed_won_rate: leadCount ? Number(((closedWonCount / leadCount) * 100).toFixed(2)) : 0
      },
      formulas: {
        lead_conversion_rate: 'converted_leads / total_leads * 100',
        lead_to_closed_won_rate: 'closed_won_deals / total_leads * 100'
      },
      data: [],
      pagination: { limit: request.limit, offset: request.offset, returned: 0, more_records: false }
    };
  }

  async conversionFunnelAnalysis(request, executionContext = createExecutionContext()) {
    const countRequest = (module, filters = request.filters) => ({ module, request_type: 'count', fields: ['id'], filters, limit: 1, offset: 0 });
    const closedWonFilters = [...request.filters, { field: 'Stage', operator: 'equals', value: 'Closed Won' }];
    const [leads, contacts, accounts, deals, closedWonDeals] = await Promise.all([
      executeCached(executionContext, `funnel:leads:${JSON.stringify(request.filters)}`, () => this.count(countRequest('Leads'))),
      executeCached(executionContext, `funnel:contacts:${JSON.stringify(request.filters)}`, () => this.count(countRequest('Contacts'))),
      executeCached(executionContext, `funnel:accounts:${JSON.stringify(request.filters)}`, () => this.count(countRequest('Accounts'))),
      executeCached(executionContext, `funnel:deals:${JSON.stringify(request.filters)}`, () => this.count(countRequest('Deals'))),
      executeCached(executionContext, `funnel:closed-won-deals:${JSON.stringify(closedWonFilters)}`, () => this.count(countRequest('Deals', closedWonFilters)))
    ]);
    const totals = {
      leads: leads.count,
      contacts: contacts.count,
      accounts: accounts.count,
      deals: deals.count,
      closed_won_deals: closedWonDeals.count
    };
    const percentage = (numerator, denominator) => denominator ? Number(((numerator / denominator) * 100).toFixed(2)) : 0;
    return {
      module: 'CRM',
      request_type: 'analysis',
      analysis: 'conversion_funnel',
      totals,
      conversion_rates: {
        lead_to_contact: percentage(totals.contacts, totals.leads),
        contact_to_account: percentage(totals.accounts, totals.contacts),
        account_to_deal: percentage(totals.deals, totals.accounts),
        deal_to_closed_won: percentage(totals.closed_won_deals, totals.deals)
      },
      data: [],
      pagination: { limit: request.limit, offset: request.offset, returned: 0, more_records: false }
    };
  }

  async highestCreationDayAnalysis(request, executionContext = createExecutionContext()) {
    const records = [];
    let offset = 0;
    let moreRecords = true;
    const pageSize = 200;
    while (moreRecords) {
      const page = await executeCached(executionContext, `highest-creation-day:${JSON.stringify({ filters: request.filters, offset })}`, () => this.zohoService.query({
        ...request,
        module: 'Leads',
        fields: ['id', 'Created_Time'],
        request_type: 'records',
        sort: undefined,
        limit: pageSize,
        offset
      }));
      records.push(...page.records.map(sanitizeZohoRecord));
      moreRecords = Boolean(page.info?.more_records);
      offset += pageSize;
    }
    const countsByDate = new Map();
    for (const record of records) {
      const createdTime = record.Created_Time;
      if (typeof createdTime !== 'string' || createdTime.length < 10) continue;
      const date = createdTime.slice(0, 10);
      countsByDate.set(date, (countsByDate.get(date) || 0) + 1);
    }
    const dateBreakdown = [...countsByDate.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => (b.count - a.count) || a.date.localeCompare(b.date));
    const top = dateBreakdown[0] || null;
    return {
      module: 'Leads',
      request_type: 'analysis',
      analysis: 'highest_creation_day',
      total_leads_checked: records.length,
      top_date: top ? top.date : null,
      top_count: top ? top.count : 0,
      date_breakdown: dateBreakdown,
      data: [],
      pagination: { limit: request.limit, offset: request.offset, returned: records.length, more_records: false }
    };
  }

  async leadConversionAnalysis(request) {
    log('info', '[METRIC QUERY] lead conversion analysis');
    const dateFilter = request.filters.find((filter) => filter.field === 'Created_Time');
    log('info', `[DATE RANGE] ${JSON.stringify(dateFilter?.value || [])}`);
    const metadata = await this.zohoService.getFieldMetadata('Leads');
    const leadFields = new Set(metadata.fields);
    if (!leadFields.has('Converted__s') || !leadFields.has('Converted_Date_Time')) {
      throw createAppError('ZOHO_CONVERSION_FIELDS_UNAVAILABLE', 'Zoho Leads metadata does not expose both Converted__s and Converted_Date_Time; conversion analysis cannot be calculated reliably.', 502);
    }

    const dealMetadata = await this.zohoService.getFieldMetadata('Deals');
    if (!new Set(dealMetadata.fields).has('Lead_Conversion_Time')) {
      throw createAppError('ZOHO_DEAL_RELATIONSHIP_UNAVAILABLE', 'Zoho Deals metadata does not expose Lead_Conversion_Time; converted-to-Deal count cannot be calculated reliably.', 502);
    }

    const created = await this.count(request);
    const conversionDateFilter = dateFilter ? { ...dateFilter, field: 'Converted_Date_Time' } : null;
    const converted = await this.count({
      ...request,
      filters: [
        { field: 'Converted__s', operator: 'equals', value: true },
        ...(conversionDateFilter ? [conversionDateFilter] : [])
      ]
    });
    let dealsCreated = { count: null };
    let dealsPopulationWarning = null;
    try {
      dealsCreated = await this.count({
        ...request,
        module: 'Deals',
        module_api_name: typeof this.zohoService.resolveModuleApiName === 'function'
          ? await this.zohoService.resolveModuleApiName('Deals')
          : undefined,
        filters: request.filters
      });
    } catch (error) {
      if (error.code !== 'ZOHO_COUNT_ERROR') throw error;
      dealsPopulationWarning = error.message;
      log('warn', `[DEALS CREATED COUNT] null (${dealsPopulationWarning})`);
    }
    let convertedToDeals = null;
    let dealsCountWarning = null;
    let comparison = {
      lead_records_checked: 0,
      deal_records_checked: 0,
      matched_lead_deal_records: null,
      relationship_method: 'Unavailable: Deals metadata exposes no direct Lead lookup.'
    };
    try {
      const relationshipResult = await this.compareLeadDealRelationships(request, dateFilter, metadata);
      convertedToDeals = relationshipResult.count;
      comparison = relationshipResult.comparison;
    } catch (error) {
      if (error.code !== 'ZOHO_DEAL_RELATIONSHIP_UNAVAILABLE') throw error;
      dealsCountWarning = error.message;
      log('warn', `[LEADS TO DEALS COUNT] null (${dealsCountWarning})`);
    }
    const leadsCreated = created.count;
    const leadsConverted = converted.count;
    const leadsConvertedToDeals = convertedToDeals ?? null;
    const conversionRate = leadsConvertedToDeals === null
      ? null
      : (leadsCreated ? Number(((leadsConvertedToDeals / leadsCreated) * 100).toFixed(2)) : 0);
    log('info', `[LEADS CREATED COUNT] ${leadsCreated}`);
    log('info', `[LEADS CONVERTED COUNT] ${leadsConverted}`);
    log('info', `[LEADS TO DEALS COUNT] ${leadsConvertedToDeals}`);
    log('info', `[CONVERSION RATE] ${conversionRate}`);
    return {
      success: true,
      module: 'Leads',
      request_type: 'analysis',
      data_source: 'Zoho CRM',
      calculation_basis: 'Leads.Created_Time for created leads; Leads.Converted__s=true and Leads.Converted_Date_Time for converted leads; Deals.Lead_Conversion_Time for converted-to-Deal records.',
      date_range: dateFilter ? { start: dateFilter.value[0], end: dateFilter.value[1] } : {},
      summary: {
        leads_created: leadsCreated,
        leads_converted: leadsConverted,
        deals_created: dealsCreated.count,
        leads_converted_to_deals: leadsConvertedToDeals,
        converted_to_deals: leadsConvertedToDeals,
        conversion_rate: conversionRate
      },
      metrics: { leads_created: leadsCreated, leads_converted: leadsConverted, deals_created: dealsCreated.count, leads_converted_to_deals: leadsConvertedToDeals, conversion_rate: conversionRate },
      calculations: ['conversion_rate = leads_converted_to_deals / leads_created * 100'],
      comparison,
      warnings: [dealsCountWarning || dealsPopulationWarning].filter(Boolean),
      data: [],
      pagination: { limit: request.limit, offset: request.offset, returned: 0, more_records: false }
    };
  }

  async compareLeadDealRelationships(request, dateFilter, leadMetadata) {
    const relationships = typeof this.zohoService.extractRelationships === 'function'
      ? this.zohoService.extractRelationships(leadMetadata.metadata || [])
      : (leadMetadata.metadata || []).map((field) => ({
        field_api_name: field.api_name || null,
        target_module_api_name: field.lookup?.module?.api_name || field.lookup?.module || field.lookup?.module_name || field.module || null
      })).filter((relationship) => relationship.field_api_name && relationship.target_module_api_name);
    const relationshipField = relationships.find((relationship) => relationship.target_module_api_name === 'Deals');
    if (!relationshipField) {
      throw createAppError(
        'ZOHO_DEAL_RELATIONSHIP_UNAVAILABLE',
        'Zoho Leads metadata exposes no direct Converted Deal lookup field, so converted-to-Deal Leads cannot be reliably matched.',
        200
      );
    }

    const leadFilters = [
      { field: 'Converted__s', operator: 'equals', value: true },
      ...(dateFilter ? [{ ...dateFilter, field: 'Converted_Date_Time' }] : [])
    ];
    const leadRecords = [];
    let page = 1;
    let moreRecords = true;
    while (moreRecords) {
      const leadResult = await this.zohoService.searchRecords(
        'Leads',
        ['id', 'Converted__s', 'Converted_Date_Time', relationshipField.field_api_name],
        leadFilters,
        page,
        200,
        {},
        { type: 'lead_conversion' }
      );
      leadRecords.push(...leadResult.records);
      moreRecords = Boolean(leadResult.info?.more_records);
      page += 1;
    }
    const validLeadDealIds = leadRecords
      .map((record) => {
        const lookup = record[relationshipField.field_api_name];
        return lookup && typeof lookup === 'object' ? lookup.id : lookup;
      })
      .filter((value) => value !== undefined && value !== null && value !== '')
      .map(String);
    const dealIds = new Set(validLeadDealIds);
    const dealRecords = dealIds.size > 0
      ? await this.zohoService.getRecordsByIds('Deals', [...dealIds], ['id', 'Deal_Name', 'Created_Time', 'Lead_Conversion_Time'])
      : [];
    const validDealIds = new Set(dealRecords.map((deal) => String(deal.id)).filter(Boolean));
    const matched = leadRecords.filter((record) => {
      const lookup = record[relationshipField.field_api_name];
      const leadDealId = lookup && typeof lookup === 'object' ? lookup.id : lookup;
      return leadDealId != null && validDealIds.has(String(leadDealId));
    }).length;
    return {
      count: matched,
      comparison: {
        lead_records_checked: leadRecords.length,
        deal_records_checked: dealRecords.length,
        matched_lead_deal_records: matched,
        matched_records: matched,
        relationship_method: `Lead.${relationshipField.field_api_name}.id matched to Deals.id`,
        confidence: 'exact'
      }
    };
  }

  async countDealsByRelationship(request, dateFilter) {
    let offset = 0;
    let count = 0;
    let moreRecords = true;
    const filters = dateFilter ? [{ ...dateFilter, field: 'Lead_Conversion_Time' }] : [{ field: 'Lead_Conversion_Time', operator: 'is_not_null' }];
    while (moreRecords) {
      const result = await this.zohoService.query({
        ...request,
        module: 'Deals',
        fields: ['id', 'Lead_Conversion_Time'],
        filters,
        limit: 200,
        offset
      });
      count += result.records.filter((record) => record.Lead_Conversion_Time).length;
      moreRecords = Boolean(result.info?.more_records);
      offset += 200;
    }
    return { count };
  }
}

function normalizeGroupValue(value) {
  if (!value || typeof value !== 'object') return value;
  return value.name || value.full_name || value.email || value.id || null;
}

function toIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function ownerLabel(value) {
  return normalizeGroupValue(value) || 'Unassigned';
}

function aggregateNumber(row = {}, key) {
  return Number(row[key] ?? row[key.replace(/[()]/g, '')] ?? row.value ?? 0) || 0;
}

function buildModuleCriteriaForBulk(filters = []) {
  return buildFilterClauses(filters).join(' and ');
}

function normalizeBulkResult(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result?.records)) return result.records;
  return [];
}

function createExecutionContext() {
  return { resultCache: new Map(), startedAt: Date.now(), queryBudget: Math.max(1, env.zohoMaxQueryBudget), queriesReserved: 0 };
}

async function executeCached(context, key, operation) {
  if (context.resultCache.has(key)) return context.resultCache.get(key);
  if (context.queriesReserved >= context.queryBudget) {
    throw createAppError('CRM_QUERY_BUDGET_EXCEEDED', `CRM query execution budget exceeded (${context.queryBudget} operations).`, 503, { budget: context.queryBudget, queries_reserved: context.queriesReserved });
  }
  context.queriesReserved += 1;
  const result = await operation();
  context.resultCache.set(key, result);
  return result;
}

async function validateMetadataFields(zohoService, request) {
  if (request.module === 'CRM' || typeof zohoService.getFieldMetadata !== 'function') return;
  const moduleApiName = request.module_api_name || request.module;
  const metadata = await zohoService.getFieldMetadata(moduleApiName);
  if (!metadata || !Array.isArray(metadata.fields) || metadata.fields.length === 0) {
    throw createAppError('ZOHO_METADATA_EMPTY', `Zoho field metadata for '${moduleApiName}' was unavailable.`, 502, { module_api_name: moduleApiName });
  }
  const conversionFields = new Set(['Converted__s', 'Converted_Date_Time']);
  if (request.analysis?.type === 'lead_conversion') {
    const missingConversionFields = [...conversionFields].filter((field) => !metadata.fields.includes(field));
    if (missingConversionFields.length > 0) throw createAppError('ZOHO_CONVERSION_FIELDS_UNAVAILABLE', 'Zoho Leads metadata does not expose the fields required for conversion analysis.', 502, { module: moduleApiName, fields: missingConversionFields });
    return;
  }
  const requestedFields = Array.isArray(request.fields) ? request.fields : [];
  const missingRequestedFields = requestedFields.filter((field) => conversionFields.has(field) && !metadata.fields.includes(field));
  if (missingRequestedFields.length > 0) {
    const isConversionField = missingRequestedFields.some((field) => conversionFields.has(field));
    throw createAppError(
      isConversionField ? 'ZOHO_FIELD_UNAVAILABLE' : 'FIELD_NOT_AVAILABLE',
      `Zoho CRM metadata for '${moduleApiName}' does not expose the requested field(s).`,
      isConversionField ? 502 : 400,
      { module: request.module, module_api_name: moduleApiName, field: missingRequestedFields[0], fields: missingRequestedFields }
    );
  }
  if (!Array.isArray(metadata.metadata) || metadata.metadata.length === 0) return;
  const fields = [
    ...(Array.isArray(request.fields) ? request.fields : []),
    ...(Array.isArray(request.filters) ? request.filters.map((filter) => filter.field) : []),
    ...collectMetadataExpressionFields(request.filter_expression),
    request.aggregate?.field,
    request.group_by,
    request.having_filter?.field,
    ...(Array.isArray(request.sort) ? request.sort.map((sort) => sort.field) : [request.sort?.field])
  ].filter(Boolean);
  const missing = [...new Set(fields.filter((field) => !metadata.fields.includes(field) && !String(field).includes('.')))];
  if (missing.length > 0) throw createAppError('FIELD_NOT_AVAILABLE', `Zoho CRM metadata for '${moduleApiName}' does not expose the requested field(s).`, 400, { module: request.module, module_api_name: moduleApiName, field: missing[0], fields: missing });
}

function projectResponseRecord(record, responseFields) {
  if (!Array.isArray(responseFields) || responseFields.length === 0) return record;
  const fields = responseFields.includes('id') || !Object.prototype.hasOwnProperty.call(record, 'id') ? responseFields : ['id', ...responseFields];
  return Object.fromEntries(fields.filter((field) => Object.prototype.hasOwnProperty.call(record, field)).map((field) => [field, record[field]]));
}

function rejectForbiddenInternalFieldNames(input) {
  if (!input || typeof input !== 'object') return;
  const candidates = [];
  if (Array.isArray(input.fields)) candidates.push(...input.fields);
  if (Array.isArray(input.filters)) candidates.push(...input.filters.map((filter) => filter?.field).filter(Boolean));
  if (input.group_by) candidates.push(input.group_by);
  if (input.aggregate?.field) candidates.push(input.aggregate.field);
  if (input.sort?.field) candidates.push(input.sort.field);
  if (input.sort_field) candidates.push(input.sort_field);
  if (input.comparison?.field) candidates.push(input.comparison.field);
  if (input.comparison?.date_field) candidates.push(input.comparison.date_field);
  const forbidden = [...new Set(candidates.filter((value) => isForbiddenMetadataFieldName(value)))];
  if (forbidden.length > 0) {
    throw createAppError(
      'FIELD_NOT_AVAILABLE',
      `Internal CRM field names are not valid Zoho API fields: ${forbidden.join(', ')}.`,
      400,
      { module: input.module, module_api_name: input.module_api_name || null, forbidden_fields: forbidden }
    );
  }
}

function resolveComparisonPeriod(period) {
  return resolveRelativePeriod(period || 'this week');
}

async function discoverActivityModuleSpecs(zohoService) {
  if (!zohoService || typeof zohoService.getModulesMetadata !== 'function' || typeof zohoService.getFieldMetadata !== 'function') return [];

  let metadata;
  try {
    metadata = await zohoService.getModulesMetadata();
  } catch (_error) {
    return [];
  }

  const moduleList = Array.isArray(metadata?.modules) ? metadata.modules : [];
  const standardModules = new Set(['Leads', 'Contacts', 'Accounts', 'Deals', 'Tasks', 'Calls', 'Meetings', 'Notes', 'Products', 'Vendors', 'Quotes', 'Sales Orders', 'Purchase Orders', 'Campaigns', 'Renewal Accounts']);
  const fieldCandidates = [
    { field: 'Created_Time', labelField: 'Subject', fields: ['Subject', 'Owner', 'Created_Time', 'Modified_Time'] },
    { field: 'Modified_Time', labelField: 'Subject', fields: ['Subject', 'Owner', 'Created_Time', 'Modified_Time'] },
    { field: 'Due_Date', labelField: 'Subject', fields: ['Subject', 'Status', 'Priority', 'Due_Date', 'Owner', 'Created_Time'] },
    { field: 'Start_DateTime', labelField: 'Event_Title', fields: ['Event_Title', 'Venue', 'Start_DateTime', 'End_DateTime', 'Owner', 'Participants'] },
    { field: 'Call_Start_Time', labelField: 'Subject', fields: ['Subject', 'Call_Type', 'Call_Start_Time', 'Status', 'Owner', 'Created_Time'] }
  ];

  const flattenFieldNames = (value) => {
    if (Array.isArray(value)) return value.flatMap((entry) => flattenFieldNames(entry));
    if (!value || typeof value !== 'object') return typeof value === 'string' ? [value] : [];
    return ['api_name', 'name', 'field_name', 'field_label', 'display_label', 'label']
      .map((key) => value[key])
      .filter(Boolean)
      .flatMap((entry) => flattenFieldNames(entry));
  };

  const discovered = [];
  for (const moduleInfo of moduleList) {
    const apiName = moduleInfo?.api_name || moduleInfo?.module_name || moduleInfo?.singular_label;
    if (!apiName || standardModules.has(apiName)) continue;
    try {
      const fieldMetadata = await zohoService.getFieldMetadata(apiName);
      const fields = Array.isArray(fieldMetadata?.fields) ? fieldMetadata.fields : [];
      const fieldNames = new Set(flattenFieldNames(fields));
      const match = fieldCandidates.find((candidate) => fieldNames.has(candidate.field))
        || fieldCandidates.find((candidate) => candidate.fields.some((field) => fieldNames.has(field)))
        || fieldCandidates.find((candidate) => fieldNames.has(candidate.fields[0]));
      if (match) {
        discovered.push({ module: apiName, dateField: match.field, fields: match.fields, labelField: match.labelField });
      }
    } catch (_error) {
      continue;
    }
  }
  return discovered;
}

function classifyExecution(input = {}) {
  const explicit = String(input.complexity || '').toUpperCase();
  if (['SIMPLE', 'MODERATE', 'COMPLEX', 'MULTI-STEP'].includes(explicit)) {
    return { classification: explicit, steps: stepsForRequest(input) };
  }
  if (input.request_type === 'analysis') return { classification: 'MULTI-STEP', steps: stepsForRequest(input) };
  if (input.request_type === 'aggregate' || input.request_type === 'count') return { classification: 'MODERATE', steps: stepsForRequest(input) };
  return { classification: 'SIMPLE', steps: stepsForRequest(input) };
}

function stepsForRequest(input = {}) {
  if (input.request_type === 'analysis') {
    if (input.analysis?.type === 'owner_performance') return ['owner totals', 'closed-won totals', 'overall totals', 'calculate ranking and win rate', 'validate result'];
    if (input.analysis?.type === 'lead_source_report') return ['source counts', 'top-source records', 'calculate percentages', 'validate result'];
    if (input.analysis?.type === 'lead_conversion') return ['created lead count', 'converted lead count', 'related deal lookup', 'calculate conversion rate', 'validate result'];
  }
  return ['execute one bounded CRM query', 'validate result'];
}

module.exports = { CrmService };
