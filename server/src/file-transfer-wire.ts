export const BINARY_FILE_DOWNLOAD_VERSION = 1;
export const BIN_MARKER_FILE_DOWNLOAD_CHUNK = 0x46; // 'F'

export interface BinaryFileDownloadChunkMetadata {
  fileId: string;
  transferToken?: string;
  offsetBytes: number;
  fileSize: number;
  chunkIndex: number;
  totalChunks: number;
}

/**
 * Encode one server→phone file chunk without JSON/base64 inflation.
 * The caller encrypts the returned plaintext as one NaCl binary envelope.
 *
 * Wire format:
 * [F][u16 fileIdLen][fileId][u16 tokenLen][token]
 * [u64 offset][u64 fileSize][u32 chunkIndex][u32 totalChunks][raw bytes]
 */
export function encodeBinaryFileDownloadChunk(
  metadata: BinaryFileDownloadChunkMetadata,
  bytes: Buffer,
): Buffer {
  const fileId = Buffer.from(metadata.fileId, "utf8");
  const transferToken = Buffer.from(metadata.transferToken || "", "utf8");
  if (fileId.length > 0xffff) throw new Error("fileId is too long");
  if (transferToken.length > 0xffff) throw new Error("transferToken is too long");
  if (!Number.isSafeInteger(metadata.offsetBytes) || metadata.offsetBytes < 0) {
    throw new Error("Invalid file chunk offset");
  }
  if (!Number.isSafeInteger(metadata.fileSize) || metadata.fileSize < 0) {
    throw new Error("Invalid file size");
  }

  const headerSize = 1 + 2 + fileId.length + 2 + transferToken.length + 8 + 8 + 4 + 4;
  const frame = Buffer.allocUnsafe(headerSize + bytes.length);
  let offset = 0;
  frame[offset++] = BIN_MARKER_FILE_DOWNLOAD_CHUNK;
  frame.writeUInt16BE(fileId.length, offset);
  offset += 2;
  fileId.copy(frame, offset);
  offset += fileId.length;
  frame.writeUInt16BE(transferToken.length, offset);
  offset += 2;
  transferToken.copy(frame, offset);
  offset += transferToken.length;
  frame.writeBigUInt64BE(BigInt(metadata.offsetBytes), offset);
  offset += 8;
  frame.writeBigUInt64BE(BigInt(metadata.fileSize), offset);
  offset += 8;
  frame.writeUInt32BE(metadata.chunkIndex, offset);
  offset += 4;
  frame.writeUInt32BE(metadata.totalChunks, offset);
  offset += 4;
  bytes.copy(frame, offset);
  return frame;
}

export function supportsBinaryFileDownload(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const version = (message as Record<string, unknown>).binaryFileDownloadVersion;
  return typeof version === "number"
    && Number.isInteger(version)
    && version >= BINARY_FILE_DOWNLOAD_VERSION;
}
