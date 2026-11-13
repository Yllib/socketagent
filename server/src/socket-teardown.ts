/** The part of a `ws` socket that `closeThenDestroy` uses. */
export interface ClosableSocket {
  close(code: number, reason: string): void;
  terminate(): void;
  once(event: "close", listener: () => void): unknown;
}

/** How long a peer gets to answer a close frame before its socket is destroyed. */
export const CLOSE_GRACE_MS = 2_000;

/**
 * Closes a direct socket from this side. The peer is sent the close frame
 * with [code] and [reason], and a peer that does not finish the closing
 * handshake within two seconds has its socket destroyed. `ws` alone would
 * wait 30 seconds and keep handing over the peer's frames all that time, so
 * the caller must also stop reading the socket in the same tick.
 */
export function closeThenDestroy(ws: ClosableSocket, code: number, reason: string): void {
  ws.close(code, reason);
  const timer = setTimeout(() => ws.terminate(), CLOSE_GRACE_MS);
  timer.unref?.();
  ws.once("close", () => clearTimeout(timer));
}
