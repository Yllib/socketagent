import * as crypto from "crypto";
import { z } from "zod";
import type { Backend, ComputerApprovalToken } from "./protocol";
import type { DeviceEntry, DeviceRegistry, ComputerAccess, ComputerConfirm } from "./device-registry";
import { decrypt, fromBase64, type KeyPair } from "./relay-crypto";
import type { AgentSessionToolArgs, AgentSessionToolResponse, DelegatedAgentTail } from "./delegated-agent-types";
import { clampPeerCommandTimeout, peerShellName, resolvePeerCommandCwd, type PeerCommandRequest, type PeerCommandResult } from "./peer-command";
import { errorMessage, isRecord } from "./value-guards";

/** Actions a source computer may ask for over the link lane. */
export const PEER_ACTIONS = [
  "hello", "sessions_list", "transcript_read", "transcript_search", "run_command",
  "agent_start", "agent_message", "agent_status", "agent_tail", "agent_stop", "agent_list",
  "agent_report_ack",
] as const;
export type PeerAction = typeof PEER_ACTIONS[number];

export const CHALLENGE_TTL_MS = 10 * 60 * 1000;
export const CHAT_GRANT_TTL_MS = 12 * 60 * 60 * 1000;
/** How long the source has to make the one request a one-time grant allows. */
export const ONE_TIME_GRANT_TTL_MS = 15 * 60 * 1000;

const approvalTokenSchema = z.object({ from: z.string(), n: z.string(), c: z.string() });

export const peerRequestSchema = z.object({
  type: z.literal("peer_request"),
  id: z.string().min(1).max(200),
  action: z.enum(PEER_ACTIONS),
  args: z.record(z.string(), z.unknown()).default({}),
  sourceSessionId: z.string().max(400).default(""),
  approval: approvalTokenSchema.optional(),
});
export type PeerRequest = z.infer<typeof peerRequestSchema>;

export const peerResponseSchema = z.object({
  type: z.literal("peer_response"),
  id: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  code: z.enum(["access_denied", "denied", "not_found", "invalid", "approval_invalid"]).optional(),
  approvalRequired: z.object({
    challengeId: z.string(),
    action: z.string(),
    summary: z.string(),
    digest: z.string(),
    expiresAt: z.number(),
  }).optional(),
});
export type PeerResponse = z.infer<typeof peerResponseSchema>;

export const peerEventSchema = z.object({
  type: z.literal("peer_event"),
  event: z.literal("agent_report"),
  delegationId: z.string(),
  runId: z.string(),
  sessionId: z.string(),
  status: z.enum(["completed", "failed", "stopped"]),
  result: z.string(),
  label: z.string().optional(),
  backend: z.enum(["claude", "codex"]).optional(),
});
export type PeerEvent = z.infer<typeof peerEventSchema>;

const approvalClaimsSchema = z.object({
  digest: z.string(),
  challengeId: z.string(),
  scope: z.enum(["once", "chat"]),
  sourceSessionId: z.string(),
  sourceKey: z.string(),
  expiresAt: z.number(),
});
export type ApprovalClaims = z.infer<typeof approvalClaimsSchema>;

const runCommandArgs = z.object({
  command: z.string().min(1).max(20_000),
  cwd: z.string().max(4_000).optional(),
  timeoutSeconds: z.number().optional(),
});
const sessionsListArgs = z.object({ limit: z.number().int().min(1).max(200).optional() });
const transcriptReadArgs = z.object({
  sessionId: z.string().min(1),
  afterSeq: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
const transcriptSearchArgs = z.object({ query: z.string().min(1).max(500), limit: z.number().int().min(1).max(50).optional() });
const agentArgs = z.object({
  prompt: z.string().optional(),
  session_id: z.string().optional(),
  delegation_id: z.string().optional(),
  backend: z.enum(["claude", "codex"]).optional(),
  cwd: z.string().optional(),
  label: z.string().optional(),
  model: z.string().optional(),
  effort: z.enum(["minimal", "low", "medium", "high", "max", "xhigh", "ultra"]).optional(),
  permissionMode: z.string().optional(),
  after_session_seq: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
const reportAckArgs = z.object({ delegationId: z.string(), runId: z.string() });

export interface PeerSessionSummary {
  id: string;
  title: string;
  backend: Backend;
  cwd: string;
  updatedAt: string;
  running: boolean;
}

export interface PeerTranscriptHit {
  sessionId: string;
  sessionSeq: number;
  role: string;
  timestamp?: string;
  preview: string;
  title?: string;
}

/** The source computer and chat a remote agent request came from. */
export interface RemoteSupervisor {
  publicKey: string;
  name: string;
  sourceSessionId: string;
}

/** Everything the peer API needs from index.ts. */
export interface PeerApiHost {
  serverName(): string;
  backends(): Backend[];
  listSessions(limit: number): PeerSessionSummary[];
  readTranscript(sessionId: string, afterSeq: number | undefined, limit: number | undefined): DelegatedAgentTail;
  searchTranscripts(query: string, limit: number): Promise<PeerTranscriptHit[]>;
  runCommand(request: PeerCommandRequest): Promise<PeerCommandResult>;
  agent(args: AgentSessionToolArgs, supervisor: RemoteSupervisor): Promise<AgentSessionToolResponse>;
  ackAgentReport(delegationId: string, runId: string): void;
  /** A computer said hello; pending reports for it can be sent now. */
  onHello?(publicKey: string): void;
}

/** JSON with sorted keys and no whitespace so both sides hash the same bytes. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function requestDigest(parts: {
  action: string;
  args: Record<string, unknown>;
  sourceSessionId: string;
  sourceKey: string;
  challengeId: string;
}): string {
  return crypto.createHash("sha256").update(canonicalJson(parts)).digest("hex");
}

/** What a one-time grant names: the action and its exact args, so it fits one request only. */
export function oneTimeDigest(action: string, args: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(canonicalJson({ action, args })).digest("hex");
}

export function accessFor(action: PeerAction): keyof ComputerAccess | null {
  switch (action) {
    case "hello":
    case "agent_report_ack":
      return null;
    case "sessions_list":
    case "transcript_read":
    case "transcript_search":
      return "read";
    case "run_command":
      return "commands";
    default:
      return "agents";
  }
}

function needsConfirm(action: PeerAction): boolean {
  return action !== "hello" && action !== "agent_report_ack";
}

export function approvalSummary(action: PeerAction, args: Record<string, unknown>): string {
  if (action === "run_command") {
    const parsed = runCommandArgs.safeParse(args);
    if (!parsed.success) return "Run a command";
    const cwd = parsed.data.cwd?.trim();
    return cwd ? `${parsed.data.command}\nin ${cwd}` : parsed.data.command;
  }
  const prompt = typeof args.prompt === "string" ? args.prompt.replace(/\s+/g, " ").trim() : "";
  const preview = prompt.length > 200 ? `${prompt.slice(0, 197)}...` : prompt;
  switch (action) {
    case "agent_start":
      return `Start a ${typeof args.backend === "string" ? args.backend : ""} agent${args.cwd ? ` in ${String(args.cwd)}` : ""}: ${preview}`.replace("  ", " ");
    case "agent_message":
      return `Message agent ${String(args.session_id || args.delegation_id || "")}: ${preview}`;
    case "agent_stop":
      return `Stop agent ${String(args.session_id || args.delegation_id || "")}`;
    case "agent_status":
    case "agent_tail":
      return `Read agent ${String(args.session_id || args.delegation_id || "")}`;
    case "agent_list":
      return "List agents started from this chat";
    case "sessions_list":
      return "List recent sessions";
    case "transcript_read":
      return `Read transcript ${String(args.sessionId || "")}`;
    case "transcript_search":
      return `Search transcripts for "${String(args.query || "")}"`;
    default:
      return action;
  }
}

interface Challenge {
  challengeId: string;
  digest: string;
  action: PeerAction;
  sourceKey: string;
  sourceSessionId: string;
  expiresAt: number;
}

/**
 * Answers peer_request messages from linked computers. Access and confirm
 * come from the registry entry for the caller's key, and approvals are
 * verified here with the target's own key, so neither the relay nor the
 * source computer can grant anything.
 */
export class ComputerLinkPeerApi {
  private challenges = new Map<string, Challenge>();
  private chatGrants = new Map<string, number>();
  private usedTokens = new Map<string, number>();
  /** `${sourceKey}\n${digest}` to when the grant lapses. */
  private oneTimeGrants = new Map<string, number>();

  constructor(
    private readonly registry: DeviceRegistry,
    private readonly keyPair: KeyPair,
    private readonly host: PeerApiHost,
    private readonly now: () => number = Date.now,
  ) {}

  /** Parses one decrypted link-lane message and produces the response, if any. */
  async handle(raw: Record<string, unknown>, publicKey: string): Promise<PeerResponse | undefined> {
    const parsed = peerRequestSchema.safeParse(raw);
    if (!parsed.success) {
      const id = typeof raw.id === "string" ? raw.id : "";
      if (raw.type !== "peer_request") return undefined;
      return { type: "peer_response", id, ok: false, code: "invalid", error: "Invalid peer request" };
    }
    const request = parsed.data;
    const entry = this.registry.get(publicKey);
    // Connector clients act here through the same access and approval rules
    // as linked computers; the AI connector calls handle() with their key.
    if (entry?.kind !== "computer" && entry?.kind !== "connector") {
      return this.fail(request, "access_denied", "This computer is not linked here");
    }
    try {
      return await this.dispatch(request, entry, publicKey);
    } catch (err: unknown) {
      return this.fail(request, undefined, errorMessage(err) || "Peer request failed");
    }
  }

  private fail(request: PeerRequest, code: PeerResponse["code"], error: string): PeerResponse {
    return { type: "peer_response", id: request.id, ok: false, ...(code ? { code } : {}), error };
  }

  private ok(request: PeerRequest, result: unknown): PeerResponse {
    return { type: "peer_response", id: request.id, ok: true, result };
  }

  /**
   * The user allowed one request from `publicKey` whose oneTimeDigest is
   * `digest`. It skips the access and confirm checks once. Returns when the
   * grant lapses.
   */
  grantOneTime(publicKey: string, digest: string): number {
    this.expire();
    const expiresAt = this.now() + ONE_TIME_GRANT_TTL_MS;
    this.oneTimeGrants.set(`${publicKey}\n${digest}`, expiresAt);
    return expiresAt;
  }

  private consumeOneTime(request: PeerRequest, publicKey: string): boolean {
    this.expire();
    return this.oneTimeGrants.delete(`${publicKey}\n${oneTimeDigest(request.action, request.args)}`);
  }

  private async dispatch(request: PeerRequest, entry: DeviceEntry, publicKey: string): Promise<PeerResponse> {
    const access: ComputerAccess = entry.access ?? { read: false, agents: false, commands: false };
    const confirm: ComputerConfirm = entry.confirm ?? "ask";
    const needed = accessFor(request.action);
    if (!(needed && this.consumeOneTime(request, publicKey))) {
      if (needed && !access[needed]) {
        return this.fail(request, "access_denied", `${needed} access is not allowed`);
      }
      if (needsConfirm(request.action) && confirm !== "never") {
        const verdict = this.checkApproval(request, publicKey);
        if (verdict !== "approved") return verdict;
      }
    }
    this.registry.touch(publicKey);
    switch (request.action) {
      case "hello": {
        this.host.onHello?.(publicKey);
        return this.ok(request, {
          name: this.host.serverName(),
          access,
          confirm,
          ...(entry.expiresAt !== undefined ? { expiresAt: entry.expiresAt } : {}),
          platform: process.platform,
          shell: peerShellName(),
          backends: this.host.backends(),
        });
      }
      case "sessions_list": {
        const args = sessionsListArgs.parse(request.args);
        return this.ok(request, { sessions: this.host.listSessions(args.limit ?? 30) });
      }
      case "transcript_read": {
        const args = transcriptReadArgs.parse(request.args);
        return this.ok(request, this.host.readTranscript(args.sessionId, args.afterSeq, args.limit));
      }
      case "transcript_search": {
        const args = transcriptSearchArgs.parse(request.args);
        return this.ok(request, { hits: await this.host.searchTranscripts(args.query, args.limit ?? 20) });
      }
      case "run_command": {
        const args = runCommandArgs.parse(request.args);
        return this.ok(request, await this.host.runCommand({
          command: args.command,
          cwd: resolvePeerCommandCwd(args.cwd),
          timeoutSeconds: clampPeerCommandTimeout(args.timeoutSeconds),
        }));
      }
      case "agent_report_ack": {
        const args = reportAckArgs.parse(request.args);
        this.host.ackAgentReport(args.delegationId, args.runId);
        return this.ok(request, { acknowledged: true });
      }
      default: {
        const args = agentArgs.parse(request.args);
        const action = request.action.slice("agent_".length);
        if (action !== "start" && action !== "message" && action !== "status" && action !== "tail" && action !== "stop" && action !== "list") {
          return this.fail(request, "invalid", "Unknown agent action");
        }
        const response = await this.host.agent({ ...args, action }, {
          publicKey,
          name: entry.name || "Linked computer",
          sourceSessionId: request.sourceSessionId,
        });
        return this.ok(request, response);
      }
    }
  }

  /** Returns "approved" or the response that asks the source for an approval. */
  private checkApproval(request: PeerRequest, publicKey: string): "approved" | PeerResponse {
    this.expire();
    // A chat grant covers one kind of access, so allowing a transcript read
    // for a chat doesn't also allow commands or agents in it.
    const grantKey = `${publicKey}\n${request.sourceSessionId}\n${accessFor(request.action)}`;
    if (request.sourceSessionId && (this.chatGrants.get(grantKey) ?? 0) > this.now()) {
      return "approved";
    }
    if (request.approval) {
      const outcome = this.verifyApproval(request, publicKey);
      if (outcome.ok) {
        if (outcome.scope === "chat") this.chatGrants.set(grantKey, this.now() + CHAT_GRANT_TTL_MS);
        return "approved";
      }
      return this.fail(request, "approval_invalid", outcome.error);
    }
    const challengeId = crypto.randomUUID();
    const digest = requestDigest({
      action: request.action, args: request.args, sourceSessionId: request.sourceSessionId,
      sourceKey: publicKey, challengeId,
    });
    const expiresAt = this.now() + CHALLENGE_TTL_MS;
    this.challenges.set(challengeId, {
      challengeId, digest, action: request.action, sourceKey: publicKey,
      sourceSessionId: request.sourceSessionId, expiresAt,
    });
    return {
      type: "peer_response", id: request.id, ok: false,
      approvalRequired: { challengeId, action: request.action, summary: approvalSummary(request.action, request.args), digest, expiresAt },
    };
  }

  /**
   * Every check the spec lists: the box opens with `from`, `from` is an
   * enrolled device, the digest matches the retried request, the token is
   * unexpired and unused, and a chat scope names a chat.
   */
  verifyApproval(
    request: Pick<PeerRequest, "action" | "args" | "sourceSessionId" | "approval">,
    publicKey: string,
  ): { ok: true; scope: "once" | "chat" } | { ok: false; error: string } {
    const token: ComputerApprovalToken | undefined = request.approval;
    if (!token) return { ok: false, error: "Missing approval" };
    const approver = this.registry.get(token.from);
    if (approver?.kind !== "device") return { ok: false, error: "The approval did not come from an enrolled device" };
    let claims: ApprovalClaims;
    try {
      const fromKey = fromBase64(token.from);
      if (fromKey.length !== 32) throw new Error("bad key");
      claims = approvalClaimsSchema.parse(JSON.parse(decrypt({ n: token.n, c: token.c }, fromKey, this.keyPair.secretKey)));
    } catch {
      return { ok: false, error: "The approval could not be opened" };
    }
    if (claims.expiresAt <= this.now()) return { ok: false, error: "The approval expired" };
    if (claims.sourceKey !== publicKey || claims.sourceSessionId !== request.sourceSessionId) {
      return { ok: false, error: "The approval was issued for a different computer or chat" };
    }
    if (claims.scope === "chat" && !request.sourceSessionId) {
      return { ok: false, error: "A chat approval needs a chat" };
    }
    const challenge = this.challenges.get(claims.challengeId);
    if (!challenge || challenge.expiresAt <= this.now()) return { ok: false, error: "The approval does not match an open request" };
    if (challenge.sourceKey !== publicKey) return { ok: false, error: "The approval was issued for a different computer" };
    const expected = requestDigest({
      action: request.action, args: request.args, sourceSessionId: request.sourceSessionId,
      sourceKey: publicKey, challengeId: claims.challengeId,
    });
    const digestBuffer = Buffer.from(claims.digest, "utf8");
    const expectedBuffer = Buffer.from(expected, "utf8");
    if (digestBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(digestBuffer, expectedBuffer)
      || challenge.digest !== expected) {
      return { ok: false, error: "The approval is for a different request" };
    }
    const tokenId = crypto.createHash("sha256").update(token.c).digest("hex");
    if (this.usedTokens.has(tokenId)) return { ok: false, error: "The approval was already used" };
    this.usedTokens.set(tokenId, claims.expiresAt);
    this.challenges.delete(claims.challengeId);
    return { ok: true, scope: claims.scope };
  }

  private expire(): void {
    const now = this.now();
    for (const [id, challenge] of this.challenges) if (challenge.expiresAt <= now) this.challenges.delete(id);
    for (const [key, until] of this.chatGrants) if (until <= now) this.chatGrants.delete(key);
    for (const [id, until] of this.usedTokens) if (until <= now) this.usedTokens.delete(id);
    for (const [key, until] of this.oneTimeGrants) if (until <= now) this.oneTimeGrants.delete(key);
  }
}
