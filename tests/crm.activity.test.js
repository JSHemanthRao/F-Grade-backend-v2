'use strict';
/**
 * CRM Activity Service – Full Test Suite
 *
 * Coverage:
 *  - Pure functions (no network): getTodayDateRange, toISTString, mapModuleToActivityType,
 *    normalizeAuditEntry, normalizeModuleRecord, normalizeAuditCSVRow, buildAuditExportCriteria
 *  - Mocked Zoho (axios + zohoClient): audit log export with scope mismatch → fallback,
 *    audit log export success path, multi-module search boundary, user filter, error propagation
 *  - Live integration: getActivity() against real Zoho CRM (flagged, opt-in)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');

// ── helpers ──────────────────────────────────────────────────────────────────

const LIVE = process.env.LIVE_TESTS === '1'; // skip live by default

// Produce a mock Zoho response object
function mockResponse(status, data) {
  return { status, data };
}

// Build a minimal 401 OAUTH_SCOPE_MISMATCH Axios error
function scopeError() {
  const err = new Error('Request failed with status code 401');
  err.response = {
    status: 401,
    data: { code: 'OAUTH_SCOPE_MISMATCH', message: 'invalid oauth scope to access this URL' },
  };
  return err;
}

// Minimal Axios 204 (no data) error-like response
function noContentResponse() {
  const err = new Error('204 No Content');
  err.response = { status: 204 };
  return err;
}

// ── imports ───────────────────────────────────────────────────────────────────

const {
  getTodayDateRange,
  toISTString,
  mapModuleToActivityType,
  normalizeAuditEntry,
  normalizeModuleRecord,
  normalizeAuditCSVRow,
  buildAuditExportCriteria,
  CRMActivityError,
  getActivity,
} = require('../src/crm/services/activity.service');

const metadataService = require('../src/crm/services/crm-metadata.service');

// ═══════════════════════════════════════════════════════════════════════════════
// 1. DATE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

test('1a. getTodayDateRange – half-open IST range for 2026-08-14', () => {
  const ref = new Date('2026-08-14T10:15:00Z'); // 15:45 IST → still 14 Aug IST
  const range = getTodayDateRange('Asia/Kolkata', ref);
  assert.equal(range.date, '2026-08-14');
  assert.equal(range.timezone, 'Asia/Kolkata');
  assert.equal(range.from, '2026-08-14T00:00:00+05:30');
  assert.equal(range.to,   '2026-08-15T00:00:00+05:30');
});

test('1b. getTodayDateRange – midnight boundary (23:59 UTC previous day = 05:29 IST same day)', () => {
  const ref = new Date('2026-08-13T23:59:00Z'); // 2026-08-14T05:29 IST
  const range = getTodayDateRange('Asia/Kolkata', ref);
  assert.equal(range.date, '2026-08-14');
  assert.equal(range.from, '2026-08-14T00:00:00+05:30');
  assert.equal(range.to,   '2026-08-15T00:00:00+05:30');
});

test('1c. toISTString – date-only → midnight IST', () => {
  assert.equal(toISTString('2026-08-14'), '2026-08-14T00:00:00+05:30');
});

test('1d. toISTString – already has +05:30 offset → unchanged', () => {
  const input = '2026-08-14T09:30:00+05:30';
  assert.equal(toISTString(input), input);
});

test('1e. toISTString – UTC midnight 2026-08-14 = 05:30 IST', () => {
  // 2026-08-14T00:00:00Z  →  2026-08-14T05:30:00+05:30
  assert.equal(toISTString('2026-08-14T00:00:00Z'), '2026-08-14T05:30:00+05:30');
});

test('1f. toISTString – UTC 18:30 prev day = IST midnight same day', () => {
  // 2026-08-13T18:30:00Z  →  2026-08-14T00:00:00+05:30
  assert.equal(toISTString('2026-08-13T18:30:00Z'), '2026-08-14T00:00:00+05:30');
});

test('1g. toISTString – handles null/undefined gracefully', () => {
  assert.equal(toISTString(null), null);
  assert.equal(toISTString(undefined), null);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. MODULE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

test('2a. mapModuleToActivityType – all supported modules', () => {
  const table = [
    ['Deals', 'deal'],
    ['Meetings', 'meeting'],
    ['Events', 'meeting'],
    ['Notes', 'note'],
    ['Tasks', 'task'],
    ['Calls', 'call'],
    ['Leads', 'lead'],
    ['Contacts', 'contact'],
    ['Accounts', 'account'],
    ['Unknown', 'record_change'],
  ];
  for (const [input, expected] of table) {
    assert.equal(mapModuleToActivityType(input), expected, `Failed for: ${input}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. NORMALIZERS
// ═══════════════════════════════════════════════════════════════════════════════

test('3a. normalizeAuditEntry – done_by variant', () => {
  const entry = {
    done_by: { id: 'usr_1', name: 'Sanjay' },
    module: { api_name: 'Deals' },
    record: { id: 'rec_1', name: 'ACME Deal' },
    action: 'updated',
    audited_time: '2026-08-14T10:00:00+05:30',
    source: 'crm_ui',
    field_history: [
      { api_name: 'Stage', _value: { old: 'Prospecting', new: 'Proposal Sent' } },
    ],
  };
  const n = normalizeAuditEntry(entry);
  assert.equal(n.user_id, 'usr_1');
  assert.equal(n.user_name, 'Sanjay');
  assert.equal(n.module_api_name, 'Deals');
  assert.equal(n.action, 'updated');
  assert.equal(n.field, 'Stage');
  assert.equal(n.new_value, 'Proposal Sent');
  assert.equal(n.old_value, 'Prospecting');
  assert.equal(n.audited_time, '2026-08-14T10:00:00+05:30');
});

test('3b. normalizeAuditEntry – audited_by fallback variant', () => {
  const entry = {
    audited_by: { id: 'usr_2', name: 'Phanindra Kumar' },
    module: 'Notes',
    record: { id: 'rec_2', name: 'Follow-up note' },
    action: 'added',
    audited_time: '2026-08-14T11:00:00+05:30',
  };
  const n = normalizeAuditEntry(entry);
  assert.equal(n.user_name, 'Phanindra Kumar');
  assert.equal(n.action, 'added');
  assert.equal(n.activity_type, 'note');
});

test('3c. normalizeAuditEntry – null input returns null', () => {
  assert.equal(normalizeAuditEntry(null), null);
});

test('3d. normalizeModuleRecord – create action', () => {
  const record = {
    id: 'rec_3',
    First_Name: 'Test',
    Last_Name: 'Lead',
    Created_Time: '2026-08-14T08:00:00+05:30',
    Modified_Time: '2026-08-14T08:00:00+05:30',
    Created_By: { id: 'usr_5', name: 'Sanjay' },
    Owner: { id: 'usr_5', name: 'Sanjay' },
  };
  const n = normalizeModuleRecord(record, 'Leads', 'created');
  assert.equal(n.user_name, 'Sanjay');
  assert.equal(n.action, 'created');
  assert.equal(n.activity_type, 'lead');
  assert.equal(n.audited_time, '2026-08-14T08:00:00+05:30');
});

test('3e. normalizeModuleRecord – Note.added action', () => {
  const record = {
    id: 'rec_4',
    Note_Title: 'Follow-up Call',
    Note_Content: 'Discussed the proposal in detail.',
    Created_Time: '2026-08-14T12:00:00+05:30',
    Modified_Time: '2026-08-14T12:00:00+05:30',
    Created_By: { id: 'usr_6', name: 'Developer Dept' },
  };
  const n = normalizeModuleRecord(record, 'Notes', 'created');
  assert.equal(n.activity_type, 'note');
  assert.equal(n.action, 'added');
  assert.equal(n.record_name, 'Follow-up Call');
});

test('3f. normalizeAuditCSVRow – standard CSV row shape', () => {
  const row = {
    'User ID': 'usr_10',
    'User Name': 'Sanjay',
    'Module': 'Deals',
    'Action': 'updated',
    'Audited Time': '2026-08-14T14:30:00+05:30',
    'Record ID': 'rec_10',
    'Record Name': 'Big Deal',
    'Field': 'Stage',
    'Old Value': 'Prospecting',
    'New Value': 'Closed Won',
    'Source': 'crm_ui',
  };
  const n = normalizeAuditCSVRow(row);
  assert.equal(n.user_id, 'usr_10');
  assert.equal(n.user_name, 'Sanjay');
  assert.equal(n.action, 'updated');
  assert.equal(n.field, 'Stage');
  assert.equal(n.new_value, 'Closed Won');
});

test('3g. normalizeAuditCSVRow – missing User Name returns null', () => {
  const row = { Module: 'Deals', Action: 'created' };
  assert.equal(normalizeAuditCSVRow(row), null);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. AUDIT EXPORT CRITERIA BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

test('4a. buildAuditExportCriteria – date-only criteria', () => {
  const criteria = buildAuditExportCriteria(
    '2026-08-14T00:00:00+05:30',
    '2026-08-15T00:00:00+05:30'
  );
  assert.ok(Array.isArray(criteria.group));
  assert.equal(criteria.group_operator, 'and');
  const dateFilter = criteria.group[0];
  assert.equal(dateFilter.field.api_name, 'audited_time');
  assert.equal(dateFilter.comparator, 'between');
  assert.deepEqual(dateFilter.value, ['2026-08-14T00:00:00+05:30', '2026-08-15T00:00:00+05:30']);
  assert.equal(criteria.group.length, 1); // no user, module, action filters
});

test('4b. buildAuditExportCriteria – with user, module, action filters', () => {
  const criteria = buildAuditExportCriteria(
    '2026-08-14T00:00:00+05:30',
    '2026-08-15T00:00:00+05:30',
    { user_id: 'usr_1', module: 'Deals', action: 'updated' }
  );
  assert.equal(criteria.group.length, 4);
  assert.equal(criteria.group[1].field.api_name, 'done_by');
  assert.equal(criteria.group[1].value, 'usr_1');
  assert.equal(criteria.group[2].field.api_name, 'module');
  assert.equal(criteria.group[2].value, 'Deals');
  assert.equal(criteria.group[3].field.api_name, 'action');
  assert.equal(criteria.group[3].value, 'updated');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. MOCKED STRATEGY TESTS
// ═══════════════════════════════════════════════════════════════════════════════

// Helper: patch zohoClient.post and .get for a single test
function withMockedZoho({ postFn, getFn, onRestore } = {}) {
  const zohoClient = require('../src/common/config/axios').zohoClient;
  const originalPost = zohoClient.post.bind(zohoClient);
  const originalGet = zohoClient.get.bind(zohoClient);

  if (postFn) zohoClient.post = postFn;
  if (getFn) zohoClient.get = getFn;

  return function restore() {
    zohoClient.post = originalPost;
    zohoClient.get = originalGet;
    if (onRestore) onRestore();
  };
}

test('5a. Scope mismatch → falls back to multi-module search and returns count > 0', async () => {
  const zohoClient = require('../src/common/config/axios').zohoClient;

  let postCallCount = 0;
  let getCallCount = 0;

  const originalPost = zohoClient.post;
  const originalGet = zohoClient.get;

  // POST audit_log_export → 401 OAUTH_SCOPE_MISMATCH
  zohoClient.post = async (url) => {
    if (url.includes('audit_log_export')) {
      postCallCount++;
      throw scopeError();
    }
    return originalPost.call(zohoClient, url);
  };

  // GET /search → return 2 records; GET /__timeline → return empty
  zohoClient.get = async (url, config) => {
    if (url.endsWith('/search')) {
      getCallCount++;
      // Return 2 lead records created/modified today
      return mockResponse(200, {
        data: [
          {
            id: 'rec_A',
            First_Name: 'Ronak', Last_Name: 'Shah',
            Created_Time: '2026-08-14T09:00:00+05:30',
            Modified_Time: '2026-08-14T09:00:00+05:30',
            Created_By: { id: 'usr_1', name: 'Sanjay' },
            Modified_By: { id: 'usr_1', name: 'Sanjay' },
            Owner: { id: 'usr_1', name: 'Sanjay' },
          },
          {
            id: 'rec_B',
            First_Name: 'Priya', Last_Name: 'Sharma',
            Created_Time: '2026-08-14T10:30:00+05:30',
            Modified_Time: '2026-08-14T10:30:00+05:30',
            Created_By: { id: 'usr_2', name: 'Phanindra Kumar' },
            Modified_By: { id: 'usr_2', name: 'Phanindra Kumar' },
            Owner: { id: 'usr_2', name: 'Phanindra Kumar' },
          },
        ],
      });
    }
    if (url.includes('__timeline')) {
      return mockResponse(200, { __timeline: [] });
    }
    // Handle any other GET (204 empty modules)
    const err = new Error('204');
    err.response = { status: 204 };
    throw err;
  };

  let result;
  try {
    result = await getActivity({ from: '2026-08-14', to: '2026-08-15' });
  } finally {
    zohoClient.post = originalPost;
    zohoClient.get = originalGet;
  }

  assert.equal(result.success, true);
  assert.equal(result.strategy, 'multi_module_search');
  assert.ok(result.count > 0, `Expected count > 0, got ${result.count}`);
  assert.ok(postCallCount >= 1, 'Expected at least one POST to audit_log_export');
  assert.ok(getCallCount > 0, 'Expected GET calls for multi-module search');
});

test('5b. Non-scope export failure → throws CRMActivityError (not count=0)', async () => {
  const zohoClient = require('../src/common/config/axios').zohoClient;
  const originalPost = zohoClient.post;

  // POST audit_log_export → 500 server error (not scope mismatch)
  zohoClient.post = async (url) => {
    if (url.includes('audit_log_export')) {
      const err = new Error('Internal Server Error');
      err.response = { status: 500, data: { code: 'INTERNAL_ERROR', message: 'unexpected error' } };
      throw err;
    }
    return originalPost.call(zohoClient, url);
  };

  try {
    await getActivity({ from: '2026-08-14' });
    assert.fail('Expected getActivity to throw on non-scope export failure');
  } catch (err) {
    assert.ok(err instanceof CRMActivityError, `Expected CRMActivityError, got: ${err.constructor.name}`);
    assert.ok(err.message.includes('audit log export'), `Unexpected message: ${err.message}`);
  } finally {
    zohoClient.post = originalPost;
  }
});

test('5c. All search modules return 204 → count=0 (no data today)', async () => {
  const zohoClient = require('../src/common/config/axios').zohoClient;
  const originalPost = zohoClient.post;
  const originalGet = zohoClient.get;

  zohoClient.post = async (url) => {
    if (url.includes('audit_log_export')) throw scopeError();
    return originalPost.call(zohoClient, url);
  };

  zohoClient.get = async (url) => {
    if (url.endsWith('/search')) return mockResponse(204, null);
    // shouldn't be called for timeline
    return mockResponse(200, { __timeline: [] });
  };

  let result;
  try {
    result = await getActivity({ from: '2026-08-14' });
  } finally {
    zohoClient.post = originalPost;
    zohoClient.get = originalGet;
  }

  assert.equal(result.success, true);
  assert.equal(result.count, 0);
  assert.deepEqual(result.data, []);
});

test('5d. Half-open boundary: record at 2026-08-15T00:00:00+05:30 (= to) is excluded', async () => {
  const zohoClient = require('../src/common/config/axios').zohoClient;
  const originalPost = zohoClient.post;
  const originalGet = zohoClient.get;

  zohoClient.post = async (url) => {
    if (url.includes('audit_log_export')) throw scopeError();
    return originalPost.call(zohoClient, url);
  };

  zohoClient.get = async (url) => {
    if (url.endsWith('/search')) {
      return mockResponse(200, {
        data: [
          {
            id: 'rec_midnight',
            First_Name: 'Edge', Last_Name: 'Case',
            // EXACTLY at `to` boundary — should be EXCLUDED
            Created_Time: '2026-08-15T00:00:00+05:30',
            Modified_Time: '2026-08-15T00:00:00+05:30',
            Created_By: { id: 'usr_3', name: 'TestUser' },
            Owner: { id: 'usr_3', name: 'TestUser' },
          },
        ],
      });
    }
    return mockResponse(200, { __timeline: [] });
  };

  let result;
  try {
    result = await getActivity({
      from: '2026-08-14T00:00:00+05:30',
      to: '2026-08-15T00:00:00+05:30',
    });
  } finally {
    zohoClient.post = originalPost;
    zohoClient.get = originalGet;
  }

  assert.equal(result.count, 0, 'Record at boundary (to) must be excluded from half-open range');
});

test('5e. Half-open boundary: record at 2026-08-14T23:59:59+05:30 (inside) is INCLUDED', async () => {
  const zohoClient = require('../src/common/config/axios').zohoClient;
  const originalPost = zohoClient.post;
  const originalGet = zohoClient.get;

  zohoClient.post = async (url) => {
    if (url.includes('audit_log_export')) throw scopeError();
    return originalPost.call(zohoClient, url);
  };

  zohoClient.get = async (url) => {
    if (url.endsWith('/search')) {
      return mockResponse(200, {
        data: [
          {
            id: 'rec_last',
            First_Name: 'Late', Last_Name: 'Night',
            Created_Time: '2026-08-14T23:59:59+05:30',
            Modified_Time: '2026-08-14T23:59:59+05:30',
            Created_By: { id: 'usr_4', name: 'NightOwl' },
            Owner: { id: 'usr_4', name: 'NightOwl' },
          },
        ],
      });
    }
    return mockResponse(200, { __timeline: [] });
  };

  let result;
  try {
    result = await getActivity({
      from: '2026-08-14T00:00:00+05:30',
      to: '2026-08-15T00:00:00+05:30',
    });
  } finally {
    zohoClient.post = originalPost;
    zohoClient.get = originalGet;
  }

  assert.ok(result.count > 0, 'Record at 23:59:59 (before boundary) must be included');
});

test('5f. User filter: only returns records for the requested user', async () => {
  const zohoClient = require('../src/common/config/axios').zohoClient;
  const originalPost = zohoClient.post;
  const originalGet = zohoClient.get;

  zohoClient.post = async (url) => {
    if (url.includes('audit_log_export')) throw scopeError();
    return originalPost.call(zohoClient, url);
  };

  zohoClient.get = async (url) => {
    if (url.endsWith('/search')) {
      return mockResponse(200, {
        data: [
          {
            id: 'rec_s1',
            Deal_Name: 'Sanjay Deal',
            Created_Time: '2026-08-14T09:00:00+05:30',
            Modified_Time: '2026-08-14T09:00:00+05:30',
            Created_By: { id: 'usr_sanjay', name: 'Sanjay' },
            Modified_By: { id: 'usr_sanjay', name: 'Sanjay' },
            Owner: { id: 'usr_sanjay', name: 'Sanjay' },
          },
          {
            id: 'rec_p1',
            Deal_Name: 'Phanindra Deal',
            Created_Time: '2026-08-14T10:00:00+05:30',
            Modified_Time: '2026-08-14T10:00:00+05:30',
            Created_By: { id: 'usr_phan', name: 'Phanindra Kumar' },
            Modified_By: { id: 'usr_phan', name: 'Phanindra Kumar' },
            Owner: { id: 'usr_phan', name: 'Phanindra Kumar' },
          },
        ],
      });
    }
    return mockResponse(200, { __timeline: [] });
  };

  // Patch metadataService.resolveUser to avoid a live call
  const origResolveUser = metadataService.resolveUser;
  metadataService.resolveUser = async (nameOrId) => ({ id: 'usr_sanjay', name: 'Sanjay' });

  let result;
  try {
    result = await getActivity({
      from: '2026-08-14T00:00:00+05:30',
      to: '2026-08-15T00:00:00+05:30',
      user: 'Sanjay',
    });
  } finally {
    zohoClient.post = originalPost;
    zohoClient.get = originalGet;
    metadataService.resolveUser = origResolveUser;
  }

  assert.ok(result.count > 0, 'Expected at least one result for Sanjay');
  for (const act of result.data) {
    assert.equal(
      act.user_name.toLowerCase(),
      'sanjay',
      `Expected all activities to belong to Sanjay, got: ${act.user_name}`
    );
  }
});

test('5g. Copilot UTC input is correctly converted to IST for boundary check', async () => {
  // Copilot may pass from="2026-08-13T18:30:00Z" (UTC midnight IST)
  // and to="2026-08-14T18:30:00Z" (UTC end of day IST)
  const from = '2026-08-13T18:30:00Z';
  const to = '2026-08-14T18:30:00Z';

  const fromIST = toISTString(from);
  const toIST = toISTString(to);

  assert.equal(fromIST, '2026-08-14T00:00:00+05:30', 'UTC midnight should map to IST 00:00');
  assert.equal(toIST, '2026-08-15T00:00:00+05:30', 'UTC next-day midnight should map to IST 00:00 next day');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. LIVE INTEGRATION (opt-in via LIVE_TESTS=1)
// ═══════════════════════════════════════════════════════════════════════════════

test('6a. [LIVE] getActivity() returns count > 0 for today in Asia/Kolkata', { skip: !LIVE }, async () => {
  const result = await getActivity({});
  assert.equal(result.success, true);
  assert.ok(result.count > 0, `Expected live count > 0, got ${result.count}`);
  assert.ok(Array.isArray(result.data));
  assert.ok(['multi_module_search', 'audit_log_export'].includes(result.strategy));

  // Each activity must have required fields
  for (const act of result.data) {
    assert.ok(act.user_name, `Missing user_name on activity: ${JSON.stringify(act)}`);
    assert.ok(act.audited_time, `Missing audited_time on activity: ${JSON.stringify(act)}`);
    assert.ok(act.module, `Missing module on activity: ${JSON.stringify(act)}`);
    assert.ok(act.action, `Missing action on activity: ${JSON.stringify(act)}`);

    // All times must be within today's IST boundary
    const todayRange = getTodayDateRange('Asia/Kolkata');
    const fromMs = new Date(todayRange.from).valueOf();
    const toMs = new Date(todayRange.to).valueOf();
    const actMs = new Date(act.audited_time).valueOf();

    assert.ok(
      actMs >= fromMs && actMs < toMs,
      `Activity time ${act.audited_time} is outside today's range [${todayRange.from}, ${todayRange.to})`
    );
  }
});

test('6b. [LIVE] User filter: "Phanindra" returns only Phanindra\'s activities', { skip: !LIVE }, async () => {
  const result = await getActivity({ user: 'Phanindra' });
  assert.equal(result.success, true);
  for (const act of result.data) {
    assert.ok(
      act.user_name.toLowerCase().includes('phanindra'),
      `Expected Phanindra activities only, got: ${act.user_name}`
    );
  }
});

test('6c. [LIVE] CRMActivityError has isScopeMismatch for audit log on current token', { skip: !LIVE }, async () => {
  // The service should log scope mismatch and successfully fall back — not throw
  const result = await getActivity({});
  assert.equal(result.strategy, 'multi_module_search', 'Expected fallback strategy due to scope mismatch');
  assert.equal(result.success, true);
});
