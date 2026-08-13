import type { ServerMessage } from "./protocol";
import type { SessionContext, SocketAgentPlugin } from "./plugin-api";

export interface PrivateIntegrationAuthStartOptions {
  plugins: SocketAgentPlugin[];
  integration: string;
  requestId: string;
  cwd: string;
  send: (message: Record<string, unknown>) => void;
}

/** Starts a protected phone sign-in without attaching it to an agent turn. */
export function startPrivateIntegrationAuthorization(
  options: PrivateIntegrationAuthStartOptions,
): void {
  const { plugins, integration, requestId, cwd, send } = options;
  const plugin = plugins.find((candidate) => candidate.name === integration);
  if (!requestId || !plugin?.requestAuthorization) {
    send({
      type: "private_integration_auth_result",
      requestId,
      integration,
      started: false,
      error: plugin
        ? "This integration does not support phone sign-in."
        : `Private integration is not available: ${integration}`,
    });
    return;
  }

  let challengeSent = false;
  const context: SessionContext = {
    sessionId: "",
    cwd,
    send: (message: ServerMessage | Record<string, unknown>) => {
      if (message.type === "outlook_auth" || message.type === "ibs_auth") {
        challengeSent = true;
      }
      send({ ...message, directRequestId: requestId });
    },
    // Settings-initiated sign-in is intentionally not attached to a
    // transcript. The plugin retains and validates its private request.
    appendHistory: () => {},
    pendingQuestions: new Map(),
    questionCounter: { next: () => "" },
  };

  const reportFailure = (error: unknown) => {
    send({
      type: "private_integration_auth_result",
      requestId,
      integration,
      started: false,
      error: error instanceof Error
        ? error.message
        : "Private integration sign-in failed.",
    });
  };

  try {
    void Promise.resolve(plugin.requestAuthorization(context))
      .then(() => {
        if (!challengeSent) {
          reportFailure(new Error(`Could not start ${integration} sign-in.`));
        }
      })
      .catch(reportFailure);
  } catch (error) {
    reportFailure(error);
  }
}
