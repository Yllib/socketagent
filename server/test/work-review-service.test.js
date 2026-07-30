const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  WorkReviewError,
  WorkReviewService,
} = require("../dist/work-review-service");
const { WorkReviewStore } = require("../dist/work-review-store");

const roots = [];

function service() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-work-reviews-"));
  roots.push(root);
  return new WorkReviewService(new WorkReviewStore(root));
}

function createInput(overrides = {}) {
  return {
    idempotencyKey: "handoff-1",
    originSessionId: "session-1",
    originBackend: "codex",
    title: "Review the thing",
    summary: "The agent changed a thing.",
    approvalMeaning: "Approval authorizes the configured next workflow step.",
    items: [{
      title: "Changed web page",
      instructions: "Check the heading and layout.",
      primaryTarget: {
        kind: "url",
        uri: "http://192.168.1.42:4173/preview",
        environment: "LAN dev server",
        displayMode: "embedded",
      },
      supportingTargets: [{
        kind: "diff",
        uri: "repo://changes/abc123",
        displayMode: "auto",
      }],
    }],
    ...overrides,
  };
}

test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

test("keeps reviewer drafts private until finish seals one immutable result", async () => {
  const subject = service();
  const created = await subject.create(createInput());
  assert.equal(created.rounds[0].status, "in_review");
  assert.equal("draft" in created.rounds[0], false);
  assert.equal("currentDraft" in created, false);

  const itemId = created.rounds[0].items[0].itemId;
  const edited = await subject.updateDraft(created.reviewId, {
    expectedRevision: 0,
    itemUpdates: [{ itemId, status: "changes_requested", note: "Align the title." }],
    overallNote: "One requested change.",
  });
  assert.equal(edited.currentDraft.revision, 1);
  assert.equal(edited.currentDraft.itemDecisions[0].note, "Align the title.");

  const agentRead = subject.get(created.reviewId);
  assert.equal(JSON.stringify(agentRead).includes("Align the title."), false);
  assert.equal(JSON.stringify(subject.list()).includes("Align the title."), false);
  assert.equal(JSON.stringify(subject.export()).includes("Align the title."), false);

  const finished = await subject.finish(created.reviewId, { expectedDraftRevision: 1 });
  assert.equal(finished.published, true);
  assert.equal(finished.result.itemResults[0].status, "changes_requested");
  assert.equal(finished.result.itemResults[0].note, "Align the title.");
  assert.equal(subject.clientSnapshot(created.reviewId).currentDraft, undefined);

  const duplicate = await subject.finish(created.reviewId);
  assert.equal(duplicate.published, false);
  assert.equal(duplicate.result.resultId, finished.result.resultId);
  await assert.rejects(
    subject.updateDraft(created.reviewId, {
      itemUpdates: [{ itemId, status: "approved" }],
    }),
    (error) => error instanceof WorkReviewError && error.code === "invalid_state",
  );
});

test("creates linked monotonic rounds while preserving completed evidence and card identity", async () => {
  const subject = service();
  const first = await subject.create(createInput());
  const firstItemId = first.rounds[0].items[0].itemId;
  await subject.updateDraft(first.reviewId, {
    itemUpdates: [{ itemId: firstItemId, status: "approved", note: "Looks good." }],
  });
  const sealed = await subject.finish(first.reviewId);

  const second = await subject.newRound(first.reviewId, {
    ...createInput({
      title: "Review the revision",
      items: [{
        title: "Updated web page",
        primaryTarget: { kind: "url", uri: "https://preview.example.test/v2" },
      }],
    }),
    idempotencyKey: "handoff-2",
  });
  assert.equal(second.reviewId, first.reviewId);
  assert.equal(second.cardId, first.cardId);
  assert.equal(second.currentRevision, 1);
  assert.equal(second.rounds.length, 2);
  assert.equal(second.rounds[0].result.resultId, sealed.result.resultId);
  assert.equal(second.rounds[0].result.itemResults[0].note, "Looks good.");
  assert.equal(second.rounds[1].status, "in_review");

  const retry = await subject.newRound(first.reviewId, {
    ...createInput({
      title: "Review the revision",
      items: [{
        title: "Updated web page",
        primaryTarget: { kind: "url", uri: "https://preview.example.test/v2" },
      }],
    }),
    idempotencyKey: "handoff-2",
  });
  assert.equal(retry.rounds.length, 2);
  assert.equal(retry.rounds[1].roundId, second.rounds[1].roundId);
});

test("content-hashes idempotent creates and rejects key reuse with different content", async () => {
  const subject = service();
  const [first, retry] = await Promise.all([
    subject.create(createInput()),
    subject.create(createInput()),
  ]);
  assert.equal(retry.reviewId, first.reviewId);
  assert.equal(subject.list().length, 1);

  await assert.rejects(
    subject.create(createInput({ title: "Different content" })),
    (error) => error instanceof WorkReviewError && error.code === "idempotency_conflict",
  );
});

test("allows legitimate local/LAN/prod HTTP targets but rejects active-scheme and credential URLs", async () => {
  const subject = service();
  await subject.create(createInput());
  await subject.create(createInput({
    idempotencyKey: "localhost",
    items: [{
      title: "Local target",
      primaryTarget: { kind: "url", uri: "http://localhost:8080/" },
    }],
  }));
  await subject.create(createInput({
    idempotencyKey: "prod",
    items: [{
      title: "Production target",
      primaryTarget: { kind: "url", uri: "https://app.example.com/" },
    }],
  }));
  const legacyExternal = await subject.create(createInput({
    idempotencyKey: "legacy-external-primary",
    items: [{
      title: "Legacy external primary URL",
      primaryTarget: {
        kind: "url",
        uri: "https://preview.example.com/",
        displayMode: "external",
      },
    }],
  }));
  assert.equal(
    legacyExternal.rounds[0].items[0].primaryTarget.displayMode,
    "embedded",
  );
  await assert.rejects(
    subject.create(createInput({
      idempotencyKey: "javascript",
      items: [{
        title: "Unsafe target",
        primaryTarget: { kind: "url", uri: "javascript:alert(1)" },
      }],
    })),
    (error) => error.code === "validation",
  );
  await assert.rejects(
    subject.create(createInput({
      idempotencyKey: "credentials",
      items: [{
        title: "Credential target",
        primaryTarget: { kind: "url", uri: "https://user:secret@example.com/" },
      }],
    })),
    (error) => error.code === "validation",
  );
});

test("recovers a missing/corrupt index from atomic record files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-work-reviews-recovery-"));
  roots.push(root);
  const firstService = new WorkReviewService(new WorkReviewStore(root));
  const created = await firstService.create(createInput());
  fs.writeFileSync(path.join(root, "index.json"), "{broken");

  const recovered = new WorkReviewService(new WorkReviewStore(root));
  assert.equal(recovered.get(created.reviewId).reviewId, created.reviewId);
  assert.equal(recovered.list().length, 1);
  const retry = await recovered.create(createInput());
  assert.equal(retry.reviewId, created.reviewId);
});

test("serializes concurrent draft mutations with optimistic revision checks", async () => {
  const subject = service();
  const created = await subject.create(createInput());
  const itemId = created.rounds[0].items[0].itemId;
  const results = await Promise.allSettled([
    subject.updateDraft(created.reviewId, {
      expectedRevision: 0,
      itemUpdates: [{ itemId, status: "approved" }],
    }),
    subject.updateDraft(created.reviewId, {
      expectedRevision: 0,
      itemUpdates: [{ itemId, status: "rejected" }],
    }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) =>
    result.status === "rejected" && result.reason.code === "revision_conflict").length, 1);
});

test("applies the complete final client draft and seals it in one finish mutation", async () => {
  const subject = service();
  const created = await subject.create(createInput({ purpose: "Visual product review" }));
  const itemId = created.rounds[0].items[0].itemId;
  const finished = await subject.finish(created.reviewId, {
    idempotencyKey: "finish-1",
    expectedDraftRevision: 0,
    itemUpdates: [{
      itemId,
      status: "approved",
      note: "Verified in the embedded preview.",
    }],
    overallNote: "Ready for the next configured step.",
  });

  assert.equal(finished.published, true);
  assert.equal(finished.review.rounds[0].purpose, "Visual product review");
  assert.equal(finished.result.itemResults[0].status, "approved");
  assert.equal(finished.result.itemResults[0].note, "Verified in the embedded preview.");
  assert.deepEqual(
    finished.review.events.map((event) => event.type),
    ["created", "finished"],
  );
  assert.equal(JSON.stringify(finished.review.events).includes("Verified"), false);
});

test("deduplicates draft mutation retries and conflicts on mutation ID content changes", async () => {
  const subject = service();
  const created = await subject.create(createInput());
  const itemId = created.rounds[0].items[0].itemId;
  const mutation = {
    mutationId: "draft-save-1",
    expectedRevision: 0,
    itemUpdates: [{ itemId, status: "approved", note: "Checked." }],
  };
  const first = await subject.updateDraft(created.reviewId, mutation);
  const retry = await subject.updateDraft(created.reviewId, mutation);
  assert.equal(first.currentDraft.revision, 1);
  assert.equal(retry.currentDraft.revision, 1);
  assert.equal(subject.get(created.reviewId).events.filter((event) =>
    event.type === "draft_saved").length, 1);

  await assert.rejects(
    subject.updateDraft(created.reviewId, {
      ...mutation,
      itemUpdates: [{ itemId, status: "rejected" }],
    }),
    (error) => error.code === "idempotency_conflict",
  );
});

test("falls back to the previous valid record when authoritative JSON is corrupted", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-work-reviews-backup-"));
  roots.push(root);
  const firstService = new WorkReviewService(new WorkReviewStore(root));
  const created = await firstService.create(createInput());
  const itemId = created.rounds[0].items[0].itemId;
  await firstService.updateDraft(created.reviewId, {
    mutationId: "make-backup",
    itemUpdates: [{ itemId, status: "approved" }],
  });

  const recordsDir = path.join(root, "records");
  const [recordName] = fs.readdirSync(recordsDir).filter((name) => name.endsWith(".json"));
  fs.writeFileSync(path.join(recordsDir, recordName), "{corrupt");
  fs.writeFileSync(path.join(root, "index.json"), "{also-corrupt");

  const recovered = new WorkReviewService(new WorkReviewStore(root));
  const snapshot = recovered.clientSnapshot(created.reviewId);
  assert.equal(snapshot.reviewId, created.reviewId);
  // The backup is intentionally the prior complete record, never a partial write.
  assert.equal(snapshot.currentDraft.revision, 0);
  assert.doesNotThrow(() =>
    JSON.parse(fs.readFileSync(path.join(recordsDir, recordName), "utf8")));
});
