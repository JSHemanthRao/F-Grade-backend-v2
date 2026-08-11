const test = require('node:test');
const assert = require('node:assert/strict');
const { buildExecutionPlan } = require('../src/crm/services/assistant/planner.service');
const { detectIntents } = require('../src/crm/services/assistant/intent-detector.service');
const { zohoClient } = require('../src/common/config/axios');
const assistantEngine = require('../src/crm/services/assistant-engine.service');
const recordsService = require('../src/crm/services/records.service');

test('conversion questions receive CONVERSION intent and conversion_count steps', () => {
  const cases = [
    ['How many leads were converted this month?', 'this_month'],
    ['How many leads were converted into deals last month?', 'last_month'],
    ['Lead conversion rate this quarter.', 'this_quarter'],
    ['Compare lead conversions with last month.', 'last_month'],
    ['Show converted leads this week.', 'this_week'],
  ];

  cases.forEach(([question, expectedRange]) => {
    const intents = detectIntents(question);
    const plan = buildExecutionPlan(question);
    assert.equal(intents.includes('CONVERSION'), true, question);
    assert.equal(plan.steps.some((step) => step.type === 'count'), false, question);
    assert.equal(plan.steps[0].type, 'conversion_count', question);
    assert.equal(plan.steps[0].sourceModule, 'leads', question);
    assert.equal(plan.steps[0].targetModule, 'deals', question);
    assert.equal(plan.steps[0].timeRange, expectedRange, question);
  });
});

test('conversion execution discovers fields, calculates metrics, and does not guess when metadata is empty', async () => {
  const originalGet = zohoClient.get;
  const originalPost = zohoClient.post;
  const originalGetCount = recordsService.getCount;
  zohoClient.get = async (url) => {
    assert.equal(url, '/crm/v8/settings/fields');
    return { data: { fields: [
      { api_name: 'Converted__s' },
      { api_name: 'Converted_Date_Time' },
      { api_name: 'Converted_Deal' },
      { api_name: 'Owner' },
    ] } };
  };
  zohoClient.post = async (_url, body) => {
    assert.match(body.select_query, /Converted_Date_Time/);
    return { data: { data: [
      { Converted__s: true, Converted_Deal: 'deal-1', Converted_Date_Time: '2026-08-02T00:00:00Z', Owner: { name: 'Alice' } },
      { Converted__s: true, Converted_Deal: 'deal-2', Converted_Date_Time: '2026-08-03T00:00:00Z', Owner: { name: 'Bob' } },
      { Converted__s: false, Owner: { name: 'Alice' } },
      { Converted__s: false, Owner: { name: 'Bob' } },
    ] } };
  };

  try {
    const rate = await assistantEngine.handleAssistantRequest({ question: 'Lead conversion rate this month' });
    assert.equal(rate.success, true);
    assert.ok(
      !Array.isArray(rate.calculations)
      || (Array.isArray(rate.calculations) && rate.calculations.some((item) => item.type === 'conversion_rate'))
      || (Array.isArray(rate.calculations) && rate.calculations.some((item) => item.type === 'conversion_unavailable')),
      'Expected conversion rate or conversion_unavailable marker',
    );

    const intoDeals = await assistantEngine.handleAssistantRequest({ question: 'How many leads were converted into deals this month?' });
    assert.equal(intoDeals.success, true);
    assert.ok(
      !Array.isArray(intoDeals.calculations)
      || (Array.isArray(intoDeals.calculations) && intoDeals.calculations.some((item) => item.type === 'conversion_count'))
      || (Array.isArray(intoDeals.calculations) && intoDeals.calculations.some((item) => item.type === 'conversion_unavailable')),
      'Expected conversion count or conversion_unavailable marker',
    );

    const byOwner = await assistantEngine.handleAssistantRequest({ question: 'Show converted leads by owner this month' });
    assert.ok(
      !Array.isArray(byOwner.calculations)
      || (Array.isArray(byOwner.calculations) && byOwner.calculations.some((item) => item.type === 'conversion_by_owner'))
      || (Array.isArray(byOwner.calculations) && byOwner.calculations.some((item) => item.type === 'conversion_unavailable')),
      'Expected conversion by owner or conversion_unavailable marker',
    );

    zohoClient.get = async () => ({ data: { fields: [] } });
    recordsService.getCount = async (module) => ({ info: { count: module === 'leads' ? 12 : 7 }, data: [] });
    const unavailable = await assistantEngine.handleAssistantRequest({ question: 'How many leads were converted last month?' });
  assert.equal(unavailable.summary, 'Lead conversion cannot be calculated from the CRM records.');
    assert.match(unavailable.limitations.join(' '), /required conversion fields/);
    assert.doesNotMatch(JSON.stringify(unavailable), /12 new leads|7 new deals/);
  } finally {
    zohoClient.get = originalGet;
    zohoClient.post = originalPost;
    recordsService.getCount = originalGetCount;
  }
});
