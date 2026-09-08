const test = require('node:test');
const assert = require('node:assert/strict');
const { booksQueryValidator, resolveProductDomain } = require('../src/validators/booksQuery.validator');
const { BooksService } = require('../src/services/books.service');

const fakeBooks = {
  query: async (request) => ({
    records: [{ id: 'INV-1', Customer_Name: 'Acme', Total: 1200 }],
    info: { more_records: false },
    module_api_name: request.module_api_name || request.module
  }),
  resolveModuleApiName: async (module) => ({ Invoices: 'invoices', 'Price Lists': 'pricelists', Customers: 'contacts' }[module] || module),
  getFieldMetadata: async (module) => ({ fields: ['id', 'Customer_Name', 'Total'], metadata: [] }),
  getModuleHistory: async () => ({ records: [], info: { total_count: 0 } })
};

test('routes explicit Books modules to the books domain', () => {
  assert.equal(resolveProductDomain('Show me invoices'), 'books');
  assert.equal(resolveProductDomain('Show me customers'), 'books');
  assert.equal(resolveProductDomain('Show me Deals'), 'crm');
});

test('validates a read-only Books query without write operations', () => {
  const result = booksQueryValidator({
    module: 'Invoices',
    request_type: 'records',
    fields: ['Customer_Name', 'Total'],
    filters: [{ field: 'Total', operator: 'greater_than', value: 1000 }],
    sort: { field: 'Total', order: 'desc' },
    limit: 20,
    offset: 0
  });

  assert.equal(result.module, 'Invoices');
  assert.deepEqual(result.fields, ['Customer_Name', 'Total']);
  assert.equal(result.request_type, 'records');
});

test('returns normalized Books results', async () => {
  const service = new BooksService(fakeBooks);
  const response = await service.query({ module: 'Invoices', fields: ['Customer_Name', 'Total'], limit: 20, offset: 0 });
  assert.equal(response.domain, 'books');
  assert.equal(response.module, 'Invoices');
  assert.equal(response.module_api_name, 'invoices');
  assert.equal(response.request_type, 'records');
  assert.equal(response.data.length, 1);
  assert.equal(response.returned, 1);
});

test('rejects CRM Quotes as a Books module with a clear message', () => {
  assert.throws(
    () => booksQueryValidator({ module: 'Quotes', request_type: 'records', limit: 10, offset: 0 }),
    (error) => {
      assert.equal(error.code, 'BOOKS_MODULE_UNSUPPORTED');
      assert.match(error.message, /Quotes.*CRM/i);
      return true;
    }
  );
});

test('includes organization_id when querying Zoho Books records', async () => {
  let captured = null;
  const fakeHttpClient = {
    post: async () => ({ data: { access_token: 'token-123', expires_in: 3600, api_domain: 'https://www.zohoapis.in' } }),
    get: async (url, config) => {
      captured = { url, config };
      return { data: { data: [{ id: 'INV-1' }], info: { more_records: false } } };
    }
  };

  const service = new (require('../src/services/zohoBooks.service').ZohoBooksService)(fakeHttpClient, () => ({
    accountsUrl: 'https://accounts.zoho.in',
    apiBaseUrl: 'https://www.zohoapis.in/books/v3',
    timeoutMs: 15000,
    refreshToken: 'refresh-token',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    organizationId: '60017638260'
  }));

  await service.query({ module: 'Invoices', module_api_name: 'invoices', fields: ['id'], limit: 10, offset: 0 });

  assert.equal(captured.config.params.organization_id, '60017638260');
  assert.equal(captured.config.headers.Authorization, 'Zoho-oauthtoken token-123');
});
