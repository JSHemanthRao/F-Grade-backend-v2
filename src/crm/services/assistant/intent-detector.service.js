const { DEBUG_ASSISTANT } = require('../../../common/config/env');
const logger = require('../../../common/logging/logger');

const INTENT_ORDER = ['ACTIVITY', 'CONVERSION', 'COUNT', 'LIST', 'SEARCH', 'FILTER', 'COMPARE', 'SUMMARY', 'ANALYTICS', 'AGGREGATION', 'EXPLAIN'];

const INTENT_PATTERNS = {
  ACTIVITY: [/(today'?s?\s+(?:crm\s+)?activity|crm\s+activity|what\s+did\s+.*\s+do\s+today|what\s+changes\s+did\s+.*\s+make\s+today|activity\s+for\s+all\s+employees|daily\s+activity|activity\s+report)/i],
  CONVERSION: [/(converted|conversion|converted\s+into|converted\s+to|lead\s+conversion|qualified|became\s+a\s+deal)/i],
  COUNT: [/(how many|number of|count|total)/i],
  LIST: [/(show|list|display|view|give me|find)/i],
  SEARCH: [/(search|find|lookup|look for)/i],
  FILTER: [/(where|with|only|for|from|belonging to)/i],
  COMPARE: [/(compare|versus|vs|difference|difference between|better than|worse than)/i],
  SUMMARY: [/(summary|overview|snapshot|report)/i],
  ANALYTICS: [/(analytics|trend|distribution|performance|top|bottom|ranking|leader|owner)/i],
  AGGREGATION: [/(sum|average|total(?:\s+\w+){0,3}\s+(?:value|revenue|amount|sales)|revenue|sales|amount|deal value|median|percentage|growth|rate)/i],
  EXPLAIN: [/(why|explain|reason|cause)/i],
};

function logIntentDebug(question, normalizedQuestion, matchedKeywords, detectedIntents, confidence) {
  if (!DEBUG_ASSISTANT) {
    return;
  }

  logger.info('Intent Detector', {
    originalQuestion: question,
    normalizedQuestion,
    matchedKeywords,
    detectedIntent: detectedIntents,
    confidence,
  });
}

function detectIntents(question) {
  const normalizedQuestion = String(question || '').trim().toLowerCase();
  const detected = [];
  const matchedKeywords = [];

  try {
    INTENT_ORDER.forEach((intent) => {
      const matches = INTENT_PATTERNS[intent].filter((pattern) => pattern.test(normalizedQuestion));
      if (matches.length > 0) {
        detected.push(intent);
        matchedKeywords.push({ intent, keywords: INTENT_PATTERNS[intent].map((pattern) => pattern.toString()) });
      }
    });
  } catch (error) {
    if (DEBUG_ASSISTANT) {
      logger.error('Intent Detector', error);
    }
  }

  const finalIntents = detected.length > 0 ? detected : ['SUMMARY'];
  logIntentDebug(question, normalizedQuestion, matchedKeywords, finalIntents, finalIntents.length > 0 ? 'high' : 'low');

  return finalIntents;
}

module.exports = {
  detectIntents,
};
