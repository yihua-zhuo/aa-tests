import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Database } from './db.ts';
import { log } from './logger.ts';
import type { Store } from './store.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

function stamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
}

export function defaultBackupDir(dbPath: string): string {
  return join(dirname(dbPath), 'backups');
}

/** Consistent snapshot via `VACUUM INTO`; safe while WAL is active. */
export function backupDatabase(db: Database, dir: string, now = new Date()): string | null {
  if (db.path === ':memory:') return null;
  mkdirSync(dir, { recursive: true });
  let target = join(dir, `pulse-${stamp(now)}.db`);
  if (existsSync(target)) {
    target = join(dir, `pulse-${stamp(now)}-${Math.random().toString(36).slice(2, 6)}.db`);
  }
  const escaped = target.replace(/'/g, "''");
  db.raw.exec(`VACUUM INTO '${escaped}'`);
  return target;
}

export function pruneBackups(dir: string, retentionDays: number, now = Date.now()): number {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0 || !existsSync(dir)) return 0;
  const cutoff = now - retentionDays * DAY_MS;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.db')) continue;
    const path = join(dir, name);
    try {
      if (statSync(path).mtimeMs < cutoff) {
        rmSync(path, { force: true });
        removed += 1;
      }
    } catch {
      // A backup disappearing concurrently is fine.
    }
  }
  return removed;
}

export type BackupSchedulerOptions = {
  dir: string;
  retentionDays: number;
  trashRetentionDays: number;
  intervalMs?: number;
  startupDelayMs?: number;
  now?: () => Date;
  /** Live retention policy; overrides the static values when provided. */
  retention?: () => {
    backupRetentionDays: number;
    trashRetentionDays: number;
    auditRetentionDays: number;
    activityRetentionDays: number;
    /** 0 keeps OCR text indefinitely; omitted behaves like 0. */
    ocrRetentionDays?: number;
  };
};

/**
 * Applies a staged restore created from the ops panel. The caller must run
 * this before opening the database. The previous database is kept as a
 * `.pre-restore-<timestamp>.bak` file so the operation stays reversible.
 */
export function applyPendingRestore(dbPath: string): string | null {
  if (dbPath === ':memory:') return null;
  const pending = `${dbPath}.restore-pending`;
  if (!existsSync(pending)) return null;

  mkdirSync(dirname(dbPath), { recursive: true });
  const previous = `${dbPath}.pre-restore-${stamp(new Date())}.bak`;
  if (existsSync(dbPath)) copyFileSync(dbPath, previous);
  for (const suffix of ['-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
  copyFileSync(pending, dbPath);
  rmSync(pending, { force: true });
  return previous;
}

export type BackupScheduler = {
  stop: () => void;
  runNow: () => string | null;
};

/**
 * Runs a snapshot shortly after boot and then on a fixed interval. `unref()`
 * keeps the process exit path unchanged.
 */
export function startBackupScheduler(
  store: Store,
  options: BackupSchedulerOptions,
): BackupScheduler {
  const now = options.now ?? (() => new Date());
  const run = (): string | null => {
    try {
      const at = now();
      const policy = options.retention?.() ?? {
        backupRetentionDays: options.retentionDays,
        trashRetentionDays: options.trashRetentionDays,
        auditRetentionDays: store.audit.retention.days,
        activityRetentionDays: 0,
        ocrRetentionDays: 0,
      };
      const file = backupDatabase(store.db, options.dir, at);
      const pruned = pruneBackups(options.dir, policy.backupRetentionDays, at.getTime());
      const purged = store.projects.cleanupDeleted(policy.trashRetentionDays, at.getTime());
      const auditTrimmed =
        policy.auditRetentionDays > 0 ? store.audit.cleanup(policy.auditRetentionDays) : 0;
      const activitiesTrimmed =
        policy.activityRetentionDays > 0
          ? store.activities.cleanup(policy.activityRetentionDays, at.getTime())
          : 0;
      const ocrPurged = store.attachments.purgeOcrText(policy.ocrRetentionDays ?? 0, at.getTime());
      log('info', 'backup.completed', {
        file,
        pruned,
        purgedProjects: purged,
        auditTrimmed,
        activitiesTrimmed,
        ocrTextsPurged: ocrPurged.attachments,
        ocrRevisionsPurged: ocrPurged.revisions,
        retentionDays: policy.backupRetentionDays,
      });
      return file;
    } catch (error) {
      log('error', 'backup.failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  const first = setTimeout(run, options.startupDelayMs ?? 60_000);
  first.unref();
  const interval = setInterval(run, options.intervalMs ?? DAY_MS);
  interval.unref();

  return {
    stop: () => {
      clearTimeout(first);
      clearInterval(interval);
    },
    runNow: run,
  };
}
