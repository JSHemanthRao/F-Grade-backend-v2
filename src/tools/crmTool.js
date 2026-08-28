const { BackendClient } = require('../services/backendClient');

const MAX_QUESTION_LENGTH = 2000;

class CrmTool {
  constructor(backendClient = new BackendClient()) {
    this.backendClient = backendClient;
  }

  async execute({ question }) {
    if (typeof question !== 'string' || question.trim().length === 0) {
      const error = new Error('Question is required.');
      error.code = 'INVALID_QUESTION';
      error.statusCode = 400;
      throw error;
    }
    if (question.length > MAX_QUESTION_LENGTH) {
      const error = new Error(`Question must not exceed ${MAX_QUESTION_LENGTH} characters.`);
      error.code = 'QUESTION_TOO_LONG';
      error.statusCode = 400;
      throw error;
    }

    const response = await this.backendClient.ask(question);
    const responseText = typeof response === 'string'
      ? response
      : JSON.stringify(response, null, 2);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ response: responseText }, null, 2)
      }],
      structuredContent: { response: responseText }
    };
  }
}

module.exports = { CrmTool };
