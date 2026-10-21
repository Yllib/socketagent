import { redactSecretsDeep } from "./secure-input-store";

/** A fence longer than any backtick run in `text`, so the block cannot close early. */
function fenced(text: string, language: string): string {
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), (run) => run[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${language}\n${text}\n${fence}`;
}

/**
 * Markdown for a tool approval card. The app renders it in the question card.
 * The first line says what the tool will do: the agent's own description when
 * it gave one. Then the reason the backend is asking, then the command as a
 * code block, or the rest of the input as JSON for other tools.
 */
export function toolApprovalMarkdown(toolName: string, input: Record<string, unknown>, reason?: string): string {
  const { description, command, cwd, reason: inputReason, ...rest } = redactSecretsDeep(input);
  const summary = typeof description === "string" && description.trim() ? description.trim() : null;
  const lines = [summary ? `**${toolName}: ${summary}**` : `**Allow ${toolName}?**`];
  const why = reason?.trim() || (typeof inputReason === "string" ? inputReason.trim() : "");
  if (why) lines.push(why);
  if (typeof cwd === "string" && cwd) lines.push(`In \`${cwd}\``);
  if (typeof command === "string" && command.trim()) {
    lines.push(fenced(command, "bash"));
  } else {
    const shown = { ...(command === undefined ? {} : { command }), ...rest };
    if (Object.keys(shown).length > 0) lines.push(fenced(JSON.stringify(shown, null, 2), "json"));
  }
  return lines.join("\n\n");
}
