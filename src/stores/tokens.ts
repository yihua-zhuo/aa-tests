import { randomBytes } from 'node:crypto';
import { permissionsForRole, sanitizePermissions } from '../../shared/permissions.ts';
import type { PersonalAccessToken, Role, SessionUser, TokenScope } from '../../shared/types.ts';
import { hashToken } from '../auth.ts';
import type { Database } from '../db.ts';

const TOKEN_PREFIX = 'clp_';
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

type TokenRow = {
  id: string;
  name: string;
  scopes: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
};

type AuthRow = {
  id: string;
  scopes: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  user_id: string;
  email: string;
  name: string;
  role: string;
  timezone: string;
  status: string;
  avatar_url: string | null;
  workspace_id: string | null;
  workspace_name: string | null;
  custom_role_id: string | null;
  custom_role_name: string | null;
  custom_role_base: string | null;
  custom_role_permissions: string | null;
};

function parseScopes(raw: string): TokenScope[] {
  try {
    const values = JSON.parse(raw) as unknown;
    if (!Array.isArray(values)) return ['read'];
    const scopes = values.filter(
      (value): value is TokenScope => value === 'read' || value === 'write',
    );
    return scopes.length > 0 ? scopes : ['read'];
  } catch {
    return ['read'];
  }
}

function toToken(row: TokenRow, now: number): PersonalAccessToken {
  return {
    id: row.id,
    name: row.name,
    scopes: parseScopes(row.scopes),
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    expired: row.expires_at !== null && Date.parse(row.expires_at) <= now,
  };
}

export type TokenAuth = {
  tokenId: string;
  scopes: TokenScope[];
  user: SessionUser;
};

export class PersonalAccessTokensStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  list(userId: string): PersonalAccessToken[] {
    const now = Date.now();
    const rows = this.#db
      .stmt(
        `SELECT id, name, scopes, expires_at, last_used_at, created_at, revoked_at
         FROM personal_access_tokens WHERE user_id = ?
         ORDER BY created_at DESC LIMIT 100`,
      )
      .all(userId) as unknown as TokenRow[];
    return rows.map((row) => toToken(row, now));
  }

  create(
    userId: string,
    input: { name: string; scopes: TokenScope[]; expiresInDays: number | null },
    now = new Date(),
  ): { token: string; item: PersonalAccessToken } {
    const id = crypto.randomUUID();
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const createdAt = now.toISOString();
    const expiresAt =
      input.expiresInDays === null
        ? null
        : new Date(now.getTime() + input.expiresInDays * 24 * 60 * 60 * 1000).toISOString();
    const scopes = [...new Set(input.scopes)];
    this.#db
      .stmt(
        `INSERT INTO personal_access_tokens
           (id, user_id, name, token_hash, scopes, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, userId, input.name, hashToken(token), JSON.stringify(scopes), expiresAt, createdAt);
    return {
      token,
      item: toToken(
        {
          id,
          name: input.name,
          scopes: JSON.stringify(scopes),
          expires_at: expiresAt,
          last_used_at: null,
          created_at: createdAt,
          revoked_at: null,
        },
        now.getTime(),
      ),
    };
  }

  authenticate(tokenHash: string, now = new Date()): TokenAuth | null {
    const row = this.#db
      .stmt(
        `SELECT t.id, t.name, t.scopes, t.expires_at, t.last_used_at, t.created_at, t.revoked_at,
                u.id AS user_id, u.email, u.name, u.role, u.timezone, u.status, u.avatar_url,
                w.id AS workspace_id, w.name AS workspace_name,
                cr.id AS custom_role_id, cr.name AS custom_role_name,
                cr.base_role AS custom_role_base, cr.permissions AS custom_role_permissions
         FROM personal_access_tokens t
         JOIN users u ON u.id = t.user_id
         LEFT JOIN workspaces w ON w.id = u.workspace_id
         LEFT JOIN custom_roles cr ON cr.id = u.custom_role_id
         WHERE t.token_hash = ?`,
      )
      .get(tokenHash) as unknown as AuthRow | undefined;
    if (!row || row.revoked_at !== null || row.status !== 'active') return null;
    if (row.expires_at !== null && Date.parse(row.expires_at) <= now.getTime()) return null;

    const lastUsed = row.last_used_at === null ? 0 : Date.parse(row.last_used_at);
    if (now.getTime() - lastUsed > TOUCH_INTERVAL_MS) {
      this.#db
        .stmt('UPDATE personal_access_tokens SET last_used_at = ? WHERE id = ?')
        .run(now.toISOString(), row.id);
    }

    let extras: string[] = [];
    try {
      extras = sanitizePermissions(JSON.parse(row.custom_role_permissions ?? '[]'));
    } catch {
      extras = [];
    }
    const role = row.role as Role;
    return {
      tokenId: row.id,
      scopes: parseScopes(row.scopes),
      user: {
        id: row.user_id,
        email: row.email,
        name: row.name,
        role,
        timezone: row.timezone,
        avatarUrl: row.avatar_url,
        workspaceId: row.workspace_id ?? 'ws_default',
        workspaceName: row.workspace_name ?? '默认工作区',
        permissions: permissionsForRole(role, extras),
        customRole: row.custom_role_id
          ? {
              id: row.custom_role_id,
              name: row.custom_role_name ?? '自定义角色',
              baseRole: (row.custom_role_base as Role | null) ?? role,
            }
          : null,
      },
    };
  }

  revoke(userId: string, id: string, now = new Date()): boolean {
    const result = this.#db
      .stmt(
        `UPDATE personal_access_tokens SET revoked_at = ?
         WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
      )
      .run(now.toISOString(), id, userId);
    return Number(result.changes) > 0;
  }

  count(userId: string): number {
    const row = this.#db
      .stmt(
        `SELECT COUNT(*) AS total FROM personal_access_tokens
         WHERE user_id = ? AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .get(userId, new Date().toISOString()) as unknown as { total: number };
    return Number(row.total);
  }
}
