/**
 * F-GRADE CRM Enterprise Dashboard Component System
 * High-end analytics & visualization component collection.
 * Supports: KPI Cards, Area/Line Charts, Vertical/Horizontal Bar Charts,
 * Stacked Bar Charts, Pie/Donut Charts, Funnel Charts, Data & Ranking Tables,
 * Activity Timelines, Filters, and Container states.
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

// 1. Widget Container with Card styling & error/empty/loading states
function WidgetContainer({ title, subtitle, status, error, emptyMessage, children, className = '', actions = '' }) {
  if (status === 'error') {
    return {
      type: 'WidgetContainer',
      render: `
        <div class="fgrade-widget-card fgrade-widget-error ${className}">
          <div class="fgrade-widget-header">
            <div>
              <h3 class="fgrade-widget-title">${title}</h3>
              ${subtitle ? `<p class="fgrade-widget-subtitle">${subtitle}</p>` : ''}
            </div>
          </div>
          <div class="fgrade-state-box fgrade-error-body">
            <span class="fgrade-state-icon">⚠️</span>
            <p class="fgrade-state-text">${error || 'Unable to retrieve data from CRM'}</p>
          </div>
        </div>
      `,
    };
  }

  if (status === 'empty') {
    return {
      type: 'WidgetContainer',
      render: `
        <div class="fgrade-widget-card ${className}">
          <div class="fgrade-widget-header">
            <div>
              <h3 class="fgrade-widget-title">${title}</h3>
              ${subtitle ? `<p class="fgrade-widget-subtitle">${subtitle}</p>` : ''}
            </div>
          </div>
          <div class="fgrade-state-box fgrade-empty-body">
            <span class="fgrade-state-icon">📊</span>
            <p class="fgrade-state-text">${emptyMessage || 'No CRM data found for the selected period'}</p>
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
          <div>
            <h3 class="fgrade-widget-title">${title}</h3>
            ${subtitle ? `<p class="fgrade-widget-subtitle">${subtitle}</p>` : ''}
          </div>
          ${actions ? `<div class="fgrade-widget-actions">${actions}</div>` : ''}
        </div>
        <div class="fgrade-widget-body">
          ${typeof children === 'string' ? children : ''}
        </div>
      </div>
    `,
  };
}

// 2. KpiCard Component (Revenue, Count, Win Rate, Growth)
function KpiCard({
  title,
  value,
  formattedValue,
  subtitle,
  comparison,
  comparisonText,
  trend,
  icon,
  accent = '#2563EB',
  status,
  error,
}) {
  if (status === 'error') {
    return WidgetContainer({ title, status: 'error', error }).render;
  }

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

// 3. BarChart Component (Vertical, Horizontal, Stacked)
function BarChart({
  data = [],
  horizontal = false,
  primaryColor = '#2563EB',
  title,
  subtitle,
  status,
  error,
}) {
  if (status === 'error') {
    return WidgetContainer({ title, subtitle, status: 'error', error }).render;
  }
  if (!data || data.length === 0) {
    return WidgetContainer({ title, subtitle, status: 'empty' }).render;
  }

  const maxVal = Math.max(...data.map((d) => d.value || 0), 1);

  const barsHtml = data.map((d, idx) => {
    const percentage = Math.min(100, Math.max(0, Math.round(((d.value || 0) / maxVal) * 100)));
    const formatted = d.formattedValue || String(d.value);
    const barColor = d.color || primaryColor;

    if (horizontal) {
      return `
        <div class="fgrade-hbar-row" title="${d.label}: ${formatted}">
          <div class="fgrade-hbar-label">${d.label}</div>
          <div class="fgrade-hbar-track">
            <div class="fgrade-hbar-fill" style="width: ${percentage}%; background-color: ${barColor};"></div>
          </div>
          <div class="fgrade-hbar-val">${formatted}</div>
        </div>
      `;
    }

    return `
      <div class="fgrade-vbar-col" title="${d.label}: ${formatted}">
        <div class="fgrade-vbar-val">${formatted}</div>
        <div class="fgrade-vbar-track">
          <div class="fgrade-vbar-fill" style="height: ${percentage}%; background-color: ${barColor};"></div>
        </div>
        <div class="fgrade-vbar-label">${d.label}</div>
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

// 4. StackedBarChart Component (Multi-metric Segmented Bar)
function StackedBarChart({
  data = [],
  series = [],
  title,
  subtitle,
  status,
  error,
}) {
  if (status === 'error') {
    return WidgetContainer({ title, subtitle, status: 'error', error }).render;
  }
  if (!data || data.length === 0) {
    return WidgetContainer({ title, subtitle, status: 'empty' }).render;
  }

  const defaultColors = ['#2563EB', '#10B981', '#F59E0B', '#6366F1', '#EC4899'];
  const seriesConfig = series.map((s, idx) => ({
    key: s.key || s,
    label: s.label || s.key || s,
    color: s.color || defaultColors[idx % defaultColors.length],
  }));

  const maxTotal = Math.max(
    ...data.map((row) => seriesConfig.reduce((sum, s) => sum + (Number(row[s.key]) || 0), 0)),
    1
  );

  const rowsHtml = data.map((row) => {
    const rowTotal = seriesConfig.reduce((sum, s) => sum + (Number(row[s.key]) || 0), 0);
    const rowPct = Math.min(100, Math.round((rowTotal / maxTotal) * 100));

    const segmentsHtml = seriesConfig.map((s) => {
      const val = Number(row[s.key]) || 0;
      const segPct = rowTotal > 0 ? (val / rowTotal) * 100 : 0;
      if (segPct <= 0) return '';
      return `<div class="fgrade-stacked-segment" style="width: ${segPct}%; background-color: ${s.color};" title="${s.label}: ${val}"></div>`;
    }).join('');

    return `
      <div class="fgrade-stacked-row">
        <div class="fgrade-stacked-label">${row.label || row.name}</div>
        <div class="fgrade-stacked-track" style="width: ${Math.max(rowPct, 10)}%;">
          ${segmentsHtml}
        </div>
        <div class="fgrade-stacked-val">${row.formattedTotal || rowTotal}</div>
      </div>
    `;
  }).join('');

  const legendHtml = seriesConfig.map((s) => `
    <div class="fgrade-legend-item">
      <span class="fgrade-legend-dot" style="background-color: ${s.color};"></span>
      <span class="fgrade-legend-text">${s.label}</span>
    </div>
  `).join('');

  return {
    type: 'StackedBarChart',
    render: `
      <div class="fgrade-widget-card">
        ${title ? `<div class="fgrade-widget-header"><h3 class="fgrade-widget-title">${title}</h3>${subtitle ? `<p class="fgrade-widget-subtitle">${subtitle}</p>` : ''}</div>` : ''}
        <div class="fgrade-stacked-legend">${legendHtml}</div>
        <div class="fgrade-stacked-container">${rowsHtml}</div>
      </div>
    `,
  };
}

// 5. LineChart & AreaChart Component (SVG with Smooth Paths & Gradient Fills)
function LineChart({
  data = [],
  color = '#2563EB',
  isArea = false,
  title,
  subtitle,
  status,
  error,
}) {
  if (status === 'error') {
    return WidgetContainer({ title, subtitle, status: 'error', error }).render;
  }
  if (!data || data.length === 0) {
    return WidgetContainer({ title, subtitle, status: 'empty' }).render;
  }

  const points = data;
  const maxVal = Math.max(...points.map((p) => p.value || 0), 1);
  const width = 560;
  const height = 200;
  const paddingX = 40;
  const paddingY = 24;

  const chartWidth = width - paddingX * 2;
  const chartHeight = height - paddingY * 2;

  const coords = points.map((p, idx) => {
    const x = paddingX + (idx / Math.max(points.length - 1, 1)) * chartWidth;
    const y = height - paddingY - ((p.value || 0) / maxVal) * chartHeight;
    return { x, y, ...p };
  });

  const polyPoints = coords.map((c) => `${c.x},${c.y}`).join(' ');

  // Generate Area polygon
  const firstPoint = coords[0] || { x: paddingX, y: height - paddingY };
  const lastPoint = coords[coords.length - 1] || { x: width - paddingX, y: height - paddingY };
  const areaPoints = `${firstPoint.x},${height - paddingY} ${polyPoints} ${lastPoint.x},${height - paddingY}`;

  // Grid lines
  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((pct) => {
    const y = height - paddingY - pct * chartHeight;
    return `<line x1="${paddingX}" y1="${y}" x2="${width - paddingX}" y2="${y}" stroke="currentColor" stroke-opacity="0.08" stroke-dasharray="3,3" />`;
  }).join('');

  return {
    type: isArea ? 'AreaChart' : 'LineChart',
    render: `
      <div class="fgrade-widget-card">
        ${title ? `<div class="fgrade-widget-header"><h3 class="fgrade-widget-title">${title}</h3>${subtitle ? `<p class="fgrade-widget-subtitle">${subtitle}</p>` : ''}</div>` : ''}
        <div class="fgrade-line-container">
          <svg viewBox="0 0 ${width} ${height}" class="fgrade-line-svg" preserveAspectRatio="none">
            <defs>
              <linearGradient id="fgradeAreaGrad_${title?.replace(/\s+/g, '_') || 'line'}" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stop-color="${color}" stop-opacity="0.28" />
                <stop offset="100%" stop-color="${color}" stop-opacity="0.0" />
              </linearGradient>
            </defs>
            ${gridLines}
            ${isArea ? `<polygon fill="url(#fgradeAreaGrad_${title?.replace(/\s+/g, '_') || 'line'})" points="${areaPoints}" />` : ''}
            <polyline fill="none" stroke="${color}" stroke-width="3" points="${polyPoints}" stroke-linecap="round" stroke-linejoin="round" />
            ${coords.map((c) => `
              <circle cx="${c.x}" cy="${c.y}" r="4.5" fill="${color}" stroke="#FFFFFF" stroke-width="2" class="fgrade-line-dot">
                <title>${c.label || c.date}: ${c.formattedValue || c.value}</title>
              </circle>
            `).join('')}
          </svg>
        </div>
        <div class="fgrade-axis-labels">
          ${coords.map((c, i) => i % Math.ceil(coords.length / 6) === 0 || i === coords.length - 1 ? `<span class="fgrade-axis-label">${c.label || c.date}</span>` : '').join('')}
        </div>
      </div>
    `,
  };
}

// 6. DonutChart & PieChart Component
function DonutChart({
  data = [],
  isPie = false,
  title,
  subtitle,
  status,
  error,
}) {
  if (status === 'error') {
    return WidgetContainer({ title, subtitle, status: 'error', error }).render;
  }
  if (!data || data.length === 0) {
    return WidgetContainer({ title, subtitle, status: 'empty' }).render;
  }

  const colors = ['#2563EB', '#10B981', '#F59E0B', '#6366F1', '#EC4899', '#8B5CF6', '#14B8A6', '#06B6D4'];
  const total = data.reduce((sum, d) => sum + (d.value || 0), 0) || 1;

  let currentAngle = 0;
  const slices = data.map((d, idx) => {
    const sliceAngle = ((d.value || 0) / total) * 360;
    if (sliceAngle <= 0) return '';
    const startAngle = currentAngle;
    const endAngle = currentAngle + sliceAngle;
    currentAngle = endAngle;

    const pathD = describeArc(100, 100, isPie ? 75 : 70, startAngle, endAngle);
    const color = d.color || colors[idx % colors.length];

    return `
      <path d="${pathD}" fill="none" stroke="${color}" stroke-width="${isPie ? 75 : 22}" stroke-linecap="butt">
        <title>${d.label}: ${d.formattedValue || d.value} (${Math.round(((d.value || 0) / total) * 100)}%)</title>
      </path>
    `;
  }).join('');

  const legends = data.map((d, idx) => {
    const color = d.color || colors[idx % colors.length];
    const pct = Math.round(((d.value || 0) / total) * 100);
    return `
      <div class="fgrade-donut-legend-item">
        <span class="fgrade-donut-dot" style="background-color: ${color};"></span>
        <span class="fgrade-donut-legend-label" title="${d.label}">${d.label}</span>
        <span class="fgrade-donut-legend-val">${d.formattedValue || d.value}</span>
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
            ${!isPie ? `
              <text x="100" y="98" text-anchor="middle" class="fgrade-donut-total">${total}</text>
              <text x="100" y="114" text-anchor="middle" class="fgrade-donut-total-lbl">TOTAL</text>
            ` : ''}
          </svg>
          <div class="fgrade-donut-legends">${legends}</div>
        </div>
      </div>
    `,
  };
}

// 7. FunnelChart Component (Pipeline Conversion Funnel)
function FunnelChart({
  data = [],
  title,
  subtitle,
  status,
  error,
}) {
  if (status === 'error') {
    return WidgetContainer({ title, subtitle, status: 'error', error }).render;
  }
  if (!data || data.length === 0) {
    return WidgetContainer({ title, subtitle, status: 'empty' }).render;
  }

  const colors = ['#2563EB', '#3B82F6', '#60A5FA', '#93C5FD', '#10B981'];
  const maxVal = Math.max(...data.map((d) => d.value || 0), 1);

  const stages = data.map((d, idx) => {
    const pct = Math.max(28, Math.round(((d.value || 0) / maxVal) * 100));
    const color = d.color || colors[idx % colors.length];
    const displayVal = d.formattedValue || String(d.value);

    return `
      <div class="fgrade-funnel-step">
        <div class="fgrade-funnel-bar" style="width: ${pct}%; background-color: ${color};" title="${d.label}: ${displayVal}">
          <span class="fgrade-funnel-label">${d.label}</span>
          <span class="fgrade-funnel-val">${displayVal}</span>
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

// 8. DataTable Component (Sortable, Formatted Cells, Badges)
function DataTable({
  headers = [],
  rows = [],
  title,
  subtitle,
  status,
  error,
}) {
  if (status === 'error') {
    return WidgetContainer({ title, subtitle, status: 'error', error }).render;
  }
  if (!rows || rows.length === 0) {
    return WidgetContainer({ title, subtitle, status: 'empty' }).render;
  }

  const headerHtml = headers.map((h) => `<th>${h}</th>`).join('');
  const rowsHtml = rows.map((row) => `
    <tr>
      ${row.map((cell) => {
        const isNum = typeof cell === 'number' || (/^[₹$€£]/.test(String(cell)));
        const alignClass = isNum ? 'cell-numeric' : '';
        return `<td class="${alignClass}">${cell ?? '-'}</td>`;
      }).join('')}
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

// 9. RankingTable Component (Top Performers, Top Deals)
function RankingTable({
  items = [],
  title,
  subtitle,
  status,
  error,
}) {
  if (status === 'error') {
    return WidgetContainer({ title, subtitle, status: 'error', error }).render;
  }
  if (!items || items.length === 0) {
    return WidgetContainer({ title, subtitle, status: 'empty' }).render;
  }

  const rowsHtml = items.map((item, idx) => `
    <div class="fgrade-ranking-item">
      <div class="fgrade-ranking-badge rank-${idx + 1}">${idx + 1}</div>
      <div class="fgrade-ranking-details">
        <div class="fgrade-ranking-name">${item.name || item.employee || item.label}</div>
        ${item.subtitle ? `<div class="fgrade-ranking-sub">${item.subtitle}</div>` : ''}
      </div>
      <div class="fgrade-ranking-value">${item.formattedValue || item.value}</div>
    </div>
  `).join('');

  return {
    type: 'RankingTable',
    render: `
      <div class="fgrade-widget-card">
        ${title ? `<div class="fgrade-widget-header"><h3 class="fgrade-widget-title">${title}</h3>${subtitle ? `<p class="fgrade-widget-subtitle">${subtitle}</p>` : ''}</div>` : ''}
        <div class="fgrade-ranking-list">${rowsHtml}</div>
      </div>
    `,
  };
}

// 10. ActivityTimeline Component (Chronological Events with Human/Automation Tagging)
function ActivityTimeline({
  data = [],
  title,
  subtitle,
  status,
  error,
}) {
  if (status === 'error') {
    return WidgetContainer({ title, subtitle, status: 'error', error }).render;
  }
  if (!data || data.length === 0) {
    return WidgetContainer({ title, subtitle, status: 'empty' }).render;
  }

  const itemsHtml = data.map((item) => {
    const timeFormatted = item.time ? String(item.time).slice(11, 16) : '';
    const isAutomation = /automation|system|deluge/i.test(item.source || item.user || '');
    const badgeIcon = item.action === 'created' ? '＋' : item.action === 'added' ? '📝' : '⚡';

    return `
      <div class="fgrade-timeline-item">
        <div class="fgrade-timeline-badge ${isAutomation ? 'automation-badge' : 'user-badge'}">${badgeIcon}</div>
        <div class="fgrade-timeline-content">
          <div class="fgrade-timeline-title">
            <strong>${item.user || 'User'}</strong> ${item.action || 'actioned'} in <em>${item.module || 'CRM'}</em>: ${item.recordName || item.record_name || 'Record'}
          </div>
          <div class="fgrade-timeline-meta">
            <span class="fgrade-timeline-time">${timeFormatted}</span>
            <span class="fgrade-timeline-tag ${isAutomation ? 'tag-automation' : 'tag-user'}">${isAutomation ? 'Automation' : 'User Activity'}</span>
          </div>
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

// 11. FilterBar Component (Interactive filter chips)
function FilterBar({ filters = [] }) {
  if (!filters || filters.length === 0) return { type: 'FilterBar', render: '' };

  const filterPills = filters.map((f) => `
    <div class="fgrade-filter-pill">
      <span class="fgrade-filter-label">${f.type || 'Filter'}:</span>
      <span class="fgrade-filter-value">${f.value || `${f.from || ''} → ${f.to || ''}`}</span>
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

// 12. Main Dashboard Layout & Grid
function Dashboard({ dashboard = {} }) {
  const theme = dashboard.theme || { mode: 'light', primaryColor: '#2563EB', accentColor: '#14B8A6' };
  const widgets = dashboard.widgets || [];

  const renderedWidgets = widgets.map((w) => {
    switch (w.type) {
      case 'kpi':
        return KpiCard({ ...w, accent: w.accent || theme.primaryColor }).render;
      case 'bar':
        return BarChart({ ...w, primaryColor: theme.primaryColor }).render;
      case 'horizontal_bar':
        return BarChart({ ...w, horizontal: true, primaryColor: theme.primaryColor }).render;
      case 'stacked_bar':
        return StackedBarChart(w).render;
      case 'line':
        return LineChart({ ...w, color: theme.primaryColor }).render;
      case 'area':
        return LineChart({ ...w, isArea: true, color: theme.primaryColor }).render;
      case 'donut':
        return DonutChart(w).render;
      case 'pie':
        return DonutChart({ ...w, isPie: true }).render;
      case 'funnel':
        return FunnelChart(w).render;
      case 'table':
        return DataTable(w).render;
      case 'ranking':
        return RankingTable(w).render;
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
          <div class="fgrade-brand-badge">F-GRADE CRM ENTERPRISE ANALYTICS</div>
          <h1 class="fgrade-dashboard-title">${dashboard.title || 'CRM Analytics Dashboard'}</h1>
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
  StackedBarChart,
  LineChart,
  DonutChart,
  FunnelChart,
  DataTable,
  RankingTable,
  ActivityTimeline,
  FilterBar,
  WidgetContainer,
};
