import * as dotenv from "dotenv";
import { execFile } from "child_process";
import * as crypto from "crypto";
import * as net from "net";
import * as path from "path";
import WebSocket from "ws";
import {
  EncryptedEnvelope,
  KeyPair,
  decrypt,
  decryptBinary,
  encrypt,
  encryptBinary,
  fromBase64,
  loadOrCreateKeyPair,
  toBase64,
} from "./relay-crypto";
import { socketAgentDataPath } from "./socket-agent-paths";

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const BIN_MARKER_JSON = 0x4a; // 'J'
const BIN_MARKER_ADB_DATA = 0x44; // 'D': [marker][4 streamId BE][bytes]
const LEGACY_PEER_ID = "legacy";

interface RelayPeer {
  publicKey: Uint8Array | null;
  binaryEnabled: boolean;
}

interface BridgeStream {
  id: number;
  peerId: string;
  socket: net.Socket;
  closed: boolean;
}

interface BridgeOptions {
  relayUrl: string;
  pairingToken: string;
  keyPair: KeyPair;
  channel: string;
  localHost: string;
  localPort: number;
}

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0) return process.argv[idx + 1];
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function usage(): void {
  console.log(`SocketAgent ADB bridge sidecar

Usage:
  socketagent adb-bridge [options]
  node server/dist/adb-bridge.js [options]

Options:
  --local-host <host>     Local bind host for adb client. Default: 127.0.0.1
  --local-port <port>     Local bind port for adb client. Default: 5038
  --channel <name>        Relay channel. Default: adb
  --relay-url <url>       Override RELAY_URL from server/.env
  --pairing-token <tok>   Override PAIRING_TOKEN from server/.env
  --bridge-pairing-token <tok>
                         Exact relay token for bridge, instead of derived token

Phone flow:
  1. Enable Android Wireless Debugging.
  2. Start the SocketAgent ADB bridge in the app and set its target host/port.
  3. Run adb pair/connect against this sidecar's local host/port.
`);
}

function readOptions(): BridgeOptions {
  if (hasFlag("help") || hasFlag("h")) {
    usage();
    process.exit(0);
  }

  const relayUrl = argValue("relay-url") || process.env.RELAY_URL || "";
  const basePairingToken =
    argValue("pairing-token") || process.env.PAIRING_TOKEN || "";
  const pairingToken =
    argValue("bridge-pairing-token") || deriveBridgePairingToken(basePairingToken);
  const localHost = argValue("local-host") || "127.0.0.1";
  const localPort = Number(
    argValue("local-port") || process.env.SOCKETAGENT_ADB_BRIDGE_PORT || 5038
  );
  const channel = (argValue("channel") || "adb").replace(
    /[^a-zA-Z0-9_-]/g,
    ""
  ) || "adb";

  if (!relayUrl || !basePairingToken) {
    throw new Error("RELAY_URL and PAIRING_TOKEN are required");
  }
  if (!Number.isInteger(localPort) || localPort <= 0 || localPort > 65535) {
    throw new Error(`Invalid --local-port: ${localPort}`);
  }

  return {
    relayUrl,
    pairingToken,
    keyPair: loadOrCreateKeyPair(socketAgentDataPath("relay-keys.json")),
    channel,
    localHost,
    localPort,
  };
}

function deriveBridgePairingToken(pairingToken: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(`${pairingToken}:adb-bridge`, "utf8")
    .digest("hex");
  return `adb-${hash}`;
}

class AdbBridgeSidecar {
  private ws: WebSocket | null = null;
  private relaySupportsMultiDevice = false;
  private peers = new Map<string, RelayPeer>();
  private streams = new Map<number, BridgeStream>();
  private tcpServer: net.Server | null = null;
  private nextStreamId = 1;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private closed = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongReceived = true;

  constructor(private opts: BridgeOptions) {}

  start(): void {
    this.startTcpServer();
    this.connectRelay();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopPing();
    this.ws?.close();
    this.tcpServer?.close();
    for (const stream of this.streams.values()) {
      stream.socket.destroy();
    }
    this.streams.clear();
  }

  private startTcpServer(): void {
    this.tcpServer = net.createServer((socket) => this.handleAdbClient(socket));
    this.tcpServer.listen(this.opts.localPort, this.opts.localHost, () => {
      console.log(
        `[ADB Bridge] Listening for adb on ${this.opts.localHost}:${this.opts.localPort}`
      );
      console.log(
        `[ADB Bridge] Run: adb pair ${this.opts.localHost}:${this.opts.localPort}`
      );
      console.log(
        `[ADB Bridge] Then retarget the phone bridge to the connect port and run: adb connect ${this.opts.localHost}:${this.opts.localPort}`
      );
    });
  }

  private connectRelay(): void {
    if (this.closed) return;
    const url =
      `${this.opts.relayUrl}?token=${encodeURIComponent(this.opts.pairingToken)}` +
      `&role=server&multi_device=1&channel=${encodeURIComponent(this.opts.channel)}`;
    console.log(
      `[ADB Bridge] Connecting to relay channel "${this.opts.channel}"...`
    );

    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.reconnectDelay = 1000;
      this.startPing();
      console.log("[ADB Bridge] Relay connected; waiting for phone bridge");
    });

    this.ws.on("pong", () => {
      this.pongReceived = true;
    });

    this.ws.on("message", (data, isBinary) => {
      try {
        if (isBinary) {
          this.handleBinaryFrame(
            Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
          );
          return;
        }
        this.handleRelayMessage(JSON.parse(data.toString()));
      } catch (err: any) {
        console.error(`[ADB Bridge] Relay message error: ${err.message}`);
      }
    });

    this.ws.on("close", () => {
      console.log("[ADB Bridge] Relay disconnected");
      this.stopPing();
      this.ws = null;
      this.peers.clear();
      this.closeAllStreams("relay disconnected");
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      console.error(`[ADB Bridge] Relay error: ${err.message}`);
    });
  }

  private handleRelayMessage(msg: any): void {
    if (msg.type === "relay_capabilities") {
      this.relaySupportsMultiDevice = !!msg.multiDevice;
      return;
    }

    if (msg.type === "peer_connected") {
      const peerId = typeof msg.peerId === "string" ? msg.peerId : LEGACY_PEER_ID;
      this.getPeer(peerId);
      console.log(`[ADB Bridge] Phone bridge connected (${peerId})`);
      return;
    }

    if (msg.type === "peer_disconnected") {
      const peerId = typeof msg.peerId === "string" ? msg.peerId : undefined;
      if (peerId) {
        this.peers.delete(peerId);
        this.closeStreamsForPeer(peerId, "phone bridge disconnected");
      } else {
        this.peers.clear();
        this.closeAllStreams("phone bridge disconnected");
      }
      console.log("[ADB Bridge] Phone bridge disconnected");
      return;
    }

    if (msg.type === "relay_peer_message") {
      const peerId = typeof msg.peerId === "string" ? msg.peerId : LEGACY_PEER_ID;
      if (msg.binary) {
        this.handleBinaryFrame(Buffer.from(String(msg.data || ""), "base64"), peerId);
        return;
      }
      this.handlePeerMessage(JSON.parse(String(msg.data || "")), peerId);
      return;
    }

    this.handlePeerMessage(msg, LEGACY_PEER_ID);
  }

  private handlePeerMessage(msg: any, peerId: string): void {
    const peer = this.getPeer(peerId);

    if (msg.type === "key_exchange") {
      peer.publicKey = fromBase64(String(msg.pubkey || ""));
      this.sendPlainToPeer(peerId, { type: "key_exchange_ack" });
      console.log(`[ADB Bridge] Encrypted phone bridge paired (${peerId})`);
      return;
    }

    if (msg.n && msg.c) {
      if (!peer.publicKey) return;
      try {
        const plaintext = decrypt(
          msg as EncryptedEnvelope,
          peer.publicKey,
          this.opts.keyPair.secretKey
        );
        this.handleJsonMessage(JSON.parse(plaintext), peerId);
      } catch (err: any) {
        console.error(`[ADB Bridge] Decryption failed: ${err.message}`);
      }
    }
  }

  private handleBinaryFrame(buf: Buffer, peerId = LEGACY_PEER_ID): void {
    const peer = this.getPeer(peerId);
    if (!peer.publicKey) return;

    let plaintext: Uint8Array;
    try {
      plaintext = decryptBinary(buf, peer.publicKey, this.opts.keyPair.secretKey);
    } catch (err: any) {
      console.error(`[ADB Bridge] Binary decrypt failed: ${err.message}`);
      return;
    }

    if (plaintext.length === 0) return;
    const marker = plaintext[0];
    if (marker === BIN_MARKER_JSON) {
      try {
        this.handleJsonMessage(
          JSON.parse(new TextDecoder().decode(plaintext.subarray(1))),
          peerId
        );
      } catch (err: any) {
        console.error(`[ADB Bridge] Binary JSON parse failed: ${err.message}`);
      }
      return;
    }

    if (marker === BIN_MARKER_ADB_DATA) {
      if (plaintext.length < 5) return;
      const streamId =
        ((plaintext[1] << 24) >>> 0) |
        (plaintext[2] << 16) |
        (plaintext[3] << 8) |
        plaintext[4];
      const stream = this.streams.get(streamId);
      if (!stream || stream.closed) return;
      stream.socket.write(Buffer.from(plaintext.subarray(5)));
      return;
    }

    console.warn(`[ADB Bridge] Unknown binary marker: 0x${marker.toString(16)}`);
  }

  private handleJsonMessage(msg: any, peerId: string): void {
    const peer = this.getPeer(peerId);

    if (msg.type === "adb_bridge_client_capabilities") {
      peer.binaryEnabled = msg.binaryEnvelope === true;
      this.sendJsonToPeer(peerId, {
        type: "adb_bridge_server_capabilities",
        binaryEnvelope: true,
      });
      console.log(
        `[ADB Bridge] Phone bridge ready; binary=${peer.binaryEnabled}`
      );
      return;
    }

    if (msg.type === "adb_pair_request") {
      const requestId = String(msg.requestId || "");
      const code = String(msg.code || "").trim();
      if (!code) {
        this.sendJsonToPeer(peerId, {
          type: "adb_command_result",
          requestId,
          command: "pair",
          ok: false,
          exitCode: null,
          stdout: "",
          stderr: "",
          message: "Pairing code is required.",
        });
        return;
      }
      this.runAdbCommand(peerId, requestId, "pair", [
        `${this.opts.localHost}:${this.opts.localPort}`,
        code,
      ]);
      return;
    }

    if (msg.type === "adb_connect_request") {
      const requestId = String(msg.requestId || "");
      this.runAdbCommand(peerId, requestId, "connect", [
        `${this.opts.localHost}:${this.opts.localPort}`,
      ]);
      return;
    }

    if (msg.type === "adb_stream_error") {
      const streamId = Number(msg.streamId);
      const stream = this.streams.get(streamId);
      if (stream) {
        stream.socket.destroy(new Error(String(msg.message || "ADB stream error")));
        this.streams.delete(streamId);
      }
      return;
    }

    if (msg.type === "adb_stream_close") {
      this.closeStream(Number(msg.streamId), false);
      return;
    }

    if (msg.type === "adb_data") {
      const stream = this.streams.get(Number(msg.streamId));
      if (!stream || stream.closed) return;
      stream.socket.write(Buffer.from(String(msg.data || ""), "base64"));
    }
  }

  private runAdbCommand(
    peerId: string,
    requestId: string,
    command: "pair" | "connect",
    args: string[]
  ): void {
    if (!this.firstReadyPeerId()) {
      this.sendJsonToPeer(peerId, {
        type: "adb_command_result",
        requestId,
        command,
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        message: "Phone bridge is not connected.",
      });
      return;
    }

    console.log(`[ADB Bridge] Running: adb ${command} ${args.join(" ")}`);
    execFile(
      "adb",
      [command, ...args],
      { timeout: 30_000, windowsHide: true },
      (error, stdout, stderr) => {
        const exitCode =
          typeof (error as any)?.code === "number" ? (error as any).code : error ? 1 : 0;
        const timedOut = (error as any)?.killed === true;
        this.sendJsonToPeer(peerId, {
          type: "adb_command_result",
          requestId,
          command,
          ok: !error && exitCode === 0,
          exitCode,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          message: error
            ? timedOut
              ? `adb ${command} timed out`
              : String((error as any)?.message || error)
            : "",
        });
      }
    );
  }

  private handleAdbClient(socket: net.Socket): void {
    const peerId = this.firstReadyPeerId();
    if (!peerId) {
      socket.destroy(new Error("Phone ADB bridge is not connected"));
      return;
    }

    const id = this.nextStreamId++;
    const stream: BridgeStream = { id, peerId, socket, closed: false };
    this.streams.set(id, stream);
    console.log(`[ADB Bridge] adb client connected stream=${id}`);

    this.sendJsonToPeer(peerId, { type: "adb_stream_open", streamId: id });

    socket.on("data", (chunk) => {
      this.sendDataToPeer(peerId, id, chunk);
    });
    socket.on("close", () => {
      this.closeStream(id, true);
    });
    socket.on("error", (err) => {
      console.warn(`[ADB Bridge] adb socket error stream=${id}: ${err.message}`);
      this.closeStream(id, true);
    });
  }

  private closeStream(streamId: number, notifyPeer: boolean): void {
    const stream = this.streams.get(streamId);
    if (!stream || stream.closed) return;
    stream.closed = true;
    this.streams.delete(streamId);
    if (notifyPeer) {
      this.sendJsonToPeer(stream.peerId, {
        type: "adb_stream_close",
        streamId,
      });
    }
    stream.socket.end();
  }

  private closeStreamsForPeer(peerId: string, reason: string): void {
    for (const stream of Array.from(this.streams.values())) {
      if (stream.peerId === peerId) {
        console.warn(`[ADB Bridge] Closing stream=${stream.id}: ${reason}`);
        stream.closed = true;
        this.streams.delete(stream.id);
        stream.socket.destroy();
      }
    }
  }

  private closeAllStreams(reason: string): void {
    for (const stream of Array.from(this.streams.values())) {
      console.warn(`[ADB Bridge] Closing stream=${stream.id}: ${reason}`);
      stream.closed = true;
      stream.socket.destroy();
    }
    this.streams.clear();
  }

  private firstReadyPeerId(): string | null {
    for (const [peerId, peer] of this.peers.entries()) {
      if (peer.publicKey && peer.binaryEnabled) return peerId;
    }
    return null;
  }

  private getPeer(peerId: string): RelayPeer {
    let peer = this.peers.get(peerId);
    if (!peer) {
      peer = { publicKey: null, binaryEnabled: false };
      this.peers.set(peerId, peer);
    }
    return peer;
  }

  private sendPlainToPeer(peerId: string, msg: Record<string, unknown>): void {
    this.sendRawFrameToPeer(peerId, JSON.stringify(msg), false);
  }

  private sendJsonToPeer(peerId: string, msg: Record<string, unknown>): void {
    const peer = this.getPeer(peerId);
    if (!peer.publicKey) return;
    const json = JSON.stringify(msg);
    if (peer.binaryEnabled) {
      const jsonBytes = new TextEncoder().encode(json);
      const plaintext = new Uint8Array(jsonBytes.length + 1);
      plaintext[0] = BIN_MARKER_JSON;
      plaintext.set(jsonBytes, 1);
      this.sendRawFrameToPeer(
        peerId,
        encryptBinary(plaintext, peer.publicKey, this.opts.keyPair.secretKey),
        true
      );
      return;
    }
    this.sendRawFrameToPeer(
      peerId,
      JSON.stringify(encrypt(json, peer.publicKey, this.opts.keyPair.secretKey)),
      false
    );
  }

  private sendDataToPeer(peerId: string, streamId: number, chunk: Buffer): void {
    const peer = this.getPeer(peerId);
    if (!peer.publicKey) return;
    if (!peer.binaryEnabled) {
      this.sendJsonToPeer(peerId, {
        type: "adb_data",
        streamId,
        data: chunk.toString("base64"),
      });
      return;
    }

    const plaintext = Buffer.allocUnsafe(chunk.length + 5);
    plaintext[0] = BIN_MARKER_ADB_DATA;
    plaintext.writeUInt32BE(streamId, 1);
    chunk.copy(plaintext, 5);
    this.sendRawFrameToPeer(
      peerId,
      encryptBinary(plaintext, peer.publicKey, this.opts.keyPair.secretKey),
      true
    );
  }

  private sendRawFrameToPeer(peerId: string, data: string | Buffer, binary: boolean): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    if (this.relaySupportsMultiDevice) {
      this.ws.send(
        JSON.stringify({
          type: "relay_to_peer",
          peerId,
          binary,
          data: binary ? Buffer.from(data as Buffer).toString("base64") : data.toString(),
        })
      );
      return;
    }

    this.ws.send(data, { binary });
  }

  private startPing(): void {
    this.stopPing();
    this.pongReceived = true;
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (!this.pongReceived) {
        this.ws.terminate();
        return;
      }
      this.pongReceived = false;
      this.ws.ping();
    }, 30_000);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.reconnectTimer = setTimeout(() => this.connectRelay(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
  }
}

try {
  const bridge = new AdbBridgeSidecar(readOptions());
  bridge.start();
  process.on("SIGINT", () => {
    bridge.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    bridge.close();
    process.exit(0);
  });
} catch (err: any) {
  console.error(`[ADB Bridge] ${err.message}`);
  process.exit(1);
}
