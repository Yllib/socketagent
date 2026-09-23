import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { socketAgentDataPath } from "./socket-agent-paths";

export const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;
const validId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function imageExtension(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpg";
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"))) return "gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  throw new Error("Use a PNG, JPEG, GIF, or WebP image.");
}

/** Persistent attachments, not a cache. No TTL or automatic session cleanup:
 * branches and archived transcripts can still reference these snapshot IDs.
 */
export class InlineImageStore {
  constructor(private readonly root = socketAgentDataPath("inline-images")) {}

  async prepare(source: string, sessionId: string): Promise<{ id: string; uri: string; created: boolean }> {
    // Reusing a previously prepared image must never recapture its old source.
    if (source.startsWith("socketagent://image?")) {
      const stored = this.resolve(source);
      const id = new URL(source).searchParams.get("id")!;
      if (!fs.existsSync(stored)) throw new Error("This image snapshot has been cleaned up. Prepare the source again.");
      return { id, uri: source, created: false };
    }
    let bytes: Buffer;
    if (/^https?:\/\//i.test(source)) {
      const response = await fetch(source, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok || !response.body) throw new Error(`Image download failed: HTTP ${response.status}`);
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let length = 0;
      try {
        if (Number(response.headers.get("content-length")) > MAX_INLINE_IMAGE_BYTES) throw new Error("Image exceeds 20 MB.");
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.length;
          if (length > MAX_INLINE_IMAGE_BYTES) throw new Error("Image exceeds 20 MB.");
          chunks.push(Buffer.from(chunk.value));
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      bytes = Buffer.concat(chunks, length);
    } else {
      if (!path.isAbsolute(source)) throw new Error("Use an absolute computer path or HTTP(S) URL.");
      const file = fs.openSync(source, "r");
      try {
        const stat = fs.fstatSync(file);
        if (!stat.isFile() || stat.size > MAX_INLINE_IMAGE_BYTES) throw new Error("Use an image file up to 20 MB.");
        // A bounded read also handles a file growing while it is captured.
        const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_INLINE_IMAGE_BYTES + 1));
        let length = 0;
        while (length < buffer.length) {
          const bytesRead = fs.readSync(file, buffer, length, buffer.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        const after = fs.fstatSync(file);
        if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("The image changed while being saved. Try again.");
        bytes = buffer.subarray(0, length);
      } finally {
        fs.closeSync(file);
      }
    }
    if (!bytes.length || bytes.length > MAX_INLINE_IMAGE_BYTES) throw new Error("Use an image up to 20 MB.");
    const extension = imageExtension(bytes);
    const id = randomUUID();
    const directory = path.join(this.root, id);
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await fs.promises.writeFile(path.join(directory, "image"), bytes, { flag: "wx", mode: 0o600 });
      // Avoid retaining signed URL query strings or source credentials.
      await fs.promises.writeFile(path.join(directory, "metadata.json"), JSON.stringify({
        id, sessionId, createdAt: new Date().toISOString(), bytes: bytes.length, extension,
      }), { flag: "wx", mode: 0o600 });
      return { id, created: true, uri: `socketagent://image?id=${id}&name=image.${extension}` };
    } catch (error) {
      this.remove(id);
      throw error;
    }
  }

  resolve(uri: string): string {
    const parsed = new URL(uri);
    const id = parsed.searchParams.get("id") || "";
    if (parsed.protocol !== "socketagent:" || parsed.host !== "image" || !validId.test(id)) {
      throw new Error("Invalid image snapshot ID. Only saved image IDs can be downloaded.");
    }
    return path.join(this.root, id, "image");
  }

  /** Explicit cleanup only. Missing snapshots never fall back to the source. */
  remove(id: string): void {
    if (!validId.test(id)) throw new Error("Invalid image snapshot ID.");
    fs.rmSync(path.join(this.root, id), { recursive: true, force: true });
  }
}

export const inlineImageStore = new InlineImageStore();
