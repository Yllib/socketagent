import { createHash } from "crypto";

/**
 * Server-owned views the app subscribes to. Design notes: docs/sync-views.md.
 *
 * Each connection (a direct socket, or one peer on a relay socket) holds a set
 * of queries. The hub sends that connection a chain of `view_transition`
 * messages; each carries the values whose hash changed for it since the last
 * one. The app applies a transition only when its `start` matches the `end` it
 * last applied, and resets its whole set when it does not.
 *
 * A value view sends its whole value when it changes. A row view (a
 * transcript) sends patches: rows whose revision changed, and the IDs of rows
 * that left it.
 */

export type ViewValue = Record<string, unknown>;

/** One row of a row view. Rows without an entry ID cannot be patched and are left out. */
export interface ViewRow {
  entryId?: string;
  revision?: number;
}

/** A query bound to its arguments. `key` scopes publishes and invalidations, for example a session ID. */
export type ViewQuery =
  | { kind: "value"; key: string; compute(): ViewValue }
  | { kind: "rows"; key: string; compute(): { meta: ViewValue; rows: readonly ViewRow[] } };

/** Validates a query's arguments and binds them. Throws when they are invalid. */
export type ViewResolver = (args: unknown) => ViewQuery;

export interface ViewSetAdd {
  queryId: number;
  view: string;
  args?: unknown;
  knownHash?: string;
  /** For row views: `entryId:revision` for each row the app already holds. */
  known?: string[];
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
  query: ViewQuery;
  hash?: string;
  /** Row views: the revision of each row this connection holds. */
  held: Map<string, number>;
}

interface Connection {
  send: (json: string) => void;
  setVersion: number;
  transition: number;
  queries: Map<number, Subscription>;
}

/** One query's part of a transition, already serialized. */
interface Update {
  queryId: number;
  json: string;
  summary: string;
}

interface Failure {
  queryId: number;
  error: string;
}

const DIRECT_PEER = "";

export function viewHash(valueJson: string): string {
  return createHash("sha256").update(valueJson).digest("base64url").slice(0, 22);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rowVersions(rows: readonly ViewRow[]): Map<string, number> {
  const versions = new Map<string, number>();
  for (const row of rows) if (row.entryId) versions.set(row.entryId, row.revision ?? 0);
  return versions;
}

function rowsHash(metaJson: string, versions: Map<string, number>): string {
  const parts: string[] = [];
  for (const [entryId, revision] of versions) parts.push(`${entryId}:${revision}`);
  return viewHash(`${metaJson}\n${parts.join(",")}`);
}

function parseKnownRows(known: readonly string[] | undefined): Map<string, number> {
  const held = new Map<string, number>();
  for (const item of known ?? []) {
    const split = item.lastIndexOf(":");
    const revision = Number(item.slice(split + 1));
    if (split > 0 && Number.isFinite(revision)) held.set(item.slice(0, split), revision);
  }
  return held;
}

export class ViewHub {
  private readonly connections = new Map<object, Map<string, Connection>>();
  private readonly pending = new Set<string>();
  private flushScheduled = false;

  constructor(private readonly views: Readonly<Record<string, ViewResolver>>) {}

  /** Applies a client's `view_set` and answers with one transition. */
  applySet(owner: object, peerId: string | undefined, send: (json: string) => void, message: ViewSetMessage): void {
    const connection = this.connection(owner, peerId, send);
    connection.send = send;
    if (message.reset) {
      connection.queries.clear();
    } else if (message.version !== connection.setVersion + 1) {
      // The app lost track of its own set. It resets when it sees this.
      console.log(`[Views] ${peerId ?? "direct"} sent set ${message.version}, expected ${connection.setVersion + 1}; asked it to reset`);
      send(JSON.stringify({ type: "view_error", reason: "set_version", expected: connection.setVersion + 1 }));
      return;
    }
    connection.setVersion = message.version;
    for (const queryId of message.remove ?? []) connection.queries.delete(queryId);

    const updates: Update[] = [];
    const failed: Failure[] = [];
    const fresh: { view: string; key: string; valueJson: string; hash: string }[] = [];
    for (const add of message.add ?? []) {
      const resolver = Object.hasOwn(this.views, add.view) ? this.views[add.view] : undefined;
      try {
        if (!resolver) throw new Error(`Unknown view ${add.view}`);
        const query = resolver(add.args);
        const subscription: Subscription = {
          view: add.view,
          query,
          held: query.kind === "rows" ? parseKnownRows(add.known) : new Map<string, number>(),
        };
        const update = this.refresh(add.queryId, subscription, add.knownHash);
        connection.queries.set(add.queryId, subscription);
        updates.push(update ?? this.unchanged(add.queryId, subscription));
        if (query.kind === "value" && update && subscription.hash) {
          fresh.push({ view: add.view, key: query.key, valueJson: update.valueJson ?? "", hash: subscription.hash });
        }
      } catch (error: unknown) {
        connection.queries.delete(add.queryId);
        failed.push({ queryId: add.queryId, error: errorText(error) });
      }
    }
    this.sendTransition(connection, updates, failed, true);
    const summary = updates.map((update) => update.summary);
    for (const failure of failed) summary.push(`query ${failure.queryId} failed: ${failure.error}`);
    console.log(`[Views] ${peerId ?? "direct"} set ${message.version}${message.reset ? " reset" : ""}: ${summary.join(", ") || "no queries"}`);
    // A fresh value is news for every other subscriber too.
    for (const value of fresh) this.publishSerialized(value.view, value.key, value.valueJson, value.hash, connection);
  }

  /** Sends `value` to every connection whose copy of the value view (view, key) is out of date. */
  publish(view: string, key: string, value: ViewValue): void {
    if (!this.hasSubscribers(view)) return;
    const valueJson = JSON.stringify(value);
    this.publishSerialized(view, key, valueJson, viewHash(valueJson));
  }

  /**
   * Marks (view, key) as changed. Queries for it are recomputed once, after
   * the current tick, so a burst of writes costs one transition.
   */
  invalidate(view: string, key: string): void {
    if (!this.hasSubscribers(view)) return;
    this.pending.add(`${view}\0${key}`);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => this.flush());
  }

  /** Recomputes every invalidated query now. Normally runs on its own after `invalidate`. */
  flush(): void {
    this.flushScheduled = false;
    if (this.pending.size === 0) return;
    const pending = new Set(this.pending);
    this.pending.clear();
    for (const peers of this.connections.values()) {
      for (const connection of peers.values()) {
        const updates: Update[] = [];
        const failed: Failure[] = [];
        for (const [queryId, subscription] of connection.queries) {
          if (!pending.has(`${subscription.view}\0${subscription.query.key}`)) continue;
          try {
            const update = this.refresh(queryId, subscription);
            if (update) updates.push(update);
          } catch (error: unknown) {
            subscription.hash = undefined;
            failed.push({ queryId, error: errorText(error) });
          }
        }
        this.sendTransition(connection, updates, failed, false);
      }
    }
  }

  /** Whether this connection receives `view` through the hub instead of its old broadcast. */
  subscribed(owner: object, peerId: string | undefined, view: string, key?: string): boolean {
    const connection = this.connections.get(owner)?.get(peerId ?? DIRECT_PEER);
    if (!connection) return false;
    for (const query of connection.queries.values()) {
      if (query.view === view && (key === undefined || query.query.key === key)) return true;
    }
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

  /**
   * Recomputes one query and returns its update, or undefined when the
   * connection already holds the current version. `knownHash` is a hash the
   * app holds from an earlier connection.
   */
  private refresh(
    queryId: number,
    subscription: Subscription,
    knownHash?: string,
  ): (Update & { valueJson?: string }) | undefined {
    const query = subscription.query;
    if (query.kind === "value") {
      const valueJson = JSON.stringify(query.compute());
      const hash = viewHash(valueJson);
      if (hash === subscription.hash) return undefined;
      subscription.hash = hash;
      if (hash === knownHash) return undefined;
      return {
        queryId,
        valueJson,
        json: `{"queryId":${queryId},"hash":${JSON.stringify(hash)},"value":${valueJson}}`,
        summary: `${subscription.view} (${Buffer.byteLength(valueJson)} bytes)`,
      };
    }
    const { meta, rows } = query.compute();
    const metaJson = JSON.stringify(meta);
    const next = rowVersions(rows);
    const hash = rowsHash(metaJson, next);
    if (hash === subscription.hash) return undefined;
    subscription.hash = hash;
    if (hash === knownHash) {
      subscription.held = next;
      return undefined;
    }
    const upsert: string[] = [];
    for (const row of rows) {
      if (row.entryId && subscription.held.get(row.entryId) !== (row.revision ?? 0)) upsert.push(JSON.stringify(row));
    }
    const remove: string[] = [];
    for (const entryId of subscription.held.keys()) if (!next.has(entryId)) remove.push(entryId);
    subscription.held = next;
    return {
      queryId,
      json: `{"queryId":${queryId},"hash":${JSON.stringify(hash)},"meta":${metaJson},` +
        `"upsert":[${upsert.join(",")}],"remove":${JSON.stringify(remove)}}`,
      summary: `${subscription.view} (+${upsert.length} -${remove.length} rows)`,
    };
  }

  /** Confirms that the app's copy is current without resending it. */
  private unchanged(queryId: number, subscription: Subscription): Update {
    return {
      queryId,
      json: `{"queryId":${queryId},"hash":${JSON.stringify(subscription.hash ?? "")}}`,
      summary: `${subscription.view} (unchanged)`,
    };
  }

  private publishSerialized(view: string, key: string, valueJson: string, hash: string, skip?: Connection): void {
    for (const peers of this.connections.values()) {
      for (const connection of peers.values()) {
        if (connection === skip) continue;
        const updates: Update[] = [];
        for (const [queryId, subscription] of connection.queries) {
          if (subscription.view !== view || subscription.query.key !== key || subscription.hash === hash) continue;
          subscription.hash = hash;
          updates.push({
            queryId,
            json: `{"queryId":${queryId},"hash":${JSON.stringify(hash)},"value":${valueJson}}`,
            summary: view,
          });
        }
        this.sendTransition(connection, updates, [], false);
      }
    }
  }

  private sendTransition(connection: Connection, updates: Update[], failed: Failure[], always: boolean): void {
    if (!always && updates.length === 0 && failed.length === 0) return;
    const start = connection.transition;
    connection.transition = start + 1;
    connection.send(
      `{"type":"view_transition","start":${start},"end":${start + 1},"setVersion":${connection.setVersion},` +
      `"updates":[${updates.map((update) => update.json).join(",")}],"failed":${JSON.stringify(failed)}}`,
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
      let known: string[] | undefined;
      if (entry.known !== undefined) {
        if (!Array.isArray(entry.known)) return "view_set known must be a list";
        const values: unknown[] = entry.known;
        known = values.filter((value): value is string => typeof value === "string");
      }
      add.push({
        queryId: entry.queryId,
        view: entry.view,
        args: entry.args,
        ...(typeof entry.knownHash === "string" ? { knownHash: entry.knownHash } : {}),
        ...(known ? { known } : {}),
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
