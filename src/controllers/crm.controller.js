const { CrmService } = require('../services/crm.service');

const MAX_QUESTION_LENGTH = 2000;

function createCrmController(crmService = new CrmService()) {
  const conversationContext = new Map();
  return {
    query: async (req, res, next) => {
      try {
        const result = await crmService.query(req.body);
        res.status(200).json({ success: true, status: 'ok', ...result });
      } catch (error) {
        next(error);
      }
    },
    assistant: async (req, res, next) => {
      try {
        const question = req.body?.question || req.body?.prompt || req.body?.message;
        if (typeof question !== 'string' || question.trim().length === 0) {
          const error = new Error('One of question, prompt, or message is required.');
          error.code = 'QUESTION_REQUIRED';
          error.statusCode = 400;
          throw error;
        }
        if (question.length > MAX_QUESTION_LENGTH) {
          const error = new Error(`Question must not exceed ${MAX_QUESTION_LENGTH} characters.`);
          error.code = 'QUESTION_TOO_LONG';
          error.statusCode = 400;
          throw error;
        }
        const conversationId = typeof req.body?.conversation_id === 'string' && req.body.conversation_id.trim()
          ? req.body.conversation_id.trim()
          : null;
        const previous = conversationId ? conversationContext.get(conversationId) : null;
        const resolvedQuestion = resolveFollowUpQuestion(question, previous);
        const plannedRequest = planQuestion(resolvedQuestion);
        const result = await crmService.query({
          ...(req.body?.query || {}),
          ...plannedRequest
        });
        if (conversationId) {
          conversationContext.set(conversationId, { question: resolvedQuestion, plannedRequest });
          if (conversationContext.size > 1000) conversationContext.delete(conversationContext.keys().next().value);
        }
        const answer = isDashboardRequest(resolvedQuestion)
          ? JSON.stringify(buildDashboardSpecification(resolvedQuestion, result), null, 2)
          : buildAssistantAnswer(resolvedQuestion, result);
        res.status(200).json({ success: true, status: 'ok', question, answer, ...result });
      } catch (error) {
        next(error);
      }
    }
  };
}

function resolveFollowUpQuestion(question, previous) {
  const text = String(question || '').trim();
  if (!previous || hasExplicitModuleIntent(text) || isClarification(text)) return text;
  if (!isFollowUpQuestion(text)) return text;
  if (/(this year|current year|last year|previous year|this month|current month|last month|previous month|today|yesterday|\b20\d{2}\b|january|february|march|april|may|june|july|august|september|october|november|december)/i.test(text)) {
    return `${previous.question} created ${text}`;
  }
  return previous.question;
}

function hasExplicitModuleIntent(text) {
  return /\b(?:lead|leads|deal|deals|account|accounts|contact|contacts)\b/i.test(text);
}

function isClarification(text) {
  return /^(?:i\s+mean|i\s+meant|actually|no,?\s+i\s+mean|not\s+leads?,?\s+deals?|give me\s+deals?\s+instead)\b/i.test(text);
}

function isFollowUpQuestion(text) {
  return /^(?:give me|show me|what about|how about|only|just|and|also|now|for)\b/i.test(text)
    && !/(lead|deal|account|contact|crm|amount|revenue|pipeline|owner|source)/i.test(text);
}

function isDashboardRequest(question) {
  return /(dashboard|visuali[sz]e|kpi|charts?|management report|analytics dashboard|performance dashboard)/i.test(question);
}

function isTodayActivityQuestion(lowerText) {
  return /(today'?s activity|today activity|activity for today|what happened today|today's meetings|today meetings|today's logs|today logs|audit logs?|audit trail|daily activity|daily logs?)/.test(lowerText)
    || (/\b(?:today|toda)\b/.test(lowerText) && /(activity|activities|meeting|meetings|event|events|call|calls|task|tasks|log|logs|audit)/.test(lowerText));
}

function buildDashboardSpecification(question, result) {
  const module = result?.module || 'CRM';

  if (result?.analysis === 'sales_performance') {
    const totals = result.totals || {};
    const year = result.year || new Date().getFullYear();
    return `${year} sales performance: ${totals.leads || 0} leads, ${totals.converted_leads || 0} converted leads, ${totals.accounts || 0} accounts, ${totals.contacts || 0} contacts, and ${totals.deals || 0} deals. Lead conversion rate: ${formatPercent(result.lead_conversion_rate)}. Deal Closed Won rate: ${formatPercent(result.comparison?.deal_closed_won_rate)}.`;
  }
  const sourceBreakdown = Array.isArray(result?.source_breakdown) ? result.source_breakdown : [];
  const rows = Array.isArray(result?.data) ? result.data : [];
  const isLeadSourceReport = result?.analysis === 'lead_source_report';
  const isGroupedResult = result?.request_type === 'aggregate' && rows.length > 0;
  const filters = extractDashboardFilters(result);
  const dashboard = {
    dashboard: {
      title: isLeadSourceReport ? 'Lead Source Performance Dashboard' : `${module} Performance Dashboard`,
      description: String(question).trim(),
      type: isLeadSourceReport ? 'lead_source' : isGroupedResult ? 'performance' : 'crm_records',
      kpis: buildDashboardKpis(result, sourceBreakdown, rows),
      charts: buildDashboardCharts(result, sourceBreakdown, rows),
      tables: buildDashboardTables(result, sourceBreakdown, rows),
      filters,
      insights: buildDashboardInsights(result, sourceBreakdown, rows),
      layout: buildDashboardLayout(result, sourceBreakdown, rows)
    }
  };
  return dashboard;
}

function buildDashboardKpis(result, sourceBreakdown, rows) {
  const kpis = [];
  if (Number.isFinite(Number(result?.total))) kpis.push({ title: 'Total Records', value: String(result.total), unit: 'records', comparison: '', trend: '', description: 'Verified records in the requested population.' });
  if (Number.isFinite(Number(result?.count)) && !Number.isFinite(Number(result?.total))) kpis.push({ title: 'Total Records', value: String(result.count), unit: 'records', comparison: '', trend: '', description: 'Verified CRM result count.' });
  if (sourceBreakdown.length > 0) kpis.push({ title: 'Top Source', value: String(result.top_source || sourceBreakdown[0].source), unit: 'lead source', comparison: '', trend: '', description: 'Highest-volume source in the selected population.' });
  if (rows.length > 0 && rows.every((row) => Number.isFinite(Number(row.value)))) {
    kpis.push({ title: 'Total Value', value: formatAmount(rows.reduce((total, row) => total + Number(row.value || 0), 0)), unit: 'currency', comparison: '', trend: '', description: 'Sum of the supplied grouped CRM values.' });
  }
  return kpis;
}

function buildDashboardCharts(result, sourceBreakdown, rows) {
  if (sourceBreakdown.length > 0) return [{
    title: 'Leads by Source', type: 'horizontal_bar', purpose: 'Compare lead volume and contribution by source.', x_axis: 'Lead Source', y_axis: 'Lead Count',
    series: [{ name: 'Leads', field: 'count' }, { name: 'Percentage', field: 'percentage' }], data: sourceBreakdown, sort: 'count descending', interaction: 'Select a source to inspect its top leads.'
  }];
  if (rows.length > 0) return [{
    title: 'Performance by Group', type: 'horizontal_bar', purpose: 'Compare verified grouped CRM values.', x_axis: 'Group', y_axis: 'Value', series: [{ name: 'Value', field: 'value' }], data: rows, sort: 'value descending', interaction: 'Sort by value.'
  }];
  return [];
}

function buildDashboardTables(result, sourceBreakdown, rows) {
  const tables = [];
  if (sourceBreakdown.length > 0) tables.push({ title: 'Source Breakdown', columns: ['source', 'count', 'percentage'], rows: sourceBreakdown, sort: 'count descending', page_size: 10, searchable: true });
  if (Array.isArray(result?.top_leads) && result.top_leads.length > 0) tables.push({ title: `Top Leads from ${result.top_source || 'highest-volume source'}`, columns: ['name', 'company', 'email', 'lead_status', 'lead_source', 'created_time'], rows: result.top_leads, sort: 'created_time descending', page_size: 5, searchable: true });
  if (sourceBreakdown.length === 0 && rows.length === 0 && Array.isArray(result?.data) && result.data.length === 0) tables.push({ title: 'CRM Records', columns: [], rows: [], sort: '', page_size: 10, searchable: true, empty_state: 'No data available for the selected request.' });
  return tables;
}

function buildDashboardInsights(result, sourceBreakdown, rows) {
  if (sourceBreakdown.length > 0) return [`${sourceBreakdown[0].source} is the highest-volume source with ${sourceBreakdown[0].count} leads (${sourceBreakdown[0].percentage}%).`];
  if (rows.length > 0) return ['The dashboard is based on the verified grouped CRM values returned for this request.'];
  return [];
}

function buildDashboardLayout(result, sourceBreakdown, rows) {
  const layout = [];
  if (buildDashboardKpis(result, sourceBreakdown, rows).length > 0) layout.push({ type: 'kpi_row', components: ['kpis'] });
  if (buildDashboardCharts(result, sourceBreakdown, rows).length > 0) layout.push({ type: 'chart_row', components: ['charts'] });
  if (buildDashboardTables(result, sourceBreakdown, rows).length > 0) layout.push({ type: 'table_row', components: ['tables'] });
  if (buildDashboardInsights(result, sourceBreakdown, rows).length > 0) layout.push({ type: 'insight_row', components: ['insights'] });
  return layout;
}

function extractDashboardFilters(result) {
  const filters = [];
  if (result?.top_source) filters.push({ field: 'Lead Source', value: result.top_source });
  return filters;
}

function planQuestion(question) {
  const text = String(question || '').trim();
  if (!text) {
    const error = new Error('One of question, prompt, or message is required.');
    error.code = 'QUESTION_REQUIRED';
    error.statusCode = 400;
    throw error;
  }

  const lower = text.toLowerCase();
  if (isTodayActivityQuestion(lower)) {
    return {
      module: 'CRM',
      complexity: 'MULTI-STEP',
      request_type: 'analysis',
      analysis: { type: 'today_activity' },
      fields: ['id'],
      filters: [],
      limit: 200,
      offset: 0
    };
  }
  const module = detectModule(lower);
  const requestedLimit = extractRecordLimit(lower);
  const recordSort = detectRecordSort(lower, module);
  const filters = [];
  const dateFilter = detectDateFilter(lower, module);
  if (dateFilter) filters.push(dateFilter);

  if (isComprehensiveSalesPerformanceRequest(lower)) {
    return {
      module: 'Deals',
      complexity: 'MULTI-STEP',
      request_type: 'analysis',
      analysis: { type: 'sales_performance' },
      fields: ['id'],
      filters: [{ field: 'Created_Time', operator: 'between', value: [`${extractRequestedYear(lower)}-01-01`, `${extractRequestedYear(lower) + 1}-01-01`], exclusive_end: true }],
      limit: 20,
      offset: 0
    };
  }

  if (module === 'Leads' && /lead source/.test(lower) && /(conversion rate|converted)/.test(lower)) {
    return {
      module: 'Leads',
      complexity: 'MULTI-STEP',
      request_type: 'analysis',
      analysis: { type: 'lead_source_conversion_report' },
      fields: ['id', 'Lead_Source', 'Converted__s'],
      filters: [...filters, { field: 'Lead_Source', operator: 'is_not_null' }],
      limit: 20,
      offset: 0
    };
  }

  if (isConversionFunnelQuestion(lower)) {
    return {
      module: 'Leads',
      complexity: 'MULTI-STEP',
      request_type: 'analysis',
      analysis: { type: 'conversion_funnel' },
      fields: ['id'],
      filters,
      limit: 20,
      offset: 0
    };
  }

  if (isLeadConversionQuestion(lower)) {
    return {
      module: 'Leads',
      complexity: 'MULTI-STEP',
      request_type: 'analysis',
      analysis: { type: isLeadToClosedWonQuestion(lower) ? 'lead_closed_won_conversion' : 'lead_conversion' },
      fields: ['id'],
      filters,
      limit: 20,
      offset: 0
    };
  }

  if (module === 'Leads' && isHighestLeadCreationDayQuestion(lower)) {
    return {
      module: 'Leads',
      complexity: 'MODERATE',
      request_type: 'analysis',
      analysis: { type: 'highest_creation_day' },
      fields: ['id', 'Created_Time'],
      filters,
      limit: 200,
      offset: 0
    };
  }

  const ownerName = extractOwnerName(text);
  if (ownerName) filters.push({ field: 'Owner', operator: 'equals', value: ownerName });

  const amountThreshold = extractAmountThreshold(lower);
  if (amountThreshold) filters.push({ field: 'Amount', operator: 'greater_than', value: amountThreshold.value });

  if (/(closed won|closed-won|won deals|won deal)/.test(lower)) {
    filters.push({ field: 'Stage', operator: 'equals', value: 'Closed Won' });
  }

  if (module === 'Leads' && /(closed won|closed-won)/.test(lower) && !/(lead status|lead_status)/.test(lower)) {
    return planQuestion(text.replace(/\bleads?\b/gi, 'deals'));
  }

  if (/(closed lost|closed-lost|lost deals|lost deal)/.test(lower)) {
    filters.push({ field: 'Stage', operator: 'equals', value: 'Closed Lost' });
  }

  if (/(not converted|unconverted|have not been converted)/.test(lower)) {
    filters.push({ field: 'Converted__s', operator: 'equals', value: false });
  }

  if (/(linkedin|linkedin)/.test(lower) && module === 'Leads') {
    filters.push({ field: 'Lead_Source', operator: 'equals', value: 'LinkedIn' });
  }

  if (module === 'Deals' && /\b(?:count|how many)\b/.test(lower) && /\b(?:list|show|give me)\b/.test(lower)) {
    return {
      module: 'Deals',
      complexity: 'MULTI-STEP',
      request_type: 'analysis',
      analysis: { type: 'count_and_records' },
      fields: defaultFields('Deals'),
      filters,
      retrieve_all: /\b(?:all|every|complete|entire)\b/.test(lower),
      limit: extractRecordLimit(lower),
      offset: 0
    };
  }

  if (module === 'Deals' && /(top|highest|best|rank).*(owner|owners|person|persons).*(total deal value|total deal amount|deal value|revenue|amount)/.test(lower)) {
    return {
      module,
      complexity: 'MULTI-STEP',
      request_type: 'analysis',
      analysis: { type: 'owner_performance' },
      ranking: { dimension: 'Owner', metric: 'Amount', operation: 'sum', limit: requestedLimit },
      filters,
      limit: requestedLimit,
      offset: 0
    };
  }

  if (module === 'Leads' && /(group|grouped|each|percentage|top 5|highest-volume|lead source)/.test(lower)) {
    if (!filters.some((filter) => filter.field === 'Lead_Source' && filter.operator === 'equals')) {
      filters.push({ field: 'Lead_Source', operator: 'is_not_null' });
    }
    return {
      module,
      complexity: 'MULTI-STEP',
      request_type: 'analysis',
      analysis: { type: 'lead_source_report' },
      fields: ['First_Name', 'Last_Name', 'Company', 'Email', 'Lead_Status', 'Lead_Source', 'Created_Time'],
      filters,
      limit: 20,
      offset: 0
    };
  }

  if (module === 'Deals' && /(dashboard|report)/.test(lower) && /(by all persons|by all owners|per owner|by owner|each owner|all persons|all owners)/.test(lower)) {
    return {
      module,
      complexity: 'COMPLEX',
      request_type: 'aggregate',
      aggregate: { operation: 'sum', field: 'Amount' },
      group_by: 'Owner',
      filters,
      limit: 20,
      offset: 0
    };
  }

  if (module === 'Deals' && /(closed won|closed-won)/.test(lower) && /(this month|current month|last month|previous month)/.test(lower)) {
    return {
      module: 'Deals',
      complexity: 'MODERATE',
      request_type: 'analysis',
      analysis: { type: 'closed_won_summary' },
      fields: ['id', 'Amount', 'Closing_Date', 'Stage'],
      filters,
      limit: 1,
      offset: 0
    };
  }

  const aggregateOperation = module === 'Leads' ? null : detectAggregateOperation(lower);
  if (aggregateOperation) {
    return {
      module,
      complexity: 'MODERATE',
      request_type: 'aggregate',
      aggregate: { operation: aggregateOperation.operation, field: aggregateOperation.field },
      filters,
      limit: 20,
      offset: 0
    };
  }

  if (isLeadConversionQuestion(lower)) {
    return {
      module: 'Leads',
      complexity: 'MULTI-STEP',
      request_type: 'analysis',
      analysis: { type: 'lead_conversion' },
      fields: ['id'],
      filters,
      limit: 20,
      offset: 0
    };
  }

  if (/(count|how many|number of|total number|many)/.test(lower) || /(?:lead|deal)s? created/.test(lower)) {
    return {
      module,
      complexity: 'SIMPLE',
      request_type: 'count',
      fields: ['id'],
      filters,
      limit: 20,
      offset: 0
    };
  }

  if (/(latest|recent|most recent|newest)/.test(lower)) {
    return {
      module,
      request_type: 'records',
      fields: defaultFields(module),
      filters,
      sort_field: recordSort.field,
      sort_order: recordSort.order,
      limit: requestedLimit,
      offset: 0
    };
  }

  return {
    module,
    complexity: 'SIMPLE',
    request_type: 'records',
    fields: defaultFields(module),
    filters,
    sort_field: recordSort.field,
    sort_order: recordSort.order,
    limit: requestedLimit,
    offset: 0
  };
}

function extractRecordLimit(lowerText) {
  const match = lowerText.match(/(?:first|latest|last|oldest|top|show|give me)\s+(\d+)\b/i);
  if (!match) return 20;
  return Math.min(Math.max(Number(match[1]), 1), 200);
}

function isComprehensiveSalesPerformanceRequest(lowerText) {
  const modules = ['leads', 'converted', 'accounts', 'contacts', 'deals'];
  const metrics = ['lead source', 'owner', 'closed won', 'conversion rate', 'created'];
  const moduleCount = modules.filter((term) => lowerText.includes(term)).length;
  const metricCount = metrics.filter((term) => lowerText.includes(term)).length;
  return moduleCount >= 4 && (metricCount >= 3 || /sales performance|compare|overall/.test(lowerText));
}

function isLeadConversionQuestion(lowerText) {
  return /\b(?:conversion rate|conversion|converted|converted to deals?|became deals?|lead to deal)\b/.test(lowerText)
    && /\b(?:lead|leads)\b/.test(lowerText);
}

function isConversionFunnelQuestion(lowerText) {
  return /\b(?:conversion rate|conversion funnel|funnel conversion)\b/.test(lowerText)
    && /\b(?:lead|leads)\b/.test(lowerText)
    && /\b(?:contact|contacts)\b/.test(lowerText)
    && /\b(?:account|accounts)\b/.test(lowerText)
    && /\b(?:deal|deals)\b/.test(lowerText)
    && /\b(?:closed won|closed-won|won deals?|won deal)\b/.test(lowerText);
}

function isLeadToClosedWonQuestion(lowerText) {
  return /\b(?:closed won|closed-won)\b/.test(lowerText)
    && /\b(?:lead|leads)\b/.test(lowerText);
}

function isHighestLeadCreationDayQuestion(lowerText) {
  return /\bday\b/.test(lowerText)
    && /(highest|most|maximum|max|busiest|top)/.test(lowerText)
    && /\bleads?\b/.test(lowerText)
    && /\bcreated\b/.test(lowerText);
}

function extractRequestedYear(lowerText) {
  const match = lowerText.match(/\b(?:created\s+in\s+|during\s+|for\s+)(20\d{2})\b/);
  return match ? Number(match[1]) : new Date().getFullYear();
}

function detectRecordSort(lowerText, module) {
  if (/(oldest|first created|earliest)/.test(lowerText)) return { field: 'Created_Time', order: 'asc' };
  if (/(highest|largest|maximum|top|latest|recent|newest)/.test(lowerText) && module === 'Deals' && /(amount|value|revenue|deal)/.test(lowerText)) return { field: 'Amount', order: 'desc' };
  return { field: defaultSortField(module), order: 'desc' };
}

function buildAssistantAnswer(question, result) {
  const text = String(question || '').trim();
  const count = Number(result?.count ?? result?.summary?.leads_created ?? result?.summary?.leads_converted ?? 0);
  const summary = result?.summary || {};
  const module = result?.module || 'CRM';

  if (result?.analysis === 'closed_won_summary') {
    const range = result.filters?.find((filter) => filter.field === 'Closing_Date')?.value || [];
    return `Closed Won Deals for ${range[0] || 'the selected period'} through ${range[1] || 'the selected period'}: ${result.count} deals, ${formatAmount(result.total_amount, result.currency)} total amount, and ${formatAmount(result.average_amount, result.currency)} average deal value.`;
  }

  if (result?.analysis === 'count_and_records') {
    return `I found ${result.count} matching ${module.toLowerCase()} records and retrieved ${result.data?.length || 0} for display.`;
  }

  if (result?.analysis === 'lead_closed_won_conversion') {
    const metrics = result.metrics || {};
    return `Total Leads: ${metrics.total_leads}. Converted Leads: ${metrics.converted_leads}. Closed Won Deals: ${metrics.closed_won_deals}. Lead Conversion Rate: ${metrics.converted_leads} / ${metrics.total_leads} x 100 = ${formatPercent(metrics.lead_conversion_rate)}. Lead-to-Closed-Won Rate: ${metrics.closed_won_deals} / ${metrics.total_leads} x 100 = ${formatPercent(metrics.lead_to_closed_won_rate)}.`;
  }

  if (result?.analysis === 'highest_creation_day') {
    return result.top_date
      ? `${result.top_date} had the highest number of Leads created: ${result.top_count} (out of ${result.total_leads_checked} Leads checked for the selected period).`
      : `No Leads were created in the selected period.`;
  }

  if (result?.analysis === 'conversion_funnel') {
    const totals = result.totals || {};
    const rates = result.conversion_rates || {};
    return `Conversion funnel: ${totals.leads} leads, ${totals.contacts} contacts, ${totals.accounts} accounts, ${totals.deals} deals, and ${totals.closed_won_deals} Closed Won deals. Lead-to-Contact: ${formatPercent(rates.lead_to_contact)}. Contact-to-Account: ${formatPercent(rates.contact_to_account)}. Account-to-Deal: ${formatPercent(rates.account_to_deal)}. Deal-to-Closed-Won: ${formatPercent(rates.deal_to_closed_won)}.`;
  }

  if (result?.analysis === 'today_activity') {
    const rows = Array.isArray(result.activity_rows) ? result.activity_rows : [];
    if (rows.length === 0) return 'Today\'s audit log: no verified CRM records were found for today.';
    const header = '| Module | Count | Latest record | Date field |';
    const separator = '| --- | ---: | --- | --- |';
    const lines = rows.map((row) => `| ${row.module} | ${row.count} | ${row.latest_record} | ${row.date_field} |`);
    return [`Today\'s audit log`, header, separator, ...lines, '', `Total verified records: ${result.total_count}`].join('\n');
  }

  if (result?.request_type === 'aggregate') {
    const rows = Array.isArray(result.data) ? result.data : [];
    const lines = rows.map((row) => `${row.Owner ?? 'Unassigned'}: ${formatAmount(row.value, row.currency)}`);
    return lines.length > 0
      ? `CRM dashboard for ${module}:\n${lines.join('\n')}\nTotal: ${formatAmount(rows.reduce((total, row) => total + Number(row.value || 0), 0), result.currency)}`
      : `CRM dashboard for ${module}: no matching records were found.`;
  }

  if (result?.request_type === 'analysis' && result?.analysis === 'lead_source_report') {
    const lines = (result.source_breakdown || []).map((row) => `${row.source}: ${row.count} (${row.percentage}%)`);
    const leads = (result.top_leads || []).map((lead, index) => `${index + 1}. ${lead.name} | ${lead.company || 'No company'} | ${lead.email || 'No email'} | ${lead.lead_status || 'No status'} | ${lead.created_time || 'No date'}`);
    return `Lead Source Dashboard\n\n${lines.join('\n')}\n\nTop 5 leads from ${result.top_source || 'the highest-volume source'}:\n${leads.join('\n')}`;
  }

  if (result?.request_type === 'analysis' && result?.analysis === 'lead_source_conversion_report') {
    const lines = (result.source_breakdown || []).map((row) => `${row.source}: ${row.converted} converted of ${row.leads} leads (${row.conversion_rate}%)`);
    return `Lead Source Conversion Report\n\n${lines.join('\n')}`;
  }

  if (result?.request_type === 'analysis' && result?.analysis === 'owner_performance') {
    const lines = (result.owners || []).map((owner, index) => `${index + 1}. ${owner.owner}: ${formatAmount(owner.total_value, owner.currency || result.currency)} total value, ${owner.deals} deals, ${owner.closed_won} Closed Won, ${owner.win_rate == null ? 'not calculable' : `${owner.win_rate}%`} win rate`);
    const overall = result.overall || {};
    return `Owner performance for ${result.year}:\n${lines.join('\n')}\n\nOverall: ${overall.deals} deals, ${overall.closed_won} Closed Won, ${overall.win_rate == null ? 'win rate not calculable' : `${overall.win_rate}% win rate`}.`;
  }

  if (result?.request_type === 'analysis' && summary.conversion_rate != null) {
    const convertedToDeals = summary.leads_converted_to_deals ?? summary.leads_converted ?? 0;
    const createdLeads = summary.leads_created ?? 0;
    const rate = formatPercent(summary.conversion_rate);
    return `CRM summary: the live ${module} dataset shows ${createdLeads} leads created and ${convertedToDeals} converted-to-deal outcomes. Key metric: the conversion rate is ${rate}. Explanation: this was calculated from verified CRM records and reflects the actual relationship between created leads and converted deals in the selected date window.`;
  }

  if (Array.isArray(result?.data) && result.data.length > 0) {
    return `CRM summary: I reviewed the matching ${module} records for "${text}" and found ${result.data.length} relevant entries. Key metric: the result set is the latest matching data from the selected CRM filters. Explanation: the backend retrieved the exact records and kept the relevant fields needed for the question.`;
  }

  if (result?.request_type === 'records' && module === 'Accounts' && Number.isInteger(count) && count > 0) {
    return `CRM summary: I checked the live Accounts records for "${text}" and found ${count} matching account records, but the detailed rows were not returned in this response. Key metric: the module is available and contains records; the current response did not include the record list. Explanation: the backend should keep the request on record retrieval rather than summarizing it as count-only.`;
  }

  if (result?.request_type === 'count' || Number.isInteger(count)) {
    return `CRM summary: I checked the live ${module} records for "${text}" and found ${count} matching ${module.toLowerCase()} records. Key metric: this is the total count for the current filters and date window. Explanation: the result is based on the exact Zoho CRM filters applied in the backend.`;
  }

  return `CRM summary: I reviewed the live ${module} data for "${text}" and did not find any records that match the exact filters applied. Key metric: zero matching results. Explanation: the query was executed using the backend’s CRM filters, and no verified data was returned for that request.`;
}

function formatPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0%';
  return `${numeric.toFixed(2)}%`;
}

function formatAmount(value, currency) {
  const amount = Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (!currency) return amount;
  const symbols = { INR: '₹', USD: '$', EUR: '€', GBP: '£' };
  const symbol = symbols[String(currency).toUpperCase()] || String(currency);
  return `${symbol} ${amount}`;
}

function detectModule(lowerText) {
  if (/(meeting|meetings|event|events|appointment|appointments)/.test(lowerText)) return 'Meetings';
  if (/(lead|leads)/.test(lowerText) && /(converted|conversion|become.*deal|became.*deal)/.test(lowerText)) return 'Leads';
  if (/(deal|deals)/.test(lowerText)) return 'Deals';
  if (/(lead|leads)/.test(lowerText)) return 'Leads';
  if (/(account|accounts)/.test(lowerText)) return 'Accounts';
  if (/(contact|contacts)/.test(lowerText)) return 'Contacts';
  return 'Deals';
}

function defaultFields(module) {
  if (module === 'Leads') return ['First_Name', 'Last_Name', 'Company', 'Created_Time', 'Lead_Source', 'Owner'];
  if (module === 'Accounts') return ['Account_Name', 'Industry', 'Owner', 'Created_Time'];
  if (module === 'Contacts') return ['First_Name', 'Last_Name', 'Account_Name', 'Email', 'Owner'];
  if (module === 'Meetings') return ['Event_Title', 'Subject', 'Start_DateTime', 'End_DateTime', 'Location', 'Owner'];
  return ['Deal_Name', 'Amount', 'Stage', 'Owner', 'Closing_Date'];
}

function defaultSortField(module) {
  if (module === 'Deals') return 'Created_Time';
  if (module === 'Leads') return 'Created_Time';
  if (module === 'Accounts') return 'Created_Time';
  if (module === 'Contacts') return 'Created_Time';
  if (module === 'Meetings') return 'Start_DateTime';
  return 'Created_Time';
}

function extractOwnerName(text) {
  const patterns = [
    /(?:owned by|owner is|assigned to|belongs to)\s+([A-Za-z][A-Za-z .'-]*?)(?=\s+(?:above|below|greater than|less than|more than|for|\.|$))/i,
    /(?:by)\s+([A-Za-z][A-Za-z .'-]*?)(?=\s+(?:above|below|greater than|less than|more than|for|\.|$))/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const value = match[1].trim();
      if (!/^(this|that|these|those|next|latest|month|week|quarter|year|all|all persons|all owners|persons|owners|owner)$/i.test(value)) return value;
    }
  }
  return null;
}

function extractAmountThreshold(lowerText) {
  const match = lowerText.match(/(?:above|greater than|more than|over|at least|min(?:imum)?|>=)\s*₹?\s*([0-9][0-9,]*(?:\.\d+)?)/i);
  if (match) {
    return { field: 'Amount', operator: 'greater_than', value: Number(match[1].replace(/,/g, '')) };
  }
  return null;
}

function detectDateFilter(lowerText, module) {
  const currentDate = new Date();
  const dateField = dateFieldForQuestion(lowerText, module);

  if (/(today)/.test(lowerText)) {
    return calendarFilter(dateField, dayRange(currentDate));
  }

  if (/(yesterday)/.test(lowerText)) {
    const yesterday = new Date(currentDate);
    yesterday.setDate(currentDate.getDate() - 1);
    return calendarFilter(dateField, dayRange(yesterday));
  }

  if (/(this month|current month)/.test(lowerText)) {
    return calendarFilter(dateField, monthRange(currentDate, 0));
  }

  if (/(last month|previous month)/.test(lowerText)) {
    return calendarFilter(dateField, monthRange(currentDate, -1));
  }

  if (/(this quarter|current quarter)/.test(lowerText)) {
    return calendarFilter(dateField, quarterRange(currentDate, 0));
  }

  if (/(last quarter|previous quarter)/.test(lowerText)) {
    return calendarFilter(dateField, quarterRange(currentDate, -1));
  }

  if (/(this year|current year)/.test(lowerText)) {
    const start = new Date(currentDate.getFullYear(), 0, 1);
    const end = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate());
    return calendarFilter(dateField, [toIsoDate(start), toIsoDate(end)]);
  }

  if (/(last year|previous year)/.test(lowerText)) {
    const start = new Date(currentDate.getFullYear() - 1, 0, 1);
    const end = new Date(currentDate.getFullYear() - 1, 11, 31);
    return calendarFilter(dateField, [toIsoDate(start), toIsoDate(end)]);
  }

  const yearMatch = lowerText.match(/\b(?:created\s+in\s+|during\s+|for\s+)(20\d{2})\b/);
  if (yearMatch) {
    const year = Number(yearMatch[1]);
    return calendarFilter(dateField, [`${year}-01-01`, `${year}-12-31`]);
  }

  const exactRange = lowerText.match(/between\s+(\d{4}-\d{2}-\d{2})\s+and\s+(\d{4}-\d{2}-\d{2})/i);
  if (exactRange) {
    return calendarFilter(dateField, [exactRange[1], exactRange[2]]);
  }

  const namedRange = lowerText.match(/between\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})\s+and\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})/i);
  if (namedRange) {
    const start = new Date(`${namedRange[1]} ${namedRange[2]}, ${namedRange[3]}`);
    const end = new Date(`${namedRange[4]} ${namedRange[5]}, ${namedRange[6]}`);
    return calendarFilter(dateField, [toIsoDate(start), toIsoDate(end)]);
  }

  if (lowerText.includes('created this month') || lowerText.includes('created in this month')) {
    return calendarFilter('Created_Time', monthRange(currentDate, 0));
  }

  if (/(created|date)\s+(this month|last month|this quarter|last quarter)/.test(lowerText)) {
    return calendarFilter('Created_Time', monthRange(currentDate, /last month|previous month/.test(lowerText) ? -1 : 0));
  }

  return null;
}

function dateFieldForQuestion(lowerText, module) {
  if (module === 'Meetings') {
    if (/(created|creation|new|added|entered)/.test(lowerText)) return 'Created_Time';
    return 'Start_DateTime';
  }
  if (module !== 'Deals') return 'Created_Time';
  if (/(created|creation|new|added|entered)/.test(lowerText)) return 'Created_Time';
  return 'Closing_Date';
}

function calendarFilter(field, value) {
  if (field !== 'Created_Time') return { field, operator: 'between', value };
  const exclusiveEnd = new Date(`${value[1]}T00:00:00Z`);
  exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
  return { field, operator: 'between', value: [value[0], exclusiveEnd.toISOString().slice(0, 10)], exclusive_end: true };
}

function dayRange(date) {
  return [toIsoDate(date), toIsoDate(date)];
}

function monthRange(referenceDate, offsetMonths) {
  const start = new Date(referenceDate.getFullYear(), referenceDate.getMonth() + offsetMonths, 1);
  const end = new Date(referenceDate.getFullYear(), referenceDate.getMonth() + offsetMonths + 1, 1);
  end.setDate(end.getDate() - 1);
  return [toIsoDate(start), toIsoDate(end)];
}

function quarterRange(referenceDate, offsetQuarters) {
  const year = referenceDate.getFullYear();
  const quarterIndex = Math.floor(referenceDate.getMonth() / 3) + offsetQuarters;
  const startMonth = (quarterIndex * 3) % 12;
  const targetYear = year + Math.floor((quarterIndex * 3) / 12);
  const start = new Date(targetYear, startMonth, 1);
  const end = new Date(targetYear, startMonth + 3, 1);
  end.setDate(end.getDate() - 1);
  return [toIsoDate(start), toIsoDate(end)];
}

function toIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function detectAggregateOperation(lowerText) {
  if (/(average|avg)/.test(lowerText)) {
    return { operation: 'avg', field: 'Amount' };
  }
  if (/(total|sum|combined)/.test(lowerText)) {
    return { operation: 'sum', field: 'Amount' };
  }
  if (/(highest|largest|max)/.test(lowerText)) {
    return { operation: 'max', field: 'Amount' };
  }
  if (/(lowest|smallest|min)/.test(lowerText)) {
    return { operation: 'min', field: 'Amount' };
  }
  return null;
}

module.exports = { createCrmController, planQuestion };
