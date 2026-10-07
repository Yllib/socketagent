/**
 * One sentence on why Codex could not start an MCP server. Codex reports its
 * Rust transport stack, which reads as noise in a chat, so this keeps only
 * the server, its address, and the kind of failure.
 */
export function describeMcpStartupFailure(name: string, raw: string): string {
  const url = /https?:\/\/[^\s)"'<>]+/.exec(raw)?.[0];
  const target = url ? ` at ${url}` : "";
  return `Codex couldn't start the ${name} MCP server${target}: ${failureReason(raw)}. `
    + "This session continues without its tools.";
}

function failureReason(raw: string): string {
  if (/certificate|self[- ]signed|\btls\b|\bssl\b/i.test(raw)) return "its security certificate wasn't trusted";
  if (/timed? ?out|deadline/i.test(raw)) return "the connection timed out";
  if (/failed to lookup|dns error|name or service not known|could not resolve/i.test(raw)) {
    return "its address couldn't be looked up";
  }
  if (/connection refused/i.test(raw)) return "the connection was refused";
  if (/error sending request|connect error|http request failed/i.test(raw)) return "the request couldn't reach it";
  if (/no such file|enoent|program not found|command not found/i.test(raw)) return "its command couldn't be found";
  return readableClause(raw);
}

/** The first clause of [raw] with Rust type paths and generics removed. */
function readableClause(raw: string): string {
  const cleaned = raw
    .replace(/\s*Transport\s*\[[^\]]*\]/g, "")
    .replace(/\b\w+(?:::\w+)+(?:<[^\s]*>)?/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const clause = cleaned.split(/(?<=[.;])\s/)[0] || "it failed to start";
  return clause.length > 160 ? `${clause.slice(0, 157)}...` : clause.replace(/[.;]$/, "");
}
