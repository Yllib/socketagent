const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { readFileSync } = require("node:fs");
const {z} = require("zod");
const echoSchema = z.object({method:z.string(),params:z.record(z.string(),z.unknown())});
const test = require("node:test");

const {
  CodexAppServerClient,
  CodexAppServerRequestTimeoutError,
  CodexAppServerProtocolError,
} = require("#server/codex-app-server-client");
const { isTimedOutCodexThreadResume } = require("#server/codex-session");

const echoServer = String.raw`
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    process.stdout.write(JSON.stringify({
      id: request.id,
      result: { method: request.method, params: request.params },
    }) + "\n");
  }
});
`;

/** @param {import("node:events").EventEmitter} emitter @param {string} name @returns {Promise<unknown>} */
function waitForEvent(emitter, name) {
  return Promise.race([
    new Promise((resolve) => emitter.once(name, resolve)),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`Timed out waiting for ${name}`)),
      3000,
    )),
  ]);
}

// Native Codex sandboxes start a new session/process group. Include a grandchild
// and ignore SIGTERM so both ownership discovery and forced cleanup are exercised.
const stubbornWorker = `
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
process.stdout.write("ready\\n");
`;
const detachedSupervisor = `
const { spawn } = require("node:child_process");
process.on("SIGTERM", () => {});
const worker = spawn(process.execPath, ["-e", ${JSON.stringify(stubbornWorker)}]);
worker.stdout.once("data", () => process.stdout.write(JSON.stringify({
  child: process.pid, grandchild: worker.pid,
}) + "\\n"));
`;
const detachedTreeServer = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(detachedSupervisor)}], {
  detached: true, stdio: ["ignore", "pipe", "ignore"],
});
child.stdout.once("data", data => process.stdout.write(JSON.stringify({
  method: "test/processes", params: {root: process.pid, ...JSON.parse(data)},
}) + "\\n"));
process.on("SIGTERM", () => process.exit(0));
process.stdin.resume();
`;

/** @param {number} pid */
function processIsLive(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !/^[ZX]/.test(stat.slice(stat.lastIndexOf(")") + 2));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function startDetachedTree() {
  const client = new CodexAppServerClient({
    cwd: process.cwd(), command: process.execPath, args: ["-e", detachedTreeServer],
  });
  const ready = waitForEvent(client, "test/processes");
  client.start();
  const pids = z.object({ root: z.number(), child: z.number(), grandchild: z.number() }).parse(await ready);
  return { client, pids };
}

for (const signal of ["SIGKILL", "SIGTERM"]) {
  test(`stop ${signal} waits for detached sandbox descendants and leaves other processes alone`, {
    skip: process.platform !== "linux",
  }, async () => {
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const { client, pids } = await startDetachedTree();
    try {
      assert.ok(Object.values(pids).every(processIsLive));
      await client.stop(signal === "SIGKILL" ? "SIGKILL" : "SIGTERM", 75, true);
      assert.deepEqual(Object.values(pids).filter(processIsLive), []);
      assert.ok(unrelated.pid && processIsLive(unrelated.pid));
    } finally {
      unrelated.kill("SIGKILL");
      await client.stop("SIGKILL", 75, true);
    }
  });
}

test("a failed Stop retains descendant ownership after the app-server leader exits", {
  skip: process.platform !== "linux",
}, async (t) => {
  const { client, pids } = await startDetachedTree();
  const kill = process.kill.bind(process);
  const blocked = t.mock.method(process, "kill", /** @param {number} pid @param {NodeJS.Signals | number} signal */ (pid, signal) => {
    if (pid === pids.grandchild && signal === "SIGKILL") return true;
    return kill(pid, signal);
  });
  try {
    await assert.rejects(client.stop("SIGKILL", 25, true), /did not exit after SIGKILL/);
    assert.equal(processIsLive(pids.root), false);
    assert.equal(processIsLive(pids.grandchild), true);
    blocked.mock.restore();
    await client.stop("SIGKILL", 25, true);
    assert.equal(processIsLive(pids.grandchild), false);
  } finally {
    blocked.mock.restore();
    await client.stop("SIGKILL", 25, true);
  }
});

test("completes the app-server initialize handshake before other requests", async () => {
  const client = new CodexAppServerClient({
    cwd: process.cwd(),
    command: process.execPath,
    args: [path.join(__dirname, "fixtures", "mock-codex-app-server.js")],
  });

  try {
    const initialized = waitForEvent(client, "test/initialized_seen");
    await client.initialize({ clientInfo: { name: "socketagent" } });
    const event = z.object({methods:z.array(z.string())}).parse(await initialized);
    assert.deepEqual(event.methods, ["initialize", "initialized"]);

    const metadata = await client.updateThreadMetadata({
      threadId: "thread-1",
      gitInfo: { branch: "master", sha: "abc123" },
    });
    assert.deepEqual(metadata, {
      threadId: "thread-1",
      gitInfo: { branch: "master", sha: "abc123" },
    });
  } finally {
    await client.stop();
  }
});

test("thread resume excludes the native turn transcript by default", async () => {
  const client = new CodexAppServerClient({
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", echoServer],
    requestTimeoutMs: 1000,
  });
  try {
    const result = echoSchema.parse(await client.resumeThread({ threadId: "large-thread" }));
    assert.equal(result.method, "thread/resume");
    assert.equal(result.params.threadId, "large-thread");
    assert.equal(result.params.excludeTurns, true);

    const explicit = echoSchema.parse(await client.resumeThread({
      threadId: "history-client",
      excludeTurns: false,
    }));
    assert.equal(explicit.params.excludeTurns, false);

    const unsubscribe = echoSchema.parse(await client.unsubscribeThread("large-thread"));
    assert.equal(unsubscribe.method, "thread/unsubscribe");
    assert.equal(unsubscribe.params.threadId, "large-thread");
  } finally {
    await client.stop();
  }
});

test("sends stable client user message IDs on turns and steers", async () => {
  const client = new CodexAppServerClient({
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", echoServer],
    requestTimeoutMs: 1000,
  });
  try {
    const turn = echoSchema.parse(await client.startTurn({
      threadId: "thread-1",
      clientUserMessageId: "phone-message-1",
      input: [{ type: "text", text: "hello" }],
      model: "test-model",
    }));
    assert.equal(turn.params.clientUserMessageId, "phone-message-1");

    const steer = echoSchema.parse(await client.steerTurn({
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      clientUserMessageId: "phone-message-2",
      input: [{ type: "text", text: "more context" }],
    }));
    assert.equal(steer.params.clientUserMessageId, "phone-message-2");
  } finally {
    await client.stop();
  }
});

test("request timeouts retain the RPC method for poisoned-client cleanup", async () => {
  const client = new CodexAppServerClient({
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "process.stdin.resume()"],
    requestTimeoutMs: 20,
  });
  try {
    await assert.rejects(
      client.resumeThread({ threadId: "stuck-thread" }),
      (error) => {
        assert.ok(error instanceof CodexAppServerRequestTimeoutError);
        assert.equal(error.method, "thread/resume");
        assert.equal(error.timeoutMs, 20);
        assert.equal(isTimedOutCodexThreadResume(error), true);
        return true;
      },
    );
  } finally {
    await client.stop();
  }
});

test("non-resume timeouts do not trigger thread-writer cleanup", () => {
  const error = new CodexAppServerRequestTimeoutError("model/list", 20);
  assert.equal(isTimedOutCodexThreadResume(error), false);
});

test("large fragmented thread responses finish without starving the request deadline", async () => {
  const bytes = 32 * 1024 * 1024;
  const client = new CodexAppServerClient({
    cwd: process.cwd(), command: process.execPath,
    args: ["-e", String.raw`
      process.stdin.once('data', async chunk => {
        const {id} = JSON.parse(chunk.toString().trim());
        const response = JSON.stringify({id, result: {text: 'x'.repeat(32 * 1024 * 1024)}}) + '\n';
        for (let offset = 0; offset < response.length; offset += 16384) {
          if (!process.stdout.write(response.slice(offset, offset + 16384))) {
            await new Promise(resolve => process.stdout.once('drain', resolve));
          }
        }
      });
    `],
    requestTimeoutMs: 5000,
  });
  try {
    const result = z.object({text:z.string()}).parse(await client.readThread({threadId: 'large', includeTurns: true}));
    assert.equal(result.text.length, bytes);
    assert.equal(result.text.at(-1), 'x');
  } finally { await client.stop(); }
});

test("JSONL framing preserves split lines, multiple messages, and malformed-line recovery", () => {
  const client = new CodexAppServerClient({cwd: process.cwd()});
  /** @type {{method:string,params?:Record<string,unknown>}[]} */
  const seen = [];
  let malformed = 0;
  client.on('notification', (/** @type {unknown} */ item) => seen.push(z.object({method:z.string(),params:z.record(z.string(),z.unknown()).optional()}).parse(item)));
  client.on('malformed', () => malformed++);
  client.handleStdout('{"method":"first","params":{"text":"');
  client.handleStdout('hello"}}\n\ninvalid\n{"method":"second",');
  client.handleStdout('"params":{"text":"世界"}}\n{"method":"third"}\n');
  assert.deepEqual(seen.map(item => item.method), ['first', 'second', 'third']);
  assert.equal(seen[0].params.text, 'hello');
  assert.equal(seen[1].params.text, '世界');
  assert.equal(malformed, 1);
});

test('paginated rewind sends an exclusive turn boundary and paginated verification', async () => {
 const client=new CodexAppServerClient({cwd:process.cwd(),command:process.execPath,args:['-e',echoServer]});
 try{
  const revert=await client.revertThread('thread','turn');
  assert.deepEqual(revert,{method:'thread/revert',params:{threadId:'thread',beforeTurnId:'turn'}});
  const page=echoSchema.parse(await client.listThreadTurns({threadId:'thread',cursor:'next',limit:100,sortDirection:'asc',itemsView:'notLoaded'}));
  assert.equal(page.method,'thread/turns/list');assert.equal(page.params.cursor,'next');assert.equal(page.params.itemsView,'notLoaded');
 }finally{await client.stop();}
});

function removedRollback() {
  return new CodexAppServerProtocolError('thread/rollback', {
    code: -32600, message: 'Invalid request: unknown variant `thread/rollback`, expected `thread/revert`',
  }, 'raw RPC error');
}

for (const mode of ['legacy', 'paginated']) {
  test(`removed rollback uses revert for ${mode} history and verifies the retained prefix`, async () => {
    const client = new CodexAppServerClient({cwd: process.cwd()});
    /** @type {[string,unknown][]} */
    const calls = [];
    let migrated = mode === 'paginated', reverted = false;
    client.migrateLegacyThread = async id => {calls.push(['migrate', id]); migrated = true;};
    client.request = async (method, params) => {
      calls.push([method, params]);
      if (method === 'thread/rollback') throw removedRollback();
      if (method === 'thread/read') return {thread: {
        historyMode: migrated ? 'paginated' : 'legacy',
        turns: (reverted ? ['one'] : ['one', 'two', 'three']).map(id => ({id})),
      }};
      if (method === 'thread/resume') return {};
      if (method === 'thread/revert') {
        assert.deepEqual(params, {threadId: 'target', beforeTurnId: 'two'});
        assert.equal(migrated, true); reverted = true; return {};
      }
      assert.fail(method);
    };
    const result = z.object({thread:z.object({turns:z.array(z.object({id:z.string()}))})}).parse(await client.rollbackThread('target', 2));
    assert.deepEqual(result.thread.turns, [{id: 'one'}]);
    assert.equal(calls.filter(([method]) => method === 'migrate').length, mode === 'legacy' ? 1 : 0);
  });
}

test('rollback never retries an ambiguous failure or an unrelated invalid request', async () => {
  for (const failure of [new CodexAppServerRequestTimeoutError('thread/rollback', 100),
    new Error('transport closed'), new CodexAppServerProtocolError('thread/rollback',
      {code: -32600, message: 'thread is busy'}, 'busy')]) {
    const client = new CodexAppServerClient({cwd: process.cwd()});
    let calls = 0;
    client.request = async method => {calls++; assert.equal(method, 'thread/rollback'); throw failure;};
    await assert.rejects(client.rollbackThread('target', 1), error => error === failure);
    assert.equal(calls, 1);
  }
});

test('migration failure or changed turn IDs never calls revert', async () => {
  for (const failure of [true, false]) {
    const client = new CodexAppServerClient({cwd: process.cwd()});
    let migrated = false;
    client.migrateLegacyThread = async () => {
      if (failure) throw new Error('another writer');
      migrated = true;
    };
    client.request = async method => {
      if (method === 'thread/rollback') throw removedRollback();
      if (method === 'thread/read') return {thread: {
        historyMode: migrated ? 'paginated' : 'legacy', turns: [{id: migrated ? 'changed' : 'one'}],
      }};
      if (method === 'thread/resume') return {};
      assert.fail(`Must not mutate after failed preparation: ${method}`);
    };
    await assert.rejects(client.rollbackThread('target', 1), failure ? /another writer/ : /history changed/);
  }
});

test('rewind fallback rejects active threads and out-of-range counts', async () => {
  for (const active of [true, false]) {
    const client = new CodexAppServerClient({cwd: process.cwd()});
    client.request = async method => {
      if (method === 'thread/rollback') throw removedRollback();
      if (method === 'thread/read') return {thread: {status: {type: active ? 'active' : 'idle'}, turns: [{id:'one'}]}};
      assert.fail(method);
    };
    await assert.rejects(client.rollbackThread('target', 2), active ? /Stop the running/ : /exceeds/);
  }
});
