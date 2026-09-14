const assert = require('node:assert/strict'), test = require('node:test'), crypto = require('node:crypto');
require('./test-data-dir');
const { CodexSession } = require('../dist/codex-session');
const { getHistory } = require('../dist/session-store');
const { codexAppServerThreadToHistory } = require('../dist/codex-native-history');
const sessions = [];
test.afterEach(() => { for (const s of sessions.splice(0)) {
    clearTimeout(s.appServerIdleStopTimer);
    clearTimeout(s.pendingAppServerTurnCompletion);
} });
function fixture() {
    const sent = [];
    const s = new CodexSession({ readyState: 1, send: v => sent.push(JSON.parse(v)) }, '/tmp');
    sessions.push(s);
    s.sessionId = s.threadId = `native-${crypto.randomUUID()}`;
    const emit = (m, p) => s.handleAppServerNotification(m, p);
    const activity = (kind, id = 'child', method = 'item/completed') => emit(method, { threadId: s.threadId, item: { type: 'subAgentActivity', id: `item-${kind}`, kind, agentThreadId: id, agentPath: `/root/${id}` } });
    const start = id => emit('turn/started', { threadId: 'child', turn: { id } });
    const finish = (id, status = 'completed') => emit('turn/completed', { threadId: 'child', turn: { id, status, error: status === 'failed' ? { message: 'child failure' } : undefined } });
    return { s, sent, emit, activity, start, finish };
}
test('native completion settles card once; duplicate spawn cannot resurrect it', () => {
    const f = fixture();
    f.activity('started', 'child', 'item/started');
    assert.equal(f.sent.length, 0);
    f.activity('started');
    assert.equal(f.s.isBusy, true);
    f.activity('completed');
    f.activity('completed');
    f.activity('started');
    assert.equal(f.s.isBusy, false);
    assert.equal(f.sent.filter(m => m.type === 'subagent_result').length, 1);
    assert.equal(f.sent.filter(m => m.type === 'active_subagents').at(-1).tasks[0].status, 'completed');
});
test('recorded lifecycle: communication does not restart a completed child', () => {
    const f = fixture();
    f.activity('started');
    f.start('t1');
    f.finish('t1');
    f.activity('interacted');
    f.activity('interacted', 'unknown');
    assert.equal(f.s.codexSubagents.size, 1);
    assert.equal(f.s.isBusy, false);
    f.start('t2');
    f.finish('t1');
    f.activity('completed');
    assert.equal(f.s.isBusy, true);
    f.finish('t2');
    f.start('t1');
    assert.equal(f.s.isBusy, false);
});
for (const [status, expected] of [['failed', 'errored'], ['interrupted', 'interrupted']])
    test(`${status} survives idle, native completion, history and replay`, () => {
        const f = fixture();
        f.start('t1');
        f.emit('thread/status/changed', { threadId: 'child', status: { type: 'idle' } });
        f.finish('t1', status);
        f.activity('completed');
        f.emit('thread/status/changed', { threadId: 'child', status: { type: 'notLoaded' } });
        f.emit('thread/status/changed', { threadId: 'child', status: { type: 'idle' } });
        assert.equal(f.sent.find(m => m.type === 'subagent_result').subagentStatus, expected);
        assert.equal(getHistory(f.s.sessionId).filter(m => m.role === 'tool_result').at(-1).subagentStatus, expected);
        const replay = [];
        f.s.replayLiveState({ readyState: 1, send: v => replay.push(JSON.parse(v)) });
        assert.equal(replay.find(m => m.type === 'active_subagents').tasks[0].status, expected);
    });
test('reconnect reads missed terminal outcome without resuming a child', async () => {
    const f = fixture();
    f.start('t1');
    const reads = [];
    f.s.appServer = { readThread: async (p) => { reads.push(p); return { thread: { status: { type: 'idle' }, turns: [{ id: 't1', status: 'failed', error: { message: 'offline failure' } }] } }; } };
    f.s.replayLiveState();
    await f.s.subagentReconciliation;
    assert.deepEqual(reads.map(p => p.includeTurns), [false, true]);
    assert.equal(f.s.isBusy, false);
    assert.equal(f.s.codexSubagents.get('child').status, 'errored');
});
test('stale reconciliation cannot overwrite a newly started turn', async () => {
    const f = fixture();
    f.start('t1');
    let resolve;
    f.s.appServer = { readThread: () => new Promise(r => resolve = r) };
    const p = f.s.reconcileCodexSubagents();
    f.start('t2');
    resolve({ thread: { status: { type: 'idle' } } });
    await p;
    assert.equal(f.s.codexSubagents.get('child').activeTurnId, 't2');
    assert.equal(f.s.isBusy, true);
});
test('unloaded child is unavailable, not successful', async () => {
    const f = fixture();
    f.start('t1');
    f.s.appServer = { readThread: async () => ({ thread: { status: { type: 'notLoaded' } } }) };
    await f.s.reconcileCodexSubagents();
    assert.equal(f.s.isBusy, false);
    assert.equal(f.sent.find(m => m.type === 'subagent_result').subagentStatus, 'unavailable');
});
test('parent completion preserves genuinely running children', async () => {
    const f = fixture();
    f.start('child-turn');
    f.s._isRunning = true;
    f.s.appServer = { readThread: async () => ({ thread: { status: { type: 'active' } } }) };
    f.emit('turn/completed', { threadId: f.s.threadId, turn: { id: 'parent-turn', status: 'completed' } });
    await new Promise(r => setTimeout(r, 550));
    await f.s.subagentReconciliation;
    assert.equal(f.s._isRunning, false);
    assert.equal(f.s.isBusy, true);
});
test('native history reconstructs one Agent card with terminal failure', () => {
    const rows = codexAppServerThreadToHistory({ id: 'root', turns: [{ id: 't', items: [
                    { type: 'subAgentActivity', id: 'spawn', kind: 'started', agentThreadId: 'child', agentPath: '/root/auditor' },
                    { type: 'collabAgentToolCall', id: 'wait', tool: 'wait', agentsStates: { child: { status: 'errored', message: 'failure details' } } },
                    { type: 'subAgentActivity', id: 'end', kind: 'completed', agentThreadId: 'child' },
                    { type: 'subAgentActivity', id: 'message', kind: 'interacted', agentThreadId: 'child' }
                ] }] });
    assert.equal(rows.filter(r => r.role === 'tool_call').length, 1);
    assert.equal(rows[0].toolName, 'Agent');
    assert.equal(rows.at(-1).subagentStatus, 'errored');
    assert.equal(rows.at(-1).toolOutput, 'failure details');
});
