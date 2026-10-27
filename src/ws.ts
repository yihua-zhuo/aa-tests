import { upgradeWebSocket } from '@hono/node-server';
import type { Context } from 'hono';
import type { WSContext } from 'hono/ws';
import { WebSocketServer } from 'ws';
import { canAccessProject } from '../shared/permissions.ts';
import type { Role, SessionUser, TypingMessage } from '../shared/types.ts';
import type { AppEnv } from './app-env.ts';
import { contextIp, hostAllowed, originAllowed } from './net.ts';

type Meta = {
  clientId: string;
  name: string;
  userId: string;
  sessionHash?: string;
  role: Role;
  ip: string;
  messages: number;
  reset: number;
};

export type WsIdentity = { user: SessionUser; sessionHash?: string };

type WsOptions = {
  trustProxy?: boolean;
  allowedOrigins?: readonly string[];
  allowedHosts?: readonly string[];
  maxClients?: number;
  maxPerIp?: number;
  messageBurst?: number;
  messageWindowMs?: number;
  maxPayloadBytes?: number;
  canAccess?: (role: Role, userId: string, projectId: string) => boolean;
};

const WS_OPEN = 1;

export function createWebSocketServer(maxPayloadBytes = 64 * 1024): WebSocketServer {
  return new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: maxPayloadBytes,
  });
}

export class WsHub {
  readonly #clients = new Map<WSContext<unknown>, Meta>();
  readonly #perIp = new Map<string, number>();
  readonly #trustProxy: boolean;
  readonly #allowedOrigins: readonly string[];
  readonly #allowedHosts: readonly string[];
  readonly #maxClients: number;
  readonly #maxPerIp: number;
  readonly #messageBurst: number;
  readonly #messageWindowMs: number;
  readonly #canAccess: (role: Role, userId: string, projectId: string) => boolean;

  constructor(options: WsOptions = {}) {
    this.#trustProxy = options.trustProxy ?? false;
    this.#allowedOrigins = options.allowedOrigins ?? [];
    this.#allowedHosts = options.allowedHosts ?? [];
    this.#maxClients = options.maxClients ?? 200;
    this.#maxPerIp = options.maxPerIp ?? 10;
    this.#messageBurst = options.messageBurst ?? 60;
    this.#messageWindowMs = options.messageWindowMs ?? 10_000;
    this.#canAccess = options.canAccess ?? (() => false);
  }

  get size(): number {
    return this.#clients.size;
  }

  handler(identityOf: (c: Context<AppEnv>) => WsIdentity | null) {
    return upgradeWebSocket((c) => {
      const identity = identityOf(c as Context<AppEnv>);
      const clientId = crypto.randomUUID().slice(0, 8);
      const ip = contextIp(c, this.#trustProxy);
      const origin = c.req.header('origin');
      const host = c.req.header('host');

      return {
        onOpen: (_event: Event, ws: WSContext<unknown>) => {
          if (!identity) {
            ws.close(1008, 'authentication required');
            return;
          }
          if (!hostAllowed(host, this.#allowedHosts)) {
            ws.close(1008, 'forbidden host');
            return;
          }
          if (!originAllowed(origin, host, this.#allowedOrigins)) {
            ws.close(1008, 'forbidden origin');
            return;
          }
          if (
            this.#clients.size >= this.#maxClients ||
            (this.#perIp.get(ip) ?? 0) >= this.#maxPerIp
          ) {
            ws.close(1013, 'too many connections');
            return;
          }
          this.#clients.set(ws, {
            clientId,
            name: identity.user.name,
            userId: identity.user.id,
            sessionHash: identity.sessionHash,
            role: identity.user.role,
            ip,
            messages: 0,
            reset: 0,
          });
          this.#perIp.set(ip, (this.#perIp.get(ip) ?? 0) + 1);
        },
        onMessage: (event: MessageEvent, ws: WSContext<unknown>) => {
          this.#handle(ws, event.data);
        },
        onClose: (_event: CloseEvent, ws: WSContext<unknown>) => {
          this.#drop(ws);
        },
        onError: (_event: Event, ws: WSContext<unknown>) => {
          this.#drop(ws);
        },
      };
    });
  }

  #drop(ws: WSContext<unknown>): void {
    const meta = this.#clients.get(ws);
    if (!meta) return;
    this.#clients.delete(ws);
    const remaining = (this.#perIp.get(meta.ip) ?? 1) - 1;
    if (remaining <= 0) this.#perIp.delete(meta.ip);
    else this.#perIp.set(meta.ip, remaining);
  }

  #handle(ws: WSContext<unknown>, raw: unknown): void {
    const meta = this.#clients.get(ws);
    if (!meta) return;

    const now = Date.now();
    if (now >= meta.reset) {
      meta.reset = now + this.#messageWindowMs;
      meta.messages = 0;
    }
    meta.messages++;
    if (meta.messages > this.#messageBurst) {
      this.#drop(ws);
      ws.close(1008, 'rate limited');
      return;
    }

    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(String(raw)) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      message = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    if (message.type === 'ping') {
      const t = typeof message.t === 'number' ? message.t : Date.now();
      ws.send(JSON.stringify({ type: 'pong', t }));
      return;
    }

    if (message.type === 'typing') {
      const projectId = typeof message.projectId === 'string' ? message.projectId.slice(0, 64) : '';
      if (!projectId) return;
      if (!this.#canAccess(meta.role, meta.userId, projectId)) return;
      const payload: TypingMessage = {
        type: 'typing',
        clientId: meta.clientId,
        name: meta.name,
        projectId,
        active: message.active === true,
      };
      this.#broadcast(payload, ws, projectId);
    }
  }

  #broadcast(payload: TypingMessage, sender: WSContext<unknown>, projectId: string): void {
    const text = JSON.stringify(payload);
    for (const [ws, meta] of this.#clients) {
      if (ws === sender || ws.readyState !== WS_OPEN) continue;
      if (!this.#canAccess(meta.role, meta.userId, projectId)) continue;
      try {
        ws.send(text);
      } catch {
        this.#drop(ws);
      }
    }
  }

  closeAll(): void {
    for (const ws of this.#clients.keys()) {
      try {
        ws.close();
      } catch {
        // socket already closed
      }
    }
    this.#clients.clear();
    this.#perIp.clear();
  }

  closeUser(userId: string): void {
    this.#closeWhere((meta) => meta.userId === userId);
  }

  closeSession(sessionHash: string): void {
    this.#closeWhere((meta) => meta.sessionHash === sessionHash);
  }

  #closeWhere(match: (meta: Meta) => boolean): void {
    for (const [ws, meta] of [...this.#clients]) {
      if (!match(meta)) continue;
      this.#drop(ws);
      try {
        ws.close(1008, 'session revoked');
      } catch {
        // socket already closed
      }
    }
  }
}

export { canAccessProject };
