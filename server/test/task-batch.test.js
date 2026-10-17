const { z } = require("zod");
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
require("./test-data-dir");

const { handleTaskBatchTool } = require("#server/app-tool-handlers");
const { dismissTodos, getTodos, saveTodos } = require("#server/session-store");

/** @param {string} sessionId
 * @returns {{ sent: import('#server/protocol').ServerMessage[], history: import('#server/protocol').HistoryEntry[], context: import('#server/app-tool-handlers').AppToolContext }} */
function makeContext(sessionId) {
  /** @type {import("#server/protocol").ServerMessage[]} */
  const sent = [];
  /** @type {import("#server/protocol").HistoryEntry[]} */
  const history = [];
  return {
    sent,
    history,
    context: {
      getSessionId: () => sessionId,
      getCwd: () => process.cwd(),
      getBackend: () => "claude",
      send: (message) => sent.push(message),
      appendHistory: (entry) => { history.push(entry); },
      getTtsEngine: () => "system",
      getKokoroVoice: () => "",
      getKokoroSpeed: () => 1,
    },
  };
}

/** @param {Awaited<ReturnType<typeof handleTaskBatchTool>>} result */
function resultBody(result) {
  return z.object({ count: z.number(), tasks: z.array(z.object({ task_id: z.string(), status: z.string() })) }).parse(JSON.parse(result.content[0].text));
}

test("TaskBatch creates and updates several tasks while preserving native tasks", async (t) => {
  const sessionId = `test-task-batch-${randomUUID()}`;
  t.after(() => saveTodos(sessionId, []));
  const nativeTask = {
    id: "native-1",
    taskId: "native-1",
    content: "Native Claude task",
    status: "in_progress",
    source: "claude_tasks",
  };
  saveTodos(sessionId, [nativeTask]);
  const { context, sent, history } = makeContext(sessionId);

  const created = await handleTaskBatchTool(context, {
    mode: "replace",
    tasks: [
      { subject: "Inspect parser", active_form: "Inspecting parser" },
      { subject: "Repair ordering", status: "in_progress" },
      { subject: "Verify replay", status: "completed" },
    ],
  });
  assert.equal(created.isError, undefined);
  const createdBody = resultBody(created);
  assert.equal(createdBody.count, 3);
  assert.equal(new Set(createdBody.tasks.map((task) => task.task_id)).size, 3);
  assert.equal(sent.length, 1);
  assert.equal(history.length, 1);
  assert.equal(history[0].role, "todos_update");
  assert.deepEqual(getTodos(sessionId)[0], nativeTask);

  const [first, second] = createdBody.tasks;
  const updated = await handleTaskBatchTool(context, {
    mode: "upsert",
    tasks: [
      { task_id: first.task_id, status: "completed" },
      { task_id: second.task_id, subject: "Repair canonical ordering", status: "completed" },
      { subject: "Ship the update", active_form: "Shipping the update" },
    ],
  });
  assert.equal(updated.isError, undefined);
  const updatedBody = resultBody(updated);
  assert.equal(updatedBody.count, 4);
  assert.equal(
    updatedBody.tasks.filter((task) => task.status === "completed").length,
    3,
  );
  assert.equal(getTodos(sessionId).filter((task) => task.source === "claude_tasks").length, 1);
});

test("TaskBatch deletes several IDs and clears completed managed tasks in bulk", async (t) => {
  const sessionId = `test-task-batch-${randomUUID()}`;
  t.after(() => saveTodos(sessionId, []));
  const { context } = makeContext(sessionId);
  const created = resultBody(await handleTaskBatchTool(context, {
    mode: "replace",
    tasks: [
      { task_id: "one", subject: "One", status: "completed" },
      { task_id: "two", subject: "Two" },
      { task_id: "three", subject: "Three", status: "completed" },
      { task_id: "four", subject: "Four" },
    ],
  }));

  const deleted = resultBody(await handleTaskBatchTool(context, {
    mode: "delete",
    task_ids: [created.tasks[1].task_id, created.tasks[3].task_id],
  }));
  assert.deepEqual(deleted.tasks.map((task) => task.task_id), ["one", "three"]);

  const cleared = resultBody(await handleTaskBatchTool(context, {
    mode: "clear_completed",
  }));
  assert.equal(cleared.count, 0);
  assert.deepEqual(getTodos(sessionId), []);
});

test("TaskBatch rejects duplicate and unknown task IDs without changing storage", async (t) => {
  const sessionId = `test-task-batch-${randomUUID()}`;
  t.after(() => saveTodos(sessionId, []));
  const { context, sent } = makeContext(sessionId);

  const duplicate = await handleTaskBatchTool(context, {
    mode: "replace",
    tasks: [
      { task_id: "same", subject: "One" },
      { task_id: "same", subject: "Two" },
    ],
  });
  assert.equal(duplicate.isError, true);
  assert.match(duplicate.content[0].text, /Duplicate SocketAgent task id/);
  assert.deepEqual(getTodos(sessionId), []);

  const unknown = await handleTaskBatchTool(context, {
    mode: "upsert",
    tasks: [{ task_id: "missing", status: "completed" }],
  });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /Unknown SocketAgent task id/);
  assert.deepEqual(getTodos(sessionId), []);
  assert.equal(sent.length, 0);
});

test("a dismissed task stays hidden through agent rewrites until it is reopened", () => {
  const sessionId = `dismiss-${randomUUID()}`;
  saveTodos(sessionId, [
    { id: "1", content: "Ship it", status: "completed", source: "claude_tasks" },
    { id: "2", content: "Test it", status: "in_progress", source: "claude_tasks" },
  ]);
  const dismissed = dismissTodos(sessionId, ["claude_tasks:1", "claude_tasks:2"]);
  assert.deepEqual(dismissed?.map((task) => task.dismissed ?? false), [true, false], "only completed tasks are dismissed");
  assert.equal(dismissTodos(sessionId, ["claude_tasks:1"]), undefined, "a repeat changes nothing");

  // TodoWrite-style rewrites drop the flag; the store keeps it.
  saveTodos(sessionId, [
    { id: "1", content: "Ship it", status: "completed", source: "claude_tasks" },
    { id: "2", content: "Test it", status: "completed", source: "claude_tasks" },
  ]);
  assert.deepEqual(getTodos(sessionId).map((task) => task.dismissed ?? false), [true, false]);

  saveTodos(sessionId, [{ id: "1", content: "Ship it", status: "in_progress", source: "claude_tasks" }]);
  saveTodos(sessionId, [{ id: "1", content: "Ship it", status: "completed", source: "claude_tasks" }]);
  assert.equal(getTodos(sessionId)[0].dismissed, undefined, "reopening a task brings it back");
});
