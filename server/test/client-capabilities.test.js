const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SESSION_EVENT_ACK_VERSION,
  supportsSessionEventAcknowledgement,
} = require("../dist/protocol");

test("legacy boolean does not enable tracked session-event delivery", () => {
  assert.equal(
    supportsSessionEventAcknowledgement({ sessionEventAck: true }),
    false,
  );
});

test("versioned capability enables tracked session-event delivery", () => {
  assert.equal(SESSION_EVENT_ACK_VERSION, 1);
  assert.equal(
    supportsSessionEventAcknowledgement({ sessionEventAckVersion: 1 }),
    true,
  );
});

test("invalid acknowledgement versions fail closed", () => {
  assert.equal(
    supportsSessionEventAcknowledgement({ sessionEventAckVersion: "1" }),
    false,
  );
  assert.equal(
    supportsSessionEventAcknowledgement({ sessionEventAckVersion: 0 }),
    false,
  );
});
