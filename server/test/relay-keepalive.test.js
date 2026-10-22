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
  const watchdog = new PingKeepalive(socket, 30_000, () => { state.dead = true; });
  watchdog.start();
  t.after(() => watchdog.stop());
  return { socket, state, watchdog, clock, advance };
}

test("an unanswered ping on schedule ends the connection", (t) => {
  const { socket, state, advance } = keepalive(t);
  advance(30_000);
  assert.equal(socket.pings, 1);
  advance(30_000);
  assert.equal(state.dead, true);
});

test("a pong keeps the connection", (t) => {
  const { socket, state, watchdog, advance } = keepalive(t);
  advance(30_000);
  watchdog.pong();
  advance(30_000);
  assert.equal(state.dead, false);
  assert.equal(socket.pings, 2);
});

test("a tick delayed by an event-loop stall pings again instead of judging", (t) => {
  const { socket, state, clock, advance } = keepalive(t);
  advance(30_000);
  // The loop was blocked for 40 s: the pong may be waiting unread behind this timer.
  clock.now += 40_000;
  advance(30_000);
  assert.equal(state.dead, false);
  assert.equal(socket.pings, 2);
});
