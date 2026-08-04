/**
 * Tracks every live runner for a SocketAgent session ID.
 *
 * `activeSessions` intentionally exposes one canonical runner per session to
 * the rest of the server.  Safety operations cannot make that assumption: a
 * reconnect or continuation race may briefly leave more than one runner alive
 * for the same persisted session.  The stop path uses this registry so it can
 * terminate every runner for the requested ID without touching child session
 * IDs.
 */
export class SessionInstanceRegistry<T extends object> {
  private readonly bySessionId = new Map<string, Set<T>>();

  setActive(sessionId: string, instance: T, active: boolean): void {
    const id = sessionId.trim();
    if (!id) return;
    if (!active) {
      this.remove(instance, id);
      return;
    }
    let instances = this.bySessionId.get(id);
    if (!instances) {
      instances = new Set<T>();
      this.bySessionId.set(id, instances);
    }
    instances.add(instance);
  }

  rekey(instance: T, previousSessionId: string, nextSessionId: string): void {
    const wasActive = this.instances(previousSessionId).includes(instance);
    this.remove(instance, previousSessionId);
    if (wasActive) this.setActive(nextSessionId, instance, true);
  }

  remove(instance: T, sessionId?: string): void {
    if (sessionId) {
      const id = sessionId.trim();
      const instances = this.bySessionId.get(id);
      if (!instances) return;
      instances.delete(instance);
      if (instances.size === 0) this.bySessionId.delete(id);
      return;
    }
    for (const [id, instances] of this.bySessionId) {
      instances.delete(instance);
      if (instances.size === 0) this.bySessionId.delete(id);
    }
  }

  instances(sessionId: string, extras: Iterable<T | null | undefined> = []): T[] {
    const result = new Set<T>(this.bySessionId.get(sessionId.trim()) || []);
    for (const instance of extras) {
      if (instance) result.add(instance);
    }
    return [...result];
  }
}
