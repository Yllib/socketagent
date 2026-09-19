/**
 * Tells a real conversation apart from Claude Code's record of a local command.
 *
 * Running a slash command such as `/usage` writes a transcript to
 * ~/.claude/projects containing only a caveat block and the command name. The
 * file is as real as any other, so a scan that looks for "a user message"
 * finds one and lists it as a session. The result was a session list full of
 * rows the user never started a conversation in.
 */

/**
 * True for a user message that is Claude Code's own record of a local command
 * rather than something said to the agent.
 */
export function isLocalCommandArtifact(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return /^<(?:local-command-caveat|command-name|command-message|command-args|local-command-std(?:out|err))\b/.test(
    trimmed,
  );
}

/** True for internal warmup traffic, which is never a real prompt. */
export function isWarmupMessage(text: string): boolean {
  return /^\s*Warmup\s*$/i.test(text);
}

/**
 * True when `text` cannot stand as a session's preview.
 *
 * Keep scanning when this is true: a session that opened with `/usage` and
 * then held a real conversation still has a real message further in, and must
 * still be listed.
 */
export function isUnusableSessionPreview(text: string): boolean {
  return !text.trim() || isWarmupMessage(text) || isLocalCommandArtifact(text);
}

/**
 * True for a preview that is nothing but a slash-command invocation.
 *
 * The prompt-history shortcut trusts recorded prompts so it can skip reading
 * the transcript. A bare command is exactly the case where that shortcut is
 * wrong, so it has to fall through and let the transcript decide.
 */
export function isBareSlashCommand(text: string): boolean {
  return /^\/[a-z0-9][\w:-]*$/i.test(text.trim());
}

/**
 * True when everything the SDK knows about a session is a local command.
 *
 * The SDK's own index carries the command block through as `firstPrompt`, so
 * the file scanner is not the only way these reach the list. Filtered only
 * when every piece of evidence is a command artifact and there is at least
 * one: a session with a real summary, a user-set title, or nothing at all
 * stays listed. Callers must never apply this to a tracked session, since the
 * store is the authority on those.
 */
export function isLocalCommandOnlySession(info: {
  firstPrompt?: string;
  summary?: string;
  customTitle?: string;
}): boolean {
  if (info.customTitle?.trim()) return false;
  const evidence = [info.summary, info.firstPrompt]
    .map((value) => (value ?? "").trim())
    .filter(Boolean);
  return evidence.length > 0 && evidence.every(isLocalCommandArtifact);
}
