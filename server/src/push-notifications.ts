import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";

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
}

const STORE_PATH = process.env.PUSH_TOKEN_STORE
  || path.join(os.homedir(), ".claude-assistant", "push-tokens.json");

let firebaseReady: boolean | null = null;

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

export function isPushConfigured(): boolean {
  return Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON
      || process.env.FIREBASE_SERVICE_ACCOUNT_PATH
      || process.env.GOOGLE_APPLICATION_CREDENTIALS
      || getApps().length > 0
  );
}

function ensureFirebase(): boolean {
  if (firebaseReady !== null) return firebaseReady;
  if (getApps().length > 0) {
    firebaseReady = true;
    return true;
  }

  try {
    const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    if (rawJson) {
      initializeApp({ credential: cert(JSON.parse(rawJson)) });
    } else if (serviceAccountPath) {
      initializeApp({ credential: cert(JSON.parse(fs.readFileSync(serviceAccountPath, "utf-8"))) });
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      initializeApp({ credential: applicationDefault() });
    } else {
      console.warn("[Push] Firebase credentials not configured; push notifications disabled");
      firebaseReady = false;
      return false;
    }
    firebaseReady = true;
    console.log("[Push] Firebase Admin initialized");
    return true;
  } catch (err: any) {
    console.error(`[Push] Firebase initialization failed: ${err.message || err}`);
    firebaseReady = false;
    return false;
  }
}

function removeTokens(tokensToRemove: Set<string>): void {
  if (tokensToRemove.size === 0) return;
  writeStore(readStore().filter((entry) => !tokensToRemove.has(entry.token)));
}

export async function sendPushNotification(
  payload: PushNotificationPayload,
): Promise<{ sent: number; attempted: number }> {
  const entries = readStore();
  const tokens = entries.map((entry) => entry.token).filter(Boolean);
  if (tokens.length === 0) return { sent: 0, attempted: 0 };
  if (!ensureFirebase()) return { sent: 0, attempted: tokens.length };

  const response = await getMessaging().sendEachForMulticast({
    tokens,
    data: {
      title: payload.title,
      body: payload.body || "",
      sessionId: payload.sessionId || "",
      serverId: entries.find((entry) => entry.appServerId)?.appServerId || "",
      status: payload.status || "manual",
    },
    android: {
      priority: "high",
    },
  });

  const invalid = new Set<string>();
  response.responses.forEach((item, index) => {
    if (!item.success) {
      const code = item.error?.code || "";
      if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
        invalid.add(tokens[index]);
      }
      console.warn(`[Push] FCM send failed: ${code || item.error?.message || "unknown error"}`);
    }
  });
  removeTokens(invalid);
  return { sent: response.successCount, attempted: tokens.length };
}
