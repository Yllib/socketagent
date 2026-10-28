import * as crypto from "crypto";
import type { AiConnectorGrant } from "./ai-connector-store";
import type { ComputerAccessAnswer } from "./computer-access-requests";
import { canonicalJson, type ComputerLinkPeerApi, type PeerAction } from "./computer-link-peer";
import type { ComputerAccessRequestCard, ComputerApprovalToken } from "./protocol";

/**
 * How long an MCP call waits for the phone before answering. AI clients give
 * up on a tool call long before a card's ten minute life, so the call returns
 * early and the retry collects the answer once the user has approved.
 */
export const APPROVAL_WAIT_MS = 20_000;
/** How long a finished result is kept for the retry that collects it. */
export const HELD_RESULT_TTL_MS = 10 * 60 * 1000;

export interface ConnectorHostActionsDeps {
  peerApi: Pick<ComputerLinkPeerApi, "handle">;
  /** This computer, as the card names it on both sides. */
  self(): { name: string; publicKey: string };
  /** Raises the card in the client's session and resolves with the phone's answer. */
  ask(
    sessionId: string,
    card: Omit<ComputerAccessRequestCard, "requestId" | "expiresAt"> & { expiresAt?: number },
  ): Promise<ComputerAccessAnswer>;
  /** A push for the card, so the phone shows it without the app open. */
  notify?(grant: AiConnectorGrant, summary: string): void;
  waitMs?: number;
}

interface Inflight {
  promise: Promise<unknown>;
  /** Set while the call sits on a card, the only wait a client should not sit through. */
  waitingForApproval: boolean;
  settled: boolean;
  holdTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Runs an AI client's actions on the computer that hosts the connector,
 * through the same peer API a linked computer uses, so the registry's
 * access boxes and confirm mode apply. When the computer wants approval the
 * card goes in the client's session and names the client; the approval the
 * phone seals carries the client's key, since this computer is both source
 * and target.
 */
export class ConnectorHostActions {
  private readonly inflight = new Map<string, Inflight>();
  private readonly waitMs: number;

  constructor(private readonly deps: ConnectorHostActionsDeps) {
    this.waitMs = deps.waitMs ?? APPROVAL_WAIT_MS;
  }

  /**
   * The action's result. A call that is still waiting on the phone after
   * `waitMs` fails with a "waiting for approval" error and keeps running;
   * the same call again, within ten minutes, returns what it produced
   * without a second card.
   */
  async run(grant: AiConnectorGrant, action: PeerAction, args: Record<string, unknown>): Promise<unknown> {
    const key = `${grant.grantId}\u0000${action}\u0000${canonicalJson(args)}`;
    let entry = this.inflight.get(key);
    if (!entry) {
      const started: Inflight = { promise: Promise.resolve(), waitingForApproval: false, settled: false };
      started.promise = this.execute(started, grant, action, args).finally(() => {
        started.settled = true;
        started.holdTimer = setTimeout(() => {
          if (this.inflight.get(key) === started) this.inflight.delete(key);
        }, HELD_RESULT_TTL_MS);
        started.holdTimer.unref?.();
      });
      // A rejection nobody has collected yet is not unhandled; the retry collects it.
      started.promise.catch(() => undefined);
      this.inflight.set(key, started);
      entry = started;
    }
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        entry.promise.then((value) => ({ done: true as const, value }), (error: unknown) => ({ done: true as const, error, failed: true })),
        new Promise<{ done: false }>((resolve) => { timer = setTimeout(() => resolve({ done: false }), this.waitMs); }),
      ]).finally(() => clearTimeout(timer));
      if (!outcome.done) {
        // The action itself may take a while; only the card is left behind.
        if (!entry.waitingForApproval) continue;
        throw new Error(
          "Waiting for your approval on the phone. Approve the card in SocketAgent, then make this same request again within 10 minutes to get its result.",
        );
      }
      if (this.inflight.get(key) === entry) {
        this.inflight.delete(key);
        if (entry.holdTimer) clearTimeout(entry.holdTimer);
      }
      if ("failed" in outcome) throw outcome.error;
      return outcome.value;
    }
  }

  private async execute(entry: Inflight, grant: AiConnectorGrant, action: PeerAction, args: Record<string, unknown>): Promise<unknown> {
    const self = this.deps.self();
    let approval: ComputerApprovalToken | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.deps.peerApi.handle({
        type: "peer_request", id: crypto.randomUUID(), action, args, sourceSessionId: grant.sessionId,
        ...(approval ? { approval } : {}),
      }, grant.publicKey);
      if (!response) throw new Error("No answer from this computer");
      if (response.ok) return response.result;
      if (response.approvalRequired && !approval) {
        const challenge = response.approvalRequired;
        this.deps.notify?.(grant, challenge.summary.split("\n")[0].slice(0, 120));
        entry.waitingForApproval = true;
        let answer: ComputerAccessAnswer;
        try {
          answer = await this.deps.ask(grant.sessionId, {
            kind: "approval",
            source: self,
            target: self,
            action: challenge.action,
            summary: challenge.summary,
            challengeId: challenge.challengeId,
            digest: challenge.digest,
            expiresAt: challenge.expiresAt,
            client: { name: grant.clientName, publicKey: grant.publicKey },
            approvalKey: grant.publicKey,
          });
        } finally {
          entry.waitingForApproval = false;
        }
        if (answer.decision === "deny") throw new Error("The user denied this request.");
        if (answer.decision === "expired") throw new Error("The user did not answer the approval request in time.");
        if (!answer.approval) throw new Error("The app answered without an approval token. Update the app.");
        approval = answer.approval;
        continue;
      }
      if (response.code === "access_denied") {
        throw new Error(`${grant.clientName} is not allowed ${scopeLabel(action)} on ${self.name}. The user can change that under Devices in the SocketAgent app.`);
      }
      throw new Error(response.error || `${self.name} refused the ${actionLabel(action)}`);
    }
    throw new Error(`${self.name} kept asking for approval`);
  }
}

function scopeLabel(action: string): string {
  if (action === "run_command") return "commands";
  if (action.startsWith("agent_")) return "agents";
  return "reading sessions";
}

function actionLabel(action: string): string {
  if (action === "run_command") return "command";
  if (action.startsWith("agent_")) return "agent request";
  return "request";
}
