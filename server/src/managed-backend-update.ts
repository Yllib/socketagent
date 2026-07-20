export const MANAGED_BACKEND_PACKAGES = [
  { name: "@openai/codex", spec: "@openai/codex@latest" },
  { name: "@anthropic-ai/claude-code", spec: "@anthropic-ai/claude-code@latest" },
] as const;

export function parseNpmVersionOutput(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) throw new Error("npm returned an empty version");
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "string" && parsed.trim()) return parsed.trim();
    if (Array.isArray(parsed)) {
      const latest = [...parsed].reverse().find((value) => typeof value === "string" && value.trim());
      if (latest) return latest.trim();
    }
  } catch {
    if (/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(trimmed)) return trimmed;
  }
  throw new Error(`npm returned an invalid version: ${trimmed.slice(0, 120)}`);
}

export function managedBackendSpecsNeedingUpdate(
  installed: Record<string, string | undefined>,
  latest: Record<string, string>,
): string[] {
  return MANAGED_BACKEND_PACKAGES
    .filter(({ name }) => !installed[name] || installed[name] !== latest[name])
    .map(({ spec }) => spec);
}
