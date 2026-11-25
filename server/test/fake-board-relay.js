const crypto = require("node:crypto");
const { parseJsonObject } = require("#server/value-guards");

/**
 * A small stand-in for the relay's board routes (docs/project-boards.md,
 * "Relay API"). It checks every signature with Node's own Ed25519, so a
 * request this server signs wrongly fails here the way it would there.
 */
class FakeRelay {
  constructor() {
    /** @type {Map<string, { seq: number, records: Map<string, { version: number, seq: number, ciphertext: string }> }>} */
    this.boards = new Map();
    /** @type {Set<string>} */
    this.deleted = new Set();
    this.down = false;
    /** @type {number[]} statuses the next PUTs answer with instead of writing */
    this.refusePuts = [];
    /** @type {(() => Promise<void>) | null} runs once just before the next PUT is applied */
    this.beforeNextPut = null;
    this.puts = 0;
  }

  /** @param {string} boardId */
  board(boardId) {
    let board = this.boards.get(boardId);
    if (!board) {
      /** @type {Map<string, { version: number, seq: number, ciphertext: string }>} */
      const records = new Map();
      board = { seq: 0, records };
      this.boards.set(boardId, board);
    }
    return board;
  }

  /** @type {import("#server/project-board-relay").BoardFetch} */
  fetch = async (url, init) => {
    if (this.down) throw new TypeError("fetch failed");
    const parsed = new URL(url);
    const body = init.body ?? "";
    const boardId = init.headers["X-SA-Board"];
    const time = init.headers["X-SA-Time"];
    const message = ["socketagent-board-v1", init.method, parsed.pathname, time,
      crypto.createHash("sha256").update(body).digest("hex")].join("\n");
    const key = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: boardId }, format: "jwk" });
    if (!crypto.verify(null, Buffer.from(message), key, Buffer.from(init.headers["X-SA-Signature"], "base64"))) {
      return reply(401, { error: "unauthorized" });
    }
    if (this.deleted.has(boardId)) return reply(410, { error: "gone" });
    const board = this.board(boardId);
    if (init.method === "GET" && parsed.pathname === "/api/board/records") {
      const since = Number(parsed.searchParams.get("since") ?? "0");
      const records = [...board.records].filter(([, record]) => record.seq > since)
        .sort(([, a], [, b]) => a.seq - b.seq)
        .map(([id, record]) => ({ id, ...record }));
      return reply(200, { seq: board.seq, records });
    }
    const match = /^\/api\/board\/records\/(.+)$/.exec(parsed.pathname);
    if (init.method === "PUT" && match) {
      const hook = this.beforeNextPut;
      this.beforeNextPut = null;
      if (hook) await hook();
      const refusal = this.refusePuts.shift();
      if (refusal === 429) return reply(429, { error: "rate_limited" });
      if (refusal === 400) return reply(400, { error: "invalid_body" });
      const request = parseJsonObject(body);
      const current = board.records.get(match[1]);
      if (request.expectedVersion !== (current?.version ?? 0)) {
        return reply(409, { error: "conflict", version: current?.version ?? 0 });
      }
      this.puts++;
      board.seq++;
      const saved = { version: (current?.version ?? 0) + 1, seq: board.seq, ciphertext: String(request.ciphertext) };
      board.records.set(match[1], saved);
      return reply(200, { version: saved.version, seq: saved.seq });
    }
    return reply(404, { error: "not_found" });
  };
}

/** @param {number} status @param {unknown} value */
function reply(status, value) {
  return { status, text: async () => JSON.stringify(value) };
}

module.exports = { FakeRelay, reply };
