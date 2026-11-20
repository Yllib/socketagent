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
  `kind:"device"` entry is refused unless the request comes from a direct
  client holding the token, which keeps access without any device.

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

The trust split (changed 2026-11-13, when the account PIN was added):
- The user's Google Drive app data folder (`appDataFolder`, scope
  `https://www.googleapis.com/auth/drive.appdata`) holds the master key
  sealed in a box. Opening the box takes the account PIN and a secret the
  relay hands over only for a right PIN.
- The vault lives on the relay as ciphertext. The relay also keeps the PIN
  record: a value that proves the PIN, the secret it hands over, and the
  count of tries.
- Nobody reads the vault with one of the three alone. Someone in the Google
  account gets 10 guesses at the PIN, then one every 24 hours. Google and the
  relay together can search the PIN offline, at the cost of one Argon2id
  stretch per guess. The relay never sees the Google identity, the PIN or
  the master key.
- An account made before the PIN has a plain key in Drive until one of its
  signed-in devices sets a PIN. Until then no new device can join it. See
  "A plain account" below.

### Keys (app only, the relay never sees any of these)

- `masterKey`: 32 random bytes made on the device that creates the account.
- `vaultKey = SHA-512("socketagent-vault-v1" || masterKey)[0..32]`, used for the
  NaCl secretbox.
- `authSeed = SHA-512("socketagent-account-auth-v1" || masterKey)[0..32]`, an
  Ed25519 seed. The public key, base64url, is the `accountId`.
- The optional recovery key is the master key itself in Crockford base32,
  grouped in fours: `SAR1-XXXX-XXXX-...`. The `SAR1` prefix is the version.
  It opens the account with no Google login and no PIN, and it changes with
  every change of master key.

The PIN is 6 to 64 printable ASCII characters with no spaces. For each new
PIN the app makes a random `salt` (16 bytes), `pinId` (16 bytes) and
`relayKey` (32 bytes), then:

```
stretched  = Argon2id13(PIN, salt, opslimit 3, memlimit 67108864), 32 bytes
authKey    = HMAC(stretched, "socketagent-pin-auth-v1")
wrapSeed   = HMAC(stretched, "socketagent-pin-wrap-v1")
pinPrivate = HMAC(wrapSeed, "socketagent-pin-key-v1" || relayKey)
pinPublic  = X25519(pinPrivate, basepoint)
```

- The relay stores `authKey` and `relayKey`. It returns `relayKey` to a
  caller who sends the right `authKey`.
- The vault's `pin` field holds `{id, salt, publicKey, setAt, setBy}`, all
  public. With `pinPublic` a signed-in device can seal a new master key for
  whoever knows the PIN. It holds nothing a guess can be tested against.
- Nothing made from the PIN is stored on a device.

The Drive file `socketagent-account-key.json` is
`{"v": 2, "body": <base64>, "sig": <base64>}`. The body is the JSON
`{account, pinId, salt, box}`, signed with the account's Ed25519 key over
`"socketagent-drive-file-v2\n" || body`. `box` is a NaCl box of
`{"t":"socketagent-pin-box-v1","masterKey"}` from a one-time sender key to
`pinPublic`, laid out as `senderPublic || nonce || ciphertext`. Writing the
file means deleting every file under the name and then creating one. The app
never writes the old `v: 1` file, which held the master key in the clear.

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
| `GET /api/account/vault` | none | `200 {version, ciphertext, updatedAt, pin}`, where `pin` is `{id, setAt, triesLeft, wrongTotal, lastWrongAt, lastUnlockAt}` or null. A moved account answers `404 {"error":"moved", version, ciphertext, wrapped}`, a deleted one `404 {"error":"gone"}`, a missing one `404 {"error":"not_found"}` |
| `PUT /api/account/vault` | `{expectedVersion, ciphertext, rotation?}` | `200 {version}`, or `409 {version}` if `expectedVersion` isn't the stored version (0 = create). `410` on a deleted account. A first write may not carry `rotation` |
| `DELETE /api/account` | none | `204`, or `409 {"error":"rotated"}` on a moved account |
| `PUT /api/account/pin` | `{expectedId, id, authKey, relayKey}` | `200 {id, setAt}`, or `409 {id}` when `expectedId` isn't the current id. `id` must be new |
| `POST /api/account/pin/reset` | none | `204`, gives the 10 tries back, at most once in 24 hours |
| `POST /api/account/pin/claim` | `{from}` | Signed by the account that `from` moved to. Carries the PIN record over |
| `POST /api/account/pin/unlock` | `{account, id, authKey}` | Not signed. `200 {relayKey}`, `403 wrong_pin` with `triesLeft`, `429 locked` with `retryAt`, `409 changed`, `404 no_pin` |

The count: 10 tries, and one comes back every 24 hours. The relay saves the
spent try to disk before it compares, and compares in constant time. A right
PIN gives all 10 back. Nothing clears `wrongTotal`, which signed-in devices
show as a notice.

A deleted account leaves a record for good, so a device that held its key
cannot bring it back. A moved account is frozen: no route changes it again.

Limits:
- `ciphertext` is base64 and at most 512 KiB decoded.
- Store at most 50,000 account records, deleted and moved ones included.
- Per address an hour: 600 signed requests and 30 `unlock` calls. Per
  account and address together: 300 signed requests an hour. Per address a
  day: 30 new accounts. An IPv6 address counts by its first 64 bits, and by
  its first 48 for new accounts.
- While the account folder holds no account file, every account route
  answers `503 storage_unavailable`, so a volume that failed to mount is
  never read as "no such account". `ACCOUNT_VAULT_FIRST_START=1` turns that
  off for an install that has never had an account.

The relay doesn't require a subscription for vault storage. It's ciphertext
only, and free direct-mode users benefit too.

The store holds `{accountId, version, ciphertext, updatedAt, createdAt}`,
plus the rotation record below, and the PIN record in a file of its own
beside it (`<hex>.pin.json`). Write each atomically with a temp file and
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

### Signing in

1. Sign in with Google and request the `drive.appdata` scope.
   - Android uses `google_sign_in`.
   - Windows uses the installed-app OAuth flow: system browser, loopback
     redirect, PKCE.
   - The OAuth client IDs are app config, not secrets.
2. Read every file named `socketagent-account-key.json` in `appDataFolder`.
   - No file: this is a first account. The user must set a PIN. The app
     makes a master key, writes the vault and the PIN record to the relay,
     then writes the Drive file.
   - One valid `v: 2` file: ask for the PIN, stretch it, send `authKey` to
     `unlock`, and open the box with the `relayKey` that comes back. The
     account ID made from the master key must equal the file's `account`.
   - A plain `v: 1` file: the device does not take the key. It tells the
     user to set a PIN on a signed-in device, restore with the recovery
     key, or start over.
3. Derive the keys and GET the vault.
4. Merge, add this device to `devices`, PUT, and adopt the computers.
5. Connect to each computer. The handshake carries this device's pass (see
   "Device passes" below), so a computer that trusts the account adds the
   key without asking. A computer that doesn't trust it yet holds the key,
   and any account device connected to it sends `device_approve` for keys
   listed in the vault's `devices`, reading the vault again first when its
   copy doesn't list the key. Either way nobody is asked, because the user
   already proved the account through Google and the PIN. The Allow prompt
   is only for keys the account doesn't list, such as a QR scan.

### Device passes

Every account device derives a pass key from the master key:
`SHA-512("socketagent-device-pass-key-v1" || masterKey)[0..32]` as an
Ed25519 seed. It is a different key from the account ID's, so computers
can't link it to the relay's records. A pass is that key's signature over
`"socketagent-device-pass-v1" || 0x00 || devicePublicKey` and travels as
`{k, s}`, both base64.

- The control lane's handshake payload carries `pass`. The computer checks
  it only for a key it has no record of. When the signature is valid for
  the key the handshake proved, and the pass key is trusted and not
  retired, a locked computer adds the key instead of holding it. The record
  gets `via: "approval"` and `vouchedBy`, the pass key that let it in. The
  key must still prove the current pairing secret. A removed key still
  waits for Allow, and a previous secret still gets silence. An unlocked
  computer adds any key that proves the pairing code, so there the pass
  does nothing and the record gets no `vouchedBy`.
- The computer keeps apart the devices a pass put on record and the rest.
  A record with `vouchedBy` came in by a pass. A record without it came in
  by the pairing code, or by Allow from a device without it.
  `device_approve` copies the approver's `vouchedBy` onto the record it
  makes, so what a pass-admitted device approves is marked like its
  approver, and so is what those approve. `device_authorize` does the same
  for the linked computer's record, so a link is marked like the device
  that made it. An AI client's sign-in is approved with `device_approve`
  too, and its record is marked like the device that approved it. Allow or
  a link from the computer itself leaves no mark. A record keeps what it
  was made with: approving or linking a recorded key again neither clears
  `vouchedBy` nor adds it.
- A computer learns a pass key from `account_pass_key {pass, retired?}`.
  A device sends it on a v2 channel after every `server_capabilities` that
  carries `accountPasses`, and again to every connected computer as soon as
  its account's master key or retired list changes. The computer takes it
  only from a recorded device on a v2 channel, and checks that before it
  verifies anything. `pass` is the sender's own pass, which shows it holds
  the key. A pass key that is a point of small order is refused, because
  signatures for those can be made up.
- A device that last synced its vault more than two minutes ago starts a
  sync as it sends `account_pass_key` after `server_capabilities`. An app
  left open may have missed a change of master key, and a computer that was
  asleep during the change learns of it from this message. The device does
  not wait for the sync. It sends the key it holds, and sends again when the
  sync brings a new key or a newly retired one. While the relay can't be
  reached it tries once in 30 seconds.
- Trust is tied to device records. The sender's record stores the pass key
  as `passKey`. The computer trusts a pass key only while at least one
  recorded device without `vouchedBy` carries it. Removing those devices
  ends the trust, so a pass key is never stronger than the devices that
  told the computer about it. A device carries one pass key.
  `device_list_result.accounts` lists each trusted pass key with the
  devices that make it trusted, and the Devices screen shows them under
  "Trusted accounts".
- A device with `vouchedBy` makes no pass key trusted. It may have come in
  by an old pass before the computer heard that key was retired, and the
  computer can't tell it from the account's real devices. Its `passKey` is
  stored on its record and no pass is checked against it. So a device let
  in by an old pass can't make up a pass key and vouch more keys in with
  it, and neither can anything it approves.
- Changing the master key (first PIN, Remove) adds the old pass key to the
  vault's `retiredPassKeys`. The device that makes the change does it, and
  so does every device that follows the move, so one updated device that
  stays is enough when the change came from an older build. Devices send
  the list with `account_pass_key`.
- A retired pass key is never trusted again, whichever recorded device
  reports it. The computer keeps every pass key it has trusted in
  `passKeys`, marked `retiredAt` once retired, and never drops one. It
  applies the whole `retired` list to those keys, however long the list is:
  the vault appends the newest key last, so a limit on the front would lose
  it behind made-up entries. Retired keys it never trusted go on
  `retiredPassKeys`, the last 256 of a message, oldest out first. No record
  goes on carrying a retired key.
- `passKeys` holds at most 256 entries. An account adds one per change of
  master key. Past that the computer takes no new pass key and answers
  `ok: false`, so that account's new devices wait for Allow. Retirements
  are still applied when the list is full. Only a device without
  `vouchedBy` adds an entry, so a device let in by an old pass can't fill
  the list.
- When a device without `vouchedBy` names retired keys, the computer also
  deletes every record those keys vouched for and closes its channels.
  Those keys do not go on the removed list, so the account's real devices
  dial again and get in with a pass from the new key. A key that a removed
  device made for itself with the old pass key is deleted with them and
  then waits for Allow. A device with `vouchedBy` deletes no record,
  whatever it reports, and its own record goes the same way as the others.
  Two such devices would otherwise delete each other in turn.
- The computer links and AI clients those keys vouched for are deleted in
  the same step. A link's channel closes and an AI client's tokens are
  revoked, so neither works from that moment. Those made by a device
  without `vouchedBy` stay. Nothing is put on the removed list, so the user
  can link the computer or sign the AI client in again.
- A deleted device also loses its push registrations, so it gets no more
  notifications. The pairing secret is not renewed, because the account's
  own devices are among the deleted and come back with it.
- The app approves a waiting device unasked only on the word of a vault it
  read in the last two minutes. With an older copy it syncs first, and
  approves only when that sync succeeded and the vault still lists the
  device. Otherwise it asks the user. An old copy may list a device the
  account has since removed, and what a code-paired device approves gets a
  record with no `vouchedBy`.
- `account_pass_key_result` carries `reason` when the key was not taken.
  On `retired` the app syncs its vault at once, once per pass key.
- What the rule costs:
  - A computer where every recorded device has `vouchedBy` trusts no pass
    key. A new device there waits for Allow. An account device gives it
    unasked when the vault lists the new key, so the new device gets in as
    soon as one is connected to that computer, and waits while none is.
    This happens to a locked computer once the devices that paired by code
    are all removed. `socketagent pair --reset` ends it: the reset deletes
    every record with `vouchedBy`, and a device that then scans the new
    code is recorded without it. Allow from the computer itself for a new
    key ends it too. Nothing a device sends takes `vouchedBy` off a record.
  - After a change of master key, the new pass key is trusted from the
    moment a device without `vouchedBy` reports it. Until then the old key
    is retired, the new one is not yet trusted, and new devices wait for
    Allow as above. Devices already on record are not touched. When that
    report comes, the records the old key vouched for are deleted and their
    devices dial again with a pass from the new key.
  - A key that came in by an old pass stays on record until a device
    without `vouchedBy` reports the retirement, or the user removes it on
    the Devices screen. On a computer where every device has `vouchedBy`,
    only the user removes it. It can vouch for nothing in the meantime, but
    it is a recorded device and can do what any paired device can.
  - A link or an AI client sign-in the user made from a pass-admitted
    device is deleted at the next change of master key that a device
    without `vouchedBy` reports, and has to be made again. Changing an
    existing link's access from a pass-admitted device is not undone.
  - A device with `vouchedBy` can remove any other device, the code-paired
    ones included. That is wanted: a pass-admitted tablet must be able to
    remove a lost phone. A key that came in by an old pass can do the same,
    and with no code-paired device left nothing deletes it until the user
    removes it or resets pairing.
  - Any recorded device can retire a pass key, and a device that came in
    by an old pass can name the account's current one. That computer then
    never trusts it again and new devices wait for Allow there until the
    next change of master key. The rule stays because it is what lets a
    pass-admitted device end trust in an old key while the code-paired
    device is away.
- An account with no PIN sends no `pass` and no `account_pass_key`. Its
  master key sits unsealed in Drive, and this keeps honest devices from
  advertising the pass key that comes from it. It is no defence against
  someone who already holds that master key. They can write a `pin` into
  the vault, which devices take when the relay has no PIN record, and the
  devices then send the pass key. They can also write their own key into
  the vault's `devices`, which a connected account device approves unasked,
  so the pass gives them nothing more. A plain account is only as safe as
  its Google account until the first PIN is set. That is a change of master
  key, and it retires the plain key's pass key.
- `socketagent pair --reset` deletes every record with `vouchedBy`:
  devices, linked computers and AI clients. It closes their channels and
  revokes the AI clients' tokens. The reset can't tell which of them came
  from an old pass. They are not put on the removed list, and the computer
  is unlocked afterwards, so the account's own devices scan the new code
  and are recorded without `vouchedBy`. Links and AI client sign-ins made
  from pass-admitted devices have to be made again. Records without
  `vouchedBy` stay as they were, less their `passKey`, so no account is
  trusted until one of its devices connects again with the new code.
  Retired keys stay retired. Only this command does it. The app's pairing
  reset renews the code and touches no record.
- Servers without `accountPasses` ignore `pass`, and older servers drop the
  pass fields from `transport.json` on load. Both fall back to approval by a
  connected device.

A signed-in device never takes a key from Drive. On each sync it asks the
relay for the vault first. It moves to a new key only when the relay's
frozen record of its account holds a handover box for it, sealed by a device
that account listed. It then checks Drive and puts the right file back if
the one there is missing, damaged or stale.

Restoring with a recovery key is steps 3 to 5, for users without their Google
account or their PIN.

### A plain account

An account from before the PIN keeps working on its signed-in devices with a
plain key in Drive. Each of those devices asks once whether to set a PIN,
and the user may say Later. Until a PIN is set, no new device can join.
Setting the first PIN is a change of master key, so devices on an older app
version are signed out until they update, and the old recovery key stops
working.

### Changing the master key

The first PIN on an existing account, Remove, and Remove with a new PIN are
one procedure with one commit point.

1. Sync the old account. Make the new master key, and the new PIN values
   when a new PIN is set. Save a pending record on the device before any
   request.
2. PUT the new account's vault, with the removed devices revoked. With a new
   PIN, also `PUT /api/account/pin` on the new account.
3. The commit: PUT the old account's vault with `rotation.newAccountId` and
   `rotation.wrapped`, a handover box for every device that stays. The relay
   freezes the old account. A handover box is a NaCl box of
   `{"t":"socketagent-handover-v1","from","masterKey"}` between two device
   keys from the vault's `devices` list.
4. Take the new key, sync the new account, and `claim` the old account's PIN
   record.
5. Write the Drive file.
6. Send `device_remove` for each removed key to every connected computer.
   That also rotates each computer's AUTH_TOKEN. Computers that are offline
   get it later: every account device, whenever it connects to a computer,
   removes any key in `revokedDevices` that the computer still lists.
7. Clear the pending record.

A device that stays finds the frozen record and its box, and follows. A
removed device finds no box and leaves without learning the new account ID.
A device that dies part way finishes or undoes the change on its next sync,
and deletes the new account only on proof that another device's change won.
A revocation always beats a device entry for the same key, whatever the
times on them say, so a removed device comes back only with a new device
key.

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

### App surface

Settings gets an Account screen with these actions:
- sign in with Google
- see devices and remove one
- sign out, which keeps this device's computers but stops syncing
- show or export the recovery key, behind the device unlock check the app
  already uses for secrets
- restore with a recovery key
- set the account PIN, or set a new one without the old one, behind the
  device unlock on Android
- see when the PIN was set, when it was last used on a new device, and how
  many wrong tries it has had

### The web app

The web app is the Flutter app built for the browser (`build-app.sh --web`).
It reaches computers only through the relay, joining as a phone with the
join headers sent as WebSocket subprotocols (`socketagent-v2` plus
`sa.<field>.<base64url>`), because browsers can't set headers.

It signs in with Google Identity Services' token client and the same "Web
application" OAuth client as Android (`SA_GOOGLE_WEB_CLIENT_ID` overrides
it). That client's Authorized JavaScript origins must list every origin
that serves the app. A browser can't restore Google without a tap, so on
the web a missing session is not an error; the actions that need Google ask
for it.

Every browser is one device. The vault holds the shared key pair:

```jsonc
"webDevice": { "publicKey": "<b64>", "privateKey": "<b64>", "createdAt": 0 },
"browsers": [{ "id": "<random per browser>", "label": "Chrome on Windows", "seenAt": 0 }]
```

- The first browser to sign in gives its own key. Later browsers take that
  key on their first sync, before any computer is added, so computers list
  one device named Web with platform `web`.
- Two browsers that make a key at once keep the older one. The other moves
  to it and forgets its own key.
- Holding the private key in the vault trusts nobody new: any account device
  can already act for the account.
- `browsers` is for the device list only. A browser marks itself seen at most
  twice a day, and entries unseen for 30 days drop off.
- Sign out all browsers is Remove for the web key. The new vault has no
  `webDevice` and no `browsers`, and the next browser to sign in makes a new
  key. Forget is refused for the web key, since every browser still holds it.

A browser forgets the account after 30 days unused. With Remember this
browser off, the keys live in session storage, and everything else is wiped
when a new browser session opens the app. The choice is offered only before
sign-in, and changing it wipes the browser's storage and reloads.

Servers before `web` saved the old `device_auth` path's platform unchecked,
and an unknown value made `devices.json` unreadable on the next start. The
app sends only `android`, `windows`, `linux`, `macos` or `ios` on that path,
and the server now maps any platform it doesn't know to `android`.

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
