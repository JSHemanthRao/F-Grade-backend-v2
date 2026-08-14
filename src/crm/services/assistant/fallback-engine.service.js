const FALLBACK_REASONS = Object.freeze({
  EMPTY_RESULT: 'EMPTY_RESULT',
  UNSUPPORTED_METRIC: 'UNSUPPORTED_METRIC',
  INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',
  INVALID_QUERY: 'INVALID_QUERY',
});
const logger = require('../../../common/logging/logger');

const SAFE_MESSAGES = Object.freeze({
  [FALLBACK_REASONS.EMPTY_RESULT]: 'No matching CRM records were found for the requested period.',
  [FALLBACK_REASONS.UNSUPPORTED_METRIC]: "I couldn't calculate this metric because the CRM records do not contain the required information.",
  [FALLBACK_REASONS.INSUFFICIENT_DATA]: "I couldn't calculate this metric because the CRM records do not contain the required information.",
  [FALLBACK_REASONS.INVALID_QUERY]: 'The CRM could not provide the requested information at this time.',
});

function logFallbackReason(reason, details = {}) {
  // Reason codes are deliberately restricted to this internal log entry.
  logger.info('Fallback Decision', { reason, ...details });
}

function chooseFallback({ exactAnswer, closestAnswer, clarifyingQuestion, reason = FALLBACK_REASONS.EMPTY_RESULT } = {}) {
  if (exactAnswer) return { type: 'EXACT', answer: exactAnswer };
  if (closestAnswer) return { type: 'CLOSEST_SUPPORTED', answer: closestAnswer };
  if (clarifyingQuestion) return { type: 'CLARIFICATION', answer: clarifyingQuestion };
  return { type: 'EXPLANATION', answer: SAFE_MESSAGES[reason] || SAFE_MESSAGES[FALLBACK_REASONS.EMPTY_RESULT] };
}

module.exports = {
  FALLBACK_REASONS,
  SAFE_MESSAGES,
  chooseFallback,
  logFallbackReason,
};
