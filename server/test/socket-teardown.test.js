const assert = require("node:assert/strict");
const test = require("node:test");

const { CLOSE_GRACE_MS, closeThenDestroy } = require("#server/socket-teardown");

// How the computer closes a direct socket from its side: a close frame, and
// the socket destroyed when the peer does not finish the closing handshake.

/** A socket that records what is done to it and closes only when told to. */
function fakeSocket() {
  /** @type {string[]} */
  const calls = [];
  /** @type {(() => void)[]} */
  const closeListeners = [];
  return {
    calls,
    close: (/** @type {number} */ code, /** @type {string} */ reason) => { calls.push(`close ${code} ${reason}`); },
    terminate: () => { calls.push("terminate"); },
    once: (/** @type {"close"} */ _event, /** @type {() => void} */ listener) => { closeListeners.push(listener); },
    /** The peer finished the closing handshake. */
    peerClosed: () => { for (const listener of closeListeners.splice(0)) listener(); },
  };
}

test("a peer that does not answer the close frame is cut off after the grace time", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const socket = fakeSocket();
  closeThenDestroy(socket, 1008, "Removed");
  assert.deepEqual(socket.calls, ["close 1008 Removed"]);

  t.mock.timers.tick(CLOSE_GRACE_MS - 1);
  assert.deepEqual(socket.calls, ["close 1008 Removed"]);
  t.mock.timers.tick(1);
  assert.deepEqual(socket.calls, ["close 1008 Removed", "terminate"]);
});

test("a peer that answers the close frame is not cut off", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const socket = fakeSocket();
  closeThenDestroy(socket, 1000, "Pairing granted");
  socket.peerClosed();
  t.mock.timers.tick(CLOSE_GRACE_MS);
  assert.deepEqual(socket.calls, ["close 1000 Pairing granted"]);
});
