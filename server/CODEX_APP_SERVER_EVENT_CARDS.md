# Codex App Server Event Card Mapping

Observed with `codex app-server` 0.133.0 through `server/scripts/probe-codex-app-server.js --verbose`.

## Primary Chat Events

- `item/agentMessage/delta`: stream to existing assistant text bubbles.
- `item/completed` with `agentMessage`: persist the completed assistant message.
- `item/started` / `item/completed` with `userMessage`: known event type, but not reliable enough as the app's injection acknowledgement point. Acknowledge steered messages when `turn/steer` succeeds.
- `item/reasoning/textDelta` and `item/reasoning/summaryTextDelta`: stream to existing thinking cards.

## Tool Cards

- `item/started` / `item/completed` with `commandExecution`: map to existing `Bash` tool cards.
  - `item/commandExecution/outputDelta` contains live shell output with `itemId`.
  - `item.aggregatedOutput` contains the final shell output when the item completes.
  - `item.commandActions` can later improve the collapsed Bash card summary.

- `item/started` / `item/completed` with `fileChange`: map to existing `ApplyPatch` tool cards.
  - `item.changes[].diff` is a unified diff hunk.
  - `item/fileChange/patchUpdated` can update the latest diff while the patch is in progress.
  - `turn/diff/updated` contains the turn-level aggregate diff. Keep this as fallback/diagnostics for now because per-item file cards fit the existing UI better.

- `item/started` / `item/completed` with `mcpToolCall`: map to existing MCP cards.
  - `socketagent_app` tools keep their short names (`Speak`, `SendFile`, `ScheduleReminder`, etc.).
  - Other MCP tools use `mcp:<server>/<tool>`.
  - `item/mcpToolCall/progress` can stream progress text into the running tool card.

- `dynamicToolCall`: map to generic tool cards using `<namespace>/<tool>` when a namespace exists.
- `webSearch`: map to a generic `WebSearch` card.
- `imageView`: map to a generic `ViewImage` card for now.
- `imageGeneration`: map to a generic `ImageGeneration` card for now.

## State Events

- `thread/status/changed`: map `active` to `session_state_changed: running`, `idle` to `idle`, and `systemError` to an app error.
- `thread/tokenUsage/updated`: map to existing `usage_update`.
- `account/rateLimits/updated`: map primary rate-limit utilization to existing `rate_limit_event`.
- `turn/completed`: map to existing `result`.

## Currently Ignored Or Deferred

- `mcpServer/startupStatus/updated`: useful for diagnostics, but noisy as a chat card.
- `remoteControl/status/changed`: not relevant to SocketAgent chat rendering.
- `rawResponseItem/completed`: useful for debug mode only; includes large developer/user payloads.
- `turn/plan/updated` and `item/plan/delta`: candidates for a future plan/todo style card.
- `thread/compacted` / `contextCompaction`: should connect to compact boundary UI when lifecycle parity work starts.
- approval review and server-request events: need a separate permission/request UX pass.
