const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const dataDir = require("./test-data-dir");

// An empty sessions.json made every start throw, so the server crash-looped.
// Written before the store loads, as a power cut would leave it.
fs.writeFileSync(path.join(dataDir, "sessions.json"), "");

const { readStateFile, stateFileIssues, writeStateFile } = require("#server/state-file");
const { listSessions, saveSession, flushSessionStore } = require("#server/session-store");
const { DeviceRegistry } = require("#server/device-registry");
const { loadOrCreateKeyPair, toBase64 } = require("#server/relay-crypto");
const { RestartRecoveryStore } = require("#server/restart-recovery");
const { getComputerIssues } = require("#server/server-settings");
const { parseJsonObject: parseJson } = require("#server/value-guards");

let counter = 0;
function folder() {
  const dir = path.join(dataDir, `case-${++counter}`);
  fs.mkdirSync(dir);
  return dir;
}

/** @param {string} dir */
function leftovers(dir) {
  return fs.readdirSync(dir).filter((name) => name.includes(".damaged-"));
}


test("an empty sessions.json starts the server with an empty list and an error on the computer", () => {
  assert.deepEqual(listSessions(), []);
  const issue = getComputerIssues().find((candidate) => candidate.path === path.join(dataDir, "sessions.json"));
  assert.equal(issue?.severity, "error");
  assert.match(issue?.message ?? "", /the file is empty/);
  assert.equal(leftovers(dataDir).length, 1, "the damaged file is set aside");

  saveSession({ id: "s1", title: "First", cwd: process.cwd(), createdAt: "2026-11-24T10:00:00.000Z", lastActive: "2026-11-24T10:00:00.000Z", messagePreview: "" });
  flushSessionStore();
  assert.match(fs.readFileSync(path.join(dataDir, "sessions.json"), "utf8"), /"s1"/, "the next write starts a clean file");
});

test("each write keeps the version it replaced as .bak", () => {
  const file = path.join(folder(), "state.json");
  writeStateFile(file, '{"n":1}');
  writeStateFile(file, '{"n":2}');
  assert.equal(fs.readFileSync(file, "utf8"), '{"n":2}');
  assert.equal(fs.readFileSync(`${file}.bak`, "utf8"), '{"n":1}');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ["state.json", "state.json.bak"]);
});

for (const [kind, damage] of [["empty", ""], ["zero-filled", "\0".repeat(64)], ["truncated", '{"n":']]) {
  test(`a ${kind} file goes back to its backup and stays on the issues list`, () => {
    const dir = folder();
    const file = path.join(dir, "state.json");
    writeStateFile(file, '{"n":1}');
    writeStateFile(file, '{"n":2}');
    fs.writeFileSync(file, damage);

    assert.deepEqual(readStateFile(file, parseJson), { status: "ok", value: { n: 1 } });
    assert.equal(fs.readFileSync(file, "utf8"), '{"n":1}');
    assert.equal(leftovers(dir).length, 1);
    assert.equal(stateFileIssues().find((issue) => issue.file === file)?.severity, "warning");
  });
}

test("a file lost between the two renames of a write comes back from its backup", () => {
  const dir = folder();
  const file = path.join(dir, "state.json");
  writeStateFile(file, '{"n":1}');
  writeStateFile(file, '{"n":2}');
  fs.rmSync(file);
  assert.deepEqual(readStateFile(file, parseJson), { status: "ok", value: { n: 1 } });
  assert.equal(stateFileIssues().some((issue) => issue.file === file), false, "an interrupted write is not damage");
});

test("a damaged file with no good backup is reported and left where it is", () => {
  const dir = folder();
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, "");
  const read = readStateFile(file, parseJson);
  assert.equal(read.status, "damaged");
  assert.equal(fs.existsSync(file), true);
});

test("a good file with no backup yet gets one", () => {
  const file = path.join(folder(), "state.json");
  fs.writeFileSync(file, '{"n":1}');
  readStateFile(file, parseJson);
  assert.equal(fs.readFileSync(`${file}.bak`, "utf8"), '{"n":1}');
});

test("an empty transport.json goes back to its backup, one change old", () => {
  const dir = folder();
  const state = path.join(dir, "transport.json");
  const registry = new DeviceRegistry(state);
  registry.enroll({ publicKey: toBase64(loadOrCreateKeyPair(path.join(dir, "keys.json")).publicKey), kind: "device", name: "Pixel", platform: "android", via: "token", transport: 2 });
  registry.lock();
  fs.writeFileSync(state, "");

  const reopened = new DeviceRegistry(state);
  assert.equal(reopened.readable, true);
  assert.equal(reopened.list().length, 1);
  assert.equal(reopened.locked, false, "the lock was the last change and is lost");
});

test("an empty transport.json with no backup refuses everyone, across restarts, until pairing is reset", () => {
  const dir = folder();
  const state = path.join(dir, "transport.json");
  fs.writeFileSync(state, "");
  assert.equal(new DeviceRegistry(state).readable, false);
  // Deleting the file must not open the computer to a fresh, unlocked state.
  fs.rmSync(state);
  const again = new DeviceRegistry(state);
  assert.equal(again.readable, false);
  assert.match(again.problem ?? "", /the file is empty/);

  again.resetPairing();
  assert.equal(new DeviceRegistry(state).readable, true);
});

test("lost relay keys get new keys and pairing has to start over", () => {
  const dir = folder();
  const keys = path.join(dir, "relay-keys.json");
  const state = path.join(dir, "transport.json");
  const before = toBase64(loadOrCreateKeyPair(keys).publicKey);
  new DeviceRegistry(state);
  fs.writeFileSync(keys, "");
  fs.rmSync(`${keys}.bak`);

  const after = toBase64(loadOrCreateKeyPair(keys).publicKey);
  assert.notEqual(after, before);
  const registry = new DeviceRegistry(state);
  assert.equal(registry.readable, false);
  assert.match(registry.problem ?? "", /relay-keys.json was damaged/);
  assert.deepEqual(registry.resetPairing().newOwnerKey, true);
  assert.equal(toBase64(loadOrCreateKeyPair(keys).publicKey), after, "the new keys stay");
});

test("damaged relay keys with a good backup keep the same keys and pairing", () => {
  const dir = folder();
  const keys = path.join(dir, "relay-keys.json");
  const before = toBase64(loadOrCreateKeyPair(keys).publicKey);
  fs.writeFileSync(keys, '{"publicKey":');
  assert.equal(toBase64(loadOrCreateKeyPair(keys).publicKey), before);
  assert.equal(new DeviceRegistry(path.join(dir, "transport.json")).readable, true);
});

test("an empty runs.json starts recovery with nothing to resume", () => {
  const file = path.join(folder(), "runs.json");
  fs.writeFileSync(file, "");
  assert.deepEqual(new RestartRecoveryStore(file).list(), []);
  assert.equal(stateFileIssues().find((issue) => issue.file === file)?.severity, "warning");
});
