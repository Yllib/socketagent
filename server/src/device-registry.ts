import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as nacl from "tweetnacl";
import { z } from "zod";
import { errorMessage } from "./value-guards";

/**
 * The computer's transport state, `transport.json` in the data folder (wire
 * spec section 7.1): the pairing secrets, the relay owner key, the lock, and
 * the record of keys that paired. Phones and desktops are "device" keys;
 * other computers that may act here through a link are "computer" keys; AI
 * clients signed in through the AI connector are "connector" keys, which are
 * random IDs rather than X25519 keys. The relay never sees this file.
 *
 * The record says who paired. It is not the door: a device gets a channel by
 * proving the pairing secret in the handshake, and the lock only decides
 * whether a new key that did so waits for Allow.
 */
/** "connector" is an AI client (Claude, ChatGPT) that signed in through the AI connector. */
export type DeviceKind = "device" | "computer" | "connector";
export type DevicePlatform = "android" | "windows" | "linux" | "macos" | "ios" | "web" | "computer" | "connector";

/** The platforms an app may name for itself. "web" is the browser app, one device per account. */
export const APP_PLATFORMS: readonly DevicePlatform[] = ["android", "windows", "linux", "macos", "ios", "web"];

/**
 * An app's claimed platform, or "android" for anything else. The state file
 * rejects an unknown platform on load, so nothing unchecked may reach it.
 */
export function appPlatformOf(value: unknown): DevicePlatform {
  return APP_PLATFORMS.find((candidate) => candidate === value) ?? "android";
}
export type DeviceVia = "migration" | "token" | "approval" | "link" | "connector";
/** What apps are told: "enforced" when the computer is locked, else "learning". */
export type RegistryMode = "learning" | "enforced";
export type ComputerConfirm = "ask" | "never";
/** 1 until the key completes a v2 handshake. A key at 2 is refused the old path. */
export type DeviceTransport = 1 | 2;

export interface ComputerAccess {
  read: boolean;
  agents: boolean;
  commands: boolean;
}

export interface DeviceEntry {
  publicKey: string;
  kind: DeviceKind;
  name: string;
  platform: DevicePlatform;
  addedAt: string;
  lastSeenAt: string;
  via: DeviceVia;
  transport: DeviceTransport;
  /** Devices only: the newest pairing secret this key has proved or been handed. */
  secretId?: number;
  /** Computers only, once the link has moved to v2. Never sent to a device. */
  linkSecret?: string;
  access?: ComputerAccess;
  confirm?: ComputerConfirm;
  /** Unix ms when a computer link ends. The entry is dropped after that. */
  expiresAt?: number;
  /**
   * Devices only: the account pass key this device proved it holds, base64
   * Ed25519. The computer trusts a pass key only while a recorded device
   * with no `vouchedBy` carries it here, so removing those devices ends the
   * trust.
   */
  passKey?: string;
  /**
   * Only for a key a pass put on record. On a device it is the pass key
   * whose pass let it in on a locked computer, or the `vouchedBy` of the
   * device that approved it. On a linked computer or an AI client it is the
   * `vouchedBy` of the device that made the link or approved the sign-in.
   * A key that came in by the pairing code, or by Allow or a link from a
   * device without this field, has none.
   *
   * A device with this field makes no pass key trusted and deletes no
   * record. A record with it, of any kind, is deleted when a device without
   * the field says the account retired that pass key, and when pairing is
   * reset.
   */
  vouchedBy?: string;
}

/** One pairing secret. A secret with `retiredAt` is a previous one. */
export interface PairingSecret {
  id: number;
  /** base64 of 32 random bytes. */
  secret: string;
  createdAt: string;
  retiredAt?: string;
}

export interface TransportStateFile {
  version: 2;
  locked: boolean;
  /** base64 of the 32-byte Ed25519 seed that proves this computer owns its relay rooms. */
  relayKey: string;
  /** Newest first. The first is the current secret. */
  secrets: PairingSecret[];
  devices: DeviceEntry[];
  removed: string[];
  /**
   * Every account pass key a device with no `vouchedBy` has carried here,
   * base64 Ed25519, with when its account retired it. This is memory, not
   * trust: a key is trusted while such a device's record carries it
   * (`DeviceEntry.passKey`) and it has no `retiredAt`. Entries are never
   * dropped, so a key this computer once trusted stays retired for good.
   * Once the list holds `MAX_KNOWN_PASS_KEYS`, no new pass key is taken.
   * Older servers drop the field on load and fall back to Allow.
   */
  passKeys?: { key: string; addedAt: string; retiredAt?: string }[];
  /**
   * Retired pass keys this computer never trusted, oldest first. Only this
   * list is capped: a device can name any number of keys nobody here has seen.
   */
  retiredPassKeys?: string[];
}

/** A previous secret is honoured this long after it was retired, then deleted. */
export const PREVIOUS_SECRET_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
/** At most this many previous secrets are kept. */
export const MAX_PREVIOUS_SECRETS = 8;
/** At most this many retired pass keys that this computer never trusted are remembered. */
export const MAX_RETIRED_PASS_KEYS = 256;
/**
 * At most this many pass keys are ever remembered as carried here. An
 * account adds one per change of master key, so honest use stays far below
 * it. The entries are never dropped, so without a ceiling a recorded device
 * could grow the state file with made-up keys. Past it a new pass key is
 * refused and its account's devices wait for Allow.
 */
export const MAX_KNOWN_PASS_KEYS = 256;

/** Why `registerPassKey` did not take a pass key. */
export type PassKeyRefusal = "unrecorded" | "retired" | "full";

export const computerAccessSchema = z.object({
  read: z.boolean(),
  agents: z.boolean(),
  commands: z.boolean(),
});
/** Files written before "ask" replaced "every_time" and "per_chat" still load. */
export const computerConfirmSchema = z.preprocess(
  (value) => (value === "every_time" || value === "per_chat" ? "ask" : value),
  z.enum(["ask", "never"]),
);
export const devicePlatformSchema = z.enum(["android", "windows", "linux", "macos", "ios", "web", "computer", "connector"]);

const base64Of32Bytes = z.string().refine(isValidPublicKey, "must be base64 of 32 bytes");

/** The fields a device record had in devices.json, before transport v2. */
const legacyDeviceEntrySchema = z.object({
  publicKey: z.string().min(1),
  kind: z.enum(["device", "computer", "connector"]),
  name: z.string(),
  platform: devicePlatformSchema,
  addedAt: z.string(),
  lastSeenAt: z.string(),
  via: z.enum(["migration", "token", "approval", "link", "connector"]),
  access: computerAccessSchema.optional(),
  confirm: computerConfirmSchema.optional(),
  expiresAt: z.number().optional(),
});

const deviceEntrySchema = legacyDeviceEntrySchema.extend({
  transport: z.union([z.literal(1), z.literal(2)]),
  secretId: z.number().int().positive().optional(),
  linkSecret: base64Of32Bytes.optional(),
  passKey: base64Of32Bytes.optional(),
  vouchedBy: base64Of32Bytes.optional(),
});

/** devices.json, read once on the first start after the update. */
const legacyRegistryFileSchema = z.object({
  version: z.literal(1),
  mode: z.enum(["learning", "enforced"]),
  devices: z.array(legacyDeviceEntrySchema),
  revoked: z.array(z.string()),
});

const pairingSecretSchema = z.object({
  id: z.number().int().positive(),
  secret: base64Of32Bytes,
  createdAt: z.string(),
  retiredAt: z.string().optional(),
});

const stateFileSchema = z.object({
  version: z.literal(2),
  locked: z.boolean(),
  relayKey: base64Of32Bytes,
  secrets: z.array(pairingSecretSchema).min(1),
  devices: z.array(deviceEntrySchema),
  removed: z.array(z.string()),
  passKeys: z.array(z.object({ key: base64Of32Bytes, addedAt: z.string(), retiredAt: z.string().optional() })).optional(),
  retiredPassKeys: z.array(z.string()).optional(),
}).refine(
  (state) => state.secrets[0].retiredAt === undefined && state.secrets.slice(1).every((secret) => secret.retiredAt !== undefined),
  "the first secret must be current and every other one retired",
);

/**
 * Six digits from a public key, shown while an AI client or an old desktop
 * app waits for Allow. A v2 device shows the code of its handshake instead.
 */
export function deviceFingerprint(publicKeyBase64: string): string {
  const digest = crypto.createHash("sha256").update(Buffer.from(publicKeyBase64, "base64")).digest();
  const value = ((digest[0] << 16) | (digest[1] << 8) | digest[2]) % 1_000_000;
  return String(value).padStart(6, "0");
}

export function isValidPublicKey(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    return Buffer.from(value, "base64").length === 32;
  } catch {
    return false;
  }
}

/** Canonical base64 so the same key is never stored twice with different padding. */
export function normalizePublicKey(value: string): string {
  return Buffer.from(value, "base64").toString("base64");
}

function randomSecret(): string {
  return crypto.randomBytes(32).toString("base64");
}

/** What to run on the computer when the state file cannot be used. */
export const STATE_RESET_HINT = "Run `socketagent pair --reset` on this computer to start over with a new pairing code.";

/**
 * The state file, loaded once and kept in memory. Every change is written
 * through a temporary file and a rename.
 *
 * `new DeviceRegistry(statePath, legacyPath)` reads `transport.json`. When it
 * does not exist yet it is made from `devices.json` at `legacyPath`, which is
 * never read again after that (spec section 7.2).
 *
 * A file that exists but cannot be read or does not validate leaves the
 * registry unreadable: `readable` is false, `problem` says why, every lookup
 * comes back empty, and anything that would change state throws. The caller
 * admits nobody over the relay or the LAN until `resetPairing` runs. It
 * never falls back to letting unknown keys in.
 */
export class DeviceRegistry {
  private state: TransportStateFile | null = null;
  private unreadable: string | undefined;
  private listeners = new Set<() => void>();

  constructor(readonly filePath: string, legacyFilePath?: string) {
    if (fs.existsSync(filePath)) {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
        this.state = stateFileSchema.parse(parsed);
      } catch (err: unknown) {
        this.refuse(`Could not read ${filePath}: ${errorMessage(err)}`);
      }
      return;
    }
    let legacy: z.infer<typeof legacyRegistryFileSchema> | undefined;
    if (legacyFilePath && fs.existsSync(legacyFilePath)) {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(legacyFilePath, "utf8"));
        legacy = legacyRegistryFileSchema.parse(parsed);
      } catch (err: unknown) {
        // Starting empty here would forget every removed key and the lock.
        this.refuse(`Could not carry over ${legacyFilePath}: ${errorMessage(err)}`);
        return;
      }
    }
    this.state = {
      version: 2,
      locked: legacy?.mode === "enforced",
      relayKey: randomSecret(),
      secrets: [{ id: 1, secret: randomSecret(), createdAt: new Date().toISOString() }],
      devices: (legacy?.devices ?? []).map((entry) => ({ ...entry, transport: 1 })),
      // The old file may hold a key without padding. Every lookup uses the canonical form.
      removed: (legacy?.revoked ?? []).map((key) => (isValidPublicKey(key) ? normalizePublicKey(key) : key)),
    };
    this.write();
    if (legacy) console.log(`[Devices] Carried ${legacy.devices.length} paired key(s) over from ${legacyFilePath}`);
  }

  private refuse(problem: string): void {
    this.unreadable = problem;
    console.error(`[Devices] ${problem}. Nobody is let in over the relay or the local network until this is fixed. ${STATE_RESET_HINT}`);
  }

  /** False when the state file could not be used. Then nobody is admitted remotely. */
  get readable(): boolean {
    return this.state !== null;
  }

  /** Why the state file could not be used. */
  get problem(): string | undefined {
    return this.unreadable;
  }

  /** A link ran out and was dropped from memory, and the file still names it. */
  private expiredUnsaved = false;

  private loaded(): TransportStateFile {
    if (!this.state) throw new Error(`${this.unreadable ?? "The device state is unreadable"}. ${STATE_RESET_HINT}`);
    return this.state;
  }

  private write(): void {
    const state = this.loaded();
    this.pruneSecrets(state);
    this.expiredUnsaved = false;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
    try {
      if (process.platform !== "win32") fs.chmodSync(this.filePath, 0o600);
    } catch {
      // Permission tightening is best effort on filesystems without POSIX modes.
    }
    for (const listener of this.listeners) listener();
  }

  /** Called after every change so capabilities and device lists stay current. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Whether a new key that proves the pairing secret waits for Allow. An unreadable file counts as locked. */
  get locked(): boolean {
    return this.state?.locked ?? true;
  }

  get mode(): RegistryMode {
    return this.locked ? "enforced" : "learning";
  }

  list(): DeviceEntry[] {
    if (!this.state) return [];
    this.dropExpired();
    return this.state.devices.map((entry) => ({ ...entry }));
  }

  get(publicKey: string): DeviceEntry | undefined {
    if (!this.state) return undefined;
    this.dropExpired();
    const entry = this.state.devices.find((candidate) => candidate.publicKey === publicKey);
    return entry ? { ...entry } : undefined;
  }

  /** Whether the key is on the removed list. */
  isRevoked(publicKey: string): boolean {
    return this.state?.removed.includes(publicKey) ?? false;
  }

  /** Whether [passKey]'s account has retired it, as far as this computer has heard. */
  private passKeyRetired(state: TransportStateFile, passKey: string): boolean {
    return (state.retiredPassKeys ?? []).includes(passKey)
      || (state.passKeys ?? []).some((entry) => entry.key === passKey && entry.retiredAt !== undefined);
  }

  /**
   * Whether a device pass signed by [passKey] lets a new key in: its account
   * has not retired the key, and a recorded device that no pass put on
   * record carries it. A device a pass let in could have come from an old
   * pass, so a key that only such devices carry counts for nothing.
   */
  trustsPassKey(passKey: string): boolean {
    const state = this.state;
    if (!state || this.passKeyRetired(state, passKey)) return false;
    return state.devices.some((entry) => entry.kind === "device" && entry.vouchedBy === undefined && entry.passKey === passKey);
  }

  /** The pass keys this computer trusts, each with the recorded devices that make it trusted. */
  trustedPassKeys(): { passKey: string; devices: string[] }[] {
    const state = this.state;
    if (!state) return [];
    const carriers = new Map<string, string[]>();
    for (const entry of state.devices) {
      if (entry.kind !== "device" || entry.vouchedBy !== undefined) continue;
      if (!entry.passKey || this.passKeyRetired(state, entry.passKey)) continue;
      carriers.set(entry.passKey, [...(carriers.get(entry.passKey) ?? []), entry.publicKey]);
    }
    return Array.from(carriers, ([passKey, devices]) => ({ passKey, devices }));
  }

  /**
   * The recorded device [devicePublicKey] proved it holds [passKey] and says
   * its account retired the keys in [retired], oldest first as the vault
   * keeps them. The caller has checked the proof. `refusal` says why the
   * pass key was not taken: the sender is not a recorded device, the key is
   * retired, or this computer already remembers `MAX_KNOWN_PASS_KEYS`. The
   * retirements count either way. Writes only when something changed.
   *
   * A retired key is never trusted again, whoever reports it. All of
   * [retired] is applied to the keys this computer has trusted, however long
   * the list, and those are remembered for good. Of the keys it never saw,
   * the last `MAX_RETIRED_PASS_KEYS` go on the capped list. No record goes
   * on carrying a retired key.
   *
   * What else the message does depends on how the sender got on record. A
   * sender with no `vouchedBy` makes [passKey] trusted, and every record a
   * key in [retired] vouched for is deleted without going on the removed
   * list, so the account's real devices come back with a pass from the new
   * key. The computer links those devices made and the AI clients they
   * approved go with them. `dropped` names those records, of every kind,
   * and the caller closes what each still holds (`closeDroppedKey`). A
   * sender a pass put on record does neither. Its record carries
   * [passKey], which no pass is checked against, and nothing is deleted or
   * remembered. So a device let in by an old pass can't make up a pass key
   * and vouch more keys in, can't use up the remembered keys, and loses its
   * own record whatever it reports.
   */
  registerPassKey(
    devicePublicKey: string,
    passKey: string,
    retired: readonly string[],
  ): { accepted: boolean; refusal?: PassKeyRefusal; dropped: string[] } {
    const state = this.loaded();
    const sender = state.devices.find((entry) => entry.publicKey === devicePublicKey && entry.kind === "device");
    if (!sender) return { accepted: false, refusal: "unrecorded", dropped: [] };
    const unvouched = sender.vouchedBy === undefined;
    const now = new Date().toISOString();
    const known = state.passKeys ?? [];
    const listed = state.retiredPassKeys ?? [];
    const named = new Set(retired);
    const unseen = new Set<string>();
    let changed = false;
    for (const key of named) {
      const entry = known.find((candidate) => candidate.key === key);
      if (!entry) {
        unseen.add(key);
      } else if (entry.retiredAt === undefined) {
        entry.retiredAt = now;
        changed = true;
      }
    }
    // The same message always picks the same keys, so repeating it writes nothing.
    const missing = [...unseen].slice(-MAX_RETIRED_PASS_KEYS).filter((key) => !listed.includes(key));
    if (missing.length > 0) changed = true;
    if (changed) {
      state.passKeys = known;
      state.retiredPassKeys = [...listed, ...missing].slice(-MAX_RETIRED_PASS_KEYS);
    }

    let refusal: PassKeyRefusal | undefined;
    if (this.passKeyRetired(state, passKey)) {
      refusal = "retired";
    } else if (unvouched && !known.some((entry) => entry.key === passKey)) {
      if (known.length >= MAX_KNOWN_PASS_KEYS) {
        refusal = "full";
      } else {
        state.passKeys = [...known, { key: passKey, addedAt: now }];
        changed = true;
      }
    }
    if (!refusal && sender.passKey !== passKey) {
      sender.passKey = passKey;
      changed = true;
    }

    for (const entry of state.devices) {
      if (!entry.passKey || !this.passKeyRetired(state, entry.passKey)) continue;
      delete entry.passKey;
      changed = true;
    }
    const dropped = unvouched
      ? state.devices.filter((entry) => entry.vouchedBy !== undefined && named.has(entry.vouchedBy)).map((entry) => entry.publicKey)
      : [];
    if (dropped.length > 0) {
      state.devices = state.devices.filter((entry) => !dropped.includes(entry.publicKey));
      changed = true;
    }
    if (changed) this.write();
    return { accepted: refusal === undefined, ...(refusal ? { refusal } : {}), dropped };
  }

  /** Locks the computer. Only `resetPairing` unlocks it. */
  lock(): void {
    const state = this.loaded();
    if (state.locked) return;
    state.locked = true;
    this.write();
  }

  /**
   * Computer links past their expiresAt are forgotten, not removed, so the
   * user can link again. This drops them from memory only. Reads call it, and
   * a read can come from a handshake nobody has proved yet, which must not
   * write the state file or broadcast. `pruneExpired` saves the change.
   */
  private dropExpired(): void {
    const state = this.loaded();
    const now = Date.now();
    const kept = state.devices.filter((entry) => entry.expiresAt === undefined || entry.expiresAt > now);
    if (kept.length === state.devices.length) return;
    state.devices = kept;
    this.expiredUnsaved = true;
  }

  /**
   * Saves the state file once a time-limited link has run out, which also
   * tells every listener. index.ts calls it on a timer. Returns whether
   * anything was saved.
   */
  pruneExpired(): boolean {
    if (!this.state) return false;
    this.dropExpired();
    if (!this.expiredUnsaved) return false;
    this.write();
    return true;
  }

  /**
   * Adds or refreshes an entry and takes its key off the removed list. A
   * computer entry without expiresAt lasts until removed. `transport` is
   * kept from the existing entry and starts at 1. A computer's `linkSecret`
   * is kept too when the new entry names none, and so are a device's
   * `passKey`. `vouchedBy` is settled when a record is made, whatever its
   * kind: approving or linking a recorded key again neither clears it nor
   * adds one.
   */
  enroll(entry: Omit<DeviceEntry, "addedAt" | "lastSeenAt" | "transport"> & { addedAt?: string; transport?: DeviceTransport }): DeviceEntry {
    const state = this.loaded();
    const now = new Date().toISOString();
    const existing = state.devices.find((candidate) => candidate.publicKey === entry.publicKey);
    const next: DeviceEntry = {
      ...(existing ?? {}),
      ...entry,
      name: entry.name || existing?.name || "",
      addedAt: existing?.addedAt ?? entry.addedAt ?? now,
      lastSeenAt: now,
      transport: entry.transport ?? existing?.transport ?? 1,
    };
    if (entry.kind === "device") {
      delete next.access;
      delete next.confirm;
    } else {
      delete next.secretId;
      delete next.passKey;
    }
    if (existing?.kind === entry.kind) {
      if (existing.vouchedBy === undefined) delete next.vouchedBy;
      else next.vouchedBy = existing.vouchedBy;
    }
    if (entry.kind !== "computer") delete next.linkSecret;
    if (entry.expiresAt === undefined) delete next.expiresAt;
    if (existing) {
      state.devices[state.devices.indexOf(existing)] = next;
    } else {
      state.devices.push(next);
    }
    state.removed = state.removed.filter((key) => key !== entry.publicKey);
    this.write();
    return { ...next };
  }

  /**
   * Updates an entry that already exists: the name and platform a device
   * sent, that it was just seen, and, for a device on v2, its transport and
   * the newest secret it holds.
   */
  touch(
    publicKey: string,
    patch: { name?: string; platform?: DevicePlatform; transport?: DeviceTransport; secretId?: number } = {},
  ): DeviceEntry | undefined {
    const existing = this.state?.devices.find((candidate) => candidate.publicKey === publicKey);
    if (!existing) return undefined;
    if (patch.name) existing.name = patch.name;
    if (patch.platform) existing.platform = patch.platform;
    if (patch.transport) existing.transport = patch.transport;
    if (patch.secretId !== undefined && existing.kind === "device") {
      existing.secretId = Math.max(existing.secretId ?? 0, patch.secretId);
    }
    existing.lastSeenAt = new Date().toISOString();
    this.write();
    return { ...existing };
  }

  /**
   * Stores the link secret a linked computer offered with `link_upgrade`.
   * False when the key is not a recorded computer, or its link already runs
   * on v2: from then only `device_authorize` from a device changes the secret.
   */
  setLinkSecret(publicKey: string, linkSecret: string): boolean {
    this.dropExpired();
    const existing = this.loaded().devices.find((candidate) => candidate.publicKey === publicKey);
    if (existing?.kind !== "computer" || existing.transport !== 1 || !isValidPublicKey(linkSecret)) return false;
    existing.linkSecret = normalizePublicKey(linkSecret);
    this.write();
    return true;
  }

  /** Moves the key to the removed list. Returns the removed entry. */
  revoke(publicKey: string): DeviceEntry | undefined {
    const state = this.loaded();
    const existing = state.devices.find((candidate) => candidate.publicKey === publicKey);
    state.devices = state.devices.filter((candidate) => candidate.publicKey !== publicKey);
    if (!state.removed.includes(publicKey)) state.removed.push(publicKey);
    this.write();
    return existing ? { ...existing } : undefined;
  }

  countDevices(): number {
    return this.state?.devices.filter((entry) => entry.kind === "device").length ?? 0;
  }

  // ── Pairing secrets ──

  /** Drops previous secrets past their 90 days and keeps the newest eight. */
  private pruneSecrets(state: TransportStateFile): void {
    const oldest = Date.now() - PREVIOUS_SECRET_LIFETIME_MS;
    const [current, ...previous] = state.secrets;
    state.secrets = [
      current,
      ...previous.filter((secret) => Date.parse(secret.retiredAt ?? "") > oldest).slice(0, MAX_PREVIOUS_SECRETS),
    ];
  }

  /** The secret in the pairing code. Throws when the state is unreadable. */
  currentSecret(): PairingSecret {
    return { ...this.loaded().secrets[0] };
  }

  /** Previous secrets still honoured for recorded devices, newest first. */
  previousSecrets(): PairingSecret[] {
    if (!this.state) return [];
    const oldest = Date.now() - PREVIOUS_SECRET_LIFETIME_MS;
    return this.state.secrets.slice(1)
      .filter((secret) => Date.parse(secret.retiredAt ?? "") > oldest)
      .map((secret) => ({ ...secret }));
  }

  /**
   * Makes a new pairing secret: the current one is retired and the new one
   * goes to the front with the next id. The caller then sends
   * `pairing_update` to every open v2 control channel.
   */
  rotateSecret(): PairingSecret {
    const state = this.loaded();
    const now = new Date().toISOString();
    state.secrets[0].retiredAt = now;
    const next: PairingSecret = { id: Math.max(...state.secrets.map((secret) => secret.id)) + 1, secret: randomSecret(), createdAt: now };
    state.secrets.unshift(next);
    this.write();
    return { ...next };
  }

  /**
   * Records that these devices were just sent the current secret, in one
   * write. Push sealing reads `secretId` to know which older secrets are
   * still in use.
   */
  markSecretHanded(publicKeys: readonly string[]): void {
    const state = this.loaded();
    const currentId = state.secrets[0].id;
    let changed = false;
    for (const publicKey of publicKeys) {
      const entry = state.devices.find((candidate) => candidate.publicKey === publicKey);
      if (!entry || entry.kind !== "device" || (entry.secretId ?? 0) >= currentId) continue;
      entry.secretId = currentId;
      changed = true;
    }
    if (changed) this.write();
  }

  /** The Ed25519 key that proves to the relay that this computer owns its rooms. */
  relayOwnerKey(): { publicKey: Uint8Array; secretKey: Uint8Array } {
    return nacl.sign.keyPair.fromSeed(new Uint8Array(Buffer.from(this.loaded().relayKey, "base64")));
  }

  /**
   * `show-pairing --reset`: one new pairing secret, previous secrets
   * cleared, the lock off. Device records still on transport 1 are deleted:
   * the old path admits a recorded key with no token, so a record left
   * behind would let its device back in without the new code. They are not
   * put on the removed list. Records on transport 2, linked computers, AI
   * clients and the removed list stay, except the records a pass put here
   * (`vouchedBy`). Those are deleted, whatever their kind, and `dropped`
   * names them so the caller can close what each still holds. The caller
   * also makes a new room ID and a new AUTH_TOKEN, so every device has to
   * scan again.
   *
   * It is the recovery for an unreadable state file too. Then nothing can be
   * kept: the lists start empty with a new relay owner key, and the old file
   * is left beside the new one as `<name>.unreadable`. `newOwnerKey` tells
   * the caller that happened, because the relay still knows this computer's
   * link room under the lost key and the room needs a new ID as well.
   */
  resetPairing(): { newOwnerKey: boolean; dropped: string[] } {
    const now = new Date().toISOString();
    const newOwnerKey = !this.state;
    let dropped: string[] = [];
    if (this.state) {
      const nextId = Math.max(...this.state.secrets.map((secret) => secret.id)) + 1;
      this.state.secrets = [{ id: nextId, secret: randomSecret(), createdAt: now }];
      this.state.locked = false;
      const kept = this.state.devices.filter((entry) => entry.kind !== "device" || entry.transport === 2);
      // Every record a pass put here goes, with the links and AI clients
      // such devices made. One of them may have come from an old pass, and
      // the reset can't tell which. They are not put on the removed list:
      // the computer is unlocked now, so the account's own devices come
      // back with the new code and are recorded like any key that pairs by
      // code.
      dropped = kept.filter((entry) => entry.vouchedBy !== undefined).map((entry) => entry.publicKey);
      this.state.devices = kept.filter((entry) => entry.vouchedBy === undefined);
      // Starting over means no account vouches for new devices until one of
      // its devices pairs again. What was retired stays retired.
      for (const entry of this.state.devices) delete entry.passKey;
    } else {
      if (fs.existsSync(this.filePath)) fs.renameSync(this.filePath, `${this.filePath}.unreadable`);
      this.state = {
        version: 2,
        locked: false,
        relayKey: randomSecret(),
        secrets: [{ id: 1, secret: randomSecret(), createdAt: now }],
        devices: [],
        removed: [],
      };
      this.unreadable = undefined;
    }
    this.write();
    return { newOwnerKey, dropped };
  }
}
