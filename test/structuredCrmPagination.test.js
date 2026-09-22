const test = require('node:test');
const assert = require('node:assert/strict');
const { createCrmController } = require('../src/controllers/crm.controller');
const { normalizeStructuredCrmRequest } = require('../src/validators/structuredCrmRequest.validator');
const { PaginationEngine } = require('../src/pagination/paginationEngine');
const { buildCoqlPagination } = require('../src/coql/coqlPagination');

function crmJson({ module = 'Deals', limit = 20, offset = 0, fields = ['Deal_Name', 'Account_Name', 'Stage', 'Amount', 'Created_Time'], fingerprint } = {}) {
  return {
    schema_version: '1.0',
    request: { module, operation: 'list' },
    query: {
      fields,
      filters: {
        Created_Time: { operator: 'this_month' }
      },
      sort: [
        { field: 'Created_Time', order: 'desc' },
        { field: 'id', order: 'desc' }
      ]
    },
    pagination: { limit, offset },
    ...(fingerprint ? { query_context: { fingerprint } } : {})
  };
}

function responseRecorder() {
  const recorder = { statusCode: 200, body: null };
  return {
    recorder,
    res: {
      status: (code) => {
        recorder.statusCode = code;
        return {
          json: (value) => {
            recorder.body = value;
            return value;
          }
        };
      },
      json: (value) => {
        recorder.body = value;
        return value;
      }
    }
  };
}

test('structured CRM request normalizes pagination, semantic dates, stable sort, and fingerprint', () => {
  const normalized = normalizeStructuredCrmRequest(crmJson({ offset: 40, limit: 20 }));

  assert.equal(normalized.plan.module, 'Deals');
  assert.equal(normalized.plan.offset, 40);
  assert.equal(normalized.plan.limit, 20);
  assert.deepEqual(normalized.plan.sort.map((item) => [item.field, item.order]), [['Created_Time', 'desc'], ['id', 'desc']]);
  assert.equal(normalized.plan.filters[0].field, 'Created_Time');
  assert.equal(normalized.plan.filters[0].operator, 'between');
  assert.equal(normalized.plan.filters[0].exclusive_end, true);
  assert.match(normalized.query_fingerprint, /^[0-9a-f]{64}$/);
});

test('structured CRM request rejects malformed pagination before Zoho execution', () => {
  assert.throws(
    () => normalizeStructuredCrmRequest(crmJson({ offset: -1 })),
    (error) => error.code === 'INVALID_PAGINATION' && /offset/.test(error.message)
  );
  assert.throws(
    () => normalizeStructuredCrmRequest(crmJson({ limit: 0 })),
    (error) => error.code === 'INVALID_PAGINATION' && /limit/.test(error.message)
  );
  assert.throws(
    () => normalizeStructuredCrmRequest({ ...crmJson(), pagination: { limit: 'twenty', offset: 0 } }),
    (error) => error.code === 'INVALID_PAGINATION' && /limit/.test(error.message)
  );
});

test('structured CRM request validates optional query fingerprint continuity', () => {
  const first = normalizeStructuredCrmRequest(crmJson());
  assert.doesNotThrow(() => normalizeStructuredCrmRequest(crmJson({ offset: 20, fingerprint: first.query_fingerprint })));
  assert.throws(
    () => normalizeStructuredCrmRequest(crmJson({ module: 'Leads', offset: 20, fingerprint: first.query_fingerprint })),
    (error) => error.code === 'QUERY_CONTEXT_MISMATCH'
  );
});

test('single nested CRM request object is the canonical schema contract', () => {
  const body = {
    schema_version: '1.0',
    request: {
      module: 'Deals',
      operation: 'list',
      query: {
        fields: [],
        filters: { Created_Time: { operator: 'this_month' } },
        sort: [
          { field: 'Created_Time', order: 'desc' },
          { field: 'id', order: 'desc' }
        ]
      },
      pagination: { limit: 20, offset: 0 }
    }
  };

  const normalized = normalizeStructuredCrmRequest(body);
  assert.equal(normalized.plan.module, 'Deals');
  assert.equal(normalized.plan.offset, 0);
  assert.equal(normalized.plan.limit, 20);
  assert.deepEqual(normalized.plan.sort.map((item) => [item.field, item.order]), [['Created_Time', 'desc'], ['id', 'desc']]);
});

test('pagination engine advances from actual returned count for short pages and limit changes', () => {
  const engine = new PaginationEngine();
  assert.deepEqual(engine.buildPaginationMetadata({ offset: 0, limit: 20, returned: 13, hasMore: true }), {
    offset: 0,
    limit: 20,
    returned: 13,
    next_offset: 13,
    has_more: true,
    more_records: true
  });
  assert.deepEqual(engine.normalizePagination({ offset: 20, limit: 50 }), { offset: 20, limit: 50 });
});

test('structured assistant executes offset sequence 0 -> 20 -> 40 -> 60 without tokens', async () => {
  const calls = [];
  const controller = createCrmController({
    query: async (input) => {
      calls.push(input);
      const offset = input.offset;
      return {
        module: input.module,
        module_api_name: input.module,
        request_type: input.request_type,
        fields: input.fields,
        filters: input.filters,
        sort: input.sort,
        data: Array.from({ length: 20 }, (_, index) => ({ id: `${input.module}-${offset + index + 1}` })),
        pagination: { limit: input.limit, offset, returned: 20, more_records: true }
      };
    }
  });

  const bodies = [crmJson({ offset: 0 }), crmJson({ offset: 20 }), crmJson({ offset: 40 }), crmJson({ offset: 60 })];
  const responses = [];
  for (const body of bodies) {
    const { recorder, res } = responseRecorder();
    await controller.assistant({ body, method: 'POST', originalUrl: '/api/crm/assistant' }, res, (error) => { throw error; });
    responses.push(recorder.body);
  }

  assert.deepEqual(calls.map((call) => call.offset), [0, 20, 40, 60]);
  assert.deepEqual(calls.map((call) => call.limit), [20, 20, 20, 20]);
  assert.deepEqual(responses.map((body) => body.pagination.next_offset), [20, 40, 60, 80]);
  assert.ok(responses.every((body) => !Object.prototype.hasOwnProperty.call(body, 'continuation_token')));
  assert.ok(responses.every((body) => !Object.prototype.hasOwnProperty.call(body, 'conversation_id')));
});

test('structured assistant resets offset for a new module query', async () => {
  const calls = [];
  const controller = createCrmController({
    query: async (input) => {
      calls.push(input);
      return {
        module: input.module,
        module_api_name: input.module,
        request_type: input.request_type,
        fields: input.fields,
        filters: input.filters,
        sort: input.sort,
        data: Array.from({ length: 20 }, (_, index) => ({ id: `${input.module}-${input.offset + index + 1}` })),
        pagination: { limit: input.limit, offset: input.offset, returned: 20, more_records: true }
      };
    }
  });

  for (const body of [crmJson({ module: 'Deals', offset: 40 }), crmJson({ module: 'Leads', offset: 0 }), crmJson({ module: 'Leads', offset: 20 })]) {
    const { res } = responseRecorder();
    await controller.assistant({ body, method: 'POST', originalUrl: '/api/crm/assistant' }, res, (error) => { throw error; });
  }

  assert.deepEqual(calls.map((call) => [call.module, call.offset, call.limit]), [['Deals', 40, 20], ['Leads', 0, 20], ['Leads', 20, 20]]);
});

test('COQL pagination remains deterministic limit offset syntax', () => {
  assert.equal(buildCoqlPagination(20, 0), ' limit 0, 20');
  assert.equal(buildCoqlPagination(20, 20), ' limit 20, 20');
  assert.equal(buildCoqlPagination(20, 40), ' limit 40, 20');
  assert.equal(buildCoqlPagination(20, 60), ' limit 60, 20');
});
