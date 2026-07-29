const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SESSION_EVENT_ACK_VERSION,
  MONITOR_OUTPUT_ACK_VERSION,
  supportsSessionEventAcknowledgement,
  supportsMonitorOutputAcknowledgement,
} = require("../dist/protocol");

test("legacy boolean does not enable tracked session-event delivery", () => {
  assert.equal(
    supportsSessionEventAcknowledgement({ sessionEventAck: true }),
    false,
  );
});

test("Monitor output acknowledgement requires the cumulative-card protocol", () => {
  assert.equal(MONITOR_OUTPUT_ACK_VERSION, 2);
  assert.equal(
    supportsMonitorOutputAcknowledgement({ sessionEventAckVersion: 1 }),
    false,
  );
  assert.equal(
    supportsMonitorOutputAcknowledgement({ sessionEventAckVersion: 2 }),
    true,
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
