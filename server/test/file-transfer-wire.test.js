const assert = require("node:assert/strict");
const test = require("node:test");

const {
  BINARY_FILE_DOWNLOAD_VERSION,
  BIN_MARKER_FILE_DOWNLOAD_CHUNK,
  encodeBinaryFileDownloadChunk,
  fileTransferPeerId,
  fileTransferVersion,
  resolveFileResumeOffset,
  supportsBinaryFileDownload,
} = require("../dist/file-transfer-wire");
const {
  decryptBinary,
  encryptBinary,
  generateKeyPair,
} = require("../dist/relay-crypto");

test("encodes raw file bytes in a versioned binary download frame", () => {
  const raw = Buffer.from([0x00, 0x7f, 0x80, 0xff]);
  const frame = encodeBinaryFileDownloadChunk({
    fileId: "file-123",
    transferToken: "token-456",
    offsetBytes: 5_000_000_000,
    fileSize: 9_000_000_000,
    chunkIndex: 12,
    totalChunks: 42,
  }, raw);

  let offset = 0;
  assert.equal(frame[offset++], BIN_MARKER_FILE_DOWNLOAD_CHUNK);
  const fileIdLength = frame.readUInt16BE(offset);
  offset += 2;
  assert.equal(frame.subarray(offset, offset + fileIdLength).toString(), "file-123");
  offset += fileIdLength;
  const tokenLength = frame.readUInt16BE(offset);
  offset += 2;
  assert.equal(frame.subarray(offset, offset + tokenLength).toString(), "token-456");
  offset += tokenLength;
  assert.equal(Number(frame.readBigUInt64BE(offset)), 5_000_000_000);
  offset += 8;
  assert.equal(Number(frame.readBigUInt64BE(offset)), 9_000_000_000);
  offset += 8;
  assert.equal(frame.readUInt32BE(offset), 12);
  offset += 4;
  assert.equal(frame.readUInt32BE(offset), 42);
  offset += 4;
  assert.deepEqual(frame.subarray(offset), raw);
});

test("binary file downloads require the explicit versioned capability", () => {
  assert.equal(supportsBinaryFileDownload({ binaryFileDownloadVersion: BINARY_FILE_DOWNLOAD_VERSION }), true);
  assert.equal(supportsBinaryFileDownload({ binaryEnvelope: true }), false);
  assert.equal(supportsBinaryFileDownload({ binaryFileDownloadVersion: 0 }), false);
});

test("file-manager transfers retain their originating relay peer", () => {
  const message = { type: "file_manager_download" };
  Object.defineProperty(message, "__relayPeerId", {
    value: "phone-peer-1",
    enumerable: false,
  });

  assert.equal(fileTransferPeerId(message), "phone-peer-1");
  assert.equal(fileTransferPeerId({ type: "file_manager_download" }), undefined);
});

test("raw download frames remain opaque inside the existing NaCl envelope", () => {
  const server = generateKeyPair();
  const phone = generateKeyPair();
  const frame = encodeBinaryFileDownloadChunk({
    fileId: "encrypted-file",
    transferToken: "encrypted-token",
    offsetBytes: 0,
    fileSize: 3,
    chunkIndex: 0,
    totalChunks: 1,
  }, Buffer.from([1, 2, 3]));

  const ciphertext = encryptBinary(frame, phone.publicKey, server.secretKey);
  assert.equal(ciphertext.includes(Buffer.from("encrypted-file")), false);
  assert.deepEqual(
    Buffer.from(decryptBinary(ciphertext, server.publicKey, phone.secretKey)),
    frame,
  );
});

test("resumes only when the client identifies the same file version", () => {
  const version = fileTransferVersion({
    size: 1000,
    mtimeMs: 1234.5,
    ctimeMs: 1200,
    ino: 42,
  });
  assert.equal(resolveFileResumeOffset({
    requestedOffset: 400,
    fileSize: 1000,
    expectedFileVersion: version,
    actualFileVersion: version,
  }), 400);
  assert.equal(resolveFileResumeOffset({
    requestedOffset: 400,
    fileSize: 1000,
    actualFileVersion: version,
  }), 0);
  assert.equal(resolveFileResumeOffset({
    requestedOffset: 400,
    fileSize: 1000,
    expectedFileVersion: `${version}-stale`,
    actualFileVersion: version,
  }), 0);
});
