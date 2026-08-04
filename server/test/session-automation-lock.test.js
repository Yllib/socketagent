const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  SessionAutomationLockStore,
} = require("../dist/session-automation-lock");

test("stop lock survives restart and only an explicit user prompt removes it", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-stop-lock-"));
  const filePath = path.join(directory, "locks.json");
  try {
    const first = new SessionAutomationLockStore(filePath);
    first.lock("parent", "2026-08-04T18:44:16.000Z");
    assert.equal(first.isLocked("parent"), true);

    const restarted = new SessionAutomationLockStore(filePath);
    assert.equal(restarted.isLocked("parent"), true);
    assert.equal(restarted.unlockForUserPrompt("parent"), true);
    assert.equal(restarted.isLocked("parent"), false);

    const afterPrompt = new SessionAutomationLockStore(filePath);
    assert.equal(afterPrompt.isLocked("parent"), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("locking a parent never locks its child session", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-stop-lock-"));
  try {
    const store = new SessionAutomationLockStore(path.join(directory, "locks.json"));
    store.lock("parent");
    assert.equal(store.isLocked("parent"), true);
    assert.equal(store.isLocked("child"), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
