const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
require("./test-data-dir");
const { CodexRealtimeBridge, parseRealtimeVoices } = require("#server/codex-realtime");
const { parseServerMessage } = require("#server/server-message");

const THREAD = "thread-1";

function fixture() {
  const client = new EventEmitter();
  /** @type {Array<{ method: string; params: unknown }>} */
  const requests = [];
  /** @type {import("#server/protocol").ServerMessage[]} */
  const sent = [];
  /** @type {Array<[string, string]>} */
  const recorded = [];
  let closedCalls = 0;
  const bridge = new CodexRealtimeBridge({
    client: Object.assign(client, {
      request: async (/** @type {string} */ method, /** @type {unknown} */ params) => {
        requests.push({ method, params });
        return {};
      },
    }),
    threadId: THREAD,
    sessionId: "session-1",
    send: (message) => sent.push(parseServerMessage(JSON.parse(JSON.stringify(message)))),
    recordTranscript: (role, text) => recorded.push([role, text]),
    onClosed: () => { closedCalls += 1; },
  });
  /** @param {string} method @param {unknown} params */
  const notify = (method, params) => client.emit("notification", { method, params });
  const events = () => sent.flatMap((message) => message.type === "codex_realtime_event" ? [message.event] : []);
  return { bridge, client, requests, sent, recorded, notify, events, closed: () => closedCalls };
}

test("start sends the phone's offer over the WebRTC transport on protocol v3", async () => {
  const { bridge, requests, notify, events } = fixture();
  await bridge.start({ sdp: "v=0\r\noffer", voice: "cove" });
  assert.deepEqual(requests, [{
    method: "thread/realtime/start",
    params: {
      threadId: THREAD, transport: { type: "webrtc", sdp: "v=0\r\noffer" }, outputModality: "audio",
      version: "v3", flushTranscriptTailOnSessionEnd: true, voice: "cove",
    },
  }]);
  assert.equal(bridge.isActive, true);
  notify("thread/realtime/started", { threadId: THREAD, realtimeSessionId: "rt-1", version: "v3" });
  notify("thread/realtime/sdp", { threadId: THREAD, sdp: "v=0\r\nanswer" });
  assert.deepEqual(events(), [
    { kind: "started", realtimeSessionId: "rt-1", version: "v3" },
    { kind: "answer", sdp: "v=0\r\nanswer" },
  ]);
});

test("item-scoped transcripts stream with their role and persist when complete", async () => {
  const { bridge, notify, events, recorded } = fixture();
  await bridge.start({ sdp: "offer" });
  notify("thread/realtime/item/started", { threadId: THREAD, item: { id: "i1", realtimeSessionId: "rt", type: "transcriptSegment", role: "user", text: "" } });
  notify("thread/realtime/item/transcript/delta", { threadId: THREAD, itemId: "i1", delta: "fix the " });
  notify("thread/realtime/item/transcript/delta", { threadId: THREAD, itemId: "i1", delta: "build" });
  notify("thread/realtime/item/completed", { threadId: THREAD, item: { id: "i1", realtimeSessionId: "rt", type: "transcriptSegment", role: "user", text: "fix the build" } });
  // A delta for a thread we are not attached to must not leak in.
  notify("thread/realtime/transcript/delta", { threadId: "other", role: "assistant", delta: "nope" });
  notify("thread/realtime/transcript/delta", { threadId: THREAD, role: "assistant", delta: "On it." });
  notify("thread/realtime/transcript/done", { threadId: THREAD, role: "assistant", text: "On it." });
  assert.deepEqual(events(), [
    { kind: "transcript_delta", role: "user", delta: "", itemId: "i1" },
    { kind: "transcript_delta", role: "user", delta: "fix the ", itemId: "i1" },
    { kind: "transcript_delta", role: "user", delta: "build", itemId: "i1" },
    { kind: "transcript_done", role: "user", text: "fix the build", itemId: "i1" },
    { kind: "transcript_delta", role: "assistant", delta: "On it." },
    { kind: "transcript_done", role: "assistant", text: "On it." },
  ]);
  assert.deepEqual(recorded, [["user", "fix the build"]]);
});

test("stop tells Codex, reports closed once and detaches from the client", async () => {
  const { bridge, client, requests, notify, events, closed } = fixture();
  await bridge.start({ sdp: "offer" });
  await bridge.stop();
  notify("thread/realtime/closed", { threadId: THREAD, reason: "requested" });
  assert.equal(requests.at(-1)?.method, "thread/realtime/stop");
  assert.equal(bridge.isActive, false);
  assert.deepEqual(events().filter((event) => event.kind === "closed"), [{ kind: "closed", reason: "requested" }]);
  assert.equal(closed(), 1);
  assert.equal(client.listenerCount("notification"), 0);
  await assert.rejects(bridge.appendText("hello"), /No realtime session/);
});

test("a failed start surfaces the error and closes the session", async () => {
  const { bridge, client, sent, closed } = fixture();
  client.request = async () => { throw new Error("realtime conversation requires API key auth"); };
  await assert.rejects(bridge.start({ sdp: "offer" }), /API key auth/);
  assert.equal(bridge.isActive, false);
  assert.deepEqual(sent.map((message) => message.type === "codex_realtime_event" ? message.event : null), [
    { kind: "closed", reason: "realtime conversation requires API key auth" },
  ]);
  assert.equal(closed(), 1);
});

test("Codex ending the call or exiting closes the bridge without a stop request", async () => {
  const { bridge, client, requests, notify, events } = fixture();
  await bridge.start({ sdp: "offer" });
  notify("thread/realtime/error", { threadId: THREAD, message: "transport lost" });
  notify("thread/realtime/item/completed", { threadId: THREAD, item: { id: "c1", realtimeSessionId: "rt", type: "realtimeSessionClosed", outcome: "failed" } });
  client.emit("exit", 1, null);
  assert.equal(bridge.isActive, false);
  assert.deepEqual(events(), [
    { kind: "error", message: "transport lost" },
    { kind: "closed", reason: "ended" },
  ]);
  assert.equal(requests.length, 1);
});

test("typed input goes to Codex as a user message", async () => {
  const { bridge, requests } = fixture();
  await bridge.start({ sdp: "offer" });
  await bridge.appendText("  open the settings screen ");
  assert.deepEqual(requests.at(-1), {
    method: "thread/realtime/appendText",
    params: { threadId: THREAD, text: "open the settings screen", role: "user" },
  });
});

test("voice lists expose the frameless (v1) voices and their default", () => {
  assert.deepEqual(parseRealtimeVoices({
    voices: { v1: ["cove", "juniper"], v2: ["marin"], defaultV1: "cove", defaultV2: "marin" },
  }), { voices: ["cove", "juniper"], defaultVoice: "cove" });
  assert.throws(() => parseRealtimeVoices({ voices: {} }), /invalid realtime voice list/);
});
