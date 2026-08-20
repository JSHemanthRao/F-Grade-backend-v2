const test = require('node:test');
const assert = require('node:assert/strict');
const { ZohoCrmService } = require('../src/services/zohoCrm.service');
const { buildCoqlQuery } = require('../src/services/coql.service');
const { ZohoAuthService, EXPIRY_BUFFER_MS } = require('../src/services/zohoAuth.service');
const { CrmService } = require('../src/services/crm.service');

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

test('preserves pagination offsets 0 and 20 in Zoho requests', async () => {
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
  assert.match(queries[0], /limit 0, 20$/);
  assert.match(queries[1], /limit 20, 20$/);
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
