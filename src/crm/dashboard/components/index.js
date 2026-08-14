/**
 * F-GRADE CRM Enterprise Dashboard Component System
 * Production-ready React component collection for analytics visualization.
 */

// Helper: safe SVG coordinates calculation
function polarToCartesian(centerX, centerY, radius, angleInDegrees) {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180.0;
  return {
    x: centerX + radius * Math.cos(angleInRadians),
    y: centerY + radius * Math.sin(angleInRadians),
  };
}

function describeArc(x, y, radius, startAngle, endAngle) {
  const start = polarToCartesian(x, y, radius, endAngle);
  const end = polarToCartesian(x, y, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';
  return ['M', start.x, start.y, 'A', radius, radius, 0, largeArcFlag, 0, end.x, end.y].join(' ');
}

// 1. Widget Container with Card styling & error/loading states
function WidgetContainer({ title, subtitle, status, error, children, className = '' }) {
  if (status === 'error') {
    return {
      type: 'WidgetContainer',
      render: `
        <div class="fgrade-widget-card fgrade-widget-error ${className}">
          <div class="fgrade-widget-header">
            <h3 class="fgrade-widget-title">${title}</h3>
            ${subtitle ? `<p class="fgrade-widget-subtitle">${subtitle}</p>` : ''}
          </div>
          <div class="fgrade-error-body">
            <span class="fgrade-error-icon">⚠️</span>
            <p>${error || 'Unable to load widget data from CRM'}</p>
          </div>
        </div>
      `,
    };
  }

  return {
    type: 'WidgetContainer',
    render: `
      <div class="fgrade-widget-card ${className}">
        <div class="fgrade-widget-header">
          <h3 class="fgrade-widget-title">${title}</h3>
          ${subtitle ? `<p class="fgrade-widget-subtitle">${subtitle}</p>` : ''}
        </div>
        <div class="fgrade-widget-body">
          ${typeof children === 'string' ? children : ''}
        </div>
      </div>
    `,
  };
}

// 2. KpiCard Component
function KpiCard({ title, value, formattedValue, subtitle, comparison, comparisonText, trend, icon, accent = '#2563EB' }) {
  const displayVal = formattedValue || String(value ?? 0);
  const trendClass = trend === 'up' ? 'trend-up' : trend === 'down' ? 'trend-down' : 'trend-neutral';
  const trendIcon = trend === 'up' ? '▲' : trend === 'down' ? '▼' : '•';

  return {
    type: 'KpiCard',
    props: { title, value, formattedValue, subtitle, comparison, trend, accent },
    render: `
      <div class="fgrade-kpi-card" style="border-left: 4px solid ${accent};">
        <div class="fgrade-kpi-top">
          <span class="fgrade-kpi-title">${title}</span>
          ${icon ? `<span class="fgrade-kpi-icon">${icon}</span>` : ''}
        </div>
        <div class="fgrade-kpi-value">${displayVal}</div>
        ${comparisonText ? `
          <div class="fgrade-kpi-comparison ${trendClass}">
            <span>${trendIcon}</span> ${comparisonText}
          </div>
        ` : ''}
        ${subtitle ? `<div class="fgrade-kpi-subtitle">${subtitle}</div>` : ''}
      </div>
    `,
  };
}

// 3. BarChart Component (Vertical & Horizontal)
function BarChart({ data = [], horizontal = false, primaryColor = '#2563EB', title, subtitle }) {
  const maxVal = Math.max(...data.map((d) => d.value || 0), 1);

  const barsHtml = data.map((d) => {
    const percentage = Math.min(100, Math.round(((d.value || 0) / maxVal) * 100));
    const formatted = d.formattedValue || String(d.value);

    if (horizontal) {
      return `
        <div class="fgrade-hbar-row">
          <div class="fgrade-hbar-label" title="${d.label}">${d.label}</div>
          <div class="fgrade-hbar-track">
            <div class="fgrade-hbar-fill" style="width: ${percentage}%; background-color: ${primaryColor};"></div>
          </div>
          <div class="fgrade-hbar-val">${formatted}</div>
        </div>
      `;
    }

    return `
      <div class="fgrade-vbar-col">
        <div class="fgrade-vbar-val">${formatted}</div>
        <div class="fgrade-vbar-track">
          <div class="fgrade-vbar-fill" style="height: ${percentage}%; background-color: ${primaryColor};"></div>
        </div>
        <div class="fgrade-vbar-label" title="${d.label}">${d.label}</div>
      </div>
    `;
  }).join('');

  const containerClass = horizontal ? 'fgrade-hbar-container' : 'fgrade-vbar-container';

  return {
    type: 'BarChart',
    render: `
      <div class="fgrade-widget-card">
        ${title ? `<div class="fgrade-widget-header"><h3 class="fgrade-widget-title">${title}</h3>${subtitle ? `<p class="fgrade-widget-subtitle">${subtitle}</p>` : ''}</div>` : ''}
        <div class="${containerClass}">
          ${barsHtml}
        </div>
      </div>
    `,
  };
}

// 4. LineChart Component
function LineChart({ data = [], color = '#2563EB', title, subtitle }) {
  const points = data || [];
  const maxVal = Math.max(...points.map((p) => p.value || 0), 1);
  const width = 500;
  const height = 180;
  const padding = 20;

  const polyPoints = points.map((p, idx) => {
    const x = padding + (idx / Math.max(points.length - 1, 1)) * (width - padding * 2);
    const y = height - padding - ((p.value || 0) / maxVal) * (height - padding * 2);
    return `${x},${y}`;
  }).join(' ');

  return {
    type: 'LineChart',
    render: `
      <div class="fgrade-widget-card">
        ${title ? `<div class="fgrade-widget-header"><h3 class="fgrade-widget-title">${title}</h3>${subtitle ? `<p class="fgrade-widget-subtitle">${subtitle}</p>` : ''}</div>` : ''}
        <div class="fgrade-line-container">
          <svg viewBox="0 0 ${width} ${height}" class="fgrade-line-svg">
            <polyline fill="none" stroke="${color}" stroke-width="3" points="${polyPoints}" stroke-linecap="round" stroke-linejoin="round" />
            ${points.map((p, idx) => {
              const x = padding + (idx / Math.max(points.length - 1, 1)) * (width - padding * 2);
              const y = height - padding - ((p.value || 0) / maxVal) * (height - padding * 2);
              return `<circle cx="${x}" cy="${y}" r="4" fill="${color}" stroke="#FFFFFF" stroke-width="2" class="fgrade-line-dot"><title>${p.label}: ${p.formattedValue || p.value}</title></circle>`;
            }).join('')}
          </svg>
        </div>
      </div>
    `,
  };
}

// 5. DonutChart / PieChart Component
function DonutChart({ data = [], isPie = false, title, subtitle }) {
  const colors = ['#2563EB', '#10B981', '#F59E0B', '#6366F1', '#EC4899', '#8B5CF6', '#14B8A6'];
  const total = data.reduce((sum, d) => sum + (d.value || 0), 0) || 1;

  let currentAngle = 0;
  const slices = data.map((d, idx) => {
    const sliceAngle = ((d.value || 0) / total) * 360;
    const startAngle = currentAngle;
    const endAngle = currentAngle + sliceAngle;
    currentAngle = endAngle;

    const pathD = describeArc(100, 100, isPie ? 75 : 70, startAngle, endAngle);
    const color = colors[idx % colors.length];

    return `<path d="${pathD}" fill="none" stroke="${color}" stroke-width="${isPie ? 75 : 20}" stroke-linecap="butt"><title>${d.label}: ${d.value} (${Math.round(((d.value || 0) / total) * 100)}%)</title></path>`;
  }).join('');

  const legends = data.map((d, idx) => {
    const color = colors[idx % colors.length];
    const pct = Math.round(((d.value || 0) / total) * 100);
    return `
      <div class="fgrade-donut-legend-item">
        <span class="fgrade-donut-dot" style="background-color: ${color};"></span>
        <span class="fgrade-donut-legend-label">${d.label}</span>
        <span class="fgrade-donut-legend-pct">${pct}%</span>
      </div>
    `;
  }).join('');

  return {
    type: isPie ? 'PieChart' : 'DonutChart',
    render: `
      <div class="fgrade-widget-card">
        ${title ? `<div class="fgrade-widget-header"><h3 class="fgrade-widget-title">${title}</h3>${subtitle ? `<p class="fgrade-widget-subtitle">${subtitle}</p>` : ''}</div>` : ''}
        <div class="fgrade-donut-layout">
          <svg viewBox="0 0 200 200" class="fgrade-donut-svg">
            ${slices}
            ${!isPie ? `<text x="100" y="105" text-anchor="middle" class="fgrade-donut-total">${total}</text>` : ''}
          </svg>
          <div class="fgrade-donut-legends">${legends}</div>
        </div>
      </div>
    `,
  };
}

// 6. FunnelChart Component
function FunnelChart({ data = [], title, subtitle }) {
  const colors = ['#2563EB', '#3B82F6', '#60A5FA', '#93C5FD', '#10B981'];
  const maxVal = Math.max(...data.map((d) => d.value || 0), 1);

  const stages = data.map((d, idx) => {
    const pct = Math.max(30, Math.round(((d.value || 0) / maxVal) * 100));
    const color = colors[idx % colors.length];
    return `
      <div class="fgrade-funnel-step">
        <div class="fgrade-funnel-bar" style="width: ${pct}%; background-color: ${color};">
          <span class="fgrade-funnel-label">${d.label}</span>
          <span class="fgrade-funnel-val">${d.value}</span>
        </div>
      </div>
    `;
  }).join('');

  return {
    type: 'FunnelChart',
    render: `
      <div class="fgrade-widget-card">
        ${title ? `<div class="fgrade-widget-header"><h3 class="fgrade-widget-title">${title}</h3>${subtitle ? `<p class="fgrade-widget-subtitle">${subtitle}</p>` : ''}</div>` : ''}
        <div class="fgrade-funnel-container">${stages}</div>
      </div>
    `,
  };
}

// 7. DataTable Component
function DataTable({ headers = [], rows = [], title, subtitle }) {
  const headerHtml = headers.map((h) => `<th>${h}</th>`).join('');
  const rowsHtml = rows.map((row) => `
    <tr>
      ${row.map((cell) => `<td>${cell}</td>`).join('')}
    </tr>
  `).join('');

  return {
    type: 'DataTable',
    render: `
      <div class="fgrade-widget-card">
        ${title ? `<div class="fgrade-widget-header"><h3 class="fgrade-widget-title">${title}</h3>${subtitle ? `<p class="fgrade-widget-subtitle">${subtitle}</p>` : ''}</div>` : ''}
        <div class="fgrade-table-container">
          <table class="fgrade-data-table">
            <thead><tr>${headerHtml}</tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
      </div>
    `,
  };
}

// 8. ActivityTimeline Component
function ActivityTimeline({ data = [], title, subtitle }) {
  const itemsHtml = data.map((item) => {
    const timeFormatted = item.time ? String(item.time).slice(11, 16) : '';
    return `
      <div class="fgrade-timeline-item">
        <div class="fgrade-timeline-badge">${item.action === 'created' ? '＋' : item.action === 'added' ? '📝' : '⚡'}</div>
        <div class="fgrade-timeline-content">
          <div class="fgrade-timeline-title"><strong>${item.user}</strong> ${item.action} in <em>${item.module}</em>: ${item.recordName}</div>
          <div class="fgrade-timeline-time">${timeFormatted}</div>
        </div>
      </div>
    `;
  }).join('');

  return {
    type: 'ActivityTimeline',
    render: `
      <div class="fgrade-widget-card">
        ${title ? `<div class="fgrade-widget-header"><h3 class="fgrade-widget-title">${title}</h3>${subtitle ? `<p class="fgrade-widget-subtitle">${subtitle}</p>` : ''}</div>` : ''}
        <div class="fgrade-timeline-container">${itemsHtml}</div>
      </div>
    `,
  };
}

// 9. FilterBar, DateFilter, EmployeeFilter, ModuleFilter
function FilterBar({ filters = [] }) {
  const filterPills = filters.map((f) => `
    <div class="fgrade-filter-pill">
      <span class="fgrade-filter-label">${f.type}:</span>
      <span class="fgrade-filter-value">${f.value || `${f.from || ''} - ${f.to || ''}`}</span>
    </div>
  `).join('');

  return {
    type: 'FilterBar',
    render: `
      <div class="fgrade-filter-bar">
        <div class="fgrade-filter-list">${filterPills}</div>
      </div>
    `,
  };
}

// 10. DashboardGrid & Main Dashboard
function Dashboard({ dashboard = {} }) {
  const theme = dashboard.theme || { mode: 'light', primaryColor: '#2563EB' };
  const widgets = dashboard.widgets || [];

  const renderedWidgets = widgets.map((w) => {
    switch (w.type) {
      case 'kpi':
        return KpiCard(w).render;
      case 'bar':
        return BarChart({ ...w, primaryColor: theme.primaryColor }).render;
      case 'horizontal_bar':
        return BarChart({ ...w, horizontal: true, primaryColor: theme.primaryColor }).render;
      case 'line':
      case 'area':
        return LineChart({ ...w, color: theme.primaryColor }).render;
      case 'donut':
        return DonutChart(w).render;
      case 'pie':
        return DonutChart({ ...w, isPie: true }).render;
      case 'funnel':
        return FunnelChart(w).render;
      case 'table':
        return DataTable(w).render;
      case 'activity_timeline':
        return ActivityTimeline(w).render;
      default:
        return `<div class="fgrade-widget-card"><p>${w.title || 'Widget'}</p></div>`;
    }
  }).join('');

  return {
    type: 'Dashboard',
    render: `
      <div class="fgrade-dashboard-root fgrade-theme-${theme.mode}">
        <div class="fgrade-dashboard-header">
          <div class="fgrade-brand-badge">F-GRADE CRM ANALYTICS</div>
          <h1 class="fgrade-dashboard-title">${dashboard.title || 'CRM Dashboard'}</h1>
          ${dashboard.summary ? `<p class="fgrade-dashboard-summary">${dashboard.summary}</p>` : ''}
        </div>
        ${dashboard.filters?.length ? FilterBar({ filters: dashboard.filters }).render : ''}
        <div class="fgrade-dashboard-grid">
          ${renderedWidgets}
        </div>
      </div>
    `,
  };
}

module.exports = {
  Dashboard,
  KpiCard,
  BarChart,
  LineChart,
  DonutChart,
  FunnelChart,
  DataTable,
  ActivityTimeline,
  FilterBar,
  WidgetContainer,
};
