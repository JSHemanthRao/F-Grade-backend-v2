const { BackendClient } = require('../services/backendClient');

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

    const response = await this.backendClient.ask(question);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response, null, 2)
      }],
      structuredContent: response
    };
  }
}

module.exports = { CrmTool };
