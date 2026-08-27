const test = require('node:test');
const assert = require('node:assert/strict');
const { ZohoCrmService } = require('../src/services/zohoCrm.service');
const { buildCoqlQuery } = require('../src/services/coql.service');
const { ZohoAuthService, EXPIRY_BUFFER_MS } = require('../src/services/zohoAuth.service');
const { CrmService } = require('../src/services/crm.service');

test('builds Zoho-supported aggregate COQL and normalizes the aggregate value', async () => {
  let selectQuery;
  const service = new CrmService({
    aggregate: async (query) => {
      selectQuery = query;
      return { rows: [{ 'SUM(Amount)': 125000 }] };
    }
  });

  const result = await service.aggregate({
    module: 'Deals',
    filters: [{ field: 'Stage', operator: 'equals', value: 'Closed Won' }],
    limit: 20,
    offset: 0
  }, { operation: 'sum', field: 'Amount' });

  assert.equal(selectQuery, "select SUM(Amount) from Deals where (Stage = 'Closed Won')");
  assert.equal(result.data[0].value, 125000);
});

test('obtains and caches the Zoho access token and stores api_domain internally', async () => {
  let calls = 0;
  const auth = new ZohoAuthService({
    post: async () => {
      calls += 1;
      return { data: { access_token: 'private-token', api_domain: 'https://www.zohoapis.in', expires_in: 3600 } };
    }
  }, () => ({ accountsUrl: 'https://accounts.zoho.in', clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh', timeoutMs: 15000 }));
  await auth.getAccessToken();
  await auth.getAccessToken();
  assert.equal(calls, 1);
  assert.equal(auth.getApiDomain(), 'https://www.zohoapis.in');
  assert.ok(auth.expiresAt > Date.now() + EXPIRY_BUFFER_MS);
});

test('executes count metrics without paginating record retrieval', async () => {
  const calls = [];
  const service = new CrmService({
    count: async (module, filters) => {
      calls.push({ module, filters });
      return { count: 12 };
    },
    query: async () => { throw new Error('record retrieval must not run for count'); }
  });
  const result = await service.query({
    module: 'Leads',
    request_type: 'count',
    filters: [{ field: 'Created_Time', operator: 'between', value: ['2026-08-01', '2026-09-01'] }]
  });
  assert.equal(result.count, 12);
  assert.equal(result.pagination.more_records, false);
  assert.equal(calls[0].module, 'Leads');
  assert.equal(calls[0].filters[0].field, 'Created_Time');
});

test('uses the Zoho Module Record Count API with datetime criteria', async () => {
  const requests = [];
  const zoho = new ZohoCrmService({
    get: async (url, options) => {
      requests.push({ url, options });
      return { status: 200, data: { count: 188 } };
    }
  }, () => ({ apiBaseUrl: 'https://www.zohoapis.com/crm/v8', timeoutMs: 1000 }), {
    getAccessToken: async () => 'redacted-test-token',
    getApiDomain: () => null,
    clearToken: () => {}
  });
  const result = await zoho.count('Leads', [{ field: 'Created_Time', operator: 'between', value: ['2026-08-01', '2026-08-25'] }]);
  assert.equal(result.count, 188);
  assert.equal(requests[0].url, 'https://www.zohoapis.com/crm/v8/Leads/actions/count');
  assert.match(requests[0].options.params.criteria, /Created_Time:between:2026-08-01T00:00:00\+05:30,2026-08-25T23:59:59\+05:30/);
});

test('resolves owner names before CRM criteria generation', async () => {
  const zoho = new ZohoCrmService({
    get: async () => ({ data: { users: [{ id: '377452000014417001', first_name: 'Laya', last_name: 'M' }] } })
  }, () => ({ apiBaseUrl: 'https://www.zohoapis.com/crm/v8', timeoutMs: 1000 }), {
    getAccessToken: async () => 'redacted-test-token',
    getApiDomain: () => null,
    clearToken: () => {}
  });
  const filters = await zoho.resolveOwnerFilters([{ field: 'Owner', operator: 'equals', value: 'Laya' }]);
  assert.deepEqual(filters, [{ field: 'Owner', operator: 'equals', value: '377452000014417001' }]);
  assert.notEqual(filters[0].value, 'Laya');
});

test('executes lead conversion analysis as two aggregate queries', async () => {
  const calls = [];
  const service = new CrmService({
    getFieldMetadata: async (module) => ({ fields: module === 'Deals' ? ['Lead_Conversion_Time'] : ['Converted__s', 'Converted_Date_Time'], metadata: [] }),
    count: async (module, filters) => {
      calls.push({ module, filters });
      if (filters.some((filter) => filter.field === 'Converted__s')) return { count: 8 };
      return { count: module === 'Leads' ? 20 : 5 };
    }
  });
  const result = await service.query({
    module: 'Leads',
    request_type: 'analysis',
    analysis: { type: 'lead_conversion' },
    filters: [{ field: 'Created_Time', operator: 'between', value: ['2026-08-01', '2026-09-01'] }]
  });
  assert.equal(result.summary.leads_created, 20);
  assert.equal(result.summary.converted_to_deals, null);
  assert.equal(result.summary.conversion_rate, null);
  assert.equal(result.metrics.leads_converted, 8);
  assert.equal(result.metrics.leads_converted_to_deals, null);
  assert.equal(calls.length, 2);
});

test('translates the Copilot Converted semantic field into conversion analysis', async () => {
  const calls = [];
  const service = new CrmService({
    getFieldMetadata: async (module) => ({ fields: module === 'Deals' ? ['Lead_Conversion_Time'] : ['Converted__s', 'Converted_Date_Time'], metadata: [] }),
    count: async (module, filters) => {
      calls.push({ module, filters });
      if (filters.some((filter) => filter.field === 'Converted__s')) return { count: 8 };
      return { count: module === 'Leads' ? 20 : 5 };
    },
    query: async () => { throw new Error('semantic conversion must not retrieve records'); }
  });
  const result = await service.query({
    module: 'Leads',
    fields: ['First_Name', 'Last_Name', 'Created_Time', 'Converted'],
    filters: [{ field: 'Created_Time', operator: 'between', value: '2026-08-01,2026-08-25' }]
  });
  assert.deepEqual(result.metrics, {
    leads_created: 20,
    leads_converted: 8,
    leads_converted_to_deals: null,
    conversion_rate: null
  });
  assert.deepEqual(result.date_range, { start: '2026-08-01', end: '2026-08-25' });
  assert.equal(result.data_source, 'Zoho CRM');
  assert.match(result.calculation_basis, /Converted__s=true/);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ filters }) => filters.every((filter) => filter.field !== 'Converted')));
  assert.ok(calls.some(({ filters }) => filters.some((filter) => filter.field === 'Converted__s')));
  assert.ok(calls.some(({ filters }) => filters.some((filter) => filter.field === 'Converted_Date_Time')));
});

test('fails conversion analysis when Zoho metadata lacks conversion fields', async () => {
  const service = new CrmService({
    getFieldMetadata: async () => ({ fields: ['Created_Time'] }),
    count: async () => { throw new Error('count must not run'); }
  });
  await assert.rejects(
    service.query({
      module: 'Leads',
      request_type: 'analysis',
      analysis: { type: 'lead_conversion' },
      filters: [{ field: 'Created_Time', operator: 'between', value: ['2026-08-01', '2026-08-25'] }]
    }),
    (error) => error.code === 'ZOHO_CONVERSION_FIELDS_UNAVAILABLE' && error.statusCode === 502
  );
});

test('matches converted Leads to Deals through a verified direct lookup', async () => {
  const service = new CrmService({
    getFieldMetadata: async (module) => ({
      fields: module === 'Deals' ? ['Lead_Conversion_Time'] : ['Converted__s', 'Converted_Date_Time', 'Converted_Deal'],
      metadata: module === 'Deals' ? [] : [{ api_name: 'Converted_Deal', data_type: 'lookup', lookup: { module: { api_name: 'Deals' } } }]
    }),
    count: async () => ({ count: 1 }),
    searchRecords: async () => ({ records: [{ id: 'lead-1', Converted__s: true, Converted_Date_Time: '2026-08-10', Converted_Deal: { id: 'deal-1' } }], info: {} }),
    getRecordsByIds: async () => [{ id: 'deal-1', Deal_Name: 'Converted deal' }]
  });
  const result = await service.query({
    module: 'Leads',
    request_type: 'analysis',
    analysis: { type: 'lead_conversion' },
    filters: [{ field: 'Created_Time', operator: 'between', value: ['2026-08-01', '2026-08-25'] }]
  });
  assert.equal(result.summary.leads_converted_to_deals, 1);
  assert.equal(result.summary.conversion_rate, 100);
  assert.deepEqual(result.comparison, {
    lead_records_checked: 1,
    deal_records_checked: 1,
    matched_lead_deal_records: 1,
    matched_records: 1,
    relationship_method: "Lead.Converted_Deal.id matched to Deals.id",
    confidence: 'exact'
  });
});

test('gates explicit conversion fields on Zoho metadata', async () => {
  const service = new CrmService({
    getFieldMetadata: async () => ({ fields: ['Created_Time'] }),
    query: async () => ({ records: [], info: {} })
  });
  await assert.rejects(
    service.query({ module: 'Leads', fields: ['Converted__s'] }),
    (error) => error.code === 'ZOHO_FIELD_UNAVAILABLE' && error.statusCode === 502
  );
});

test('returns real Lead counts with null Deal count when Zoho rejects the Deal relationship criterion', async () => {
  const service = new CrmService({
    getFieldMetadata: async (module) => ({ fields: module === 'Deals' ? ['Lead_Conversion_Time'] : ['Converted__s', 'Converted_Date_Time'] }),
    count: async (module, filters) => {
      if (module === 'Deals') {
        const error = new Error('invalid query');
        error.code = 'ZOHO_COUNT_ERROR';
        error.details = { upstream_code: 'INVALID_QUERY' };
        throw error;
      }
      return { count: filters.some((filter) => filter.field === 'Converted__s') ? 3 : 10 };
    }
  });
  const result = await service.query({
    module: 'Leads',
    request_type: 'analysis',
    analysis: { type: 'lead_conversion' },
    filters: [{ field: 'Created_Time', operator: 'between', value: ['2026-08-01', '2026-08-25'] }]
  });
  assert.equal(result.summary.leads_created, 10);
  assert.equal(result.summary.leads_converted, 3);
  assert.equal(result.summary.leads_converted_to_deals, null);
  assert.equal(result.summary.conversion_rate, null);
  assert.equal(result.warnings.length, 1);
});

test('refreshes when the cached token enters the expiry buffer', async () => {
  let calls = 0;
  const auth = new ZohoAuthService({
    post: async () => {
      calls += 1;
      return { data: { access_token: `private-token-${calls}`, expires_in: 3600 } };
    }
  }, () => ({ accountsUrl: 'https://accounts.zoho.in', clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh', timeoutMs: 15000 }));
  await auth.getAccessToken();
  auth.expiresAt = Date.now() + EXPIRY_BUFFER_MS - 1;
  await auth.getAccessToken();
  assert.equal(calls, 2);
});

test('builds v8 COQL from structured filters without accepting raw queries', () => {
  const query = buildCoqlQuery({
    module: 'Deals',
    fields: ['Deal_Name', 'Amount', 'Stage'],
    filters: [{ field: 'Stage', operator: 'equals', value: 'Closed Won' }],
    sort: { field: 'Amount', order: 'desc' }
  });
  assert.equal(query, "select Deal_Name, Amount, Stage from Deals where (Stage = 'Closed Won') order by Amount desc");
});

test('adds a safe internal predicate for unfiltered COQL retrieval', () => {
  const query = buildCoqlQuery({
    module: 'Deals',
    fields: ['Deal_Name', 'Amount', 'Stage'],
    filters: [],
    sort: { field: 'Amount', order: 'desc' }
  });
  assert.equal(query, 'select Deal_Name, Amount, Stage from Deals where (id is not null) order by Amount desc');
});

test('authenticates, calls Zoho COQL, and normalizes the CRM response', async () => {
  const calls = [];
  const fakeClient = {
    post: async (url, body, options) => {
      calls.push({ url, body, options });
      if (url.includes('/oauth/v2/token')) return { data: { access_token: 'server-token', expires_in: 3600 } };
      return {
        data: {
          data: [{ id: 7, Deal_Name: 'Acme', Owner: { name: 'Asha' }, $state: 'hidden' }],
          info: { count: 1, more_records: false }
        }
      };
    }
  };
  const config = {
    accountsUrl: 'https://accounts.zoho.com',
    apiBaseUrl: 'https://www.zohoapis.com/crm/v8',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    refreshToken: 'refresh-token',
    timeoutMs: 15000
  };
  const crmService = new CrmService(new ZohoCrmService(fakeClient, () => config));
  const result = await crmService.query({
    module: 'Deals',
    fields: ['Deal_Name', 'Account_Name', 'Amount', 'Stage', 'Closing_Date', 'Owner'],
    filters: [
      { field: 'Stage', operator: 'equals', value: 'Closed Won' },
      { field: 'Amount', operator: 'greater_than', value: 50000 }
    ],
    sort_field: 'Amount',
    sort_order: 'desc',
    limit: 20,
    offset: 0
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].body, null);
  assert.equal(calls[1].url, 'https://www.zohoapis.com/crm/v8/coql');
  assert.equal(calls[1].body.select_query, "select Deal_Name, Account_Name, Amount, Stage, Closing_Date, Owner from Deals where ((Stage = 'Closed Won') and (Amount > 50000)) order by Amount desc limit 0, 20");
  assert.equal(calls[1].options.headers.Authorization, 'Zoho-oauthtoken server-token');
  assert.deepEqual(result, {
    module: 'Deals',
    count: 1,
    data: [{ id: '7', Deal_Name: 'Acme', Owner: 'Asha' }],
    pagination: { limit: 20, offset: 0, more_records: false }
  });
});

test('converts date between filters into parenthesized inclusive COQL bounds', () => {
  const query = buildCoqlQuery({
    module: 'Deals',
    fields: ['Deal_Name', 'Amount', 'Stage', 'Closing_Date'],
    filters: [
      { field: 'Stage', operator: 'equals', value: 'Closed Won' },
      { field: 'Closing_Date', operator: 'between', value: ['2026-07-01', '2026-07-31'] }
    ],
    sort: { field: 'Amount', order: 'desc' }
  });
  assert.equal(query, "select Deal_Name, Amount, Stage, Closing_Date from Deals where ((Stage = 'Closed Won') and (Closing_Date >= '2026-07-01' and Closing_Date <= '2026-07-31')) order by Amount desc");
});

test('generates the correct COQL for a normalized comma-separated between value', () => {
  const { validateCrmQuery } = require('../src/validators/crmQuery.validator');
  const request = validateCrmQuery({
    module: 'Deals',
    fields: ['Closing_Date'],
    filters: [{ field: 'Closing_Date', operator: 'between', value: '2026-07-01,2026-07-31' }]
  });
  assert.equal(buildCoqlQuery(request), "select Closing_Date from Deals where (Closing_Date >= '2026-07-01' and Closing_Date <= '2026-07-31')");
});

test('retrieves only Closed Won Deals within the requested Closing_Date range', async () => {
  const calls = [];
  const fakeClient = {
    post: async (url, body) => {
      if (url.includes('/oauth/v2/token')) return { data: { access_token: 'test-token', expires_in: 3600 } };
      calls.push(body.select_query);
      return {
        data: {
          data: [
            { Deal_Name: 'July deal', Stage: 'Closed Won', Closing_Date: '2026-07-31' },
            { Deal_Name: 'Earlier July deal', Stage: 'Closed Won', Closing_Date: '2026-07-03' }
          ],
          info: { count: 2, more_records: false }
        }
      };
    }
  };
  const service = new CrmService(new ZohoCrmService(fakeClient, () => ({
    accountsUrl: 'https://accounts.zoho.com',
    apiBaseUrl: 'https://www.zohoapis.com/crm/v8',
    clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh', timeoutMs: 15000
  })));
  const result = await service.query({
    module: 'Deals',
    fields: ['Deal_Name', 'Stage', 'Closing_Date', 'Amount'],
    filters: [
      { field: 'Stage', operator: 'equals', value: 'Closed Won' },
      { field: 'Closing_Date', operator: 'between', value: ['2026-07-01', '2026-07-31'] }
    ],
    sort_field: 'Closing_Date',
    sort_order: 'desc',
    limit: 20,
    offset: 0
  });

  assert.equal(calls[0], "select Deal_Name, Stage, Closing_Date, Amount from Deals where ((Stage = 'Closed Won') and (Closing_Date >= '2026-07-01' and Closing_Date <= '2026-07-31')) order by Closing_Date desc limit 0, 20");
  assert.equal(result.count, 2);
  assert.equal(result.pagination.more_records, false);
  assert.ok(result.data.every((record) => record.Stage === 'Closed Won'));
  assert.ok(result.data.every((record) => record.Closing_Date >= '2026-07-01' && record.Closing_Date <= '2026-07-31'));
});

test('keeps additional filters outside the compound date group for Zoho COQL', () => {
  const query = buildCoqlQuery({
    module: 'Deals',
    fields: ['Deal_Name', 'Amount', 'Stage', 'Closing_Date'],
    filters: [
      { field: 'Stage', operator: 'equals', value: 'Closed Won' },
      { field: 'Closing_Date', operator: 'between', value: ['2026-07-01', '2026-07-31'] },
      { field: 'Amount', operator: 'greater_than', value: 50000 }
    ],
    sort: { field: 'Amount', order: 'desc' }
  });
  assert.equal(query, "select Deal_Name, Amount, Stage, Closing_Date from Deals where ((Stage = 'Closed Won') and (Closing_Date >= '2026-07-01' and Closing_Date <= '2026-07-31')) and (Amount > 50000) order by Amount desc");
});

test('does not quote numeric COQL values and rejects invalid date values', () => {
  const numericQuery = buildCoqlQuery({
    module: 'Deals',
    fields: ['Deal_Name', 'Amount'],
    filters: [{ field: 'Amount', operator: 'greater_equal', value: 10000 }]
  });
  assert.match(numericQuery, /Amount >= 10000/);
  assert.throws(() => buildCoqlQuery({
    module: 'Deals',
    fields: ['Closing_Date'],
    filters: [{ field: 'Closing_Date', operator: 'between', value: ['07/01/2026', '2026-07-31'] }]
  }), /YYYY-MM-DD/);
});

test('keeps numeric filter strings unquoted for comparison operators', () => {
  const query = buildCoqlQuery({
    module: 'Deals',
    fields: ['Deal_Name', 'Amount'],
    filters: [
      { field: 'Amount', operator: 'greater_than', value: '50000' },
      { field: 'Amount', operator: 'less_than', value: '100000' },
      { field: 'Amount', operator: 'greater_equal', value: '50000' },
      { field: 'Amount', operator: 'less_equal', value: '100000' },
      { field: 'Amount', operator: 'between', value: ['50000', '100000'] }
    ]
  });
  assert.match(query, /Amount > 50000/);
  assert.match(query, /Amount < 100000/);
  assert.match(query, /Amount >= 50000 and Amount <= 100000/);
  assert.doesNotMatch(query, /Amount [<>]=? '\d+'/);
});

test('supports Accounts filtered by Industry', () => {
  const query = buildCoqlQuery({
    module: 'Accounts',
    fields: ['Account_Name', 'Industry'],
    filters: [{ field: 'Industry', operator: 'equals', value: 'Technology' }]
  });
  assert.equal(query, "select Account_Name, Industry from Accounts where (Industry = 'Technology')");
});

test('supports Contacts filtered by Account_Name', () => {
  const query = buildCoqlQuery({
    module: 'Contacts',
    fields: ['First_Name', 'Last_Name', 'Account_Name'],
    filters: [{ field: 'Account_Name', operator: 'equals', value: 'Acme Corporation' }]
  });
  assert.equal(query, "select First_Name, Last_Name, Account_Name from Contacts where (Account_Name = 'Acme Corporation')");
});

test('supports Meetings filtered by date', () => {
  const query = buildCoqlQuery({
    module: 'Meetings',
    fields: ['Event_Title', 'Start_DateTime'],
    filters: [{ field: 'Start_DateTime', operator: 'greater_equal', value: '2026-08-20' }]
  });
  assert.equal(query, "select Event_Title, Start_DateTime from Events where (Start_DateTime >= '2026-08-20')");
});

test('supports Tasks filtered by due date', () => {
  const query = buildCoqlQuery({
    module: 'Tasks',
    fields: ['Subject', 'Due_Date'],
    filters: [{ field: 'Due_Date', operator: 'equals', value: '2026-08-20' }]
  });
  assert.equal(query, "select Subject, Due_Date from Tasks where (Due_Date = '2026-08-20')");
});

test('preserves first, second, and third pagination offsets in Zoho requests', async () => {
  const queries = [];
  const fakeClient = {
    post: async (url, body) => {
      if (url.includes('/oauth/v2/token')) return { data: { access_token: 'test-token', expires_in: 3600 } };
      queries.push(body.select_query);
      return { data: { data: [], info: { count: 0, more_records: false } } };
    }
  };
  const service = new ZohoCrmService(fakeClient, () => ({
    accountsUrl: 'https://accounts.zoho.com',
    apiBaseUrl: 'https://www.zohoapis.com/crm/v8',
    clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh', timeoutMs: 15000
  }));
  const request = { module: 'Deals', fields: ['Deal_Name'], filters: [], limit: 20 };
  await service.query({ ...request, offset: 0 });
  await service.query({ ...request, offset: 20 });
  await service.query({ ...request, offset: 40 });
  assert.match(queries[0], /limit 0, 20$/);
  assert.match(queries[1], /limit 20, 20$/);
  assert.match(queries[2], /limit 40, 20$/);
});

test('returns more_records false when Zoho reports no additional page', async () => {
  const zohoService = new ZohoCrmService({
    post: async (url) => url.includes('/oauth/v2/token')
      ? { data: { access_token: 'test-token', expires_in: 3600 } }
      : { data: { data: [{ id: '1' }], info: { count: 1, more_records: false } } }
  }, () => ({
    accountsUrl: 'https://accounts.zoho.com',
    apiBaseUrl: 'https://www.zohoapis.com/crm/v8',
    clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh', timeoutMs: 15000
  }));
  const service = new CrmService(zohoService);
  const result = await service.query({ module: 'Deals', fields: ['Deal_Name'], filters: [], limit: 20, offset: 20 });
  assert.equal(result.pagination.more_records, false);
});

test('preserves the original filters when requesting the next page', async () => {
  const queries = [];
  const zohoService = new ZohoCrmService({
    post: async (url, body) => {
      if (url.includes('/oauth/v2/token')) return { data: { access_token: 'test-token', expires_in: 3600 } };
      queries.push(body.select_query);
      return { data: { data: [], info: { count: 20, more_records: true } } };
    }
  }, () => ({
    accountsUrl: 'https://accounts.zoho.com',
    apiBaseUrl: 'https://www.zohoapis.com/crm/v8',
    clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh', timeoutMs: 15000
  }));
  const service = new CrmService(zohoService);
  const request = {
    module: 'Deals',
    fields: ['Deal_Name', 'Amount', 'Stage'],
    filters: [
      { field: 'Stage', operator: 'equals', value: 'Closed Won' },
      { field: 'Amount', operator: 'greater_than', value: '50000' }
    ],
    sort_field: 'Amount',
    sort_order: 'desc',
    limit: 20
  };
  await service.query({ ...request, offset: 0 });
  await service.query({ ...request, offset: 20 });
  const expectedQuery = "select Deal_Name, Amount, Stage from Deals where ((Stage = 'Closed Won') and (Amount > 50000)) order by Amount desc";
  assert.equal(queries[0], `${expectedQuery} limit 0, 20`);
  assert.equal(queries[1], `${expectedQuery} limit 20, 20`);
});

test('concurrent requests share one OAuth refresh request', async () => {
  let tokenCalls = 0;
  const fakeClient = {
    post: async (url) => {
      if (url.includes('/oauth/v2/token')) {
        tokenCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { data: { access_token: 'shared-token', expires_in: 3600 } };
      }
      return { data: { data: [], info: { count: 0, more_records: false } } };
    }
  };
  const service = new ZohoCrmService(fakeClient, () => ({
    accountsUrl: 'https://accounts.zoho.com',
    apiBaseUrl: 'https://www.zohoapis.com/crm/v8',
    clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh', timeoutMs: 15000
  }));
  const request = { module: 'Deals', fields: ['Deal_Name'], filters: [], limit: 20, offset: 0 };
  await Promise.all([service.query(request), service.query(request)]);
  assert.equal(tokenCalls, 1);
});
