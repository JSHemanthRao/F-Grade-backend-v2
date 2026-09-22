const test = require('node:test');
const assert = require('node:assert/strict');
const { PaginationManager, pageIdentity } = require('../src/pagination/paginationManager');
const { buildCoqlPagination, validateCoqlPagination } = require('../src/coql/coqlPagination');
const { createQueryIdentity } = require('../src/query/pagination');

function plan(offset = 0, limit = 20) {
  return { domain: 'CRM', module: 'Leads', module_api_name: 'Leads', fields: ['id'], filters: [], sort: null, pagination: { offset, limit }, offset, limit };
}

test('COQL pagination validates and formats one shared limit/offset boundary', () => {
  assert.deepEqual(validateCoqlPagination(50, 20), { limit: 50, offset: 20 });
  assert.equal(buildCoqlPagination(50, 20), ' limit 20, 50');
  assert.throws(() => validateCoqlPagination(0, 0), /limit/);
  assert.throws(() => validateCoqlPagination(20, -1), /offset/);
});

test('pagination manager advances from actual returned count and preserves query identity', () => {
  const manager = new PaginationManager();
  const firstPlan = plan(0, 20);
  manager.save('conversation-a', firstPlan, { data: [{ id: 'lead-1' }, { id: 'lead-2' }], pagination: { returned: 2, more_records: true } }, 'request-1', 'show me leads');
  const previous = manager.get('conversation-a');
  const next = manager.planContinuation('next 50', previous);
  assert.equal(next.offset, 2);
  assert.equal(next.limit, 50);
  assert.equal(createQueryIdentity(firstPlan), createQueryIdentity(next));
});

test('pagination manager produces deterministic 20-record offsets without mutating prior state', () => {
  const manager = new PaginationManager({ tokenTtlMs: 60_000 });
  const firstPlan = plan(0, 20);
  const first = manager.save('conversation-pages', firstPlan, { data: Array.from({ length: 20 }, (_, index) => ({ id: `lead-${index}` })), info: { count: 20, more_records: true } }, 'request-1', 'show me leads');
  const secondPlan = { ...first.canonical_plan, ...manager.advance(first, 20), pagination: { ...first.pagination, ...manager.advance(first, 20) } };
  const second = manager.save('conversation-pages', secondPlan, { data: Array.from({ length: 20 }, (_, index) => ({ id: `lead-${index + 20}` })), info: { count: 20, more_records: true } }, 'request-2', 'next 20', first);
  const thirdPlan = { ...second.canonical_plan, ...manager.advance(second, 20), pagination: { ...second.pagination, ...manager.advance(second, 20) } };
  const third = manager.save('conversation-pages', thirdPlan, { data: Array.from({ length: 20 }, (_, index) => ({ id: `lead-${index + 40}` })), info: { count: 20, more_records: true } }, 'request-3', 'next 20', second);
  const fourthPlan = { ...third.canonical_plan, ...manager.advance(third, 20), pagination: { ...third.pagination, ...manager.advance(third, 20) } };
  const fourth = manager.save('conversation-pages', fourthPlan, { data: Array.from({ length: 20 }, (_, index) => ({ id: `lead-${index + 60}` })), info: { count: 20, more_records: true } }, 'request-4', 'next 20', third);

  assert.deepEqual([first.pagination.offset, second.pagination.offset, third.pagination.offset, fourth.pagination.offset], [0, 20, 40, 60]);
  assert.equal(first.pagination.offset, 0);
  assert.equal(first.query_fingerprint, second.query_fingerprint);
  assert.equal(second.query_fingerprint, third.query_fingerprint);
  assert.notEqual(first, second);
  assert.notEqual(second, third);
  assert.equal(second.canonical_query.module, 'Leads');
  assert.equal(second.pagination.more_records, true);
});

test('pagination manager uses actual short-page count and requested next limit', () => {
  const manager = new PaginationManager();
  const first = manager.save('conversation-short', plan(0, 20), { data: Array.from({ length: 13 }, (_, index) => ({ id: `lead-${index}` })), info: { count: 13, more_records: true } }, 'request-1', 'show me leads');
  assert.deepEqual(manager.advance(first, 50), { offset: 13, limit: 50 });
});

test('pagination manager detects duplicate pages by ordered record identity', () => {
  const manager = new PaginationManager();
  const first = manager.save('conversation-duplicate', plan(), { data: [{ id: 'a' }, { id: 'b' }], info: { count: 2, more_records: true } }, 'request-1', 'show me leads');
  const nextPlan = { ...first.canonical_plan, ...manager.advance(first, 20), pagination: { ...first.pagination, ...manager.advance(first, 20) } };
  assert.throws(() => manager.save('conversation-duplicate', nextPlan, { data: [{ id: 'a' }, { id: 'b' }], info: { count: 2, more_records: true } }, 'request-2', 'next 20', first), (error) => error.code === 'PAGINATION_DUPLICATE_PAGE');
  assert.equal(pageIdentity(['a', 'b']), pageIdentity(['a', 'b']));
});

test('pagination manager stops advancement when CRM reports no more records', () => {
  const manager = new PaginationManager();
  const state = manager.save('conversation-end', plan(), { data: [{ id: 'a' }], info: { count: 1, more_records: false } }, 'request-1', 'show me leads');
  assert.equal(manager.advance(state, 20), null);
});
