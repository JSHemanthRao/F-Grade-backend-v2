const { booksQueryValidator, resolveProductDomain } = require('../validators/booksQuery.validator');
const { ZohoBooksService } = require('./zohoBooks.service');
const { createAppError } = require('../utils/errors');

class BooksService {
  constructor(zohoBooksService = new ZohoBooksService()) {
    this.zohoBooksService = zohoBooksService;
  }

  async query(input = {}) {
    const request = booksQueryValidator(input);
    const moduleApiName = request.module_api_name || await this.zohoBooksService.resolveModuleApiName(request.module);
    const metadata = await this.zohoBooksService.getFieldMetadata(moduleApiName);
    const customFields = Array.isArray(request.fields) && request.fields.length > 0 ? request.fields : metadata.fields.slice(0, 6);
    const result = await this.zohoBooksService.query({ ...request, module_api_name: moduleApiName, fields: customFields });
    const records = Array.isArray(result.records) ? result.records : [];
    return {
      success: true,
      domain: 'books',
      module: request.module,
      module_api_name: moduleApiName,
      request_type: request.request_type,
      returned: records.length,
      more_records: Boolean(result.info?.more_records),
      records,
      data: records,
      pagination: {
        limit: request.limit,
        offset: request.offset,
        returned: records.length,
        more_records: Boolean(result.info?.more_records)
      },
      answer: `Books ${request.module} query returned ${records.length} record(s).`
    };
  }

  async getModuleHistory(moduleName, params = {}) {
    if (!moduleName) {
      throw createAppError('BOOKS_HISTORY_ERROR', 'A Books module is required for module history.', 400);
    }
    const result = await this.zohoBooksService.getModuleHistory(moduleName, params);
    return {
      success: true,
      domain: 'books',
      module: moduleName,
      request_type: 'history',
      data: Array.isArray(result.records) ? result.records : [],
      pagination: { limit: params.limit || 20, offset: params.offset || 0, returned: Array.isArray(result.records) ? result.records.length : 0, more_records: false }
    };
  }
}

module.exports = { BooksService, resolveProductDomain };
