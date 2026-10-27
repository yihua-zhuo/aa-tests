import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import type { Role } from '../shared/types.ts';
import { type AppOptions, createApp } from '../src/app.ts';
import type { AppEnv } from '../src/app-env.ts';
import { DEMO_PASSWORD, DEMO_USERS } from '../src/seed.ts';
import { EventHub } from '../src/sse.ts';
import { Store } from '../src/store.ts';

process.env.LOG_LEVEL = 'silent';

export const TEST_NOW = new Date('2026-06-15T12:00:00.000Z');

export const DEMO = DEMO_USERS.reduce(
  (map, user) => {
    map[user.role] = user;
    return map;
  },
  {} as Record<Role, (typeof DEMO_USERS)[number]>,
);

export const PASSWORD = DEMO_PASSWORD;

export function testStore(options: { demo?: boolean; now?: Date } = {}): Store {
  return new Store(':memory:', { demo: true, demoAccounts: true, now: TEST_NOW, ...options });
}

export function testApp(
  store: Store,
  options: AppOptions = {},
): { app: Hono<AppEnv>; hub: EventHub } {
  const hub = new EventHub();
  return { app: createApp(store, hub, options), hub };
}

export type SseEvent = { event: string; id?: string; data: string };

function cookieHeader(res: Response): string {
  const header = res.headers.get('set-cookie');
  assert.ok(header, 'login response should set a cookie');
  const match = /np_session=([^;]+)/.exec(header);
  assert.ok(match, 'login response should contain the session cookie');
  return `np_session=${match[1]}`;
}

export async function login(
  app: Hono<AppEnv>,
  email: string = DEMO.admin.email,
  password: string = PASSWORD,
): Promise<string> {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, `login failed for ${email}`);
  return cookieHeader(res);
}

/** Like login(), but also returns the raw token so tests can expire or inspect sessions. */
export async function loginWithToken(
  app: Hono<AppEnv>,
  email: string = DEMO.admin.email,
  password: string = PASSWORD,
): Promise<{ cookie: string; token: string }> {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, `login failed for ${email}`);
  const cookie = cookieHeader(res);
  return { cookie, token: cookie.slice('np_session='.length) };
}

export function authHeaders(
  cookie: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { cookie, ...extra };
}

export async function getJson<T>(
  app: Hono<AppEnv>,
  cookie: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<T> {
  const res = await app.request(path, { headers: authHeaders(cookie, headers) });
  assert.equal(res.status, 200, `GET ${path} should succeed, got ${res.status}`);
  return (await res.json()) as T;
}

export async function sendJson<T = Record<string, unknown>>(
  app: Hono<AppEnv>,
  cookie: string,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T; res: Response }> {
  const res = await app.request(path, {
    method,
    headers: authHeaders(cookie, { 'content-type': 'application/json', ...headers }),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as T) : (null as T);
  return { status: res.status, body: parsed, res };
}

export function multipart(file: File): FormData {
  const form = new FormData();
  form.set('file', file);
  return form;
}

export async function startServer(
  app: Hono<AppEnv>,
): Promise<{ server: Server; base: string; close: () => Promise<void> }> {
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }) as unknown as Server;
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    server,
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        let event = 'message';
        let id: string | undefined;
        const data: string[] = [];
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('id:')) id = line.slice(3).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (data.length > 0) yield { event, id, data: data.join('\n') };

        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function nextEvent(
  events: AsyncGenerator<SseEvent>,
  eventName: string,
  timeoutMs = 5_000,
): Promise<SseEvent> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${eventName}`)), timeoutMs);
  });
  try {
    for (;;) {
      const result = await Promise.race([events.next(), timeout]);
      if (result.done) throw new Error(`stream ended before ${eventName}`);
      if (result.value.event === eventName) return result.value;
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
