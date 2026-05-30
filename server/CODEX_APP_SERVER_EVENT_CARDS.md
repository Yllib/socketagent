# Codex App Server Event Card Audit

Audited against `codex app-server generate-ts` from `codex-cli 0.133.0` and
SocketAgent's current app/server mappings.

## Handled

- `item/agentMessage/delta` -> assistant text stream.
- `item/completed` with `agentMessage` -> persisted assistant message.
- `item/started` / `item/completed` with `userMessage` -> steer acknowledgement.
- `item/reasoning/textDelta` and `item/reasoning/summaryTextDelta` -> thinking cards.
- `item/started` / `item/completed` with `commandExecution` -> existing Bash cards.
- `item/commandExecution/outputDelta`, `command/exec/outputDelta`, `process/outputDelta` -> live Bash output chunks.
- `item/commandExecution/terminalInteraction` -> stdin line in the matching Bash card.
- `item/started` / `item/completed` with `fileChange` -> existing ApplyPatch/diff cards.
- `item/fileChange/patchUpdated` and `item/fileChange/outputDelta` -> running diff buffer.
- `item/started` / `item/completed` with `mcpToolCall` -> existing MCP/tool cards.
- `item/mcpToolCall/progress` -> streamed tool result chunk.
- `item/started` / `item/completed` with `dynamicToolCall` -> generic tool card.
- `item/started` / `item/completed` with `collabAgentToolCall` -> existing `Agent`/subagent cards and active task pane.
- `item/started` / `item/completed` with `webSearch` -> generic WebSearch tool card.
- `item/started` / `item/completed` with `imageView` -> generic ViewImage tool card plus inline `tool_image` when the file is locally readable.
- `item/started` / `item/completed` with `imageGeneration` -> generic ImageGeneration tool card plus inline `tool_image` when `savedPath` is locally readable.
- `item/started` / `item/completed` with `contextCompaction` and `thread/compacted` -> existing compacting state and compact boundary.
- `turn/plan/updated` -> dedicated Codex plan card in chat.
- `hook/started` / `hook/completed` -> existing hook banner.
- `thread/status/changed` -> running/idle/error state.
- `thread/name/updated` -> stored session title update.
- `thread/tokenUsage/updated` -> usage update.
- `account/rateLimits/updated` -> rate-limit UI event.
- `model/rerouted` -> lightweight task notification.
- `guardianWarning`, `deprecationNotice`, `windows/worldWritableWarning` -> visible error/warning card.
- `mcpServer/startupStatus/updated` -> visible error card when startup reports an error.
- `turn/completed` -> result/end-of-turn.
- `warning`, `configWarning`, `error` -> app error message.

## Still Missing Or Partial

### Codex Plans

- `turn/plan/updated` is handled.
- `item/plan/delta` and `ThreadItem: plan` are still ignored.
- The current app card is chat-local and does not persist into SocketAgent history. Codex rollout/app-server history may still contain the underlying plan data, but SocketAgent's own history restore will not recreate this card yet.

### Image Cards

- Inline image display is handled for local files up to 20 MiB.
- Remote/generated outputs without a readable `savedPath` still fall back to text.
- SVG is sent as `image/svg+xml`; verify Flutter image decoding behavior on device before relying on it.

### Session And Settings Refresh

- `thread/name/updated` updates the stored session title, but does not currently force an immediate session-list broadcast from inside `CodexSession`.
- `thread/archived`, `thread/unarchived`, and `thread/closed` are not explicitly mapped to session/archive refreshes.
- `skills/changed` is not yet mapped to a skills refresh.
- `account/updated` and `account/login/completed` are not yet mapped to settings/account refresh.

### MCP Status

- `mcpServer/startupStatus/updated` only surfaces errors in chat.
- Successful MCP startup/status changes are not synced into the app's MCP settings screen for Codex yet.
- `mcpServer/oauthLogin/completed` is not mapped.

### Model And Guardian Details

- `model/rerouted` is visible.
- `model/verification` is still ignored.
- `item/autoApprovalReview/started`, `item/autoApprovalReview/completed`, and `serverRequest/resolved` are not mapped to tool-card progress.

### Permission And Approval Surface

Generated server requests include:
- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `item/tool/requestUserInput`
- `mcpServer/elicitation/request`
- `item/tool/call`

Current SocketAgent App Server mode runs with `approvalPolicy: "never"`, so most approval UI is not exercised. If Codex is used by other people or without bypass-style permissions, this becomes a real parity project:
- Map approval requests to existing question/permission cards.
- Resolve app answers back through app-server request responses.
- Render auto-review status on the target tool card.

## Low-Value Or Debug-Only For Now

- `rawResponseItem/completed`: useful in raw event debug mode, too noisy for chat.
- `turn/diff/updated`: useful fallback, but per-item file cards fit the app better.
- `process/exited`: mostly redundant when tied to command execution; useful for `process/spawn`.
- `fs/changed`: not chat-worthy unless we build a file watcher UI.
- `app/list/updated`: settings/app connector screen only.
- `remoteControl/status/changed`: not relevant to SocketAgent chat rendering.
- `externalAgentConfig/import/completed`: settings-only.
- `fuzzyFileSearch/sessionUpdated` / `sessionCompleted`: only relevant if we implement Codex file picker/search UI.
- Realtime notifications: separate voice/realtime project, not parity for current chat flow.
- Windows sandbox setup notifications: settings/diagnostics only.

## Recommended Next Pass

1. Add immediate refresh hooks for session/archive/skills/account events.
2. Persist Codex plan cards into SocketAgent history if we want them visible after resume.
3. Add Codex MCP status sync to the existing MCP settings UI.
4. Build approval/request UI only if we stop using `approvalPolicy: "never"` or support non-owner installs.
