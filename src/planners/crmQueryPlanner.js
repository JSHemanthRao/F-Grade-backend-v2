const { createCanonicalPlan } = require('../query/canonicalPlan');
const { createAppError } = require('../utils/errors');

const WRITE_REQUEST = /\b(create|insert|update|edit|modify|delete|remove|convert|approve|merge|assign|close|reopen)\b/i;

function createCrmQueryPlanner(sourcePlanner) {
  if (typeof sourcePlanner !== 'function') throw new TypeError('A source planner is required.');

  return function planCrmQuestion(question, context = {}) {
    const originalQuestion = String(question || '').trim();
    if (!originalQuestion) throw createAppError('QUESTION_REQUIRED', 'A natural-language CRM question is required.', 400);
    const isPresentationRequest = /\b(dashboard|report|chart|summary|analysis|visuali[sz]e)\b/i.test(originalQuestion);
    if (WRITE_REQUEST.test(originalQuestion) && !isPresentationRequest) {
      throw createAppError('READ_ONLY_OPERATION', 'CRM assistant requests are strictly read-only.', 400, { operation: 'write' });
    }

    const planned = sourcePlanner(originalQuestion, context);
    const canonical = createCanonicalPlan({ ...planned, original_question: originalQuestion });
    return {
      ...planned,
      ...canonical,
      original_question: originalQuestion,
      intent: canonical.intent,
      pagination: canonical.pagination
    };
  };
}

module.exports = { createCrmQueryPlanner };
