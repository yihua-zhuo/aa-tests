import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  FEATURE_FLAG_KEYS,
  type FeatureFlag,
  type FeatureFlagKey,
  type FeatureFlags,
  type OpsBackup,
  type OpsIntegrity,
  type OpsSettings,
  type OpsStatus,
  type UserDataExport,
} from '../../shared/types.ts';
import { hashPasswordSync } from '../auth.ts';
import { backupDatabase } from '../backup.ts';
import { type Database, positiveIntEnv, SCHEMA_VERSION } from '../db.ts';

const SETTINGS_KEY = 'ops.settings';

type StoredSettings = Omit<OpsSettings, 'updatedAt'>;

type AppSettingRow = { value: string; updated_at: string };
type FlagRow = {
  key: string;
  enabled: number;
  updated_at: string;
  updated_by: string | null;
};

function defaultSettings(demoDataEnabled: boolean): StoredSettings {
  return {
    backupRetentionDays: positiveIntEnv('BACKUP_RETENTION_DAYS', 14),
    trashRetentionDays: positiveIntEnv('TRASH_RETENTION_DAYS', 30),
    auditRetentionDays: positiveIntEnv('AUDIT_RETENTION_DAYS', 180),
    activityRetentionDays: positiveIntEnv('ACTIVITY_RETENTION_DAYS', 180),
    demoDataEnabled,
  };
}

export type EraseUserResult = 'ok' | 'not_found' | 'last_admin';

export class OpsStore {
  readonly #db: Database;

  constructor(db: Database, options: { demoDataEnabled?: boolean } = {}) {
    this.#db = db;
    const defaults = defaultSettings(options.demoDataEnabled ?? true);
    const now = new Date().toISOString();
    this.#db
      .stmt('INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run(SETTINGS_KEY, JSON.stringify(defaults), now);
    const insertFlag = this.#db.stmt(
      `INSERT OR IGNORE INTO feature_flags (key, enabled, updated_at)
       VALUES (?, 1, ?)`,
    );
    for (const key of FEATURE_FLAG_KEYS) insertFlag.run(key, now);
  }

  settings(): OpsSettings {
    const row = this.#db
      .stmt('SELECT value, updated_at FROM app_settings WHERE key = ?')
      .get(SETTINGS_KEY) as unknown as AppSettingRow | undefined;
    const defaults = defaultSettings(true);
    if (!row) {
      return { ...defaults, updatedAt: new Date().toISOString() };
    }
    let parsed: Partial<StoredSettings> = {};
    try {
      const value: unknown = JSON.parse(row.value);
      if (value && typeof value === 'object') parsed = value as Partial<StoredSettings>;
    } catch {
      parsed = {};
    }
    const days = (value: unknown, fallback: number): number => {
      const parsedValue = Number(value);
      return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
    };
    return {
      backupRetentionDays: days(parsed.backupRetentionDays, defaults.backupRetentionDays),
      trashRetentionDays: days(parsed.trashRetentionDays, defaults.trashRetentionDays),
      auditRetentionDays: days(parsed.auditRetentionDays, defaults.auditRetentionDays),
      activityRetentionDays: days(parsed.activityRetentionDays, defaults.activityRetentionDays),
      demoDataEnabled:
        typeof parsed.demoDataEnabled === 'boolean'
          ? parsed.demoDataEnabled
          : defaults.demoDataEnabled,
      updatedAt: row.updated_at,
    };
  }

  updateSettings(patch: Partial<StoredSettings>): OpsSettings {
    const current = this.settings();
    const next: StoredSettings = {
      backupRetentionDays: patch.backupRetentionDays ?? current.backupRetentionDays,
      trashRetentionDays: patch.trashRetentionDays ?? current.trashRetentionDays,
      auditRetentionDays: patch.auditRetentionDays ?? current.auditRetentionDays,
      activityRetentionDays: patch.activityRetentionDays ?? current.activityRetentionDays,
      demoDataEnabled: patch.demoDataEnabled ?? current.demoDataEnabled,
    };
    const now = new Date().toISOString();
    this.#db
      .stmt(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(SETTINGS_KEY, JSON.stringify(next), now);
    return { ...next, updatedAt: now };
  }

  retention(): {
    backupRetentionDays: number;
    trashRetentionDays: number;
    auditRetentionDays: number;
    activityRetentionDays: number;
  } {
    const { demoDataEnabled: _demo, updatedAt: _updatedAt, ...retention } = this.settings();
    return retention;
  }

  features(): FeatureFlag[] {
    const rows = this.#db
      .stmt('SELECT key, enabled, updated_at, updated_by FROM feature_flags ORDER BY key')
      .all() as unknown as FlagRow[];
    return rows
      .filter((row): row is FlagRow & { key: FeatureFlagKey } =>
        (FEATURE_FLAG_KEYS as readonly string[]).includes(row.key),
      )
      .map((row) => ({
        key: row.key,
        enabled: row.enabled === 1,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
      }));
  }

  featureMap(): FeatureFlags {
    const result = Object.fromEntries(FEATURE_FLAG_KEYS.map((key) => [key, true])) as FeatureFlags;
    for (const flag of this.features()) result[flag.key] = flag.enabled;
    return result;
  }

  setFeature(key: string, enabled: boolean, updatedBy: string): FeatureFlag | null {
    if (!(FEATURE_FLAG_KEYS as readonly string[]).includes(key)) return null;
    this.#db
      .stmt(`UPDATE feature_flags SET enabled = ?, updated_at = ?, updated_by = ? WHERE key = ?`)
      .run(enabled ? 1 : 0, new Date().toISOString(), updatedBy, key);
    return this.features().find((flag) => flag.key === key) ?? null;
  }

  integrity(): OpsIntegrity {
    const checkedAt = new Date().toISOString();
    let messages: string[];
    try {
      const rows = this.#db.raw.prepare('PRAGMA integrity_check').all() as unknown as {
        integrity_check: string;
      }[];
      messages = rows.map((row) => row.integrity_check);
    } catch (error) {
      messages = [error instanceof Error ? error.message : String(error)];
    }
    return {
      ok: messages.length === 1 && messages[0] === 'ok',
      checkedAt,
      messages: messages.slice(0, 20),
    };
  }

  status(backupDir: string, dbPath: string): OpsStatus {
    const counts = this.#db.raw
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM users) AS users,
           (SELECT COUNT(*) FROM projects) AS projects,
           (SELECT COUNT(*) FROM sessions) AS sessions,
           (SELECT COUNT(*) FROM activities) AS activities,
           (SELECT COUNT(*) FROM audit_log) AS audit_entries,
           (SELECT COUNT(*) FROM users WHERE is_demo = 1) AS demo_users,
           (SELECT COUNT(*) FROM projects WHERE is_demo = 1) AS demo_projects`,
      )
      .get() as unknown as Record<string, number>;
    const settings = this.settings();
    return {
      healthy: this.#db.quickCheck(),
      schemaVersion: SCHEMA_VERSION,
      sqliteVersion: this.#db.sqliteVersion(),
      databaseBytes: fileSize(dbPath),
      backupDir,
      backups: this.backups(backupDir),
      settings,
      features: this.features(),
      demo: {
        enabled: settings.demoDataEnabled,
        users: Number(counts.demo_users ?? 0),
        projects: Number(counts.demo_projects ?? 0),
      },
      counts: {
        users: Number(counts.users ?? 0),
        projects: Number(counts.projects ?? 0),
        sessions: Number(counts.sessions ?? 0),
        activities: Number(counts.activities ?? 0),
        auditEntries: Number(counts.audit_entries ?? 0),
      },
      pendingRestore: existsSync(`${dbPath}.restore-pending`)
        ? `${basename(dbPath)}.restore-pending`
        : null,
    };
  }

  backups(dir: string): OpsBackup[] {
    if (!existsSync(dir)) return [];
    const result: OpsBackup[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.db')) continue;
      try {
        const stats = statSync(join(dir, name));
        result.push({
          name,
          sizeBytes: stats.size,
          createdAt: stats.mtime.toISOString(),
        });
      } catch {
        // A backup disappearing concurrently is fine.
      }
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  createBackup(dir: string, now = new Date()): OpsBackup | null {
    const file = backupDatabase(this.#db, dir, now);
    if (!file) return null;
    try {
      const stats = statSync(file);
      return { name: basename(file), sizeBytes: stats.size, createdAt: stats.mtime.toISOString() };
    } catch {
      return null;
    }
  }

  stageRestore(
    dir: string,
    file: string,
    dbPath: string,
  ): { ok: true } | { ok: false; reason: 'memory' | 'missing' | 'invalid' } {
    if (dbPath === ':memory:') return { ok: false, reason: 'memory' };
    if (file !== basename(file) || !/^[A-Za-z0-9._-]+\.db$/.test(file)) {
      return { ok: false, reason: 'invalid' };
    }
    const source = join(dir, file);
    if (!existsSync(source)) return { ok: false, reason: 'missing' };

    let probe: DatabaseSync | null = null;
    try {
      probe = new DatabaseSync(source, { readOnly: true });
      const rows = probe.prepare('PRAGMA quick_check').all() as unknown as {
        quick_check: string;
      }[];
      if (rows.length !== 1 || rows[0]?.quick_check !== 'ok') {
        return { ok: false, reason: 'invalid' };
      }
    } catch {
      return { ok: false, reason: 'invalid' };
    } finally {
      probe?.close();
    }

    copyFileSync(source, `${dbPath}.restore-pending`);
    return { ok: true };
  }

  demoCounts(): { projects: number; users: number } {
    const row = this.#db.raw
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM projects WHERE is_demo = 1) AS projects,
           (SELECT COUNT(*) FROM users WHERE is_demo = 1) AS users`,
      )
      .get() as unknown as { projects: number; users: number };
    return { projects: Number(row.projects), users: Number(row.users) };
  }

  purgeDemoProjects(): number {
    const result = this.#db.stmt('DELETE FROM projects WHERE is_demo = 1').run();
    return Number(result.changes);
  }

  exportUser(id: string): UserDataExport | null {
    const user = this.#db
      .stmt(
        `SELECT id, email, name, role, status, timezone, workspace_id, custom_role_id,
                is_demo, created_at, updated_at, last_login_at, avatar_url
         FROM users WHERE id = ?`,
      )
      .get(id) as unknown as Record<string, unknown> | undefined;
    if (!user) return null;

    const all = (sql: string): Record<string, unknown>[] =>
      this.#db.raw.prepare(sql).all(id) as unknown as Record<string, unknown>[];

    return {
      generatedAt: new Date().toISOString(),
      user,
      preferences:
        (this.#db.raw
          .prepare('SELECT * FROM user_preferences WHERE user_id = ?')
          .get(id) as unknown as Record<string, unknown> | undefined) ?? null,
      ownedProjects: all(
        `SELECT id, name, description, status, progress, workspace_id, visibility,
                start_date, due_date, created_at, updated_at
         FROM projects WHERE owner_id = ?`,
      ),
      memberships: all(`SELECT project_id, added_at FROM project_members WHERE user_id = ?`),
      assignedTasks: all(
        `SELECT id, project_id, title, status, priority, due_date, created_at, updated_at
         FROM project_tasks WHERE assignee_id = ?`,
      ),
      comments: all(
        `SELECT id, project_id, task_id, body, created_at, updated_at
         FROM comments WHERE author_id = ?`,
      ),
      activities: all(
        `SELECT seq, type, project_id, payload, created_at
         FROM activities WHERE actor_id = ? ORDER BY seq`,
      ),
      sessions: all(
        `SELECT created_at, last_seen_at, expires_at, ip, user_agent
         FROM sessions WHERE user_id = ?`,
      ),
      tokens: all(
        `SELECT id, name, scopes, expires_at, last_used_at, created_at, revoked_at
         FROM personal_access_tokens WHERE user_id = ?`,
      ),
      webhooks: all(`SELECT id, url, events, active, created_at FROM webhooks WHERE user_id = ?`),
      notifications: all(
        `SELECT id, type, title, body, link, read_at, created_at
         FROM notifications WHERE user_id = ? ORDER BY created_at`,
      ),
      auditEntries: all(
        `SELECT seq, action, target, ip, detail, created_at
         FROM audit_log WHERE actor_id = ? ORDER BY seq`,
      ),
      attachments: all(
        `SELECT id, project_id, task_id, name, mime, size, sha256, created_at
         FROM attachments WHERE uploader_id = ?`,
      ),
    };
  }

  eraseUser(targetId: string, actingAdminId: string): EraseUserResult {
    const target = this.#db
      .stmt('SELECT id, email, role, status FROM users WHERE id = ?')
      .get(targetId) as unknown as
      | { id: string; email: string; role: string; status: string }
      | undefined;
    if (!target) return 'not_found';
    if (target.role === 'admin' && target.status === 'active') {
      const others = this.#db.raw
        .prepare(
          `SELECT COUNT(*) AS total FROM users
           WHERE role = 'admin' AND status = 'active' AND id <> ?`,
        )
        .get(targetId) as unknown as { total: number };
      if (Number(others.total) === 0) return 'last_admin';
    }

    const now = new Date().toISOString();
    const anonymizedEmail = `deleted-${targetId}@invalid`;
    const passwordHash = hashPasswordSync(randomBytes(32).toString('base64url'));

    this.#db.transaction(() => {
      this.#db
        .stmt('UPDATE projects SET owner_id = ? WHERE owner_id = ?')
        .run(actingAdminId, targetId);
      this.#db.stmt('DELETE FROM project_members WHERE user_id = ?').run(targetId);
      this.#db.stmt('DELETE FROM comment_mentions WHERE user_id = ?').run(targetId);
      this.#db.stmt('DELETE FROM project_favorites WHERE user_id = ?').run(targetId);
      this.#db.stmt('DELETE FROM saved_views WHERE user_id = ?').run(targetId);
      this.#db.stmt('DELETE FROM saved_reports WHERE user_id = ?').run(targetId);
      this.#db.stmt('DELETE FROM notifications WHERE user_id = ?').run(targetId);
      this.#db.stmt('DELETE FROM push_subscriptions WHERE user_id = ?').run(targetId);
      this.#db.stmt('DELETE FROM mail_outbox WHERE user_id = ?').run(targetId);
      this.#db.stmt('DELETE FROM password_resets WHERE user_id = ?').run(targetId);
      this.#db.stmt('DELETE FROM mfa_challenges WHERE user_id = ?').run(targetId);
      this.#db.stmt('DELETE FROM sessions WHERE user_id = ?').run(targetId);
      this.#db.stmt('DELETE FROM personal_access_tokens WHERE user_id = ?').run(targetId);
      this.#db.stmt('DELETE FROM webhooks WHERE user_id = ?').run(targetId);
      this.#db.stmt('DELETE FROM user_preferences WHERE user_id = ?').run(targetId);
      this.#db.stmt('DELETE FROM login_failures WHERE key = ?').run(`account:${target.email}`);
      this.#db
        .stmt('UPDATE project_tasks SET assignee_id = NULL WHERE assignee_id = ?')
        .run(targetId);
      this.#db.stmt('UPDATE comments SET author_id = NULL WHERE author_id = ?').run(targetId);
      this.#db
        .stmt('UPDATE attachments SET uploader_id = NULL WHERE uploader_id = ?')
        .run(targetId);
      this.#db
        .stmt(
          `UPDATE activities SET actor_id = NULL,
             payload = json_set(payload, '$.actorName', NULL)
           WHERE actor_id = ?`,
        )
        .run(targetId);
      this.#db.stmt('UPDATE audit_log SET actor_id = NULL WHERE actor_id = ?').run(targetId);
      this.#db
        .stmt(
          `UPDATE users SET
             email = ?, name = '已删除用户', password_hash = ?, status = 'disabled',
             avatar_url = NULL, mfa_secret = NULL, mfa_enabled = 0,
             mfa_recovery = '[]', custom_role_id = NULL, is_demo = 0,
             version = version + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(anonymizedEmail, passwordHash, now, targetId);
    });
    return 'ok';
  }
}

function fileSize(path: string): number {
  if (path === ':memory:') return 0;
  try {
    return statSync(path).size + fileSizeIfExists(`${path}-wal`);
  } catch {
    return 0;
  }
}

function fileSizeIfExists(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
