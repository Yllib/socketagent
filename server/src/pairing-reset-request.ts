import * as crypto from "crypto";
import * as http from "http";
import { isLoopbackRequest } from "./loopback-request";
import { constantTimeEqual } from "./secret-compare";
import { errorMessage, isRecord } from "./value-guards";

/**
 * How `socketagent pair --reset` asks the running server to start pairing
 * over. Both read AUTH_TOKEN from the same .env, and each proves to the
 * other that it holds the token before anything happens. The token itself
 * never goes on the wire, so a program that has taken the server's port
 * learns nothing it can use, and cannot make the script report a reset that
 * did not happen.
 *
 * Two loopback requests, JSON both ways, nonces as 64 hex characters:
 *
 *   1. POST /internal/pairing/reset/challenge  {clientNonce}
 *      answer {serverNonce, proof}, where proof is the "server" proof.
 *      The script checks it: the listener holds the token.
 *   2. POST /internal/pairing/reset  {serverNonce, proof}, the "reset" proof.
 *      The server checks it, starts pairing over, and answers {done}, the
 *      "done" proof made with the token as it was before the reset. The
 *      script checks that too: the reset happened.
 *
 * A proof is HMAC-SHA256 keyed by AUTH_TOKEN over the label, the role and
 * both nonces. The role keeps one proof from standing in for another, and
 * the server's nonce is good for one reset within 30 seconds, so a recorded
 * request cannot be sent again.
 *
 * index.ts calls `answerPairingResetRequest` from its HTTP handler.
 * show-pairing.js calls `requestPairingReset`.
 */

export const RESET_CHALLENGE_PATH = "/internal/pairing/reset/challenge";
export const RESET_PATH = "/internal/pairing/reset";
/** How long the script has to answer a challenge. */
export const RESET_CHALLENGE_LIFETIME_MS = 30_000;
/** Challenges kept at once. A new one past this replaces the oldest. */
export const MAX_RESET_CHALLENGES = 8;

const PROOF_LABEL = "socketagent-pairing-reset-v1";
const NONCE_PATTERN = /^[0-9a-f]{64}$/;
const MAX_BODY_BYTES = 1024;
const REQUEST_TIMEOUT_MS = 10_000;

type ProofRole = "server" | "reset" | "done";

function resetProof(authToken: string, role: ProofRole, clientNonce: string, serverNonce: string): string {
  return crypto.createHmac("sha256", authToken).update(`${PROOF_LABEL}\0${role}\0${clientNonce}\0${serverNonce}`).digest("hex");
}

function isNonce(value: unknown): value is string {
  return typeof value === "string" && NONCE_PATTERN.test(value);
}

/** The server's side: hands out challenges and runs one reset for each that is answered rightly. */
export class PairingResetGate {
  /** Open challenges by server nonce, oldest first. */
  private readonly challenges = new Map<string, { clientNonce: string; expiresAt: number }>();

  constructor(
    private readonly authToken: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Step 1. Null when the request is malformed. */
  challenge(body: unknown): { serverNonce: string; proof: string } | null {
    const token = this.authToken();
    if (!token || !isRecord(body) || !isNonce(body.clientNonce)) return null;
    const now = this.now();
    for (const [nonce, challenge] of this.challenges) if (challenge.expiresAt <= now) this.challenges.delete(nonce);
    const [oldest] = this.challenges.keys();
    if (this.challenges.size >= MAX_RESET_CHALLENGES && oldest !== undefined) this.challenges.delete(oldest);
    const serverNonce = crypto.randomBytes(32).toString("hex");
    this.challenges.set(serverNonce, { clientNonce: body.clientNonce, expiresAt: now + RESET_CHALLENGE_LIFETIME_MS });
    return { serverNonce, proof: resetProof(token, "server", body.clientNonce, serverNonce) };
  }

  /**
   * Step 2. Runs [startOver] when the proof fits a challenge that is still
   * open, and returns the receipt. Null, with nothing run, otherwise. A
   * challenge is spent by its first answer, right or wrong.
   */
  reset(body: unknown, startOver: () => void): { done: string } | null {
    const token = this.authToken();
    if (!token || !isRecord(body) || !isNonce(body.serverNonce) || typeof body.proof !== "string") return null;
    const challenge = this.challenges.get(body.serverNonce);
    this.challenges.delete(body.serverNonce);
    if (!challenge || challenge.expiresAt <= this.now()) return null;
    if (!constantTimeEqual(body.proof, resetProof(token, "reset", challenge.clientNonce, body.serverNonce))) return null;
    // The receipt is keyed by the token the script holds. The reset makes a new one.
    const done = resetProof(token, "done", challenge.clientNonce, body.serverNonce);
    startOver();
    return { done };
  }
}

/** A small JSON request body. Undefined when it is too large or does not parse. */
function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on("error", () => resolve(undefined));
    req.on("end", () => {
      if (size > MAX_BODY_BYTES) return resolve(undefined);
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(parsed);
      } catch {
        resolve(undefined);
      }
    });
  });
}

/**
 * Answers the two reset routes. Returns false, with nothing read or sent,
 * when the request is for neither. Only this computer may ask.
 */
export function answerPairingResetRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  gate: PairingResetGate,
  startOver: () => void,
): boolean {
  const route = req.url?.split("?")[0];
  if (req.method !== "POST" || (route !== RESET_CHALLENGE_PATH && route !== RESET_PATH)) return false;
  const answer = (status: number, body: Record<string, string>) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (!isLoopbackRequest(req)) {
    answer(401, { error: "Unauthorized" });
    return true;
  }
  void readJsonBody(req).then((body) => {
    if (route === RESET_CHALLENGE_PATH) {
      const challenge = gate.challenge(body);
      if (challenge) answer(200, challenge);
      else answer(400, { error: "Invalid request" });
      return;
    }
    try {
      const receipt = gate.reset(body, startOver);
      if (receipt) answer(200, receipt);
      else answer(401, { error: "Unauthorized" });
    } catch (error: unknown) {
      console.error(`[Devices] Could not start pairing over: ${errorMessage(error)}`);
      answer(500, { error: "Could not reset pairing" });
    }
  });
  return true;
}

/** One JSON POST to this computer's own port. Null when nothing listens there. */
function postJson(port: number, path: string, body: Record<string, string>): Promise<{ status: number; body: unknown } | null> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      host: "127.0.0.1", port, path, method: "POST", timeout: REQUEST_TIMEOUT_MS,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_BODY_BYTES) chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        let parsed: unknown;
        try {
          if (size <= MAX_BODY_BYTES) parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          // Not JSON. The caller sees a body it cannot check.
        }
        resolve({ status: response.statusCode ?? 0, body: parsed });
      });
    });
    request.on("timeout", () => request.destroy(new Error(`Port ${port} on this computer did not answer the reset`)));
    request.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") resolve(null);
      else reject(error);
    });
    request.end(payload);
  });
}

/**
 * The script's side. Resolves `done` when the running server proved itself
 * and confirmed the reset, and `no-server` when nothing listens on [port],
 * so the caller may write the files itself. Rejects, with nothing changed
 * by this side and AUTH_TOKEN never sent, when whatever answered did not
 * prove it holds [authToken].
 */
export async function requestPairingReset(port: number, authToken: string): Promise<"done" | "no-server"> {
  const clientNonce = crypto.randomBytes(32).toString("hex");
  const challenge = await postJson(port, RESET_CHALLENGE_PATH, { clientNonce });
  if (!challenge) return "no-server";
  const offered = challenge.body;
  if (
    !authToken || challenge.status !== 200 || !isRecord(offered) || !isNonce(offered.serverNonce) || typeof offered.proof !== "string"
    || !constantTimeEqual(offered.proof, resetProof(authToken, "server", clientNonce, offered.serverNonce))
  ) {
    throw new Error(
      `Something answers on port ${port} of this computer but did not prove it is this install's SocketAgent server. `
      + "Nothing was changed. Stop whatever holds the port, or stop the server, and run the reset again.",
    );
  }
  const { serverNonce } = offered;
  const result = await postJson(port, RESET_PATH, { serverNonce, proof: resetProof(authToken, "reset", clientNonce, serverNonce) });
  const receipt = result?.body;
  if (
    result?.status !== 200 || !isRecord(receipt) || typeof receipt.done !== "string"
    || !constantTimeEqual(receipt.done, resetProof(authToken, "done", clientNonce, serverNonce))
  ) {
    throw new Error(`The running server did not confirm the reset${result ? ` (HTTP ${result.status})` : ""}. Check its log, then run the reset again.`);
  }
  return "done";
}
