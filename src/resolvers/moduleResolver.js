const { CRM_API_NAMES } = require('../constants/crmModules');
const { createAppError } = require('../utils/errors');

const FILLER_WORDS = new Set(['show', 'give', 'get', 'find', 'list', 'search', 'me', 'my', 'the', 'all', 'some', 'what', 'are', 'is', 'today', 'todays', 'latest', 'recent', 'first', 'top', 'records', 'record', 'from']);
const SEMANTIC_ALIASES = new Map([
  ['meeting', 'Meetings'], ['meetings', 'Meetings'], ['event', 'Meetings'], ['events', 'Meetings'],
  ['call', 'Calls'], ['calls', 'Calls'], ['task', 'Tasks'], ['tasks', 'Tasks'],
  ['deal', 'Deals'], ['deals', 'Deals'], ['lead', 'Leads'], ['leads', 'Leads'],
  ['contact', 'Contacts'], ['contacts', 'Contacts'], ['account', 'Accounts'], ['accounts', 'Accounts'],
  ['product', 'Products'], ['products', 'Products'], ['quote', 'Quotes'], ['quotes', 'Quotes']
]);

function normalizeModuleReference(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2018\u2019']/g, '')
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function singularize(value) {
  const normalized = normalizeModuleReference(value);
  if (normalized.endsWith('ies')) return `${normalized.slice(0, -3)}y`;
  if (normalized.endsWith('ses') && normalized.length > 4) return normalized.slice(0, -2);
  if (normalized.endsWith('s') && !normalized.endsWith('ss')) return normalized.slice(0, -1);
  return normalized;
}

function moduleTokens(value) {
  return normalizeModuleReference(value).split(' ').filter(Boolean);
}

function buildModuleRegistry(metadata = [], staticAliases = CRM_API_NAMES) {
  const entries = metadata.filter((item) => item && item.api_name).map((item) => {
    const label = item.display_label || item.plural_label || item.module_name || item.singular_label || item.api_name;
    const names = [item.api_name, item.module_name, item.plural_label, item.singular_label, item.display_label, label].filter(Boolean);
    const singularKeys = new Set([item.singular_label, singularize(label)].filter(Boolean).map(normalizeModuleReference));
    const keys = new Set(names.flatMap((name) => [normalizeModuleReference(name), singularize(name)]).filter(Boolean));
    return { item, api_name: item.api_name, label, keys, singularKeys };
  });

  for (const [alias, apiName] of Object.entries(staticAliases || {})) {
    const entry = entries.find((candidate) => candidate.api_name === apiName);
    if (!entry) continue;
    entry.keys.add(normalizeModuleReference(alias));
    const singularAlias = singularize(alias);
    entry.keys.add(singularAlias);
    entry.singularKeys.add(singularAlias);
  }
  return entries;
}

function extractModuleCandidates(text, registry = []) {
  const normalized = normalizeModuleReference(text);
  const phrases = new Set([normalized]);
  const words = normalized.split(' ').filter(Boolean);
  for (const entry of registry) {
    for (const key of entry.keys) {
      if (!key) continue;
      const expression = new RegExp(`(^| )${escapeRegExp(key)}(?= |$)`);
      if (expression.test(normalized)) phrases.add(key);
    }
  }
  const meaningful = words.filter((word) => !FILLER_WORDS.has(word));
  if (meaningful.length) phrases.add(meaningful.join(' '));
  return [...phrases];
}

function resolveModuleReference(userText, metadata = [], options = {}) {
  const registry = Array.isArray(metadata) ? buildModuleRegistry(metadata, options.staticAliases) : metadata;
  const candidates = extractModuleCandidates(userText, registry);
  const normalizedInput = normalizeModuleReference(userText);

  for (const entry of registry) {
    if (entry.keys.has(normalizedInput)) return resolved(entry, entry.singularKeys.has(normalizedInput) ? 0.98 : 1, entry.singularKeys.has(normalizedInput) ? 'singular' : 'exact_normalized');
  }
  for (const candidate of candidates) {
    const exact = registry.filter((entry) => entry.keys.has(candidate));
    if (exact.length === 1) {
      const matchType = exact[0].singularKeys.has(candidate) ? 'singular' : 'exact_normalized';
      return resolved(exact[0], matchType === 'singular' ? 0.98 : 0.99, matchType);
    }
    if (exact.length > 1) return ambiguous(exact);
  }

  const tokenCandidates = candidates.filter((candidate) => !candidate.includes(' '));
  for (const candidate of tokenCandidates) {
    const tokenMatches = registry.filter((entry) => [...entry.keys].some((key) => moduleTokens(key).includes(candidate)));
    if (tokenMatches.length > 1) return ambiguous(tokenMatches);
  }

  const aliasMatches = candidates.map((candidate) => SEMANTIC_ALIASES.get(candidate)).filter(Boolean);
  const uniqueAliases = [...new Set(aliasMatches)];
  const aliasEntries = registry.filter((entry) => uniqueAliases.includes(entry.label) || uniqueAliases.includes(entry.item.module_name));
  if (aliasEntries.length === 1) return resolved(aliasEntries[0], 0.95, 'alias');
  if (aliasEntries.length > 1) return ambiguous(aliasEntries);

  // Do not guess from token subsets: generated API names and custom labels can
  // make a permissive fuzzy match select the wrong live module.
  return { matched: false, ambiguous: false, candidates: [], user_text: userText };
}

function resolved(entry, confidence, matchType) {
  const semanticName = entry.item.module_name || entry.item.plural_label || entry.label;
  return {
    matched: true,
    ambiguous: false,
    semantic_name: semanticName === 'Events' ? 'Meetings' : semanticName,
    api_name: entry.api_name,
    label: semanticName === 'Events' ? 'Meetings' : entry.label,
    confidence,
    match_type: matchType,
    metadata: entry.item
  };
}

function ambiguous(entries) {
  return {
    matched: false,
    ambiguous: true,
    candidates: entries.map((entry) => ({ api_name: entry.api_name, label: entry.label }))
  };
}

function assertResolvedModule(result, userText) {
  if (result?.matched) return result;
  if (result?.ambiguous) throw createAppError('MODULE_AMBIGUOUS', `CRM module reference '${userText}' is ambiguous.`, 400, { requested_module: userText, candidates: result.candidates });
  throw createAppError('MODULE_UNAVAILABLE', `CRM module '${userText}' is unavailable for read operations.`, 400, { requested_module: userText, candidates: [] });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { normalizeModuleReference, singularize, buildModuleRegistry, resolveModuleReference, assertResolvedModule };
