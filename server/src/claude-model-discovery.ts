import { query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

type DiscoveryOptions = Pick<Options,
  "cwd" | "pathToClaudeCodeExecutable" | "executable" | "settingSources" | "env"
>;

/** Read initialization metadata without sending a prompt or saving a conversation. */
export async function readClaudeSupportedModels(options: DiscoveryOptions) {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 15_000);
  let closeInput!: () => void;
  const inputClosed = new Promise<void>((resolve) => { closeInput = resolve; });
  // Keep stdin open for the initialization response, but never yield a user message.
  async function* emptyInput(): AsyncGenerator<SDKUserMessage> {
    await inputClosed;
  }
  let probe: ReturnType<typeof query> | undefined;
  try {
    probe = query({
      prompt: emptyInput(),
      options: { ...options, tools: [], persistSession: false, abortController },
    });
    const models = await probe.supportedModels();
    return models.map((model) => ({ ...model }));
  } finally {
    clearTimeout(timeout);
    // Close the transport before ending input, so EOF cannot start any work.
    try { probe?.close(); } finally { closeInput(); }
  }
}
