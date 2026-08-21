const { validateCrmQuery } = require('../validators/crmQuery.validator');
const { ZohoCrmService } = require('./zohoCrm.service');
const { sanitizeZohoRecord } = require('../utils/zohoRecord');
const { log } = require('../utils/logger');

class CrmService {
  constructor(zohoService = new ZohoCrmService()) {
    this.zohoService = zohoService;
  }

  async query(input) {
    log('info', `[CRM filters received] ${JSON.stringify(Array.isArray(input?.filters) ? input.filters : [])}`);
    const request = validateCrmQuery(input);
    log('info', `[CRM filters normalized] ${JSON.stringify(request.filters)}`);
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
}

module.exports = { CrmService };
