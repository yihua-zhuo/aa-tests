import type {
  AuditActionCount,
  AuditEntry,
  AuditRetention,
  Preferences,
  UserOption,
} from '../../shared/types.ts';
import { type Database, escapeLike, positiveIntEnv } from '../db.ts';

type PreferenceRow = {
  user_id: string;
  default_range: string;
  email_notifications: number;
  weekly_digest: number;
  sidebar_collapsed: number;
  updated_at: string;
  version: number;
};

const MAX_AUDIT_ROWS = positiveIntEnv('AUDIT_RETENTION', 10_000);
const AUDIT_RETENTION_DAYS = positiveIntEnv('AUDIT_RETENTION_DAYS', 180);
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export type LoginAttemptRule = { key: string; limit: number };

type LoginFailureRow = {
  key: string;
  failures: number;
  reset_at: string;
};

/**
 * Persistent failed-login counters. Scoped keys let the caller apply different
 * thresholds to an account and to the originating IP across restarts.
 */
export class LoginAttemptsStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  check(
    rules: readonly LoginAttemptRule[],
    now = Date.now(),
  ): { blocked: boolean; retryAfterMs: number } {
    if (rules.length === 0) return { blocked: false, retryAfterMs: 0 };
    const keys = rules.map((rule) => rule.key);
    const placeholders = keys.map(() => '?').join(', ');
    const rows = this.#db
      .stmt(`SELECT key, failures, reset_at FROM login_failures WHERE key IN (${placeholders})`)
      .all(...keys) as unknown as LoginFailureRow[];
    const byKey = new Map(rows.map((row) => [row.key, row]));

    let retryAfterMs = 0;
    for (const rule of rules) {
      const row = byKey.get(rule.key);
      if (!row) continue;
      const reset = Date.parse(row.reset_at);
      if (!Number.isFinite(reset) || reset <= now) continue;
      if (Number(row.failures) >= rule.limit) {
        retryAfterMs = Math.max(retryAfterMs, reset - now);
      }
    }
    return { blocked: retryAfterMs > 0, retryAfterMs };
  }

  record(rules: readonly LoginAttemptRule[], now = Date.now()): void {
    if (rules.length === 0) return;
    const nowIso = new Date(now).toISOString();
    const resetIso = new Date(now + LOGIN_WINDOW_MS).toISOString();
    this.#db.transaction(() => {
      this.#db.stmt('DELETE FROM login_failures WHERE reset_at <= ?').run(nowIso);
      for (const rule of rules) {
        const row = this.#db
          .stmt('SELECT failures, reset_at FROM login_failures WHERE key = ?')
          .get(rule.key) as unknown as LoginFailureRow | undefined;
        if (!row) {
          this.#db
            .stmt(
              `INSERT INTO login_failures (key, failures, reset_at, updated_at)
               VALUES (?, 1, ?, ?)`,
            )
            .run(rule.key, resetIso, nowIso);
        } else {
          this.#db
            .stmt('UPDATE login_failures SET failures = failures + 1, updated_at = ? WHERE key = ?')
            .run(nowIso, rule.key);
        }
      }
    });
  }

  clear(keys: readonly string[]): void {
    if (keys.length === 0) return;
    const placeholders = keys.map(() => '?').join(', ');
    this.#db.stmt(`DELETE FROM login_failures WHERE key IN (${placeholders})`).run(...keys);
  }
}

export class PreferencesStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  #ensure(userId: string): void {
    this.#db
      .stmt(
        `INSERT OR IGNORE INTO user_preferences
           (user_id, default_range, email_notifications, weekly_digest, sidebar_collapsed, updated_at)
         VALUES (?, '30d', 1, 0, 0, ?)`,
      )
      .run(userId, new Date().toISOString());
  }

  get(userId: string): Preferences {
    this.#ensure(userId);
    const row = this.#db
      .stmt('SELECT * FROM user_preferences WHERE user_id = ?')
      .get(userId) as unknown as PreferenceRow;
    return {
      defaultRange: row.default_range as Preferences['defaultRange'],
      emailNotifications: row.email_notifications === 1,
      weeklyDigest: row.weekly_digest === 1,
      sidebarCollapsed: row.sidebar_collapsed === 1,
      updatedAt: row.updated_at,
      version: Number(row.version),
    };
  }

  update(
    userId: string,
    patch: Partial<Preferences>,
    expectedVersion?: number,
  ): Preferences | null {
    this.#ensure(userId);
    const sets = ['updated_at = ?', 'version = version + 1'];
    const params: (string | number)[] = [new Date().toISOString()];

    if (patch.defaultRange !== undefined) {
      sets.push('default_range = ?');
      params.push(patch.defaultRange);
    }
    if (patch.emailNotifications !== undefined) {
      sets.push('email_notifications = ?');
      params.push(patch.emailNotifications ? 1 : 0);
    }
    if (patch.weeklyDigest !== undefined) {
      sets.push('weekly_digest = ?');
      params.push(patch.weeklyDigest ? 1 : 0);
    }
    if (patch.sidebarCollapsed !== undefined) {
      sets.push('sidebar_collapsed = ?');
      params.push(patch.sidebarCollapsed ? 1 : 0);
    }

    params.push(userId);
    const guard = expectedVersion === undefined ? '' : ' AND version = ?';
    if (expectedVersion !== undefined) params.push(expectedVersion);
    const result = this.#db
      .stmt(`UPDATE user_preferences SET ${sets.join(', ')} WHERE user_id = ?${guard}`)
      .run(...params);
    return Number(result.changes) === 0 ? null : this.get(userId);
  }
}

export type AuditInput = {
  actor: UserOption | null;
  action: string;
  target?: string | null;
  ip?: string | null;
  detail?: Record<string, unknown>;
};

export type AuditFilters = {
  q?: string;
  action?: string;
  actor?: string;
  /** Inclusive ISO timestamp lower / upper bounds. */
  from?: string;
  to?: string;
};

export type AuditListInput = AuditFilters & { page: number; pageSize: number };

type AuditRow = {
  seq: number;
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  target: string | null;
  ip: string | null;
  detail: string;
  created_at: string;
};

export class AuditStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  get retention(): AuditRetention {
    return { maxRows: MAX_AUDIT_ROWS, days: AUDIT_RETENTION_DAYS };
  }

  record(input: AuditInput): void {
    const result = this.#db
      .stmt(
        'INSERT INTO audit_log (actor_id, action, target, ip, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.actor?.id ?? null,
        input.action,
        input.target ?? null,
        input.ip ?? null,
        JSON.stringify(input.detail ?? {}),
        new Date().toISOString(),
      );
    const seq = Number(result.lastInsertRowid);
    this.#db.stmt('DELETE FROM audit_log WHERE seq <= ?').run(seq - MAX_AUDIT_ROWS);
  }

  #where(
    filters: AuditFilters,
    { skipAction = false } = {},
  ): {
    clause: string;
    params: (string | number)[];
  } {
    const clauses: string[] = [];
    const params: (string | number)[] = [];

    const q = filters.q?.trim();
    if (q) {
      const pattern = `%${escapeLike(q)}%`;
      clauses.push(
        `(a.action LIKE ? ESCAPE '\\' OR a.target LIKE ? ESCAPE '\\' OR a.detail LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')`,
      );
      params.push(pattern, pattern, pattern, pattern, pattern);
    }
    if (!skipAction && filters.action && filters.action !== 'all') {
      clauses.push('a.action = ?');
      params.push(filters.action);
    }
    if (filters.actor && filters.actor !== 'all') {
      clauses.push('a.actor_id = ?');
      params.push(filters.actor);
    }
    if (filters.from) {
      clauses.push('a.created_at >= ?');
      params.push(filters.from);
    }
    if (filters.to) {
      clauses.push('a.created_at <= ?');
      params.push(filters.to);
    }

    return {
      clause: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '',
      params,
    };
  }

  #map(row: AuditRow): AuditEntry {
    let detail: unknown = {};
    try {
      detail = JSON.parse(row.detail) as unknown;
    } catch {
      detail = {};
    }
    return {
      seq: Number(row.seq),
      actorId: row.actor_id,
      actorName: row.actor_name,
      action: row.action,
      target: row.target,
      ip: row.ip,
      detail,
      createdAt: row.created_at,
    };
  }

  #select(filters: AuditFilters, limit: number, offset = 0): AuditEntry[] {
    const { clause, params } = this.#where(filters);
    const rows = this.#db
      .stmt(
        `SELECT a.seq, a.actor_id, a.action, a.target, a.ip, a.detail, a.created_at,
                u.name AS actor_name
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id${clause}
         ORDER BY a.seq DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as unknown as AuditRow[];
    return rows.map((row) => this.#map(row));
  }

  count(filters: AuditFilters = {}): number {
    const { clause, params } = this.#where(filters);
    const row = this.#db
      .stmt(
        `SELECT COUNT(*) AS total FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id${clause}`,
      )
      .get(...params) as unknown as { total: number };
    return Number(row.total);
  }

  actions(): AuditActionCount[] {
    const rows = this.#db
      .stmt('SELECT action, COUNT(*) AS count FROM audit_log GROUP BY action ORDER BY action')
      .all() as unknown as { action: string; count: number }[];
    return rows.map((row) => ({ action: row.action, count: Number(row.count) }));
  }

  page(input: AuditListInput): {
    entries: AuditEntry[];
    total: number;
    page: number;
    pageSize: number;
    actions: AuditActionCount[];
  } {
    const total = this.count(input);
    const offset = (input.page - 1) * input.pageSize;
    return {
      entries: this.#select(input, input.pageSize, offset),
      total,
      page: input.page,
      pageSize: input.pageSize,
      actions: this.actions(),
    };
  }

  exportRows(filters: AuditFilters = {}, limit = 1000): AuditEntry[] {
    return this.#select(filters, limit);
  }

  cleanup(days: number): number {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const result = this.#db.stmt('DELETE FROM audit_log WHERE created_at < ?').run(cutoff);
    return Number(result.changes);
  }

  list(limit = 100): AuditEntry[] {
    return this.#select({}, limit);
  }
}
