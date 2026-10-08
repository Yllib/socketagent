#!/usr/bin/env node
// Uploads the Play app bundle that `build-app.sh --flavor play --bundle` made
// and releases it on a Play track.
//
// Usage:
//   GOOGLE_PLAY_SERVICE_ACCOUNT_JSON=/path/key.json ./upload-play.mjs [options]
//
//   --urgent           Installed apps update right away through Play's
//                      full-screen update. Without it they show the
//                      "Update available" banner. The choice is fixed per
//                      release once uploaded.
//   --track NAME       production (default), beta, alpha, or internal.
//   --aab PATH         Bundle to upload. Defaults to the Play build output.
//   --dry-run          Sign in and show the track's current releases without
//                      changing anything.
//
// The app reads the release's in-app update priority. `--urgent` sets 5, at
// or above UpdateService.urgentPlayPriority in the app; normal releases get 0.

import { readFile } from "node:fs/promises";
import { createSign } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const PACKAGE = "com.socketagent.app";
const API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}`;
const UPLOAD_API = `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PACKAGE}`;
const URGENT_PRIORITY = 5;

const here = dirname(fileURLToPath(import.meta.url));
const { values: options } = parseArgs({
  options: {
    urgent: { type: "boolean", default: false },
    track: { type: "string", default: "production" },
    aab: {
      type: "string",
      default: join(here, "../socketagent-app/build/app/outputs/bundle/playRelease/app-play-release.aab"),
    },
    "dry-run": { type: "boolean", default: false },
  },
});

/** Exchanges the service account key for an Android Publisher access token. */
async function accessToken() {
  const keyPath = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  if (!keyPath) throw new Error("Set GOOGLE_PLAY_SERVICE_ACCOUNT_JSON to the service account key file.");
  const key = JSON.parse(await readFile(keyPath, "utf8"));
  const now = Math.floor(Date.now() / 1000);
  const encode = (part) => Buffer.from(JSON.stringify(part)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: key.token_uri,
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url");
  const response = await fetch(key.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });
  if (!response.ok) throw new Error(`Google sign-in failed: ${response.status} ${await response.text()}`);
  return (await response.json()).access_token;
}

const token = await accessToken();

/** Calls the Play Developer API and returns its JSON reply. */
async function play(method, url, body, contentType = "application/json") {
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": contentType } : {}) },
    body: body && contentType === "application/json" ? JSON.stringify(body) : body,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${url} failed: ${response.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

const edit = await play("POST", `${API}/edits`);
const editUrl = `${API}/edits/${edit.id}`;

if (options["dry-run"]) {
  const track = await play("GET", `${editUrl}/tracks/${options.track}`);
  for (const release of track.releases ?? []) {
    console.log(
      `${options.track}: ${release.name ?? "(unnamed)"} codes ${release.versionCodes?.join(",")} ` +
        `${release.status}, update priority ${release.inAppUpdatePriority ?? 0}`,
    );
  }
  await play("DELETE", editUrl);
  console.log("Dry run, nothing changed.");
} else {
  const bundle = await play(
    "POST",
    `${UPLOAD_API}/edits/${edit.id}/bundles?uploadType=media`,
    await readFile(options.aab),
    "application/octet-stream",
  );
  const priority = options.urgent ? URGENT_PRIORITY : 0;
  await play("PUT", `${editUrl}/tracks/${options.track}`, {
    track: options.track,
    releases: [{ versionCodes: [String(bundle.versionCode)], status: "completed", inAppUpdatePriority: priority }],
  });
  await play("POST", `${editUrl}:commit`);
  console.log(
    `Released version code ${bundle.versionCode} on ${options.track}, ` +
      (options.urgent ? "urgent: apps update right away." : "apps show the update banner."),
  );
}
