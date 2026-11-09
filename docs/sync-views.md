# Sync views

Working notes for moving SocketAgent's app sync to server-owned views the app
subscribes to. The model comes from Convex's sync protocol (studied for ideas
only, no code copied; Convex is FSL-licensed).

## Why

Today the server pushes events and the app rebuilds state from them. Session
lists, running state and transcripts each arrive by several routes
(`session_list`, `status_sync`, `session_state_changed`, `session_history`,
live stream events, recovery replays), and the app reconciles them. That
reconciliation is most of the sync code: `_handleSessionHistory` is about 1500
lines, `message_reconciliation.dart` about 800. Every bug in this area so far
was two routes disagreeing, or one route arriving out of order.

With views the server computes the answer and the app shows it. The app never
merges two sources of the same state.

## Protocol

One subscription set per connection. A connection is a direct socket, or one
relay peer on a relay socket.

Client to server:

```json
{ "type": "view_set", "version": 3, "reset": false,
  "add": [{ "queryId": 7, "view": "sessions", "args": {}, "knownHash": "abc" }],
  "remove": [4] }
```

- `version` counts the client's changes to its set. The server applies a
  `view_set` only when `version` is one past the last one it applied, or when
  `reset` is true. A reset clears the set and starts over at that version.
- `knownHash` is the hash of a value the app already holds from an earlier
  connection. When it matches, the server confirms the query without sending
  the value again.

Server to client:

```json
{ "type": "view_transition", "start": 11, "end": 12, "setVersion": 3,
  "updates": [{ "queryId": 7, "hash": "abc", "value": { } }],
  "failed": [{ "queryId": 9, "error": "Unknown view" }] }
```

- Transitions chain. The app applies one only when `start` equals the `end`
  of the last one it applied. Anything else means a message went missing, and
  the app resets its subscription set, which makes the server resend
  everything (cheap, because unchanged values only cost a hash).
- An update without `value` confirms that the app's `knownHash` value is
  current.
- `setVersion` is the last `view_set` the server applied. A query added in
  that set has its first value in this transition or an earlier one.
- The server sends a value only when its hash changed for that connection.

On every new socket the app sends `reset: true` with every query it wants and
the hashes it holds. There is no other reconnect logic.

Negotiation: `server_capabilities.views.version`. Apps that never subscribe
keep getting the old broadcasts. A connection that subscribes to a view stops
getting that view's old broadcast message, so the app never sees both.

## Invalidation

Convex re-runs queries whose read set changed. SocketAgent's server is the
only writer to its own state, so it knows when something changed. Each view
has a compute function and the server calls `views.invalidate(view, key)` at
the points that already broadcast today. The hub coalesces invalidations in
one tick, computes each affected value once, hashes it and sends one
transition per connection that holds an outdated hash.

## Views

Phase 1:

| View | Args | Value | Invalidated by |
| --- | --- | --- | --- |
| `sessions` | none | `{ sessions }`, the `session_list` payload | every `session_list` broadcast |
| `status` | none | the `status_sync` payload without `type` | every `status_sync` broadcast |

Phase 2 (`views.version` 2):

| View | Args | Rows | Meta |
| --- | --- | --- | --- |
| `transcript` | `{ sessionId, fromSeq? }` | history rows from `fromSeq` on, at most 2000 (the newest) | `sessionId, fromSeq, offset, total, totalUserPrompts, taskStates, runStats, todos?, promptSuggestion?` |

A transcript is a row view. A transition carries row patches instead of the
whole page:

```json
{ "queryId": 101, "hash": "…", "meta": { }, "upsert": [ rows ], "remove": ["entryId"] }
```

- The server diffs by `entryId` + `revision` against the rows it last sent
  that connection. The hash covers the meta and every `entryId:revision`.
- On reset the app sends `knownHash` and `known: ["entryId:revision", …]`
  for the rows it holds, so a reconnect sends only rows that changed while it
  was away, and nothing when the hash matches.
- Without `fromSeq` the page starts where the resume page starts. The first
  compute pins it, and the app sends it back on reset so the range holds
  still across reconnects.
- The transcript database notifies on every committed write. Each write
  invalidates that session's view; the hub coalesces a burst into one
  transition.
- User rows store `clientMessageId`, the app's local message ID the prompt
  was sent with.

The app follows the open session: when it changes, it removes the old query
and adds a new one in the next `view_set`. Older pages the user scrolls back
to still load through `load_more_history`.

How the app shows a page during the migration: it rebuilds through the
existing history handler with `historyKind: 'view'`, reusing the row
converter, then `reconcileViewTranscript` merges the result with the chat.
The page is exact for its range, so a visible row in that range the page
lacks is dropped. Older pages stay. A row that matches a visible card reuses
that card when it is unchanged or still streaming. Messages with no server
position (live stream cards, local cards, the pending prompt) are drafts and
keep their place until a row covers them; the pending prompt matches its row
by `clientMessageId`. The app applies at most one page per 150 ms.

Live stream events stay as the draft channel. Phase 2 did not add a separate
`view_draft` message or prompt mutations: the existing events already carry
token deltas, and `clientMessageId` releases the optimistic prompt. Both can
be revisited in phase 3 once the old merge paths are gone.

## Mutations (not built)

Phase 2 matched prompts to rows by `clientMessageId` instead. The original
idea, kept for phase 3: prompts and card answers become mutations:

```json
{ "type": "view_mutation", "mutationId": "m-123", "name": "prompt", "args": { } }
```

The server replies `view_mutation_result { mutationId, ok, transition }`,
where `transition` is the `end` of the first transition that already contains
the mutation's effect. The app keeps its optimistic row (the pending user
message) until it applies that transition, then drops it. This replaces
`_pendingLocalUserMessageIds`, the protected-ID rules and the duplicate
filtering for user messages.

Existing `commandId` receipts stay; a mutation reuses its `mutationId` as the
command ID so a retried mutation after reconnect is not run twice.

## Phases

- [x] Design (this file).
- [x] Phase 1 server: view hub, `sessions` and `status` views, tests.
- [x] Phase 1 app: subscribe on `views.version >= 1`, feed values into the
  existing session list and status handlers, reset on chain break.
- [x] Phase 2 server: `transcript` row view with patches and `known` resume,
  write notifications from the transcript database, `clientMessageId` on
  user rows.
- [x] Phase 2 app: follow the open session, row store, exact reconcile of
  each page, pending prompt released by its row.
- [ ] Phase 3: delete the old routes from the app (`_handleSessionHistory`
  merge paths, `message_reconciliation.dart`, pending ID protection) and the
  server's per-session delivery acks. Blocked until a deployed app with views
  has replaced the old ones.

## Decisions

- Per-connection state lives in memory only. A server restart is a reconnect;
  the app resets and hashes make that cheap.
- Values are the existing wire payloads during the migration, so the app can
  route a view value into the handler it already has. Phase 3 can change
  shapes once old handlers are gone.
- Relay outbox does not queue view transitions. A transition to a missing peer
  is dropped; the next connection resets.
