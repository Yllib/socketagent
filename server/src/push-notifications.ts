import * as fs from "fs";
import * as path from "path";
import { GoogleAuth } from "google-auth-library";
import { socketAgentDataPath } from "./socket-agent-paths";

interface StoredPushToken {
  token: string;
  platform: string;
  appServerId?: string;
  updatedAt: string;
}

export interface PushNotificationPayload {
  title: string;
  body?: string;
  sessionId?: string;
  status?: string;
  kind?: string;
  data?: Record<string, string | number | boolean | null | undefined>;
  showNotification?: boolean;
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
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
    return Array.isArray(parsed) ? parsed.filter((entry) => entry?.token) : [];
  } catch {
    return [];
  }
}

function writeStore(entries: StoredPushToken[]): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(entries, null, 2), { mode: 0o600 });
}

export function registerPushToken(
  fcmToken: string,
  platform = "android",
  appServerId?: string,
): void {
  const token = fcmToken.trim();
  if (!token) return;

  const withoutToken = readStore().filter((entry) => entry.token !== token);
  writeStore([
    ...withoutToken,
    {
      token,
      platform,
      ...(appServerId ? { appServerId } : {}),
      updatedAt: new Date().toISOString(),
    },
  ].slice(-20));
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
): boolean {
  const token = fcmToken.trim();
  if (!token) return false;
  return readStore().some((entry) => (
    entry.token === token && (!appServerId || entry.appServerId === appServerId)
  ));
}

export function isPushConfigured(): boolean {
  return Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON
      || process.env.FIREBASE_SERVICE_ACCOUNT_PATH
      || process.env.GOOGLE_APPLICATION_CREDENTIALS
  );
}

function loadServiceAccountCredentials(): Record<string, unknown> | null {
  if (cachedCredentials !== undefined) return cachedCredentials;
  try {
    const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    if (rawJson) {
      const credentials = JSON.parse(rawJson) as Record<string, unknown>;
      cachedCredentials = credentials;
      return credentials;
    }
    if (serviceAccountPath) {
      const credentials = JSON.parse(fs.readFileSync(serviceAccountPath, "utf-8")) as Record<string, unknown>;
      cachedCredentials = credentials;
      return credentials;
    }
    cachedCredentials = null;
    return null;
  } catch (err: any) {
    console.error(`[Push] Firebase credentials could not be read: ${err.message || err}`);
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
  } catch (err: any) {
    console.error(`[Push] Firebase project ID could not be resolved: ${err.message || err}`);
    return null;
  }
}

function removeTokens(tokensToRemove: Set<string>): void {
  if (tokensToRemove.size === 0) return;
  writeStore(readStore().filter((entry) => !tokensToRemove.has(entry.token)));
}

function fcmDetailErrorCode(err: any): string {
  const details = err?.response?.data?.error?.details;
  if (Array.isArray(details)) {
    for (const detail of details) {
      const type = typeof detail?.["@type"] === "string" ? detail["@type"] : "";
      if (type.includes("google.firebase.fcm.v1.FcmError") && typeof detail?.errorCode === "string") {
        return detail.errorCode;
      }
    }
  }
  return "";
}

function fcmErrorCode(err: any): string {
  const fcmCode = fcmDetailErrorCode(err);
  if (fcmCode) return fcmCode;
  return err?.response?.data?.error?.status || err?.code || "";
}

function isInvalidFcmTokenError(err: any): boolean {
  const code = fcmDetailErrorCode(err);
  return code === "UNREGISTERED" || code === "INVALID_ARGUMENT";
}

async function sendFcmHttpV1(
  auth: GoogleAuth,
  projectId: string,
  token: string,
  data: Record<string, string>,
  payload: PushNotificationPayload,
): Promise<void> {
  const client = await auth.getClient();
  const message: Record<string, unknown> = {
    token,
    data,
    android: {
      priority: "HIGH",
    },
  };

  if (payload.showNotification !== false) {
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

export async function sendPushNotification(
  payload: PushNotificationPayload,
): Promise<{ sent: number; attempted: number }> {
  const entries = readStore();
  const tokens = entries.map((entry) => entry.token).filter(Boolean);
  if (tokens.length === 0) return { sent: 0, attempted: 0 };
  const auth = getFcmAuth();
  if (!auth) return { sent: 0, attempted: tokens.length };
  const projectId = await getFcmProjectId(auth);
  if (!projectId) return { sent: 0, attempted: tokens.length };

  const groups = new Map<string, StoredPushToken[]>();
  for (const entry of entries) {
    const key = entry.appServerId || "";
    groups.set(key, [...(groups.get(key) || []), entry]);
  }

  let sent = 0;
  const invalid = new Set<string>();
  for (const [appServerId, group] of groups) {
    const groupTokens = group.map((entry) => entry.token).filter(Boolean);
    if (groupTokens.length === 0) continue;
    const data: Record<string, string> = {
      title: payload.title,
      body: payload.body || "",
      sessionId: payload.sessionId || "",
      serverId: appServerId,
      status: payload.status || "manual",
      kind: payload.kind || "",
    };
    for (const [key, value] of Object.entries(payload.data || {})) {
      data[key] = value == null ? "" : String(value);
    }

    for (const token of groupTokens) {
      try {
        await sendFcmHttpV1(auth, projectId, token, data, payload);
        sent++;
      } catch (err: any) {
        const code = fcmErrorCode(err);
        if (isInvalidFcmTokenError(err)) {
          invalid.add(token);
        }
        console.warn(`[Push] FCM send failed: ${code || err?.message || "unknown error"}`);
      }
    }
  }
  removeTokens(invalid);
  return { sent, attempted: tokens.length };
}
