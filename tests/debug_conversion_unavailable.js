const assistantEngine = require('../src/crm/services/assistant-engine.service');
const { zohoClient } = require('../src/common/config/axios');
const recordsService = require('../src/crm/services/records.service');

(async () => {
  const originalGet = zohoClient.get;
  const originalPost = zohoClient.post;
  const originalGetCount = recordsService.getCount;

  try {
    zohoClient.get = async (url) => {
      console.log('mock GET for unavailable called', url);
      return { data: { fields: [] } };
    };
    recordsService.getCount = async (module) => ({ info: { count: module === 'leads' ? 12 : 7 }, data: [] });

    const unavailable = await assistantEngine.handleAssistantRequest({ question: 'How many leads were converted last month?' });
    console.log('UNAVAILABLE RESULT:', JSON.stringify(unavailable, null, 2));
  } catch (err) {
    console.error('ERR', err);
  } finally {
    zohoClient.get = originalGet;
    zohoClient.post = originalPost;
    recordsService.getCount = originalGetCount;
  }
})();
