# Project boards

Status: built in all three repos, not committed or shipped. Three repos
change: `socketagent/server`,
`socketagent-relay`, `socketagent-app`.

## Why

A busy project runs several chats and child agents at once. Each one tracks
its work in its own task list, in prose. The open items the user cares about
are mixed in every reply:

- decisions waiting on the user, such as approving a deploy, a write to an
  outside system, or "send it" on a drafted reply
- work waiting on another person
- work an agent is still doing

A detour ("real quick, before that") leaves no bookmark, and approvals are
numbered lists that scroll away. A new chat starts with none of it.

A board is one list of work items per project, shared by every chat in the
project, with statuses and rules the user sets once. It replaces each chat's
own working-task list for chats in that project.

## What the user sees

- Boards live inside Sessions, not in a tab of their own. A project's board
  is off until the user turns it on from the project's menu in the session
  list's Projects view.
- A board shows cards by status. Phones show statuses as collapsible
  sections. Wide windows show columns, and on the desktop cards drag between
  them.
- A chat whose project has a board shows "Board" in its header, "Board 3" in
  peach when three cards wait on the user. Tapping it opens the board, with
  only the Needs you status expanded when something waits. Long-pressing a
  chat in the list offers "Open board" too.
- The user can edit statuses and rules in the app. An agent can only propose
  a rule change, and the user approves or declines it in the app.

## Words

- **Board:** the statuses, rules and cards of one project.
- **Card:** one piece of work that outlives a single turn. An agent's step
  list inside one turn stays in the backend's own todo tool, not on the board.
- **Status:** a column. Each has a `kind` that the app and the server use. The
  name is the user's to choose.

| kind | meaning | counts as "Needs you" |
|---|---|---|
| `new` | came in, nobody has looked yet | no |
| `active` | an agent is working on it | no |
| `user` | waiting on the user | yes |
| `other` | waiting on someone else | no |
| `done` | finished or dropped | no |

New boards start with five statuses, one of each kind: Inbox, Doing, Needs
you, Waiting, Done. Users add more, for example "Approved, ships with the next
release" as a second `user` or `active` status.

## Storage

The board lives with the projects, in the user's account, so it's the same on
every device and every computer. The account vault itself can't hold it:

- Only the app holds the vault key, and agents must read the board while the
  phone is off.
- The vault is one blob merged per item. Agents in several chats write cards
  at the same time, and whole-blob writes would keep colliding.

So each board is a store of its own on the relay, next to the vault.

### Keys

When the user turns a board on, the app makes a random 32-byte `boardSecret`
and stores it in a vault list of its own, merged per project on `at` like
the other lists. Turning the board off leaves a tombstone in
`removedProjectBoards`.

```jsonc
"projectBoards": [{ "projectId": "p_...",
                    "secret": "<standard base64, 32 bytes>", "at": 0 }],
"removedProjectBoards": [{ "key": "p_...", "at": 0 }]
```

The secret is not a field on the project entry because app builds that
don't know boards rewrite each project with only `id`, `name` and `at`, and
would strip it. They keep unknown top-level lists whole.

From it, with `||` meaning byte concatenation and the labels as UTF-8:

- `boardKey = SHA-512("socketagent-board-key-v1" || boardSecret)[0..32]`,
  the NaCl secretbox key for every record.
- `boardAuthSeed = SHA-512("socketagent-board-auth-v1" || boardSecret)[0..32]`,
  an Ed25519 seed (tweetnacl `sign.keyPair.fromSeed`, pinenacl
  `SigningKey(seed:)`).
- `boardId` is the Ed25519 public key in unpadded base64url, 43 characters,
  the same form as an account ID.

A sealed record is standard padded base64 of `nonce (24 bytes) ||
secretbox(plaintext UTF-8 JSON)`, the vault's format.

The relay sees the board ID, record IDs, sizes and timing. It never sees the
secret, so it can't read or write a card. This is the same split the vault
uses.

### Relay API (new file `src/project-boards.ts`)

Every request carries `X-SA-Board: <boardId>`, `X-SA-Time: <unix ms>` and
`X-SA-Signature: <standard base64 of the 64-byte detached signature>` over

```
socketagent-board-v1\n<METHOD>\n<URL path, no query>\n<time>\n<sha256 hex of the body bytes>
```

with no trailing newline. Time skew up to 5 minutes. A bad signature is
`401 {error:"unauthorized"}`, a skewed time `401 {error:"stale_time",
serverTime}`.

| route | body | reply |
|---|---|---|
| `GET /api/board/records?since=<seq>` | none | `200 {seq, records: [{id, version, seq, ciphertext}]}`: records whose `seq` is above `since`, in `seq` order. `seq` is the board's latest. A board never written answers `{seq: 0, records: []}` |
| `PUT /api/board/records/<id>` | `{expectedVersion, ciphertext}` | `200 {version, seq}`. `409 {error:"conflict", version}` when `expectedVersion` isn't the record's version (0 for a new record) |
| `DELETE /api/board` | none | `204`. Used when a board is rotated or turned off |

- A deleted board is remembered. Every later request for it answers
  `410 {error:"gone"}`, so a computer still holding a rotated secret learns
  its grant is stale and drops it.
- Record IDs match `^(config|card\.[A-Za-z0-9_-]{1,64}|proposal\.[A-Za-z0-9_-]{1,64})$`.
- Nothing is ever removed one record at a time. A deleted card is a sealed
  tombstone, `{"v":1,"id":"c_...","deleted":true,"updatedAt":<ms>}`, so a
  stale writer can't bring it back unseen.
- Conflicts: a writer that gets `409` pulls and compares. A deletion on
  either side wins. Otherwise the record with the later `updatedAt` wins.
  The app applies the same rule when a pull brings a newer version of a
  record it has an unsent edit for. The server's agent tool instead re-reads
  the card and applies the agent's change again on top.
- The relay also answers `400` (`invalid_record_id`, `invalid_since`,
  `invalid_body`), `429 rate_limited`, and `503 storage_full` when it holds
  its cap of 100,000 boards. New boards are limited to 100 a day per /48.
- Test vector: for secret bytes `00..1f` the board ID is
  `wss17kbg38xaAvyhI4f73jAG7PdZhHkbrL0YmbFGB6M`.
- `GET ?since=0` returns every record in one reply. A full board (5,000
  records of 64 KiB) would be about 440 MB, so paging with a byte cap and a
  `more` flag is needed before boards get that large.
- `seq` is a per-board counter that every write raises by one.
- Limits: 64 KiB of decoded ciphertext per record, 5,000 records per board,
  128 KiB request body. Over them: `413 {error:"too_large"}` or
  `409 {error:"full"}`.
- Boards live in a `boards` folder inside the account vault's folder, on the
  same volume. The board routes answer `503 {error:"storage_unavailable"}`
  whenever the vault's routes would.
- Rate limits like the vault's: per address before the signature check, then
  per board and address after it.
- A board doesn't require a subscription, the same as the vault.

### Who holds the secret

- **Devices** read it from the vault like any other project field.
- **Computers** get it from the app over the existing end-to-end channel. The
  app sends the full set for that computer, every time something changes and
  on every connect:

  ```jsonc
  { "type": "project_board_grants",
    "boards": [{ "projectId": "p_...", "name": "Mobile app",
                 "secret": "<standard base64>", "sessionIds": ["..."] }] }
  ```

  Each entry is a project with a board and at least one chat on that
  computer, with those chats' IDs. The server replaces what it held with this
  list, so a project left out loses its board on that computer. The server
  keeps the list in `project-boards.json` in its data folder, mode 0600.
- That grant is also how a server learns which of its chats belong to which
  project. Today only the app knows.
- **Child agents** started by a chat in a board project join the parent's
  project on that computer at once. The server sends
  `{ "type": "project_board_member", "projectId", "sessionId" }` and the app
  files the child in the vault, which leads to a new grant.

Rotation is not built yet. A computer whose last chat leaves the project
loses its grant at once, but it has seen the secret and could keep using it
until the board is rotated. The plan: when a computer leaves the account,
or its last chat leaves the project, the app makes a new secret, copies
every record to the new board, deletes the old one, and grants the new
secret to the computers that remain. Turning the board off and on again
does the same by hand today, minus the copy.

### Plaintext

All times are Unix ms. Unknown fields are kept when a record is rewritten.

```jsonc
// config
{
  "v": 1,
  "statuses": [
    { "key": "inbox", "name": "Inbox", "kind": "new",
      "meaning": "Came in from a ticket or message. Nobody has looked yet." }
  ],
  "rules": "<plain text the user writes: when to make a card, when to move it, what a good card says>",
  "updatedAt": 0, "updatedBy": "<device name or session ID>"
}

// card.<id>
{
  "v": 1,
  "id": "c_...", "title": "...", "status": "<status key>",
  "notes": "<short: where this stands now>",
  "detail": "<Markdown, up to 48 KiB: everything the user needs to decide without leaving the card, such as the ticket's full request text, the drafted reply, the proposed release notes>",
  "waitingOn": { "kind": "user" | "person" | "agent", "name": "..." },
  "ask": { "kind": "approve" | "send" | "decide" | "answer", "text": "<the exact question>", "sessionId": "..." },
  "links": [{ "kind": "session" | "ticket" | "thread" | "url", "ref": "...", "label": "..." }],
  "history": [{ "at": 0, "by": "<'You', or the session's title>", "from": "inbox", "to": "waiting", "why": "..." }],
  "createdAt": 0, "updatedAt": 0
}

// proposal.<id>
{ "v": 1, "id": "r_...", "by": "<session ID>", "byName": "<session title>", "why": "...",
  "config": { /* full proposed config */ }, "state": "open" | "approved" | "declined", "at": 0 }
```

Status kinds are `new`, `active`, `user`, `other` and `done`. `history`
keeps the last 50 moves. A card in a `done` status more than 30 days is
hidden from lists by default, but stays on the board. A board with no
`config` record uses the five default statuses.

## Server

### Sync

`ProjectBoardStore` keeps a local copy of each granted board in
`boards/<projectId>/` in its data folder. It pulls changes before every turn
in a board chat and before every write. Writes go through an outbox, so a
chat keeps working while the relay is unreachable. On a `409` the store
rereads the card and applies the change again. A move is checked against the
card's new status, and if it no longer fits, the agent gets an error that
says who moved it and where.

### Rules reach every chat

At the start of each turn in a chat with a board, the server compares a
digest of the board config with the digest it last gave that chat. When they
differ, it adds a `<socketagent_project_board>` block with the statuses and
rules:

- Claude: on the user message that starts the turn.
- Codex: through `injectDeveloperInstructions`, the way
  `codex-instruction-delivery.ts` already handles changed guidance.

The digest is saved per session, so a rule changed in one chat reaches every
chat in the project on its next turn, once, and survives a restart.

### Agent tool

`ProjectBoard`, one tool with actions. It's added only to chats whose project
has a board, and `TaskBatch` is removed from those chats so work is tracked
in one place.

| action | does |
|---|---|
| `list` | card summaries without `detail`, filtered by status key, kind, `waitingOn` name or text |
| `get` | one card in full, with `detail` and history |
| `create` | a new card. Any status; a `user` status needs an `ask` |
| `update` | title, notes, `detail`, links, `waitingOn`, `ask`. A field left out is unchanged; `null` clears it |
| `move` | a new status plus a one-line `why`. Moving into a `user` status needs an `ask`, given in the same call or already on the card |
| `delete` | writes a tombstone. For cards made by mistake; finished work moves to a done status |
| `propose_rules` | a full new config plus `why`. It becomes an open proposal the user approves in the app |

The server enforces the structure: known status keys, an `ask` on every
`user` card, size limits. Judgment calls, such as when something deserves a
card, stay in the rules text. History entries name the chat by its title.

The board block tells the agent, besides the statuses and rules, that a card
waiting on the user carries everything needed to decide in `detail`: the
ticket's full request, the full drafted message, the full proposed text. The
user approves from the card without opening the chat.

## App

`BoardStore` (`lib/services/board_store.dart`) holds each board as the
relay's records plus an outbox of local edits, cached in
`project-boards-v2.json`. Secrets live in secure storage and are loaded
before the first account sync reads them. Edits show at once and go out
400 ms later; every board is pulled every 20 s while the app is in front
and when its screen opens. A cloud icon on the board shows edits the relay
hasn't taken yet. `ChatProvider` sends `project_board_grants` to each
connected computer on connect and whenever the secrets, the projects or
the session list change, skipping a message identical to the last one
sent. `project_board_member` files the child chat in the parent's project.

- **Getting to a board:** the chat header's Board control, "Open board" in
  a chat's long-press menu, and the project's menu in the Projects view
  ("Open board", or "Turn on board" when signed in and the project has
  none). `BoardScreen.open` opens on Needs you when cards wait.
- **Board:** a count of cards that need the user (tapping it narrows a phone
  board to those), the open count, and a bar with one coloured segment per
  status. Each status kind has one colour in both themes: new lavender,
  active blue, Needs you peach, waiting mauve, done green.
- **Cards:** a 3 px edge in the status colour, the title, the ask (or the
  first line of the notes), who it waits on, its chat, and how long it has
  been in its status. Tapping opens it in place: the ask with its button,
  notes that edit in place, links (a chat link opens that chat), the last
  four moves with their reasons, Move, Edit and Done. Right-click or
  long-press opens the same moves as a menu.
- **Ask button:** opens the chat that asked with a reply already in its
  message box ("Approved: <title>"). The user sends it, so approving still
  happens in that chat in the user's own words, and the agent's approval
  rules stay in force.
- **Editor:** title, status, notes, the ask (kind, exact question, the chat
  it was asked in), waiting on (a person or an agent), links and linked
  chats.
- **Board settings:** a screen listing the statuses (rename, meaning,
  kind, reorder, delete when empty) and the rules text. Open proposals show
  above it with who suggested it, why, the proposed statuses (new ones in
  green, removed ones listed), the new rules, and Approve or Decline. The
  board shows "An agent suggests a rule change" while one is open. Intake
  keys are listed below the rules (see Intake).
- The board menu can remove all cards or turn the board off. There are no
  sample cards: on a synced board, agents would read them as real work.

## Intake from outside services

An outside service, such as the Feedback Hub, can add items to a board
without being able to read it. The user makes an **intake key** for the
board in the app and pastes it into the service. The service seals each
event to the board, the relay stores it, and a computer with the board's
grant turns it into a card or updates the card it already made.

### Keys

- **Board box key.** `boxSecret = SHA-512("socketagent-board-box-v1" || secret)[0..32]`,
  used directly as an X25519 secret key (`nacl.box.keyPair.fromSecretKey`,
  pinenacl `PrivateKey`, PHP `sodium_crypto_box_publickey_from_secretkey`).
  Its public key is `boxKey`.
- **Intake key.** 32 random bytes made by the app, used as an Ed25519 seed.
  `intakeId` is the base64url-nopad public key (43 characters).
- **Intake token**, the one string the user pastes into the service:
  `sa-intake-v1.` followed by base64url-nopad of the UTF-8 JSON
  `{"relay":"https://relay.jarofdirt.info","seed":"<std base64, 32 bytes>","boxKey":"<std base64, 32 bytes>"}`.
  The service never sees the board secret, the board key or the board ID.
- **Intake box**, how a service seals one item:
  `base64( ephemeralPublic(32) || nonce(24) || crypto_box(json, nonce, boxKey, ephemeralSecret) )`,
  with a fresh X25519 key pair and random nonce per item. This is plain NaCl
  `box`, so tweetnacl, pinenacl and PHP sodium all do it without sealed-box
  support. Members open it with `boxSecret`.

### Relay API

| Route | Signed by | Body | Answers |
|---|---|---|---|
| `PUT /api/board/intake-keys/<intakeId>` | board | `{}` | `204`, also when already registered. At most 20 per board: `409 {error:"full"}`. A key another board holds: `409 {error:"taken"}` |
| `DELETE /api/board/intake-keys/<intakeId>` | board | none | `204`, also when it wasn't registered |
| `POST /api/board/intake` | intake key | `{ciphertext}` | `201 {id, seq}`, where `id` is the full record ID `intake.<22 chars>` |

- Intake requests carry `X-SA-Intake: <intakeId>`, `X-SA-Time` and
  `X-SA-Signature` over the same message as board requests with the context
  `socketagent-board-intake-v1`. An unknown or revoked intake key gets
  `401 {error:"unauthorized"}`. Deleting a board drops its keys, so its
  services get 401 too; `410` shows only if a crash left a key behind.
  A skewed clock gets `401 {error:"stale_time", serverTime}`.
- The relay stores each item as a new record `intake.<id>` (the relay picks
  `id`: 22 random base64url characters) at version 1, raising the board's
  `seq` like any write. It counts toward the 5,000 records and the 64 KiB
  limit. Rate limit per intake key: 60 a minute. Each address may make 600
  refused intake requests an hour, checked before the signature, so one
  service posting for many boards isn't throttled.
- Members read intake records through the normal `GET /api/board/records`.
  Version 1 is an intake box; any later version is a member's secretbox
  record. Members may `PUT` an `intake.<id>` record (expected version 1) but
  never create one (`403 {error:"forbidden"}`); an intake key can't read or
  overwrite anything.
- Record IDs now match
  `^(config|card\.[A-Za-z0-9_-]{1,64}|proposal\.[A-Za-z0-9_-]{1,64}|intake\.[A-Za-z0-9_-]{1,64})$`.
- `DELETE /api/board` also drops the board's intake keys. On disk a key is
  `boards/<board hex>/intake-key.<intake hex>` plus the lookup
  `boards/intake/<intake hex>` holding the board ID; it works only while
  both exist.

### Item plaintext

```jsonc
{ "v": 1,
  "source": "Feedback Hub",            // shown as who made or moved the card
  "ref": "electrified-marina-external#123", // stable per item in the service
  "event": "opened" | "updated" | "closed" | "reopened",
  "title": "...",                      // opened: required; updated: optional
  "detail": "...",                     // Markdown, the full current text; replaces the card's detail
  "note": "...",                       // one line: what happened; becomes notes and the move's why
  "url": "https://...",                // link back to the item in the service
  "at": 1795000000000 }
```

### Turning items into cards (server)

- The card ID is `h_` plus the first 24 hex characters of
  `SHA-256(source + "\n" + ref)`, so every event for one item finds its card.
- `opened`, or any event whose card doesn't exist: create the card in the
  first status of kind `new`, with title, detail, notes = note, one link
  `{kind:"ticket", ref:url or ref, label:source + " " + ref}`, and a history
  entry by `source`.
- `updated`: set the fields it carries (title, detail, notes = note).
- `closed`: move to the first status of kind `done` with why = note.
- `reopened`: move a card in a done status to the first status of kind `new`.
- The card keeps the IDs of the last 50 items applied to it in an `intake`
  field, and an item already in that list is skipped, so two computers
  applying the same item change the card once.
- After applying, the computer marks the item handled by writing
  `intake.<id>` at expected version 1 with the secretbox record
  `{"v":1,"id":"<id>","handled":true,"at":<ms>}`. A `409` means another
  computer handled it. An item that doesn't open or doesn't parse is marked
  handled with `"error"` set, so it isn't retried forever.
- Only computers holding the board's grant do this. Items wait on the relay
  while none is online.

### App

The board's settings list its intake keys (label, created) with Revoke.
"New intake key" asks for a label, registers the key, adds
`{id, label, createdAt}` to an `intakes` list in the `config` record, and
shows the token once with a Copy button. Revoke removes it from the relay
and from `config`.

## Sweeps

A sweep is a scheduled task in a project. A new `projectId` field on
scheduled tasks makes each run a fresh chat filed in the project, so it gets
the board and its rules like any other chat. An example the user would
write:

> Every two hours, go through the cards in Waiting. Open each card's linked
> thread. When the person has answered, move the card to Needs you with what
> they said.

Nothing about a particular outside service is built into boards. Which
threads to check and how to read them belongs in the user's rules and
schedules.

## Phases

1. Done: relay board store, app sync and grants, proposals, server tool and
   rule delivery.
2. Rotation when a computer leaves (above).
3. Paging for `GET /api/board/records`.
4. Scheduled tasks with a `projectId`.
5. Use it on one real project for a week before changing defaults.

## Decisions

- **Storage with the projects (2026-11-18).** The user: "If we tie it to
  projects then it has to be stored where projects are or else it's going to
  get confusing because there's going to be an invisible separation that
  people don't understand. I am not the only user of Socket Agent."
- **Native, not a plugin (2026-11-18).** The plugin API can add tools and
  context but can't see projects or add app screens.
- **Agents propose rule changes, the user approves them.** Otherwise rules
  drift between chats.
- **Ask buttons send a message, they don't act.** The agent stays the one
  that performs the write or send, with the user's words in its chat.
- **Boards need an account (2026-11-18).** Projects already do. Without one,
  the project menu says "This feature requires being signed in."
- **Every computer with a chat in the project gets the board key
  (2026-11-18).** The user: "That would be what users would expect."
- **The name is Board (2026-11-18).**
