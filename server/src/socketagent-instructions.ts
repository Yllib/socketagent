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

export const HTML_PLAN_TOOL_DESCRIPTION =
  "Create or revise a durable, full-screen HTML implementation or design plan for a large task. Use only when a rich document materially improves review, such as multi-component architecture, phased execution, tradeoffs, diagrams, embedded images, or UI/page mockups. Do not use for checklists, TODO lists, routine status updates, brief execution steps, or small tasks. Use your native plan/task tool or TaskBatch for working plans and progress tracking, or normal chat for concise user-facing content, whichever is appropriate. Reuse plan_id from the prior result when revising a plan.";

export const WORK_REVIEW_TOOL_DESCRIPTION =
  "Create and manage a durable human review handoff: describe what you did, provide one or more links or other targets where the user can inspect it, and ask for a decision. Use it for any reviewable work such as a live production environment, sandbox/dev server, file, image, diff, session, or custom target. Primary HTTP(S) targets are embedded inside the app beneath the collapsible review panel so the user can inspect the live site and take notes together; do not request external display for a primary web target. The user reviews every item privately and you receive one consolidated result only when they choose Finish Review. Approval meaning is supplied by the workflow and may explicitly authorize deployment or another follow-up action.";

export function buildSocketAgentIntegrationInstructions(options: {
  mcpServerName: string;
  toolNames: string[];
  secureInventory: string;
  discoverMissingTools?: boolean;
  monitorToolReference?: string;
}): string {
  const monitorToolReference = options.monitorToolReference || "Monitor";
  const monitorRouting = monitorToolReference === "Monitor"
    ? "- Background command monitoring -> Monitor."
    : `- Background command monitoring -> ${monitorToolReference}. Use this SocketAgent MCP tool, not Claude's built-in Monitor; the built-in monitor ends with the SDK session and is not durable across SocketAgent turns or server restarts.`;
  const routingRules = [
    "Routing rules:",
    ...(options.discoverMissingTools
      ? [`- If a SocketAgent tool is not visible, discover tools for ${options.mcpServerName} before claiming it is unavailable.`]
      : []),
    "- HtmlPlan is reserved for detailed implementation or design plans for larger tasks where a rich full-screen document materially improves review, such as multi-component architecture, phased execution, important tradeoffs, diagrams, embedded images, or UI/page mockups. Do not use HtmlPlan for checklists, TODO lists, routine status updates, brief execution steps, or small tasks. Use your native plan/task tool or TaskBatch for working plans and progress tracking, or normal chat for concise user-facing content, whichever is appropriate. Use semantic, self-contained HTML with inline CSS only; use inline SVG/CSS or data-image assets when visuals help, never scripts or remote resources. Revisions must reuse plan_id.",
    "- Work Review handoff -> WorkReview. Use it to say what you did and provide the target(s) where the user can inspect the result, whether production, development, sandbox, file, image, diff, session, or another kind of link. Primary HTTP(S) targets are embedded beneath the app's collapsible review panel; do not request external display for a primary web target. The user reviews items and writes notes privately; no draft decisions or notes are exposed to you. You receive exactly one consolidated result only after the user chooses Finish Review. A review's approval meaning is workflow-defined and may explicitly authorize deployment or another action. Use new_round with the same review_id after addressing requested changes.",
    "- User asks to send/share/transfer a file to their phone -> SendFile with an absolute file_path.",
    "- Credential, password, key, token, cookie, or other secret needed -> RequestSecureInput. Never request secrets in normal chat. The result contains metadata and a local secret-file path, not the value.",
    "- Important immediate phone notification -> NotifyUser.",
    "- Device reminder -> ScheduleReminder.",
    "- Deferred or recurring agent work -> ScheduleTask.",
    "- Two or more working-task mutations -> TaskBatch. Use one replace, upsert, or delete call instead of looping single-task tools; use clear_completed to remove finished SocketAgent tasks in bulk and list to inspect the managed set. TaskBatch preserves native Claude tasks.",
    ...(options.toolNames.includes("ReportSubagentAssignment")
      ? ["- If you are a spawned Codex subagent, call ReportSubagentAssignment exactly once before any commentary or other tool use. Pass agent_path exactly as shown in your NEW_TASK envelope and copy the complete readable NEW_TASK payload into prompt. This is an internal UI metadata handshake. Never call it from the root agent."]
      : []),
    "- Independent delegated work that should run in a full Claude or Codex session -> AgentSession. Use action=start, retain the returned session_id/delegation_id, use action=message for follow-ups or added context even while the child is running, and use status/list/stop when needed. Messages sent to a running child are injected at its next safe boundary. The child runs independently and reports its completed turn back automatically.",
    monitorRouting,
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
