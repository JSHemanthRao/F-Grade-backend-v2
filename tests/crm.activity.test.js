const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');

const {
  getActivity,
  getTodayDateRange,
  normalizeAuditEntry,
  normalizeModuleRecord,
  mapModuleToActivityType,
} = require('../src/crm/services/activity.service');
const metadataService = require('../src/crm/services/crm-metadata.service');
const { formatActivityResponse } = require('../src/crm/services/assistant/activity-formatter.service');
const assistantEngine = require('../src/crm/services/assistant-engine.service');
const crmRouter = require('../src/crm/routes');

test('1. getTodayDateRange calculates half-open date range in Asia/Kolkata timezone', () => {
  const refDate = new Date('2026-08-14T10:15:00Z');
  const range = getTodayDateRange('Asia/Kolkata', refDate);

  assert.equal(range.date, '2026-08-14');
  assert.equal(range.timezone, 'Asia/Kolkata');
  assert.equal(range.from, '2026-08-14T00:00:00+05:30');
  assert.equal(range.to, '2026-08-15T00:00:00+05:30');
});

test('2. metadataService resolves user by name or ID and maps module labels/API names', async () => {
  const user = await metadataService.resolveUser('Sanjay');
  assert.ok(user);
  assert.equal(typeof user.id, 'string');
  assert.equal(typeof user.name, 'string');

  assert.equal(metadataService.resolveModuleApiName('deals'), 'Deals');
  assert.equal(metadataService.resolveModuleLabel('Deals'), 'Deals');
});

test('3. mapModuleToActivityType correctly maps modules', () => {
  assert.equal(mapModuleToActivityType('Deals'), 'deal');
  assert.equal(mapModuleToActivityType('Meetings'), 'meeting');
  assert.equal(mapModuleToActivityType('Notes'), 'note');
  assert.equal(mapModuleToActivityType('Tasks'), 'task');
  assert.equal(mapModuleToActivityType('Calls'), 'call');
  assert.equal(mapModuleToActivityType('Leads'), 'lead');
  assert.equal(mapModuleToActivityType('Contacts'), 'contact');
  assert.equal(mapModuleToActivityType('Accounts'), 'account');
});

test('4. normalizeAuditEntry normalizes Zoho audit log items correctly', () => {
  const mockAuditItem = {
    audited_by: { id: 'usr_101', name: 'Sanjay' },
    module: 'Deals',
    record: { id: 'rec_501', name: 'ABC Project' },
    action: 'created',
    audited_time: '2026-08-14T10:15:00+05:30',
    source: 'crm_ui',
  };

  const normalized = normalizeAuditEntry(mockAuditItem);
  assert.equal(normalized.user_id, 'usr_101');
  assert.equal(normalized.user_name, 'Sanjay');
  assert.equal(normalized.module, 'Deals');
  assert.equal(normalized.module_api_name, 'Deals');
  assert.equal(normalized.record_id, 'rec_501');
  assert.equal(normalized.record_name, 'ABC Project');
  assert.equal(normalized.action, 'created');
  assert.equal(normalized.activity_type, 'deal');
  assert.equal(normalized.audited_time, '2026-08-14T10:15:00+05:30');
});

test('5. normalizeModuleRecord normalizes Zoho CRM module records correctly', () => {
  const mockDeal = {
    id: 'deal_99',
    Deal_Name: 'XYZ Deal',
    Created_By: { id: 'usr_101', name: 'Sanjay' },
    Created_Time: '2026-08-14T11:30:00+05:30',
  };

  const normalized = normalizeModuleRecord(mockDeal, 'Deals', 'created');
  assert.equal(normalized.user_id, 'usr_101');
  assert.equal(normalized.user_name, 'Sanjay');
  assert.equal(normalized.module, 'Deals');
  assert.equal(normalized.record_name, 'XYZ Deal');
  assert.equal(normalized.action, 'created');
  assert.equal(normalized.activity_type, 'deal');
});

test('6. formatActivityResponse generates natural language daily report and tables', () => {
  const mockActivityResult = {
    success: true,
    date: '2026-08-14',
    timezone: 'Asia/Kolkata',
    count: 4,
    data: [
      {
        user_id: 'usr_101',
        user_name: 'Sanjay',
        module: 'Deals',
        module_api_name: 'Deals',
        record_id: 'rec_1',
        record_name: 'ABC Project',
        action: 'created',
        activity_type: 'deal',
        audited_time: '2026-08-14T10:15:00+05:30',
        source: 'crm_ui',
      },
      {
        user_id: 'usr_101',
        user_name: 'Sanjay',
        module: 'Meetings',
        module_api_name: 'Meetings',
        record_id: 'rec_2',
        record_name: 'Client Meeting',
        action: 'created',
        activity_type: 'meeting',
        audited_time: '2026-08-14T11:30:00+05:30',
        source: 'crm_ui',
      },
      {
        user_id: 'usr_101',
        user_name: 'Sanjay',
        module: 'Notes',
        module_api_name: 'Notes',
        record_id: 'rec_3',
        record_name: 'ABC Project',
        action: 'added',
        activity_type: 'note',
        audited_time: '2026-08-14T12:05:00+05:30',
        source: 'crm_ui',
      },
      {
        user_id: 'usr_101',
        user_name: 'Sanjay',
        module: 'Deals',
        module_api_name: 'Deals',
        record_id: 'rec_4',
        record_name: 'XYZ Deal',
        action: 'Stage changed',
        activity_type: 'deal',
        audited_time: '2026-08-14T14:10:00+05:30',
        source: 'crm_ui',
      },
    ],
  };

  const formatted = formatActivityResponse(mockActivityResult, { question: 'What did Sanjay do today? Give summary' });
  assert.equal(formatted.success, true);
  assert.ok(formatted.summary.includes('Sanjay completed the following CRM activities today.'));
  assert.ok(formatted.summary.includes('Today, Sanjay created 2 deals, created 1 meeting, added 1 note.'));
  assert.ok(formatted.summary.includes('| Employee | Activity | Module | Record | Action | Time |'));
  assert.ok(formatted.summary.includes('| Sanjay | Deal created | Deals | ABC Project | Created |'));
  assert.ok(formatted.summary.includes('| Employee | Deals Created | Meetings Created | Notes Added | Other Changes |'));
});

test('7. formatActivityResponse handles no results correctly', () => {
  const emptyResult = {
    success: true,
    date: '2026-08-14',
    timezone: 'Asia/Kolkata',
    count: 0,
    data: [],
  };

  const formatted = formatActivityResponse(emptyResult, { question: "Give me today's activity" });
  assert.equal(formatted.success, true);
  assert.equal(formatted.summary, 'No CRM activity was found for today.');
  assert.equal(formatted.data.length, 0);
});

test('8. formatActivityResponse handles API errors without converting to 0 activities', () => {
  const errorResult = {
    success: false,
    error: 'Zoho CRM API token expired or scope missing',
  };

  const formatted = formatActivityResponse(errorResult, { question: "Give me today's activity" });
  assert.equal(formatted.success, false);
  assert.equal(formatted.summary, 'No activity could be retrieved because the CRM activity API returned an error.');
});

test('9. GET /api/crm/activity endpoint integration test', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/crm', crmRouter);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const res = await fetch(`http://localhost:${port}/api/crm/activity?user_id=Sanjay&limit=5`);
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.success, true);
    assert.equal(json.timezone, 'Asia/Kolkata');
    assert.ok(Array.isArray(json.data));
  } finally {
    server.close();
  }
});

test('10. Assistant engine handles activity questions via handleAssistantRequest', async () => {
  const res = await assistantEngine.handleAssistantRequest({ question: 'What did Sanjay do today?' });
  assert.equal(res.success, true);
  assert.ok(typeof res.summary === 'string');
});

test('11. Querying module=activities returns 400 directing callers to /api/crm/activity', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/crm', crmRouter);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const res = await fetch(`http://localhost:${port}/api/crm/query?module=activities`);
    const json = await res.json();

    assert.equal(res.status, 400);
    assert.equal(json.success, false);
    assert.match(json.error, /Unsupported CRM module: activities/);
    assert.match(json.error, /\/api\/crm\/activity/);
  } finally {
    server.close();
  }
});

test('12. Normalized activity records contain standard action and time fields', () => {
  const sampleActivity = {
    user_id: '123',
    user_name: 'Sanjay',
    module: 'Deals',
    module_api_name: 'Deals',
    record_id: '456',
    record_name: 'ABC Deal',
    action: 'updated',
    activity_type: 'Deal',
    time: '2026-08-14T10:15:00+05:30',
    field: 'Stage',
    old_value: 'Proposal',
    new_value: 'Closed Won',
    source: 'crm_ui',
  };

  assert.equal(sampleActivity.user_name, 'Sanjay');
  assert.equal(sampleActivity.module, 'Deals');
  assert.equal(sampleActivity.action, 'updated');
  assert.equal(sampleActivity.field, 'Stage');
  assert.equal(sampleActivity.old_value, 'Proposal');
  assert.equal(sampleActivity.new_value, 'Closed Won');
  assert.ok(sampleActivity.time.includes('2026-08-14'));
});

test('13. normalizeAuditEntry extracts field_history changes accurately', () => {
  const mockTimelineItem = {
    done_by: { id: 'usr_201', name: 'Phanindra Kumar' },
    record: { id: 'deal_777', name: 'Enterprise Deal', module: { api_name: 'Deals' } },
    action: 'updated',
    audited_time: '2026-08-14T14:20:00+05:30',
    source: 'crm_ui',
    field_history: [
      {
        api_name: 'Stage',
        _value: { old: 'Discovery Mode', new: 'Proposal/Price Quote' },
      },
    ],
  };

  const normalized = normalizeAuditEntry(mockTimelineItem, 'Deals');
  assert.equal(normalized.user_name, 'Phanindra Kumar');
  assert.equal(normalized.action, 'updated');
  assert.equal(normalized.field, 'Stage');
  assert.equal(normalized.old_value, 'Discovery Mode');
  assert.equal(normalized.new_value, 'Proposal/Price Quote');
});

test('14. Half-open date range strictly excludes August 13 and August 15 records', () => {
  const from = '2026-08-14T00:00:00+05:30';
  const to = '2026-08-15T00:00:00+05:30';
  const fromTime = new Date(from).valueOf();
  const toTime = new Date(to).valueOf();

  const mockRecords = [
    { name: 'Aug 13 Late Night', audited_time: '2026-08-13T23:59:59+05:30' },
    { name: 'Aug 14 Midnight Exact', audited_time: '2026-08-14T00:00:00+05:30' },
    { name: 'Aug 14 Noon', audited_time: '2026-08-14T12:00:00+05:30' },
    { name: 'Aug 14 Late Night', audited_time: '2026-08-14T23:59:59+05:30' },
    { name: 'Aug 15 Midnight Exact', audited_time: '2026-08-15T00:00:00+05:30' },
    { name: 'Aug 15 Morning', audited_time: '2026-08-15T09:00:00+05:30' },
  ];

  const inRange = mockRecords.filter((rec) => {
    const t = new Date(rec.audited_time).valueOf();
    return t >= fromTime && t < toTime;
  });

  assert.equal(inRange.length, 3);
  assert.equal(inRange[0].name, 'Aug 14 Midnight Exact');
  assert.equal(inRange[1].name, 'Aug 14 Noon');
  assert.equal(inRange[2].name, 'Aug 14 Late Night');
});

test('15. Live/Real getActivity returns count > 0 for August 14, 2026 activity', async () => {
  const result = await getActivity({ from: '2026-08-14T00:00:00+05:30', to: '2026-08-15T00:00:00+05:30' });
  assert.equal(result.success, true);
  assert.ok(result.count > 0, `Expected count > 0, received ${result.count}`);
  assert.ok(result.data.length > 0);

  const first = result.data[0];
  assert.ok(first.user_name);
  assert.ok(first.module);
  assert.ok(first.action);
  assert.ok(first.time);
});


