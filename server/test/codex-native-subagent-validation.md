# Native Codex subagent lifecycle validation

Validated against Codex CLI 0.153.2 and its generated app-server TypeScript
schema. The official app-server guide recommends generating schemas from the
installed CLI: https://learn.chatgpt.com/docs/app-server.

## Fixed behavior

- Native `subAgentActivity/completed` settles an Agent card. Activity is applied
  on the final item notification. Sending a message to a child does not start it.
- Child turn IDs distinguish a new run from a delayed/replayed prior turn event.
  Completion activity without a child turn ID reconciles runtime state if a
  child turn is known to be active.
- Reconnect and parent-turn completion reconcile tracked active children through
  `thread/read`. They do not resume threads or start AI turns. Runtime revision
  checks prevent an in-flight read from overriding a newer event.
- Parent completion does not stop children that the runtime still reports active.
- Failed, interrupted, and unavailable outcomes survive live results, replacement
  snapshots, durable history, and the app's offline cache. Unloading a completed
  child does not overwrite its known outcome.
- Native app-server history reconstructs Agent cards from subagent activity and
  collaboration items. Current native snapshots take precedence over an older
  result from a prior child turn loaded into the same card.

## Reproduction and regression coverage

The original recorded lifecycle had a child complete, a later interaction with
that child, and parent completion. Replaying these notifications against the old
server left root `_isRunning=false` but `isBusy=true`; the fixed server reports
`isBusy=false`, with the child completed.

`codex-native-subagent-lifecycle.test.js` covers native completion, duplicate
spawn notifications, communication after completion, a new turn with delayed
old completion/start events, failure/interruption through history and reconnect,
missed-completion reconciliation, stale reads during a newer turn, unloaded
children, background work after parent completion, and native-history cards.

The app's `codex_subagent_lifecycle_test.dart` uses a local encrypted WebSocket
server to exercise live cards, terminal snapshots, replacement snapshots,
dismiss/reopen, history loading, and active work overriding old history. It also
checks cache serialization and outcome-aware acknowledgement deduplication.

Commands:

```sh
cd server
npm test
```

```sh
cd ../socketagent-app
flutter test test/codex_subagent_lifecycle_test.dart test/message_reconciliation_test.dart test/session_transcript_cache_test.dart
```

Windows builds must use `build-app.sh --windows`; its test list includes the
new lifecycle integration tests. These tests do not start real agent turns or
alter any connected computer's sessions.
