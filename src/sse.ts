import type { PresenceClient, Role } from '../shared/types.ts';

export type HubEvent = 'activity' | 'presence' | 'visibility.changed';

export type HubClient = {
  id: string;
  name: string;
  since: string;
  userId: string;
  sessionHash?: string;
  role: Role;
  // `json` is pre-serialized once per broadcast, so N clients share the work.
  send: (event: HubEvent, json: string, seq?: number) => void;
  close: () => void;
};

export type BroadcastScope = {
  canSee?: (role: Role, userId: string) => boolean;
};

const PRESENCE_THROTTLE_MS = 1_000;

export class EventHub {
  readonly #clients = new Map<string, HubClient>();
  readonly #joined = new Map<string, PresenceClient>();
  readonly #left = new Set<string>();
  #presenceTimer: ReturnType<typeof setTimeout> | null = null;

  get size(): number {
    return this.#clients.size;
  }

  get clients(): PresenceClient[] {
    return [...this.#clients.values()].map(({ id, name, since }) => ({ id, name, since }));
  }

  add(client: HubClient): void {
    this.#clients.set(client.id, client);
    this.#left.delete(client.id);
    this.#joined.set(client.id, { id: client.id, name: client.name, since: client.since });
    this.#schedulePresence();
  }

  remove(id: string): void {
    if (!this.#clients.delete(id)) return;
    this.#joined.delete(id);
    this.#left.add(id);
    this.#schedulePresence();
  }

  closeUser(userId: string): void {
    this.#closeWhere((client) => client.userId === userId);
  }

  closeSession(sessionHash: string): void {
    this.#closeWhere((client) => client.sessionHash === sessionHash);
  }

  #closeWhere(match: (client: HubClient) => boolean): void {
    let removed = false;
    for (const [id, client] of this.#clients) {
      if (!match(client)) continue;
      this.#clients.delete(id);
      this.#joined.delete(id);
      this.#left.add(id);
      removed = true;
      try {
        client.close();
      } catch {
        // stream already closed
      }
    }
    if (removed) this.#schedulePresence();
  }

  #schedulePresence(): void {
    if (this.#presenceTimer !== null) return;
    this.#presenceTimer = setTimeout(() => {
      this.#presenceTimer = null;
      this.#flushPresence();
    }, PRESENCE_THROTTLE_MS);
    this.#presenceTimer.unref?.();
  }

  // Clients receive the full list on their own handshake, so later updates only
  // carry the changes since the last broadcast.
  #flushPresence(): void {
    const joined = [...this.#joined.values()];
    const left = [...this.#left];
    this.#joined.clear();
    this.#left.clear();
    if (joined.length === 0 && left.length === 0) return;
    this.broadcast('presence', { joined, left });
  }

  broadcast(event: HubEvent, data: unknown, seq?: number, scope?: BroadcastScope): void {
    const json = JSON.stringify(data);
    for (const client of this.#clients.values()) {
      if (scope?.canSee && !scope.canSee(client.role, client.userId)) continue;
      client.send(event, json, seq);
    }
  }

  closeAll(): void {
    if (this.#presenceTimer !== null) {
      clearTimeout(this.#presenceTimer);
      this.#presenceTimer = null;
    }
    this.#joined.clear();
    this.#left.clear();
    for (const client of this.#clients.values()) {
      client.close();
    }
    this.#clients.clear();
  }
}
