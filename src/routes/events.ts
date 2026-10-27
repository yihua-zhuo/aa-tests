import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { SnapshotPayload } from '../../shared/types.ts';
import type { AppEnv } from '../app-env.ts';
import { noStore } from '../http.ts';
import { currentUser } from '../middleware/auth.ts';
import { contextIp } from '../net.ts';
import { canSeeActivity } from '../realtime.ts';
import { runtimeInfo } from '../runtime.ts';
import type { EventHub, HubClient } from '../sse.ts';
import type { Store } from '../store.ts';

const PENDING_LIMIT = 32;
const HANDSHAKE_WINDOW_MS = 60_000;
const MAX_HANDSHAKE_KEYS = 5_000;
const REPLAY_LIMIT = 200;

type EventOptions = {
  trustProxy: boolean;
  maxClients: number;
  maxPerIp: number;
  handshakeMax?: number;
};

function parseLastEventId(header: string | undefined, query: string | undefined): number | null {
  const raw = header ?? query;
  if (!raw) return null;
  const id = Number(raw);
  return Number.isInteger(id) && id >= 0 ? id : null;
}

function delayUntilAbort(ms: number, aborted: Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void aborted.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export function eventsRoutes(store: Store, hub: EventHub, options: EventOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const perIp = new Map<string, number>();
  const handshakes = new Map<string, { count: number; reset: number }>();
  const handshakeMax = options.handshakeMax ?? 30;

  app.get('/api/events', (c) => {
    const user = currentUser(c);
    const lastEventId = parseLastEventId(c.req.header('last-event-id'), c.req.query('lastEventId'));
    const ip = contextIp(c, options.trustProxy);
    const now = Date.now();

    if (handshakeMax > 0) {
      if (handshakes.size >= MAX_HANDSHAKE_KEYS) {
        for (const [key, bucket] of handshakes) {
          if (bucket.reset <= now) handshakes.delete(key);
        }
        while (handshakes.size >= MAX_HANDSHAKE_KEYS) {
          const oldest = handshakes.keys().next().value;
          if (oldest === undefined) break;
          handshakes.delete(oldest);
        }
      }
      let bucket = handshakes.get(ip);
      if (!bucket || bucket.reset <= now) {
        bucket = { count: 0, reset: now + HANDSHAKE_WINDOW_MS };
        handshakes.delete(ip);
        handshakes.set(ip, bucket);
      }
      bucket.count++;
      if (bucket.count > handshakeMax) {
        c.header('Retry-After', String(Math.max(1, Math.ceil((bucket.reset - now) / 1000))));
        noStore(c);
        return c.json({ error: 'rate_limited', message: '实时连接请求过于频繁' }, 429);
      }
    }

    const active = perIp.get(ip) ?? 0;

    if (hub.size >= options.maxClients || active >= options.maxPerIp) {
      c.header('Retry-After', '5');
      noStore(c);
      return c.json({ error: 'too_many_connections', message: '实时连接数已达上限' }, 429);
    }
    perIp.set(ip, active + 1);

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      const remaining = (perIp.get(ip) ?? 1) - 1;
      if (remaining <= 0) perIp.delete(ip);
      else perIp.set(ip, remaining);
    };

    const response = streamSSE(c, async (stream) => {
      const id = crypto.randomUUID();
      const since = new Date().toISOString();
      let closed = false;
      let pending = 0;

      const finish = (): void => {
        if (closed) return;
        closed = true;
        hub.remove(id);
        release();
      };

      const client: HubClient = {
        id,
        name: user.name,
        since,
        userId: user.id,
        sessionHash: c.get('sessionHash'),
        role: user.role,
        send: (event, json, seq) => {
          if (closed) return;
          if (pending >= PENDING_LIMIT) {
            finish();
            return;
          }
          pending++;
          const payload =
            seq === undefined ? { event, data: json } : { event, data: json, id: String(seq) };
          stream.writeSSE(payload).then(
            () => {
              pending--;
            },
            () => {
              pending--;
              finish();
            },
          );
        },
        close: () => {
          try {
            stream.abort();
          } catch {
            // already closed
          }
        },
      };

      try {
        const snapshot = (cursor: number): SnapshotPayload => {
          const listed = store.projects.list(user.role, user.id, {
            status: 'all',
            owner: 'all',
            sort: 'updated',
            page: 1,
            pageSize: 200,
          });
          return {
            user,
            projects: listed.projects,
            counts: listed.counts,
            activities: store.activities.recent(user.role, user.id, 20),
            cursor,
            clients: hub.clients,
            runtime: runtimeInfo(store),
          };
        };

        hub.add(client);
        const cursor = store.activities.latestSeq();

        if (lastEventId === null) {
          await stream.writeSSE({ event: 'snapshot', data: JSON.stringify(snapshot(cursor)) });
        } else if (cursor - lastEventId > REPLAY_LIMIT) {
          // The gap is too large to replay; hand over a full snapshot explicitly.
          await stream.writeSSE({
            event: 'resync',
            data: JSON.stringify(snapshot(cursor)),
          });
        } else {
          await stream.writeSSE({
            event: 'resume',
            data: JSON.stringify({
              cursor,
              clients: hub.clients,
              runtime: runtimeInfo(store),
            }),
          });
          const missed = store.activities.since(lastEventId, REPLAY_LIMIT);
          for (const activity of missed) {
            if (!canSeeActivity(store, activity, user.role, user.id)) continue;
            await stream
              .writeSSE({
                event: 'activity',
                data: JSON.stringify({ activity }),
                id: String(activity.seq),
              })
              .catch(() => finish());
            if (closed) break;
          }
        }

        const aborted = new Promise<void>((resolve) =>
          stream.onAbort(() => {
            finish();
            resolve();
          }),
        );
        while (!stream.aborted && !closed) {
          await delayUntilAbort(15_000, aborted);
          if (stream.aborted || closed) break;
          await stream
            .writeSSE({ event: 'heartbeat', data: String(Date.now()) })
            .catch(() => finish());
        }
      } finally {
        finish();
      }
    });

    response.headers.set('Cache-Control', 'no-cache, no-transform');
    response.headers.set('X-Accel-Buffering', 'no');
    return response;
  });

  return app;
}
