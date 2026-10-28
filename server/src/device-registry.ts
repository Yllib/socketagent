import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { errorMessage } from "./value-guards";

/**
 * Keys allowed to talk to this computer through the relay. Phones and desktops
 * enroll a "device" key; other computers that may act here through a link
 * enroll a "computer" key; AI clients signed in through the AI connector
 * enroll a "connector" key, which is a random ID rather than a NaCl key.
 * The relay never sees this file or its contents.
 */
/** "connector" is an AI client (Claude, ChatGPT) that signed in through the AI connector. */
export type DeviceKind = "device" | "computer" | "connector";
export type DevicePlatform = "android" | "windows" | "linux" | "macos" | "ios" | "computer" | "connector";
export type DeviceVia = "migration" | "token" | "approval" | "link" | "connector";
export type RegistryMode = "learning" | "enforced";
export type ComputerConfirm = "ask" | "never";

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
  access?: ComputerAccess;
  confirm?: ComputerConfirm;
  /** Unix ms when a computer link ends. The entry is dropped after that. */
  expiresAt?: number;
}

export interface DeviceRegistryFile {
  version: 1;
  mode: RegistryMode;
  devices: DeviceEntry[];
  revoked: string[];
}

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
export const devicePlatformSchema = z.enum(["android", "windows", "linux", "macos", "ios", "computer", "connector"]);

const deviceEntrySchema = z.object({
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

const registryFileSchema = z.object({
  version: z.literal(1),
  mode: z.enum(["learning", "enforced"]),
  devices: z.array(deviceEntrySchema),
  revoked: z.array(z.string()),
});

/** Six digits both ends show so the user can match a pending device to a prompt. */
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

export class DeviceRegistry {
  private state: DeviceRegistryFile;
  private listeners = new Set<() => void>();

  /**
   * `freshInstall` means the relay key pair was generated on this boot, so no
   * phone can have paired yet and the registry can start enforced.
   */
  constructor(private readonly filePath: string, freshInstall: boolean) {
    this.state = this.read() ?? {
      version: 1,
      mode: freshInstall ? "enforced" : "learning",
      devices: [],
      revoked: [],
    };
    if (!fs.existsSync(filePath)) this.write();
  }

  private read(): DeviceRegistryFile | undefined {
    try {
      if (!fs.existsSync(this.filePath)) return undefined;
      const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return registryFileSchema.parse(parsed);
    } catch (err: unknown) {
      console.error(`[Devices] Could not read ${this.filePath}: ${errorMessage(err)}. Starting a new registry in enforced mode is unsafe, so this one stays in learning mode.`);
      return undefined;
    }
  }

  private write(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2), { encoding: "utf8", mode: 0o600 });
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

  get mode(): RegistryMode {
    return this.state.mode;
  }

  list(): DeviceEntry[] {
    this.dropExpired();
    return this.state.devices.map((entry) => ({ ...entry }));
  }

  get(publicKey: string): DeviceEntry | undefined {
    this.dropExpired();
    const entry = this.state.devices.find((candidate) => candidate.publicKey === publicKey);
    return entry ? { ...entry } : undefined;
  }

  isRevoked(publicKey: string): boolean {
    return this.state.revoked.includes(publicKey);
  }

  /** Enforced never goes back to learning. */
  lock(): void {
    if (this.state.mode === "enforced") return;
    this.state.mode = "enforced";
    this.write();
  }

  /** Computer links past their expiresAt are forgotten, not revoked, so the user can link again. */
  private dropExpired(): void {
    const now = Date.now();
    const kept = this.state.devices.filter((entry) => entry.expiresAt === undefined || entry.expiresAt > now);
    if (kept.length === this.state.devices.length) return;
    this.state.devices = kept;
    this.write();
  }

  /**
   * Adds or refreshes an entry. Approval and link enrollment un-revoke the
   * key. A computer entry without expiresAt lasts until removed.
   */
  enroll(entry: Omit<DeviceEntry, "addedAt" | "lastSeenAt"> & { addedAt?: string }): DeviceEntry {
    const now = new Date().toISOString();
    const existing = this.state.devices.find((candidate) => candidate.publicKey === entry.publicKey);
    const next: DeviceEntry = {
      ...(existing ?? {}),
      ...entry,
      name: entry.name || existing?.name || "",
      addedAt: existing?.addedAt ?? entry.addedAt ?? now,
      lastSeenAt: now,
    };
    if (entry.kind === "device") {
      delete next.access;
      delete next.confirm;
    }
    if (entry.expiresAt === undefined) delete next.expiresAt;
    if (existing) {
      this.state.devices[this.state.devices.indexOf(existing)] = next;
    } else {
      this.state.devices.push(next);
    }
    this.state.revoked = this.state.revoked.filter((key) => key !== entry.publicKey);
    this.write();
    return { ...next };
  }

  /** Name and platform updates from an already enrolled device. */
  touch(publicKey: string, patch: { name?: string; platform?: DevicePlatform } = {}): DeviceEntry | undefined {
    const existing = this.state.devices.find((candidate) => candidate.publicKey === publicKey);
    if (!existing) return undefined;
    if (patch.name) existing.name = patch.name;
    if (patch.platform) existing.platform = patch.platform;
    existing.lastSeenAt = new Date().toISOString();
    this.write();
    return { ...existing };
  }

  /** Moves the key to the revoked list. Returns the removed entry. */
  revoke(publicKey: string): DeviceEntry | undefined {
    const existing = this.state.devices.find((candidate) => candidate.publicKey === publicKey);
    this.state.devices = this.state.devices.filter((candidate) => candidate.publicKey !== publicKey);
    if (!this.state.revoked.includes(publicKey)) this.state.revoked.push(publicKey);
    this.write();
    return existing ? { ...existing } : undefined;
  }

  countDevices(): number {
    return this.state.devices.filter((entry) => entry.kind === "device").length;
  }
}
