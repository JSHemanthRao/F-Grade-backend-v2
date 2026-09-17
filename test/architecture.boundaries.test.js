const test = require('node:test');
const assert = require('node:assert/strict');
const { PaginationManager } = require('../src/pagination/paginationManager');
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
