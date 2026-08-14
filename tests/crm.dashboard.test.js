const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');

const dashboardService = require('../src/crm/services/dashboard.service');
const assistantEngine = require('../src/crm/services/assistant-engine.service');
const activityService = require('../src/crm/services/activity.service');
const recordsService = require('../src/crm/services/retrieval-engine.service');
const { generateDashboardHtml } = require('../src/crm/dashboard/dashboard-renderer');
const crmRouter = require('../src/crm/routes');

const MOCK_DEALS = [
  { id: '1', Deal_Name: 'Cloud Migration', Amount: 500000, Stage: 'Closed Won', Owner: { name: 'Sanjay' }, Closing_Date: '2026-07-15' },
  { id: '2', Deal_Name: 'Security Audit', Amount: 250000, Stage: 'Proposal/Price Quote', Owner: { name: 'Sanjay' }, Closing_Date: '2026-07-20' },
  { id: '3', Deal_Name: 'ERP Implementation', Amount: 750000, Stage: 'Closed Won', Owner: { name: 'Ravi' }, Closing_Date: '2026-07-25' },
  { id: '4', Deal_Name: 'DevOps Setup', Amount: 150000, Stage: 'Negotiation/Review', Owner: { name: 'Priya' }, Closing_Date: '2026-07-28' },
];

const MOCK_LEADS = [
  { id: 'l1', First_Name: 'Amit', Last_Name: 'Shah', Company: 'Tech Corp', Lead_Source: 'Advertisement', Created_Time: '2026-07-10' },
  { id: 'l2', First_Name: 'Deepa', Last_Name: 'Nair', Company: 'Health Plus', Lead_Source: 'Cold Call', Created_Time: '2026-07-12' },
];

const MOCK_ACTIVITIES = [
  { user_id: 'usr_1', user_name: 'Sanjay', module: 'Deals', record_name: 'Cloud Migration', action: 'created', activity_type: 'deal', audited_time: '2026-08-14T10:15:00+05:30' },
  { user_id: 'usr_1', user_name: 'Sanjay', module: 'Meetings', record_name: 'Kickoff Call', action: 'created', activity_type: 'meeting', audited_time: '2026-08-14T11:30:00+05:30' },
  { user_id: 'usr_1', user_name: 'Sanjay', module: 'Notes', record_name: 'Requirements Note', action: 'added', activity_type: 'note', audited_time: '2026-08-14T12:05:00+05:30' },
  { user_id: 'usr_2', user_name: 'Ravi', module: 'Deals', record_name: 'ERP Implementation', action: 'Stage changed', activity_type: 'deal', audited_time: '2026-08-14T14:10:00+05:30' },
];

test('Case 1: "Give me 10 leads created in July 2026" returns normal table and NO dashboard', async () => {
  const originalGetRecords = recordsService.getRecords;
  try {
    recordsService.getRecords = async () => ({
      data: MOCK_LEADS,
      info: { count: MOCK_LEADS.length, more_records: false },
    });

    const res = await assistantEngine.handleAssistantRequest({
      question: 'Give me 10 leads created in July 2026.',
    });

    assert.equal(res.success, true);
    assert.equal(res.dashboard, undefined);
    assert.ok(typeof res.summary === 'string');
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('Case 2: "How many leads were created in July?" returns count only and NO dashboard', async () => {
  const originalGetCount = recordsService.getCount;
  try {
    recordsService.getCount = async () => ({
      data: [],
      info: { count: 37 },
    });

    const res = await assistantEngine.handleAssistantRequest({
      question: 'How many leads were created in July?',
    });

    assert.equal(res.success, true);
    assert.equal(res.dashboard, undefined);
    assert.ok(typeof res.summary === 'string');
  } finally {
    recordsService.getCount = originalGetCount;
  }
});

test('Case 3: "Give me today\'s activity" returns Section 1 (table) + Section 2 (dashboard)', async () => {
  const originalGetActivity = activityService.getActivity;
  try {
    activityService.getActivity = async () => ({
      success: true,
      date: '2026-08-14',
      timezone: 'Asia/Kolkata',
      count: MOCK_ACTIVITIES.length,
      data: MOCK_ACTIVITIES,
    });

    const res = await assistantEngine.handleAssistantRequest({
      question: "Give me today's activity",
    });

    assert.equal(res.success, true);
    // Section 1: Detailed Table
    assert.ok(res.summary.includes("Today's CRM Activity"));
    assert.ok(res.summary.includes('| Employee | Activity | Module | Record | Action | Time |'));
    // Section 2: Dashboard
    assert.ok(res.summary.includes('Activity Dashboard'));
    assert.ok(res.dashboard);
    assert.equal(res.dashboard.type, 'activity');
    assert.ok(res.dashboard.widgets.length >= 4);
  } finally {
    activityService.getActivity = originalGetActivity;
  }
});

test('Case 4: "What did Sanjay do today?" returns Sanjay table + Sanjay dashboard', async () => {
  const originalGetActivity = activityService.getActivity;
  try {
    activityService.getActivity = async () => ({
      success: true,
      date: '2026-08-14',
      timezone: 'Asia/Kolkata',
      count: 3,
      data: MOCK_ACTIVITIES.filter((a) => a.user_name === 'Sanjay'),
    });

    const res = await assistantEngine.handleAssistantRequest({
      question: 'What did Sanjay do today?',
    });

    assert.equal(res.success, true);
    assert.ok(res.summary.includes("Today's CRM Activity"));
    assert.ok(res.summary.includes('Activity Dashboard'));
    assert.ok(res.dashboard);
  } finally {
    activityService.getActivity = originalGetActivity;
  }
});

test('Case 5: "Create a sales dashboard for July" returns high-end sales dashboard', async () => {
  const originalGetRecords = recordsService.getRecords;
  try {
    recordsService.getRecords = async (module) => {
      if (module === 'deals') return { data: MOCK_DEALS, info: { count: MOCK_DEALS.length } };
      return { data: MOCK_LEADS, info: { count: MOCK_LEADS.length } };
    };

    const res = await assistantEngine.handleAssistantRequest({
      question: 'Create a sales dashboard for July.',
    });

    assert.equal(res.success, true);
    assert.ok(res.dashboard);
    assert.equal(res.dashboard.type, 'sales');
    assert.ok(res.dashboard.widgets.some((w) => w.id === 'total-revenue-kpi'));
    assert.ok(res.dashboard.widgets.some((w) => w.id === 'deal-stage-donut'));
    assert.ok(res.dashboard.widgets.some((w) => w.id === 'revenue-by-employee-bar'));
    assert.ok(res.dashboard.widgets.some((w) => w.id === 'revenue-trend-line'));
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('Case 6: "Compare July with June" returns comparison dashboard', async () => {
  const originalGetRecords = recordsService.getRecords;
  try {
    recordsService.getRecords = async () => ({
      data: MOCK_DEALS,
      info: { count: MOCK_DEALS.length },
    });

    const res = await assistantEngine.handleAssistantRequest({
      question: 'Compare July with June',
    });

    assert.equal(res.success, true);
    assert.ok(res.dashboard);
    assert.equal(res.dashboard.type, 'comparison');
    assert.ok(res.dashboard.widgets.some((w) => w.id === 'comparison-revenue-kpi'));
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('Case 7: "Show only Sanjay" filters dashboard by employee', async () => {
  const originalGetRecords = recordsService.getRecords;
  try {
    recordsService.getRecords = async () => ({
      data: MOCK_DEALS,
      info: { count: MOCK_DEALS.length },
    });

    const res = await assistantEngine.handleAssistantRequest({
      question: 'Create a sales dashboard for July and show only Sanjay',
    });

    assert.equal(res.success, true);
    assert.ok(res.dashboard);
    const employeeFilter = res.dashboard.filters.find((f) => f.type === 'employee');
    assert.ok(employeeFilter);
    assert.equal(employeeFilter.value, 'Sanjay');
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('Case 8: "Add a deal-stage donut chart" includes donut chart widget', async () => {
  const originalGetRecords = recordsService.getRecords;
  try {
    recordsService.getRecords = async () => ({
      data: MOCK_DEALS,
      info: { count: MOCK_DEALS.length },
    });

    const result = await dashboardService.getDashboard({
      question: 'Add a deal-stage donut chart for July sales',
    });

    assert.ok(result.dashboard);
    assert.ok(result.dashboard.widgets.some((w) => w.type === 'donut'));
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('Case 9: "Change the dashboard to dark mode" applies dark theme', async () => {
  const originalGetRecords = recordsService.getRecords;
  try {
    recordsService.getRecords = async () => ({
      data: MOCK_DEALS,
      info: { count: MOCK_DEALS.length },
    });

    const res = await assistantEngine.handleAssistantRequest({
      question: 'Create a sales dashboard for July in dark mode',
    });

    assert.equal(res.success, true);
    assert.ok(res.dashboard);
    assert.equal(res.dashboard.theme.mode, 'dark');
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('Case 10: "Show revenue by employee" produces employee revenue breakdown', async () => {
  const originalGetRecords = recordsService.getRecords;
  try {
    recordsService.getRecords = async () => ({
      data: MOCK_DEALS,
      info: { count: MOCK_DEALS.length },
    });

    const result = await dashboardService.buildSalesDashboard({
      dateRange: { from: '2026-07-01T00:00:00+05:30', to: '2026-08-01T00:00:00+05:30' },
    });

    const empBar = result.dashboard.widgets.find((w) => w.id === 'revenue-by-employee-bar');
    assert.ok(empBar);
    assert.equal(empBar.type, 'bar');
    assert.ok(Array.isArray(empBar.data));
    assert.ok(empBar.data.length >= 2);
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('Case 11: Clean empty state handling when no CRM records exist', async () => {
  const originalGetActivity = activityService.getActivity;
  try {
    activityService.getActivity = async () => ({
      success: true,
      date: '2099-01-01',
      timezone: 'Asia/Kolkata',
      count: 0,
      data: [],
    });

    const emptyActivity = await dashboardService.buildActivityDashboard({
      dateRange: { from: '2099-01-01T00:00:00+05:30', to: '2099-01-02T00:00:00+05:30' },
    });

    assert.ok(emptyActivity.dashboard);
    assert.equal(emptyActivity.dashboard.widgets[0].value, 0);
  } finally {
    activityService.getActivity = originalGetActivity;
  }
});

test('Case 12: API failure handling does not fabricate fake zeros', () => {
  const { formatActivityResponse } = require('../src/crm/services/assistant/activity-formatter.service');
  const errorResult = formatActivityResponse({ success: false, error: 'CRM_TOKEN_EXPIRED' });

  assert.equal(errorResult.success, false);
  assert.equal(errorResult.summary, 'No activity could be retrieved because the CRM activity API returned an error.');
});

test('Case 13: Large dataset is bounded and aggregated', async () => {
  const originalGetRecords = recordsService.getRecords;
  try {
    recordsService.getRecords = async () => ({
      data: MOCK_DEALS,
      info: { count: MOCK_DEALS.length },
    });

    const result = await dashboardService.buildSalesDashboard({
      limit: 10,
    });

    assert.ok(result.dashboard);
    assert.ok(result.dashboard.widgets.length >= 5);
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('Case 14: POST /api/crm/dashboard and GET /api/crm/dashboard/view endpoints', async () => {
  const originalGetRecords = recordsService.getRecords;
  try {
    recordsService.getRecords = async () => ({
      data: MOCK_DEALS,
      info: { count: MOCK_DEALS.length },
    });

    const app = express();
    app.use(express.json());
    app.use('/api/crm', crmRouter);

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
      // Test POST /api/crm/dashboard
      const postRes = await fetch(`http://localhost:${port}/api/crm/dashboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Q3 Sales Dashboard',
          type: 'sales',
          theme: { mode: 'dark' },
        }),
      });
      const postJson = await postRes.json();
      assert.equal(postRes.status, 200);
      assert.equal(postJson.success, true);
      assert.equal(postJson.dashboard.title, 'Q3 Sales Dashboard');
      assert.equal(postJson.dashboard.theme.mode, 'dark');

      // Test GET /api/crm/dashboard/view (HTML Renderer)
      const viewRes = await fetch(`http://localhost:${port}/api/crm/dashboard/view?type=sales`);
      const html = await viewRes.text();
      assert.equal(viewRes.status, 200);
      assert.ok(html.includes('<!DOCTYPE html>'));
      assert.ok(html.includes('fgrade-dashboard-root'));
    } finally {
      server.close();
    }
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});
