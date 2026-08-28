const { validateCrmQuery, validateModuleFieldScope, validateAggregateQuery } = require('../validators/crmQuery.validator');
const { ZohoCrmService } = require('./zohoCrm.service');
const { sanitizeZohoRecord } = require('../utils/zohoRecord');
const { CRM_API_NAMES } = require('../constants/crmModules');
const { buildFilterClauses, buildWhereClause } = require('./coql.service');
const { createAppError } = require('../utils/errors');
const { log } = require('../utils/logger');
const { randomUUID } = require('node:crypto');
const { env } = require('../config/env');

class CrmService {
  constructor(zohoService = new ZohoCrmService()) {
    this.zohoService = zohoService;
  }

  async query(input, executionContext = createExecutionContext()) {
    const executionId = randomUUID();
    const startedAt = Date.now();
    const statsAtStart = { ...(this.zohoService.executionStats || {}) };
    log('info', `[CRM EXECUTION START] executionId=${executionId}`);
    log('info', `[CRM filters received] ${JSON.stringify(Array.isArray(input?.filters) ? input.filters : [])}`);
    log('info', `[CRM request received] ${JSON.stringify({ module: input?.module, fields: input?.fields, filters: input?.filters, limit: input?.limit, offset: input?.offset, sort_field: input?.sort_field || input?.sort?.field, sort_order: input?.sort_order || input?.sort?.order, request_type: input?.request_type || 'records' })}`);
    const normalizedInput = normalizeSemanticRequest(input);
    const executionPlan = classifyExecution(normalizedInput);
    log('info', `[CRM execution plan] classification=${executionPlan.classification} steps=${executionPlan.steps.join(' | ')}`);
    let request;
    try {
      request = validateCrmQuery(normalizedInput);
    } catch (error) {
      log('warn', `[CRM validation failure] ${JSON.stringify(error.details || { message: error.message })}`);
      throw error;
    }
    await validateMetadataFields(this.zohoService, request);
    if (typeof this.zohoService.resolveOwnerFilters === 'function') {
      request.filters = await this.zohoService.resolveOwnerFilters(request.filters);
    }
    log('info', `[CRM normalized request] ${JSON.stringify({ module: request.module, fields: request.fields, filters: request.filters, limit: request.limit, offset: request.offset, sort_field: request.sort?.field, sort_order: request.sort?.order, request_type: request.request_type })}`);
    log('info', `[CRM filters normalized] ${JSON.stringify(request.filters)}`);
    if (request.request_type === 'count') {
      const result = await this.count(request);
      this.logExecution(executionId, startedAt, statsAtStart, 'count');
      return result;
    }
    if (request.request_type === 'aggregate') {
      const result = await this.aggregate(request, request.aggregate);
      this.logExecution(executionId, startedAt, statsAtStart, 'aggregate');
      return result;
    }
    if (request.request_type === 'analysis' && normalizedInput.analysis?.type === 'lead_conversion') {
      const result = await this.leadConversionAnalysis(request);
      this.logExecution(executionId, startedAt, statsAtStart, 'lead_conversion');
      return result;
    }
    if (request.request_type === 'analysis' && normalizedInput.analysis?.type === 'lead_closed_won_conversion') {
      const result = await this.leadClosedWonConversionAnalysis(request, executionContext);
      this.logExecution(executionId, startedAt, statsAtStart, 'lead_closed_won_conversion');
      return result;
    }
    if (request.request_type === 'analysis' && normalizedInput.analysis?.type === 'lead_source_report') {
      const result = await this.leadSourceReport(request, executionContext);
      this.logExecution(executionId, startedAt, statsAtStart, 'lead_source_report');
      return result;
    }
    if (request.request_type === 'analysis' && normalizedInput.analysis?.type === 'owner_performance') {
      const result = await this.ownerPerformanceReport(request, executionContext);
      this.logExecution(executionId, startedAt, statsAtStart, 'owner_performance');
      return result;
    }
    if (request.request_type === 'analysis' && normalizedInput.analysis?.type === 'sales_performance') {
      const result = await this.salesPerformanceAnalysis(request, executionContext);
      this.logExecution(executionId, startedAt, statsAtStart, 'sales_performance');
      return result;
    }
    if (request.request_type === 'analysis' && normalizedInput.analysis?.type === 'closed_won_summary') {
      const result = await this.closedWonSummary(request, executionContext);
      this.logExecution(executionId, startedAt, statsAtStart, 'closed_won_summary');
      return result;
    }
    if (request.request_type === 'analysis' && normalizedInput.analysis?.type === 'count_and_records') {
      const result = await this.countAndRecords(request, normalizedInput.retrieve_all === true, executionContext);
      this.logExecution(executionId, startedAt, statsAtStart, 'count_and_records');
      return result;
    }
    const result = await this.zohoService.query(request);
    const data = result.records.map(sanitizeZohoRecord);
    const info = result.info || {};

    const response = {
      module: request.module,
      count: Number.isInteger(info.count) ? info.count : data.length,
      data,
      pagination: {
        limit: request.limit,
        offset: request.offset,
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

  async count(request) {
    const result = await this.zohoService.count(CRM_API_NAMES[request.module], request.filters);
    return { module: request.module, request_type: request.request_type, count: result.count, data: [], summary: { operation: 'count', value: result.count }, pagination: { limit: request.limit, offset: request.offset, returned: 0, more_records: false } };
  }

  async aggregate(request, aggregate) {
    validateAggregateQuery({ module: request.module, fields: request.fields, filters: request.filters, aggregate, groupBy: request.group_by, sort: request.sort });
    const expression = `${aggregate.operation.toUpperCase()}(${aggregate.field})`;
    const selectQuery = `select ${request.group_by ? `${request.group_by}, ` : ''}${expression} from ${CRM_API_NAMES[request.module]} where ${buildWhereClause(buildFilterClauses(request.filters))}${request.group_by ? ` group by ${request.group_by}` : ''}`;
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
        leads_converted_to_deals: leadsConvertedToDeals,
        converted_to_deals: leadsConvertedToDeals,
        conversion_rate: conversionRate
      },
      metrics: { leads_created: leadsCreated, leads_converted: leadsConverted, leads_converted_to_deals: leadsConvertedToDeals, conversion_rate: conversionRate },
      calculations: ['conversion_rate = leads_converted_to_deals / leads_created * 100'],
      comparison,
      warnings: dealsCountWarning ? [dealsCountWarning] : [],
      data: [],
      pagination: { limit: request.limit, offset: request.offset, returned: 0, more_records: false }
    };
  }

  async compareLeadDealRelationships(request, dateFilter, leadMetadata) {
    const relationshipField = (leadMetadata.metadata || []).find((field) => {
      const lookupModule = field.lookup?.module?.api_name || field.lookup?.module || field.lookup?.module_name || field.module;
      return field.data_type === 'lookup' && lookupModule === 'Deals';
    });
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
        ['id', 'Converted__s', 'Converted_Date_Time', relationshipField.api_name],
        leadFilters,
        page,
        200
      );
      leadRecords.push(...leadResult.records);
      moreRecords = Boolean(leadResult.info?.more_records);
      page += 1;
    }
    const dealIds = new Set(leadRecords.map((record) => {
      const lookup = record[relationshipField.api_name];
      return lookup && typeof lookup === 'object' ? lookup.id : lookup;
    }).filter(Boolean).map(String));
    const dealRecords = dealIds.size > 0
      ? await this.zohoService.getRecordsByIds('Deals', [...dealIds], ['id', 'Deal_Name', 'Created_Time', 'Lead_Conversion_Time'])
      : [];
    const matched = dealRecords.filter((deal) => dealIds.has(String(deal.id))).length;
    return {
      count: matched,
      comparison: {
        lead_records_checked: leadRecords.length,
        deal_records_checked: dealRecords.length,
        matched_lead_deal_records: matched,
        matched_records: matched,
        relationship_method: `Lead.${relationshipField.api_name}.id matched to Deals.id`,
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

function ownerLabel(value) {
  return normalizeGroupValue(value) || 'Unassigned';
}

function aggregateNumber(row = {}, key) {
  return Number(row[key] ?? row[key.replace(/[()]/g, '')] ?? row.value ?? 0) || 0;
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
  const conversionFields = new Set(['Converted__s', 'Converted_Date_Time']);
  const requestedFields = Array.isArray(request.fields) ? request.fields : [];
  const requestedConversionField = requestedFields.find((field) => conversionFields.has(field));
  if (!requestedConversionField || request.module !== 'Leads') return;

  const metadata = await zohoService.getFieldMetadata('Leads');
  if (!new Set(metadata.fields).has(requestedConversionField)) {
    throw createAppError(
      'ZOHO_FIELD_UNAVAILABLE',
      `Zoho Leads metadata does not expose '${requestedConversionField}'.`,
      502
    );
  }
}

function normalizeSemanticRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const fields = Array.isArray(input.fields) ? input.fields : [];
  const hasSemanticConversion = input.module === 'Leads'
    && fields.includes('Converted')
    && Array.isArray(input.filters)
    && input.filters.some((filter) => filter?.field === 'Created_Time');
  if (!hasSemanticConversion) return input;

  const validFields = fields.filter((field) => field !== 'Converted');
  log('info', '[CRM semantic translation] Converted -> lead conversion analysis using Deals.Lead_Conversion_Time');
  return {
    ...input,
    fields: validFields.length > 0 ? validFields : ['id'],
    request_type: 'analysis',
    analysis: { type: 'lead_conversion' }
  };
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
