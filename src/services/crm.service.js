const { validateCrmQuery } = require('../validators/crmQuery.validator');
const { ZohoCrmService } = require('./zohoCrm.service');
const { sanitizeZohoRecord } = require('../utils/zohoRecord');
const { CRM_API_NAMES } = require('../constants/crmModules');
const { buildFilterClauses, buildWhereClause } = require('./coql.service');
const { createAppError } = require('../utils/errors');
const { log } = require('../utils/logger');

class CrmService {
  constructor(zohoService = new ZohoCrmService()) {
    this.zohoService = zohoService;
  }

  async query(input) {
    log('info', `[CRM filters received] ${JSON.stringify(Array.isArray(input?.filters) ? input.filters : [])}`);
    log('info', `[CRM request received] ${JSON.stringify({ module: input?.module, fields: input?.fields, filters: input?.filters, limit: input?.limit, offset: input?.offset, sort_field: input?.sort_field || input?.sort?.field, sort_order: input?.sort_order || input?.sort?.order, request_type: input?.request_type || 'records' })}`);
    const normalizedInput = normalizeSemanticRequest(input);
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
    if (request.request_type === 'count') return this.count(request);
    if (request.request_type === 'aggregate') return this.aggregate(request, request.aggregate);
    if (request.request_type === 'analysis' && normalizedInput.analysis?.type === 'lead_conversion') return this.leadConversionAnalysis(request);
    const result = await this.zohoService.query(request);
    const data = result.records.map(sanitizeZohoRecord);
    const info = result.info || {};

    return {
      module: request.module,
      count: Number.isInteger(info.count) ? info.count : data.length,
      data,
      pagination: {
        limit: request.limit,
        offset: request.offset,
        more_records: Boolean(info.more_records)
      }
    };
  }

  async count(request) {
    const result = await this.zohoService.count(CRM_API_NAMES[request.module], request.filters);
    return { module: request.module, request_type: request.request_type, count: result.count, data: [], summary: { operation: 'count', value: result.count }, pagination: { limit: request.limit, offset: request.offset, returned: 0, more_records: false } };
  }

  async aggregate(request, aggregate) {
    const clauses = buildFilterClauses(request.filters);
    const expression = `${aggregate.operation.toUpperCase()}(${aggregate.field})`;
    let selectQuery = `select ${request.group_by ? `${request.group_by}, ` : ''}${expression} from ${CRM_API_NAMES[request.module]}`;
    selectQuery += ` where ${buildWhereClause(clauses)}`;
    if (request.group_by) selectQuery += ` group by ${request.group_by}`;
    log('info', `[COQL aggregate query] ${selectQuery}`);
    const result = await this.zohoService.aggregate(selectQuery);
    const aggregateKey = `${aggregate.operation.toUpperCase()}(${aggregate.field})`;
    const rows = result.rows.map((row) => ({
      ...row,
      value: row.value ?? row[aggregateKey]
    }));
    return {
      module: request.module,
      count: aggregate.operation === 'count' ? Number(rows[0]?.value || 0) : rows.length,
      data: rows,
      summary: { operation: aggregate.operation, field: aggregate.field, rows },
      pagination: { limit: request.limit, offset: request.offset, returned: rows.length, more_records: false }
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

module.exports = { CrmService };
