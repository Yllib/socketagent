import { createHash } from "crypto";

/**
 * Server-owned views the app subscribes to. Design notes: docs/sync-views.md.
 *
 * Each connection (a direct socket, or one peer on a relay socket) holds a set
 * of queries. The hub sends that connection a chain of `view_transition`
 * messages; each carries the values whose hash changed for it since the last
 * one. The app applies a transition only when its `start` matches the `end` it
 * last applied, and resets its whole set when it does not.
 */

export type ViewValue = Record<string, unknown>;

/** A query bound to its arguments. `key` scopes publishes, for example a session ID. */
export interface ViewQuery {
  key: string;
  compute(): ViewValue;
}

/** Validates a query's arguments and binds them. Throws when they are invalid. */
export type ViewResolver = (args: unknown) => ViewQuery;

export interface ViewSetAdd {
  queryId: number;
  view: string;
  args?: unknown;
  knownHash?: string;
}

export interface ViewSetMessage {
  type: "view_set";
  version: number;
  reset?: boolean;
  add?: ViewSetAdd[];
  remove?: number[];
}

interface Subscription {
  view: string;
  key: string;
  hash?: string;
}

interface Connection {
  send: (json: string) => void;
  setVersion: number;
  transition: number;
  queries: Map<number, Subscription>;
}

interface Update {
  queryId: number;
  hash: string;
  /** Already serialized, so one publish stringifies its value once for every connection. */
  valueJson?: string;
}

interface Failure {
  queryId: number;
  error: string;
}

const DIRECT_PEER = "";

export function viewHash(valueJson: string): string {
  return createHash("sha256").update(valueJson).digest("base64url").slice(0, 22);
}

export class ViewHub {
  private readonly connections = new Map<object, Map<string, Connection>>();

  constructor(private readonly views: Readonly<Record<string, ViewResolver>>) {}

  /** Applies a client's `view_set` and answers with one transition. */
  applySet(owner: object, peerId: string | undefined, send: (json: string) => void, message: ViewSetMessage): void {
    const connection = this.connection(owner, peerId, send);
    connection.send = send;
    if (message.reset) {
      connection.queries.clear();
    } else if (message.version !== connection.setVersion + 1) {
      // The app lost track of its own set. It resets when it sees this.
      send(JSON.stringify({ type: "view_error", reason: "set_version", expected: connection.setVersion + 1 }));
      return;
    }
    connection.setVersion = message.version;
    for (const queryId of message.remove ?? []) connection.queries.delete(queryId);

    const updates: Update[] = [];
    const failed: Failure[] = [];
    const published: { view: string; key: string; valueJson: string; hash: string }[] = [];
    for (const add of message.add ?? []) {
      const resolver = Object.hasOwn(this.views, add.view) ? this.views[add.view] : undefined;
      let query: ViewQuery;
      let valueJson: string;
      try {
        if (!resolver) throw new Error(`Unknown view ${add.view}`);
        query = resolver(add.args);
        valueJson = JSON.stringify(query.compute());
      } catch (error: unknown) {
        connection.queries.delete(add.queryId);
        failed.push({ queryId: add.queryId, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const hash = viewHash(valueJson);
      connection.queries.set(add.queryId, { view: add.view, key: query.key, hash });
      updates.push(add.knownHash === hash ? { queryId: add.queryId, hash } : { queryId: add.queryId, hash, valueJson });
      published.push({ view: add.view, key: query.key, valueJson, hash });
    }
    this.sendTransition(connection, updates, failed, true);
    // A fresh value is news for every other subscriber too.
    for (const value of published) this.publishSerialized(value.view, value.key, value.valueJson, value.hash, connection);
  }

  /** Sends `value` to every connection whose copy of (view, key) is out of date. */
  publish(view: string, key: string, value: ViewValue): void {
    if (!this.hasSubscribers(view)) return;
    const valueJson = JSON.stringify(value);
    this.publishSerialized(view, key, valueJson, viewHash(valueJson));
  }

  /** Whether this connection receives `view` through the hub instead of its old broadcast. */
  subscribed(owner: object, peerId: string | undefined, view: string): boolean {
    const connection = this.connections.get(owner)?.get(peerId ?? DIRECT_PEER);
    if (!connection) return false;
    for (const query of connection.queries.values()) if (query.view === view) return true;
    return false;
  }

  hasSubscribers(view: string): boolean {
    for (const peers of this.connections.values()) {
      for (const connection of peers.values()) {
        for (const query of connection.queries.values()) if (query.view === view) return true;
      }
    }
    return false;
  }

  dropPeer(owner: object, peerId: string | undefined): void {
    const peers = this.connections.get(owner);
    peers?.delete(peerId ?? DIRECT_PEER);
    if (peers?.size === 0) this.connections.delete(owner);
  }

  dropOwner(owner: object): void {
    this.connections.delete(owner);
  }

  private connection(owner: object, peerId: string | undefined, send: (json: string) => void): Connection {
    let peers = this.connections.get(owner);
    if (!peers) {
      peers = new Map();
      this.connections.set(owner, peers);
    }
    const id = peerId ?? DIRECT_PEER;
    let connection = peers.get(id);
    if (!connection) {
      connection = { send, setVersion: 0, transition: 0, queries: new Map<number, Subscription>() };
      peers.set(id, connection);
    }
    return connection;
  }

  private publishSerialized(view: string, key: string, valueJson: string, hash: string, skip?: Connection): void {
    for (const peers of this.connections.values()) {
      for (const connection of peers.values()) {
        if (connection === skip) continue;
        const updates: Update[] = [];
        for (const [queryId, query] of connection.queries) {
          if (query.view !== view || query.key !== key || query.hash === hash) continue;
          query.hash = hash;
          updates.push({ queryId, hash, valueJson });
        }
        if (updates.length > 0) this.sendTransition(connection, updates, [], false);
      }
    }
  }

  private sendTransition(connection: Connection, updates: Update[], failed: Failure[], always: boolean): void {
    if (!always && updates.length === 0 && failed.length === 0) return;
    const start = connection.transition;
    connection.transition = start + 1;
    const parts = updates.map((update) => {
      const head = `{"queryId":${update.queryId},"hash":${JSON.stringify(update.hash)}`;
      return update.valueJson === undefined ? `${head}}` : `${head},"value":${update.valueJson}}`;
    });
    connection.send(
      `{"type":"view_transition","start":${start},"end":${start + 1},"setVersion":${connection.setVersion},` +
      `"updates":[${parts.join(",")}],"failed":${JSON.stringify(failed)}}`,
    );
  }
}

/** Narrows an incoming message to a `view_set`, or returns an error for the app. */
export function parseViewSet(raw: { version?: unknown; reset?: unknown; add?: unknown; remove?: unknown }): ViewSetMessage | string {
  const version = raw.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return "view_set needs a positive integer version";
  const add: ViewSetAdd[] = [];
  if (raw.add !== undefined) {
    if (!Array.isArray(raw.add)) return "view_set add must be a list";
    const items: unknown[] = raw.add;
    for (const item of items) {
      if (typeof item !== "object" || item === null) return "view_set add entries must be objects";
      const entry: Record<string, unknown> = { ...item };
      if (typeof entry.queryId !== "number" || !Number.isInteger(entry.queryId)) return "view_set add needs an integer queryId";
      if (typeof entry.view !== "string") return "view_set add needs a view name";
      add.push({
        queryId: entry.queryId,
        view: entry.view,
        args: entry.args,
        ...(typeof entry.knownHash === "string" ? { knownHash: entry.knownHash } : {}),
      });
    }
  }
  const remove: number[] = [];
  if (raw.remove !== undefined) {
    if (!Array.isArray(raw.remove)) return "view_set remove must be a list";
    const queryIds: unknown[] = raw.remove;
    for (const queryId of queryIds) {
      if (typeof queryId !== "number" || !Number.isInteger(queryId)) return "view_set remove needs integer queryIds";
      remove.push(queryId);
    }
  }
  return { type: "view_set", version, reset: raw.reset === true, add, remove };
}
