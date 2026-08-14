const { Dashboard } = require('./components');

function generateDashboardHtml(dashboardSpec = {}) {
  const dashboard = dashboardSpec.dashboard || dashboardSpec;
  const theme = dashboard.theme || { mode: 'light', primaryColor: '#2563EB', accentColor: '#14B8A6' };
  const renderedDashboard = Dashboard({ dashboard }).render;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${dashboard.title || 'F-GRADE CRM Dashboard'}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      --bg-light: #F8FAFC;
      --bg-dark: #0F172A;
      --card-light: #FFFFFF;
      --card-dark: #1E293B;
      --card-hover-light: #F1F5F9;
      --card-hover-dark: #334155;
      --text-light: #0F172A;
      --text-dark: #F8FAFC;
      --subtext-light: #64748B;
      --subtext-dark: #94A3B8;
      --border-light: #E2E8F0;
      --border-dark: #334155;
      --primary: ${theme.primaryColor || '#2563EB'};
      --accent: ${theme.accentColor || '#14B8A6'};
      --success: #10B981;
      --danger: #EF4444;
      --warning: #F59E0B;
      --radius-sm: 8px;
      --radius-md: 12px;
      --radius-lg: 16px;
      --shadow-sm: 0 1px 3px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.02);
      --shadow-md: 0 4px 14px rgba(0,0,0,0.06), 0 2px 6px rgba(0,0,0,0.03);
      --shadow-hover: 0 10px 25px rgba(0,0,0,0.09), 0 4px 10px rgba(0,0,0,0.04);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--font-family);
      background-color: var(--bg-light);
      color: var(--text-light);
      transition: background-color 0.25s ease, color 0.25s ease;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    body.dark-mode {
      background-color: var(--bg-dark);
      color: var(--text-dark);
    }

    .fgrade-dashboard-root {
      max-width: 1380px;
      margin: 0 auto;
      padding: 32px 24px 64px;
    }

    .fgrade-top-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border-light);
    }
    body.dark-mode .fgrade-top-bar {
      border-color: var(--border-dark);
    }

    .fgrade-brand-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 1.2px;
      color: var(--primary);
      text-transform: uppercase;
      background: rgba(37, 99, 235, 0.08);
      padding: 4px 10px;
      border-radius: 20px;
    }
    body.dark-mode .fgrade-brand-badge {
      background: rgba(59, 130, 246, 0.18);
    }

    .fgrade-actions-group {
      display: flex;
      gap: 10px;
    }

    .fgrade-btn {
      background: var(--card-light);
      border: 1px solid var(--border-light);
      padding: 8px 16px;
      border-radius: var(--radius-sm);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      color: inherit;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      box-shadow: var(--shadow-sm);
      transition: all 0.2s ease;
    }
    body.dark-mode .fgrade-btn {
      background: var(--card-dark);
      border-color: var(--border-dark);
    }
    .fgrade-btn:hover {
      background: var(--card-hover-light);
      transform: translateY(-1px);
      box-shadow: var(--shadow-md);
    }
    body.dark-mode .fgrade-btn:hover {
      background: var(--card-hover-dark);
    }

    .fgrade-dashboard-header {
      margin-bottom: 24px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .fgrade-dashboard-title {
      font-size: 28px;
      font-weight: 800;
      letter-spacing: -0.6px;
    }
    .fgrade-dashboard-summary {
      font-size: 15px;
      color: var(--subtext-light);
      max-width: 900px;
      line-height: 1.6;
    }
    body.dark-mode .fgrade-dashboard-summary {
      color: var(--subtext-dark);
    }

    /* Filter Bar */
    .fgrade-filter-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
      flex-wrap: wrap;
      gap: 12px;
    }
    .fgrade-filter-list {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .fgrade-filter-pill {
      background: rgba(37, 99, 235, 0.08);
      border: 1px solid rgba(37, 99, 235, 0.15);
      border-radius: 20px;
      padding: 6px 14px;
      font-size: 12px;
      font-weight: 600;
      color: var(--primary);
      display: inline-flex;
      gap: 6px;
      align-items: center;
    }
    body.dark-mode .fgrade-filter-pill {
      background: rgba(59, 130, 246, 0.16);
      border-color: rgba(59, 130, 246, 0.25);
    }

    /* Main Grid */
    .fgrade-dashboard-grid {
      display: grid;
      grid-template-columns: repeat(12, 1fr);
      gap: 20px;
    }

    /* Cards */
    .fgrade-widget-card, .fgrade-kpi-card {
      background-color: var(--card-light);
      border: 1px solid var(--border-light);
      border-radius: var(--radius-md);
      padding: 22px;
      box-shadow: var(--shadow-sm);
      transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease;
      grid-column: span 6;
      display: flex;
      flex-direction: column;
      position: relative;
    }
    body.dark-mode .fgrade-widget-card, body.dark-mode .fgrade-kpi-card {
      background-color: var(--card-dark);
      border-color: var(--border-dark);
      box-shadow: 0 2px 6px rgba(0,0,0,0.25);
    }
    .fgrade-widget-card:hover, .fgrade-kpi-card:hover {
      transform: translateY(-2px);
      box-shadow: var(--shadow-hover);
      border-color: rgba(37, 99, 235, 0.25);
    }

    /* Specific Grid Spans */
    .fgrade-kpi-card {
      grid-column: span 3;
    }
    @media (max-width: 1100px) {
      .fgrade-kpi-card { grid-column: span 6; }
      .fgrade-widget-card { grid-column: span 12; }
    }
    @media (max-width: 640px) {
      .fgrade-kpi-card { grid-column: span 12; }
      .fgrade-widget-card { grid-column: span 12; }
    }

    /* KPI styling */
    .fgrade-kpi-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
      font-weight: 700;
      color: var(--subtext-light);
      text-transform: uppercase;
      letter-spacing: 0.6px;
      margin-bottom: 8px;
    }
    body.dark-mode .fgrade-kpi-top { color: var(--subtext-dark); }
    .fgrade-kpi-value {
      font-size: 30px;
      font-weight: 800;
      letter-spacing: -0.8px;
      margin-bottom: 6px;
      color: inherit;
    }
    .fgrade-kpi-comparison {
      font-size: 12px;
      font-weight: 700;
      margin-bottom: 4px;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .trend-up { color: var(--success); }
    .trend-down { color: var(--danger); }
    .trend-neutral { color: var(--subtext-light); }
    .fgrade-kpi-subtitle {
      font-size: 12px;
      color: var(--subtext-light);
    }
    body.dark-mode .fgrade-kpi-subtitle { color: var(--subtext-dark); }

    /* Widget Header */
    .fgrade-widget-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 18px;
    }
    .fgrade-widget-title {
      font-size: 16px;
      font-weight: 700;
      letter-spacing: -0.2px;
      margin-bottom: 3px;
    }
    .fgrade-widget-subtitle {
      font-size: 12px;
      color: var(--subtext-light);
    }
    body.dark-mode .fgrade-widget-subtitle { color: var(--subtext-dark); }

    /* Horizontal Bar */
    .fgrade-hbar-container { display: flex; flex-direction: column; gap: 12px; }
    .fgrade-hbar-row { display: flex; align-items: center; gap: 14px; font-size: 13px; }
    .fgrade-hbar-label { width: 110px; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; font-weight: 600; }
    .fgrade-hbar-track { flex: 1; height: 12px; background: rgba(0,0,0,0.06); border-radius: 8px; overflow: hidden; }
    body.dark-mode .fgrade-hbar-track { background: rgba(255,255,255,0.08); }
    .fgrade-hbar-fill { height: 100%; border-radius: 8px; transition: width 0.5s cubic-bezier(0.4, 0, 0.2, 1); }
    .fgrade-hbar-val { width: 95px; text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }

    /* Vertical Bar */
    .fgrade-vbar-container { display: flex; height: 190px; align-items: flex-end; gap: 16px; padding-top: 20px; }
    .fgrade-vbar-col { flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; justify-content: flex-end; gap: 6px; }
    .fgrade-vbar-track { width: 32px; height: 100%; background: rgba(0,0,0,0.06); border-radius: 8px 8px 0 0; display: flex; align-items: flex-end; }
    body.dark-mode .fgrade-vbar-track { background: rgba(255,255,255,0.08); }
    .fgrade-vbar-fill { width: 100%; border-radius: 8px 8px 0 0; transition: height 0.5s cubic-bezier(0.4, 0, 0.2, 1); }
    .fgrade-vbar-label { font-size: 11px; font-weight: 600; text-align: center; max-width: 70px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fgrade-vbar-val { font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; }

    /* Stacked Bar */
    .fgrade-stacked-legend { display: flex; gap: 14px; margin-bottom: 16px; flex-wrap: wrap; }
    .fgrade-legend-item { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; }
    .fgrade-legend-dot { width: 9px; height: 9px; border-radius: 3px; }
    .fgrade-stacked-container { display: flex; flex-direction: column; gap: 12px; }
    .fgrade-stacked-row { display: flex; align-items: center; gap: 12px; font-size: 13px; }
    .fgrade-stacked-label { width: 100px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fgrade-stacked-track { display: flex; height: 14px; border-radius: 8px; overflow: hidden; background: rgba(0,0,0,0.06); }
    .fgrade-stacked-segment { height: 100%; transition: width 0.4s ease; }
    .fgrade-stacked-val { width: 70px; text-align: right; font-weight: 700; }

    /* Line & Area Chart */
    .fgrade-line-container { width: 100%; height: 200px; }
    .fgrade-line-svg { width: 100%; height: 100%; overflow: visible; }
    .fgrade-line-dot { transition: r 0.2s ease; cursor: pointer; }
    .fgrade-line-dot:hover { r: 6.5; }
    .fgrade-axis-labels { display: flex; justify-content: space-between; margin-top: 8px; font-size: 11px; color: var(--subtext-light); }
    body.dark-mode .fgrade-axis-labels { color: var(--subtext-dark); }

    /* Donut & Pie Chart */
    .fgrade-donut-layout { display: flex; align-items: center; justify-content: space-around; gap: 24px; flex-wrap: wrap; }
    .fgrade-donut-svg { width: 140px; height: 140px; flex-shrink: 0; }
    .fgrade-donut-total { font-size: 22px; font-weight: 800; fill: currentColor; }
    .fgrade-donut-total-lbl { font-size: 10px; font-weight: 700; fill: var(--subtext-light); letter-spacing: 0.8px; }
    .fgrade-donut-legends { display: flex; flex-direction: column; gap: 8px; font-size: 13px; flex: 1; min-width: 170px; }
    .fgrade-donut-legend-item { display: flex; align-items: center; gap: 8px; }
    .fgrade-donut-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
    .fgrade-donut-legend-label { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 120px; }
    .fgrade-donut-legend-val { font-weight: 700; margin-left: auto; font-variant-numeric: tabular-nums; }
    .fgrade-donut-legend-pct { font-size: 12px; font-weight: 600; color: var(--subtext-light); width: 36px; text-align: right; }

    /* Funnel Chart */
    .fgrade-funnel-container { display: flex; flex-direction: column; gap: 10px; }
    .fgrade-funnel-step { display: flex; justify-content: center; }
    .fgrade-funnel-bar {
      border-radius: var(--radius-sm);
      padding: 10px 16px;
      color: #FFFFFF;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 13px;
      font-weight: 700;
      box-shadow: var(--shadow-sm);
      transition: width 0.4s ease;
    }

    /* Data Table */
    .fgrade-table-container { overflow-x: auto; max-height: 320px; }
    .fgrade-data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .fgrade-data-table th, .fgrade-data-table td { padding: 12px 14px; text-align: left; border-bottom: 1px solid var(--border-light); }
    body.dark-mode .fgrade-data-table th, body.dark-mode .fgrade-data-table td { border-color: var(--border-dark); }
    .fgrade-data-table th { font-weight: 700; color: var(--subtext-light); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; position: sticky; top: 0; background: inherit; }
    body.dark-mode .fgrade-data-table th { color: var(--subtext-dark); }
    .cell-numeric { text-align: right !important; font-variant-numeric: tabular-nums; font-weight: 600; }

    /* Ranking Table */
    .fgrade-ranking-list { display: flex; flex-direction: column; gap: 10px; }
    .fgrade-ranking-item { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-radius: var(--radius-sm); background: rgba(0,0,0,0.02); }
    body.dark-mode .fgrade-ranking-item { background: rgba(255,255,255,0.03); }
    .fgrade-ranking-badge { width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 800; background: var(--border-light); color: var(--text-light); flex-shrink: 0; }
    .fgrade-ranking-badge.rank-1 { background: #F59E0B; color: #FFFFFF; }
    .fgrade-ranking-badge.rank-2 { background: #94A3B8; color: #FFFFFF; }
    .fgrade-ranking-badge.rank-3 { background: #D97706; color: #FFFFFF; }
    .fgrade-ranking-details { flex: 1; }
    .fgrade-ranking-name { font-weight: 700; font-size: 13px; }
    .fgrade-ranking-sub { font-size: 11px; color: var(--subtext-light); }
    .fgrade-ranking-value { font-weight: 800; font-size: 14px; font-variant-numeric: tabular-nums; }

    /* Timeline */
    .fgrade-timeline-container { display: flex; flex-direction: column; gap: 14px; max-height: 320px; overflow-y: auto; }
    .fgrade-timeline-item { display: flex; gap: 12px; font-size: 13px; align-items: flex-start; }
    .fgrade-timeline-badge { width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 13px; flex-shrink: 0; }
    .user-badge { background: rgba(37, 99, 235, 0.12); color: var(--primary); }
    .automation-badge { background: rgba(100, 116, 139, 0.15); color: var(--subtext-light); }
    .fgrade-timeline-content { flex: 1; }
    .fgrade-timeline-meta { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
    .fgrade-timeline-time { font-size: 11px; color: var(--subtext-light); }
    .fgrade-timeline-tag { font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; text-transform: uppercase; }
    .tag-user { background: rgba(16, 185, 129, 0.12); color: #10B981; }
    .tag-automation { background: rgba(100, 116, 139, 0.12); color: #64748B; }

    /* Empty & Error State Boxes */
    .fgrade-state-box {
      padding: 32px 16px;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
    }
    .fgrade-state-icon { font-size: 28px; }
    .fgrade-state-text { font-size: 13px; color: var(--subtext-light); font-weight: 500; }
    body.dark-mode .fgrade-state-text { color: var(--subtext-dark); }
  </style>
</head>
<body class="${theme.mode === 'dark' ? 'dark-mode' : ''}">
  <div class="fgrade-dashboard-root">
    <div class="fgrade-top-bar">
      <div class="fgrade-brand-badge">⚡ F-GRADE ANALYTICS ENGINE</div>
      <div class="fgrade-actions-group">
        <button class="fgrade-btn" onclick="window.print()">🖨️ Print Report</button>
        <button class="fgrade-btn" onclick="document.body.classList.toggle('dark-mode')">🌓 Toggle Theme</button>
      </div>
    </div>
    ${renderedDashboard}
  </div>
</body>
</html>`;
}

module.exports = {
  generateDashboardHtml,
};
