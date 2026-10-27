import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  ActivityItem,
  PresenceClient,
  ProjectDetail,
  SnapshotPayload,
} from '../shared/types.ts';
import { publishActivity } from '../src/realtime.ts';
import { EventHub } from '../src/sse.ts';
import {
  DEMO,
  login,
  nextEvent,
  sendJson,
  sseEvents,
  startServer,
  testApp,
  testStore,
  waitFor,
} from './helpers.ts';

type Sent = { event: string; data: string; seq?: number };

test('authenticated snapshots are scoped to the viewer', async () => {
  const store = testStore();
  const { app, hub } = testApp(store);
  const { base, close } = await startServer(app);
  const admin = await login(app, DEMO.admin.email);
  const viewer = await login(app, DEMO.viewer.email);
  const first = new AbortController();
  const second = new AbortController();

  try {
    const res = await fetch(`${base}/api/events`, {
      headers: { cookie: admin },
      signal: first.signal,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-cache, no-transform');
    assert.equal(res.headers.get('x-accel-buffering'), 'no');
    assert.ok(res.body);
    const events = sseEvents(res.body);
    const snapshot = await nextEvent(events, 'snapshot');
    const adminPayload = JSON.parse(snapshot.data) as SnapshotPayload;

    assert.equal(adminPayload.user.id, DEMO.admin.id);
    assert.equal(adminPayload.user.role, 'admin');
    assert.equal(adminPayload.projects.length, 8);
    assert.equal(adminPayload.counts.all, 8);
    assert.ok(adminPayload.activities.length > 0);
    assert.equal(adminPayload.clients.length, 1);
    assert.equal(adminPayload.clients[0]?.name, DEMO.admin.name);
    assert.ok(adminPayload.runtime.sqlite);
    await waitFor(() => hub.size === 1);

    const viewerRes = await fetch(`${base}/api/events`, {
      headers: { cookie: viewer },
      signal: second.signal,
    });
    assert.equal(viewerRes.status, 200);
    const viewerEvents = sseEvents(viewerRes.body!);
    const viewerPayload = JSON.parse(
      (await nextEvent(viewerEvents, 'snapshot')).data,
    ) as SnapshotPayload;
    assert.equal(viewerPayload.user.role, 'viewer');
    assert.equal(viewerPayload.projects.length, 5);
    assert.equal(viewerPayload.counts.all, 5);
    for (const activity of viewerPayload.activities) {
      if (!activity.project) continue;
      assert.ok(
        viewerPayload.projects.some((project) => project.id === activity.project?.id),
        'snapshot activities stay inside the visible project set',
      );
    }

    await waitFor(() => hub.size === 2);
    await sendJson(app, admin, 'POST', '/api/projects', { name: '实时广播' });
    const live = await nextEvent(events, 'activity');
    assert.match(live.id ?? '', /^\d+$/);
    const parsed = JSON.parse(live.data) as { activity: ActivityItem };
    assert.equal(parsed.activity.type, 'project.created');
    assert.equal(Number(live.id), parsed.activity.seq);
  } finally {
    first.abort();
    second.abort();
    hub.closeAll();
    await close();
    store.close();
  }
});

test('live activity broadcasts respect project visibility', () => {
  const store = testStore();
  try {
    const hub = new EventHub();
    const inbox: Record<'admin' | 'viewer', Sent[]> = { admin: [], viewer: [] };
    for (const [key, demo] of [
      ['admin', DEMO.admin],
      ['viewer', DEMO.viewer],
    ] as const) {
      hub.add({
        id: key,
        name: demo.name,
        since: new Date().toISOString(),
        userId: demo.id,
        role: demo.role,
        send: (event, data, seq) => inbox[key].push({ event, data, seq }),
        close: () => {},
      });
    }

    const activitiesFor = (key: 'admin' | 'viewer'): Sent[] =>
      inbox[key].filter((entry) => entry.event === 'activity');

    const secret = store.projects.create(
      { name: '仅管理员可见', ownerId: DEMO.admin.id },
      { id: DEMO.admin.id, name: DEMO.admin.name },
    );
    publishActivity(hub, store, store.activities.latest()!);
    assert.equal(activitiesFor('admin').length, 1);
    assert.equal(
      activitiesFor('viewer').length,
      0,
      'viewers never receive hidden project activities',
    );

    const shared = store.projects.create(
      { name: '共享项目', ownerId: DEMO.viewer.id },
      { id: DEMO.viewer.id, name: DEMO.viewer.name },
    );
    publishActivity(hub, store, store.activities.latest()!);

    assert.equal(activitiesFor('admin').length, 2);
    assert.equal(activitiesFor('viewer').length, 1);
    const delivered = JSON.parse(activitiesFor('viewer')[0]!.data) as { activity: ActivityItem };
    assert.equal(delivered.activity.project?.id, shared.id);
    assert.equal(activitiesFor('viewer')[0]!.seq, delivered.activity.seq);
    assert.notEqual(delivered.activity.project?.id, secret.id);
  } finally {
    store.close();
  }
});

test('presence snapshots track connected clients', async () => {
  const store = testStore();
  const { app, hub } = testApp(store);
  const { base, close } = await startServer(app);
  const cookie = await login(app, DEMO.admin.email);
  const controller = new AbortController();
  const other = new AbortController();

  try {
    const res = await fetch(`${base}/api/events`, {
      headers: { cookie },
      signal: controller.signal,
    });
    const events = sseEvents(res.body!);
    await nextEvent(events, 'snapshot');
    await waitFor(() => hub.size === 1);

    const second = await fetch(`${base}/api/events`, {
      headers: { cookie },
      signal: other.signal,
    });
    const secondEvents = sseEvents(second.body!);
    const snapshot = JSON.parse(
      (await nextEvent(secondEvents, 'snapshot')).data,
    ) as SnapshotPayload;
    assert.equal(snapshot.clients.length, 2, 'both connections are listed');
  } finally {
    controller.abort();
    other.abort();
    hub.closeAll();
    await close();
    store.close();
  }
});

test('project creation broadcasts an SSE id to connected clients', async () => {
  const store = testStore({ demo: false });
  const { app, hub } = testApp(store);
  const { base, close } = await startServer(app);
  const cookie = await login(app, DEMO.admin.email);
  const controller = new AbortController();

  try {
    const res = await fetch(`${base}/api/events`, {
      headers: { cookie },
      signal: controller.signal,
    });
    const events = sseEvents(res.body!);
    const snapshot = JSON.parse((await nextEvent(events, 'snapshot')).data) as SnapshotPayload;
    assert.equal(snapshot.cursor, 0);
    await waitFor(() => hub.size === 1);

    const created = await sendJson<ProjectDetail>(app, cookie, 'POST', '/api/projects', {
      name: '新项目',
    });
    assert.equal(created.status, 201);

    const live = await nextEvent(events, 'activity');
    assert.equal(live.id, '1');
    const payload = JSON.parse(live.data) as { activity: ActivityItem };
    assert.equal(payload.activity.project?.id, created.body.id);
  } finally {
    controller.abort();
    hub.closeAll();
    await close();
    store.close();
  }
});

test('role changes and disabling drop existing live streams', async () => {
  const store = testStore();
  const { app, hub } = testApp(store);
  const { base, close } = await startServer(app);
  const admin = await login(app, DEMO.admin.email);
  const viewer = await login(app, DEMO.viewer.email);
  const controller = new AbortController();

  try {
    const res = await fetch(`${base}/api/events`, {
      headers: { cookie: viewer },
      signal: controller.signal,
    });
    const events = sseEvents(res.body!);
    await nextEvent(events, 'snapshot');
    await waitFor(() => hub.size === 1);

    const disabled = await sendJson(app, admin, 'PATCH', `/api/users/${DEMO.viewer.id}`, {
      status: 'disabled',
    });
    assert.equal(disabled.status, 200);
    await waitFor(() => hub.size === 0);

    const retry = await fetch(`${base}/api/events`, { headers: { cookie: viewer } });
    assert.equal(retry.status, 401, 'the revoked session cannot reconnect');
    await retry.arrayBuffer();
  } finally {
    controller.abort();
    hub.closeAll();
    await close();
    store.close();
  }
});

test('logout closes only the streams bound to that session', async () => {
  const store = testStore();
  const { app, hub } = testApp(store);
  const { base, close } = await startServer(app);
  const first = await login(app, DEMO.admin.email);
  const second = await login(app, DEMO.admin.email);
  const firstController = new AbortController();
  const secondController = new AbortController();

  try {
    const firstRes = await fetch(`${base}/api/events`, {
      headers: { cookie: first },
      signal: firstController.signal,
    });
    await nextEvent(sseEvents(firstRes.body!), 'snapshot');
    const secondRes = await fetch(`${base}/api/events`, {
      headers: { cookie: second },
      signal: secondController.signal,
    });
    await nextEvent(sseEvents(secondRes.body!), 'snapshot');
    await waitFor(() => hub.size === 2);

    const logout = await sendJson(app, first, 'POST', '/api/auth/logout', {});
    assert.equal(logout.status, 204);
    await waitFor(() => hub.size === 1, 3_000);
    assert.equal(
      (await app.request('/api/auth/me', { headers: { cookie: second } })).status,
      200,
      'the other session keeps working',
    );
  } finally {
    firstController.abort();
    secondController.abort();
    hub.closeAll();
    await close();
    store.close();
  }
});

test('SSE handshakes are rate limited per IP', async () => {
  const store = testStore();
  const { app } = testApp(store, { maxSseHandshakes: 2 });
  const { base, close } = await startServer(app);
  const cookie = await login(app, DEMO.admin.email);
  const controllers: AbortController[] = [];

  try {
    for (let index = 0; index < 2; index++) {
      const controller = new AbortController();
      controllers.push(controller);
      const res = await fetch(`${base}/api/events`, {
        headers: { cookie },
        signal: controller.signal,
      });
      assert.equal(res.status, 200);
      await res.body?.cancel();
    }

    const limited = await fetch(`${base}/api/events`, { headers: { cookie } });
    assert.equal(limited.status, 429);
    assert.equal(((await limited.json()) as { error: string }).error, 'rate_limited');
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  } finally {
    for (const controller of controllers) controller.abort();
    await close();
    store.close();
  }
});

test('presence updates are coalesced into join/leave deltas', async () => {
  const hub = new EventHub();
  const inbox: Sent[] = [];
  const client = (id: string) => ({
    id,
    name: `用户${id}`,
    since: new Date().toISOString(),
    userId: `user-${id}`,
    role: 'admin' as const,
    send: (event: string, data: string) => inbox.push({ event, data }),
    close: () => {},
  });
  const presence = (): Sent[] => inbox.filter((entry) => entry.event === 'presence');

  hub.add(client('a'));
  hub.add(client('b'));
  assert.equal(presence().length, 0, 'a burst of joins waits for the throttle window');

  await delay(1_200);
  assert.equal(presence().length, 2, 'one delta per connected recipient');
  const joined = JSON.parse(presence()[0]!.data) as { joined: PresenceClient[]; left: string[] };
  assert.deepEqual(joined.joined.map((entry) => entry.id).sort(), ['a', 'b']);
  assert.deepEqual(joined.left, []);
  assert.equal(presence()[1]!.data, presence()[0]!.data);
  for (const entry of joined.joined) {
    assert.deepEqual(Object.keys(entry).sort(), ['id', 'name', 'since']);
  }

  hub.remove('a');
  await delay(1_200);
  assert.equal(presence().length, 3);
  const left = JSON.parse(presence()[2]!.data) as { joined: PresenceClient[]; left: string[] };
  assert.deepEqual(left, { joined: [], left: ['a'] });
  assert.equal(hub.size, 1);
});
