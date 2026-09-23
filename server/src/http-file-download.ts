import * as fs from "fs";
import * as path from "path";
import type { IncomingMessage, ServerResponse } from "http";
import { fileTransferVersion } from "./file-transfer-wire";

/** Serve one opened revision with validators. If-Range prevents a client from
 * appending a newer file's suffix to a prefix saved before disconnection. */
export function serveDownloadFile(req: IncomingMessage, res: ServerResponse, filePath: string): void {
  try {
    serveOpenedFile(req, res, filePath);
  } catch (error) {
    if (res.headersSent) { res.destroy(); return; }
    const code = (error as NodeJS.ErrnoException).code;
    res.writeHead(code === "ENOENT" ? 404 : 500);
    res.end();
  }
}

function serveOpenedFile(req: IncomingMessage, res: ServerResponse, filePath: string): void {
  const fd = fs.openSync(filePath, "r");
  let streamOwnsFd = false;
  try {
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    const etag = `"${fileTransferVersion(stat)}"`;
    const headers: Record<string, string> = {
      "Accept-Ranges": "bytes", "ETag": etag,
      "Last-Modified": stat.mtime.toUTCString(),
      "Cache-Control": "private, no-transform",
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${path.basename(filePath).replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`,
    };
    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = req.headers.range;
    const ifRange = req.headers["if-range"];
    if (range && (!ifRange || ifRange === etag || ifRange === headers["Last-Modified"])) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      const suffix = match?.[1] === "" && match[2] !== "";
      if (match) {
        start = suffix ? Math.max(0, size - Number(match[2])) : Number(match[1]);
        end = suffix || match[2] === "" ? size - 1 : Math.min(size - 1, Number(match[2]));
      }
      if (!match || (!match[1] && !match[2]) || (suffix && Number(match[2]) <= 0) ||
          !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
        res.writeHead(416, { ...headers, "Content-Range": `bytes */${size}`, "Content-Length": "0" });
        res.end(); return;
      }
      status = 206;
      headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    }
    headers["Content-Length"] = String(Math.max(0, end - start + 1));
    res.writeHead(status, headers);
    if (!size) { res.end(); return; }
    const stream = fs.createReadStream(filePath, { fd, autoClose: true, start, end });
    streamOwnsFd = true;
    res.once("close", () => stream.destroy());
    stream.once("error", () => res.destroy());
    stream.pipe(res);
  } finally {
    if (!streamOwnsFd) fs.closeSync(fd);
  }
}
