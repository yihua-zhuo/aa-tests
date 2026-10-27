import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { SCHEMA_VERSION } from '../src/db.ts';
import { Store } from '../src/store.ts';

const BOOTSTRAP = { email: 'owner@clay.test', password: 'Owner1234!', name: 'Owner' };
const dir = mkdtempSync(join(tmpdir(), 'clay-migration-'));

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

type LegacyProjectRow = {
  id: string;
  name: string;
  status: string;
  progress: number;
  owner_id: string;
  legacy_task_id: string;
  due_date: string | null;
  start_date: string | null;
};

function createLegacyDb(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      due_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT
    );
    INSERT INTO tasks (id, title, done, due_at, created_at, updated_at) VALUES
      ('legacy-done', '旧版已完成任务', 1, '2026-10-01', '2026-09-01T08:00:00.000Z', '2026-09-20T08:00:00.000Z'),
      ('legacy-open', '旧版未完成任务', 0, NULL, '2026-09-02T09:00:00.000Z', NULL);

    CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO events (type, payload, created_at) VALUES
      ('task.created', '{"id":"legacy-done","title":"旧版已完成任务"}', '2026-09-01T08:00:01.000Z'),
      ('task.updated', '{"id":"legacy-open","title":"旧版未完成任务"}', '2026-09-02T09:00:01.000Z'),
      ('task.created', '{"id":"missing-task","title":"幽灵任务"}', '2026-09-03T09:00:01.000Z'),
      ('tasks.imported', '{"count":3}', '2026-09-04T09:00:01.000Z');
  `);
  db.close();
}

test('legacy tasks and events migrate into projects with a backup', () => {
  const path = join(dir, 'legacy.db');
  createLegacyDb(path);

  const store = new Store(path, { demo: false, bootstrapAdmin: BOOTSTRAP });
  try {
    assert.ok(existsSync(`${path}.pre-v2.bak`), 'the v1 database is backed up first');
    assert.equal(store.db.userVersion, SCHEMA_VERSION);
    assert.equal(store.db.tableExists('tasks'), false);
    assert.equal(store.db.tableExists('events'), false);

    const projects = store.db.raw
      .prepare(
        `SELECT id, name, status, progress, owner_id, legacy_task_id, due_date, start_date
         FROM projects WHERE legacy_task_id IS NOT NULL ORDER BY id`,
      )
      .all() as unknown as LegacyProjectRow[];
    assert.equal(projects.length, 2);

    const done = projects.find((project) => project.id === 'legacy-done');
    const open = projects.find((project) => project.id === 'legacy-open');
    assert.ok(done && open);
    assert.equal(done.name, '旧版已完成任务');
    assert.equal(done.status, 'completed');
    assert.equal(done.progress, 100);
    assert.equal(done.due_date, '2026-10-01');
    assert.equal(done.start_date, null);
    assert.equal(done.owner_id, store.users.authByEmail(BOOTSTRAP.email)?.id);
    assert.equal(done.legacy_task_id, 'legacy-done');

    assert.equal(open.status, 'active');
    assert.equal(open.progress, 0);
    assert.equal(open.due_date, null);

    const activities = store.activities.page('admin', done.owner_id, { limit: 50 }).activities;
    assert.deepEqual(
      activities.map((activity) => activity.type).sort(),
      ['project.created', 'project.imported', 'project.updated'],
      'events for missing tasks are dropped',
    );
    const imported = activities.find((activity) => activity.type === 'project.imported');
    assert.equal(imported?.meta?.count, 3);
    assert.equal(imported?.project, null);

    const search = store.projects.list('admin', done.owner_id, {
      q: '旧版已完成',
      status: 'all',
      owner: 'all',
      sort: 'updated',
      page: 1,
      pageSize: 10,
    });
    assert.deepEqual(
      search.projects.map((project) => project.id),
      ['legacy-done'],
      'the FTS index is rebuilt for migrated rows',
    );

    const reopened = new Store(path, { demo: false, bootstrapAdmin: BOOTSTRAP });
    try {
      const again = reopened.db.raw
        .prepare('SELECT COUNT(*) AS total FROM projects WHERE legacy_task_id IS NOT NULL')
        .get() as { total: number };
      assert.equal(Number(again.total), 2, 'reopening does not duplicate rows');
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
  }

  const backup = new DatabaseSync(`${path}.pre-v2.bak`);
  try {
    const rows = backup.prepare('SELECT COUNT(*) AS total FROM tasks').get() as { total: number };
    assert.equal(Number(rows.total), 2, 'the backup keeps the original task rows');
  } finally {
    backup.close();
  }
});

test('fresh v2 databases are not backed up again', () => {
  const path = join(dir, 'fresh.db');
  const first = new Store(path, { demo: false, bootstrapAdmin: BOOTSTRAP });
  first.close();
  assert.equal(existsSync(`${path}.pre-v2.bak`), false);

  const second = new Store(path, { demo: false, bootstrapAdmin: BOOTSTRAP });
  try {
    assert.equal(second.db.userVersion, SCHEMA_VERSION);
    assert.equal(second.projects.total(), 0);
    assert.equal(second.users.count(), 1, 'non-demo deployments seed only the bootstrap admin');
  } finally {
    second.close();
  }
});
