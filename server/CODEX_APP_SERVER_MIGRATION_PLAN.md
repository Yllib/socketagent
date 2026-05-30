# Codex App Server Migration Plan

## Goal

Move SocketClaude's Codex backend from one-shot `codex exec --json` subprocesses to the long-lived `codex app-server` protocol so Codex sessions can support CLI-app-style features such as active-turn steering, richer lifecycle operations, and better live event parity.

The migration must be phased, testable, and reversible. The current `exec` driver remains available until App Server mode is proven stable.

## Current State

- `server/src/codex-session.ts` drives Codex with `codex exec --json` and `codex exec resume <threadId> --json`.
- SocketClaude parses JSONL stdout and translates Codex events into existing app messages.
- Mid-turn prompts are locally queued and run as a follow-up `codex exec resume` turn after the current turn exits.
- Archive/clear/restore and scheduled tasks now carry Codex backend metadata, but they still run through the exec driver.

## Target State

- A runtime-selectable Codex driver:
  - `exec`: current stable driver.
  - `app-server`: new long-lived App Server driver.
- The app exposes a per-server toggle for the Codex driver, requiring no rebuild, redeploy, restart, or env edit.
- New Codex sessions use the selected driver.
- Running sessions keep their original driver until they finish.
- App Server mode supports `turn/steer` for mid-turn user input.

## Phase 0: Protocol Probe

Add a probe script that talks to `codex app-server` without changing production behavior.

Files:
- `server/scripts/probe-codex-app-server.js`

Probe flow:
1. Spawn `codex app-server --listen stdio://`.
2. Send `initialize`.
3. Send `thread/start`.
4. Send `turn/start` with a small prompt.
5. While the turn is active, send `turn/steer`.
6. Optionally send `turn/interrupt`.
7. Print all responses and notifications.

Acceptance checks:
- `initialize` succeeds.
- `thread/start` returns a thread id.
- `turn/start` returns a turn id.
- We observe `thread/started`, `turn/started`, item notifications, and `turn/completed`.
- `turn/steer` succeeds during an active turn or fails with a clear, actionable protocol error.

## Phase 1: App Server Client

Add a reusable client.

Files:
- `server/src/codex-app-server-client.ts`

Responsibilities:
- Spawn/connect to `codex app-server`.
- Request/response id tracking.
- Notification event emitter.
- Timeout handling.
- Process restart/cleanup.
- Minimal typed wrappers for methods SocketClaude needs.

Acceptance checks:
- Unit test or script with fake line-based server.
- Real smoke test against local `codex app-server`.
- No production Codex session path changes.

## Phase 2: Runtime Driver Setting And App Toggle

Add server-persisted Codex driver selection.

Server persistence:
- Store in `~/.claude-assistant/server-settings.json`:
  ```json
  {
    "codexDriver": "exec"
  }
  ```

Protocol:
- Client to server:
  ```json
  { "type": "get_server_settings" }
  { "type": "set_codex_driver", "driver": "exec" }
  { "type": "set_codex_driver", "driver": "app-server" }
  ```
- Server to client:
  ```json
  {
    "type": "server_settings",
    "codexDriver": "exec",
    "codexDriversAvailable": ["exec", "app-server"]
  }
  ```

App UI:
- Add a per-server setting, likely under Settings -> Servers -> selected server.
- Segmented control:
  - `Exec`
  - `App Server`
- Disable App Server if the server does not advertise it.
- Explain that the setting affects new Codex sessions; running sessions keep their current driver.

Acceptance checks:
- Toggle persists across server restart.
- Toggle updates without app rebuild or server restart.
- New sessions use selected driver.
- Existing running sessions are not mutated mid-turn.

## Phase 3: App Server Session Driver

Add a new session implementation behind the runtime driver switch.

Files:
- `server/src/codex-app-server-session.ts`

Responsibilities:
- Implement the same `Session` surface consumed by `index.ts`.
- New session: `thread/start` then `turn/start`.
- Resume: `thread/resume` then `turn/start`.
- Abort: `turn/interrupt`.
- Track thread id, active turn id, model, cwd, permission mode, and running state.

Acceptance checks:
- New Codex session works in App Server mode.
- Resume works in App Server mode.
- Exec mode still works unchanged.

## Phase 4: Event Translation Parity

Translate App Server notifications into the existing SocketClaude protocol.

Important mappings:
- `item/agentMessage/delta` -> assistant streaming text.
- `item/started` / `item/completed` -> tool cards.
- `command/exec/outputDelta` and related process deltas -> live shell output.
- `item/fileChange/patchUpdated` -> file diff cards.
- `turn/completed` -> result, usage, session list update.
- `thread/tokenUsage/updated` -> context usage UI.
- `thread/status/changed` -> running/idle/requires-action state.

Acceptance checks:
- A normal coding task looks right in the app.
- Live tool output displays.
- File edits render as diffs.
- Context usage updates when App Server emits it.

## Phase 5: Mid-Turn Steering

Use App Server's active-turn steering surface.

Method:
```json
{
  "method": "turn/steer",
  "params": {
    "threadId": "...",
    "expectedTurnId": "...",
    "input": [
      { "type": "text", "text": "message", "text_elements": [] }
    ]
  }
}
```

Behavior:
- If a turn is active and `turn/steer` succeeds, acknowledge the app's pending message immediately.
- If there is no active turn, start a normal next turn.
- If `turn/steer` rejects, fall back to local queue + next `turn/start`.

Acceptance checks:
- Send a second message while Codex is inside a long tool call.
- The message is delivered to the active turn.
- Pending message UI resolves correctly.
- Fallback queue still works.

## Phase 6: SocketClaude App MCP

Preserve app tools in App Server mode.

Current exec mode passes:
```toml
mcp_servers.socketclaude_app.url = "http://127.0.0.1:$PORT/codex-mcp/<token>"
```

App Server thread methods expose `config`, so App Server mode should pass the equivalent config through `thread/start` and `thread/resume`.

Acceptance checks:
- Codex can call `Speak`.
- Codex can call `SendFile`.
- Codex can call `ScheduleTask`.
- App MCP messages carry the correct SocketClaude session id.
- Concurrent Codex sessions do not share the wrong MCP token.

## Phase 7: Lifecycle Parity

Use App Server lifecycle methods where available.

Mappings:
- Archive: `thread/archive`.
- Restore: existing archive restore plus `thread/resume`, or `thread/unarchive` when appropriate.
- Fork/branch: `thread/fork`.
- Rewind: `thread/rollback`.
- Compact: `thread/compact/start`.
- Abort: `turn/interrupt`.

Acceptance checks:
- Archive list and restore still work for Codex.
- Fork/branch becomes available for App Server Codex where supported.
- Rewind/rollback can be tested without corrupting workspace files.
- Compact emits app-visible boundary/status events.

## Phase 8: Scheduled And Background Tasks

Make scheduled Codex tasks use the selected driver and make App Server the default Codex driver. Keep `exec` available as the emergency fallback.

Implementation notes:
- New Codex sessions default to `app-server` when the local Codex install advertises it.
- Explicit `exec` selection in the app remains supported and persisted.
- Scheduled Codex tasks persist `codexDriver` at creation time so recurring tasks do not unexpectedly change runtime later.
- Legacy Codex sessions/tasks without `codexDriver` are treated as `exec` when resumed.

Acceptance checks:
- One-shot scheduled Codex task runs in App Server mode.
- Recurring Codex task with `reuseSession` resumes the same App Server thread.
- Notifications link to the correct session.
- Exec-mode scheduled tasks remain unchanged.

## Phase 9: Rollout

Rollout order:
1. App Server is the default when available.
2. Keep the app toggle so `exec` can be selected for emergency fallback.
3. Test live phone workflows locally and on one remote server.
4. Deploy app only when UI/protocol changes require it.
5. Remove exec driver only after explicit decision.

## Open Questions

- Exact App Server framing guarantees: newline JSON vs future transport variants.
- Exact App Server config shape for MCP server injection.
- Whether `turn/steer` semantics match CLI app queued-message behavior in all turn phases.
- How App Server reports usage compared with rollout token_count events.
- Whether `thread/archive` should replace or augment our existing archive files.
