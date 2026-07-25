const assert = require("node:assert/strict");
const test = require("node:test");

const {
  codexRolloutJsonlToHistory,
} = require("../dist/codex-native-history");

test("restores Codex reasoning summaries as thinking history", () => {
  const raw = [
    JSON.stringify({
      timestamp: "2026-07-25T12:00:00.000Z",
      type: "response_item",
      payload: {
        id: "reasoning-1",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Checked the implementation." }],
      },
    }),
    JSON.stringify({
      timestamp: "2026-07-25T12:00:01.000Z",
      type: "response_item",
      payload: {
        id: "reasoning-redacted",
        type: "reasoning",
        encrypted_content: "withheld",
      },
    }),
  ].join("\n");

  const history = codexRolloutJsonlToHistory(raw);
  assert.deepEqual(history, [
    {
      role: "assistant",
      content: "Checked the implementation.",
      thinking: true,
      streamId: "reasoning-1",
      timestamp: "2026-07-25T12:00:00.000Z",
    },
    {
      role: "assistant",
      content: "",
      thinking: true,
      streamId: "reasoning-redacted",
      timestamp: "2026-07-25T12:00:01.000Z",
    },
  ]);
});
