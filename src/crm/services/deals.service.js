const recordsService = require('./retrieval-engine.service');
const { numericValue } = require('./assistant/currency.service');
const logger = require('../../common/logging/logger');

function normalizeStage(value) {
  return String(value || '').trim().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').toLowerCase();
}

function canonicalStage(value) {
  const stage = normalizeStage(value);
  if (stage === 'closed won' || stage === 'won') return 'Closed Won';
  if (stage === 'closed lost' || stage === 'lost') return 'Closed Lost';
  return String(value || '').trim() || 'Open';
}

function dealId(record, fallbackIndex) {
  const id = record?.id ?? record?.ID;
  return id === undefined || id === null || id === '' ? `missing-id-${fallbackIndex}` : String(id);
}

function normalizeDeal(record, fallbackIndex = 0) {
  const amount = numericValue(record?.Amount ?? record?.amount);
  return {
    ...record,
    id: dealId(record, fallbackIndex),
    Deal_Name: record?.Deal_Name || record?.Deal || record?.deal_name || 'Untitled Deal',
    Account_Name: typeof record?.Account_Name === 'object'
      ? record.Account_Name
      : record?.Account_Name ? { name: record.Account_Name } : { name: 'Direct Customer' },
    Owner: typeof record?.Owner === 'object'
      ? record.Owner
      : { name: record?.Owner || record?.Owner_Name || 'Unassigned' },
    Stage: canonicalStage(record?.Stage ?? record?.stage),
    Amount: amount,
    Closing_Date: record?.Closing_Date ?? record?.closing_date ?? null,
    Created_Time: record?.Created_Time ?? record?.created_time ?? null,
  };
}

function deduplicateDeals(records = []) {
  const seen = new Set();
  let duplicatesRemoved = 0;
  const unique = [];
  records.forEach((record, index) => {
    const normalized = normalizeDeal(record, index);
    if (seen.has(normalized.id)) {
      duplicatesRemoved += 1;
      return;
    }
    seen.add(normalized.id);
    unique.push(normalized);
  });
  return { records: unique, duplicatesRemoved };
}

async function getAllDeals(options = {}) {
  const providedRecords = options.records || options.data || options.deals;
  let result;
  if (Array.isArray(providedRecords)) {
    result = { data: providedRecords, info: options.info || {} };
  } else {
    result = await recordsService.getRecords('deals', {
      ...options,
      retrieval_mode: 'all',
      limit: undefined,
    });
  }

  const info = result?.info || {};
  if (info.retrievalComplete === false || info.more_records === true) {
    const error = new Error('Complete Deals retrieval did not finish.');
    error.code = 'CRM_DEALS_RETRIEVAL_INCOMPLETE';
    error.status = 502;
    throw error;
  }

  const deduplicated = deduplicateDeals(Array.isArray(result?.data) ? result.data : []);
  const metadata = {
    sourceRecordCount: Array.isArray(result?.data) ? result.data.length : 0,
    uniqueRecordCount: deduplicated.records.length,
    duplicateRecordsRemoved: deduplicated.duplicatesRemoved,
    pagesRetrieved: Number(info.pagesFetched || 1),
    retrievalComplete: info.retrievalComplete !== false,
    dateRange: options.from && options.to ? { from: options.from, to: options.to } : null,
    dateField: options.date_field || options.dateField || null,
    stageFilter: options.stage || null,
  };

  logger.info('[DEALS RETRIEVAL]', metadata);
  return { data: deduplicated.records, info, metadata };
}

module.exports = {
  canonicalStage,
  deduplicateDeals,
  getAllDeals,
  normalizeDeal,
  normalizeStage,
};
