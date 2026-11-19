import { z } from "zod";
import { signBoardRequest, type BoardKeys } from "./project-board-crypto";

/** The relay forgot this board: it was rotated or turned off. Drop the grant. */
export class BoardGoneError extends Error {
  constructor() { super("This board no longer exists on the relay"); }
}

/** A PUT whose expectedVersion was not the record's version. */
export class BoardConflictError extends Error {
  constructor(readonly version: number) { super(`Record changed on the relay (now version ${version})`); }
}

/** The relay refused a write outright: too large, board full, or a malformed request (400). */
export class BoardRejectedError extends Error {}

/** The relay answered but cannot take the request now: rate limited (429) or storage trouble (503). */
export class BoardUnavailableError extends Error {}

const recordSchema = z.object({
  id: z.string(),
  version: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
  ciphertext: z.string(),
});
const listSchema = z.object({ seq: z.number().int().nonnegative(), records: z.array(recordSchema) });
const putSchema = z.object({ version: z.number().int().positive(), seq: z.number().int().positive() });
const errorSchema = z.object({
  error: z.string(),
  version: z.number().int().nonnegative().optional(),
  serverTime: z.number().optional(),
});

export type RelayBoardRecord = z.infer<typeof recordSchema>;
export type RelayBoardList = z.infer<typeof listSchema>;

export type BoardFetch = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<{ status: number; text(): Promise<string> }>;

const REQUEST_TIMEOUT_MS = 8_000;

/**
 * The relay's HTTP base for a RELAY_URL such as wss://relay.example. Null when
 * no relay is configured, which leaves boards unavailable on this computer.
 */
export function relayHttpBase(relayUrl: string | undefined): string | null {
  const value = relayUrl?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === "wss:") url.protocol = "https:";
    else if (url.protocol === "ws:") url.protocol = "http:";
    else if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Signed requests to one board's routes on the relay. */
export class ProjectBoardRelay {
  /** Relay clock minus ours, learned from a stale_time answer. */
  private clockOffset = 0;

  constructor(
    private readonly base: string,
    private readonly keys: BoardKeys,
    private readonly fetchImpl: BoardFetch = fetch,
  ) {}

  /** Records written after [since], and the board's latest seq. */
  async list(since: number): Promise<RelayBoardList> {
    return listSchema.parse(await this.request("GET", "/api/board/records", `?since=${since}`));
  }

  /** Writes one sealed record. Throws BoardConflictError on a version mismatch. */
  async put(id: string, expectedVersion: number, ciphertext: string): Promise<z.infer<typeof putSchema>> {
    const body = JSON.stringify({ expectedVersion, ciphertext });
    return putSchema.parse(await this.request("PUT", `/api/board/records/${id}`, "", body));
  }

  private async request(method: string, path: string, query: string, body = "", retried = false): Promise<unknown> {
    const bytes = new Uint8Array(Buffer.from(body, "utf8"));
    const headers = signBoardRequest(this.keys, method, path, Date.now() + this.clockOffset, bytes);
    if (body) headers["Content-Type"] = "application/json";
    const response = await this.fetchImpl(`${this.base}${path}${query}`, {
      method,
      headers,
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (response.status === 200) return parsed;
    const failure = errorSchema.safeParse(parsed);
    const error = failure.success ? failure.data : null;
    if (response.status === 401 && error?.error === "stale_time" && error.serverTime !== undefined && !retried) {
      this.clockOffset = error.serverTime - Date.now();
      return this.request(method, path, query, body, true);
    }
    if (response.status === 410) throw new BoardGoneError();
    if (response.status === 409 && error?.error === "conflict") throw new BoardConflictError(error.version ?? 0);
    const answer = `the relay answered ${response.status}${error ? ` (${error.error})` : ""}`;
    if (response.status === 413) throw new BoardRejectedError("The relay refused the record as too large");
    if (response.status === 409 && error?.error === "full") throw new BoardRejectedError("The board is full (5,000 records)");
    if (response.status === 400) throw new BoardRejectedError(`The relay refused the request: ${answer}`);
    if (response.status === 429 || response.status === 503) throw new BoardUnavailableError(answer);
    throw new Error(answer);
  }
}
