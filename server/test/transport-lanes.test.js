const test = require("node:test");
const assert = require("node:assert/strict");

const {
  BULK_RELAY_PAIRING_SUFFIX,
  TRANSPORT_LANE_VERSION,
  UPLOAD_ACK_VERSION,
} = require("../dist/protocol");

test("transport lane and upload acknowledgement capabilities are versioned", () => {
  assert.equal(TRANSPORT_LANE_VERSION, 1);
  assert.equal(UPLOAD_ACK_VERSION, 1);
  assert.equal(BULK_RELAY_PAIRING_SUFFIX, ":bulk:v1");
});
