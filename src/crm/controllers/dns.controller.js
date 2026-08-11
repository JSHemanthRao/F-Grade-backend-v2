const { resolveDnsRecords, filterDnsRecords, formatDnsResponse } = require('../services/dns.service');

async function handleDnsRequest(req, res, next) {
  try {
    const domain = String(req.query?.domain || req.query?.q || '').trim();
    const recordTypeValue = req.query?.type || req.query?.recordType || req.query?.record_type;
    const requestedRecords = Array.isArray(recordTypeValue)
      ? recordTypeValue
      : String(recordTypeValue || '')
        .split(/[,\s]+/)
        .filter((item) => item.trim())
        .map((item) => item.trim());

    if (!domain) {
      return res.status(400).json({ success: false, message: 'A domain query parameter is required.' });
    }

    const allRecords = await resolveDnsRecords(domain);
    const filteredRecords = filterDnsRecords(allRecords, requestedRecords);
    const response = formatDnsResponse({
      domain,
      completeRecords: allRecords,
      filteredRecords,
      requestedRecords,
    });

    return res.json(response);
  } catch (error) {
    return next(error);
  }
}

module.exports = { handleDnsRequest };
