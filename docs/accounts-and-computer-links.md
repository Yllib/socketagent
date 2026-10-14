# Device keys, accounts and computer links

Status: design for the build that started 2026-10-12. Three repos change:
`socketagent/server`, `socketagent-relay`, `socketagent-app`.

The rule behind all of it: the relay only moves ciphertext and never holds a
key or secret that would let it read data or act as a device. Anything the relay
can see (pairing tokens, room names, account IDs, blob sizes) must not be
enough to read or control anything.

## 0. The gap this closes

The pairing QR is `SA|<pairingToken>|<serverPubkey>|<port>|<AUTH_TOKEN>|<hosts>`
(older servers print `SC|<pairingToken>|<serverPubkey>`). In relay mode the phone
joins the room named by `pairingToken` and sends a plaintext `key_exchange` with
its public key. The server accepts any key. The relay sees `pairingToken` in the
upgrade URL, so the relay operator, or anyone who learns the token, can join as
a phone and drive the computer.

`AUTH_TOKEN` never reaches the relay. It travels in the QR, the LAN route, the
phone-to-desktop handoff and inside E2E-encrypted `server_capabilities`. That
makes it a good enrollment proof as long as it's only ever sent inside the
encrypted box.

## 1. Device keys on each computer (server + app)

Each app install already has one long-lived X25519 key pair (`CryptoService`,
stored in secure storage) used for every computer. That public key is the
device's identity.

### Registry

`~/.claude-assistant/devices.json` (mode 0600):

```jsonc
{
  "version": 1,
  "mode": "learning" | "enforced",
  "devices": [{
    "publicKey": "<base64 X25519>",
    "kind": "device" | "computer",
    "name": "Pixel 9",
    "platform": "android" | "windows" | "linux" | "macos" | "ios" | "computer",
    "addedAt": "<iso>", "lastSeenAt": "<iso>",
    "via": "migration" | "token" | "approval" | "link",
    // kind "computer" only, see section 3
    "access"?: { "read": boolean, "agents": boolean, "commands": boolean },
    "confirm"?: "ask" | "never"
  }],
  "revoked": ["<base64 X25519>"]
}
```

Mode:
- An existing install with no `devices.json` starts in `learning`. Every phone
  key that finishes a key exchange is enrolled with `via: "migration"`. This
  keeps old app versions working the day the server auto-updates.
- An install whose relay key pair is generated on this boot (a fresh install)
  will start `enforced`. Until an app with `device_auth` is released, fresh
  installs start `learning` too, because the released app would sit pending.
- `learning` becomes `enforced` when a device sends `device_lock`, or when a
  computer link is created on this computer (section 3). It never goes back.
- A key in `revoked` is never enrolled again by migration or by token. Only an
  explicit `device_approve` from an enrolled device can bring it back.

### Handshake (relay control and bulk lanes)

Both relay lanes (control room `pairingToken` and bulk room
`pairingToken + ":bulk:v1"`) apply the same rule. Direct LAN connections keep
authenticating with `AUTH_TOKEN` as they do today.

1. Phone sends plaintext `{type:"key_exchange", pubkey}` as today.
2. Server replies plaintext `{type:"key_exchange_ack", device:"approved"|"pending"}`.
   Old servers send no `device` field, and new apps treat a missing field as
   approved.
   - `approved`: the key is enrolled (or mode is `learning`, in which case the
     server enrolls it now). The peer is fully open, as today.
   - `pending`: the peer is held. The server sends it nothing except replies to
     `device_auth`. It is excluded from every broadcast, the outbox flush and
     `virtualWs` open-state, and any other message from it gets one encrypted
     `{type:"device_auth_result", ok:false, reason:"not_approved"}` reply.
3. A pending app sends encrypted
   `{type:"device_auth", token?, name, platform}`.
   - `token === AUTH_TOKEN` (constant-time compare) and the key isn't revoked:
     enroll with `via:"token"`, reply `{type:"device_auth_result", ok:true}`
     and open the peer exactly as an approved peer opens.
   - No token or a wrong token: reply `{ok:false, reason:"approval_required",
     code}`, where `code` is the 6-digit fingerprint below. Then notify every
     open enrolled peer with
     `{type:"device_pending", publicKey, name, platform, code}`. The pending
     peer stays held. When it gets approved, the server sends it
     `{type:"device_auth_result", ok:true}` and opens it.
   - Repeated wrong tokens: allow 5 per peer key per 10 minutes, then close.
4. Approved apps may also send `device_auth` with just `name` and `platform` to
   update their listing.

Fingerprint `code`: the first 3 bytes of SHA-256 of the raw public key, as a
decimal number mod 1,000,000, zero-padded to 6 digits. Both devices show it so
the user can match them.

Pending peer limits: at most 8 pending peers per lane. Each expires after 10
minutes, along with its `device_pending` notice (send `device_pending_cleared`).

### Messages (client to server, all encrypted, enrolled peers only)

| message | reply | effect |
|---|---|---|
| `device_list` | `device_list_result {mode, devices[], self}` | `self` is the caller's publicKey |
| `device_approve {publicKey, name?}` | `device_approve_result {ok, error?}` | enroll a pending or revoked key with `via:"approval"` |
| `device_deny {publicKey}` | `device_deny_result` | drop the pending peer |
| `device_remove {publicKey}` | `device_remove_result {ok, error?}` | see below |
| `device_lock` | `device_list_result` | mode becomes `enforced` |

`device_remove`:
- moves the key to `revoked` and closes its connections on all lanes
- rotates `AUTH_TOKEN`, so a removed device can't re-enroll with the token it
  knows. `keepToken: true` skips the rotation, for Forget below. The new token is written to `.env`, used in memory from then on, and
  pushed to open enrolled peers through the existing `direct.token` field in
  `server_capabilities`.
- Before building rotation, audit every reader of `AUTH_TOKEN`: loopback HTTP
  routes, the Codex MCP URL, worker processes and hooks that got it through the
  environment. Anything that captured the value at spawn time must keep
  working.
- A device can't remove itself through this message. Removing the last
  `kind:"device"` entry is refused.

Capability: `server_capabilities.deviceAuth = {version:1, mode}`. Changes to the
registry broadcast a fresh capabilities payload so device lists stay current.

### App work

- Send `device_auth` when the ack says `pending`, with the stored `token` for
  that computer (ServerConfig.token, from the QR or a handoff).
- Pending with no token, or `approval_required`: show a clear state on that
  computer, such as "Waiting for approval from another device. Code 123 456".
  Don't loop reconnects.
- Enrolled devices that get `device_pending` show an approval prompt naming
  the device, the computer and the code. The options are Allow and Deny.
- Each computer's settings get a Devices list: name, platform, last seen, this
  device marked, and remove with confirmation. In `learning` mode, offer
  "Only allow these devices" (`device_lock`).
- When `direct.token` in capabilities changes, update the stored
  ServerConfig.token.

## 2. Accounts (relay + app)

An account is an encrypted vault of the user's computers and settings, synced
between their devices. The user signs in with Google and nothing else. There
are no codes to scan or type. (Changed 2026-10-12 at the user's request: "id
like google sign in, not their weird code linking.")

The trust split:
- The master key lives in the user's Google Drive app data folder
  (`appDataFolder`, scope `https://www.googleapis.com/auth/drive.appdata`).
  Only this app can read that folder, using the user's Google login.
- The vault lives on the relay as ciphertext.
- Neither Google nor the relay can read the vault alone. The relay never sees
  the Google identity or the key.

### Keys (app only, the relay never sees any of these)

- `masterKey`: 32 random bytes made on the device that creates the account.
- `vaultKey = SHA-512("socketagent-vault-v1" || masterKey)[0..32]`, used for the
  NaCl secretbox.
- `authSeed = SHA-512("socketagent-account-auth-v1" || masterKey)[0..32]`, an
  Ed25519 seed. The public key, base64url, is the `accountId`.
- The optional recovery key is the master key itself in Crockford base32,
  grouped in fours: `SAR1-XXXX-XXXX-...`. The `SAR1` prefix is the version.
  It's for users who want a copy outside Google. It's never required.

### Relay API (new file `src/account-vault.ts`, JSON store like entitlements)

All requests carry `X-SA-Account: <accountId>`, `X-SA-Time: <unix ms>` and
`X-SA-Signature: base64(Ed25519 sign(authKey, message))`, where `message` is
UTF-8:

```
socketagent-account-v1
<METHOD>
<path>
<X-SA-Time>
<hex sha256 of body, empty body hashes "">
```

The relay verifies with Node's built-in Ed25519 (`crypto.createPublicKey` from a
JWK `{kty:"OKP", crv:"Ed25519", x}`). It rejects times more than 5 minutes off.

| route | body | reply |
|---|---|---|
| `GET /api/account/vault` | none | `200 {version, ciphertext, updatedAt}` or `404` |
| `PUT /api/account/vault` | `{expectedVersion, ciphertext}` | `200 {version}`, or `409 {version}` if `expectedVersion` isn't the stored version (0 = create) |
| `DELETE /api/account` | none | `204` |

Limits:
- `ciphertext` is base64 and at most 512 KiB decoded.
- Store at most 50,000 accounts.
- Rate-limit per IP and per account, the way reports are limited.

The relay doesn't require a subscription for vault storage. It's ciphertext
only, and free direct-mode users benefit too.

The store holds only `{accountId, version, ciphertext, updatedAt, createdAt}`,
plus the rotation record below. Write it atomically with a temp file and
rename.

### Vault plaintext (inside secretbox, app-defined, JSON)

```jsonc
{
  "v": 2,
  "updatedAt": "<iso>", "updatedBy": "<device name>",
  "computers": [ /* ServerConfig.toJson() minus local-only fields */ ],
  "removedComputers": ["<connectionIdentity>"],   // tombstones so merges don't resurrect
  "subscription": { "token": "...", "email": "..." },
  "devices": [{ "publicKey": "<X25519 b64>", "name": "...", "platform": "...", "addedAt": "<iso>" }],
  "revokedDevices": ["<X25519 b64>"],
  "pinnedSessions": [{ "sessionId": "...", "at": 0 }],  // chat IDs are unique across computers
  "unpinnedSessions": [{ "key": "<sessionId>", "at": 0 }],
  "projects": [{ "id": "p_...", "name": "...", "at": 0 }],  // session list groups
  "removedProjects": [{ "key": "<projectId>", "at": 0 }],
  "projectMembers": [{ "sessionId": "...", "projectId": "p_...", "at": 0 }],
  "removedProjectMembers": [{ "key": "<sessionId>", "at": 0 }],
  "preferences": { /* settings that make sense on every device */ }
}
```

Sync is read, merge, then PUT with `expectedVersion`, retried on 409. Merging
is per item, keyed by connectionIdentity for computers, publicKey for
devices, session ID for pins and project members, and project ID for
projects, with tombstones winning. Each device remembers the highest vault
version it has seen. If the relay later serves a lower one, the device warns
and doesn't write over newer local state.

`v` is the format. Format 2 added pins and projects. Builds that know only 1
refuse a newer vault and write nothing, so they can't drop fields they don't
know. From 2 on, a build keeps top-level fields it doesn't recognize and
writes them back, so a new field doesn't need another bump.

### Signing in (every device, first or not)

1. Sign in with Google and request the `drive.appdata` scope.
   - Android uses `google_sign_in`.
   - Windows uses the installed-app OAuth flow: system browser, loopback
     redirect, PKCE.
   - The OAuth client IDs are app config, not secrets.
2. Look in `appDataFolder` for `socketagent-account-key.json`, which holds
   `{v:1, masterKey:<b64>, createdAt, rotatedAt?, rotatedBy?}`.
   - If it's missing, make a master key and write the file.
   - Two first devices can race. After writing, list again and keep the file
     with the oldest `createdTime`, and delete the other.
3. Derive the keys and GET the vault. A 404 means a new account, so create it
   from this device's computers.
4. Merge, add this device to `devices`, PUT, and adopt the computers.
5. Enroll on each computer with the stored token (section 1). For computers
   with no token in the vault, this device asks to be approved, and any
   account device that is connected to that computer sends `device_approve`
   for keys listed in the vault's `devices`. That approval is automatic,
   because the user already proved the account through Google.

On every app start and every vault sync, the device re-reads the Drive file. If
the master key changed, the device moves to the new account. Drive is the
source of truth, and only Google-authenticated devices can write it.

Restoring with a recovery key is steps 3 to 5, for users without their Google
account.

### Removing a device from the account

1. Send `device_remove` for the removed key on every reachable computer. That
   also rotates each computer's AUTH_TOKEN. Computers that are offline get it
   later: every account device, whenever it connects to a computer, removes any
   key in `revokedDevices` that the computer still lists.
2. Make a new master key and write the vault under the new accountId, with
   current tokens and the removed key in `revokedDevices`.
3. Replace the Drive key file with the new key, then DELETE the old account
   on the relay.
4. Tell the user plainly that a removed device that's still signed in to their
   Google account can read the new key. To cut it off completely, they also
   remove it from their Google account. The computers refuse its device key
   either way.

### Forgetting a device

A reinstall makes a new device key, so the old install stays listed. Forget
drops it without the cost of Remove:
1. Send `device_remove` with `keepToken: true` to every reachable computer.
2. Move the key from `devices` to `revokedDevices` with `forgotten: true`, and
   sync as usual. The account key stays the same and Google isn't needed.
3. Devices that catch up later also send `keepToken: true` for a forgotten
   key.

Forget is only safe when nothing holds the old key or the computers' tokens.
For a lost device that may still have the app, use Remove.

The relay's rotation record (`rotation` on PUT) isn't used in this design.

### App surface

Settings gets an Account screen with these actions:
- sign in with Google
- see devices and remove one
- sign out, which keeps this device's computers but stops syncing
- show or export the recovery key, behind the device unlock check the app
  already uses for secrets
- restore with a recovery key

## 3. Computer links and the agent tools (relay + server + app)

A link lets an agent on computer A (the source) act on computer B (the target).
B stores what A may do and enforces it. A authenticates with its existing relay
server key pair. The phone is the only thing that creates links.

### Transport

- B makes a random `LINK_ROOM_TOKEN` (32 bytes hex, kept in `.env` like
  `PAIRING_TOKEN`). B runs a third relay connection as `role=server` on room
  `LINK_ROOM_TOKEN`. That's separate from the control and bulk rooms, so link
  peers can never receive the phone broadcast stream.
- A connects to that room as `role=phone` with
  `link_ticket=<ticket>` in place of `subscriber_token`. It sends
  `key_exchange` with A's server public key and pins B's server public key.
- B's link lane accepts a peer only if its key is enrolled with `kind:"computer"`.
  Device keys are refused on the link lane, and computer keys are refused on the
  control and bulk lanes.
- Encryption is the same NaCl box envelope as the phone lanes. Peer traffic is
  JSON only. No binary markers are needed in v1.

### Relay: link tickets

- `POST /api/computer-link {subscriberToken, linkRoom}` returns
  `{ticket, expiresAt}`. It requires the same subscription check as phone
  connections (owner and comp tokens pass). The ticket is HMAC-signed like
  transfer tickets:
  `{kind:"computer-link", roomHash: sha256hex(linkRoom), expiresAt}`, valid for
  30 days.
- The WebSocket upgrade with `role=phone&link_ticket=...` skips the
  subscriber check when the ticket verifies and `roomHash` matches the
  `token` parameter. A bad ticket is rejected with 401.
- The phone refreshes tickets: every time it connects to a source computer
  with an active subscription, it renews tickets that expire within 7 days and
  sends them with `computer_link_set`.

### Server: messages from the phone (control lane, enrolled devices only)

| message | on | effect / reply |
|---|---|---|
| `link_room_info` | B | `link_room_info_result {relayUrl, linkRoom}` |
| `device_authorize {publicKey, kind:"computer", name, access, confirm}` | B | upserts the computer entry and sets mode `enforced`; replies `device_approve_result` |
| `device_remove {publicKey}` | B | as section 1; for computers it doesn't rotate AUTH_TOKEN |
| `computer_link_set {name, targetPubkey, relayUrl, linkRoom, ticket, ticketExpiresAt, access, confirm}` | A | stores or replaces the outgoing link and (re)connects |
| `computer_link_remove {targetPubkey}` | A | drops it |
| `computer_link_list` | A | `computer_link_list_result {links:[{name, targetPubkey, online, access, confirm, ticketExpiresAt}]}` |
| `known_computers {computers:[{name, serverPubkey}]}` | any | the app sends its computer names and keys on connect, so agents can ask for access by name |

Capability: `server_capabilities.computerLinks = {version:1}`.

A stores outgoing links in `~/.claude-assistant/computer-links.json` (0600). B's
grants live in `devices.json` as `kind:"computer"` entries. `access` and
`confirm` on A are only a copy for display, because B enforces.

### Peer API (A to B, over the link lane)

Request `{type:"peer_request", id, action, args, sourceSessionId, approval?}`.
Response `{type:"peer_response", id, ok, result? , error?, approvalRequired?}`.
B can push `{type:"peer_event", event, ...}`.

| action | needs | args → result |
|---|---|---|
| `hello` | none | → `{name, access, confirm, platform, backends}` |
| `sessions_list` | read | `{limit?}` → recent sessions (id, title, backend, cwd, updatedAt, running) |
| `transcript_read` | read | `{sessionId, afterSeq?, limit?}` → entries like AgentSession tail |
| `transcript_search` | read | `{query, limit?}` → matches with session IDs |
| `run_command` | commands | `{command, cwd?, timeoutSeconds?}` → `{exitCode, signal?, stdout, stderr, truncated, timedOut}` |
| `agent_start` | agents | AgentSession start args → `{sessionId, delegationId}` |
| `agent_message` / `agent_status` / `agent_tail` / `agent_stop` / `agent_list` | agents | same shapes as AgentSession |

Commands:
- B runs them with the user's shell: `bash -lc` on Linux and macOS,
  PowerShell on Windows.
- `cwd` defaults to the home directory. The timeout defaults to 120 s and is
  capped at 600 s, and B kills the whole process tree when it runs out (see
  `posix-process-tree.ts`).
- stdout and stderr are capped at 64 KiB each.

Remote agents:
- A child started through `agent_start` is a normal session on B. The user can
  open it from the app on B, and its title shows that it came from A.
- When it finishes, B sends `peer_event {event:"agent_report", delegationId, sessionId, status, result}`.
  A delivers that to the parent session the way a local delegation result is
  delivered.
- If A isn't connected, B keeps the report pending in its delegated-agent store
  and sends it when A reconnects. A keeps a local record of every remote
  delegation, so `list`, `status` and restart recovery keep working.

### Approvals

B enforces `confirm` for every action except `hello`:
- `never`: allowed within `access`.
- `ask`: needs an approval. A `once` approval covers this exact request. A
  `chat` approval covers every request from this `sourceSessionId` for 12 hours.

Registries and link files written before `ask` existed stored `every_time` or
`per_chat`. Both load as `ask`.

When an approval is missing, B replies
`{ok:false, approvalRequired:{challengeId, action, summary, digest, expiresAt}}`.
- `digest` is the SHA-256 hex of canonical JSON
  `{action, args, sourceSessionId, sourceKey, challengeId}`.
- `summary` is human text, for example the exact command line plus its cwd.

A then asks the user in the source chat with a `computer_access_request`
card of kind `approval`. The card includes the target's name and public key, the
action, the summary, the digest and the expiry. The options are Allow once,
Allow for this chat, and Deny.

The card's `source.publicKey` is A's server key. The app puts it in the token
as `sourceKey`, so the approval names the computer that asked even when the
user answers from another computer's screen.

The app answers with an approval token: a NaCl box from the app's device key
to B's public key over
`{digest, challengeId, scope:"once"|"chat", sourceSessionId, sourceKey, expiresAt}`,
sent as `{from:<app pubkey b64>, n, c}`. A attaches it as `approval` when it
retries.

B accepts the approval only when all of these hold:
- the box opens with the `from` key
- `from` is an enrolled `kind:"device"`
- the digest matches the retried request
- it hasn't expired
- a `once` token hasn't been used before
- a `chat` token names a chat

A compromised A can't approve its own requests, because only the user's
devices hold keys B accepts.

Wire shapes for the card. These are new message types, not `question`:

```jsonc
// server → app, also saved in session history (role "computer_access") so it
// shows again when the chat is reopened, and resent on reconnect while pending
{ "type": "computer_access_request", "requestId": "...", "sessionId": "...",
  "kind": "approval" | "link",
  "source": { "name": "Dev VM", "publicKey": "<b64>" },
  "target": { "name": "Desktop", "publicKey": "<b64>" },
  // kind "approval"
  "action": "run_command", "summary": "cd ~/proj && npm test",
  "challengeId": "...", "digest": "<hex>", "expiresAt": 1760300000000,
  // kind "link"
  "access": { "read": true, "agents": true, "commands": false }, "reason": "..." }

// app → server
{ "type": "computer_access_answer", "requestId": "...", "sessionId": "...",
  "decision": "once" | "chat" | "deny" | "linked",
  "approval": { "from": "<b64>", "n": "<b64>", "c": "<b64>" } }

// server → app once answered or expired, so every device clears the card
{ "type": "computer_access_resolved", "requestId": "...", "sessionId": "...",
  "decision": "once" | "chat" | "deny" | "linked" | "expired" }
```

For kind `link`, the app sets up the link (below) first and then answers
`linked`. The tool waits until the request is answered, the challenge expires
(10 minutes) or the turn is aborted.

### Agent tools (on A)

- `Computers`:
  - `list`: linked computers with online state, access and confirm, plus known
    computers that aren't linked
  - `run {computer, command, cwd?, timeout_seconds?}`
  - `sessions {computer, limit?}`
  - `transcript {computer, session_id, after_seq?, limit?}`
  - `search {computer, query}`
  - `request_access {computer, access, reason}`: posts a `computer_access_request`
    card of kind `link` in the chat. When the user allows it, the app
    creates the link.
- `AgentSession` gets an optional `computer` argument. With it, start, message,
  status, tail, stop and list go to that computer.
- `computer` matches a link's name, case-insensitive, or its public key.
- Errors are short and actionable, for example "Desktop is offline", "Desktop
  doesn't allow commands from Dev VM. Use request_access.", or "The user
  denied this command."
- Both Claude (`claude-session.ts`) and Codex (`codex-app-mcp.ts`) get the
  tools.

### App: creating a link

From a `computer_access_request` card of kind `link`, or from computer settings ("Access from
other computers"):
1. B: `device_authorize` with the source key, access and confirm. Then
   `link_room_info`.
2. Relay: `POST /api/computer-link`.
3. A: `computer_link_set`.

Defaults: `access {read:true, agents:true, commands:true}` with
`confirm:"ask"`. Removing a link sends `device_remove` to B and
`computer_link_remove` to A. Both computers must use the same relay.

Editing a link sends `device_authorize` to B again with the new access and
confirm, then `computer_link_refresh` to A. A runs `hello` against B and
stores what B reports, along with B's platform and `run_command` shell. The
Computers list shows both, so agents know a Windows target runs PowerShell.

## Order and ownership

- Relay repo: vault API, link tickets, link-lane upgrade. Small.
- Server repo: device registry and handshake, link lane, peer API, tools,
  remote agents.
- App repo: device auth, devices UI, approvals, account, links UI, approval
  cards and question kinds.

Tests in each repo cover the parts the relay must not be able to fake:
- the handshake refuses an unknown key in enforced mode
- token enrollment works only inside the box
- approval tokens are refused with a wrong key, a wrong digest, an expired
  token or a replay
- vault signatures and CAS
- tickets for the wrong room are refused
