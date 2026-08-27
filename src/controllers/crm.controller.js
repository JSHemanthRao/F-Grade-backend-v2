const { CrmService } = require('../services/crm.service');

function createCrmController(crmService = new CrmService()) {
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
            const result = await crmService.query({
          ...(req.body?.query || {}),
          ...planQuestion(question)
        });
        const answer = buildAssistantAnswer(question, result);
        res.status(200).json({ success: true, status: 'ok', question, answer, ...result });
      } catch (error) {
        next(error);
      }
    }
  };
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
  const module = detectModule(lower);
  const requestedLimit = extractRecordLimit(lower);
  const filters = [];
  const dateFilter = detectDateFilter(lower, module);
  if (dateFilter) filters.push(dateFilter);

  const ownerName = extractOwnerName(text);
  if (ownerName) filters.push({ field: 'Owner', operator: 'equals', value: ownerName });

  const amountThreshold = extractAmountThreshold(lower);
  if (amountThreshold) filters.push({ field: 'Amount', operator: 'greater_than', value: amountThreshold.value });

  if (/(closed won|closed-won|won deals|won deal)/.test(lower)) {
    filters.push({ field: 'Stage', operator: 'equals', value: 'Closed Won' });
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

  if (module === 'Leads' && /(group|grouped|each|percentage|top 5|highest-volume|lead source)/.test(lower)) {
    if (!filters.some((filter) => filter.field === 'Lead_Source' && filter.operator === 'equals')) {
      filters.push({ field: 'Lead_Source', operator: 'is_not_null' });
    }
    return {
      module,
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
      request_type: 'aggregate',
      aggregate: { operation: 'sum', field: 'Amount' },
      group_by: 'Owner',
      filters,
      limit: 20,
      offset: 0
    };
  }

  const aggregateOperation = detectAggregateOperation(lower);
  if (aggregateOperation) {
    return {
      module,
      request_type: 'aggregate',
      aggregate: { operation: aggregateOperation.operation, field: aggregateOperation.field },
      filters,
      limit: 20,
      offset: 0
    };
  }

  if (/(converted|conversion|became deals|became a deal|converted to deals|converted to deal)/.test(lower)) {
    return {
      module: 'Leads',
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
      sort_field: defaultSortField(module),
      sort_order: 'desc',
      limit: requestedLimit,
      offset: 0
    };
  }

  return {
    module,
    request_type: 'records',
    fields: defaultFields(module),
    filters,
    sort_field: defaultSortField(module),
    sort_order: 'desc',
    limit: requestedLimit,
    offset: 0
  };
}

function extractRecordLimit(lowerText) {
  const match = lowerText.match(/(?:first|latest|last|top|show|give me)\s+(\d+)\b/i);
  if (!match) return 20;
  return Math.min(Math.max(Number(match[1]), 1), 200);
}

function buildAssistantAnswer(question, result) {
  const text = String(question || '').trim();
  const count = Number(result?.count ?? result?.summary?.leads_created ?? result?.summary?.leads_converted ?? 0);
  const summary = result?.summary || {};
  const module = result?.module || 'CRM';

  if (result?.request_type === 'aggregate') {
    const rows = Array.isArray(result.data) ? result.data : [];
    const lines = rows.map((row) => `${row.Owner ?? 'Unassigned'}: ${formatAmount(row.value)}`);
    return lines.length > 0
      ? `CRM dashboard for ${module}:\n${lines.join('\n')}\nTotal: ${formatAmount(rows.reduce((total, row) => total + Number(row.value || 0), 0))}`
      : `CRM dashboard for ${module}: no matching records were found.`;
  }

  if (result?.request_type === 'analysis' && result?.analysis === 'lead_source_report') {
    const lines = (result.source_breakdown || []).map((row) => `${row.source}: ${row.count} (${row.percentage}%)`);
    const leads = (result.top_leads || []).map((lead, index) => `${index + 1}. ${lead.name} | ${lead.company || 'No company'} | ${lead.email || 'No email'} | ${lead.lead_status || 'No status'} | ${lead.created_time || 'No date'}`);
    return `Lead Source Dashboard\n\n${lines.join('\n')}\n\nTop 5 leads from ${result.top_source || 'the highest-volume source'}:\n${leads.join('\n')}`;
  }

  if (result?.request_type === 'analysis' && summary.conversion_rate != null) {
    const convertedToDeals = summary.leads_converted_to_deals ?? summary.leads_converted ?? 0;
    const createdLeads = summary.leads_created ?? 0;
    const rate = formatPercent(summary.conversion_rate);
    return `CRM summary: the live ${module} dataset shows ${createdLeads} leads created and ${convertedToDeals} converted-to-deal outcomes. Key metric: the conversion rate is ${rate}. Explanation: this was calculated from verified CRM records and reflects the actual relationship between created leads and converted deals in the selected date window.`;
  }

  if (result?.request_type === 'count' || Number.isInteger(count)) {
    return `CRM summary: I checked the live ${module} records for "${text}" and found ${count} matching ${module.toLowerCase()} records. Key metric: this is the total count for the current filters and date window. Explanation: the result is based on the exact Zoho CRM filters applied in the backend.`;
  }

  if (Array.isArray(result?.data) && result.data.length > 0) {
    return `CRM summary: I reviewed the matching ${module} records for "${text}" and found ${result.data.length} relevant entries. Key metric: the result set is the latest matching data from the selected CRM filters. Explanation: the backend retrieved the exact records and kept the relevant fields needed for the question.`;
  }

  return `CRM summary: I reviewed the live ${module} data for "${text}" and did not find any records that match the exact filters applied. Key metric: zero matching results. Explanation: the query was executed using the backend’s CRM filters, and no verified data was returned for that request.`;
}

function formatPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0%';
  return `${numeric.toFixed(2)}%`;
}

function formatAmount(value) {
  return `₹ ${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function detectModule(lowerText) {
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
  return ['Deal_Name', 'Amount', 'Stage', 'Owner', 'Closing_Date'];
}

function defaultSortField(module) {
  if (module === 'Deals') return 'Created_Time';
  if (module === 'Leads') return 'Created_Time';
  if (module === 'Accounts') return 'Created_Time';
  if (module === 'Contacts') return 'Created_Time';
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

  if (/(today)/.test(lowerText)) {
    return { field: module === 'Deals' ? 'Closing_Date' : 'Created_Time', operator: 'between', value: [toIsoDate(currentDate), toIsoDate(currentDate)] };
  }

  if (/(yesterday)/.test(lowerText)) {
    const yesterday = new Date(currentDate);
    yesterday.setDate(currentDate.getDate() - 1);
    return { field: module === 'Deals' ? 'Closing_Date' : 'Created_Time', operator: 'between', value: [toIsoDate(yesterday), toIsoDate(yesterday)] };
  }

  if (/(this month|current month)/.test(lowerText)) {
    return { field: module === 'Deals' ? 'Closing_Date' : 'Created_Time', operator: 'between', value: monthRange(currentDate, 0) };
  }

  if (/(last month|previous month)/.test(lowerText)) {
    return { field: module === 'Deals' ? 'Closing_Date' : 'Created_Time', operator: 'between', value: monthRange(currentDate, -1) };
  }

  if (/(this quarter|current quarter)/.test(lowerText)) {
    return { field: module === 'Deals' ? 'Closing_Date' : 'Created_Time', operator: 'between', value: quarterRange(currentDate, 0) };
  }

  if (/(last quarter|previous quarter)/.test(lowerText)) {
    return { field: module === 'Deals' ? 'Closing_Date' : 'Created_Time', operator: 'between', value: quarterRange(currentDate, -1) };
  }

  if (/(this year|current year)/.test(lowerText)) {
    const start = new Date(currentDate.getFullYear(), 0, 1);
    const end = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate());
    return { field: module === 'Deals' ? 'Closing_Date' : 'Created_Time', operator: 'between', value: [toIsoDate(start), toIsoDate(end)] };
  }

  if (/(last year|previous year)/.test(lowerText)) {
    const start = new Date(currentDate.getFullYear() - 1, 0, 1);
    const end = new Date(currentDate.getFullYear() - 1, 11, 31);
    return { field: module === 'Deals' ? 'Closing_Date' : 'Created_Time', operator: 'between', value: [toIsoDate(start), toIsoDate(end)] };
  }

  const exactRange = lowerText.match(/between\s+(\d{4}-\d{2}-\d{2})\s+and\s+(\d{4}-\d{2}-\d{2})/i);
  if (exactRange) {
    return { field: module === 'Deals' ? 'Closing_Date' : 'Created_Time', operator: 'between', value: [exactRange[1], exactRange[2]] };
  }

  const namedRange = lowerText.match(/between\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})\s+and\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})/i);
  if (namedRange) {
    const start = new Date(`${namedRange[1]} ${namedRange[2]}, ${namedRange[3]}`);
    const end = new Date(`${namedRange[4]} ${namedRange[5]}, ${namedRange[6]}`);
    return { field: module === 'Deals' ? 'Closing_Date' : 'Created_Time', operator: 'between', value: [toIsoDate(start), toIsoDate(end)] };
  }

  if (lowerText.includes('created this month') || lowerText.includes('created in this month')) {
    return { field: 'Created_Time', operator: 'between', value: monthRange(currentDate, 0) };
  }

  if (/(created|date)\s+(this month|last month|this quarter|last quarter)/.test(lowerText)) {
    return { field: 'Created_Time', operator: 'between', value: monthRange(currentDate, /last month|previous month/.test(lowerText) ? -1 : 0) };
  }

  return null;
}

function monthRange(referenceDate, offsetMonths) {
  const start = new Date(referenceDate.getFullYear(), referenceDate.getMonth() + offsetMonths, 1);
  const end = new Date(referenceDate.getFullYear(), referenceDate.getMonth() + offsetMonths + 1, 0);
  return [toIsoDate(start), toIsoDate(end)];
}

function quarterRange(referenceDate, offsetQuarters) {
  const year = referenceDate.getFullYear();
  const quarterIndex = Math.floor(referenceDate.getMonth() / 3) + offsetQuarters;
  const startMonth = (quarterIndex * 3) % 12;
  const targetYear = year + Math.floor((quarterIndex * 3) / 12);
  const start = new Date(targetYear, startMonth, 1);
  const end = new Date(targetYear, startMonth + 3, 0);
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
