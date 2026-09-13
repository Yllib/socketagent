const assert = require('node:assert/strict');
const test = require('node:test');
const {CodexSession} = require('../dist/codex-session');
const {CodexAppServerClient} = require('../dist/codex-app-server-client');

test('account payload preserves real quota windows, reset credits, and unknown usage', async () => {
  const session = new CodexSession({readyState:1,send(){}}, '/tmp');
  session.ensureAppServer = async () => {};
  session.appServer = {
    readConfig: async () => ({config:{}}), readThread: async () => ({thread:{}}),
    readAccountRateLimits: async () => ({rateLimitsByLimitId:{codex:{limitId:'codex', primary:{usedPercent:35,windowDurationMins:10080},secondary:null}}, rateLimitResetCredits:{availableCount:2,credits:null}}),
    readAccountUsage: async () => ({summary:{lifetimeTokens:null, peakDailyTokens:123, currentStreakDays:null},dailyUsageBuckets:null}),
  };
  const {payload} = await session.buildStatusResult('thread');
  assert.equal(payload.limits[0].primary.windowDurationMins,10080);
  assert.equal(payload.limits[0].secondary,null);
  assert.equal(payload.resetCredits.availableCount,2);
  assert.equal(payload.usage.todayTokens,null);
  assert.equal(payload.usage.lifetimeTokens,null);
  assert.equal(payload.usage.currentStreakDays,null);
});

test('reset RPC validates and preserves the same idempotency key on retry', async () => {
  const client = new CodexAppServerClient({cwd:'/tmp'});
  const sent=[];
  client.request=async (method,params)=>{sent.push({method,params});return {outcome:'alreadyRedeemed'}};
  await assert.rejects(client.consumeAccountRateLimitReset(' '),/attempt ID/);
  await client.consumeAccountRateLimitReset('attempt-one');
  await client.consumeAccountRateLimitReset('attempt-one');
  assert.deepEqual(sent,[1,2].map(()=>({method:'account/rateLimitResetCredit/consume',params:{idempotencyKey:'attempt-one'}})));
});

test('delayed daily reporting exposes a dated total without inventing today usage', () => {
  const session = new CodexSession({readyState:1,send(){}}, '/tmp');
  session.localDateKey = () => '2026-09-06';
  const value = {summary: {}, dailyUsageBuckets: [
    {startDate:'2026-09-05',tokens:191653800},
    {startDate:'2026-09-03',tokens:454048476},
    {startDate:'2026-09-07',tokens:100},
    {startDate:'invalid',tokens:100},
  ]};
  const delayed = session.buildUsagePayload(value);
  assert.equal(delayed.todayTokens,null);
  assert.equal(delayed.latestUsageDate,'2026-09-05');
  assert.equal(delayed.latestDailyTokens,191653800);
  value.dailyUsageBuckets.push({startDate:'2026-09-06',tokens:0});
  const current = session.buildUsagePayload(value);
  assert.equal(current.todayTokens,0);
  assert.equal(current.latestUsageDate,'2026-09-06');
  assert.equal(current.latestDailyTokens,0);
  assert.equal(session.buildUsagePayload({summary:{},dailyUsageBuckets:null}).latestUsageDate,null);
});
