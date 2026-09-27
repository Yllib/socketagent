import type { BinaryFileDownloadChunkMetadata } from "./file-transfer-wire";

/** Shared surface for direct sockets, relay peers, and headless session delivery. */
export interface ClientTransport {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  readonly connectionGeneration?: number;
  supportsRawSdkEvents?: boolean;
  supportsSessionEventAck?: boolean;
  supportsMonitorOutputAck?: boolean;
  send(data: string): void;
  setClientCapabilities?(message: unknown): void;
  sendReply?(peerId: string, data: string): void;
  supportsBinaryFileDownload?(peerId?: string): boolean;
  sendFileDownloadChunk?(
    metadata: BinaryFileDownloadChunkMetadata,
    bytes: Buffer,
    peerId?: string,
  ): boolean;
}
