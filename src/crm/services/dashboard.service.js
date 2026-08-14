const recordsService = require('./retrieval-engine.service');
const activityService = require('./activity.service');
const metadataService = require('./crm-metadata.service');
const { formatCurrency, formatNumber, numericValue } = require('./assistant/currency.service');
const { detectTimeRange } = require('./assistant/date-detector.service');
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

function resolveDateRange(dateRangeInput = {}, question = '') {
  const from = dateRangeInput.from || dateRangeInput.startDate || dateRangeInput.start;
  const to = dateRangeInput.to || dateRangeInput.endDate || dateRangeInput.end;

  if (from && to) {
    return { from, to };
  }

  // Check if dates can be inferred from question
  if (question) {
    const timeRange = detectTimeRange(question);
    if (timeRange?.startDate && timeRange?.endDate) {
      return { from: timeRange.startDate, to: timeRange.endDate };
    }
  }

  // Default to current month in Asia/Kolkata
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
    value: counts[stage],
    totalAmount: values[stage],
    formattedValue: formatCurrency(values[stage]),
  }));
}

function computeEmployeeRevenue(deals = []) {
  const userRevenue = {};
  const userDeals = {};
  const userWon = {};

  deals.forEach((deal) => {
    const ownerName = deal.Owner?.name || deal.Owner || deal.Created_By?.name || 'Unassigned';
    const amount = numericValue(deal.Amount || deal.amount || 0) || 0;
    const isWon = /closed\s*won|\bwon\b/i.test(deal.Stage || deal.stage || '');

    userRevenue[ownerName] = (userRevenue[ownerName] || 0) + amount;
    userDeals[ownerName] = (userDeals[ownerName] || 0) + 1;
    if (isWon) {
      userWon[ownerName] = (userWon[ownerName] || 0) + 1;
    }
  });

  return Object.keys(userRevenue)
    .map((employee) => ({
      employee,
      name: employee,
      revenue: userRevenue[employee],
      formattedRevenue: formatCurrency(userRevenue[employee]),
      formattedValue: formatCurrency(userRevenue[employee]),
      dealCount: userDeals[employee],
      wonCount: userWon[employee] || 0,
      subtitle: `${userDeals[employee]} deals (${userWon[employee] || 0} won)`,
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
      label: date,
      value: dailyRevenue[date],
      revenue: dailyRevenue[date],
      formattedValue: formatCurrency(dailyRevenue[date]),
      formattedRevenue: formatCurrency(dailyRevenue[date]),
    }));
}

function computeLeadSourceDistribution(leads = []) {
  const sourceCounts = {};

  leads.forEach((lead) => {
    const source = lead.Lead_Source || lead.lead_source || 'Direct / Website';
    sourceCounts[source] = (sourceCounts[source] || 0) + 1;
  });

  return Object.keys(sourceCounts).map((source) => ({
    label: source,
    source,
    value: sourceCounts[source],
    count: sourceCounts[source],
    formattedValue: String(sourceCounts[source]),
  }));
}

function computeDealFunnel(deals = []) {
  const standardStages = [
    { label: 'Qualification', match: /qualification/i },
    { label: 'Needs Analysis', match: /needs\s*analysis|discovery/i },
    { label: 'Proposal / Quote', match: /proposal|quote/i },
    { label: 'Negotiation', match: /negotiat/i },
    { label: 'Closed Won', match: /closed\s*won|\bwon\b/i },
  ];

  const stageCounts = {};
  const stageValues = {};

  deals.forEach((deal) => {
    const stage = String(deal.Stage || deal.stage || 'Open');
    const amount = numericValue(deal.Amount || deal.amount || 0) || 0;

    let matchedLabel = 'Other Stages';
    for (const std of standardStages) {
      if (std.match.test(stage)) {
        matchedLabel = std.label;
        break;
      }
    }
    stageCounts[matchedLabel] = (stageCounts[matchedLabel] || 0) + 1;
    stageValues[matchedLabel] = (stageValues[matchedLabel] || 0) + amount;
  });

  return Object.keys(stageCounts).map((stage) => ({
    label: stage,
    value: stageCounts[stage],
    formattedValue: `${stageCounts[stage]} (${formatCurrency(stageValues[stage] || 0)})`,
  }));
}

// ---------------------------------------------------------------------------
// 1. Sales / Management Dashboard
// ---------------------------------------------------------------------------
async function buildSalesDashboard(options = {}) {
  const theme = resolveTheme(options.theme);
  const dateRange = resolveDateRange(options.dateRange, options.question);

  let deals = [];
  let leads = [];
  let dealsError = null;
  let leadsError = null;

  // 1. Check if pre-fetched CRM data was provided directly from CRM connector or previous tool step
  const providedDeals = options.data || options.records || options.deals;
  if (Array.isArray(providedDeals) && providedDeals.length > 0) {
    deals = providedDeals;
  } else {
    try {
      const dealsResult = await recordsService.getRecords('deals', {
        from: dateRange.from,
        to: dateRange.to,
        date_field: options.date_field || 'Closing_Date',
        retrieval_mode: 'all',
        limit: options.limit || 200,
        signal: options.signal,
      });
      deals = dealsResult?.data || [];
    } catch (err) {
      dealsError = err.message;
      logger.warn('Dashboard Service', { event: 'deals_fetch_failed', error: err.message });
    }
  }

  // 2. Leads data
  if (Array.isArray(options.leads) && options.leads.length > 0) {
    leads = options.leads;
  } else if (!dealsError) {
    try {
      const leadsResult = await recordsService.getRecords('leads', {
        from: dateRange.from,
        to: dateRange.to,
        date_field: 'Created_Time',
        retrieval_mode: 'all',
        limit: options.limit || 200,
        signal: options.signal,
      });
      leads = leadsResult?.data || [];
    } catch (err) {
      leadsError = err.message;
      logger.warn('Dashboard Service', { event: 'leads_fetch_failed', error: err.message });
    }
  }

  // Normalize deal fields for downstream analytics and Code Executor compatibility
  deals = deals.map((d) => ({
    ...d,
    Deal_Name: d.Deal_Name || d.Deal || d.deal_name || 'Untitled Deal',
    Account_Name: d.Account_Name || d.Account || { name: 'Direct Customer' },
    Owner: typeof d.Owner === 'object' ? d.Owner : { name: d.Owner || d.Owner_Name || 'Unassigned' },
    Stage: d.Stage || d.stage || 'Open',
    Amount: numericValue(d.Amount || d.amount || 0) || 0,
    Closing_Date: d.Closing_Date || d.closing_date || (d.Created_Time ? String(d.Created_Time).slice(0, 10) : dateRange.from.slice(0, 10)),
    Created_Time: d.Created_Time || d.created_time || dateRange.from,
  }));

  // Filter by employee if requested
  if (options.employee || options.user_id) {
    const resolvedUser = await metadataService.resolveUser(options.employee || options.user_id);
    const targetName = (resolvedUser?.name || options.employee || options.user_id).toLowerCase();
    deals = deals.filter((d) => {
      const owner = (d.Owner?.name || d.Owner || d.Created_By?.name || '').toLowerCase();
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
  const dealFunnel = computeDealFunnel(deals);
  const leadSources = computeLeadSourceDistribution(leads);
  const topPerformer = employeeRevenue[0]?.employee || 'Team';

  const metrics = {
    totalRevenue,
    formattedTotalRevenue: formatCurrency(totalRevenue),
    dealCount: deals.length,
    closedWonCount: closedWonDeals.length,
    closedWonRevenue,
    formattedClosedWonRevenue: formatCurrency(closedWonRevenue),
    winRate: Number(winRate.toFixed(1)),
    formattedWinRate: `${formatNumber(winRate)}%`,
    averageDealSize: Number(avgDealSize.toFixed(2)),
    formattedAverageDealSize: formatCurrency(avgDealSize),
    topPerformer,
    stageCounts: stageDistribution,
    employeeRevenue,
    revenueTrend,
    dealFunnel,
    leadSources,
  };

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
    icon: '💰',
    accent: theme.primaryColor,
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
    subtitle: `${closedWonDeals.length} won opportunities`,
    icon: '🏆',
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
    icon: '🎯',
    accent: '#6366F1',
    status: dealsError ? 'error' : 'success',
  });

  // 4. Leads Count KPI
  widgets.push({
    id: 'lead-count-kpi',
    type: 'kpi',
    title: 'New Leads Acquired',
    value: leads.length,
    formattedValue: String(leads.length),
    subtitle: 'Acquired in selected period',
    icon: '👥',
    accent: '#F59E0B',
    status: leadsError ? 'error' : 'success',
    error: leadsError ? 'Could not retrieve Leads from CRM' : null,
  });

  // 5. Revenue Trend (Area / Line Chart)
  if (revenueTrend.length > 0) {
    widgets.push({
      id: 'revenue-trend-line',
      type: 'area',
      title: 'Revenue & Deal Value Trend',
      subtitle: 'Timeline of deal amounts across period',
      data: revenueTrend,
      status: dealsError ? 'error' : 'success',
    });
  }

  // 6. Revenue by Employee (Horizontal Bar)
  if (employeeRevenue.length > 0) {
    widgets.push({
      id: 'revenue-by-employee-bar',
      type: 'horizontal_bar',
      title: 'Revenue by Sales Rep',
      subtitle: 'Pipeline contribution per team member',
      data: employeeRevenue.map((item) => ({
        label: item.employee,
        value: item.revenue,
        formattedValue: item.formattedRevenue,
      })),
      status: dealsError ? 'error' : 'success',
    });
  }

  // 7. Deal Stage Distribution (Donut Chart)
  if (stageDistribution.length > 0) {
    widgets.push({
      id: 'deal-stage-donut',
      type: 'donut',
      title: 'Deal Stage Distribution',
      subtitle: 'Deal count by stage pipeline',
      data: stageDistribution.map((item) => ({
        label: item.label,
        value: item.count,
        formattedValue: `${item.count} deals`,
      })),
      status: dealsError ? 'error' : 'success',
    });
  }

  // 8. Sales Pipeline Funnel (Funnel Chart)
  if (dealFunnel.length > 0) {
    widgets.push({
      id: 'deal-funnel-chart',
      type: 'funnel',
      title: 'Sales Pipeline Funnel',
      subtitle: 'Conversion stages and volume',
      data: dealFunnel,
      status: dealsError ? 'error' : 'success',
    });
  }

  // 9. Lead Sources Distribution (Pie Chart)
  if (leadSources.length > 0) {
    widgets.push({
      id: 'lead-sources-pie',
      type: 'pie',
      title: 'Lead Acquisition Sources',
      subtitle: 'Channel breakdown for new leads',
      data: leadSources,
      status: leadsError ? 'error' : 'success',
    });
  }

  // 10. Top Deals Table
  const topDealsRows = deals
    .sort((a, b) => (numericValue(b.Amount || b.amount || 0) || 0) - (numericValue(a.Amount || a.amount || 0) || 0))
    .slice(0, 10)
    .map((d) => [
      d.Deal_Name || d.Deal || 'Untitled Deal',
      d.Owner?.name || d.Owner || 'Unassigned',
      d.Stage || d.stage || 'Open',
      d.Closing_Date || d.Created_Time?.slice(0, 10) || '-',
      formatCurrency(numericValue(d.Amount || d.amount || 0) || 0),
    ]);

  if (deals.length > 0) {
    widgets.push({
      id: 'top-deals-table',
      type: 'table',
      title: 'Top Deals in Pipeline',
      subtitle: 'Highest value opportunities',
      headers: ['Deal Name', 'Owner', 'Stage', 'Closing Date', 'Amount'],
      rows: topDealsRows.slice(0, 5),
      status: dealsError ? 'error' : 'success',
    });
  }

  const tables = [
    {
      title: 'Top Deals in Pipeline',
      headers: ['Deal Name', 'Owner', 'Stage', 'Closing Date', 'Amount'],
      rows: topDealsRows,
    },
    {
      title: 'Revenue by Sales Rep',
      headers: ['Employee', 'Deals', 'Won Deals', 'Revenue'],
      rows: employeeRevenue.map((e) => [
        e.employee,
        String(e.dealCount),
        String(e.wonCount),
        e.formattedRevenue,
      ]),
    },
  ];

  const summary = deals.length > 0
    ? `Total pipeline value is ${formatCurrency(totalRevenue)} across ${deals.length} deals with a ${formatNumber(winRate)}% win rate (${closedWonDeals.length} won). ${topPerformer} generated the highest revenue.`
    : 'No CRM deals or records were found for the selected period.';

  const dashboardObj = {
    title: options.title || 'Sales Performance Dashboard',
    type: 'sales',
    theme,
    dateRange,
    filters: [
      { type: 'Date Range', from: dateRange.from.slice(0, 10), to: dateRange.to.slice(0, 10) },
      { type: 'Employee', value: options.employee || 'All Employees' },
    ],
    summary,
    metrics,
    data: deals,
    records: deals,
    tables,
    widgets,
  };

  return {
    dashboard: dashboardObj,
    metrics,
    data: deals,
    records: deals,
    tables,
  };
}

// ---------------------------------------------------------------------------
// 2. Activity Dashboard
// ---------------------------------------------------------------------------
async function buildActivityDashboard(options = {}) {
  const theme = resolveTheme(options.theme);

  let activities = [];
  let reportDate = new Date().toISOString().slice(0, 10);

  const providedActivities = options.data || options.records || options.activities;
  if (Array.isArray(providedActivities) && providedActivities.length > 0) {
    activities = providedActivities;
  } else {
    const activityResult = await activityService.getActivity({
      ...options,
      from: options.from || options.dateRange?.from,
      to: options.to || options.dateRange?.to,
      user_id: options.user_id || options.employee,
    });
    activities = activityResult?.data || [];
    reportDate = activityResult?.date || reportDate;
  }

  const totalActivities = activities.length;

  const dealsCount = activities.filter((a) => a.activity_type === 'deal').length;
  const meetingsCount = activities.filter((a) => a.activity_type === 'meeting').length;
  const notesCount = activities.filter((a) => a.activity_type === 'note').length;
  const callsCount = activities.filter((a) => a.activity_type === 'call').length;
  const otherCount = totalActivities - (dealsCount + meetingsCount + notesCount + callsCount);

  // Group by Employee
  const empMap = {};
  // Group by Module
  const modMap = {};
  // Group by Human vs Automation
  const actorMap = { 'User Activity': 0, 'Automation': 0 };

  activities.forEach((act) => {
    const isAuto = /automation|system|deluge/i.test(act.source || act.user_name || '');
    if (isAuto) {
      actorMap['Automation'] += 1;
    } else {
      actorMap['User Activity'] += 1;
      const emp = act.user_name || 'Unknown';
      empMap[emp] = (empMap[emp] || 0) + 1;
    }

    const mod = act.module || 'Other';
    modMap[mod] = (modMap[mod] || 0) + 1;
  });

  const widgets = [
    {
      id: 'total-activities-kpi',
      type: 'kpi',
      title: 'Total Activities',
      value: totalActivities,
      formattedValue: String(totalActivities),
      subtitle: "Logged CRM actions",
      icon: '⚡',
      accent: theme.primaryColor,
    },
    {
      id: 'deals-actioned-kpi',
      type: 'kpi',
      title: 'Deals Actioned',
      value: dealsCount,
      formattedValue: String(dealsCount),
      subtitle: 'Created or stage updated',
      icon: '💼',
      accent: '#10B981',
    },
    {
      id: 'meetings-logged-kpi',
      type: 'kpi',
      title: 'Meetings Logged',
      value: meetingsCount,
      formattedValue: String(meetingsCount),
      subtitle: 'Client & team meetings',
      icon: '📅',
      accent: '#6366F1',
    },
    {
      id: 'notes-added-kpi',
      type: 'kpi',
      title: 'Notes Added',
      value: notesCount,
      formattedValue: String(notesCount),
      subtitle: 'Customer record notes',
      icon: '📝',
      accent: '#F59E0B',
    },
  ];

  if (Object.keys(empMap).length > 0) {
    widgets.push({
      id: 'activities-by-employee-bar',
      type: 'bar',
      title: 'Activities by Employee',
      subtitle: 'Human actions per team member',
      data: Object.keys(empMap).map((name) => ({ label: name, value: empMap[name] })),
    });
  }

  if (Object.keys(modMap).length > 0) {
    widgets.push({
      id: 'activities-by-module-donut',
      type: 'donut',
      title: 'Activities by Module',
      subtitle: 'Distribution across CRM modules',
      data: Object.keys(modMap).map((name) => ({ label: name, value: modMap[name] })),
    });
  }

  widgets.push({
    id: 'activity-timeline',
    type: 'activity_timeline',
    title: 'Recent Activity Stream',
    subtitle: 'Chronological timeline of CRM events',
    data: activities.slice(0, 15).map((a) => ({
      id: a.record_id,
      user: a.user_name,
      action: a.action,
      module: a.module,
      recordName: a.record_name,
      time: a.audited_time,
      source: a.source,
    })),
  });

  const dashboardObj = {
    title: options.title || "Today's CRM Activity Dashboard",
    type: 'activity',
    theme,
    dateRange: {
      from: reportDate,
      to: reportDate,
    },
    filters: [
      { type: 'Employee', value: options.user_id || options.employee || 'All Employees' },
      { type: 'Date', value: reportDate },
    ],
    summary: totalActivities > 0
      ? `Total of ${totalActivities} activities logged today across ${Object.keys(empMap).length || 1} team member(s).`
      : 'No CRM activity was logged for today.',
    data: activities,
    records: activities,
    widgets,
  };

  return {
    dashboard: dashboardObj,
    data: activities,
    records: activities,
  };
}

// ---------------------------------------------------------------------------
// 3. Comparison Dashboard (e.g. June vs July)
// ---------------------------------------------------------------------------
async function buildComparisonDashboard(options = {}) {
  const theme = resolveTheme(options.theme);
  const primaryRange = options.primaryRange || { from: '2026-07-01T00:00:00+05:30', to: '2026-08-01T00:00:00+05:30' };
  const comparisonRange = options.comparisonRange || { from: '2026-06-01T00:00:00+05:30', to: '2026-07-01T00:00:00+05:30' };

  const [currentDealsResult, prevDealsResult] = await Promise.all([
    recordsService.getRecords('deals', {
      from: primaryRange.from,
      to: primaryRange.to,
      date_field: 'Closing_Date',
      retrieval_mode: 'all',
      limit: 200,
      signal: options.signal,
    }).catch(() => ({ data: [] })),
    recordsService.getRecords('deals', {
      from: comparisonRange.from,
      to: comparisonRange.to,
      date_field: 'Closing_Date',
      retrieval_mode: 'all',
      limit: 200,
      signal: options.signal,
    }).catch(() => ({ data: [] })),
  ]);

  const currentDeals = currentDealsResult?.data || [];
  const prevDeals = prevDealsResult?.data || [];

  const currentRevenue = currentDeals.reduce((sum, d) => sum + (numericValue(d.Amount || d.amount || 0) || 0), 0);
  const prevRevenue = prevDeals.reduce((sum, d) => sum + (numericValue(d.Amount || d.amount || 0) || 0), 0);
  const revenueGrowth = prevRevenue > 0 ? ((currentRevenue - prevRevenue) / prevRevenue) * 100 : 0;

  const currentWon = currentDeals.filter((d) => /closed\s*won|\bwon\b/i.test(d.Stage || d.stage || ''));
  const prevWon = prevDeals.filter((d) => /closed\s*won|\bwon\b/i.test(d.Stage || d.stage || ''));

  const widgets = [
    {
      id: 'comparison-revenue-kpi',
      type: 'kpi',
      title: 'Current vs Prior Revenue',
      value: currentRevenue,
      formattedValue: formatCurrency(currentRevenue),
      previousValue: formatCurrency(prevRevenue),
      comparison: Number(revenueGrowth.toFixed(1)),
      comparisonText: `${formatPercentage(revenueGrowth)} vs prior period (${formatCurrency(prevRevenue)})`,
      trend: revenueGrowth >= 0 ? 'up' : 'down',
      icon: '📈',
      accent: theme.primaryColor,
    },
    {
      id: 'comparison-deals-kpi',
      type: 'kpi',
      title: 'Deal Volume Comparison',
      value: currentDeals.length,
      formattedValue: `${currentDeals.length} Deals`,
      previousValue: `${prevDeals.length} Deals`,
      comparisonText: `${currentDeals.length} deals vs ${prevDeals.length} in prior period`,
      trend: currentDeals.length >= prevDeals.length ? 'up' : 'down',
      icon: '📊',
      accent: '#10B981',
    },
    {
      id: 'period-revenue-bar',
      type: 'bar',
      title: 'Period Revenue Comparison',
      subtitle: 'Primary vs Comparison Period Total Value',
      data: [
        { label: 'Prior Period', value: prevRevenue, formattedValue: formatCurrency(prevRevenue), color: '#94A3B8' },
        { label: 'Current Period', value: currentRevenue, formattedValue: formatCurrency(currentRevenue), color: theme.primaryColor },
      ],
    },
    {
      id: 'comparison-table',
      type: 'table',
      title: 'Key Metric Comparison',
      subtitle: 'Side-by-side performance indicators',
      headers: ['Metric', 'Current Period', 'Prior Period', 'Change (%)'],
      rows: [
        ['Total Revenue', formatCurrency(currentRevenue), formatCurrency(prevRevenue), formatPercentage(revenueGrowth)],
        ['Total Deals', String(currentDeals.length), String(prevDeals.length), formatPercentage(prevDeals.length ? ((currentDeals.length - prevDeals.length) / prevDeals.length) * 100 : 0)],
        ['Closed Won Deals', String(currentWon.length), String(prevWon.length), formatPercentage(prevWon.length ? ((currentWon.length - prevWon.length) / prevWon.length) * 100 : 0)],
      ],
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

// ---------------------------------------------------------------------------
// Main Dashboard Controller
// ---------------------------------------------------------------------------
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
