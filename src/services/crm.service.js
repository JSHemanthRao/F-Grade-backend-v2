const { validateCrmQuery } = require('../validators/crmQuery.validator');
const { ZohoCrmService } = require('./zohoCrm.service');
const { sanitizeZohoRecord } = require('../utils/zohoRecord');
const { CRM_API_NAMES } = require('../constants/crmModules');
const { buildFilterClauses, buildWhereClause } = require('./coql.service');
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
    log('info', `[CRM normalized request] ${JSON.stringify({ module: request.module, fields: request.fields, filters: request.filters, limit: request.limit, offset: request.offset, sort_field: request.sort?.field, sort_order: request.sort?.order, request_type: request.request_type })}`);
    log('info', `[CRM filters normalized] ${JSON.stringify(request.filters)}`);
    if (request.request_type === 'count') return this.aggregate(request, { operation: 'count', field: 'id' });
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

  async aggregate(request, aggregate) {
    const clauses = buildFilterClauses(request.filters);
    const expression = `${aggregate.operation}(${aggregate.field}) as value`;
    let selectQuery = `select ${request.group_by ? `${request.group_by}, ` : ''}${expression} from ${CRM_API_NAMES[request.module]}`;
    selectQuery += ` where ${buildWhereClause(clauses)}`;
    if (request.group_by) selectQuery += ` group by ${request.group_by}`;
    log('info', `[COQL aggregate query] ${selectQuery}`);
    const result = await this.zohoService.aggregate(selectQuery);
    const rows = result.rows;
    return {
      module: request.module,
      count: aggregate.operation === 'count' ? Number(rows[0]?.value || 0) : rows.length,
      data: rows,
      summary: { operation: aggregate.operation, field: aggregate.field, rows },
      pagination: { limit: request.limit, offset: request.offset, returned: rows.length, more_records: false }
    };
  }

  async leadConversionAnalysis(request) {
    const created = await this.aggregate(request, { operation: 'count', field: 'id' });
    const dateFilter = request.filters.find((filter) => filter.field === 'Created_Time');
    const converted = await this.aggregate({
      ...request,
      module: 'Deals',
      filters: dateFilter ? [{ ...dateFilter, field: 'Lead_Conversion_Time' }] : []
    }, { operation: 'count', field: 'id' });
    const leadsCreated = Number(created.data[0]?.value || 0);
    const convertedToDeals = Number(converted.data[0]?.value || 0);
    const conversionRate = leadsCreated ? Number(((convertedToDeals / leadsCreated) * 100).toFixed(2)) : 0;
    return {
      success: true,
      module: 'Leads',
      request_type: 'analysis',
      date_range: dateFilter ? { start: dateFilter.value[0], end: dateFilter.value[1] } : {},
      summary: {
        leads_created: leadsCreated,
        leads_converted: convertedToDeals,
        leads_converted_to_deals: convertedToDeals,
        converted_to_deals: convertedToDeals,
        conversion_rate: conversionRate
      },
      metrics: { leads_created: leadsCreated, leads_converted: convertedToDeals, leads_converted_to_deals: convertedToDeals, conversion_rate: conversionRate },
      calculations: ['conversion_rate = leads_converted_to_deals / leads_created * 100'],
      data: [],
      pagination: { limit: request.limit, offset: request.offset, returned: 0, more_records: false }
    };
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
