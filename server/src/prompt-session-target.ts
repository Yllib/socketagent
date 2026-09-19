/**
 * A connection handler keeps one "active session" pointer, and several things
 * move it: opening a session, a headless continuation reattaching to the
 * client, a live session being recovered from the pool. A prompt, though,
 * names the session it belongs to, and that name is the user's intent.
 *
 * Without this check the prompt handler runs the turn against whatever the
 * pointer happens to hold, and still acknowledges it with the session id the
 * app asked for, so neither side can tell the message went to the wrong
 * conversation.
 */
export function promptNeedsSessionRebind(
  requestedSessionId: string | undefined,
  boundSessionId: string | undefined,
): boolean {
  const requested = (requestedSessionId || "").trim();
  // No named target: the prompt is for whatever this connection has open.
  if (!requested) return false;
  const bound = (boundSessionId || "").trim();
  // Nothing bound yet, or a new session the backend has not named: the caller
  // builds the session the prompt asked for anyway.
  if (!bound) return false;
  return bound !== requested;
}
