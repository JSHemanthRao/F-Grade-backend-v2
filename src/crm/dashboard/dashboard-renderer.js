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
  <style>
    :root {
      --bg-light: #F8FAFC;
      --bg-dark: #0F172A;
      --card-light: #FFFFFF;
      --card-dark: #1E293B;
      --text-light: #0F172A;
      --text-dark: #F8FAFC;
      --subtext-light: #64748B;
      --subtext-dark: #94A3B8;
      --border-light: #E2E8F0;
      --border-dark: #334155;
      --primary: ${theme.primaryColor || '#2563EB'};
      --accent: ${theme.accentColor || '#14B8A6'};
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: var(--bg-light); color: var(--text-light); transition: background-color 0.2s, color 0.2s; }
    body.dark-mode { background-color: var(--bg-dark); color: var(--text-dark); }

    .fgrade-dashboard-root { max-width: 1300px; margin: 0 auto; padding: 24px 16px; }
    .fgrade-dashboard-header { margin-bottom: 24px; display: flex; flex-direction: column; gap: 8px; }
    .fgrade-brand-badge { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: 1px; color: var(--primary); text-transform: uppercase; }
    .fgrade-dashboard-title { font-size: 26px; font-weight: 800; letter-spacing: -0.5px; }
    .fgrade-dashboard-summary { font-size: 14px; color: var(--subtext-light); }
    body.dark-mode .fgrade-dashboard-summary { color: var(--subtext-dark); }

    .fgrade-filter-bar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; flex-wrap: wrap; gap: 12px; }
    .fgrade-filter-list { display: flex; gap: 8px; flex-wrap: wrap; }
    .fgrade-filter-pill { background: rgba(37, 99, 235, 0.08); border-radius: 20px; padding: 6px 14px; font-size: 12px; font-weight: 600; color: var(--primary); display: flex; gap: 6px; align-items: center; }
    body.dark-mode .fgrade-filter-pill { background: rgba(59, 130, 246, 0.18); }

    .fgrade-dashboard-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 18px; }

    .fgrade-widget-card, .fgrade-kpi-card {
      background-color: var(--card-light);
      border: 1px solid var(--border-light);
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
      transition: transform 0.15s, box-shadow 0.15s;
    }
    body.dark-mode .fgrade-widget-card, body.dark-mode .fgrade-kpi-card {
      background-color: var(--card-dark);
      border-color: var(--border-dark);
      box-shadow: 0 1px 3px rgba(0,0,0,0.3);
    }
    .fgrade-widget-card:hover, .fgrade-kpi-card:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.08); }

    .fgrade-kpi-top { display: flex; justify-content: space-between; align-items: center; font-size: 13px; font-weight: 600; color: var(--subtext-light); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
    body.dark-mode .fgrade-kpi-top { color: var(--subtext-dark); }
    .fgrade-kpi-value { font-size: 32px; font-weight: 800; letter-spacing: -1px; margin-bottom: 6px; }
    .fgrade-kpi-comparison { font-size: 12px; font-weight: 600; margin-bottom: 4px; }
    .trend-up { color: #10B981; }
    .trend-down { color: #EF4444; }
    .fgrade-kpi-subtitle { font-size: 12px; color: var(--subtext-light); }
    body.dark-mode .fgrade-kpi-subtitle { color: var(--subtext-dark); }

    .fgrade-widget-header { margin-bottom: 16px; }
    .fgrade-widget-title { font-size: 16px; font-weight: 700; margin-bottom: 4px; }
    .fgrade-widget-subtitle { font-size: 12px; color: var(--subtext-light); }
    body.dark-mode .fgrade-widget-subtitle { color: var(--subtext-dark); }

    .fgrade-hbar-container { display: flex; flex-direction: column; gap: 10px; }
    .fgrade-hbar-row { display: flex; align-items: center; gap: 12px; font-size: 13px; }
    .fgrade-hbar-label { width: 90px; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; font-weight: 500; }
    .fgrade-hbar-track { flex: 1; height: 10px; background: rgba(0,0,0,0.06); border-radius: 6px; overflow: hidden; }
    body.dark-mode .fgrade-hbar-track { background: rgba(255,255,255,0.08); }
    .fgrade-hbar-fill { height: 100%; border-radius: 6px; transition: width 0.4s ease-out; }
    .fgrade-hbar-val { width: 75px; text-align: right; font-weight: 600; }

    .fgrade-vbar-container { display: flex; height: 160px; align-items: flex-end; gap: 14px; padding-top: 20px; }
    .fgrade-vbar-col { flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; justify-content: flex-end; gap: 6px; }
    .fgrade-vbar-track { width: 28px; height: 100%; background: rgba(0,0,0,0.06); border-radius: 6px 6px 0 0; display: flex; align-items: flex-end; }
    body.dark-mode .fgrade-vbar-track { background: rgba(255,255,255,0.08); }
    .fgrade-vbar-fill { width: 100%; border-radius: 6px 6px 0 0; transition: height 0.4s ease-out; }
    .fgrade-vbar-label { font-size: 11px; text-align: center; max-width: 60px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fgrade-vbar-val { font-size: 11px; font-weight: 700; }

    .fgrade-line-container { width: 100%; height: 180px; }
    .fgrade-line-svg { width: 100%; height: 100%; }

    .fgrade-donut-layout { display: flex; align-items: center; justify-content: space-around; gap: 16px; }
    .fgrade-donut-svg { width: 130px; height: 130px; }
    .fgrade-donut-total { font-size: 20px; font-weight: 800; fill: currentColor; }
    .fgrade-donut-legends { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
    .fgrade-donut-legend-item { display: flex; align-items: center; gap: 6px; }
    .fgrade-donut-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
    .fgrade-donut-legend-pct { font-weight: 700; margin-left: auto; }

    .fgrade-data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .fgrade-data-table th, .fgrade-data-table td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border-light); }
    body.dark-mode .fgrade-data-table th, body.dark-mode .fgrade-data-table td { border-color: var(--border-dark); }
    .fgrade-data-table th { font-weight: 700; color: var(--subtext-light); font-size: 11px; text-transform: uppercase; }
    body.dark-mode .fgrade-data-table th { color: var(--subtext-dark); }

    .fgrade-timeline-container { display: flex; flex-direction: column; gap: 12px; max-height: 280px; overflow-y: auto; }
    .fgrade-timeline-item { display: flex; gap: 12px; font-size: 13px; align-items: flex-start; }
    .fgrade-timeline-badge { width: 28px; height: 28px; border-radius: 50%; background: rgba(37, 99, 235, 0.1); display: flex; align-items: center; justify-content: center; font-size: 12px; flex-shrink: 0; }
    .fgrade-timeline-title { line-height: 1.4; }
    .fgrade-timeline-time { font-size: 11px; color: var(--subtext-light); }
    body.dark-mode .fgrade-timeline-time { color: var(--subtext-dark); }

    .fgrade-toolbar { display: flex; justify-content: flex-end; gap: 10px; margin-bottom: 16px; }
    .fgrade-btn { background: var(--card-light); border: 1px solid var(--border-light); padding: 6px 14px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; color: inherit; }
    body.dark-mode .fgrade-btn { background: var(--card-dark); border-color: var(--border-dark); }

    @media (max-width: 768px) {
      .fgrade-dashboard-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body class="${theme.mode === 'dark' ? 'dark-mode' : ''}">
  <div class="fgrade-dashboard-root">
    <div class="fgrade-toolbar">
      <button class="fgrade-btn" onclick="document.body.classList.toggle('dark-mode')">🌓 Toggle Theme</button>
    </div>
    ${renderedDashboard}
  </div>
</body>
</html>`;
}

module.exports = {
  generateDashboardHtml,
};
