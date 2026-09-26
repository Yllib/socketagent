import * as os from "node:os";
import { CodexAppServerClient, type CodexAppServerOptions } from "./codex-app-server-client";

interface LoginResult {
  type: string;
  loginId?: string;
  authUrl?: string;
}
interface LoginCompleted {
  loginId?: string;
  success?: boolean;
}

interface BrowserAuthOptions extends CodexAppServerOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onReady: (authUrl: string, acceptCallback: (callbackUrl: string) => Promise<void>) => void;
}

/** Codex owns PKCE, token exchange, and credential storage. SocketAgent only
 * returns the sign-in link and forwards a matching callback from the user's device. */
export async function runCodexBrowserAuth(options: BrowserAuthOptions): Promise<void> {
  if (options.signal?.aborted) throw new Error("Operation cancelled");
  const client = new CodexAppServerClient({ ...options, cwd: options.cwd || os.homedir() });
  let loginId: string | undefined;
  let completed: LoginCompleted | undefined;
  let succeeded = false;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // Cancellation/exit can arrive while login initialization awaits.
  void completion.catch(() => {});
  const checkCompletion = () => {
    if (!loginId || completed?.loginId !== loginId) return;
    if (completed.success) resolveCompletion();
    else rejectCompletion(new Error("Browser sign-in was not completed. Try again or use a device code."));
  };
  client.on("notification", ({ method, params }: { method: string; params: LoginCompleted }) => {
    if (method !== "account/login/completed") return;
    completed = params;
    checkCompletion();
  });
  client.on("error", () => rejectCompletion(new Error("Codex sign-in could not start.")));
  client.on("exit", () => rejectCompletion(new Error("Codex exited before sign-in finished.")));
  const abort = () => rejectCompletion(new Error("Operation cancelled"));
  options.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => rejectCompletion(new Error("Sign-in timed out. Try again or use a device code.")), options.timeoutMs ?? 15 * 60_000);
  try {
    await client.initialize({ clientInfo: { name: "socketagent_login", title: "SocketAgent", version: "1.0.0" } });
    if (options.signal?.aborted) throw new Error("Operation cancelled");
    const result = await client.request<LoginResult>("account/login/start", { type: "chatgpt" });
    loginId = result.loginId;
    if (result.type !== "chatgpt" || !loginId || !result.authUrl) {
      throw new Error("This Codex version did not return a browser sign-in. Use a device code or repair Codex.");
    }
    const url = new URL(result.authUrl);
    if (url.protocol !== "https:" || !["auth.openai.com", "auth0.openai.com", "chatgpt.com"].includes(url.hostname)) {
      throw new Error("Codex returned an unexpected sign-in address.");
    }
    if (options.signal?.aborted) throw new Error("Operation cancelled");
    const redirect = new URL(url.searchParams.get("redirect_uri") || "");
    const state = url.searchParams.get("state");
    if (redirect.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname)
      || redirect.pathname !== "/auth/callback" || redirect.username || redirect.password || !state) {
      throw new Error("Codex returned an unsupported sign-in callback. Use a device code.");
    }
    let forwarding: Promise<void> | undefined;
    options.onReady(result.authUrl, async (callbackUrl) => {
      let callback: URL;
      try { callback = new URL(callbackUrl); } catch { throw new Error("Invalid sign-in response."); }
      if (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname
        || callback.username || callback.password || callback.hash
        || callback.searchParams.getAll("state").length !== 1
        || callback.searchParams.get("state") !== state
        || !(callback.searchParams.get("code") || callback.searchParams.get("error"))) {
        throw new Error("This sign-in response does not match the pending login.");
      }
      if (options.signal?.aborted || !client.isRunning) throw new Error("This sign-in has ended.");
      if (!forwarding) {
        // The destination comes exclusively from Codex's validated redirect URI.
        const target = new URL(redirect);
        for (const key of ["state", "code", "error"]) {
          const value = callback.searchParams.get(key);
          if (value) target.searchParams.set(key, value);
        }
        forwarding = (async () => {
          try {
            const response = await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
            await response.body?.cancel();
            if (response.status >= 400) throw new Error("Callback rejected");
            const location = response.headers.get("location");
            if (response.status >= 300 && response.status < 400 && location) {
              const next = new URL(location, redirect);
              if (next.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(next.hostname)
                && next.port === redirect.port && next.pathname === "/success") {
                // Codex completes older login flows only when /success is visited.
                // Use the known loopback origin, never arbitrary redirect targets.
                const finished = await fetch(new URL("/success", redirect), {
                  redirect: "manual", signal: AbortSignal.timeout(5000),
                });
                await finished.body?.cancel();
                if (finished.status >= 400) throw new Error("Sign-in did not finish");
              }
            }
          } catch {
            if (!succeeded) throw new Error("Could not finish sign-in. Return to SocketAgent and try again.");
          }
        })();
      }
      try { await forwarding; await completion; } catch (error) { forwarding = undefined; throw error; }
    });
    checkCompletion();
    await completion;
    succeeded = true;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
    if (loginId && !succeeded && client.isRunning) {
      await client.request("account/login/cancel", { loginId }, 5000).catch(() => {});
    }
    await client.stop();
  }
}
