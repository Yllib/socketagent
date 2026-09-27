# T3 Code review for SocketAgent

Reviewed 2026-09-27 at upstream commit `de251fc2971a884cb5b1305ba4daf309dc8cccb0`.
Read source, tests, and documentation from a shallow checkout. No T3 dependencies
were installed, no T3 service was started, and no provider calls were made.
Recommendations below are implementation judgments, not validated performance claims.

## Resume with less context

There are two separate mechanisms:

1. The web banner is a heuristic. `shouldOfferResumeCompaction` requires Claude,
   at least 100,000 used context tokens, and a context reading at least 70 minutes
   old. It explicitly returns false for Codex. Its Compact button invokes normal
   compaction. It does not query a provider cache-expiry signal.
2. The Claude adapter enables the native `resume_return` dialog through
   `onUserDialog` and `supportedDialogKinds`. It translates the native payload's
   age and token count into a user question, then returns `compact`, `continue`,
   or `never`. Cancellation and abort are handled. Tests verify the returned
   action and the UI question lifecycle.

Sources: [banner logic](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/chat/ContextWindowMeter.logic.ts),
[banner rendering](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/ChatView.tsx),
[Claude adapter](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts),
[adapter tests](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.test.ts).

SocketAgent's installed Claude SDK 0.3.283 already has these two options in
`server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`. Our
`server/src/claude-session.ts` wires `onElicitation`, but not `onUserDialog` or
`supportedDialogKinds`. The SDK documentation says declaring supported kinds is
required; providing only the callback does not opt in.

**Recommended first change:** wire the native dialog into our existing persistent
question UI. Offer Compact and continue, Keep full history, and Don't ask again.
Keep transcript history available to the user and Remember. Do not equate native
model-context compaction with deleting the visible transcript.

A separate optional stale-context hint could be useful, but label it as an
estimate. Do not claim "cache expired" or promise that compacting a cold thread
avoids processing its existing context. T3's source does not establish that.
Measure native dialog behavior and before/after input/cache-read usage before
making a savings claim. Codex needs its own policy; the Claude thresholds are
not a Codex cache lifetime.

## Other candidates, in priority order

| Candidate | What T3 does | SocketAgent fit | Relative effort |
| --- | --- | --- | --- |
| Durable operation receipts | Records command IDs and accepted/rejected outcomes with the event/projection transaction. A repeated accepted command returns its previous sequence. | Extend our existing prompt deduplication and operation-specific idempotency to rewind, compact, and other retryable mutations. Distinguish request acceptance from operation completion. | Medium |
| Persistent outgoing queue | Mobile saves each queued message atomically, including destination, stable command/message IDs, text, settings, and attachments. It flushes pending writes before update restarts. | Our text drafts persist, and prompts have acknowledgement/retry logic, but `_pendingPromptDispatches` is an in-memory map. Audit attachment lifetime and add restart-safe queued sends instead of rebuilding delivery from visible chat. | Medium |
| Reconnect and history ownership | One connection owner per environment; connection health and data freshness are separate. Cached thread state and replay cursor commit together. Desktop keeps active thread subscriptions alive. | We already have transcript caches, sequence-based deltas, and connection management. Adopt the consistency checks and explicit synchronization states, not another cache/connection layer. Directly relevant to the recent stale-history bugs. | Medium |
| Typed provider API contract checks | Generates Codex request/response schemas and method maps; ships a probe and provider fixture tests. | Generate a small typed contract for the methods we use, and validate current installed CLI behavior during backend updates. This would catch removals like `thread/rollback` earlier. Keep explicit older-version fallbacks. | Small to medium |
| Per-turn workspace diffs and checkpoints | Captures workspace state using hidden Git refs and a separate index, without adding commits to the user's branch. Conversation and filesystem reverts are coordinated. | Add a Changes view first. Optional file restoration is a separate, larger feature requiring protection for user edits, concurrent sessions, and non-Git projects. Existing Codex rewind intentionally changes conversation only. | Medium for diffs; large for safe restore |
| Windows capture shortcut | Captures the foreground window into the current draft, with window/app information and optional accessibility text. Native helpers are isolated with deadlines. | Useful for "fix what I am looking at" in SocketAgent Desktop. Use Windows/Flutter integration; retain explicit user-triggered capture and preview before send. No BrowserSession involved. | Medium |
| Multiple provider accounts | Separate authentication homes, compatible shared session state, account-specific model/usage selection. | Useful if users need work/personal accounts. Requires explicit credential ownership and compatibility checks; lower priority than reliability. | Large |

Implementation sources:

- Receipts: [orchestration engine](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/Layers/OrchestrationEngine.ts)
  and [receipt persistence](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/persistence/Layers/OrchestrationCommandReceipts.ts).
- Outgoing queue: [storage](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/mobile/src/state/thread-outbox-storage.ts),
  [stored message schema](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/mobile/src/state/thread-outbox-model.ts).
- Reconnection: [connection runtime](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/docs/internals/connection-runtime.md),
  [thread state and cursor](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/packages/client-runtime/src/state/threads.ts).
- Provider API: [Codex client package](https://github.com/pingdotgg/t3code/tree/de251fc2971a884cb5b1305ba4daf309dc8cccb0/packages/effect-codex-app-server),
  [generated method map](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/packages/effect-codex-app-server/src/_generated/meta.gen.ts).
- Checkpoints: [checkpoint store](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/checkpointing/CheckpointStore.ts),
  [Git driver](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/vcs/GitVcsDriver.ts).
- Capture: [desktop implementation](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/desktop/src/snapShot/DesktopSnapShot.ts),
  [user behavior](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/docs/user/snap-shot.md).
- Accounts: [Codex account setup](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/docs/user/providers-codex.md).

## What to avoid importing wholesale

- React/Electron UI code and the Effect-based orchestration framework do not fit
  our Flutter app and existing TypeScript server directly. Adapt algorithms,
  contracts, and focused tests. A broad framework replacement is unnecessary.
- T3's current Codex rollback reads the turns, calls `thread/revert`, and returns
  a sliced snapshot. Its source explicitly says legacy histories are rejected.
  Our native migration and retained-prefix verification should remain.
  [Source](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexSessionRuntime.ts).
- T3's Claude Stop closes its query to enforce a hard boundary. That is not a
  cache-preservation technique. SocketAgent already distinguishes interrupt,
  abort, and warm sessions; evaluate these independently of a resume banner.
- We already have inline image snapshots, comparison views, usage display,
  native subagent cards, transcript caching, and resumable file downloads.
  Review specific differences rather than treating these as missing features.

The repository is MIT-licensed, copyright T3 Tools Inc. Preserve its copyright
and permission notice for copied substantial code. Dependencies and native
helpers need their own license check if imported. No T3 code was incorporated
in this review. [License](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/LICENSE).

Suggested implementation order: native Claude resume dialog; durable outgoing
queue plus command receipts; targeted reconnect consistency work; typed provider
contract checks; then workspace diffs and the Windows capture shortcut.
