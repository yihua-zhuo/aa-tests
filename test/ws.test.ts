import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { test } from 'node:test';
import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import { type WebSocketServer, WebSocket as WsClient } from 'ws';
import { canAccessProject } from '../shared/permissions.ts';
import type { Project } from '../shared/types.ts';
import type { AppOptions } from '../src/app.ts';
import type { AppEnv } from '../src/app-env.ts';
import { createWebSocketServer, WsHub } from '../src/ws.ts';
import { DEMO, login, sendJson, testApp, testStore } from './helpers.ts';

type CloseInfo = { code: number; reason: string };

type WsTarget = {
  app: Hono<AppEnv>;
  store: ReturnType<typeof testStore>;
  hub: WsHub;
  wss: WebSocketServer;
  server: Server;
  base: string;
};

async function startWs(
  options: ConstructorParameters<typeof WsHub>[0] = {},
  maxPayload?: number,
  appOptions: AppOptions = {},
): Promise<WsTarget> {
  const store = testStore();
  const hub = new WsHub({
    canAccess: (role, userId, projectId) => {
      const access = store.projects.access(projectId);
      return Boolean(access && canAccessProject(role, userId, access));
    },
    ...options,
  });
  const wss = createWebSocketServer(maxPayload);
  const { app } = testApp(store, { ...appOptions, wsHub: hub });
  const server = serve({
    fetch: app.fetch,
    port: 0,
    hostname: '127.0.0.1',
    websocket: { server: wss },
  }) as unknown as Server;
  if (!server.listening) {
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  }
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { app, store, hub, wss, server, base: `ws://127.0.0.1:${address.port}` };
}

async function stopWs(target: WsTarget): Promise<void> {
  target.hub.closeAll();
  target.wss.close();
  await new Promise<void>((resolve) => target.server.close(() => resolve()));
  target.store.close();
}

function connect(base: string, cookie: string, name: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(`${base}/ws?name=${encodeURIComponent(name)}`, {
      headers: { cookie },
    });
    const timer = setTimeout(() => reject(new Error('websocket open timed out')), 5_000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function rawConnect(
  url: string,
  cookie: string | undefined,
  origin?: string,
  headers: Record<string, string> = {},
): Promise<{ ws: WsClient; closed: Promise<CloseInfo> }> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(url, {
      ...(origin ? { origin } : {}),
      headers: { ...(cookie ? { cookie } : {}), ...headers },
    });
    let resolveClosed!: (info: CloseInfo) => void;
    const closed = new Promise<CloseInfo>((done) => {
      resolveClosed = done;
    });
    ws.once('close', (code, reason) => resolveClosed({ code, reason: String(reason) }));
    const timer = setTimeout(() => reject(new Error('websocket open timed out')), 5_000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve({ ws, closed });
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

type WsMessage = Record<string, unknown>;

function nextOfType(ws: WsClient, type: string, timeoutMs = 5_000): Promise<WsMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`timed out waiting for ${type}`));
    }, timeoutMs);
    const handler = (raw: unknown) => {
      const message = JSON.parse(String(raw)) as WsMessage;
      if (message.type !== type) return;
      clearTimeout(timer);
      ws.off('message', handler);
      resolve(message);
    };
    ws.on('message', handler);
  });
}

function expectNoType(ws: WsClient, type: string, timeoutMs = 300): Promise<void> {
  return new Promise((resolve, reject) => {
    const handler = (raw: unknown) => {
      const message = JSON.parse(String(raw)) as WsMessage;
      if (message.type === type) {
        clearTimeout(timer);
        ws.off('message', handler);
        reject(new Error(`unexpected ${type} message`));
      }
    };
    const timer = setTimeout(() => {
      ws.off('message', handler);
      resolve();
    }, timeoutMs);
    ws.on('message', handler);
  });
}

function visibleProject(store: ReturnType<typeof testStore>): Project {
  const listed = store.projects.list('manager', DEMO.manager.id, {
    status: 'all',
    owner: 'all',
    sort: 'updated',
    page: 1,
    pageSize: 50,
  });
  const project = listed.projects.find((item) => item.name === '官网品牌重塑');
  assert.ok(project);
  return project;
}

function hiddenProject(store: ReturnType<typeof testStore>): Project {
  const listed = store.projects.list('admin', DEMO.admin.id, {
    status: 'all',
    owner: 'all',
    sort: 'updated',
    page: 1,
    pageSize: 50,
  });
  const project = listed.projects.find((item) => item.name === '客户数据中台');
  assert.ok(project);
  return project;
}

test('WebSocket relays typing for visible projects and answers pings', async () => {
  const target = await startWs();
  const manager = await login(target.app, DEMO.manager.email);
  const viewer = await login(target.app, DEMO.viewer.email);
  const alice = await connect(target.base, manager, '陈墨');
  const bob = await connect(target.base, viewer, '顾言');

  try {
    const selfPong = nextOfType(alice, 'pong');
    alice.send(JSON.stringify({ type: 'ping', t: 42 }));
    assert.equal((await selfPong).t, 42);

    const shared = visibleProject(target.store);
    const typing = nextOfType(bob, 'typing');
    alice.send(JSON.stringify({ type: 'typing', projectId: shared.id, active: true }));
    const indicator = await typing;
    assert.equal(indicator.name, '陈墨');
    assert.equal(indicator.projectId, shared.id);
    assert.equal(indicator.active, true);
    assert.ok(typeof indicator.clientId === 'string');

    const cleared = nextOfType(bob, 'typing');
    alice.send(JSON.stringify({ type: 'typing', projectId: shared.id, active: false }));
    assert.equal((await cleared).active, false);

    const hidden = hiddenProject(target.store);
    await expectNoType(bob, 'typing');
    const leaked: WsMessage[] = [];
    const capture = (raw: unknown) => {
      const message = JSON.parse(String(raw)) as WsMessage;
      if (message.type === 'typing' && message.projectId === hidden.id) leaked.push(message);
    };
    bob.on('message', capture);
    try {
      alice.send(JSON.stringify({ type: 'typing', projectId: hidden.id, active: true }));
      await new Promise((resolve) => setTimeout(resolve, 150));
    } finally {
      bob.off('message', capture);
    }
    assert.equal(leaked.length, 0, 'typing for an invisible project must not be relayed');
  } finally {
    alice.close();
    bob.close();
    await stopWs(target);
  }
});

test('unauthenticated WebSocket upgrades are rejected', async () => {
  const target = await startWs();
  try {
    await assert.rejects(
      rawConnect(`${target.base}/ws?name=anon`, undefined),
      /401/,
      'the auth middleware refuses the upgrade before it opens',
    );
  } finally {
    await stopWs(target);
  }
});

test('cross-origin WebSocket handshakes are rejected', async () => {
  const target = await startWs({ allowedOrigins: ['http://trusted.example'] }, undefined, {
    allowedOrigins: ['http://trusted.example'],
  });
  const cookie = await login(target.app, DEMO.manager.email);
  try {
    const evil = await rawConnect(`${target.base}/ws?name=evil`, cookie, 'http://evil.example');
    const evilClose = await evil.closed;
    assert.equal(evilClose.code, 1008);
    assert.match(evilClose.reason, /forbidden origin/);

    const trusted = await rawConnect(`${target.base}/ws?name=ok`, cookie, 'http://trusted.example');
    assert.equal(trusted.ws.readyState, WsClient.OPEN);
    trusted.ws.close();
    await trusted.closed;
  } finally {
    await stopWs(target);
  }
});

test('WebSocket handshakes reject untrusted Host names', async () => {
  const target = await startWs({ allowedHosts: ['bridge.local'] }, undefined, {
    allowedHosts: ['bridge.local'],
  });
  const cookie = await login(target.app, DEMO.manager.email);
  try {
    await assert.rejects(
      rawConnect(`${target.base}/ws?name=evil`, cookie, undefined, { host: 'evil.example' }),
      /403/,
      'the HTTP host guard rejects the upgrade before it opens',
    );

    const allowed = await rawConnect(`${target.base}/ws?name=ok`, cookie, undefined, {
      host: 'bridge.local',
    });
    assert.equal(allowed.ws.readyState, WsClient.OPEN);
    allowed.ws.close();
    await allowed.closed;
  } finally {
    await stopWs(target);
  }
});

test('oversized frames are closed with 1009', async () => {
  const target = await startWs({}, 1_024);
  const cookie = await login(target.app, DEMO.manager.email);
  try {
    const { ws, closed } = await rawConnect(`${target.base}/ws?name=large`, cookie);
    ws.send('x'.repeat(4 * 1024));
    const info = await closed;
    assert.equal(info.code, 1009);
  } finally {
    await stopWs(target);
  }
});

test('message bursts are rate limited', async () => {
  const target = await startWs({ messageBurst: 3 });
  const cookie = await login(target.app, DEMO.manager.email);
  try {
    const { ws, closed } = await rawConnect(`${target.base}/ws?name=spam`, cookie);
    for (let index = 0; index < 6; index++) {
      try {
        ws.send(JSON.stringify({ type: 'ping', t: index }));
      } catch {
        break;
      }
    }
    const info = await closed;
    assert.equal(info.code, 1008);
    assert.match(info.reason, /rate limited/);
  } finally {
    await stopWs(target);
  }
});

test('per-IP WebSocket connection caps are enforced', async () => {
  const target = await startWs({ maxPerIp: 2 });
  const cookie = await login(target.app, DEMO.manager.email);
  try {
    const first = await rawConnect(`${target.base}/ws?name=one`, cookie);
    const second = await rawConnect(`${target.base}/ws?name=two`, cookie);
    const third = await rawConnect(`${target.base}/ws?name=three`, cookie);
    const info = await third.closed;
    assert.equal(info.code, 1013);
    assert.match(info.reason, /too many connections/);

    first.ws.close();
    second.ws.close();
    await Promise.all([first.closed, second.closed]);
  } finally {
    await stopWs(target);
  }
});

test('role changes and disabling close every WebSocket for the user', async () => {
  const target = await startWs();
  const admin = await login(target.app, DEMO.admin.email);
  const viewer = await login(target.app, DEMO.viewer.email);
  try {
    const first = await rawConnect(`${target.base}/ws?name=one`, viewer);
    const second = await rawConnect(`${target.base}/ws?name=two`, viewer);
    assert.equal(target.hub.size, 2);

    const res = await sendJson(target.app, admin, 'PATCH', `/api/users/${DEMO.viewer.id}`, {
      role: 'pm',
    });
    assert.equal(res.status, 200);

    const [one, two] = await Promise.all([first.closed, second.closed]);
    assert.equal(one.code, 1008);
    assert.match(one.reason, /session revoked/);
    assert.equal(two.code, 1008);
    assert.equal(target.hub.size, 0);
  } finally {
    await stopWs(target);
  }
});

test('logout closes only the WebSocket opened with that session', async () => {
  const target = await startWs();
  const firstCookie = await login(target.app, DEMO.admin.email);
  const secondCookie = await login(target.app, DEMO.admin.email);
  try {
    const first = await rawConnect(`${target.base}/ws?name=first`, firstCookie);
    const second = await rawConnect(`${target.base}/ws?name=second`, secondCookie);

    const res = await sendJson(target.app, firstCookie, 'POST', '/api/auth/logout', {});
    assert.equal(res.status, 204);

    const closed = await first.closed;
    assert.equal(closed.code, 1008);
    assert.match(closed.reason, /session revoked/);
    assert.equal(second.ws.readyState, WsClient.OPEN);
    assert.equal(target.hub.size, 1);

    second.ws.close();
    await second.closed;
  } finally {
    await stopWs(target);
  }
});
