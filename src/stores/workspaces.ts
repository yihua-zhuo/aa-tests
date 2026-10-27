import { sanitizePermissions } from '../../shared/permissions.ts';
import type { CustomRole, Role, WorkspaceSummary } from '../../shared/types.ts';
import type { Database } from '../db.ts';

export const DEFAULT_WORKSPACE_ID = 'ws_default';

type RoleRow = {
  id: string;
  workspace_id: string;
  name: string;
  base_role: string;
  permissions: string;
  created_at: string;
  updated_at: string;
  member_count?: number;
};

function toRole(row: RoleRow): CustomRole {
  let parsed: unknown = [];
  try {
    parsed = JSON.parse(row.permissions);
  } catch {
    parsed = [];
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    baseRole: row.base_role as Role,
    permissions: sanitizePermissions(parsed),
    memberCount: Number(row.member_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type CustomRoleResult =
  | { status: 'ok'; role: CustomRole }
  | { status: 'duplicate' }
  | { status: 'missing' };

export class WorkspacesStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  defaultId(): string {
    const row = this.#db
      .stmt(
        "SELECT id FROM workspaces WHERE id = ? OR slug = 'default' ORDER BY id = 'ws_default' DESC LIMIT 1",
      )
      .get(DEFAULT_WORKSPACE_ID) as unknown as { id: string } | undefined;
    return row?.id ?? DEFAULT_WORKSPACE_ID;
  }

  /** Assigns legacy users and projects to the default workspace. */
  backfill(): void {
    const fallback = this.defaultId();
    this.#db.stmt('UPDATE users SET workspace_id = ? WHERE workspace_id IS NULL').run(fallback);
    this.#db
      .stmt(
        `UPDATE projects
         SET workspace_id = COALESCE(
           (SELECT workspace_id FROM users u WHERE u.id = projects.owner_id),
           ?
         )
         WHERE workspace_id IS NULL`,
      )
      .run(fallback);
  }

  get(id: string): WorkspaceSummary | null {
    const row = this.#db
      .stmt(
        `SELECT w.id, w.name, w.created_at,
                (SELECT COUNT(*) FROM users u WHERE u.workspace_id = w.id) AS member_count,
                (SELECT COUNT(*) FROM projects p
                  WHERE p.workspace_id = w.id AND p.deleted_at IS NULL) AS project_count
         FROM workspaces w WHERE w.id = ?`,
      )
      .get(id) as unknown as
      | {
          id: string;
          name: string;
          created_at: string;
          member_count: number;
          project_count: number;
        }
      | undefined;
    return row
      ? {
          id: row.id,
          name: row.name,
          createdAt: row.created_at,
          memberCount: Number(row.member_count),
          projectCount: Number(row.project_count),
        }
      : null;
  }

  forUser(userId: string): WorkspaceSummary | null {
    const row = this.#db
      .stmt('SELECT workspace_id FROM users WHERE id = ?')
      .get(userId) as unknown as { workspace_id: string | null } | undefined;
    return row?.workspace_id ? this.get(row.workspace_id) : null;
  }

  list(): WorkspaceSummary[] {
    const rows = this.#db
      .stmt(
        `SELECT w.id, w.name, w.created_at,
                (SELECT COUNT(*) FROM users u WHERE u.workspace_id = w.id) AS member_count,
                (SELECT COUNT(*) FROM projects p
                  WHERE p.workspace_id = w.id AND p.deleted_at IS NULL) AS project_count
         FROM workspaces w ORDER BY w.created_at ASC, w.name COLLATE NOCASE`,
      )
      .all() as unknown as {
      id: string;
      name: string;
      created_at: string;
      member_count: number;
      project_count: number;
    }[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      memberCount: Number(row.member_count),
      projectCount: Number(row.project_count),
    }));
  }

  create(name: string): WorkspaceSummary {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.#db
      .stmt(
        `INSERT INTO workspaces (id, name, slug, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, name.trim(), id, now, now);
    const workspace = this.get(id);
    if (!workspace) throw new Error('workspace creation failed');
    return workspace;
  }

  rename(id: string, name: string): WorkspaceSummary | null {
    const result = this.#db
      .stmt('UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?')
      .run(name.trim(), new Date().toISOString(), id);
    return Number(result.changes) > 0 ? this.get(id) : null;
  }

  customRoles(workspaceId?: string): CustomRole[] {
    const rows = this.#db
      .stmt(
        `SELECT r.*,
                (SELECT COUNT(*) FROM users u WHERE u.custom_role_id = r.id) AS member_count
         FROM custom_roles r
         ${workspaceId ? 'WHERE r.workspace_id = ?' : ''}
         ORDER BY r.name COLLATE NOCASE`,
      )
      .all(...(workspaceId ? [workspaceId] : [])) as unknown as RoleRow[];
    return rows.map(toRole);
  }

  customRole(id: string): CustomRole | null {
    const row = this.#db
      .stmt(
        `SELECT r.*,
                (SELECT COUNT(*) FROM users u WHERE u.custom_role_id = r.id) AS member_count
         FROM custom_roles r WHERE r.id = ?`,
      )
      .get(id) as unknown as RoleRow | undefined;
    return row ? toRole(row) : null;
  }

  createCustomRole(
    workspaceId: string,
    input: { name: string; baseRole: Role; permissions: readonly string[] },
  ): CustomRoleResult {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    try {
      this.#db
        .stmt(
          `INSERT INTO custom_roles
             (id, workspace_id, name, base_role, permissions, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          workspaceId,
          input.name.trim(),
          input.baseRole,
          JSON.stringify(sanitizePermissions(input.permissions)),
          now,
          now,
        );
    } catch (error) {
      if (error instanceof Error && /UNIQUE|constraint/i.test(error.message)) {
        return { status: 'duplicate' };
      }
      throw error;
    }
    const role = this.customRole(id);
    return role ? { status: 'ok', role } : { status: 'missing' };
  }

  updateCustomRole(
    id: string,
    patch: { name?: string; baseRole?: Role; permissions?: readonly string[] },
  ): CustomRoleResult {
    const current = this.customRole(id);
    if (!current) return { status: 'missing' };
    try {
      this.#db
        .stmt(
          `UPDATE custom_roles
           SET name = ?, base_role = ?, permissions = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          patch.name?.trim() ?? current.name,
          patch.baseRole ?? current.baseRole,
          JSON.stringify(
            patch.permissions ? sanitizePermissions(patch.permissions) : current.permissions,
          ),
          new Date().toISOString(),
          id,
        );
    } catch (error) {
      if (error instanceof Error && /UNIQUE|constraint/i.test(error.message)) {
        return { status: 'duplicate' };
      }
      throw error;
    }
    if (patch.baseRole && patch.baseRole !== current.baseRole) {
      this.#db
        .stmt('UPDATE users SET role = ?, updated_at = ? WHERE custom_role_id = ?')
        .run(patch.baseRole, new Date().toISOString(), id);
    }
    const role = this.customRole(id);
    return role ? { status: 'ok', role } : { status: 'missing' };
  }

  deleteCustomRole(id: string): boolean {
    return this.#db.transaction(() => {
      this.#db
        .stmt('UPDATE users SET custom_role_id = NULL, updated_at = ? WHERE custom_role_id = ?')
        .run(new Date().toISOString(), id);
      const result = this.#db.stmt('DELETE FROM custom_roles WHERE id = ?').run(id);
      return Number(result.changes) > 0;
    });
  }
}
