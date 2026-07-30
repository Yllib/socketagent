export interface RunningDelegatedAgentMessageTarget {
  injectMessage(
    text: string,
    priority: "now" | "next" | "later",
    messageId?: string,
  ): Promise<void>;
}

export async function routeRunningDelegatedAgentMessage(options: {
  target?: RunningDelegatedAgentMessageTarget;
  isRunning: boolean;
  prompt: string;
  messageId: string;
}): Promise<"injected" | "start_turn"> {
  if (!options.target || !options.isRunning) return "start_turn";
  await options.target.injectMessage(
    options.prompt,
    "next",
    options.messageId,
  );
  return "injected";
}
