import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { socketAgentDataPath } from "./socket-agent-paths";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).filter(([key]) => !key.startsWith("__") && key !== "commandId")
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]),
  );
  return value;
}

type Reply = Record<string, unknown>;
type Claim = { status: "new" | "pending" | "uncertain" | "conflict" } |
  { status: "accepted"; replies: Reply[]; currentProcess: boolean };

/** Records dispatch separately from completion. An interrupted dispatch is
 * never replayed automatically: the external backend may already have run it. */
export class CommandReceipts {
  private readonly db: DatabaseSync;
  private readonly owner = randomUUID();
  constructor(file = socketAgentDataPath("command-receipts.sqlite")) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    try { chmodSync(file, 0o600); } catch {}
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS command_receipts (
        id TEXT PRIMARY KEY, digest TEXT NOT NULL, owner TEXT NOT NULL,
        state TEXT NOT NULL, replies TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS client_conversations (
        client_id TEXT PRIMARY KEY, first_command_id TEXT NOT NULL,
        session_id TEXT NOT NULL DEFAULT '', owner TEXT NOT NULL
      )`);
  }
  claim(id: string, payload: unknown): Claim {
    const digest = createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO command_receipts
      (id,digest,owner,state,created_at) VALUES (?,?,?,'dispatching',?)`)
      .run(id, digest, this.owner, new Date().toISOString());
    if (inserted.changes) return { status: "new" };
    const row = this.db.prepare("SELECT * FROM command_receipts WHERE id=?").get(id)!;
    if (row.digest !== digest) return { status: "conflict" };
    if (row.state === "accepted") return { status: "accepted", replies: JSON.parse(String(row.replies)) as Reply[], currentProcess: row.owner === this.owner };
    return { status: row.state === "dispatching" && row.owner === this.owner ? "pending" : "uncertain" };
  }
  conversation(clientId: string): { firstCommandId: string; sessionId: string; currentProcess: boolean } | undefined {
    const row = this.db.prepare("SELECT * FROM client_conversations WHERE client_id=?").get(clientId);
    return row ? { firstCommandId: String(row.first_command_id), sessionId: String(row.session_id), currentProcess: row.owner === this.owner } : undefined;
  }
  reserveConversation(clientId: string, commandId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO client_conversations (client_id,first_command_id,owner) VALUES (?,?,?)")
      .run(clientId, commandId, this.owner);
  }
  bindConversation(clientId: string, sessionId: string): void {
    if (!sessionId) return;
    this.db.prepare("UPDATE client_conversations SET session_id=? WHERE client_id=? AND owner=?")
      .run(sessionId, clientId, this.owner);
  }
  releaseUnstartedConversation(clientId: string, commandId: string): void {
    this.db.prepare("DELETE FROM client_conversations WHERE client_id=? AND first_command_id=? AND session_id='' AND owner=?")
      .run(clientId, commandId, this.owner);
  }
  remapConversation(previous: string, next: string): void {
    this.db.prepare("UPDATE client_conversations SET session_id=? WHERE session_id=?").run(next, previous);
  }
  confirmPrompt(id: string, messageId: string, sessionId: string): void {
    const row = this.db.prepare("SELECT replies FROM command_receipts WHERE id=? AND owner=?").get(id, this.owner);
    if (!row) return;
    const replies = (JSON.parse(String(row.replies)) as Reply[]).filter(reply => reply.type !== "prompt_received");
    replies.push({ type: "prompt_received", messageId, sessionId });
    this.accept(id, replies);
  }
  accept(id: string, replies: Reply[]): void {
    if (replies.length === 0) {
      this.db.prepare("UPDATE command_receipts SET state='accepted' WHERE id=? AND owner=?").run(id, this.owner);
      return;
    }
    this.db.prepare("UPDATE command_receipts SET state='accepted',replies=? WHERE id=? AND owner=?")
      .run(JSON.stringify(replies), id, this.owner);
  }
  uncertain(id: string): void {
    this.db.prepare("UPDATE command_receipts SET state='uncertain' WHERE id=? AND owner=?")
      .run(id, this.owner);
  }
  close(): void { this.db.close(); }
}
