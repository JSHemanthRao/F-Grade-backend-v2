const { validateCrmQuery } = require('../validators/crmQuery.validator');
const { ZohoCrmService } = require('./zohoCrm.service');
const { sanitizeZohoRecord } = require('../utils/zohoRecord');

class CrmService {
  constructor(zohoService = new ZohoCrmService()) {
    this.zohoService = zohoService;
  }

  async query(input) {
    const request = validateCrmQuery(input);
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
