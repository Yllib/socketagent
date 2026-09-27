# TypeScript safety migration

Started 2026-09-27. Work stays local on master until deployment is requested.

## Goal and scope

Remove explicit and inferred `any` from our code, validate external data as
`unknown`, and replace narrowing casts with checked types. Do not change product
behavior just to satisfy a type checker. Preserve older supported provider formats.

The enforced scope is `server/src/**/*.{ts,mts}`, JavaScript/MJS under
`server/test` and `server/scripts`, and the ESLint configuration. Dependencies,
build output, ignored private plugins, the separate relay repository, and scripts
outside `server` are not covered yet. Flutter is Dart and needs a separate audit.

Existing functional changes in both repositories predate this migration. Keep
them intact and distinguish them when staging. No app changes or deployment are
part of this batch. The server's starting HEAD is `64a82b1`.

## Checks and baseline

From `server`:

```sh
npm run build
npm run type-safety
npm run type-safety:report
npm run type-safety:prune
npm test
```

`npm test` builds, checks type safety, then runs both JS and MJS tests. The pre-push
hook also builds and checks type safety when dependencies are installed. Hooks
must be enabled with `git config core.hooksPath .githooks` in each pushing checkout.
Run the build first in fresh checkouts: existing JS tests import `dist` modules.

Client-message runtime schemas derive from `protocol.ts` with
`npm run protocol:generate`. Type-safety checks regenerate in memory and reject
stale checked-in schemas. Known fields are validated; unknown future fields are
retained. Packed binary uploads are decoded separately from JSON messages.

ESLint checks explicit `any`, unsafe assignments, arguments, calls, member access,
returns, narrowing assertions, and TypeScript suppression comments. Inline ESLint
configuration cannot disable these checks. TypeScript strict compilation remains
enabled for production source. Existing JavaScript tests have typed linting but
are not yet subject to full `checkJs` compiler diagnostics.

The baseline identifies diagnostics by file, rule, and a hash of the offending
source line and range, with multiplicity for duplicates. It is not a per-file
error budget. Adding an unsafe expression elsewhere fails even if another was
removed. Moving unchanged lines within a file does not require baseline churn.
Changing an unsafe line requires fixing its diagnostics, not refreshing allowances.

`type-safety:prune` refuses new violations and only removes resolved entries.
Normal checks fail if resolved entries remain, so old allowances cannot linger.
The one-time bootstrap uses exclusive file creation and refuses to overwrite an
existing baseline. Do not manually grow the baseline or disable rules. Changes to
the check configuration and baseline still require code review.

Initial inventory: 1,503 explicit `any` nodes in 42 TypeScript files; 664
unannotated declarations inferred as `any`; 43 double assertions. These are
different, overlapping measurements, not additive totals. The initial ESLint
baseline contained 9,349 diagnostics across production code, scripts, and tests.
Use the report command for current rule and file counts.

## Batches

| Batch | Status | Scope and exit condition |
| --- | --- | --- |
| Enforcement | Implemented | Checks in tests and pre-push; shrinking source-specific baseline; test rejection of new debt and bypasses. |
| Codex transport, rewind, sign-in | Complete | Raw RPC responses stay unknown; validate consumed rewind, compaction, migration, and login fields. No baseline entries in these modules. |
| Generated Codex contracts | Complete | Codex 0.157.1 snapshot, 34 typed request/response pairs, JSON schemas, manifest/hash checks, runtime response decoder. Goal APIs use generated validation; remaining responses migrate with adapters. |
| Provider adapters | Complete | Codex and Claude sessions, stream identity, native history, elicitation, and interactive answer helpers have zero diagnostics. Test streaming, completion, approvals, cancellation, and subagents. |
| Persisted history | Complete | SQLite rows, history JSON, session metadata, task lists, native history readers, and transfer bundles are validated. `session-store.ts`, `transcript-database.ts`, and `session-transfer.ts` have zero diagnostics. Test recovery, pagination, rewind, and archive reads. |
| WebSocket routing | Complete | Generated incoming-message validation, typed routing and provider dispatch; `index.ts` and relay client have zero diagnostics. |
| Remaining code and tests | In progress | MCP tools, helpers, JS fixtures and scripts. Plugin loading and hook results are validated, including private SDK copies. Audit private plugin implementation debt separately. |
| Final enforcement | Pending | Zero baseline; remove baseline handling; review lingering assertions and inferred unsafe types, not just the explicit-any count. |

Work shared definitions before consumers to avoid repeated edits. Keep each batch
reviewable and test it before moving to the next. If work is delegated later,
assign nonoverlapping file ownership and give shared protocol types one owner.

## First batch details

- Removed the generic RPC return assertion. A caller cannot make an unvalidated
  response typed just by supplying a generic argument.
- Rewind validates native turn IDs, prompt fields, and pagination cursors before
  relying on them; malformed input cannot authorize truncating local history.
- Compaction validates relevant events and retains matching-thread completion
  behavior. Additional provider fields are accepted.
- Browser sign-in validates both the login response and completion event.
- Added boundary and enforcement tests using typed imports, without new baseline
  allowances. Existing provider behavior tests remain in place.

The first batch's targeted validators describe only fields consumed by those
boundaries. Generated contracts now complement them. Staged backend-update
activation checks remain separate work; this migration adds reproducible
`npm run codex:generate-contracts` and `npm run codex:check-contracts` commands,
not a new auto-update policy.

## Local checkpoints

- Server `735ae1c`: pending reliability, resume, and rewind UX work preserved.
- App `d49b94d`: pending voice, auth, and reliable delivery work preserved.
- Server `dbd064c`: initial type-safety gate and Codex boundary migration.
- Server `0b98c6d`: generated contracts. Request
  aliases now follow the exported API. Config values use JSON types, collaboration
  mode settings validate their supported values, and raw results remain unknown
  unless a runtime decoder validates them. Tests that inspect collaboration
  settings now select a model, as the real send path does.
- Server `f6d2a62`: Codex adapter foundations. Typed existing wire events, validated account and
  model records, subagent reconciliation, error handling, and file-change helpers.
  Session delivery preserves its caller's message type across acknowledgement,
  retry, and replay. Plugin session sends now use the declared server protocol.
- Server `a123dbe`: Codex native event translation. No remaining unsafe types or assertions in
  `codex-session.ts`. Provider data is checked before use, including supported
  legacy event shapes. Rate-limit normalization is clean too. App tool callbacks
  now preserve `ServerMessage` and `HistoryEntry`; secure-input messages have a
  concrete protocol type. Effort names advertised by Codex remain extensible,
  following the generated provider type instead of asserting a fixed enum.
- Server `1fefd9d`: Codex history and elicitation helper validation.
- Server `b652097`: Claude foundations; declared outgoing SDK-derived protocol messages, typed
  delivery/replay, workflow/task reducers, async input queue completion, and
  usage/MCP/rewind results. File rewind callers now distinguish provider result
  shapes. Main Claude stream handling was completed in the next checkpoint.

## Validation log

- Initial focused run: 33 tests passed for client transport, rewind, browser auth,
  malformed data, compaction lifecycle, and baseline enforcement.
- Final `npm test`: build and type-safety check passed; 536 tests passed, one
  skipped, zero failures. Output: `/tmp/sa-type-migration-full-tests.log`.
- Baseline reduced from 9,349 to 9,266 diagnostics, a reduction of 83. Explicit
  `any` reduced from 1,503 to 1,486. These are overlapping measures, not totals
  to add together. All four first-batch source modules have zero diagnostics.
- `git diff --check` passed in both repositories. No push, deployment, server
  restart, or app rebuild was performed.
- Contract checkpoint: build, lint, exported-protocol drift check, and full suite
  passed; 539 tests passed, one skipped. Baseline is 9,258 diagnostics.
  Output: `/tmp/sa-contract-full-tests.log`.
- Adapter foundations: build and type-safety checks passed; full suite 539 passed,
  one skipped. Baseline reduced to 8,354 diagnostics, 904 fewer than the previous
  checkpoint. Output: `/tmp/sa-adapter-foundation-full-tests.log`.
- Codex native translation: full suite 539 passed, one skipped; focused native,
  approval, subagent, delivery, rate-limit, and task tests 91 passed, one skipped.
  Output: `/tmp/sa-codex-native-full-tests.log` and `/tmp/sa-codex-native-tests.log`.
  Final model/instruction checks: nine passed, one skipped. Baseline: 7,668.
- Codex history/elicitation helpers: build and lint passed; 19 focused tests
  passed for elicitation, history, and native subagent lifecycle. Both helpers
  have zero diagnostics. Baseline: 7,416.
- Claude foundations: build/lint passed; full suite 539 passed, one skipped.
  Baseline: 6,953. Output: `/tmp/sa-claude-foundation-full-tests.log`.

- Claude stream checkpoint: SDK discriminated events and hooks replace untyped
  payloads. Tool input and legacy output fields are validated before use. SDK
  elicitation responses use the MCP response schema. Interactive cards use the
  server protocol. Descriptive delivery IDs map to deterministic native UUIDs;
  original client IDs remain on delivery receipts/history and UUIDs stay intact.
  The Claude adapter and stream identity helper now have zero diagnostics.
- Claude stream validation: build/lint passed; 107 focused tests passed; full
  suite 540 passed, one skipped. Baseline: 5,617 (1,336 removed this checkpoint).
  Output: `/tmp/sa-claude-provider-full-tests.log`.

- History reader checkpoint: SQLite row schemas replace narrowing assertions;
  stored HistoryEntry schemas validate optional/nested fields and retain future
  fields. Missing legacy text/timestamp becomes an empty display value, never an
  invented date. Snapshot/archive readers validate arrays without dropping bad
  entries. Existing snapshot recovery remains in place.
- History reader validation: 43 focused tests and the full suite passed (543
  passed, one skipped). Read-only validation of 25,000 recent local database
  entries found zero failures. Baseline: 5,548. Output:
  `/tmp/sa-history-reader-full-tests.log`.

- Server `ffc85f1`: transcript SQLite/history schema checkpoint.
- Session store checkpoint: typed metadata and task persistence, checked native
  JSONL/SQLite reads, opaque provider context snapshots, typed SDK debug events,
  and position assignment without casts. Retired `exec` metadata normalizes to
  `app-server`, matching existing archive restoration. Transfer bundle validation
  checks nested fields before destination writes, retains failed bundles, and
  defaults omitted legacy auxiliary arrays. Protocol capability guards are clean.
- Session store validation: 138 focused tests, 12 transfer/schema tests, and a
  malformed-bundle import test passed. Full suite: 546 passed, one skipped.
  All 154 local session metadata records validated read-only. Baseline: 5,003.
  Output: `/tmp/sa-session-store-full-tests.log`.

- Server `0feb23b`: session metadata/native readers/transfer validation checkpoint.
- Routing foundations: one ClientTransport contract covers direct, relay, and
  headless delivery. Provider constructors and plugin APIs accept that contract;
  server-owned runtime metadata is declared separately. Live-backend and auth
  state are exposed through getters instead of private-property casts. Hard abort
  preserves its concrete target type through lookup/removal, so abort groups no
  longer masquerade as full Session instances. SDK fork uses a typed lazy import.
- Routing foundation validation: 32 focused delivery/lifecycle tests passed;
  full suite 546 passed, one skipped. Baseline: 4,644. Output:
  `/tmp/sa-routing-foundation-full-tests.log`.

- Server `ef061cd`: typed transports/runtime metadata/abort group checkpoint.
- Client protocol checkpoint: generated JSON schemas validate direct and relay
  commands at ingress. Discriminant lookup validates one command at a time.
  Legacy directory listing now has a declared contract. Relay peer identity is
  transport-owned WeakMap metadata, not a field supplied by the client. Relay
  control messages, public keys, socket data, and outgoing JSON are narrowed;
  TCP keepalive uses the WebSocket upgrade event. Relay client has zero diagnostics.
- Client protocol validation: nine focused tests passed, including encrypted
  malformed-then-valid traffic, peer routing, and binary upload delivery. Full
  suite: 548 passed, one skipped. Baseline: 4,545. Output:
  `/tmp/sa-client-protocol-full-tests.log`.

- Server `eaaea43`: generated client validation and relay boundary checkpoint.
- Command routing checkpoint: handlers use the validated ClientMessage union;
  missing resume metadata, download version, and force-update fields are declared.
  Prompt priorities and skill formats/scopes have their actual supported types.
  Native-history helpers carry HistoryEntry arrays; errors remain unknown and
  are checked before reading messages or provider flags. Work Review commands
  use service contracts. Direct upgrade authentication uses server-owned metadata.
- Command routing validation: full suite 548 passed, one skipped. Baseline:
  2,487, including 311 remaining diagnostics in index.ts (provider settings,
  durable tool delivery, HTTP endpoints, and update helpers). Output:
  `/tmp/sa-router-full-tests.log`.

- Server `b69fbec`: validated routing and error boundaries checkpoint.
- Provider settings/tool delivery checkpoint: index.ts has zero diagnostics.
  Work Review delivery uses service records; monitor events and plugin contexts
  retain their message types. Claude exposes context usage without private-field
  access; provider-specific settings are narrowed before dispatch. Legacy Claude
  `superYolo` maps to `bypassPermissions`, and old rollback `system` notes load as
  notifications. Reset consumption validates the generated Codex response.
- Dynamic plugin exports and hook results are validated. MCP configs accept real
  CJS/ESM instances and SDK copies found in a plugin's loaded dependency graph;
  the ESM interop source is included in enforcement. Both existing private plugins
  passed read-only configuration validation without auth/tool execution.
- Validation: 43 focused tests and 11 compatibility tests passed; full suite 553
  passed, one skipped. Baseline: 2,043. Output:
  `/tmp/sa-tools-full-tests.log`. No deployment or live server restart.

- Server `3017c32`: provider settings, durable tool delivery, and plugin boundary checkpoint.
- Tool/helper checkpoint: app-tool handlers and Codex MCP registrations use
  their schema-inferred input and declared output types. Speak messages now have
  a protocol declaration. Stored HTML plans, skill marketplace metadata, image
  comparison JSON, credential records, and restart journals validate incoming
  data. OAuth token responses are checked before writing credentials.
- Validation: full suite 553 passed, one skipped. Baseline: 1,729. Output:
  `/tmp/sa-helper-full-tests.log`. All changes remain local.
