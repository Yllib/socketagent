import { randomUUID } from "crypto";
import { inlineImageStore, InlineImageStore } from "./inline-image-store";

interface Replacement { start: number; end: number; value: Promise<string> }
export function hasInlineImages(content: string): boolean {
  return content.includes("![") || content.includes("socketagent-compare");
}

/** Snapshot only displayed Markdown images, never examples inside code. */
export async function snapshotInlineImages(
  content: string,
  sessionId: string,
  store: InlineImageStore = inlineImageStore,
): Promise<string> {
  const saved = new Map<string, Promise<string>>();
  const save = (source: string): Promise<string> => {
    if (source.startsWith("socketagent://image?") && new URL(source).searchParams.has("id")) return Promise.resolve(source);
    const existing = saved.get(source);
    if (existing) return existing;
    const pending = (async () => {
      try {
        let input = source;
        if (source.startsWith("socketagent://image?")) input = new URL(source).searchParams.get("path") || "";
        if (source.startsWith("file://")) input = require("url").fileURLToPath(source);
        return (await store.prepare(input, sessionId)).uri;
      } catch {
        // A failed capture stays missing. Never reread a changing source later.
        return `socketagent://image?id=${randomUUID()}&name=unavailable.png`;
      }
    })();
    saved.set(source, pending);
    return pending;
  };
  const replacements: Replacement[] = [];
  // Keep offsets intact while masking code fences and inline code.
  let masked = content;
  const fences = /^[ \t]{0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n/gm;
  let fence: RegExpExecArray | null;
  while ((fence = fences.exec(content))) {
    const closing = new RegExp(`^[ \\t]{0,3}${fence[1][0]}{${fence[1].length},}[ \\t]*\\r?$`, "gm");
    closing.lastIndex = fences.lastIndex;
    const endFence = closing.exec(content);
    const end = endFence ? endFence.index + endFence[0].length : content.length;
    const bodyStart = fences.lastIndex;
    const bodyEnd = endFence?.index ?? content.length;
    if (fence[2].trim() === "socketagent-compare") {
      try {
        const spec = JSON.parse(content.slice(bodyStart, bodyEnd));
        const items = Array.isArray(spec) ? spec : spec.images;
        if (Array.isArray(items) && items.length >= 1 && items.length <= 12 && items.every((item) => typeof (typeof item === "string" ? item : item?.src) === "string")) {
          const value = Promise.all(items.map(async (item: any) => typeof item === "string" ? save(item) : { ...item, src: await save(item.src) }))
            .then((images) => JSON.stringify(Array.isArray(spec) ? images : { ...spec, images }) + "\n");
          replacements.push({ start: bodyStart, end: bodyEnd, value });
        }
      } catch { /* Incomplete streamed JSON is left alone until completion. */ }
    }
    masked = masked.slice(0, fence.index) + " ".repeat(end - fence.index) + masked.slice(end);
    fences.lastIndex = end;
  }
  masked = masked.replace(/(`+)([\s\S]*?)\1/g, (match) => " ".repeat(match.length));
  // Markdown destinations may be angle-bracketed (spaces) or contain balanced
  // parentheses. Scan their delimiters rather than truncating filenames at ')'.
  const starts = /!\[(?:\\.|[^\]\\])*\]\(\s*/g;
  let match: RegExpExecArray | null;
  while ((match = starts.exec(masked))) {
    if (match.index > 0 && masked[match.index - 1] === "\\") continue;
    let start = starts.lastIndex;
    let end = start;
    if (masked[start] === "<") {
      start++;
      end = masked.indexOf(">", start);
      if (end < 0) continue;
    } else {
      let depth = 0;
      while (end < masked.length) {
        const char = masked[end];
        if (char === "\\" && /[()\\]/.test(masked[end + 1] || "")) { end += 2; continue; }
        if (char === "(") depth++;
        if (char === ")") { if (!depth) break; depth--; }
        if (/\s/.test(char)) break;
        end++;
      }
      if (depth || end >= masked.length) continue;
    }
    const suffix = masked.slice(end + (masked[end] === ">" ? 1 : 0));
    if (!/^\s*(?:"[^"\n]*"|'[^'\n]*')?\s*\)/.test(suffix)) continue;
    let source = content.slice(start, end).replace(/\\([()\\])/g, "$1");
    if (source.startsWith("/") || /^[A-Za-z]:[\\/]/.test(source)) {
      try { source = decodeURI(source); } catch { /* Literal filename. */ }
    }
    if (source) replacements.push({ start, end, value: save(source) });
    starts.lastIndex = end + 1;
  }
  // Launch all captures immediately; await their completion before publishing.
  const ready = await Promise.all(replacements.map(async (replacement) => ({ ...replacement, value: await replacement.value })));
  let result = content;
  for (const replacement of ready.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, replacement.start) + replacement.value + result.slice(replacement.end);
  }
  return result;
}
