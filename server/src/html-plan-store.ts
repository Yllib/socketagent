import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { socketAgentDataPath } from "./socket-agent-paths";

const PLAN_DIR = socketAgentDataPath("html-plans");
export const MAX_HTML_PLAN_BYTES = 512 * 1024;

export interface HtmlPlanRecord {
  planId: string;
  sessionId: string;
  title: string;
  html: string;
  createdAt: string;
  updatedAt: string;
}

function safeSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (!trimmed) throw new Error("HTML plans require an active session");
  return trimmed.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 180)
    || crypto.createHash("sha256").update(trimmed).digest("hex");
}

function planFile(sessionId: string): string {
  return path.join(PLAN_DIR, `${safeSessionId(sessionId)}.json`);
}

function readPlans(sessionId: string): HtmlPlanRecord[] {
  const file = planFile(sessionId);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is HtmlPlanRecord =>
      !!entry && typeof entry.planId === "string" && typeof entry.html === "string");
  } catch {
    return [];
  }
}

function writePlans(sessionId: string, plans: HtmlPlanRecord[]): void {
  fs.mkdirSync(PLAN_DIR, { recursive: true, mode: 0o700 });
  const file = planFile(sessionId);
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(plans, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

function cleanTitle(value: string): string {
  const title = String(value || "").replace(/\s+/g, " ").trim();
  if (!title) throw new Error("Plan title is required");
  return title.slice(0, 160);
}

function cleanPlanId(value?: string): string {
  const requested = String(value || "").trim();
  if (!requested) return crypto.randomUUID();
  const cleaned = requested.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-").slice(0, 120);
  return cleaned || crypto.randomUUID();
}

/**
 * Keep formatting HTML while removing executable, interactive, and remotely
 * loaded content. The app applies a second CSP/JavaScript-disabled boundary.
 */
export function sanitizeHtmlPlan(value: string): string {
  let html = String(value || "").trim();
  if (!html) throw new Error("Plan HTML is required");
  if (Buffer.byteLength(html, "utf8") > MAX_HTML_PLAN_BYTES) {
    throw new Error(`Plan HTML exceeds the ${Math.round(MAX_HTML_PLAN_BYTES / 1024)} KB limit`);
  }

  html = html
    .replace(/<!doctype[^>]*>/gi, "")
    .replace(/<!--([\s\S]*?)-->/g, "")
    .replace(/<(script|iframe|frame|frameset|object|embed|form|input|button|textarea|select|option|base|link|meta|audio|video|source)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|iframe|frame|frameset|object|embed|form|input|button|textarea|select|option|base|link|meta|audio|video|source)\b[^>]*\/?\s*>/gi, "")
    .replace(/\s(?:on[a-z]+|srcdoc|action|formaction)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/@import\s+[^;]+;?/gi, "")
    .replace(/url\(\s*(?!['"]?data:image\/(?:png|jpeg|gif|webp);base64,)[^)]+\)/gi, "none");

  html = html.replace(
    /\s(?:href|src|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (attribute, doubleQuoted, singleQuoted, unquoted) => {
      const url = String(doubleQuoted ?? singleQuoted ?? unquoted ?? "").trim();
      return url.startsWith("#") || /^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(url)
        ? attribute
        : "";
    },
  );

  return html;
}

export function saveHtmlPlan(args: {
  sessionId: string;
  title: string;
  html: string;
  planId?: string;
}): HtmlPlanRecord {
  const sessionId = args.sessionId.trim();
  const plans = readPlans(sessionId);
  const planId = cleanPlanId(args.planId);
  const existingIndex = plans.findIndex((plan) => plan.planId === planId);
  const now = new Date().toISOString();
  const record: HtmlPlanRecord = {
    planId,
    sessionId,
    title: cleanTitle(args.title),
    html: sanitizeHtmlPlan(args.html),
    createdAt: existingIndex >= 0 ? plans[existingIndex].createdAt : now,
    updatedAt: now,
  };
  if (existingIndex >= 0) plans[existingIndex] = record;
  else plans.push(record);
  writePlans(sessionId, plans);
  return record;
}

export function listHtmlPlans(sessionId: string): HtmlPlanRecord[] {
  return readPlans(sessionId).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function renameHtmlPlan(sessionId: string, planId: string, title: string): HtmlPlanRecord {
  const plans = readPlans(sessionId);
  const index = plans.findIndex((plan) => plan.planId === planId);
  if (index < 0) throw new Error("HTML plan not found in this session");
  plans[index] = { ...plans[index], title: cleanTitle(title), updatedAt: new Date().toISOString() };
  writePlans(sessionId, plans);
  return plans[index];
}

export function deleteHtmlPlan(sessionId: string, planId: string): boolean {
  const plans = readPlans(sessionId);
  const remaining = plans.filter((plan) => plan.planId !== planId);
  if (remaining.length === plans.length) return false;
  if (remaining.length === 0) {
    try { fs.unlinkSync(planFile(sessionId)); } catch {}
  } else {
    writePlans(sessionId, remaining);
  }
  return true;
}

export function deleteHtmlPlansForSession(sessionId: string): void {
  try { fs.unlinkSync(planFile(sessionId)); } catch {}
}

export function remapHtmlPlans(oldSessionId: string, newSessionId: string): void {
  if (!oldSessionId || !newSessionId || oldSessionId === newSessionId) return;
  const oldPlans = readPlans(oldSessionId);
  if (oldPlans.length === 0) return;
  const merged = new Map(listHtmlPlans(newSessionId).map((plan) => [plan.planId, plan]));
  for (const plan of oldPlans) {
    merged.set(plan.planId, { ...plan, sessionId: newSessionId });
  }
  writePlans(newSessionId, [...merged.values()]);
  deleteHtmlPlansForSession(oldSessionId);
}
