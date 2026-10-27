import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActivityItem, Role, WebhookEvent } from '../shared/types.ts';
import { hashPasswordSync } from '../src/auth.ts';
import type { Store } from '../src/store.ts';
import { WebhookWorker, webhookSignature } from '../src/webhook-worker.ts';
import { DEMO, testStore } from './helpers.ts';

const NOW = new Date('2026-06-15T12:00:00.000Z');
const PROJECT = { id: '00000000-0000-4000-8000-000000000000', name: '测试项目' };

function activity(
  type: WebhookEvent,
  project: { id: string; name: string } | null = PROJECT,
  createdAt = NOW.toISOString(),
): ActivityItem {
  return { seq: 1, type, actor: null, project, message: '测试活动', createdAt, meta: null };
}

function projectId(store: Store): string {
  const row = store.db
    .stmt('SELECT id, name FROM projects ORDER BY created_at ASC LIMIT 1')
    .get() as { id: string; name: string } | undefined;
  assert.ok(row, 'seed data should contain a project');
  return row.id;
}

function makeWebhook(
  store: Store,
  userId: string,
  events: WebhookEvent[],
): { id: string; secret: string } {
  const created = store.webhooks.create(
    userId,
    { url: 'https://hooks.example.com/clay', events },
    NOW,
  );
  return { id: created.webhook.id, secret: created.secret };
}

function addUser(store: Store, role: Role): string {
  const created = store.users.create({
    email: `webhook-${role}-${crypto.randomUUID()}@example.com`,
    name: '集成测试成员',
    role,
    passwordHash: hashPasswordSync('Demo1234!'),
  });
  assert.ok(created.ok);
  return created.user.id;
}

test('webhook enqueue filters events, inactive hooks and project visibility', () => {
  const store = testStore();
  try {
    const project = { id: projectId(store), name: '种子项目' };
    const admin = makeWebhook(store, DEMO.admin.id, ['project.created', 'task.created']);
    const outsiderId = addUser(store, 'pm');
    const outsider = makeWebhook(store, outsiderId, ['project.created']);

    const access = store.projects.access(project.id);
    assert.ok(access);
    assert.equal(
      store.webhooks.enqueue(activity('project.created', project), NOW),
      1,
      'only the admin hook should match a project they can see',
    );

    const adminDeliveries = store.webhooks.deliveries(DEMO.admin.id, admin.id);
    assert.ok(adminDeliveries);
    assert.equal(adminDeliveries.length, 1);
    assert.equal(adminDeliveries[0]?.event, 'project.created');
    assert.equal(adminDeliveries[0]?.status, 'pending');
    assert.equal(store.webhooks.deliveries(outsiderId, outsider.id)?.length, 0);

    assert.equal(
      store.webhooks.enqueue(activity('comment.created', project), NOW),
      0,
      'events that are not subscribed are ignored',
    );
    assert.equal(
      store.webhooks.enqueue(activity('project.created', null), NOW),
      0,
      'activities without a project are ignored',
    );

    store.webhooks.update(DEMO.admin.id, admin.id, { active: false });
    assert.equal(store.webhooks.enqueue(activity('project.created', project), NOW), 0);

    store.webhooks.update(DEMO.admin.id, admin.id, { active: true });
    assert.equal(store.webhooks.enqueue(activity('task.created', project), NOW), 1);
  } finally {
    store.close();
  }
});

test('webhook worker signs and delivers payloads once', async () => {
  const store = testStore();
  try {
    const project = { id: projectId(store), name: '种子项目' };
    const hook = makeWebhook(store, DEMO.admin.id, ['project.created']);
    assert.equal(store.webhooks.enqueue(activity('project.created', project), NOW), 1);

    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const worker = new WebhookWorker(store, { fetchImpl, now: () => NOW });
    assert.deepEqual(await worker.runOnce(), { sent: 1, retried: 0, failed: 0 });

    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call);
    assert.equal(call.url, 'https://hooks.example.com/clay');
    assert.equal(call.init.method, 'POST');
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers['x-clay-event'], 'project.created');
    assert.equal(headers['x-clay-timestamp'], String(Math.floor(NOW.getTime() / 1000)));
    assert.equal(headers['user-agent'], 'Clay-Webhooks/1.0');
    const body = call.init.body as string;
    const expected = webhookSignature(hook.secret, Math.floor(NOW.getTime() / 1000), body);
    assert.equal(headers['x-clay-signature'], `sha256=${expected}`);

    const payload = JSON.parse(body) as {
      id: string;
      event: string;
      activity: { project: { id: string }; message: string };
    };
    assert.equal(payload.event, 'project.created');
    assert.equal(payload.activity.project.id, project.id);
    assert.equal(payload.activity.message, '测试活动');
    assert.equal(headers['x-clay-delivery'], payload.id);

    const deliveries = store.webhooks.deliveries(DEMO.admin.id, hook.id);
    assert.ok(deliveries);
    assert.equal(deliveries[0]?.status, 'sent');
    assert.equal(deliveries[0]?.attempts, 1);
    assert.equal(deliveries[0]?.responseStatus, 200);

    assert.deepEqual(await worker.runOnce(), { sent: 0, retried: 0, failed: 0 });
    assert.equal(calls.length, 1);
  } finally {
    store.close();
  }
});

test('webhook worker retries with backoff and gives up after max attempts', async () => {
  const store = testStore();
  try {
    const project = { id: projectId(store), name: '种子项目' };
    const hook = makeWebhook(store, DEMO.admin.id, ['project.created']);
    assert.equal(store.webhooks.enqueue(activity('project.created', project), NOW), 1);

    let now = NOW;
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('nope', { status: 500 });
    }) as typeof fetch;
    const worker = new WebhookWorker(store, { fetchImpl, now: () => now, maxAttempts: 2 });

    assert.deepEqual(await worker.runOnce(), { sent: 0, retried: 1, failed: 0 });
    let delivery = store.webhooks.deliveries(DEMO.admin.id, hook.id)?.[0];
    assert.ok(delivery);
    assert.equal(delivery.status, 'pending');
    assert.equal(delivery.attempts, 1);
    assert.equal(delivery.responseStatus, 500);

    assert.deepEqual(await worker.runOnce(), { sent: 0, retried: 0, failed: 0 });

    now = new Date(NOW.getTime() + 31_000);
    assert.deepEqual(await worker.runOnce(), { sent: 0, retried: 0, failed: 1 });
    assert.equal(calls, 2);
    delivery = store.webhooks.deliveries(DEMO.admin.id, hook.id)?.[0];
    assert.ok(delivery);
    assert.equal(delivery.status, 'failed');
    assert.equal(delivery.attempts, 2);
    assert.equal(delivery.responseStatus, 500);

    now = new Date(NOW.getTime() + 3_600_000);
    assert.deepEqual(await worker.runOnce(), { sent: 0, retried: 0, failed: 0 });
    assert.equal(calls, 2);
  } finally {
    store.close();
  }
});

test('deleting a webhook cascades queued deliveries', () => {
  const store = testStore();
  try {
    const project = { id: projectId(store), name: '种子项目' };
    const hook = makeWebhook(store, DEMO.admin.id, ['project.created']);
    assert.equal(store.webhooks.enqueue(activity('project.created', project), NOW), 1);

    const count = () =>
      (
        store.db
          .stmt('SELECT COUNT(*) AS total FROM webhook_deliveries WHERE webhook_id = ?')
          .get(hook.id) as { total: number }
      ).total;
    assert.equal(count(), 1);
    assert.equal(store.webhooks.remove(DEMO.admin.id, hook.id), true);
    assert.equal(count(), 0);
    assert.equal(store.webhooks.deliveries(DEMO.admin.id, hook.id), null);
  } finally {
    store.close();
  }
});
