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
