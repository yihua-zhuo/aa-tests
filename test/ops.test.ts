import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import type { Hono } from 'hono';
import type { AppEnv } from '../src/app-env.ts';
import { startBackupScheduler } from '../src/backup.ts';
import { SCHEMA_VERSION } from '../src/db.ts';
import { DEMO_USERS } from '../src/seed.ts';
import { Store } from '../src/store.ts';
import { authHeaders, DEMO, login, testApp } from './helpers.ts';

async function json<T>(response: Response): Promise<T> {
  assert.ok(
    response.ok,
    `expected success, got ${response.status}: ${await response.clone().text()}`,
  );
  return (await response.json()) as T;
}

async function send(
  app: Hono<AppEnv>,
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return await app.request(path, {
    method,
    headers: authHeaders(cookie, { 'content-type': 'application/json' }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const dir = mkdtempSync(join(tmpdir(), 'clay-ops-'));
const dbPath = join(dir, 'pulse.db');
const backupDir = join(dir, 'backups');
const store = new Store(dbPath, { demo: true, demoAccounts: true });
const { app } = testApp(store, { backupDir });

after(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('admin ops panel', () => {
  test('status is admin-only and carries settings, flags and counts', async () => {
    const adminCookie = await login(app);
    const { status } = await json<{
      status: {
        healthy: boolean;
        schemaVersion: number;
        backups: unknown[];
        settings: { backupRetentionDays: number };
        features: { key: string; enabled: boolean }[];
        demo: { enabled: boolean; projects: number };
        counts: { users: number; projects: number };
      };
    }>(await app.request('/api/ops', { headers: authHeaders(adminCookie) }));
    assert.equal(status.healthy, true);
    assert.equal(status.schemaVersion, SCHEMA_VERSION);
    assert.equal(status.features.length, 6);
    assert.equal(status.settings.backupRetentionDays, 14);
    assert.equal(status.demo.enabled, true);
    assert.ok(status.demo.projects > 0);
    assert.ok(status.counts.users >= 4);

    const me = await json<{ features: Record<string, boolean> }>(
      await app.request('/api/auth/me', { headers: authHeaders(adminCookie) }),
    );
    assert.equal(me.features.analytics, true);

    for (const email of [DEMO.viewer.email, DEMO.manager.email]) {
      const cookie = await login(app, email);
      const denied = await app.request('/api/ops', { headers: authHeaders(cookie) });
      assert.equal(denied.status, 403, `${email} must not reach the ops panel`);
    }
  });

  test('retention settings and feature flags validate input', async () => {
    const cookie = await login(app);
    const { settings } = await json<{ settings: Record<string, number | boolean> }>(
      await send(app, cookie, 'PATCH', '/api/ops/settings', {
        backupRetentionDays: 7,
        activityRetentionDays: 45,
        ocrRetentionDays: 0,
      }),
    );
    assert.equal(settings.backupRetentionDays, 7);
    assert.equal(settings.activityRetentionDays, 45);
    assert.equal(settings.ocrRetentionDays, 0);
    assert.equal(store.ops.retention().backupRetentionDays, 7);
    assert.equal(store.ops.retention().ocrRetentionDays, 0);

    const invalid = await send(app, cookie, 'PATCH', '/api/ops/settings', {
      backupRetentionDays: 0,
    });
    assert.equal(invalid.status, 400);

    const negativeOcr = await send(app, cookie, 'PATCH', '/api/ops/settings', {
      ocrRetentionDays: -1,
    });
    assert.equal(negativeOcr.status, 400);

    const { flag } = await json<{ flag: { key: string; enabled: boolean } }>(
      await send(app, cookie, 'PATCH', '/api/ops/features/analytics', { enabled: false }),
    );
    assert.equal(flag.enabled, false);
    const me = await json<{ features: Record<string, boolean> }>(
      await app.request('/api/auth/me', { headers: authHeaders(cookie) }),
    );
    assert.equal(me.features.analytics, false);

    const unknown = await send(app, cookie, 'PATCH', '/api/ops/features/nope', { enabled: true });
    assert.equal(unknown.status, 404);

    await send(app, cookie, 'PATCH', '/api/ops/features/analytics', { enabled: true });
  });

  test('integrity check succeeds and backups can be staged for restore', async () => {
    const cookie = await login(app);
    const { integrity } = await json<{ integrity: { ok: boolean; messages: string[] } }>(
      await app.request('/api/ops/integrity', { headers: authHeaders(cookie) }),
    );
    assert.equal(integrity.ok, true);
    assert.deepEqual(integrity.messages, ['ok']);

    const created = await json<{ backup: { name: string } }>(
      await send(app, cookie, 'POST', '/api/ops/backups'),
    );
    assert.ok(existsSync(join(backupDir, created.backup.name)));

    const traversal = await send(app, cookie, 'POST', '/api/ops/restore', {
      file: '../pulse.db',
    });
    assert.equal(traversal.status, 400);

    const missing = await send(app, cookie, 'POST', '/api/ops/restore', { file: 'missing.db' });
    assert.equal(missing.status, 404);

    const staged = await json<{ restartRequired: boolean; file: string }>(
      await send(app, cookie, 'POST', '/api/ops/restore', { file: created.backup.name }),
    );
    assert.equal(staged.restartRequired, true);
    assert.ok(existsSync(`${dbPath}.restore-pending`));
    rmSync(`${dbPath}.restore-pending`, { force: true });

    const status = await json<{ status: { backups: { name: string }[] } }>(
      await app.request('/api/ops', { headers: authHeaders(cookie) }),
    );
    assert.equal(status.status.backups[0]?.name, created.backup.name);
  });

  test('demo data can be disabled and restored without duplicates', async () => {
    const cookie = await login(app);
    const disabled = await json<{ enabled: boolean; removed: number; demo: { projects: number } }>(
      await send(app, cookie, 'POST', '/api/ops/demo-data', { enabled: false }),
    );
    assert.equal(disabled.enabled, false);
    assert.ok(disabled.removed > 0);
    assert.equal(disabled.demo.projects, 0);
    assert.equal(store.ops.settings().demoDataEnabled, false);

    const enabled = await json<{ demo: { projects: number } }>(
      await send(app, cookie, 'POST', '/api/ops/demo-data', { enabled: true }),
    );
    assert.equal(enabled.demo.projects, disabled.removed);
    const again = await json<{ demo: { projects: number } }>(
      await send(app, cookie, 'POST', '/api/ops/demo-data', { enabled: true }),
    );
    assert.equal(again.demo.projects, enabled.demo.projects, 'seeding is idempotent');
  });

  test('GDPR export omits secrets and erase anonymizes the account', async () => {
    const cookie = await login(app);
    const email = `gdpr-${Date.now()}@clay.test`;
    const created = await json<{ id: string }>(
      await send(app, cookie, 'POST', '/api/users', {
        email,
        name: '隐私测试用户',
        role: 'viewer',
        password: 'Privacy1234!',
      }),
    );
    const targetCookie = await login(app, email, 'Privacy1234!');
    assert.ok(targetCookie);
    const token = store.tokens.create(created.id, {
      name: 'export-me',
      scopes: ['read'],
      expiresInDays: null,
    });

    const exported = await app.request(`/api/ops/users/${created.id}/export`, {
      headers: authHeaders(cookie),
    });
    assert.equal(exported.status, 200);
    const text = await exported.text();
    assert.equal(exported.headers.get('content-disposition')?.includes('attachment'), true);
    assert.ok(text.includes(email));
    assert.ok(!text.includes('password_hash'));
    assert.ok(!text.includes('token_hash'));
    assert.ok(!text.includes(token.token));
    const parsed = JSON.parse(text) as { user: { id: string }; tokens: unknown[] };
    assert.equal(parsed.user.id, created.id);
    assert.equal(parsed.tokens.length, 1);

    const self = await send(app, cookie, 'POST', `/api/ops/users/${DEMO.admin.id}/erase`);
    assert.equal(self.status, 400);

    const erased = await send(app, cookie, 'POST', `/api/ops/users/${created.id}/erase`);
    assert.equal(erased.status, 200);

    const row = store.db.raw
      .prepare('SELECT email, name, status, password_hash FROM users WHERE id = ?')
      .get(created.id) as unknown as {
      email: string;
      name: string;
      status: string;
      password_hash: string;
    };
    assert.equal(row.email, `deleted-${created.id}@invalid`);
    assert.equal(row.name, '已删除用户');
    assert.equal(row.status, 'disabled');
    assert.notEqual(row.password_hash, '');
    assert.equal(
      store.db.raw.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(created.id)
        ?.n,
      0,
    );
    assert.equal(
      store.db.raw
        .prepare('SELECT COUNT(*) AS n FROM personal_access_tokens WHERE user_id = ?')
        .get(created.id)?.n,
      0,
    );
    const relogin = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'Privacy1234!' }),
    });
    assert.equal(relogin.status, 401);
  });

  test('the last active admin cannot be erased', async () => {
    const plain = new Store(join(dir, 'plain.db'), {
      demo: false,
      demoAccounts: false,
      bootstrapAdmin: { email: 'owner@clay.test', password: 'Owner1234!' },
    });
    try {
      const admin = plain.users.authByEmail('owner@clay.test');
      assert.ok(admin);
      assert.equal(plain.ops.eraseUser(admin.id, admin.id), 'last_admin');
    } finally {
      plain.close();
    }
  });

  test('scheduled retention trims old activities and audit rows', async () => {
    const old = new Date('2020-01-01T00:00:00.000Z').toISOString();
    store.activities.record({
      type: 'project.updated',
      actor: null,
      message: '很久以前的活动',
      createdAt: old,
    });
    store.db.raw
      .prepare(
        `INSERT INTO audit_log (actor_id, action, target, detail, created_at)
         VALUES (NULL, 'test.old', NULL, '{}', ?)`,
      )
      .run(old);

    const owner = store.users.authByEmail(DEMO_USERS[0].email);
    assert.ok(owner);
    const project = store.projects.create(
      { name: 'OCR 保留期' },
      { id: owner.id, name: owner.name },
    );
    const attachmentId = randomUUID();
    store.attachments.create({
      id: attachmentId,
      projectId: project.id,
      uploaderId: owner.id,
      name: 'old-scan.png',
      mime: 'image/png',
      size: 16,
      storedName: `old-${attachmentId}.bin`,
      sha256: 'c'.repeat(64),
      createdAt: old,
      ocrTarget: 'paddle',
    });
    store.attachments.completeOcr(
      attachmentId,
      {
        text: '旧扫描件的识别文本',
        confidence: 0.9,
        model: 'fake-model',
        engineModel: 'fake-model',
        configHash: 'retention-test',
        seconds: 1,
        pages: 1,
        truncated: false,
        route: 'visual',
        quality: null,
        stages: [],
        document: null,
      },
      old,
    );

    const scheduler = startBackupScheduler(store, {
      dir: join(dir, 'retention-backups'),
      retentionDays: 14,
      trashRetentionDays: 30,
      startupDelayMs: 60_000,
      intervalMs: 60_000,
      retention: () => ({
        backupRetentionDays: 14,
        trashRetentionDays: 30,
        auditRetentionDays: 30,
        activityRetentionDays: 30,
        ocrRetentionDays: 30,
      }),
    });
    try {
      scheduler.runNow();
    } finally {
      scheduler.stop();
    }
    const activities = store.db.raw
      .prepare("SELECT COUNT(*) AS n FROM activities WHERE payload LIKE '%很久以前的活动%'")
      .get() as unknown as { n: number };
    assert.equal(Number(activities.n), 0);
    const audits = store.db.raw
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'test.old'")
      .get() as unknown as { n: number };
    assert.equal(Number(audits.n), 0);
    const ocr = store.attachments.findOcr(attachmentId);
    assert.ok(ocr?.purgedAt);
    assert.equal(ocr?.text, '');
  });

  test('primary demo admin row stays intact for other suites', () => {
    const admin = store.users.authByEmail(DEMO_USERS[0].email);
    assert.equal(admin?.status, 'active');
    assert.equal(admin?.role, 'admin');
  });
});
