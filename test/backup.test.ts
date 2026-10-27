import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { backupDatabase, pruneBackups, startBackupScheduler } from '../src/backup.ts';
import { DEMO_USERS } from '../src/seed.ts';
import { Store } from '../src/store.ts';

process.env.LOG_LEVEL = 'silent';

const DAY_MS = 24 * 60 * 60 * 1000;
const ADMIN = { id: DEMO_USERS[0].id, name: DEMO_USERS[0].name };

function quickCheck(path: string): string[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare('PRAGMA quick_check').all() as { quick_check: string }[]).map(
      (row) => row.quick_check,
    );
  } finally {
    db.close();
  }
}

test('VACUUM INTO produces a standalone consistent snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clay-backup-'));
  const store = new Store(join(dir, 'pulse.db'), { demo: true, demoAccounts: true });
  try {
    store.projects.create({ name: '备份前的项目' }, ADMIN);
    const file = backupDatabase(store.db, join(dir, 'backups'), new Date('2026-06-15T12:00:00Z'));
    assert.ok(file && existsSync(file), 'a backup file is written');
    assert.deepEqual(quickCheck(file), ['ok']);

    const snapshot = new DatabaseSync(file, { readOnly: true });
    try {
      const row = snapshot
        .prepare("SELECT COUNT(*) AS n FROM projects WHERE name = '备份前的项目'")
        .get() as { n: number };
      assert.equal(Number(row.n), 1, 'committed rows are visible in the snapshot');
    } finally {
      snapshot.close();
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retention pruning removes only expired snapshots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clay-prune-'));
  try {
    writeFileSync(join(dir, 'old.db'), '');
    writeFileSync(join(dir, 'fresh.db'), '');
    writeFileSync(join(dir, 'notes.txt'), '');
    const old = (Date.now() - 10 * DAY_MS) / 1000;
    utimesSync(join(dir, 'old.db'), old, old);

    assert.equal(pruneBackups(dir, 7), 1);
    assert.equal(existsSync(join(dir, 'old.db')), false);
    assert.equal(existsSync(join(dir, 'fresh.db')), true);
    assert.equal(existsSync(join(dir, 'notes.txt')), true, 'non-backup files are untouched');
    assert.equal(pruneBackups(join(dir, 'missing'), 7), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scheduler snapshots and purges projects deleted past retention', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clay-scheduler-'));
  const store = new Store(join(dir, 'pulse.db'), { demo: true, demoAccounts: true });
  try {
    const project = store.projects.create({ name: '待清理的项目' }, ADMIN);
    store.projects.remove(project.id, ADMIN);
    store.db
      .stmt('UPDATE projects SET deleted_at = ? WHERE id = ?')
      .run('2020-01-01T00:00:00.000Z', project.id);

    const scheduler = startBackupScheduler(store, {
      dir: join(dir, 'backups'),
      retentionDays: 14,
      trashRetentionDays: 30,
      startupDelayMs: 60_000,
      intervalMs: 60_000,
    });
    try {
      const file = scheduler.runNow();
      assert.ok(file, 'the run reports the snapshot path');
      assert.deepEqual(quickCheck(file), ['ok']);
      assert.equal(
        store.db.stmt('SELECT 1 AS found FROM projects WHERE id = ?').get(project.id),
        undefined,
        'projects past the trash retention window are purged',
      );
    } finally {
      scheduler.stop();
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manual backup script writes a consistent snapshot to the chosen directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clay-manual-'));
  const dbPath = join(dir, 'pulse.db');
  const store = new Store(dbPath, { demo: true, demoAccounts: true });
  try {
    store.projects.create({ name: '手动备份项目' }, ADMIN);
  } finally {
    store.close();
  }

  try {
    const script = join(import.meta.dirname, '..', 'scripts', 'backup.mjs');
    const out = execFileSync(process.execPath, [script, dbPath, join(dir, 'manual')], {
      encoding: 'utf8',
    }).trim();
    assert.ok(out.endsWith('.db'), 'the script prints the snapshot path');
    assert.ok(existsSync(out));
    assert.deepEqual(quickCheck(out), ['ok']);

    const snapshot = new DatabaseSync(out, { readOnly: true });
    try {
      const row = snapshot
        .prepare("SELECT COUNT(*) AS n FROM projects WHERE name = '手动备份项目'")
        .get() as { n: number };
      assert.equal(Number(row.n), 1);
    } finally {
      snapshot.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restore script replaces a database and keeps the previous copy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clay-restore-'));
  const store = new Store(join(dir, 'source.db'), { demo: true, demoAccounts: true });
  let backup: string | null;
  try {
    backup = backupDatabase(store.db, join(dir, 'backups'));
  } finally {
    store.close();
  }
  assert.ok(backup);

  try {
    const target = join(dir, 'restored.db');
    const script = join(import.meta.dirname, '..', 'scripts', 'restore.mjs');
    execFileSync(process.execPath, [script, backup, target]);
    assert.deepEqual(quickCheck(target), ['ok']);

    assert.throws(() =>
      execFileSync(process.execPath, [script, backup, target], { stdio: 'pipe' }),
    );
    execFileSync(process.execPath, [script, backup, target, '--force']);
    assert.deepEqual(quickCheck(target), ['ok']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
