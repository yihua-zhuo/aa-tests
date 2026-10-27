import {
  canViewAllProjects,
  permissionsForRole,
  sanitizePermissions,
} from '../../shared/permissions.ts';
import type {
  ActivityItem,
  ActivityPage,
  ActivityType,
  Role,
  UserOption,
} from '../../shared/types.ts';
import { type Database, escapeLike, MAX_ACTIVITIES } from '../db.ts';
import { ftsMatch, searchTerms } from '../search.ts';

type ActivityRow = {
  seq: number;
  type: string;
  actor_id: string | null;
  project_id: string | null;
  payload: string;
  created_at: string;
};

type Payload = {
  message?: string;
  actorName?: string | null;
  projectName?: string | null;
  [key: string]: unknown;
};

export type RecordActivityInput = {
  type: ActivityType;
  actor: UserOption | null;
  project?: { id: string; name: string } | null;
  message: string;
  meta?: Record<string, unknown>;
  createdAt?: string;
};

function parsePayload(raw: string): Payload {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' ? (value as Payload) : {};
  } catch {
    return {};
  }
}

function toItem(row: ActivityRow): ActivityItem {
  const payload = parsePayload(row.payload);
  return {
    seq: Number(row.seq),
    type: row.type as ActivityType,
    actor:
      row.actor_id && payload.actorName
        ? { id: row.actor_id, name: String(payload.actorName) }
        : null,
    project:
      row.project_id && payload.projectName
        ? { id: row.project_id, name: String(payload.projectName) }
        : null,
    message: payload.message ?? row.type,
    createdAt: row.created_at,
    meta: payload,
  };
}

export class ActivitiesStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  record(input: RecordActivityInput): ActivityItem {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const payload: Payload = {
      message: input.message,
      actorName: input.actor?.name ?? null,
      projectName: input.project?.name ?? null,
      ...(input.meta ?? {}),
    };
    const result = this.#db
      .stmt(
        'INSERT INTO activities (type, actor_id, project_id, payload, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        input.type,
        input.actor?.id ?? null,
        input.project?.id ?? null,
        JSON.stringify(payload),
        createdAt,
      );
    const seq = Number(result.lastInsertRowid);
    this.#db.stmt('DELETE FROM activities WHERE seq <= ?').run(seq - MAX_ACTIVITIES);
    return {
      seq,
      type: input.type,
      actor: input.actor,
      project: input.project ?? null,
      message: input.message,
      createdAt,
      meta: input.meta ?? null,
    };
  }

  cleanup(days: number, now = Date.now()): number {
    if (!Number.isFinite(days) || days <= 0) return 0;
    const cutoff = new Date(now - days * 86_400_000).toISOString();
    const result = this.#db.stmt('DELETE FROM activities WHERE created_at < ?').run(cutoff);
    return Number(result.changes);
  }

  #scope(role: Role, userId: string): { sql: string; params: string[] } {
    const viewer = this.#db
      .stmt(
        `SELECT u.workspace_id, cr.permissions
         FROM users u LEFT JOIN custom_roles cr ON cr.id = u.custom_role_id
         WHERE u.id = ?`,
      )
      .get(userId) as unknown as
      | { workspace_id: string | null; permissions: string | null }
      | undefined;
    const workspaceId = viewer?.workspace_id ?? 'ws_default';
    let extras: string[] = [];
    try {
      extras = sanitizePermissions(JSON.parse(viewer?.permissions ?? '[]'));
    } catch {
      extras = [];
    }
    const permissions = permissionsForRole(role, extras);
    const member = `(p.owner_id = ?
      OR EXISTS (
        SELECT 1 FROM project_members m
        WHERE m.project_id = p.id AND m.user_id = ?
      ))`;
    if (role === 'admin') {
      return {
        sql: `(a.project_id IS NULL OR a.project_id IN (
          SELECT p.id FROM projects p WHERE p.workspace_id = ?
        ))`,
        params: [workspaceId],
      };
    }
    if (canViewAllProjects(role, permissions)) {
      return {
        sql: `(a.project_id IS NULL OR a.project_id IN (
          SELECT p.id FROM projects p
          WHERE p.workspace_id = ? AND (p.visibility = 'workspace' OR ${member})
        ))`,
        params: [workspaceId, userId, userId],
      };
    }
    return {
      sql: `a.project_id IN (
        SELECT p.id FROM projects p WHERE p.workspace_id = ? AND ${member}
      )`,
      params: [workspaceId, userId, userId],
    };
  }

  page(
    role: Role,
    userId: string,
    options: { cursor?: number; limit?: number; projectId?: string; type?: string },
  ): ActivityPage {
    const limit = options.limit ?? 20;
    const scope = this.#scope(role, userId);
    const where: string[] = [scope.sql];
    const params: (string | number)[] = [...scope.params];

    if (options.cursor !== undefined) {
      where.push('a.seq < ?');
      params.push(options.cursor);
    }
    if (options.projectId) {
      where.push('a.project_id = ?');
      params.push(options.projectId);
    }
    if (options.type) {
      where.push('a.type = ?');
      params.push(options.type);
    }

    const rows = this.#db
      .stmt(
        `SELECT a.seq, a.type, a.actor_id, a.project_id, a.payload, a.created_at
         FROM activities a
         WHERE ${where.join(' AND ')}
         ORDER BY a.seq DESC
         LIMIT ?`,
      )
      .all(...params, limit) as unknown as ActivityRow[];

    return {
      activities: rows.map(toItem),
      nextCursor: rows.length === limit ? Number(rows[rows.length - 1]?.seq) : null,
    };
  }

  recent(role: Role, userId: string, limit = 8): ActivityItem[] {
    return this.page(role, userId, { limit }).activities;
  }

  latestSeq(): number {
    const row = this.#db
      .stmt('SELECT COALESCE(MAX(seq), 0) AS seq FROM activities')
      .get() as unknown as { seq: number };
    return Number(row.seq);
  }

  latest(): ActivityItem | null {
    const row = this.#db
      .stmt(
        `SELECT seq, type, actor_id, project_id, payload, created_at
         FROM activities ORDER BY seq DESC LIMIT 1`,
      )
      .get() as unknown as ActivityRow | undefined;
    return row ? toItem(row) : null;
  }

  search(role: Role, userId: string, query: string, limit = 6): ActivityItem[] {
    const scope = this.#scope(role, userId);
    const match = ftsMatch(query);
    if (match) {
      const rows = this.#db
        .stmt(
          `SELECT a.seq, a.type, a.actor_id, a.project_id, a.payload, a.created_at,
                  snippet(activities_fts, 0, '<mark>', '</mark>', '…', 12) AS highlight
           FROM activities_fts
           JOIN activities a ON a.seq = activities_fts.rowid
           WHERE ${scope.sql} AND activities_fts MATCH ?
           ORDER BY bm25(activities_fts), a.seq DESC LIMIT ?`,
        )
        .all(...scope.params, match, limit) as unknown as (ActivityRow & {
        highlight: string | null;
      })[];
      return rows.map((row) => ({ ...toItem(row), highlight: row.highlight }));
    }
    const terms = searchTerms(query);
    const where = terms.map(() => "a.payload LIKE ? ESCAPE '\\'").join(' AND ');
    const rows = this.#db
      .stmt(
        `SELECT a.seq, a.type, a.actor_id, a.project_id, a.payload, a.created_at
         FROM activities a
         WHERE ${scope.sql}${where ? ` AND ${where}` : ''}
         ORDER BY a.seq DESC LIMIT ?`,
      )
      .all(
        ...scope.params,
        ...terms.map((term) => `%${escapeLike(term)}%`),
        limit,
      ) as unknown as ActivityRow[];
    return rows.map(toItem);
  }

  since(seq: number, limit = MAX_ACTIVITIES): ActivityItem[] {
    const rows = this.#db
      .stmt(
        `SELECT seq, type, actor_id, project_id, payload, created_at
         FROM activities WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
      )
      .all(seq, limit) as unknown as ActivityRow[];
    return rows.map(toItem);
  }
}
