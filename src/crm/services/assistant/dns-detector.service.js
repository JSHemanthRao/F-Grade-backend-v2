const { normalizeDomain } = require('../dns.service');

const REQUESTED_RECORD_PATTERNS = [
  { type: 'A', regex: /\bA\s+records?\b|\bA\s+record\b/i },
  { type: 'AAAA', regex: /\bAAAA\b/i },
  { type: 'MX', regex: /\bMX\s+records?\b|\bMX\b/i },
  { type: 'CNAME', regex: /\bCNAME\b/i },
  { type: 'NS', regex: /\b(?:nameserver|nameservers|NS\s+records?\b|NS\b)/i },
  { type: 'TXT', regex: /\bTXT\s+records?\b|\bTXT\b/i },
  { type: 'SOA', regex: /\bSOA\b/i },
  { type: 'CAA', regex: /\bCAA\b/i },
  { type: 'SPF', regex: /\bSPF\b/i },
  { type: 'DMARC', regex: /\bDMARC\b/i },
  { type: 'SRV', regex: /\bSRV\b/i },
  { type: 'NAPTR', regex: /\bNAPTR\b/i },
  { type: 'PTR', regex: /\bPTR\b/i },
  { type: 'TLSA', regex: /\bTLSA\b/i },
];

const DNS_KEYWORDS = /\b(?:dns|dns records|dns lookup|dns check|dns information|nameservers?|mx|a(?:aaa)?|cname|txt|soa|caa|spf|dmarc|srv|naptr|ptr|tlsa)\b/i;
const URL_PATTERN = /\b(?:https?:\/\/|dns:\/\/|ftp:\/\/)[^\s]+/i;
const HOSTNAME_PATTERN = /([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\.?)/i;

function extractDomain(question) {
  const normalized = String(question || '').trim();
  const urlMatch = normalized.match(URL_PATTERN);
  if (urlMatch) {
    try {
      const url = new URL(urlMatch[0]);
      return url.hostname;
    } catch (error) {
      // fall through and attempt hostname extraction
    }
  }

  const hostMatch = normalized.match(HOSTNAME_PATTERN);
  if (!hostMatch) return null;
  return hostMatch[1];
}

function detectRequestedRecordTypes(question) {
  const lowerCased = String(question || '').toLowerCase();
  const requestedTypes = [];

  REQUESTED_RECORD_PATTERNS.forEach((pattern) => {
    if (pattern.regex.test(lowerCased)) {
      requestedTypes.push(pattern.type);
    }
  });

  return [...new Set(requestedTypes)];
}

function detectDnsRequest(question) {
  const normalized = String(question || '').trim();
  if (!normalized) return null;

  const keywordMatch = DNS_KEYWORDS.test(normalized);
  if (!keywordMatch) return null;

  const domain = extractDomain(normalized);
  const requestedRecords = detectRequestedRecordTypes(normalized);

  return {
    domain: domain ? normalizeDomain(domain) : null,
    requestedRecords,
  };
}

module.exports = {
  detectDnsRequest,
  detectRequestedRecordTypes,
  extractDomain,
};
