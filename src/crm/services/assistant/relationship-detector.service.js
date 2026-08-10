function detectRelationships(question = '', modules = []) {
  const text = String(question || '').toLowerCase();
  const referenceText = text
    .replace(/\bthis\s+(?:week|month|quarter|year)\b/g, '')
    .replace(/\blast\s+(?:week|month|quarter|year|\d+\s+months?)\b/g, '')
    .replace(/\bcurrent\s+month\b|\bprevious\s+month\b|\bmonth[-\s]+to[-\s]+date\b/g, '');
  const relationships = [];
  if (modules.length > 1 && /\b(compare|versus|vs|between|with)\b/.test(text)) relationships.push('cross_module_comparison');
  if (modules.includes('contacts') && modules.includes('deals')
    && /\b(?:converted|converted\s+to|converted\s+into|associated|linked|related)\b/.test(text)) {
    relationships.push('contact_to_deal');
  }
  if (/converted\s+(?:into|to)\s+deals?|became\s+a\s+deal/.test(text)) relationships.push('lead_to_deal_conversion');
  if (/\b(?:by|per)\s+(?:owner|stage|status|country|region|source)/.test(text)) relationships.push('grouped_analysis');
  if (/\b(?:same|them|those|these|it|its|this|that|continue|remaining|next|previous)\b/.test(referenceText)) relationships.push('conversation_reference');
  return relationships;
}

module.exports = { detectRelationships };
