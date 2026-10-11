const CONTEXT_BLOCK = /^\s*<(socketagent_[a-z_]+)\b[^>]*>[\s\S]*?<\/\1>\s*/;

/**
 * Title for a session started by `prompt`: its first line after any leading
 * SocketAgent context blocks, such as the quiet scheduled-task instructions,
 * which are written for the agent rather than the user.
 */
export function promptTitle(prompt: string, maxLength = 50): string {
  let text = prompt;
  for (let block = CONTEXT_BLOCK.exec(text); block; block = CONTEXT_BLOCK.exec(text)) {
    text = text.slice(block[0].length);
  }
  const line = text.split(/\r?\n/, 1)[0].trim();
  return line.length > maxLength ? `${line.slice(0, maxLength)}...` : line;
}
