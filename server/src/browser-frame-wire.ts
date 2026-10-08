import type { BrowserFrame } from "./browser-session-manager";
import { isRecord } from "./value-guards";

export const BINARY_BROWSER_FRAME_VERSION = 1;
export const BIN_MARKER_BROWSER_FRAME = 0x56; // 'V'

/**
 * Encode a streamed browser frame as raw JPEG bytes behind a JSON header,
 * which is a quarter smaller than the JSON message with the image in base64.
 * The caller encrypts the result as one binary envelope.
 *
 * Wire format: [V][u32 headerLen][header JSON][JPEG bytes]. The header is the
 * browser_frame message without imageBase64.
 */
export function encodeBinaryBrowserFrame(frame: BrowserFrame): Buffer {
  const { imageBase64, ...fields } = frame;
  const header = Buffer.from(JSON.stringify({ type: "browser_frame", ...fields }), "utf8");
  const image = Buffer.from(imageBase64, "base64");
  const encoded = Buffer.allocUnsafe(1 + 4 + header.length + image.length);
  encoded[0] = BIN_MARKER_BROWSER_FRAME;
  encoded.writeUInt32BE(header.length, 1);
  header.copy(encoded, 5);
  image.copy(encoded, 5 + header.length);
  return encoded;
}

/** Whether a client_capabilities or direct_auth message says the app reads binary frames. */
export function supportsBinaryBrowserFrames(message: unknown): boolean {
  if (!isRecord(message)) return false;
  const version = message.binaryBrowserFrameVersion;
  return typeof version === "number"
    && Number.isInteger(version)
    && version >= BINARY_BROWSER_FRAME_VERSION;
}
