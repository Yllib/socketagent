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

Rewind finds the selected prompt through the UUID index. The backup streams
stored JSON through a separate read-only SQLite snapshot, yielding between
chunks so other sessions can keep writing. After native verification, one
transaction deletes only the discarded suffix and its search entries. Retained
rows, identities, and search documents are not rebuilt. History caches and
stream positions are invalidated, and native reimports wait for rewind to end.

A full native rewind on an isolated Wakespeed copy with 143,149 transcript
entries took 4,110 ms: 2,287 ms for the backup and 70 ms for suffix deletion.
That test removed one native turn and 11 local entries. The earlier live
18-turn rewind took 69,773 ms, including 50,855 ms rebuilding retained history.
These are separate runs, not an identical-boundary benchmark. Regression tests
forbid writes to retained rows, cover FTS and fallback search, verify concurrent
snapshot writes, and reject full transcript hydration in the rewind path.

Codex CLI 0.155.1's generated schema still exposes `thread/rollback`, but marks
it deprecated. Official documentation also warns it will be removed:
https://learn.chatgpt.com/docs/app-server#roll-back-recent-turns
Paginated native threads reject that legacy command. They use `thread/revert`
with the selected `beforeTurnId`, then verify the retained IDs through
`thread/turns/list`; revert's response contains metadata, not retained turns.
If the runtime rejects either operation, SocketAgent keeps its history and
shows the error. Rewind progress and results remain above the chat viewport.

The JSONL response reader accumulates chunks until a newline before joining
them. Repeatedly splitting the accumulated buffer made large thread reads
quadratic: a 166 MB Wakespeed transcript took about 62 seconds before the fix,
versus 1.2 seconds afterward. A 32 MB fragmented-response regression covers
the request deadline and separate tests cover framing and malformed lines.

Native integration validation uses an isolated copy of the rollout and SQLite
history databases under a temporary CODEX_HOME, with its indexed rollout path
redirected into that directory. The real transcript remains unchanged and no
model turn is started. A 179-turn copy successfully reverts to 178 retained
turns. The temporary databases and transcripts are removed afterward.

Validation:
- Full server suite, including approval, archive search, native turn mapping,
  concurrent rewind, rollback failure, and rollout reimport regressions.
- App widget tests for explicit transcript approval and rewind confirmation.
- Encrypted WebSocket app test for terminal cards, rewind session routing,
  authoritative history replacement, and persisted cache invalidation.
- Canonical Play APK build with no deployment flags.
