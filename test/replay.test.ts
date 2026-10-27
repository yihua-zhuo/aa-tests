import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActivityItem, ProjectDetail, SnapshotPayload } from '../shared/types.ts';
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

async function expectNoEvent(
  events: AsyncGenerator<{ event: string; id?: string; data: string }>,
  eventName: string,
  timeoutMs = 300,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const result = await Promise.race([events.next(), timeout]);
    if (result === 'timeout') return;
    assert.notEqual(result.value.event, eventName, `unexpected ${eventName} event`);
  } finally {
    clearTimeout(timer);
  }
}

test('SSE replays only the events missed while disconnected', async () => {
  const store = testStore({ demo: false });
  const { app, hub } = testApp(store);
  const { base, close } = await startServer(app);
  const admin = await login(app, DEMO.admin.email);
  const first = new AbortController();
  const second = new AbortController();

  try {
    const res = await fetch(`${base}/api/events`, {
      headers: { cookie: admin },
      signal: first.signal,
    });
    const events = sseEvents(res.body!);
    const snapshot = JSON.parse((await nextEvent(events, 'snapshot')).data) as SnapshotPayload;
    assert.equal(snapshot.cursor, 0);
    await waitFor(() => hub.size === 1);

    const before = await sendJson<ProjectDetail>(app, admin, 'POST', '/api/projects', {
      name: '断线前的项目',
    });
    assert.equal(before.status, 201);

    const live = await nextEvent(events, 'activity');
    const lastId = live.id;
    assert.equal(lastId, '1');

    first.abort();
    await waitFor(() => hub.size === 0);

    const missed = await sendJson<ProjectDetail>(app, admin, 'POST', '/api/projects', {
      name: '断线期间的项目',
    });
    assert.equal(missed.status, 201);

    const resumed = await fetch(`${base}/api/events`, {
      headers: { cookie: admin, 'last-event-id': lastId! },
      signal: second.signal,
    });
    assert.equal(resumed.status, 200);
    const resumedEvents = sseEvents(resumed.body!);
    const resume = JSON.parse((await nextEvent(resumedEvents, 'resume')).data) as {
      cursor: number;
      clients: { id: string }[];
    };
    assert.equal(resume.cursor, 2);
    assert.equal(resume.clients.length, 1, 'resume carries presence without a full snapshot');

    const replayed = await nextEvent(resumedEvents, 'activity');
    assert.equal(replayed.id, '2');
    assert.ok(Number(replayed.id) > Number(lastId));
    const payload = JSON.parse(replayed.data) as { activity: ActivityItem };
    assert.equal(payload.activity.project?.id, missed.body.id);
    assert.equal(payload.activity.message, '创建了项目「断线期间的项目」');

    await expectNoEvent(resumedEvents, 'activity');
  } finally {
    first.abort();
    second.abort();
    hub.closeAll();
    await close();
    store.close();
  }
});

test('replay filters activities by project visibility', async () => {
  const store = testStore({ demo: false });
  const { app, hub } = testApp(store);
  const { base, close } = await startServer(app);
  const admin = await login(app, DEMO.admin.email);
  const viewer = await login(app, DEMO.viewer.email);
  const controller = new AbortController();

  try {
    const hidden = await sendJson<ProjectDetail>(app, admin, 'POST', '/api/projects', {
      name: '隐藏项目',
      ownerId: DEMO.admin.id,
    });
    assert.equal(hidden.status, 201);
    const visible = await sendJson<ProjectDetail>(app, admin, 'POST', '/api/projects', {
      name: '可见项目',
      ownerId: DEMO.admin.id,
      memberIds: [DEMO.viewer.id],
    });
    assert.equal(visible.status, 201);

    const res = await fetch(`${base}/api/events`, {
      headers: { cookie: viewer, 'last-event-id': '0' },
      signal: controller.signal,
    });
    const events = sseEvents(res.body!);
    const resume = JSON.parse((await nextEvent(events, 'resume')).data) as { cursor: number };
    assert.equal(resume.cursor, 2);

    const replayed = await nextEvent(events, 'activity');
    const payload = JSON.parse(replayed.data) as { activity: ActivityItem };
    assert.equal(payload.activity.project?.id, visible.body.id);
    assert.equal(replayed.id, '2');

    await expectNoEvent(events, 'activity');
  } finally {
    controller.abort();
    hub.closeAll();
    await close();
    store.close();
  }
});

test('an invalid last-event-id does not trigger a replay', async () => {
  const store = testStore({ demo: false });
  const { app, hub } = testApp(store);
  const { base, close } = await startServer(app);
  const admin = await login(app, DEMO.admin.email);
  const controller = new AbortController();

  try {
    await sendJson(app, admin, 'POST', '/api/projects', { name: '已有活动' });

    const res = await fetch(`${base}/api/events?lastEventId=nope`, {
      headers: { cookie: admin },
      signal: controller.signal,
    });
    const events = sseEvents(res.body!);
    const snapshot = JSON.parse((await nextEvent(events, 'snapshot')).data) as SnapshotPayload;
    assert.equal(snapshot.cursor, 1);
    await expectNoEvent(events, 'activity');
  } finally {
    controller.abort();
    hub.closeAll();
    await close();
    store.close();
  }
});

test('a gap larger than the replay window sends an explicit resync', async () => {
  const store = testStore({ demo: false });
  const { app, hub } = testApp(store);
  const { base, close } = await startServer(app);
  const admin = await login(app, DEMO.admin.email);
  const controller = new AbortController();

  try {
    for (let index = 0; index < 205; index++) {
      store.activities.record({
        type: 'project.updated',
        actor: null,
        message: `gap ${index}`,
      });
    }

    const res = await fetch(`${base}/api/events`, {
      headers: { cookie: admin, 'last-event-id': '0' },
      signal: controller.signal,
    });
    const events = sseEvents(res.body!);
    const resync = JSON.parse((await nextEvent(events, 'resync')).data) as SnapshotPayload;
    assert.equal(resync.cursor, 205);
    assert.equal(resync.activities.length, 20);
    await expectNoEvent(events, 'resume');
    await expectNoEvent(events, 'activity');
  } finally {
    controller.abort();
    hub.closeAll();
    await close();
    store.close();
  }
});
