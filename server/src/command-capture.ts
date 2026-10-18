// Agents often pipe a command through a filter (`npm test | tail -20`) so the
// agent reads less. These rewriters add a tee in front of the first filter of
// each pipeline, so the full stream also lands in a capture file the user can
// read. What the agent sees is unchanged. Each scanner returns null when the
// command has no filter to capture or uses syntax it does not fully follow.

const SHELL_FILTERS = new Set([
  "head", "tail", "grep", "egrep", "fgrep", "rg", "ag", "sed", "awk", "gawk",
  "cut", "wc", "uniq", "sort", "jq", "yq", "tr", "column",
]);

const POWERSHELL_FILTERS = new Set([
  "select-object", "select", "select-string", "sls", "where-object", "where", "?",
  "measure-object", "measure", "sort-object", "sort", "group-object", "findstr", "findstr.exe",
]);

type Context = "dq" | "sub" | "param";

const SAFE_SHELL_WORD = /^[A-Za-z0-9_./:@%+,=-]+$/;

function shellQuote(value: string): string {
  return SAFE_SHELL_WORD.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The text inserted after a `|`. `|| true` keeps a tee killed by SIGPIPE
 * (`... | head -5` closing early) from changing the status under pipefail,
 * while the signal still stops the producer as before.
 */
export function shellTeeStage(capturePath: string): string {
  return ` { tee -a ${shellQuote(capturePath)} || true; } |`;
}

/** Bare when it can be, so the command Codex reports needs no quote unescaping to strip. */
export function powerShellTeeStage(capturePath: string): string {
  const file = /^[A-Za-z0-9_.:\\/-]+$/.test(capturePath) ? capturePath : `'${capturePath.replace(/'/g, "''")}'`;
  return ` Tee-Object -FilePath ${file} -Append |`;
}

/** Name of the command that starts at `start`, skipping `VAR=value` prefixes. */
function shellStageCommand(command: string, start: number): string | null {
  const rest = command.slice(start).replace(/^[ \t]+/, "");
  const match = /^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s'"`$;&|()]*[ \t]+)*([A-Za-z0-9_./-]+)(?=$|[\s;&|)])/.exec(rest);
  if (!match) return null;
  const word = match[1];
  return word.slice(word.lastIndexOf("/") + 1);
}

/** Adds a tee before the first filter of each top-level bash or zsh pipeline. */
export function insertShellTee(command: string, capturePath: string): string | null {
  if (/(^|[\s;&|(])(case|select)\s/.test(command)) return null;
  const stage = shellTeeStage(capturePath);
  const insertAt: number[] = [];
  const stack: Context[] = [];
  // Pipeline state at the top level, saved across plain `( ... )` subshells.
  let stageIndex = 0;
  let captured = false;
  const groups: Array<{ stageIndex: number; captured: boolean }> = [];
  const resetPipeline = () => { stageIndex = 0; captured = false; };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];
    const top = stack[stack.length - 1];

    if (ch === "`") return null;
    if (ch === "\\") { i++; continue; }

    if (top === "dq") {
      if (ch === '"') stack.pop();
      else if (ch === "$" && next === "(") { stack.push("sub"); i++; }
      else if (ch === "$" && next === "{") { stack.push("param"); i++; }
      continue;
    }

    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return null;
      i = end;
      continue;
    }
    if (ch === '"') { stack.push("dq"); continue; }
    if ((ch === "$" || ch === "<" || ch === ">") && next === "(") { stack.push("sub"); i++; continue; }
    if (ch === "$" && next === "{") { stack.push("param"); i++; continue; }
    if (ch === "<" && next === "<") {
      // Heredocs carry raw text the scanner cannot follow; `<<<` is a plain word.
      if (command[i + 2] !== "<") return null;
      i += 2;
      continue;
    }
    if (ch === "#" && (i === 0 || /[\s;&|()]/.test(command[i - 1]))) {
      const end = command.indexOf("\n", i);
      if (end < 0) break;
      i = end - 1;
      continue;
    }

    if (top === "param") {
      if (ch === "}") stack.pop();
      continue;
    }
    if (top === "sub") {
      if (ch === "(") stack.push("sub");
      else if (ch === ")") stack.pop();
      continue;
    }

    // Top level.
    if (ch === "(") {
      groups.push({ stageIndex, captured });
      resetPipeline();
      continue;
    }
    if (ch === ")") {
      const outer = groups.pop();
      if (!outer) return null;
      stageIndex = outer.stageIndex;
      captured = outer.captured || captured;
      continue;
    }
    if (ch === "|") {
      if (next === "|") { i++; resetPipeline(); continue; }
      if (next === "&") return null;
      if (command[i - 1] === ">") continue;
      stageIndex++;
      const name = shellStageCommand(command, i + 1);
      if (!captured && name && SHELL_FILTERS.has(name)) {
        insertAt.push(i + 1);
        captured = true;
      }
      continue;
    }
    if (ch === "&") {
      const prev = command[i - 1];
      if (prev === ">" || prev === "<" || next === ">") continue;
      if (next === "&") i++;
      resetPipeline();
      continue;
    }
    if (ch === ";" || ch === "\n") resetPipeline();
  }

  if (stack.length > 0 || groups.length > 0 || insertAt.length === 0) return null;
  let rewritten = command;
  for (const at of insertAt.reverse()) {
    rewritten = rewritten.slice(0, at) + stage + rewritten.slice(at);
  }
  return rewritten;
}

/** Adds a Tee-Object before the first filter of each top-level PowerShell pipeline. */
export function insertPowerShellTee(command: string, capturePath: string): string | null {
  const stage = powerShellTeeStage(capturePath);
  const insertAt: number[] = [];
  let depth = 0;
  let captured = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];
    if (ch === "`") { i++; continue; }
    if (ch === "@" && (next === "'" || next === '"')) return null;
    if (ch === "<" && next === "#") return null;
    if (ch === "'") {
      let end = i + 1;
      for (;;) {
        end = command.indexOf("'", end);
        if (end < 0) return null;
        if (command[end + 1] !== "'") break;
        end += 2;
      }
      i = end;
      continue;
    }
    if (ch === '"') {
      // Subexpressions inside double quotes would need a nested scan.
      let end = i + 1;
      for (; end < command.length; end++) {
        if (command[end] === "`") { end++; continue; }
        if (command[end] === "$" && command[end + 1] === "(") return null;
        if (command[end] === '"') break;
      }
      if (end >= command.length) return null;
      i = end;
      continue;
    }
    if (ch === "#" && (i === 0 || /[\s;|]/.test(command[i - 1]))) {
      const end = command.indexOf("\n", i);
      if (end < 0) break;
      i = end - 1;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") { depth++; continue; }
    if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth < 0) return null;
      continue;
    }
    if (depth > 0) continue;
    if (ch === "|") {
      if (next === "|") { i++; captured = false; continue; }
      const word = /^\s*([A-Za-z0-9_.?-]+)(?=$|[\s;|)])/.exec(command.slice(i + 1));
      const name = word?.[1].toLowerCase();
      if (!captured && name && POWERSHELL_FILTERS.has(name)) {
        insertAt.push(i + 1);
        captured = true;
      }
      continue;
    }
    if (ch === ";" || ch === "\n" || (ch === "&" && next === "&")) captured = false;
  }

  if (depth !== 0 || insertAt.length === 0) return null;
  let rewritten = command;
  for (const at of insertAt.reverse()) {
    rewritten = rewritten.slice(0, at) + stage + rewritten.slice(at);
  }
  return rewritten;
}

const SHELL_STAGE_PATTERN = / \{ tee -a (?:'[^']*'|[^\s']+) \|\| true; \} \|/g;
const POWERSHELL_STAGE_PATTERN = / Tee-Object -FilePath (?:'(?:[^']|'')*'|[^\s']+) -Append \|/g;

/** Removes inserted capture stages, for showing the command the agent wrote. */
export function stripCaptureStages(command: string): string {
  return command.replace(SHELL_STAGE_PATTERN, "").replace(POWERSHELL_STAGE_PATTERN, "");
}
