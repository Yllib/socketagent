# Resume and delivery reliability

Local implementation following the T3 review in `t3code-review-2026-09-27.md`.

## Resume UX

Claude's SDK opts into `resume_return` for user-submitted turns. The SDK decides
when to ask, after Send. SocketAgent does not infer that a Codex cache expired.
The original prompt waits while the user chooses Compact and continue or Keep
full context. Decide later dismisses the window without answering. The transcript
keeps a Review control. Stop aborts the underlying query before returning the
native cancelled response, whose default behavior could otherwise continue.
Scheduled/background turns do not opt into this dialog.

## Outgoing requests

The app writes prompts into its support directory before network delivery. It
copies selected files out of picker storage, checkpoints each completed upload,
and preserves server/session/model settings and message IDs across retries.
Uploads own their completion handler independently of the selected session.
A stable draft identity also binds queued follow-ups to the same native session
when Send is pressed before the backend has assigned its session ID. That mapping
survives server restarts and context rollovers.
New secret values use the existing protected server storage first; the disk
queue contains only returned references, never raw secret attachment values.

Receipted commands include prompts, question answers, conversation rewind, and
compaction. Stop keeps its existing independent durable cancellation path and
removes queued requests that could restart stopped work. Commands other than
prompts expire after two minutes rather than silently applying stale controls.
Older servers retain the previous one-shot control behavior. Persisted controls
are not replayed to a server that does not advertise command receipts.

The server records command claims and replies in SQLite with full synchronous
writes. It acknowledges a prompt for removal from the phone only after its user
entry exists in the durable transcript. Starting the backend is insufficient;
an interrupted start leaves the phone copy available for inspection. The identity is checked against a canonical payload hash. A lost reply
can be recovered without repeating the command. An interrupted dispatch becomes
uncertain after restart and requires user inspection. Acceptance is not proof
that the AI finished the task; this does not promise exactly-once external
backend execution. Rewind receipts carry their deleted sequence range and replay
with current history, so an old receipt cannot restore an old snapshot or mark
new work idle.

## History synchronization

Resume requests hash the cached entries' sequences, IDs, and revisions. The
server compares that hash to the corresponding indexed window. A matching last
position alone no longer hides edits to earlier cached entries. Cache writes
continue to persist content and cursor together. Per-session generations prevent
a cold disk read from undoing a newer replacement or invalidation.

## Validation

Focused tests cover dialog choices/dismissal, pre-init question persistence,
outbox restoration and file snapshots, delivery acknowledgments, uncertain
receipts, Stop, session switching during uploads, stale rewind receipts,
history window digests, and stale cache reads. Server and app test logs are in
`/tmp/sa-reliability-server-full.log`, `/tmp/sa-new-server-tests.log`,
`/tmp/sa-reliability-app-tests.log`, and `/tmp/sa-attachment-test.log`.
No live AI cache savings have been measured. This work is local and unpushed;
a server deployment is still required before end-to-end phone testing of the
native resume callback and durable server receipts.
