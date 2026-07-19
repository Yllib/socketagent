export const SOCKETAGENT_FILE_LINK_INSTRUCTIONS = [
  "Phone file links:",
  "- Use when the user would benefit from tapping to browse, reveal, preview, or download a server file.",
  "- Use absolute server paths and URL-encode the path query.",
  "- Browse folder: [Open folder](socketagent://file/browse?path=%2Fabsolute%2Ffolder)",
  "- Reveal file: [Show file](socketagent://file/reveal?path=%2Fabsolute%2Ffile.txt)",
  "- Preview file: [View file](socketagent://file/view?path=%2Fabsolute%2Ffile.txt)",
  "- Download file: [Download file](socketagent://file/download?path=%2Fabsolute%2Ffile.zip)",
  "- These links are non-destructive references; emitting one does not transfer or modify anything.",
].join("\n");

export function buildSocketAgentIntegrationInstructions(options: {
  mcpServerName: string;
  toolNames: string[];
  secureInventory: string;
  discoverMissingTools?: boolean;
}): string {
  const routingRules = [
    "Routing rules:",
    ...(options.discoverMissingTools
      ? [`- If a SocketAgent tool is not visible, discover tools for ${options.mcpServerName} before claiming it is unavailable.`]
      : []),
    "- Substantive plan for the user -> HtmlPlan. Use semantic, self-contained HTML with inline CSS only; no scripts or remote resources. Revisions must reuse plan_id. Do not use for trivial one- or two-step answers.",
    "- User asks to send/share/transfer a file to their phone -> SendFile with an absolute file_path.",
    "- Credential, password, key, token, cookie, or other secret needed -> RequestSecureInput. Never request secrets in normal chat. The result contains metadata and a local secret-file path, not the value.",
    "- Important immediate phone notification -> NotifyUser.",
    "- Device reminder -> ScheduleReminder.",
    "- Deferred or recurring agent work -> ScheduleTask.",
    "- Background command monitoring -> Monitor.",
    "- Spoken output -> Speak only when TTS is enabled or explicitly requested.",
    "- Skill discovery/loading -> SearchSkills, then ReadSkill.",
  ].join("\n");

  return [
    "SocketAgent integration",
    `MCP server: ${options.mcpServerName}`,
    `Tools: ${options.toolNames.join(", ")}`,
    routingRules,
    options.secureInventory,
    SOCKETAGENT_FILE_LINK_INSTRUCTIONS,
  ].join("\n\n");
}
