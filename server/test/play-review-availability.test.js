const assert = require('node:assert/strict');
const test = require('node:test');
const {CodexSession, getCodexAvailability} = require('../dist/codex-session');

test('review sessions need no provider executable and identify their simulated model', async () => {
  const previous = process.env.SOCKETAGENT_PLAY_REVIEW_MODE;
  process.env.SOCKETAGENT_PLAY_REVIEW_MODE = '1';
  try {
    assert.deepEqual(getCodexAvailability(), {available: true});
    const messages = [];
    const session = new CodexSession({readyState: 1, send: s => messages.push(JSON.parse(s))}, '/tmp');
    session.ensureAppServer = async () => { throw new Error('Review mode must not start a provider'); };
    await session.refreshSupportedModels();
    const catalog = messages.find(m => m.type === 'supported_models');
    assert.equal(catalog.models[0].value, 'play-review-demo');
    assert.match(catalog.models[0].description, /No live AI/);
    assert.deepEqual(await session.listCodexCollaborationModes(), [{id: 'default', name: 'Review demo'}]);
  } finally {
    if (previous === undefined) delete process.env.SOCKETAGENT_PLAY_REVIEW_MODE;
    else process.env.SOCKETAGENT_PLAY_REVIEW_MODE = previous;
  }
});
