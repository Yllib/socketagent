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
  currentRevision: number;
  revisionCount: number;
}

export interface HtmlPlanRevisionRecord {
  revision: number;
  title: string;
  html: string;
  createdAt: string;
  restoredFromRevision?: number;
}

export interface HtmlPlanRevisionSummary {
  revision: number;
  title: string;
  createdAt: string;
  byteSize: number;
  restoredFromRevision?: number;
}

export interface HtmlPlanDiffSegment {
  type: "equal" | "added" | "removed";
  text: string;
}

interface StoredHtmlPlanRecord extends HtmlPlanRecord {
  revisionScheme: 2;
  revisions: HtmlPlanRevisionRecord[];
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

function normalizeStoredPlan(entry: any, sessionId: string): StoredHtmlPlanRecord | null {
  if (!entry || typeof entry.planId !== "string" || typeof entry.html !== "string") return null;
  const createdAt = String(entry.createdAt || entry.updatedAt || new Date().toISOString());
  const updatedAt = String(entry.updatedAt || createdAt);
  const legacyRevision: HtmlPlanRevisionRecord = {
    revision: 0,
    title: String(entry.title || "Plan"),
    html: entry.html,
    createdAt: updatedAt,
  };
  const hasStoredRevisions = Array.isArray(entry.revisions) && entry.revisions.length > 0;
  // v1.0.144 briefly stored snapshots as 1-based revisions. Convert those
  // records on read so creation is version 0 and the first change is revision 1.
  const legacyOffset = hasStoredRevisions && entry.revisionScheme !== 2 ? -1 : 0;
  const revisions = (hasStoredRevisions ? entry.revisions : [legacyRevision])
    .filter((revision: any) => revision && Number.isInteger(Number(revision.revision)) && typeof revision.html === "string")
    .map((revision: any): HtmlPlanRevisionRecord => ({
      revision: Number(revision.revision) + legacyOffset,
      title: String(revision.title || entry.title || "Plan"),
      html: revision.html,
      createdAt: String(revision.createdAt || updatedAt),
      ...(Number.isInteger(Number(revision.restoredFromRevision))
        ? { restoredFromRevision: Number(revision.restoredFromRevision) + legacyOffset }
        : {}),
    }))
    .sort((left: HtmlPlanRevisionRecord, right: HtmlPlanRevisionRecord) => left.revision - right.revision);
  if (revisions.length === 0) revisions.push(legacyRevision);
  const current = revisions[revisions.length - 1];
  return {
    planId: entry.planId,
    sessionId,
    title: String(entry.title || current.title || "Plan"),
    html: current.html,
    createdAt,
    updatedAt,
    currentRevision: current.revision,
    revisionCount: Math.max(0, revisions.length - 1),
    revisionScheme: 2,
    revisions,
  };
}

function readPlans(sessionId: string): StoredHtmlPlanRecord[] {
  const file = planFile(sessionId);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => normalizeStoredPlan(entry, sessionId))
      .filter((entry): entry is StoredHtmlPlanRecord => entry !== null);
  } catch {
    return [];
  }
}

function writePlans(sessionId: string, plans: StoredHtmlPlanRecord[]): void {
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

/** Validate the tool payload without rewriting the document the agent made. */
export function validateHtmlPlan(value: string): string {
  const html = String(value || "");
  if (!html.trim()) throw new Error("Plan HTML is required");
  if (Buffer.byteLength(html, "utf8") > MAX_HTML_PLAN_BYTES) {
    throw new Error(`Plan HTML exceeds the ${Math.round(MAX_HTML_PLAN_BYTES / 1024)} KB limit`);
  }
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
  const title = cleanTitle(args.title);
  const html = validateHtmlPlan(args.html);
  const existing = existingIndex >= 0 ? plans[existingIndex] : null;
  if (existing && existing.title === title && existing.html === html) return publicPlan(existing);
  const revision = existing ? existing.currentRevision + 1 : 0;
  const revisions = existing ? [...existing.revisions] : [];
  revisions.push({ revision, title, html, createdAt: now });
  const record: StoredHtmlPlanRecord = {
    planId,
    sessionId,
    title,
    html,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    currentRevision: revision,
    revisionCount: Math.max(0, revisions.length - 1),
    revisionScheme: 2,
    revisions,
  };
  if (existingIndex >= 0) plans[existingIndex] = record;
  else plans.push(record);
  writePlans(sessionId, plans);
  return publicPlan(record);
}

export function listHtmlPlans(sessionId: string): HtmlPlanRecord[] {
  return readPlans(sessionId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map(publicPlan);
}

/** Resolve one plan without exposing plans from any other originating session. */
export function getHtmlPlan(sessionId: string, planId: string): HtmlPlanRecord | undefined {
  const requested = String(planId || "").trim();
  if (!requested) return undefined;
  const plan = readPlans(sessionId).find((candidate) => candidate.planId === requested);
  return plan ? publicPlan(plan) : undefined;
}

/** Complete revision-preserving representation used by encrypted session transfer. */
export function exportHtmlPlansForSession(sessionId: string): unknown[] {
  return readPlans(sessionId).map((plan) => JSON.parse(JSON.stringify(plan)));
}

/** Restore plans while rebinding every record to the destination session. */
export function importHtmlPlansForSession(sessionId: string, rawPlans: unknown): void {
  if (!Array.isArray(rawPlans) || rawPlans.length === 0) return;
  const normalized = rawPlans
    .map((entry) => normalizeStoredPlan(entry, sessionId))
    .filter((entry): entry is StoredHtmlPlanRecord => entry !== null)
    .map((entry) => ({ ...entry, sessionId }));
  if (normalized.length > 0) writePlans(sessionId, normalized);
}

function publicPlan(plan: StoredHtmlPlanRecord): HtmlPlanRecord {
  const { revisions: _revisions, revisionScheme: _revisionScheme, ...record } = plan;
  return record;
}

function requirePlan(sessionId: string, planId: string): { plans: StoredHtmlPlanRecord[]; index: number; plan: StoredHtmlPlanRecord } {
  const plans = readPlans(sessionId);
  const index = plans.findIndex((plan) => plan.planId === planId);
  if (index < 0) throw new Error("HTML plan not found in this session");
  return { plans, index, plan: plans[index] };
}

export function listHtmlPlanRevisions(sessionId: string, planId: string): HtmlPlanRevisionSummary[] {
  const { plan } = requirePlan(sessionId, planId);
  return [...plan.revisions].reverse().map((revision) => ({
    revision: revision.revision,
    title: revision.title,
    createdAt: revision.createdAt,
    byteSize: Buffer.byteLength(revision.html, "utf8"),
    ...(revision.restoredFromRevision !== undefined
      ? { restoredFromRevision: revision.restoredFromRevision }
      : {}),
  }));
}

export function getHtmlPlanRevision(sessionId: string, planId: string, revisionNumber: number): HtmlPlanRevisionRecord {
  const { plan } = requirePlan(sessionId, planId);
  const revision = plan.revisions.find((candidate) => candidate.revision === revisionNumber);
  if (!revision) throw new Error("HTML plan revision not found");
  return { ...revision };
}

function diffTokens(value: string): string[] {
  return value.match(/<[^>]+>|&[^;\s]+;|[A-Za-z0-9_]+|[^A-Za-z0-9_\s]+|\s+/g) || [];
}

function coalesceDiff(segments: HtmlPlanDiffSegment[]): HtmlPlanDiffSegment[] {
  const result: HtmlPlanDiffSegment[] = [];
  for (const segment of segments) {
    if (!segment.text) continue;
    const previous = result[result.length - 1];
    if (previous?.type === segment.type) previous.text += segment.text;
    else result.push({ ...segment });
  }
  return result;
}

export function diffHtmlPlanRevisions(
  sessionId: string,
  planId: string,
  revisionNumber: number,
  requestedBaseRevision?: number,
): { baseRevision?: number; revision: number; segments: HtmlPlanDiffSegment[] } {
  const { plan } = requirePlan(sessionId, planId);
  const revision = getHtmlPlanRevision(sessionId, planId, revisionNumber);
  const prior = requestedBaseRevision === undefined
    ? [...plan.revisions].reverse().find((candidate) => candidate.revision < revisionNumber)
    : plan.revisions.find((candidate) => candidate.revision === requestedBaseRevision);
  const before = diffTokens(prior?.html || "");
  const after = diffTokens(revision.html);

  // Exact LCS for normal plans. Bound the matrix so a pathological, entirely
  // rewritten 512 KB document cannot monopolize the Node event loop.
  if (before.length * after.length > 1_500_000) {
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
    let suffix = 0;
    while (
      suffix < before.length - prefix && suffix < after.length - prefix
      && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
    ) suffix++;
    return {
      ...(prior ? { baseRevision: prior.revision } : {}),
      revision: revisionNumber,
      segments: coalesceDiff([
        { type: "equal", text: after.slice(0, prefix).join("") },
        { type: "removed", text: before.slice(prefix, before.length - suffix).join("") },
        { type: "added", text: after.slice(prefix, after.length - suffix).join("") },
        { type: "equal", text: after.slice(after.length - suffix).join("") },
      ]),
    };
  }

  const matrix = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));
  for (let left = 1; left <= before.length; left++) {
    for (let right = 1; right <= after.length; right++) {
      matrix[left][right] = before[left - 1] === after[right - 1]
        ? matrix[left - 1][right - 1] + 1
        : Math.max(matrix[left - 1][right], matrix[left][right - 1]);
    }
  }
  const reversed: HtmlPlanDiffSegment[] = [];
  let left = before.length;
  let right = after.length;
  while (left > 0 || right > 0) {
    if (left > 0 && right > 0 && before[left - 1] === after[right - 1]) {
      reversed.push({ type: "equal", text: before[left - 1] });
      left--;
      right--;
    } else if (right > 0 && (left === 0 || matrix[left][right - 1] >= matrix[left - 1][right])) {
      reversed.push({ type: "added", text: after[right - 1] });
      right--;
    } else {
      reversed.push({ type: "removed", text: before[left - 1] });
      left--;
    }
  }
  return {
    ...(prior ? { baseRevision: prior.revision } : {}),
    revision: revisionNumber,
    segments: coalesceDiff(reversed.reverse()),
  };
}

export function rollbackHtmlPlan(sessionId: string, planId: string, revisionNumber: number): HtmlPlanRecord {
  const { plans, index, plan } = requirePlan(sessionId, planId);
  const source = plan.revisions.find((revision) => revision.revision === revisionNumber);
  if (!source) throw new Error("HTML plan revision not found");
  const now = new Date().toISOString();
  const nextRevision = plan.currentRevision + 1;
  const revisions = [
    ...plan.revisions,
    {
      revision: nextRevision,
      title: source.title,
      html: source.html,
      createdAt: now,
      restoredFromRevision: source.revision,
    },
  ];
  const rolledBack: StoredHtmlPlanRecord = {
    ...plan,
    title: source.title,
    html: source.html,
    updatedAt: now,
    currentRevision: nextRevision,
    revisionCount: Math.max(0, revisions.length - 1),
    revisions,
  };
  plans[index] = rolledBack;
  writePlans(sessionId, plans);
  return publicPlan(rolledBack);
}

export function renameHtmlPlan(sessionId: string, planId: string, title: string): HtmlPlanRecord {
  const { plans, index } = requirePlan(sessionId, planId);
  plans[index] = { ...plans[index], title: cleanTitle(title), updatedAt: new Date().toISOString() };
  writePlans(sessionId, plans);
  return publicPlan(plans[index]);
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
  const merged = new Map(readPlans(newSessionId).map((plan) => [plan.planId, plan]));
  for (const plan of oldPlans) {
    merged.set(plan.planId, { ...plan, sessionId: newSessionId });
  }
  writePlans(newSessionId, [...merged.values()]);
  deleteHtmlPlansForSession(oldSessionId);
}
