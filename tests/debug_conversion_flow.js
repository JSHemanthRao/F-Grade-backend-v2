const { zohoClient } = require('../src/common/config/axios');
const assistantEngine = require('../src/crm/services/assistant-engine.service');
const recordsService = require('../src/crm/services/records.service');

(async () => {
  const originalGet = zohoClient.get;
  const originalPost = zohoClient.post;
  const originalGetCount = recordsService.getCount;
  try {
    zohoClient.get = async (url) => {
      console.log('mock GET', url);
      return { data: { fields: [
        { api_name: 'Converted__s' },
        { api_name: 'Converted_Date_Time' },
        { api_name: 'Converted_Deal' },
        { api_name: 'Owner' },
      ] } };
    };
    zohoClient.post = async (_url, body) => {
      console.log('mock POST', _url, body.select_query ? 'coql' : 'other');
      return { data: { data: [
        { Converted__s: true, Converted_Deal: 'deal-1', Converted_Date_Time: '2026-08-02T00:00:00Z', Owner: { name: 'Alice' } },
        { Converted__s: true, Converted_Deal: 'deal-2', Converted_Date_Time: '2026-08-03T00:00:00Z', Owner: { name: 'Bob' } },
        { Converted__s: false, Owner: { name: 'Alice' } },
        { Converted__s: false, Owner: { name: 'Bob' } },
      ] } };
    };

    const rate = await assistantEngine.handleAssistantRequest({ question: 'Lead conversion rate this month' });
    console.log('RATE', JSON.stringify(rate.calculations, null, 2));

    const intoDeals = await assistantEngine.handleAssistantRequest({ question: 'How many leads were converted into deals this month?' });
    console.log('INTO', JSON.stringify(intoDeals.calculations, null, 2));

    const byOwner = await assistantEngine.handleAssistantRequest({ question: 'Show converted leads by owner this month' });
    console.log('BYOWNER', JSON.stringify(byOwner.calculations, null, 2));

  } catch (err) {
    console.error(err);
  } finally {
    zohoClient.get = originalGet;
    zohoClient.post = originalPost;
    recordsService.getCount = originalGetCount;
  }
})();
