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

/** Text that only ever comes from invoking a command, never from a person. */
function isCommandOnlyText(text: string): boolean {
  return isLocalCommandArtifact(text) || isBareSlashCommand(text);
}

/**
 * True when everything known about a session is a local command.
 *
 * Two shapes reach the list. The transcript's own `<command-*>` block arrives
 * as `firstPrompt`, and alongside it the SDK derives a title and summary that
 * read as the bare command name, `/usage`. An earlier cut required every piece
 * of evidence to be a `<command-*>` block, so the derived `/usage` title made
 * the row look like real content and it stayed listed.
 *
 * The rule is therefore: at least one piece of evidence has to be an actual
 * command block, and nothing may look like something a person wrote. A session
 * that opened with `/compact` and then held a real conversation carries no
 * command block in its index entry and keeps its place, as does one whose
 * summary describes real work.
 */
/**
 * The same test against an assembled session row, whatever produced it.
 *
 * The converters below run only on rows discovered through the SDK index. A
 * session SocketAgent tracked is listed straight out of the store, so a
 * `/usage` run from the app reached the list without ever meeting them. This
 * is the check the display lists apply, after every source has been merged.
 */
/**
 * A preview with the command artifact stripped out.
 *
 * A real session can still end on a command, leaving rows titled with real
 * work and previewed with `<local-command-stdout>Bye!</local-command-stdout>`.
 * The row stays; the line that says nothing goes. The app hides the preview
 * line when it is empty.
 */
export function listedPreview(preview: string | undefined): string {
  const text = (preview ?? "").trim();
  return isLocalCommandArtifact(text) ? "" : (preview ?? "");
}

export function isLocalCommandOnlyEntry(session: {
  title?: string;
  messagePreview?: string;
}): boolean {
  return isLocalCommandOnlySession({}, session);
}

export function isLocalCommandOnlySession(
  info: {
    firstPrompt?: string;
    summary?: string;
    customTitle?: string;
  },
  tracked?: {
    title?: string;
    messagePreview?: string;
  },
): boolean {
  const evidence = [
    info.summary,
    info.firstPrompt,
    info.customTitle,
    // The store's placeholder says nothing either way.
    tracked?.title === "Untitled" ? undefined : tracked?.title,
    tracked?.messagePreview,
  ]
    .map((value) => (value ?? "").trim())
    .filter(Boolean);
  return evidence.some(isLocalCommandArtifact) && evidence.every(isCommandOnlyText);
}
