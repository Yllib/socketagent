# Remember access and Codex rewind

Remember remains scoped to its current SocketAgent session by default.
`search_all` requests one-time approval through the app's existing question
card. It searches durable SocketAgent transcripts on the connected server and
saved history archives from Clear Context or conversation rewind. It does not
search other computers or arbitrary files. Native provider transcripts that
have never been imported into SocketAgent are outside this index.

Each `get` or `context` request with a `source_id` returned by global search
requires a new approval. Permission bypass modes do not grant access. Missing
callbacks, denial, cancellation, and stale question responses fail closed.
There is no persistent grant or model-supplied authorization flag. This gate
controls Remember; it does not sandbox an agent's general filesystem tools.

Codex rewind targets the first user prompt of a native turn, removing that turn
and every later turn. Client message IDs identify prompts; older imported
prompts require a unique exact match without a conflicting client ID. Requests
for a message sent within an existing turn fail with instructions to select
its first prompt. Running work must be stopped first. No files are reverted.

A transcript backup is written before the native rollback. SocketAgent truncates
its live history only after Codex returns the expected retained turns. The app
replaces its visible history and invalidates its disk cache. Native rollout
rollback markers are honored so reconnect cannot resurrect discarded turns.

Codex CLI 0.155.1's generated schema still exposes `thread/rollback`, but marks
it deprecated. Official documentation also warns it will be removed:
https://learn.chatgpt.com/docs/app-server#roll-back-recent-turns
If the runtime rejects rollback, the original SocketAgent history is retained
and the error is shown. Regression tests use isolated fixture transcripts and
mock native RPC responses, not real user conversations or paid agent turns.

Validation:
- Full server suite, including approval, archive search, native turn mapping,
  concurrent rewind, rollback failure, and rollout reimport regressions.
- App widget tests for explicit transcript approval and rewind confirmation.
- Encrypted WebSocket app test for terminal cards, rewind session routing,
  authoritative history replacement, and persisted cache invalidation.
- Canonical Play APK build with no deployment flags.
