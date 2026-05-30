# Codex App Server Lifecycle Parity

## Implemented

- Session metadata now records `codexDriver` for new Codex sessions.
- `clear_context` and `archive_session` call `thread/archive` for Codex App Server sessions before moving SocketAgent history into the local archive.
- `restore_archive` calls `thread/unarchive` when the restored archive is known to be a Codex App Server session.
- `fork_session` supports full-thread Codex App Server forks through `thread/fork`.
- `compact_context` is accepted by the server for Codex App Server sessions and calls `thread/compact/start`.
- App Server `contextCompaction` and `thread/compacted` events now update the existing compacting/compact-boundary app UI.

## Verified

- `thread/fork`, `thread/archive`, and `thread/unarchive` work after a thread has at least one completed turn.
- Empty just-created threads cannot be forked by App Server: the protocol returns `no rollout found for thread id ...`.
- `server` TypeScript compilation passes with `npx tsc`.

## Still Not Parity

- Message-level branch is not implemented for Codex App Server.
  - App Server exposes full-thread `thread/fork`.
  - It does not currently expose Claude-style `upToMessageId` branching.

- Message-level conversation rewind is not implemented for Codex App Server.
  - App Server exposes `thread/rollback` by number of turns.
  - SocketAgent rewind is based on user-message UUIDs and can also restore files for Claude.
  - Mapping UUIDs to App Server turn rollback safely needs more design so local chat history and App Server thread history do not diverge.

- File rewind remains unsupported for Codex.
  - App Server rollback explicitly does not restore workspace file changes.
