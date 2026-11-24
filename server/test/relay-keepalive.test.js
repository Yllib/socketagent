const assert = require("node:assert/strict");
const test = require("node:test");
const WebSocket = require("ws");
const { PingKeepalive } = require("#server/relay-client");

/**
 * Timers and the wall clock move separately here: `advance` moves both, as
 * an idle loop would; moving only `clock.now` models a loop that was blocked.
 * @param {import("node:test").TestContext} t
 */
function keepalive(t) {
  const clock = { now: 1_000_000 };
  t.mock.method(Date, "now", () => clock.now);
  t.mock.timers.enable({ apis: ["setInterval", "setImmediate"] });
  /** @param {number} ms */
  const advance = (ms) => {
    clock.now += ms;
    t.mock.timers.tick(ms);
  };
  const socket = { readyState: WebSocket.OPEN, pings: 0, ping() { this.pings++; } };
  const state = { dead: false };
  const watchdog = new PingKeepalive(socket, 15_000, 60_000, () => { state.dead = true; });
  watchdog.start();
  t.after(() => watchdog.stop());
  return { socket, state, watchdog, clock, advance };
}

test("a minute with nothing from the relay ends the connection", (t) => {
  const { state, advance } = keepalive(t);
  for (let i = 0; i < 4; i++) advance(15_000);
  assert.equal(state.dead, false);
  advance(15_000);
  assert.equal(state.dead, true);
});

test("late pongs or ordinary messages keep the connection", (t) => {
  const { socket, state, watchdog, advance } = keepalive(t);
  for (let i = 0; i < 12; i++) {
    advance(15_000);
    // One frame every 45 s: most pings go unanswered within their interval.
    if (i % 3 === 2) watchdog.heard();
  }
  assert.equal(state.dead, false);
  assert.equal(socket.pings, 12);
});

test("a tick delayed by an event-loop stall restarts the count instead of judging", (t) => {
  const { socket, state, clock, advance } = keepalive(t);
  for (let i = 0; i < 3; i++) advance(15_000);
  // The loop was blocked for 40 s: a pong may be waiting unread behind this timer.
  clock.now += 40_000;
  advance(15_000);
  assert.equal(state.dead, false);
  assert.equal(socket.pings, 4);
  for (let i = 0; i < 4; i++) advance(15_000);
  assert.equal(state.dead, false);
  advance(15_000);
  assert.equal(state.dead, true);
});
