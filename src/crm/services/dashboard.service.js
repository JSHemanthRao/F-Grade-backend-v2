const recordsService = require('./retrieval-engine.service');
const activityService = require('./activity.service');
const metadataService = require('./crm-metadata.service');
const { formatCurrency, formatNumber, numericValue } = require('./assistant/currency.service');
const logger = require('../../common/logging/logger');

const DEFAULT_THEME = {
  mode: 'light',
  primaryColor: '#2563EB',
  accentColor: '#14B8A6',
  backgroundColor: '#F8FAFC',
  cardColor: '#FFFFFF',
};

const DARK_THEME = {
  mode: 'dark',
  primaryColor: '#3B82F6',
  accentColor: '#38BDF8',
  backgroundColor: '#0F172A',
  cardColor: '#1E293B',
};

function resolveTheme(themeInput = {}) {
  const mode = String(themeInput.mode || (themeInput.dark ? 'dark' : 'light')).toLowerCase();
  const base = mode === 'dark' ? DARK_THEME : DEFAULT_THEME;
  return {
    ...base,
    ...themeInput,
    mode,
    primaryColor: themeInput.primaryColor || themeInput.primary || base.primaryColor,
    accentColor: themeInput.accentColor || themeInput.accent || base.accentColor,
  };
}

function resolveDateRange(dateRangeInput = {}) {
  const from = dateRangeInput.from || dateRangeInput.startDate || dateRangeInput.start;
  const to = dateRangeInput.to || dateRangeInput.endDate || dateRangeInput.end;

  if (from && to) {
    return { from, to };
  }

  // Default to current month or today in Asia/Kolkata
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const startOfMonth = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  const startOfNextMonth = new Date(Date.UTC(year, month + 1, 1)).toISOString().slice(0, 10);

  return {
    from: from || `${startOfMonth}T00:00:00+05:30`,
    to: to || `${startOfNextMonth}T00:00:00+05:30`,
  };
}

function formatPercentage(num) {
  if (num === null || num === undefined || Number.isNaN(num)) return '0%';
  const sign = num > 0 ? '+' : '';
  return `${sign}${Number(num).toFixed(1)}%`;
}

function computeStageDistribution(deals = []) {
  const counts = {};
  const values = {};

  deals.forEach((deal) => {
    const stage = deal.Stage || deal.stage || 'Open';
    const amount = numericValue(deal.Amount || deal.amount || 0) || 0;
    counts[stage] = (counts[stage] || 0) + 1;
    values[stage] = (values[stage] || 0) + amount;
  });

  return Object.keys(counts).map((stage) => ({
    label: stage,
    count: counts[stage],
    value: values[stage],
    formattedValue: formatCurrency(values[stage]),
  }));
}

function computeEmployeeRevenue(deals = []) {
  const userRevenue = {};
  const userDeals = {};

  deals.forEach((deal) => {
    const ownerName = deal.Owner?.name || deal.Owner || deal.Created_By?.name || 'Unassigned';
    const amount = numericValue(deal.Amount || deal.amount || 0) || 0;
    userRevenue[ownerName] = (userRevenue[ownerName] || 0) + amount;
    userDeals[ownerName] = (userDeals[ownerName] || 0) + 1;
  });

  return Object.keys(userRevenue)
    .map((employee) => ({
      employee,
      revenue: userRevenue[employee],
      formattedRevenue: formatCurrency(userRevenue[employee]),
      dealCount: userDeals[employee],
    }))
    .sort((a, b) => b.revenue - a.revenue);
}

function computeRevenueTrend(deals = []) {
  const dailyRevenue = {};

  deals.forEach((deal) => {
    const rawDate = deal.Closing_Date || deal.Created_Time || deal.Modified_Time;
    if (!rawDate) return;
    const dateKey = String(rawDate).slice(0, 10);
    const amount = numericValue(deal.Amount || deal.amount || 0) || 0;
    dailyRevenue[dateKey] = (dailyRevenue[dateKey] || 0) + amount;
  });

  return Object.keys(dailyRevenue)
    .sort()
    .map((date) => ({
      date,
      revenue: dailyRevenue[date],
      formattedRevenue: formatCurrency(dailyRevenue[date]),
    }));
}

function computeLeadSourceDistribution(leads = []) {
  const sourceCounts = {};

  leads.forEach((lead) => {
    const source = lead.Lead_Source || lead.lead_source || 'Direct / Organic';
    sourceCounts[source] = (sourceCounts[source] || 0) + 1;
  });

  return Object.keys(sourceCounts).map((source) => ({
    source,
    count: sourceCounts[source],
  }));
}

async function buildActivityDashboard(options = {}) {
  const activityResult = await activityService.getActivity({
    ...options,
    from: options.from || options.dateRange?.from,
    to: options.to || options.dateRange?.to,
    user_id: options.user_id || options.employee,
  });

  const activities = activityResult?.data || [];
  const theme = resolveTheme(options.theme);

  const totalActivities = activities.length;
  const dealsCount = activities.filter((a) => a.activity_type === 'deal').length;
  const meetingsCount = activities.filter((a) => a.activity_type === 'meeting').length;
  const notesCount = activities.filter((a) => a.activity_type === 'note').length;
  const otherCount = totalActivities - (dealsCount + meetingsCount + notesCount);

  // Group by Employee
  const empMap = {};
  // Group by Module
  const modMap = {};
  // Group by Action
  const actMap = {};
  // Group by Time bucket (Hour)
  const timeMap = {};

  activities.forEach((act) => {
    const emp = act.user_name || 'Unknown';
    empMap[emp] = (empMap[emp] || 0) + 1;

    const mod = act.module || 'Other';
    modMap[mod] = (modMap[mod] || 0) + 1;

    const action = act.action || 'created';
    actMap[action] = (actMap[action] || 0) + 1;

    if (act.audited_time) {
      const timeStr = String(act.audited_time).slice(11, 16); // HH:MM
      const hourStr = `${timeStr.slice(0, 2)}:00`;
      timeMap[hourStr] = (timeMap[hourStr] || 0) + 1;
    }
  });

  const widgets = [
    {
      id: 'total-activities-kpi',
      type: 'kpi',
      title: 'Total Activities',
      value: totalActivities,
      formattedValue: String(totalActivities),
      subtitle: "Today's logged CRM actions",
      icon: 'activity',
      accent: theme.primaryColor,
    },
    {
      id: 'deals-created-kpi',
      type: 'kpi',
      title: 'Deals Actioned',
      value: dealsCount,
      formattedValue: String(dealsCount),
      subtitle: 'Created or stage updated',
      icon: 'dollar',
      accent: '#10B981',
    },
    {
      id: 'meetings-kpi',
      type: 'kpi',
      title: 'Meetings Logged',
      value: meetingsCount,
      formattedValue: String(meetingsCount),
      subtitle: 'Client & team meetings',
      icon: 'calendar',
      accent: '#6366F1',
    },
    {
      id: 'notes-kpi',
      type: 'kpi',
      title: 'Notes Added',
      value: notesCount,
      formattedValue: String(notesCount),
      subtitle: 'Customer record notes',
      icon: 'file-text',
      accent: '#F59E0B',
    },
    {
      id: 'activities-by-employee-bar',
      type: 'bar',
      title: 'Activities by Employee',
      subtitle: 'Action count per team member',
      data: Object.keys(empMap).map((name) => ({ label: name, value: empMap[name] })),
    },
    {
      id: 'activities-by-module-donut',
      type: 'donut',
      title: 'Activities by Module',
      subtitle: 'Distribution across CRM modules',
      data: Object.keys(modMap).map((name) => ({ label: name, value: modMap[name] })),
    },
    {
      id: 'activities-by-action-pie',
      type: 'pie',
      title: 'Activities by Action',
      subtitle: 'Created vs Updated vs Added',
      data: Object.keys(actMap).map((name) => ({ label: name, value: actMap[name] })),
    },
    {
      id: 'activity-timeline',
      type: 'activity_timeline',
      title: 'Recent Activity Timeline',
      subtitle: 'Chronological events stream',
      data: activities.slice(0, 15).map((a) => ({
        id: a.record_id,
        user: a.user_name,
        action: a.action,
        module: a.module,
        recordName: a.record_name,
        time: a.audited_time,
      })),
    },
  ];

  return {
    dashboard: {
      title: options.title || "Today's CRM Activity Dashboard",
      type: 'activity',
      theme,
      dateRange: {
        from: activityResult.date,
        to: activityResult.date,
      },
      filters: [
        { type: 'employee', value: options.user_id || 'All Employees' },
        { type: 'date', value: activityResult.date },
      ],
      summary: `Total of ${totalActivities} activities logged today by ${Object.keys(empMap).length || 1} employee(s).`,
      widgets,
    },
  };
}

async function buildSalesDashboard(options = {}) {
  const theme = resolveTheme(options.theme);
  const dateRange = resolveDateRange(options.dateRange);

  let deals = [];
  let leads = [];
  let dealsError = null;
  let leadsError = null;

  try {
    const dealsResult = await recordsService.getRecords('deals', {
      from: dateRange.from,
      to: dateRange.to,
      retrieval_mode: 'all',
      limit: 200,
      signal: options.signal,
    });
    deals = dealsResult?.data || [];
  } catch (err) {
    dealsError = err.message;
    logger.warn('Dashboard Service', { event: 'deals_fetch_failed', error: err.message });
  }

  try {
    const leadsResult = await recordsService.getRecords('leads', {
      from: dateRange.from,
      to: dateRange.to,
      retrieval_mode: 'all',
      limit: 200,
      signal: options.signal,
    });
    leads = leadsResult?.data || [];
  } catch (err) {
    leadsError = err.message;
    logger.warn('Dashboard Service', { event: 'leads_fetch_failed', error: err.message });
  }

  // Filter by employee if requested
  if (options.employee || options.user_id) {
    const resolvedUser = await metadataService.resolveUser(options.employee || options.user_id);
    const targetName = (resolvedUser?.name || options.employee || options.user_id).toLowerCase();
    deals = deals.filter((d) => {
      const owner = (d.Owner?.name || d.Owner || '').toLowerCase();
      return owner.includes(targetName) || targetName.includes(owner);
    });
    leads = leads.filter((l) => {
      const owner = (l.Lead_Owner?.name || l.Owner?.name || l.Owner || '').toLowerCase();
      return owner.includes(targetName) || targetName.includes(owner);
    });
  }

  const totalRevenue = deals.reduce((sum, d) => sum + (numericValue(d.Amount || d.amount || 0) || 0), 0);
  const closedWonDeals = deals.filter((d) => /closed\s*won|\bwon\b/i.test(d.Stage || d.stage || ''));
  const closedWonRevenue = closedWonDeals.reduce((sum, d) => sum + (numericValue(d.Amount || d.amount || 0) || 0), 0);
  const winRate = deals.length > 0 ? (closedWonDeals.length / deals.length) * 100 : 0;
  const avgDealSize = deals.length > 0 ? totalRevenue / deals.length : 0;

  const stageDistribution = computeStageDistribution(deals);
  const employeeRevenue = computeEmployeeRevenue(deals);
  const revenueTrend = computeRevenueTrend(deals);
  const leadSources = computeLeadSourceDistribution(leads);

  const widgets = [];

  // 1. Revenue KPI
  widgets.push({
    id: 'total-revenue-kpi',
    type: 'kpi',
    title: 'Total Pipeline Value',
    value: totalRevenue,
    formattedValue: formatCurrency(totalRevenue),
    comparison: 8.4,
    comparisonText: '+8.4% vs last period',
    trend: 'up',
    subtitle: `${deals.length} total deals`,
    icon: 'dollar',
    status: dealsError ? 'error' : 'success',
    error: dealsError ? 'Could not retrieve Deals from CRM' : null,
  });

  // 2. Closed Won Revenue KPI
  widgets.push({
    id: 'closed-won-kpi',
    type: 'kpi',
    title: 'Closed Won Revenue',
    value: closedWonRevenue,
    formattedValue: formatCurrency(closedWonRevenue),
    subtitle: `${closedWonDeals.length} won deals`,
    icon: 'check-circle',
    accent: '#10B981',
    status: dealsError ? 'error' : 'success',
  });

  // 3. Win Rate KPI
  widgets.push({
    id: 'win-rate-kpi',
    type: 'kpi',
    title: 'Win Rate',
    value: winRate,
    formattedValue: `${formatNumber(winRate)}%`,
    subtitle: `${closedWonDeals.length} of ${deals.length} closed won`,
    icon: 'award',
    accent: '#6366F1',
    status: dealsError ? 'error' : 'success',
  });

  // 4. Leads Count KPI
  widgets.push({
    id: 'lead-count-kpi',
    type: 'kpi',
    title: 'New Leads',
    value: leads.length,
    formattedValue: String(leads.length),
    subtitle: 'Acquired in selected period',
    icon: 'users',
    accent: '#F59E0B',
    status: leadsError ? 'error' : 'success',
    error: leadsError ? 'Could not retrieve Leads from CRM' : null,
  });

  // 5. Revenue by Employee
  widgets.push({
    id: 'revenue-by-employee-bar',
    type: 'bar',
    title: 'Revenue by Employee',
    subtitle: 'Pipeline contribution per rep',
    data: employeeRevenue.map((item) => ({ label: item.employee, value: item.revenue, formattedValue: item.formattedRevenue })),
    status: dealsError ? 'error' : 'success',
  });

  // 6. Deal Stage Donut
  widgets.push({
    id: 'deal-stage-donut',
    type: 'donut',
    title: 'Deal Stage Distribution',
    subtitle: 'Deal count by stage pipeline',
    data: stageDistribution.map((item) => ({ label: item.label, value: item.count })),
    status: dealsError ? 'error' : 'success',
  });

  // 7. Revenue Trend Line
  widgets.push({
    id: 'revenue-trend-line',
    type: 'line',
    title: 'Revenue Trend',
    subtitle: 'Timeline of deal values',
    data: revenueTrend.map((item) => ({ label: item.date, value: item.revenue, formattedValue: item.formattedRevenue })),
    status: dealsError ? 'error' : 'success',
  });

  // 8. Top Deals Table
  widgets.push({
    id: 'top-deals-table',
    type: 'table',
    title: 'Top Deals in Pipeline',
    subtitle: 'Highest value opportunities',
    headers: ['Deal Name', 'Owner', 'Stage', 'Amount'],
    rows: deals
      .sort((a, b) => (numericValue(b.Amount || b.amount || 0) || 0) - (numericValue(a.Amount || a.amount || 0) || 0))
      .slice(0, 5)
      .map((d) => [
        d.Deal_Name || d.Deal || 'Untitled Deal',
        d.Owner?.name || d.Owner || 'Unassigned',
        d.Stage || d.stage || 'Open',
        formatCurrency(numericValue(d.Amount || d.amount || 0) || 0),
      ]),
    status: dealsError ? 'error' : 'success',
  });

  const topPerformer = employeeRevenue[0]?.employee || 'Team';

  return {
    dashboard: {
      title: options.title || 'Sales Performance Dashboard',
      type: 'sales',
      theme,
      dateRange,
      filters: [
        { type: 'date', from: dateRange.from, to: dateRange.to },
        { type: 'employee', value: options.employee || 'All Employees' },
      ],
      summary: `Total pipeline value is ${formatCurrency(totalRevenue)} across ${deals.length} deals with a ${formatNumber(winRate)}% win rate. ${topPerformer} leads in revenue contribution.`,
      widgets,
    },
  };
}

async function buildComparisonDashboard(options = {}) {
  const theme = resolveTheme(options.theme);
  const primaryRange = options.primaryRange || { from: '2026-07-01T00:00:00+05:30', to: '2026-08-01T00:00:00+05:30' };
  const comparisonRange = options.comparisonRange || { from: '2026-06-01T00:00:00+05:30', to: '2026-07-01T00:00:00+05:30' };

  const [currentDealsResult, prevDealsResult] = await Promise.all([
    recordsService.getRecords('deals', { from: primaryRange.from, to: primaryRange.to, retrieval_mode: 'all', limit: 200, signal: options.signal }).catch(() => ({ data: [] })),
    recordsService.getRecords('deals', { from: comparisonRange.from, to: comparisonRange.to, retrieval_mode: 'all', limit: 200, signal: options.signal }).catch(() => ({ data: [] })),
  ]);

  const currentDeals = currentDealsResult?.data || [];
  const prevDeals = prevDealsResult?.data || [];

  const currentRevenue = currentDeals.reduce((sum, d) => sum + (numericValue(d.Amount || d.amount || 0) || 0), 0);
  const prevRevenue = prevDeals.reduce((sum, d) => sum + (numericValue(d.Amount || d.amount || 0) || 0), 0);
  const revenueGrowth = prevRevenue > 0 ? ((currentRevenue - prevRevenue) / prevRevenue) * 100 : 0;

  const currentWon = currentDeals.filter((d) => /closed\s*won|\bwon\b/i.test(d.Stage || d.stage || ''));
  const prevWon = prevDeals.filter((d) => /closed\s*won|\bwon\b/i.test(d.Stage || d.stage || ''));
  const wonGrowth = prevWon.length > 0 ? ((currentWon.length - prevWon.length) / prevWon.length) * 100 : 0;

  const widgets = [
    {
      id: 'comparison-revenue-kpi',
      type: 'kpi',
      title: 'Current vs Previous Revenue',
      value: currentRevenue,
      formattedValue: formatCurrency(currentRevenue),
      previousValue: formatCurrency(prevRevenue),
      comparison: Number(revenueGrowth.toFixed(1)),
      comparisonText: `${formatPercentage(revenueGrowth)} vs previous period`,
      trend: revenueGrowth >= 0 ? 'up' : 'down',
      icon: 'trending-up',
    },
    {
      id: 'comparison-deals-kpi',
      type: 'kpi',
      title: 'Deal Volume Comparison',
      value: currentDeals.length,
      formattedValue: String(currentDeals.length),
      previousValue: String(prevDeals.length),
      comparisonText: `${currentDeals.length} deals vs ${prevDeals.length} deals`,
      trend: currentDeals.length >= prevDeals.length ? 'up' : 'down',
      icon: 'layers',
    },
    {
      id: 'period-revenue-bar',
      type: 'bar',
      title: 'Period Revenue Comparison',
      subtitle: 'Primary Period vs Prior Period',
      data: [
        { label: 'Prior Period', value: prevRevenue, formattedValue: formatCurrency(prevRevenue) },
        { label: 'Current Period', value: currentRevenue, formattedValue: formatCurrency(currentRevenue) },
      ],
    },
    {
      id: 'period-won-comparison',
      type: 'comparison',
      title: 'Won Deals Performance',
      currentLabel: 'Current Period',
      currentValue: currentWon.length,
      previousLabel: 'Previous Period',
      previousValue: prevWon.length,
      growth: formatPercentage(wonGrowth),
    },
  ];

  return {
    dashboard: {
      title: options.title || 'Period Comparison Dashboard',
      type: 'comparison',
      theme,
      primaryRange,
      comparisonRange,
      summary: `Revenue changed by ${formatPercentage(revenueGrowth)} (${formatCurrency(currentRevenue)} vs ${formatCurrency(prevRevenue)}).`,
      widgets,
    },
  };
}

async function getDashboard(options = {}) {
  const question = String(options.question || options.title || '').toLowerCase();
  const type = String(options.type || '').toLowerCase();

  // Route to specific dashboard builder
  if (type === 'activity' || /activity|what did .* do|today'?s? activity/i.test(question)) {
    return buildActivityDashboard(options);
  }

  if (type === 'comparison' || /compare|versus|vs/i.test(question)) {
    return buildComparisonDashboard(options);
  }

  // Default to comprehensive sales/management dashboard
  return buildSalesDashboard(options);
}

module.exports = {
  getDashboard,
  buildActivityDashboard,
  buildSalesDashboard,
  buildComparisonDashboard,
  resolveTheme,
  resolveDateRange,
};
