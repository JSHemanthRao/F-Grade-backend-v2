const { DEBUG_ASSISTANT } = require('../../../common/config/env');
const logger = require('../../../common/logging/logger');
const { shouldDefaultMonthlyBusinessActivityToDeals } = require('../business-criteria.service');

const MODULE_PATTERNS = {
  leads: /\b(lead|leads|prospect|prospects)\b/i,
  deals: /\b(deal|deals|opportunity|opportunities|sale\b(?!\s+orders?)|sales\b(?!\s+orders?)|revenue|closed\s+won|deal\s+value)\b/i,
  contacts: /\b(contact|contacts)\b/i,
  accounts: /\b(account|accounts|customer|customers|company|companies|business|businesses)\b/i,
  events: /\b(event|events|meeting|meetings|appointment|appointments)\b/i,
  vendors: /\b(vendor|vendors|supplier|suppliers)\b/i,
  tasks: /\b(task|tasks)\b/i,
  calls: /\b(call|calls)\b/i,
  quotes: /\b(quote|quotes)\b/i,
  products: /\b(product|products)\b/i,
  'purchase-orders': /\b(purchase order|purchase orders|po)\b/i,
  'sales-orders': /\b(sales order|sales orders)\b/i,
  campaigns: /\b(campaign|campaigns)\b/i,
  users: /\b(user|users|sales\s+reps?|representatives?)\b/i,
};

function normalizeQuestion(question = '') {
  return String(question || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeQuestion(question = '') {
  const normalized = normalizeQuestion(question);
  return normalized
    .split(' ')
    .filter(Boolean)
    .filter((token) => !['the', 'all', 'entire', 'total', 'of', 'in', 'from', 'for'].includes(token));
}

function logModuleDebug(question, normalizedQuestion, tokens, normalizedTokens, checks, finalModule) {
  if (!DEBUG_ASSISTANT) {
    return;
  }

  logger.info('Module Detector', {
    originalQuestion: question,
    normalizedQuestion,
    tokens,
    normalizedTokens,
    aliasChecks: checks,
    finalModule,
  });
}

function detectModules(question = '') {
  const normalizedQuestion = normalizeQuestion(question);
  const tokens = tokenizeQuestion(question);
  const normalizedTokens = tokens.map((token) => token.replace(/s$/, ''));
  const modules = [];
  const checks = [];

  try {
    for (const [module, regex] of Object.entries(MODULE_PATTERNS)) {
      const matched = regex.test(normalizedQuestion);
      checks.push({ module, matched, pattern: regex.toString() });
      if (matched) {
        modules.push(module);
      }
    }
  } catch (error) {
    if (DEBUG_ASSISTANT) {
      logger.error('Module Detector', error);
    }
  }

  const finalModule = shouldDefaultMonthlyBusinessActivityToDeals(normalizedQuestion)
    && (modules.length === 0 || (modules.length === 1 && modules[0] === 'accounts'))
    ? ['deals']
    : modules.length > 0 ? modules : [];
  logModuleDebug(question, normalizedQuestion, tokens, normalizedTokens, checks, finalModule);

  return finalModule;
}

function detectModule(question) {
  return detectModules(question)[0] || null;
}

module.exports = {
  detectModule,
  detectModules,
  normalizeQuestion,
  tokenizeQuestion,
};
