# TypeScript safety migration

Started 2026-09-27. Work stays local on master until deployment is requested.

## Goal and scope

Remove explicit and inferred `any` from our code, validate external data as
`unknown`, and replace narrowing casts with checked types. Do not change product
behavior just to satisfy a type checker. Preserve older supported provider formats.

The enforced initial scope is `server/src/**/*.ts`, JavaScript/MJS under
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
| Provider adapters | In progress | Codex session, native history, and elicitation helpers have zero diagnostics. Remaining work: Claude adapter. Test streaming, completion, approvals, cancellation, and subagents. |
| Persisted history | Pending | Validate JSON and database rows, including supported legacy records, in `session-store.ts` and `transcript-database.ts`. Test recovery, pagination, rewind, and archive reads. |
| WebSocket routing | Pending | Validate incoming messages and narrow discriminated protocol types in `index.ts`. Test send, retry, receipt, reconnect, and session routing. |
| Remaining code and tests | Pending | MCP tools, plugins API, relay client, helpers, JS fixtures and scripts. Audit additional repositories and ignored private plugins separately. |
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
