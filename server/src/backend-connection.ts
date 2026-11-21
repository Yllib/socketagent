import { backendName } from "./protocol";
import * as dns from "node:dns/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as tls from "node:tls";
import type { Backend } from "./protocol";

/**
 * Why this computer cannot reach a backend's provider, or "reachable" when
 * it can and the failure came from somewhere else.
 */
export type ConnectionCause = "offline" | "dns" | "blocked" | "intercepted" | "proxy" | "reachable";

export interface ConnectionDiagnosis {
  cause: ConnectionCause;
  /** The certificate issuer for "intercepted", the variable name for "proxy". */
  detail?: string;
}

/** The network checks behind a diagnosis. Each one rejects when it fails. */
export interface ConnectionProbe {
  /** Whether any network interface has a routable address. */
  hasNetwork(): boolean;
  resolve(host: string): Promise<unknown>;
  connect(host: string, port: number): Promise<unknown>;
  /** A verified TLS handshake. Rejects with the issuer name when the certificate is not trusted. */
  handshake(host: string): Promise<unknown>;
}

const PROXY_VARIABLES = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] as const;
const STEP_TIMEOUT_MS = 4_000;
const DIAGNOSIS_CACHE_MS = 10_000;

/**
 * Whether an error from Codex or Claude says a network request did not get
 * through, as opposed to the provider answering with a refusal.
 */
export function isBackendConnectionError(message: string): boolean {
  return /workspace routing discovery failed/i.test(message)
    || /falling back from websockets to https transport/i.test(message)
    || /error sending request|the request couldn't reach it|its address couldn't be looked up/i.test(message)
    || /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)\b/.test(message)
    || /\b(connection error|connection failed|fetch failed|unable to connect to (the )?api)\b/i.test(message);
}

function providerHost(backend: Backend, env: NodeJS.ProcessEnv): string {
  if (backend === "codex") return "chatgpt.com";
  if (backend === "gemini") return "cloudcode-pa.googleapis.com";
  try {
    return new URL(env.ANTHROPIC_BASE_URL || "").hostname || "api.anthropic.com";
  } catch {
    return "api.anthropic.com";
  }
}

function proxyTarget(env: NodeJS.ProcessEnv): { variable: string; host: string; port: number } | null {
  for (const variable of PROXY_VARIABLES) {
    const value = env[variable];
    if (!value) continue;
    try {
      const url = new URL(value);
      return { variable, host: url.hostname, port: Number(url.port) || (url.protocol === "https:" ? 443 : 80) };
    } catch {
      return null;
    }
  }
  return null;
}

function withTimeout<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), STEP_TIMEOUT_MS);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function issuerName(certificate: tls.PeerCertificate): string {
  const issuer = certificate.issuer;
  const name = issuer?.O || issuer?.CN;
  return Array.isArray(name) ? name[0] || "" : name || "";
}

const systemProbe: ConnectionProbe = {
  hasNetwork: () => Object.values(os.networkInterfaces()).some((addresses) => (addresses ?? []).some(
    (address) => !address.internal && !/^(169\.254\.|fe80:)/i.test(address.address),
  )),
  resolve: (host) => dns.lookup(host),
  connect: (host, port) => new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.once("connect", () => { socket.destroy(); resolve(); });
    socket.once("error", (error) => { socket.destroy(); reject(error); });
  }),
  handshake: (host) => new Promise<void>((resolve, reject) => {
    // Verification is checked by hand so an untrusted certificate still
    // completes the handshake and its issuer can be named.
    const socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false });
    socket.once("secureConnect", () => {
      const trusted = socket.authorized;
      const issuer = issuerName(socket.getPeerCertificate());
      socket.destroy();
      if (trusted) resolve();
      else reject(new Error(issuer));
    });
    // No certificate to name: the caller reads an empty message as a blocked connection.
    socket.once("error", () => { socket.destroy(); reject(new Error("")); });
  }),
};

/**
 * Finds out why this computer cannot reach [backend]'s provider, from the
 * server's own process and environment, which the backend inherits.
 */
export async function diagnoseBackendConnection(
  backend: Backend,
  probe: ConnectionProbe = systemProbe,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConnectionDiagnosis> {
  if (!probe.hasNetwork()) return { cause: "offline" };
  const proxy = proxyTarget(env);
  if (proxy) {
    // The backend talks to the proxy, not to the provider, so that is the hop to test.
    try {
      await withTimeout(probe.connect(proxy.host, proxy.port));
      return { cause: "reachable" };
    } catch {
      return { cause: "proxy", detail: proxy.variable };
    }
  }
  const host = providerHost(backend, env);
  try {
    await withTimeout(probe.resolve(host));
  } catch {
    return { cause: "dns" };
  }
  try {
    await withTimeout(probe.connect(host, 443));
  } catch {
    return { cause: "blocked" };
  }
  try {
    await withTimeout(probe.handshake(host));
  } catch (error) {
    const issuer = error instanceof Error ? error.message : "";
    // A handshake that broke without a certificate to blame is a blocked connection.
    return issuer && issuer !== "timed out" ? { cause: "intercepted", detail: issuer } : { cause: "blocked" };
  }
  return { cause: "reachable" };
}

/**
 * The card text for a diagnosis other than "reachable". [retrying] says the
 * backend is still trying on its own, so the user has nothing to resend yet.
 */
export function connectionFailureMessage(
  backend: Backend,
  diagnosis: ConnectionDiagnosis,
  options: { retrying?: boolean; env?: NodeJS.ProcessEnv } = {},
): string {
  const name = backendName(backend);
  const provider = backend === "codex" ? "OpenAI" : backend === "gemini" ? "Google" : "Anthropic";
  const host = providerHost(backend, options.env ?? process.env);
  const next = options.retrying
    ? `${name} keeps retrying for a few minutes.`
    : "Send your message again once it is fixed.";
  const finding = {
    offline: "This computer is not connected to a network.",
    dns: `This computer can't look up ${host}, so its internet connection or DNS is down.`,
    blocked: `This computer can't connect to ${host}. A firewall, a VPN or a network outage is in the way.`,
    intercepted: `Secure connections from this computer to ${host} are being intercepted (certificate issued by ${diagnosis.detail}). Antivirus web scanning and corporate proxies do this.`,
    proxy: `The proxy set in ${diagnosis.detail} is not answering.`,
    reachable: `This computer can reach ${host}.`,
  }[diagnosis.cause];
  return `${name} can't reach ${provider}. ${finding} ${next}`;
}

const recentDiagnoses = new Map<Backend, { at: number; result: Promise<ConnectionDiagnosis> }>();

/** One diagnosis shared by every session that fails in the same few seconds. */
function sharedDiagnosis(backend: Backend): Promise<ConnectionDiagnosis> {
  const recent = recentDiagnoses.get(backend);
  if (recent && Date.now() - recent.at < DIAGNOSIS_CACHE_MS) return recent.result;
  const result = diagnoseBackendConnection(backend);
  recentDiagnoses.set(backend, { at: Date.now(), result });
  return result;
}

/**
 * Turns the burst of errors one lost connection produces into a single card
 * that names the cause. A session owns one. Callers hand it each connection
 * error and show their own error only when [report] resolves false.
 */
export class ConnectionFailureReporter {
  private shown = false;

  constructor(
    private readonly backend: Backend,
    private readonly emit: (message: string) => void,
    private readonly diagnose: (backend: Backend) => Promise<ConnectionDiagnosis> = sharedDiagnosis,
  ) {}

  /** A new turn starts clean, so a failure in it gets its own card. */
  reset(): void {
    this.shown = false;
  }

  /**
   * Resolves true when the cause card covers this error: it is showing
   * already, or this call showed it. Resolves false when the computer can
   * reach the provider, so the failure is something else and the caller's
   * own error should stand.
   */
  async report(options: { retrying?: boolean } = {}): Promise<boolean> {
    if (this.shown) return true;
    let diagnosis: ConnectionDiagnosis;
    try {
      diagnosis = await this.diagnose(this.backend);
    } catch (error) {
      console.warn(`[Connection] Diagnosis for ${this.backend} failed:`, error);
      return false;
    }
    if (diagnosis.cause === "reachable") return false;
    // Another report may have shown the card while this one was diagnosing.
    if (this.shown) return true;
    this.shown = true;
    console.warn(`[Connection] ${this.backend} cannot reach its provider: ${diagnosis.cause}${diagnosis.detail ? ` (${diagnosis.detail})` : ""}`);
    this.emit(connectionFailureMessage(this.backend, diagnosis, options));
    return true;
  }
}
