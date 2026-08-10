const STAGE_PATTERN = /\b(closed\s+won|closed\s+lost|qualification|needs\s+analysis|value\s+proposition|negotiation|proposal|new|open|won|lost)\b/gi;
const OWNER_PATTERN = /\b(?:owned\s+by|owner(?:\s+is)?|assigned\s+to)\s+([a-z][a-z .'-]{1,80}?)(?=\s+(?:for|from|in|by|with|this|last|between|and)\b|$)/i;
const SOURCE_PATTERN = /\b(?:from|lead\s+source|source)(?:\s+is)?\s*[:=]?\s*([a-z][a-z .'-]{1,80}?)(?=\s+(?:for|from|in|by|with|this|last|between|and)\b|$)/i;
const AMOUNT_PATTERN = /(?:\u20b9|rs\.?|\$|\u20ac|\u00a3)\s*[\d,]+(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s*(?:lakh|lakhs|crore|crores|k|m|million|billion)\b/i;

function normalizeValue(value) {
  return String(value || '').trim().replace(/[?.!,]+$/g, '');
}

function unique(values) {
  return [...new Set(values.map(normalizeValue).filter(Boolean))];
}

function extractNamedValues(text, pattern) {
  return [...text.matchAll(pattern)].map((match) => normalizeValue(match[1]));
}

function detectEntities(question = '') {
  const text = String(question || '').trim();
  const monthNames = new Set(['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']);
  const stages = unique(extractNamedValues(text, STAGE_PATTERN));
  const owner = text.match(OWNER_PATTERN)?.[1] || null;
  const source = text.match(SOURCE_PATTERN)?.[1] || null;
  const amountMatches = [...text.matchAll(new RegExp(AMOUNT_PATTERN.source, 'gi'))].map((match) => match[0]);
  const contextualPlainAmounts = [...text.matchAll(/\b(?:above|over|under|below|greater\s+than|less\s+than)\s+([\d,]+(?:\.\d+)?)\b/gi)].map((match) => match[1]);
  const statuses = extractNamedValues(text, /\b(?:status|state)\s*(?:=|is|:)?\s*([a-z][a-z -]*?)(?=\s+(?:for|from|in|by|with|this|last)\b|$)/gi);
  const countries = [
    ...[...text.matchAll(/\b(?:country|countries)\s*(?:=|is|:)?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g)].map((match) => match[1]),
    ...[...text.matchAll(/\bin\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g)].map((match) => match[1]),
  ].filter((value) => !monthNames.has(String(value).toLowerCase()) && !/^20\d{2}$/.test(String(value)));
  const regions = extractNamedValues(text, /\bregion\s*(?:=|is|:)?\s*([a-z][a-z -]*?)(?=\s+(?:for|from|in|by|with|this|last)\b|$)/gi);
  const cities = extractNamedValues(text, /\bcit(?:y|ies)\s*(?:=|is|:)?\s*([a-z][a-z .'-]*?)(?=\s+(?:for|from|in|by|with|this|last)\b|$)/gi);
  const companies = extractNamedValues(text, /\b(?:company|companies|account|customer|customers)\s*(?:=|is|named)?\s*([A-Z][A-Za-z0-9&.'-]*(?:\s+[A-Z][A-Za-z0-9&.'-]*)*)/g);
  const products = extractNamedValues(text, /\bproduct\s*(?:=|is|named)?\s*([A-Z][A-Za-z0-9&.'-]*(?:\s+[A-Z][A-Za-z0-9&.'-]*)*)/g);

  return {
    stages,
    owners: owner ? [normalizeValue(owner)] : [],
    leadSources: source ? [normalizeValue(source)] : [],
    amounts: unique([...amountMatches, ...contextualPlainAmounts]),
    statuses: unique(statuses),
    regions: unique(regions),
    countries: unique(countries),
    cities: unique(cities),
    names: owner ? [normalizeValue(owner)] : [],
    companies: unique(companies),
    products: unique(products),
    currencies: [...new Set((text.match(/[\u20b9$\u20ac\u00a3]|\b(?:rs|usd|eur|gbp|inr)\b/gi) || []).map((value) => value.toUpperCase()))],
  };
}

module.exports = { detectEntities };
