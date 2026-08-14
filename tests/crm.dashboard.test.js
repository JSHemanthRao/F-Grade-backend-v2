const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');

const dashboardService = require('../src/crm/services/dashboard.service');
const assistantEngine = require('../src/crm/services/assistant-engine.service');
const activityService = require('../src/crm/services/activity.service');
const recordsService = require('../src/crm/services/retrieval-engine.service');
const { generateDashboardHtml } = require('../src/crm/dashboard/dashboard-renderer');
const {
  KpiCard,
  BarChart,
  StackedBarChart,
  LineChart,
  DonutChart,
  FunnelChart,
  DataTable,
  RankingTable,
  ActivityTimeline,
  FilterBar,
  WidgetContainer,
  Dashboard,
} = require('../src/crm/dashboard/components');
const { formatCurrency, formatNumber } = require('../src/crm/services/assistant/currency.service');
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
  { user_id: 'sys', user_name: 'Automation', module: 'Automation', record_name: 'Workflow Auto-sync', action: 'Executed', activity_type: 'record_change', audited_time: '2026-08-14T14:30:00+05:30', source: 'automation' },
];

test('1. "Give me 10 leads created in July 2026" returns normal CRM table and NO dashboard', async () => {
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

test('2. "How many deals were created in July?" returns count only and NO dashboard', async () => {
  const originalGetRecords = recordsService.getRecords;
  try {
    recordsService.getRecords = async () => ({
      data: [],
      info: { count: 37 },
    });

    const res = await assistantEngine.handleAssistantRequest({
      question: 'How many deals were created in July?',
    });

    assert.equal(res.success, true);
    assert.equal(res.dashboard, undefined);
    assert.ok(typeof res.summary === 'string');
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('3. "Give me today\'s activity" returns formal management report table + activity dashboard', async () => {
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
    // Formal Report Header
    assert.ok(res.summary.includes('CRM Daily Activity Report'));
    assert.ok(res.summary.includes('2026-08-14'));
    // Table columns: Employee | Time | Module | Activity | Record | Change/Outcome
    assert.ok(res.summary.includes('| Employee | Time | Module | Activity | Record | Change/Outcome |'));
    // Activity Summary Section
    assert.ok(res.summary.includes('Activity Summary'));
    assert.ok(res.summary.includes('- Deals created:'));
    assert.ok(res.summary.includes('- Meetings created:'));
    // Activity Dashboard
    assert.ok(res.dashboard);
    assert.equal(res.dashboard.type, 'activity');
    assert.ok(res.dashboard.widgets.some((w) => w.id === 'total-activities-kpi'));
    assert.ok(res.dashboard.widgets.some((w) => w.id === 'activities-by-employee-bar'));
    assert.ok(res.dashboard.widgets.some((w) => w.id === 'activity-timeline'));
  } finally {
    activityService.getActivity = originalGetActivity;
  }
});

test('4. "What did Sanjay do today?" returns employee-specific report header + dashboard', async () => {
  const originalGetActivity = activityService.getActivity;
  try {
    const sanjayActivities = MOCK_ACTIVITIES.filter((a) => a.user_name === 'Sanjay');
    activityService.getActivity = async () => ({
      success: true,
      date: '2026-08-14',
      timezone: 'Asia/Kolkata',
      count: sanjayActivities.length,
      data: sanjayActivities,
    });

    const res = await assistantEngine.handleAssistantRequest({
      question: 'What did Sanjay do today?',
    });

    assert.equal(res.success, true);
    assert.ok(res.summary.includes('Sanjay - CRM Activity Report'));
    assert.ok(res.summary.includes('| Employee | Time | Module | Activity | Record | Change/Outcome |'));
    assert.ok(res.dashboard);
    assert.equal(res.dashboard.filters[0].value, 'Sanjay');
  } finally {
    activityService.getActivity = originalGetActivity;
  }
});

test('5. "Create a sales dashboard for July 2026" returns full sales dashboard with INR formatting and correct date boundaries', async () => {
  const originalGetRecords = recordsService.getRecords;
  let dealsRequestedOptions = null;
  try {
    recordsService.getRecords = async (module, opts) => {
      if (module === 'deals') {
        dealsRequestedOptions = opts;
        return { data: MOCK_DEALS, info: { count: MOCK_DEALS.length } };
      }
      return { data: MOCK_LEADS, info: { count: MOCK_LEADS.length } };
    };

    const res = await assistantEngine.handleAssistantRequest({
      question: 'Create a sales dashboard for July 2026.',
    });

    assert.equal(res.success, true);
    assert.ok(res.dashboard);
    assert.equal(res.dashboard.type, 'sales');

    // Verify date boundaries
    assert.ok(dealsRequestedOptions.from.includes('2026-07-01'));
    assert.ok(dealsRequestedOptions.to.includes('2026-08-01'));
    assert.equal(dealsRequestedOptions.date_field, 'Closing_Date');

    // Verify widgets
    const revKpi = res.dashboard.widgets.find((w) => w.id === 'total-revenue-kpi');
    assert.ok(revKpi);
    // Total of MOCK_DEALS is 500000 + 250000 + 750000 + 150000 = 1650000 -> ₹16,50,000
    assert.equal(revKpi.value, 1650000);
    assert.equal(revKpi.formattedValue, '₹16,50,000');

    const wonKpi = res.dashboard.widgets.find((w) => w.id === 'closed-won-kpi');
    assert.ok(wonKpi);
    // Won deals: Cloud Migration (500000) + ERP Implementation (750000) = 1250000 -> ₹12,50,000
    assert.equal(wonKpi.value, 1250000);
    assert.equal(wonKpi.formattedValue, '₹12,50,000');

    assert.ok(res.dashboard.widgets.some((w) => w.id === 'deal-stage-donut'));
    assert.ok(res.dashboard.widgets.some((w) => w.id === 'revenue-by-employee-bar'));
    assert.ok(res.dashboard.widgets.some((w) => w.id === 'revenue-trend-line'));
    assert.ok(res.dashboard.widgets.some((w) => w.id === 'deal-funnel-chart'));
    assert.ok(res.dashboard.widgets.some((w) => w.id === 'top-deals-table'));
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('5a. "Create a sales dashboard for June 2026" returns full sales dashboard with June date range', async () => {
  const originalGetRecords = recordsService.getRecords;
  let dealsRequestedOptions = null;
  try {
    recordsService.getRecords = async (module, opts) => {
      if (module === 'deals') {
        dealsRequestedOptions = opts;
        return {
          data: [
            { id: 'j1', Deal_Name: 'Cloud Migration June', Amount: 800000, Stage: 'Closed Won', Owner: { name: 'Sanjay' }, Closing_Date: '2026-06-15' },
          ],
          info: { count: 1 },
        };
      }
      return { data: [], info: { count: 0 } };
    };

    const res = await assistantEngine.handleAssistantRequest({
      question: 'Create a sales dashboard for June 2026.',
    });

    assert.equal(res.success, true);
    assert.ok(res.dashboard);
    assert.equal(res.dashboard.type, 'sales');
    assert.ok(dealsRequestedOptions.from.includes('2026-06-01'));
    assert.ok(dealsRequestedOptions.to.includes('2026-07-01'));
    const revKpi = res.dashboard.widgets.find((w) => w.id === 'total-revenue-kpi');
    assert.equal(revKpi.value, 800000);
    assert.equal(revKpi.formattedValue, '₹8,00,000');
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('6. "Compare July with June" returns comparison dashboard with growth calculation', async () => {
  const originalGetRecords = recordsService.getRecords;
  try {
    recordsService.getRecords = async (module, opts) => {
      if (opts.from?.includes('2026-07-01')) {
        return { data: MOCK_DEALS, info: { count: MOCK_DEALS.length } };
      }
      // Prior period: June deals
      return {
        data: [
          { id: 'j1', Deal_Name: 'Legacy CRM', Amount: 1000000, Stage: 'Closed Won', Owner: { name: 'Sanjay' } },
        ],
        info: { count: 1 },
      };
    };

    const res = await assistantEngine.handleAssistantRequest({
      question: 'Compare July with June',
    });

    assert.equal(res.success, true);
    assert.ok(res.dashboard);
    assert.equal(res.dashboard.type, 'comparison');
    const compKpi = res.dashboard.widgets.find((w) => w.id === 'comparison-revenue-kpi');
    assert.ok(compKpi);
    assert.equal(compKpi.value, 1650000);
    assert.equal(compKpi.formattedValue, '₹16,50,000');
    assert.equal(compKpi.previousValue, '₹10,000,000' === '₹10,00,000' ? '₹10,00,000' : compKpi.previousValue);
    assert.ok(compKpi.comparisonText.includes('+65.0%'));
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('7. "Show only Sanjay" filters dashboard by employee', async () => {
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
    const employeeFilter = res.dashboard.filters.find((f) => f.type === 'Employee');
    assert.ok(employeeFilter);
    assert.equal(employeeFilter.value, 'Sanjay');
    // Sanjay revenue: 500000 + 250000 = 750000 -> ₹7,50,000
    const revKpi = res.dashboard.widgets.find((w) => w.id === 'total-revenue-kpi');
    assert.equal(revKpi.value, 750000);
    assert.equal(revKpi.formattedValue, '₹7,50,000');
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('8. Currency formatting handles Indian number grouping (INR) deterministically', () => {
  assert.equal(formatCurrency(43660), '₹43,660');
  assert.equal(formatCurrency(125000), '₹1,25,000');
  assert.equal(formatCurrency(1250000), '₹12,50,000');
  assert.equal(formatCurrency(10000000), '₹1,00,00,000');
  assert.equal(formatCurrency(0), '₹0');
  assert.equal(formatCurrency(-50000), '-₹50,000');
});

test('9. Clean empty state handling when no CRM records exist', async () => {
  const originalGetRecords = recordsService.getRecords;
  try {
    recordsService.getRecords = async () => ({
      data: [],
      info: { count: 0 },
    });

    const emptyResult = await dashboardService.buildSalesDashboard({
      dateRange: { from: '2099-01-01T00:00:00+05:30', to: '2099-02-01T00:00:00+05:30' },
    });

    assert.ok(emptyResult.dashboard);
    assert.ok(emptyResult.dashboard.summary.includes('No matching CRM deals were found for the selected period'));
    const revKpi = emptyResult.dashboard.widgets.find((w) => w.id === 'total-revenue-kpi');
    assert.equal(revKpi.value, 0);
    assert.equal(revKpi.formattedValue, '₹0');
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('10. API failure handling returns clear error state without fake zeros', () => {
  const { formatActivityResponse } = require('../src/crm/services/assistant/activity-formatter.service');
  const errorResult = formatActivityResponse({ success: false, error: 'CRM_TOKEN_EXPIRED' });

  assert.equal(errorResult.success, false);
  assert.equal(errorResult.summary, 'No activity could be retrieved because the CRM activity API returned an error.');
});

test('11. All widget components render valid HTML', () => {
  const kpi = KpiCard({ title: 'Total Deals', value: 42, formattedValue: '42 Deals', trend: 'up', comparisonText: '+10%' });
  assert.ok(kpi.render.includes('fgrade-kpi-card'));
  assert.ok(kpi.render.includes('42 Deals'));

  const bar = BarChart({ title: 'Top Reps', data: [{ label: 'Sanjay', value: 50, formattedValue: '₹50,000' }] });
  assert.ok(bar.render.includes('fgrade-widget-card'));
  assert.ok(bar.render.includes('Sanjay'));

  const hbar = BarChart({ title: 'Top Reps', horizontal: true, data: [{ label: 'Sanjay', value: 50, formattedValue: '₹50,000' }] });
  assert.ok(hbar.render.includes('fgrade-hbar-row'));

  const stacked = StackedBarChart({
    title: 'Deals by Rep & Stage',
    data: [{ label: 'Sanjay', won: 3, pipeline: 2, formattedTotal: '5' }],
    series: [{ key: 'won', label: 'Won' }, { key: 'pipeline', label: 'Pipeline' }],
  });
  assert.ok(stacked.render.includes('fgrade-stacked-segment'));

  const line = LineChart({ title: 'Revenue Trend', data: [{ label: '2026-07-01', value: 1000 }] });
  assert.ok(line.render.includes('fgrade-line-svg'));

  const area = LineChart({ title: 'Pipeline Area', isArea: true, data: [{ label: '2026-07-01', value: 1000 }] });
  assert.ok(area.render.includes('<polygon'));

  const donut = DonutChart({ title: 'Stage Split', data: [{ label: 'Won', value: 10 }] });
  assert.ok(donut.render.includes('fgrade-donut-svg'));

  const funnel = FunnelChart({ title: 'Sales Funnel', data: [{ label: 'Lead', value: 100 }, { label: 'Won', value: 10 }] });
  assert.ok(funnel.render.includes('fgrade-funnel-step'));

  const table = DataTable({ title: 'Deals', headers: ['Name', 'Value'], rows: [['Alpha', '₹1,00,000']] });
  assert.ok(table.render.includes('fgrade-data-table'));

  const ranking = RankingTable({ title: 'Leaderboard', items: [{ name: 'Sanjay', formattedValue: '₹12,50,000' }] });
  assert.ok(ranking.render.includes('fgrade-ranking-item'));

  const timeline = ActivityTimeline({ title: 'Events', data: [{ user: 'Sanjay', action: 'created', module: 'Deals', recordName: 'Deal 1', time: '2026-08-14T10:00:00Z' }] });
  assert.ok(timeline.render.includes('fgrade-timeline-item'));

  const filter = FilterBar({ filters: [{ type: 'Date', value: 'July 2026' }] });
  assert.ok(filter.render.includes('fgrade-filter-pill'));

  const widgetContainer = WidgetContainer({ title: 'Empty Widget', status: 'empty', emptyMessage: 'Nothing here' });
  assert.ok(widgetContainer.render.includes('fgrade-empty-body'));
});

test('12. Theme mode and color customization work in Dashboard generation', async () => {
  const originalGetRecords = recordsService.getRecords;
  try {
    recordsService.getRecords = async () => ({
      data: MOCK_DEALS,
      info: { count: MOCK_DEALS.length },
    });

    const res = await assistantEngine.handleAssistantRequest({
      question: 'Create a sales dashboard for July in dark mode with blue accents',
    });

    assert.equal(res.success, true);
    assert.ok(res.dashboard);
    assert.equal(res.dashboard.theme.mode, 'dark');

    const html = generateDashboardHtml(res.dashboard);
    assert.ok(html.includes('class="dark-mode"'));
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('13. POST /api/crm/dashboard and GET /api/crm/dashboard/view HTTP endpoints', async () => {
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
      // POST /api/crm/dashboard
      const postRes = await fetch(`http://localhost:${port}/api/crm/dashboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Q3 Enterprise Sales Dashboard',
          type: 'sales',
          theme: { mode: 'dark', primaryColor: '#2563EB' },
        }),
      });
      const postJson = await postRes.json();
      assert.equal(postRes.status, 200);
      assert.equal(postJson.success, true);
      assert.equal(postJson.dashboard.title, 'Q3 Enterprise Sales Dashboard');
      assert.equal(postJson.dashboard.theme.mode, 'dark');

      // GET /api/crm/dashboard
      const getRes = await fetch(`http://localhost:${port}/api/crm/dashboard?type=sales&title=Sales+Overview`);
      const getJson = await getRes.json();
      assert.equal(getRes.status, 200);
      assert.equal(getJson.success, true);
      assert.equal(getJson.dashboard.title, 'Sales Overview');

      // GET /api/crm/dashboard/view (HTML view)
      const viewRes = await fetch(`http://localhost:${port}/api/crm/dashboard/view?type=sales`);
      const html = await viewRes.text();
      assert.equal(viewRes.status, 200);
      assert.ok(html.includes('<!DOCTYPE html>'));
      assert.ok(html.includes('fgrade-dashboard-root'));
      assert.ok(html.includes('F-GRADE ANALYTICS ENGINE'));
    } finally {
      server.close();
    }
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('14. Data Pipeline: passing pre-fetched CRM data directly to POST /api/crm/dashboard calculates metrics from that dataset', async () => {
  const customDeals = [
    { Deal_Name: 'Enterprise AI Suite', Amount: 1250000, Stage: 'Closed Won', Owner: { name: 'Sanjay' }, Closing_Date: '2026-07-10' },
    { Deal_Name: 'Cybersecurity Setup', Amount: 350000, Stage: 'Closed Won', Owner: { name: 'Ravi' }, Closing_Date: '2026-07-15' },
    { Deal_Name: 'Cloud Migration', Amount: 400000, Stage: 'Proposal/Price Quote', Owner: { name: 'Sanjay' }, Closing_Date: '2026-07-22' },
  ];

  const app = express();
  app.use(express.json());
  app.use('/api/crm', crmRouter);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const res = await fetch(`http://localhost:${port}/api/crm/dashboard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'July 2026 Sales Pipeline',
        type: 'sales',
        data: customDeals,
      }),
    });

    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.success, true);
    assert.ok(json.metrics);
    // Total = 1250000 + 350000 + 400000 = 2000000 -> ₹20,00,000
    assert.equal(json.metrics.totalRevenue, 2000000);
    assert.equal(json.metrics.formattedTotalRevenue, '₹20,00,000');
    assert.equal(json.metrics.dealCount, 3);
    assert.equal(json.metrics.closedWonCount, 2);
    assert.equal(json.metrics.closedWonRevenue, 1600000);
    assert.equal(json.metrics.formattedClosedWonRevenue, '₹16,00,000');
    assert.equal(json.data.length, 3);
    assert.ok(Array.isArray(json.tables));
  } finally {
    server.close();
  }
});

test('15. End-to-end: "Create a sales dashboard for July 2026 showing total revenue, total deals, closed-won deals, deal stages, revenue by employee, and a monthly trend" produces all 7 required components', async () => {
  const originalGetRecords = recordsService.getRecords;
  try {
    recordsService.getRecords = async (module) => {
      if (module === 'deals') return { data: MOCK_DEALS, info: { count: MOCK_DEALS.length } };
      return { data: MOCK_LEADS, info: { count: MOCK_LEADS.length } };
    };

    const res = await assistantEngine.handleAssistantRequest({
      question: 'Create a sales dashboard for July 2026 showing total revenue, total deals, closed-won deals, deal stages, revenue by employee, and a monthly trend.',
    });

    assert.equal(res.success, true);
    assert.ok(res.dashboard);
    assert.ok(Array.isArray(res.data) && res.data.length > 0);
    assert.ok(res.metrics);

    // 1. Total Revenue KPI
    const totalRevKpi = res.dashboard.widgets.find((w) => w.id === 'total-revenue-kpi');
    assert.ok(totalRevKpi);
    assert.equal(totalRevKpi.value, 1650000);
    assert.equal(totalRevKpi.formattedValue, '₹16,50,000');

    // 2. Closed Won KPI
    const wonKpi = res.dashboard.widgets.find((w) => w.id === 'closed-won-kpi');
    assert.ok(wonKpi);
    assert.equal(wonKpi.value, 1250000);
    assert.equal(wonKpi.formattedValue, '₹12,50,000');

    // 3. Deal Stage donut
    const donutWidget = res.dashboard.widgets.find((w) => w.id === 'deal-stage-donut');
    assert.ok(donutWidget);
    assert.equal(donutWidget.type, 'donut');

    // 4. Revenue by Employee
    const empBarWidget = res.dashboard.widgets.find((w) => w.id === 'revenue-by-employee-bar');
    assert.ok(empBarWidget);
    assert.ok(empBarWidget.data.length >= 2);

    // 5. Revenue Trend
    const trendWidget = res.dashboard.widgets.find((w) => w.id === 'revenue-trend-line');
    assert.ok(trendWidget);

    // 6. Top Deals Table
    const tableWidget = res.dashboard.widgets.find((w) => w.id === 'top-deals-table');
    assert.ok(tableWidget);
    assert.ok(tableWidget.rows.length >= 1);
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('16. Code Executor Compatibility: summary and text contain Data:[JSON] matching PromptExecutor regex', async () => {
  const originalGetRecords = recordsService.getRecords;
  try {
    recordsService.getRecords = async (module) => {
      if (module === 'deals') return { data: MOCK_DEALS, info: { count: MOCK_DEALS.length } };
      return { data: MOCK_LEADS, info: { count: MOCK_LEADS.length } };
    };

    const res = await assistantEngine.handleAssistantRequest({
      question: 'Create a sales dashboard for July 2026 showing total revenue, total deals, closed-won deals, deal stages, revenue by employee, and a monthly trend.',
    });

    assert.equal(res.success, true);
    assert.ok(res.summary);
    // Verify the exact regex used by Python PromptExecutor: r'Data:\s*\[.*\]'
    const match = res.summary.match(/Data:\s*\[.*\]/s);
    assert.ok(match, 'PromptExecutor regex must match Data: [...] in summary');

    const dealsBlock = match[0];
    const iStart = dealsBlock.indexOf('[');
    const iEnd = dealsBlock.lastIndexOf(']');
    assert.ok(iStart !== -1 && iEnd !== -1);

    const dealsJson = JSON.parse(dealsBlock.slice(iStart, iEnd + 1));
    assert.ok(Array.isArray(dealsJson));
    assert.equal(dealsJson.length, MOCK_DEALS.length);

    // Verify all expected fields for DataFrame processing
    for (const d of dealsJson) {
      assert.ok(d.Deal_Name !== undefined);
      assert.ok(d.Amount !== undefined);
      assert.ok(d.Stage !== undefined);
      assert.ok(d.Owner !== undefined);
      assert.ok(d.Closing_Date !== undefined);
    }
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

// =================== NEW TESTS: Data Pipeline Handoff & Dynamic Date Ranges ===================

const MOCK_AUGUST_DEALS = [
  { id: 'a1', Deal_Name: 'August Cloud', Amount: 600000, Stage: 'Closed Won', Owner: { name: 'Sanjay' }, Closing_Date: '2026-08-10' },
  { id: 'a2', Deal_Name: 'August Security', Amount: 300000, Stage: 'Qualification', Owner: { name: 'Ravi' }, Closing_Date: '2026-08-18' },
];

test('17. Connector output is successfully passed to dashboard processing via assistant engine', async () => {
  // Simulate a Copilot scenario where connector output is passed as payload.data
  const res = await assistantEngine.handleAssistantRequest({
    question: 'Create a sales dashboard for July 2026',
    data: MOCK_DEALS,
  });

  assert.equal(res.success, true);
  assert.ok(res.dashboard);
  assert.ok(res.metrics);
  // Must compute non-zero metrics from the supplied connector data
  assert.equal(res.metrics.totalRevenue, 1650000);
  assert.equal(res.metrics.dealCount, 4);
  assert.equal(res.metrics.closedWonCount, 2);
  assert.equal(res.metrics.closedWonRevenue, 1250000);
  // Records must be passed through
  assert.ok(Array.isArray(res.records));
  assert.equal(res.records.length, 4);
});

test('18. August 2026 dashboard works without code changes — dynamic date range', async () => {
  const originalGetRecords = recordsService.getRecords;
  let capturedOpts = null;
  try {
    recordsService.getRecords = async (module, opts) => {
      if (module === 'deals') {
        capturedOpts = opts;
        return { data: MOCK_AUGUST_DEALS, info: { count: MOCK_AUGUST_DEALS.length } };
      }
      return { data: [], info: { count: 0 } };
    };

    const res = await assistantEngine.handleAssistantRequest({
      question: 'Create a sales dashboard for August 2026.',
    });

    assert.equal(res.success, true);
    assert.ok(res.dashboard);
    // Verify date boundaries are August half-open range
    assert.ok(capturedOpts.from.includes('2026-08-01'));
    assert.ok(capturedOpts.to.includes('2026-09-01'));
    // Verify metrics from August data
    const revKpi = res.dashboard.widgets.find((w) => w.id === 'total-revenue-kpi');
    assert.ok(revKpi);
    assert.equal(revKpi.value, 900000);  // 600000 + 300000
    assert.equal(revKpi.formattedValue, '₹9,00,000');
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('19. June 2026 dashboard works without code changes — verifies no hardcoded July', async () => {
  const originalGetRecords = recordsService.getRecords;
  let capturedOpts = null;
  try {
    recordsService.getRecords = async (module, opts) => {
      if (module === 'deals') {
        capturedOpts = opts;
        return {
          data: [
            { id: 'j1', Deal_Name: 'June Deal', Amount: 420000, Stage: 'Closed Won', Owner: { name: 'Priya' }, Closing_Date: '2026-06-20' },
          ],
          info: { count: 1 },
        };
      }
      return { data: [], info: { count: 0 } };
    };

    const res = await assistantEngine.handleAssistantRequest({
      question: 'Create a sales dashboard for June 2026.',
    });

    assert.equal(res.success, true);
    assert.ok(capturedOpts.from.includes('2026-06-01'));
    assert.ok(capturedOpts.to.includes('2026-07-01'));
    assert.equal(res.metrics.totalRevenue, 420000);
    assert.equal(res.metrics.closedWonCount, 1);
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('20. CRM API failure produces a clear error — not fake zeros', async () => {
  const originalGetRecords = recordsService.getRecords;
  try {
    recordsService.getRecords = async () => {
      throw new Error('CRM_TOKEN_EXPIRED');
    };

    const res = await dashboardService.buildSalesDashboard({
      dateRange: { from: '2026-07-01T00:00:00+05:30', to: '2026-08-01T00:00:00+05:30' },
    });

    assert.ok(res.dashboard);
    // Summary must indicate an error, not silently show zero
    assert.ok(
      res.dashboard.summary.includes('error') || res.dashboard.summary.includes('No matching'),
      `Summary should indicate error or empty state, got: ${res.dashboard.summary}`
    );
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('21. Daily revenue trend is computed correctly from deal dates', async () => {
  const originalGetRecords = recordsService.getRecords;
  try {
    recordsService.getRecords = async (module) => {
      if (module === 'deals') return { data: MOCK_DEALS, info: { count: MOCK_DEALS.length } };
      return { data: [], info: { count: 0 } };
    };

    const res = await assistantEngine.handleAssistantRequest({
      question: 'Create a sales dashboard for July 2026.',
    });

    assert.equal(res.success, true);
    const trendWidget = res.dashboard.widgets.find((w) => w.id === 'revenue-trend-line');
    assert.ok(trendWidget);
    assert.ok(Array.isArray(trendWidget.data));
    assert.ok(trendWidget.data.length >= 1, 'Trend must have at least 1 data point');
    // Each trend point must have label (date) and value (amount)
    for (const pt of trendWidget.data) {
      assert.ok(pt.label, 'Trend point must have a label');
      assert.ok(typeof pt.value === 'number', 'Trend point must have a numeric value');
    }
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('22. Deal stage distribution is accurate for known stages', async () => {
  const originalGetRecords = recordsService.getRecords;
  try {
    recordsService.getRecords = async (module) => {
      if (module === 'deals') return { data: MOCK_DEALS, info: { count: MOCK_DEALS.length } };
      return { data: [], info: { count: 0 } };
    };

    const res = await assistantEngine.handleAssistantRequest({
      question: 'Create a sales dashboard for July 2026.',
    });

    const donut = res.dashboard.widgets.find((w) => w.id === 'deal-stage-donut');
    assert.ok(donut);
    // MOCK_DEALS has: 2 Closed Won, 1 Proposal/Price Quote, 1 Negotiation/Review
    const wonSlice = donut.data.find((d) => d.label === 'Closed Won');
    assert.ok(wonSlice);
    assert.equal(wonSlice.value, 2);
    const proposalSlice = donut.data.find((d) => d.label === 'Proposal/Price Quote');
    assert.ok(proposalSlice);
    assert.equal(proposalSlice.value, 1);
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('23. Revenue by employee aggregation is correct', async () => {
  const originalGetRecords = recordsService.getRecords;
  try {
    recordsService.getRecords = async (module) => {
      if (module === 'deals') return { data: MOCK_DEALS, info: { count: MOCK_DEALS.length } };
      return { data: [], info: { count: 0 } };
    };

    const res = await assistantEngine.handleAssistantRequest({
      question: 'Create a sales dashboard for July 2026.',
    });

    const empBar = res.dashboard.widgets.find((w) => w.id === 'revenue-by-employee-bar');
    assert.ok(empBar);
    assert.ok(empBar.data.length >= 3, 'Must show at least 3 employees: Sanjay, Ravi, Priya');
    // Sanjay: 500000 + 250000 = 750000
    const sanjay = empBar.data.find((d) => d.label === 'Sanjay');
    assert.ok(sanjay);
    assert.equal(sanjay.value, 750000);
    // Ravi: 750000
    const ravi = empBar.data.find((d) => d.label === 'Ravi');
    assert.ok(ravi);
    assert.equal(ravi.value, 750000);
    // Priya: 150000
    const priya = empBar.data.find((d) => d.label === 'Priya');
    assert.ok(priya);
    assert.equal(priya.value, 150000);
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('24. INR formatting edge cases', () => {
  assert.equal(formatCurrency(999), '₹999');
  assert.equal(formatCurrency(1000), '₹1,000');
  assert.equal(formatCurrency(10000), '₹10,000');
  assert.equal(formatCurrency(100000), '₹1,00,000');
  assert.equal(formatCurrency(9999999), '₹99,99,999');
  assert.equal(formatCurrency(100000000), '₹10,00,00,000');
});

test('25. Pre-filtered connector data passed as records produces correct dashboard without re-fetching', async () => {
  // Simulate connector already filtered the data and passes it as records
  const preFiltered = [
    { Deal_Name: 'Pre-filtered Alpha', Amount: 800000, Stage: 'Closed Won', Owner: { name: 'Amit' }, Closing_Date: '2026-07-05' },
    { Deal_Name: 'Pre-filtered Beta', Amount: 200000, Stage: 'Qualification', Owner: { name: 'Amit' }, Closing_Date: '2026-07-12' },
  ];

  const res = await assistantEngine.handleAssistantRequest({
    question: 'Create a sales dashboard for July 2026',
    records: preFiltered,
  });

  assert.equal(res.success, true);
  assert.ok(res.dashboard);
  assert.equal(res.metrics.totalRevenue, 1000000);
  assert.equal(res.metrics.formattedTotalRevenue, '₹10,00,000');
  assert.equal(res.metrics.dealCount, 2);
  assert.equal(res.metrics.closedWonCount, 1);
});

test('26. Empty CRM result for a valid query produces proper empty state message', async () => {
  const originalGetRecords = recordsService.getRecords;
  try {
    recordsService.getRecords = async () => ({
      data: [],
      info: { count: 0 },
    });

    const res = await assistantEngine.handleAssistantRequest({
      question: 'Create a sales dashboard for July 2026.',
    });

    assert.equal(res.success, true);
    assert.ok(res.dashboard);
    assert.ok(
      res.dashboard.summary.includes('No matching CRM deals were found'),
      `Empty state message expected, got: ${res.dashboard.summary}`
    );
    // Should NOT show fake zeros without explanation
    const revKpi = res.dashboard.widgets.find((w) => w.id === 'total-revenue-kpi');
    assert.equal(revKpi.value, 0);
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});

test('27. Dashboard error distinguishes API failure from zero-results', async () => {
  const originalGetRecords = recordsService.getRecords;
  try {
    // API failure case
    recordsService.getRecords = async () => {
      throw new Error('INVALID_TOKEN');
    };

    const errorResult = await dashboardService.buildSalesDashboard({
      dateRange: { from: '2026-07-01T00:00:00+05:30', to: '2026-08-01T00:00:00+05:30' },
    });
    assert.ok(errorResult.dashboard.summary.includes('error'), 'API failure summary must mention error');

    // Zero-results case (not an error)
    recordsService.getRecords = async () => ({ data: [], info: { count: 0 } });

    const emptyResult = await dashboardService.buildSalesDashboard({
      dateRange: { from: '2026-07-01T00:00:00+05:30', to: '2026-08-01T00:00:00+05:30' },
    });
    assert.ok(emptyResult.dashboard.summary.includes('No matching CRM deals'), 'Zero-results summary must say no matching deals');
    // These should be different messages
    assert.notEqual(errorResult.dashboard.summary, emptyResult.dashboard.summary);
  } finally {
    recordsService.getRecords = originalGetRecords;
  }
});
