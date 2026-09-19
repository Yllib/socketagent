const assert = require("node:assert/strict");
const test = require("node:test");

const {
  RESTART_CONTINUATION_PROMPT,
  isRestartContinuationPrompt,
} = require("../dist/restart-recovery");

// The prompt reached the transcript as a user bubble, bracket tag and all,
// because runQuery persists whatever prompt it is handed as the user's turn.

test("the continuation prompt is recognised as SocketAgent's own", () => {
  assert.ok(isRestartContinuationPrompt(RESTART_CONTINUATION_PROMPT));
});

test("surrounding whitespace does not hide it", () => {
  assert.ok(isRestartContinuationPrompt(`\n${RESTART_CONTINUATION_PROMPT}  `));
});

test("a user talking about a restart is still a user turn", () => {
  assert.equal(isRestartContinuationPrompt("the server restarted, continue"), false);
  assert.equal(
    isRestartContinuationPrompt(`please do this: ${RESTART_CONTINUATION_PROMPT}`),
    false,
    "only the prompt on its own is SocketAgent's",
  );
  assert.equal(isRestartContinuationPrompt(""), false);
});
