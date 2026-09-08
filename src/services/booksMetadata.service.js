const { BOOKS_MODULES, BOOKS_API_NAMES } = require('../constants/booksModules');

class BooksMetadataService {
  constructor() {
    this.moduleCache = new Map();
  }

  async resolveModuleApiName(moduleName, { preferStatic = true } = {}) {
    if (!moduleName) return null;
    if (BOOKS_API_NAMES[moduleName]) return BOOKS_API_NAMES[moduleName];
    return String(moduleName).trim();
  }

  async getModuleMetadata(moduleName) {
    const apiName = await this.resolveModuleApiName(moduleName);
    if (!apiName) return { module_api_name: null, fields: [], metadata: [] };
    const staticFields = BOOKS_MODULES[moduleName] || [];
    const fields = staticFields.length > 0 ? staticFields : ['id'];
    return {
      module: moduleName,
      module_api_name: apiName,
      fields,
      metadata: fields.map((field) => ({ field_name: field, display_name: field, data_type: 'string' }))
    };
  }

  async getFieldMetadata(moduleName) {
    const metadata = await this.getModuleMetadata(moduleName);
    return { module: metadata.module, module_api_name: metadata.module_api_name, fields: metadata.fields, metadata: metadata.metadata };
  }
}

module.exports = { BooksMetadataService };
