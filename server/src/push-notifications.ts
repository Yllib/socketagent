import * as fs from "fs";
import { z } from "zod";
import { isRecord, unknownArray, errorMessage, parseJsonObject } from "./value-guards";
import * as path from "path";
import { GoogleAuth } from "google-auth-library";
import { socketAgentDataPath } from "./socket-agent-paths";
import { redactSecrets } from "./secure-input-store";
import { legacyPushFields, plainPushData, sealPush, type PushNotificationPayload, type RelayPushRequest } from "./push-sealing";

export type { PushNotificationPayload } from "./push-sealing";

export interface StoredPushToken {
  token: string;
  platform: string;
  appServerId?: string;
  deliveryRoute?: "relay" | "direct";
  firebaseProjectId?: string;
  /** The phone registered on a transport v2 channel, so it gets sealed pushes. */
  v2?: boolean;
  /**
   * The device key the registration arrived under, so it can go when that
   * device is removed. Absent for one that came over the loopback token
   * socket, and for one stored before keys were kept.
   */
  deviceKey?: string;
  updatedAt: string;
}

/**
 * What a push needs from the running server. index.ts sets it once the
 * device registry and the control-room relay client exist. Until then
 * nothing is sealed and nothing goes to the relay.
 */
export interface PushTransport {
  /** The pairing secrets to seal for, newest first (push-sealing.ts). */
  sealingSecrets(): Uint8Array[];
  /** True while the old path is on and a recorded device is still on it. Only then may a push leave in plaintext. */
  plaintextAllowed(): boolean;
  /**
   * Sends a `relay_push` over the control-room socket. Rejects when that
   * socket is down. [dead] names the tokens the relay found dead.
   */
  relayPush(push: RelayPushRequest): Promise<{ sent: number; attempted: number; dead: string[] }>;
  /**
   * Called after every change to the stored registrations, so the relay gets
   * the list again. [atOnce] is true when a device was removed or the pairing
   * reset, and the list must not wait its turn.
   */
  relayTokensChanged(atOnce: boolean): void;
}

/** One registration in a `relay_push_tokens` frame (wire spec 11.2a). */
export interface RelayPushToken {
  token: string;
  platform: string;
  /** The ID that phone knows this computer by. */
  serverId?: string;
  /** 2 when the phone registered on a transport v2 channel and gets sealed pushes. */
  v?: 2;
}

let pushTransport: PushTransport | null = null;

export function setPushTransport(transport: PushTransport | null): void {
  pushTransport = transport;
}

export type DirectFcmConfigurationIssue = "missing" | "invalid" | "unreadable";

export interface PushDeliveryCapabilities {
  directFcmConfigured: boolean;
  directFcmIssue?: DirectFcmConfigurationIssue;
  directFcmProjectId?: string;
  relayConfigured: boolean;
}

export function shouldSendForwardedPush(message: Record<string, unknown>): boolean {
  return message.type === "scheduled_task_notification"
    && message.fcmDispatched !== true;
}

const sentAttentionEvents = new Map<string, number>();

/**
 * Questions and secure-input requests are live UI events, but FCM is the sole
 * notification transport. Replays use sendTo() and never reach this helper;
 * this process-level guard also prevents duplicate sends across session objects.
 */
export function maybeSendAgentAttentionPush(
  message: unknown,
  fallbackTitle = "SocketAgent",
): void {
  if (!isRecord(message)) return;
  const type = String(message.type || "");
  if (type !== "question" && type !== "secure_input_request") return;
  const sessionId = String(message.sessionId || "");
  if (!sessionId) return;
  const interactionId = type === "question"
    ? String(message.questionId || "")
    : String(message.requestId || "");
  if (!interactionId) return;
  const eventId = `${type}:${sessionId || "none"}:${interactionId}`;
  if (sentAttentionEvents.has(eventId)) return;
  const now = Date.now();
  sentAttentionEvents.set(eventId, now);
  if (sentAttentionEvents.size > 1000) {
    for (const [key, timestamp] of sentAttentionEvents) {
      if (now - timestamp > 24 * 60 * 60 * 1000 || sentAttentionEvents.size > 800) {
        sentAttentionEvents.delete(key);
      }
    }
  }

  const first = unknownArray(message.questions)[0];
  const firstQuestion = isRecord(first) ? String(first.question || "").trim() : "";
  const label = String(message.label || "Secret").trim() || "Secret";
  const body = type === "question"
    ? (firstQuestion || "Your agent needs your input")
    : `Secure input requested: ${label}`;
  const kind = type === "question" ? "input_required" : "secure_input_required";
  sendPushNotification({
    title: fallbackTitle.trim() || "SocketAgent",
    body: body.length > 220 ? `${body.slice(0, 217)}...` : body,
    sessionId,
    status: "manual",
    kind,
    data: { eventId },
    showNotification: false,
  }).then((result) => {
    if (result.attempted > 0) {
      console.log(`[Push] FCM sent ${result.sent}/${result.attempted} for ${type} session=${sessionId || "none"}`);
    }
  }).catch((err: unknown) => {
    console.warn(`[Push] ${type} push error: ${errorMessage(err)}`);
  });
}

const STORE_PATH = process.env.PUSH_TOKEN_STORE
  || socketAgentDataPath("push-tokens.json");

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
let cachedCredentials: Record<string, unknown> | null | undefined;
let fcmAuth: GoogleAuth | null = null;
let fcmProjectId: string | null = null;

function readStore(): StoredPushToken[] {
  try {
    if (!fs.existsSync(STORE_PATH)) return [];
    const parsed: unknown = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
    return unknownArray(parsed).flatMap(entry => {
      const result = z.object({
        token: z.string().min(1), platform: z.string().default("android"),
        appServerId: z.string().optional(), deliveryRoute: z.enum(["relay", "direct"]).optional(),
        firebaseProjectId: z.string().optional(), v2: z.boolean().optional(), deviceKey: z.string().optional(),
        updatedAt: z.string().default(""),
      }).safeParse(entry);
      return result.success ? [result.data] : [];
    });
  } catch {
    return [];
  }
}

function writeStore(entries: StoredPushToken[], atOnce = false): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(entries, null, 2), { mode: 0o600 });
  pushTransport?.relayTokensChanged(atOnce);
}

/** Whether the relay delivers for [entry]. Only a phone that registered as direct is left to this computer's own Firebase path. */
function relayDelivers(entry: StoredPushToken): boolean {
  return entry.deliveryRoute !== "direct";
}

/**
 * The whole push list the relay should hold for this computer's room, oldest
 * first. The relay takes an owned room's list only from its computer, so
 * every registration an app gives this computer is passed on from here.
 */
export function relayPushTokens(): RelayPushToken[] {
  return readStore().filter(relayDelivers).map((entry) => ({
    token: entry.token,
    platform: entry.platform,
    ...(entry.appServerId ? { serverId: entry.appServerId } : {}),
    ...(entry.v2 ? { v: 2 as const } : {}),
  }));
}

export function registerPushToken(
  fcmToken: string,
  platform = "android",
  appServerId?: string,
  deliveryRoute?: "relay" | "direct",
  firebaseProjectId?: string,
  /** Whether `register_push_token` arrived on a transport v2 channel. */
  v2 = false,
  /** The device key the channel proved. A registration made again without one keeps the key it had. */
  deviceKey?: string,
): void {
  const token = fcmToken.trim();
  if (!token) return;

  const stored = readStore();
  const key = deviceKey ?? stored.find((entry) => entry.token === token)?.deviceKey;
  const withoutToken = stored.filter((entry) => {
    if (entry.token === token) return false;
    return !(
      appServerId
      && deliveryRoute
      && entry.appServerId === appServerId
      && entry.deliveryRoute === deliveryRoute
    );
  });
  writeStore([
    ...withoutToken,
    {
      token,
      platform,
      ...(appServerId ? { appServerId } : {}),
      ...(deliveryRoute ? { deliveryRoute } : {}),
      ...(firebaseProjectId ? { firebaseProjectId } : {}),
      ...(v2 ? { v2 } : {}),
      ...(key ? { deviceKey: key } : {}),
      updatedAt: new Date().toISOString(),
    },
  ].slice(-20));
}

/**
 * Drops the registrations of a device that was removed: every one stored
 * under [deviceKey]. With [alsoUnkeyed], every one stored under no key goes
 * too, because the removed phone's may be among them. The phones that stay
 * register again when they next connect.
 */
export function dropDeviceRegistrations(deviceKey: string, alsoUnkeyed: boolean): void {
  const stored = readStore();
  const kept = stored.filter((entry) => (entry.deviceKey ? entry.deviceKey !== deviceKey : !alsoUnkeyed));
  if (kept.length !== stored.length) writeStore(kept, true);
}

/** Drops every registration. Pairing was started over, so every phone has to pair and register again. */
export function clearPushRegistrations(): void {
  if (readStore().length > 0) writeStore([], true);
}

export function unregisterPushToken(
  fcmToken: string,
  appServerId?: string,
): void {
  const token = fcmToken.trim();
  if (!token) return;

  writeStore(readStore().filter((entry) => {
    if (entry.token !== token) return true;
    if (!appServerId) return false;
    return entry.appServerId !== appServerId;
  }));
}

export function isPushTokenRegistered(
  fcmToken: string,
  appServerId?: string,
  deliveryRoute?: "relay" | "direct",
  /** Asked on a v2 channel: a registration made on the old path does not count, so the phone registers again. */
  v2Only = false,
): boolean {
  const token = fcmToken.trim();
  if (!token) return false;
  return readStore().some((entry) => (
    entry.token === token
      && (!appServerId || entry.appServerId === appServerId)
      && (!deliveryRoute || entry.deliveryRoute === deliveryRoute)
      && (!v2Only || entry.v2 === true)
  ));
}

function hasRequiredServiceAccountFields(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const credentials = value;
  const hasProject = typeof credentials.project_id === "string"
    && credentials.project_id.trim().length > 0;
  const hasExplicitProject = Boolean(
    process.env.FIREBASE_PROJECT_ID
      || process.env.GOOGLE_CLOUD_PROJECT
      || process.env.GCLOUD_PROJECT,
  );
  return typeof credentials.client_email === "string"
    && credentials.client_email.trim().length > 0
    && typeof credentials.private_key === "string"
    && credentials.private_key.trim().length > 0
    && (hasProject || hasExplicitProject);
}

function directFcmConfiguration(): Pick<
  PushDeliveryCapabilities,
  "directFcmConfigured" | "directFcmIssue" | "directFcmProjectId"
> {
  const explicitProjectId = String(
    process.env.FIREBASE_PROJECT_ID
      || process.env.GOOGLE_CLOUD_PROJECT
      || process.env.GCLOUD_PROJECT
      || "",
  ).trim();
  const resultForCredentials = (
    credentials: Record<string, unknown>,
  ): Pick<
    PushDeliveryCapabilities,
    "directFcmConfigured" | "directFcmIssue" | "directFcmProjectId"
  > => {
    if (!hasRequiredServiceAccountFields(credentials)) {
      return { directFcmConfigured: false, directFcmIssue: "invalid" };
    }
    const credentialProjectId = typeof credentials.project_id === "string"
      ? credentials.project_id.trim()
      : "";
    return {
      directFcmConfigured: true,
      directFcmProjectId: explicitProjectId || credentialProjectId,
    };
  };
  const rawJson = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();
  if (rawJson) {
    try {
      return resultForCredentials(parseJsonObject(rawJson));
    } catch {
      return { directFcmConfigured: false, directFcmIssue: "invalid" };
    }
  }

  const credentialsPath = String(
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH
      || process.env.GOOGLE_APPLICATION_CREDENTIALS
      || "",
  ).trim();
  if (!credentialsPath) {
    return { directFcmConfigured: false, directFcmIssue: "missing" };
  }
  try {
    const credentials = parseJsonObject(fs.readFileSync(credentialsPath, "utf-8"));
    return resultForCredentials(credentials);
  } catch (error: unknown) {
    const hasFileErrorCode = error !== null
      && typeof error === "object"
      && "code" in error;
    return {
      directFcmConfigured: false,
      directFcmIssue: hasFileErrorCode ? "unreadable" : "invalid",
    };
  }
}

export function getPushDeliveryCapabilities(): PushDeliveryCapabilities {
  return {
    ...directFcmConfiguration(),
    relayConfigured: relayPushConfigured(),
  };
}

export function isPushConfigured(): boolean {
  const capabilities = getPushDeliveryCapabilities();
  return capabilities.directFcmConfigured || capabilities.relayConfigured;
}

/** Whether this computer has a relay room for the relay to send pushes for. */
function relayPushConfigured(): boolean {
  const relayUrl = String(process.env.RELAY_URL || "").trim();
  const pairingToken = String(process.env.PAIRING_TOKEN || "").trim();
  if (!relayUrl || !pairingToken) return false;
  try {
    new URL(relayUrl);
    return true;
  } catch {
    return false;
  }
}

/**
 * The `relay_push` for a notification (wire spec 11.2). [entries] are this
 * computer's registrations that the relay delivers for, which is the whole
 * push list of its room. The plaintext `legacy` part rides along only when
 * [plaintextAllowed] and one of them did not arrive on a v2 channel, so the
 * relay sees no notification text once every phone gets sealed pushes.
 * Registrations are appended, so the last one with a server ID is the
 * newest, and it fills in for phones the relay holds without an ID.
 */
export function buildRelayPush(
  payload: PushNotificationPayload,
  sealed: string,
  entries: readonly StoredPushToken[],
  plaintextAllowed: boolean,
): RelayPushRequest {
  const serverId = [...entries].reverse().find((entry) => entry.appServerId)?.appServerId;
  const legacyNeeded = plaintextAllowed && entries.some((entry) => !entry.v2);
  return {
    sealed,
    ...(serverId ? { serverId } : {}),
    ...(legacyNeeded ? { legacy: legacyPushFields(payload) } : {}),
  };
}

/**
 * The FCM `data` this computer's own Firebase path sends to one registration
 * (wire spec 11.3). A phone that registered on a v2 channel gets the sealed
 * text, and any other phone today's plaintext map while [plaintextAllowed].
 * Null means that phone gets nothing.
 */
export function directPushData(
  entry: StoredPushToken,
  payload: PushNotificationPayload,
  sealed: string | null,
  plaintextAllowed: boolean,
): Record<string, string> | null {
  if (entry.v2) return sealed ? { v: "2", serverId: entry.appServerId ?? "", sealed } : null;
  return plaintextAllowed ? plainPushData(payload, entry.appServerId ?? "") : null;
}

function loadServiceAccountCredentials(): Record<string, unknown> | null {
  if (cachedCredentials !== undefined) return cachedCredentials;
  try {
    const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    if (rawJson) {
      const credentials = parseJsonObject(rawJson);
      cachedCredentials = credentials;
      return credentials;
    }
    if (serviceAccountPath) {
      const credentials = parseJsonObject(fs.readFileSync(serviceAccountPath, "utf-8"));
      cachedCredentials = credentials;
      return credentials;
    }
    cachedCredentials = null;
    return null;
  } catch (err: unknown) {
    console.error(`[Push] Firebase credentials could not be read: ${errorMessage(err)}`);
    cachedCredentials = null;
    return null;
  }
}

function getFcmAuth(): GoogleAuth | null {
  if (fcmAuth) return fcmAuth;
  const credentials = loadServiceAccountCredentials();
  if (credentials) {
    fcmAuth = new GoogleAuth({ credentials, scopes: [FCM_SCOPE] });
    return fcmAuth;
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    fcmAuth = new GoogleAuth({ scopes: [FCM_SCOPE] });
    return fcmAuth;
  }
  console.warn("[Push] Firebase credentials not configured; push notifications disabled");
  return null;
}

async function getFcmProjectId(auth: GoogleAuth): Promise<string | null> {
  if (fcmProjectId) return fcmProjectId;
  const explicit = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
  if (explicit) {
    fcmProjectId = explicit;
    return fcmProjectId;
  }
  const credentials = loadServiceAccountCredentials();
  const credentialProject = typeof credentials?.project_id === "string" ? credentials.project_id : "";
  if (credentialProject) {
    fcmProjectId = credentialProject;
    return fcmProjectId;
  }
  try {
    fcmProjectId = await auth.getProjectId();
    return fcmProjectId;
  } catch (err: unknown) {
    console.error(`[Push] Firebase project ID could not be resolved: ${errorMessage(err)}`);
    return null;
  }
}

function removeTokens(tokensToRemove: Set<string>): void {
  if (tokensToRemove.size === 0) return;
  writeStore(readStore().filter((entry) => !tokensToRemove.has(entry.token)));
}

function fcmResponseError(err: unknown): Record<string, unknown> | undefined {
  if (!isRecord(err) || !isRecord(err.response) || !isRecord(err.response.data)) return undefined;
  return isRecord(err.response.data.error) ? err.response.data.error : undefined;
}

function fcmDetailErrorCode(err: unknown): string {
  for (const detail of unknownArray(fcmResponseError(err)?.details)) {
    if (!isRecord(detail)) continue;
    const type = typeof detail["@type"] === "string" ? detail["@type"] : "";
    if (type.includes("google.firebase.fcm.v1.FcmError") && typeof detail.errorCode === "string") {
      return detail.errorCode;
    }
  }
  return "";
}

function fcmErrorCode(err: unknown): string {
  const fcmCode = fcmDetailErrorCode(err);
  if (fcmCode) return fcmCode;
  const status = fcmResponseError(err)?.status;
  if (typeof status === "string" && status) return status;
  return isRecord(err) && typeof err.code === "string" ? err.code : "";
}

function isInvalidFcmTokenError(err: unknown): boolean {
  const code = fcmDetailErrorCode(err);
  return code === "UNREGISTERED" || code === "INVALID_ARGUMENT";
}

async function sendFcmHttpV1(
  auth: GoogleAuth,
  projectId: string,
  token: string,
  data: Record<string, string>,
  /** The plaintext to show as a system notification. Null for a sealed push, which is data only. */
  payload: PushNotificationPayload | null,
): Promise<void> {
  const client = await auth.getClient();
  const message: Record<string, unknown> = {
    token,
    data,
    android: {
      priority: "HIGH",
    },
  };

  if (payload && payload.showNotification !== false) {
    message.notification = {
      title: payload.title,
      body: payload.body || "",
    };
    message.android = {
      priority: "HIGH",
      notification: {
        channel_id: "session_alerts",
        notification_priority: "PRIORITY_HIGH",
        default_sound: true,
        default_vibrate_timings: true,
      },
    };
  }

  await client.request({
    method: "POST",
    url: `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`,
    data: { message },
  });
}

/**
 * The notification with stored secrets taken out of its text, scoped to its
 * session the way chat text is. A notification leaves this computer, so an
 * agent that repeats a secret must not put it on the lock screen.
 */
function redactPush(payload: PushNotificationPayload): PushNotificationPayload {
  const context = payload.sessionId ? { sessionId: payload.sessionId } : undefined;
  const text = (value: string | undefined) => (value === undefined ? undefined : redactSecrets(value, context));
  const data = payload.data && Object.fromEntries(
    Object.entries(payload.data).map(([key, value]) => [key, typeof value === "string" ? redactSecrets(value, context) : value]),
  );
  return { ...payload, title: redactSecrets(payload.title, context), body: text(payload.body), ...(data ? { data } : {}) };
}

/**
 * Sends one notification to this computer's phones. The relay gets a
 * `relay_push` for the phones registered with it. This computer's own
 * Firebase credentials serve the phones registered as direct, and every
 * registered phone when the relay reached none.
 */
export async function sendPushNotification(
  unredacted: PushNotificationPayload,
): Promise<{ sent: number; attempted: number }> {
  const payload = redactPush(unredacted);
  // Test processes inherit the developer's relay credentials. Never let a
  // fixture notification escape to a real enrolled device.
  if (process.env.SOCKETAGENT_TEST_MODE === "1") {
    return { sent: 0, attempted: 0 };
  }
  const entries = readStore();
  const sealed = pushTransport ? sealPush(payload, pushTransport.sealingSecrets()) : null;
  const plaintextAllowed = pushTransport?.plaintextAllowed() ?? false;
  const relayEntries = entries.filter(relayDelivers);
  let relayResult: { sent: number; attempted: number } | null = null;
  if (
    pushTransport &&
    relayPushConfigured() &&
    (entries.length === 0 || relayEntries.length > 0)
  ) {
    if (sealed) {
      try {
        const { sent, attempted, dead } = await pushTransport.relayPush(buildRelayPush(payload, sealed, relayEntries, plaintextAllowed));
        relayResult = { sent, attempted };
        // The relay has dropped these already. Dropping them here keeps the
        // next list this computer sends from putting them back. Only a token
        // the relay delivers for is its to name.
        const listed = new Set(relayEntries.map((entry) => entry.token));
        removeTokens(new Set(dead.filter((token) => listed.has(token))));
      } catch (error: unknown) {
        console.warn(`[Push] Relay delivery failed, checking direct Firebase fallback: ${errorMessage(error)}`);
      }
    } else {
      console.warn("[Push] Nothing sent through the relay: the notification could not be sealed");
    }
  }

  if (entries.length === 0) {
    return relayResult ?? { sent: 0, attempted: 0 };
  }

  const directEntries = relayResult && relayResult.attempted > 0
    ? entries.filter((entry) => entry.deliveryRoute === "direct")
    : entries;
  if (directEntries.length === 0) {
    return relayResult ?? { sent: 0, attempted: 0 };
  }
  const auth = getFcmAuth();
  if (!auth) {
    return {
      sent: relayResult?.sent ?? 0,
      attempted: (relayResult?.attempted ?? 0) + directEntries.length,
    };
  }
  const projectId = await getFcmProjectId(auth);
  if (!projectId) {
    return {
      sent: relayResult?.sent ?? 0,
      attempted: (relayResult?.attempted ?? 0) + directEntries.length,
    };
  }
  const projectEntries = directEntries.filter(
    (entry) => entry.token && (!entry.firebaseProjectId || entry.firebaseProjectId === projectId),
  );
  if (projectEntries.length === 0) {
    return relayResult ?? { sent: 0, attempted: 0 };
  }

  const targets = projectEntries.flatMap((entry) => {
    const data = directPushData(entry, payload, sealed, plaintextAllowed);
    return data ? [{ entry, data }] : [];
  });
  let sent = 0;
  const invalid = new Set<string>();
  for (const { entry, data } of targets) {
    try {
      await sendFcmHttpV1(auth, projectId, entry.token, data, entry.v2 ? null : payload);
      sent++;
    } catch (err: unknown) {
      const code = fcmErrorCode(err);
      if (isInvalidFcmTokenError(err)) {
        invalid.add(entry.token);
      }
      console.warn(`[Push] FCM send failed: ${code || errorMessage(err)}`);
    }
  }
  removeTokens(invalid);
  return {
    sent: sent + (relayResult?.sent ?? 0),
    attempted: targets.length + (relayResult?.attempted ?? 0),
  };
}
