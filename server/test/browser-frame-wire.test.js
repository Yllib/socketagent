const assert = require("node:assert/strict");
const test = require("node:test");
const { encodeBinaryBrowserFrame, supportsBinaryBrowserFrames } = require("#server/browser-frame-wire");

test("a binary browser frame carries the JPEG bytes behind a JSON header", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const encoded = encodeBinaryBrowserFrame({
    profile: "input-test",
    imageBase64: jpeg.toString("base64"),
    mimeType: "image/jpeg",
    width: 430,
    height: 860,
    url: "https://example.test/",
    title: "Example",
    seq: 12,
  });
  assert.equal(encoded[0], 0x56);
  const headerLength = encoded.readUInt32BE(1);
  /** @type {unknown} */
  const header = JSON.parse(encoded.subarray(5, 5 + headerLength).toString("utf8"));
  assert.deepEqual(header, {
    type: "browser_frame",
    profile: "input-test",
    mimeType: "image/jpeg",
    width: 430,
    height: 860,
    url: "https://example.test/",
    title: "Example",
    seq: 12,
  });
  assert.deepEqual(encoded.subarray(5 + headerLength), jpeg);
});

test("only apps that announce binary frames get them", () => {
  assert.equal(supportsBinaryBrowserFrames({ type: "client_capabilities", binaryBrowserFrameVersion: 1 }), true);
  assert.equal(supportsBinaryBrowserFrames({ type: "client_capabilities", binaryFileDownloadVersion: 1 }), false);
});
