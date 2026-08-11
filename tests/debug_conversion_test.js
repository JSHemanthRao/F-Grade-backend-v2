const assistantEngine = require('../src/crm/services/assistant-engine.service');
const { zohoClient } = require('../src/common/config/axios');
const recordsService = require('../src/crm/services/records.service');

(async () => {
  const originalGet = zohoClient.get;
  const originalPost = zohoClient.post;
  const originalGetCount = recordsService.getCount;
  zohoClient.get = async (url) => {
    console.log('mock GET called', url);
    return { data: { fields: [
      { api_name: 'Converted__s' },
      { api_name: 'Converted_Date_Time' },
      { api_name: 'Converted_Deal' },
      { api_name: 'Owner' },
    ] } };
  };
  zohoClient.post = async (_url, body) => {
    console.log('mock POST called', _url);
    return { data: { data: [
      { Converted__s: true, Converted_Deal: 'deal-1', Converted_Date_Time: '2026-08-02T00:00:00Z', Owner: { name: 'Alice' } },
      { Converted__s: true, Converted_Deal: 'deal-2', Converted_Date_Time: '2026-08-03T00:00:00Z', Owner: { name: 'Bob' } },
      { Converted__s: false, Owner: { name: 'Alice' } },
      { Converted__s: false, Owner: { name: 'Bob' } },
    ] } };
  };

  try {
    const rate = await assistantEngine.handleAssistantRequest({ question: 'Lead conversion rate this month' });
    console.log('RATE RESULT:', JSON.stringify(rate, null, 2));
  } catch (err) {
    console.error('ERR', err);
  } finally {
    zohoClient.get = originalGet;
    zohoClient.post = originalPost;
    recordsService.getCount = originalGetCount;
  }
})();
