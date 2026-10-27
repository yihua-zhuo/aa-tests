import { permissionsForRole, sanitizePermissions } from '../../shared/permissions.ts';
import type {
  Role,
  SessionInfo,
  SessionUser,
  User,
  UserDirectoryEntry,
  UserListResult,
  UserOption,
  UserStatus,
} from '../../shared/types.ts';
import { type Database, escapeLike } from '../db.ts';
import { ftsMatch, searchTerms } from '../search.ts';

type UserRow = {
  id: string;
  email: string;
  name: string;
  role: string;
  password_hash: string;
  status: string;
  is_demo: number;
  timezone: string;
  workspace_id: string | null;
  custom_role_id: string | null;
  mfa_secret: string | null;
  mfa_enabled: number;
  mfa_recovery: string;
  avatar_url: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
};

export type AuthUser = User & {
  passwordHash: string;
  mfaEnabled: boolean;
  mfaSecret: string | null;
  mfaRecovery: string[];
};

export type UserUpdateResult =
  | { status: 'ok'; user: User }
  | { status: 'conflict'; current: User }
  | { status: 'missing' };

function parseRecovery(raw: string): string[] {
  try {
    const values = JSON.parse(raw) as unknown;
    return Array.isArray(values)
      ? values.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}

const DIRECTORY_COLUMNS = `id, name, email, role, status, is_demo, avatar_url, workspace_id,
  custom_role_id,
  (SELECT name FROM custom_roles cr WHERE cr.id = users.custom_role_id) AS custom_role_name,
  created_at, last_login_at, version`;

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as Role,
    status: row.status as UserStatus,
    isDemo: row.is_demo === 1,
    timezone: row.timezone,
    avatarUrl: row.avatar_url,
    workspaceId: row.workspace_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
    version: Number(row.version),
  };
}

function toDirectory(row: {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  is_demo: number;
  avatar_url: string | null;
  workspace_id?: string | null;
  custom_role_id?: string | null;
  custom_role_name?: string | null;
  created_at: string;
  last_login_at: string | null;
  version: number;
}): UserDirectoryEntry {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role as Role,
    status: row.status as UserStatus,
    isDemo: row.is_demo === 1,
    avatarUrl: row.avatar_url,
    workspaceId: row.workspace_id ?? undefined,
    customRoleId: row.custom_role_id ?? null,
    customRoleName: row.custom_role_name ?? null,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    version: Number(row.version),
  };
}

export class UsersStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  findById(id: string): User | null {
    const row = this.#db.stmt('SELECT * FROM users WHERE id = ?').get(id) as unknown as
      | UserRow
      | undefined;
    return row ? toUser(row) : null;
  }

  allByEmail(): Map<string, User> {
    const rows = this.#db.stmt('SELECT * FROM users').all() as unknown as UserRow[];
    return new Map(rows.map((row) => [row.email.toLowerCase(), toUser(row)]));
  }

  authByEmail(email: string): AuthUser | null {
    const row = this.#db
      .stmt('SELECT * FROM users WHERE email = ? COLLATE NOCASE')
      .get(email) as unknown as UserRow | undefined;
    return row
      ? {
          ...toUser(row),
          passwordHash: row.password_hash,
          mfaEnabled: row.mfa_enabled === 1,
          mfaSecret: row.mfa_secret,
          mfaRecovery: parseRecovery(row.mfa_recovery),
        }
      : null;
  }

  findSessionUser(id: string): SessionUser | null {
    const row = this.#db
      .stmt(
        `SELECT u.id, u.email, u.name, u.role, u.timezone, u.avatar_url,
                w.id AS workspace_id, w.name AS workspace_name,
                cr.id AS custom_role_id, cr.name AS custom_role_name,
                cr.base_role AS custom_role_base, cr.permissions AS custom_role_permissions
         FROM users u
         LEFT JOIN workspaces w ON w.id = u.workspace_id
         LEFT JOIN custom_roles cr ON cr.id = u.custom_role_id
         WHERE u.id = ?`,
      )
      .get(id) as unknown as SessionUserRow | undefined;
    if (!row) return null;
    const now = new Date().toISOString();
    const jitRows = this.#db
      .stmt(
        `SELECT permissions_json FROM jit_grants
         WHERE user_id = ? AND status = 'active' AND starts_at <= ? AND expires_at > ?`,
      )
      .all(id, now, now) as unknown as { permissions_json: string }[];
    const jit: string[] = [];
    for (const grant of jitRows) {
      try {
        jit.push(...sanitizePermissions(JSON.parse(grant.permissions_json)));
      } catch {
        // malformed grant permissions are ignored
      }
    }
    return toSessionUser(row, jit);
  }

  list(filters: {
    q?: string;
    role: Role | 'all';
    status: UserStatus | 'all';
    workspaceId?: string;
    page: number;
    pageSize: number;
  }): UserListResult {
    const match = filters.q ? ftsMatch(filters.q) : null;
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (filters.workspaceId) {
      where.push('workspace_id = ?');
      params.push(filters.workspaceId);
    }

    if (filters.q && !match) {
      for (const term of searchTerms(filters.q)) {
        where.push("(name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')");
        const like = `%${escapeLike(term)}%`;
        params.push(like, like);
      }
    }
    if (filters.role !== 'all') {
      where.push('role = ?');
      params.push(filters.role);
    }
    if (filters.status !== 'all') {
      where.push('status = ?');
      params.push(filters.status);
    }

    const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    const ftsClause = match
      ? ` WHERE users.rowid IN (
            SELECT rowid FROM users_fts WHERE users_fts MATCH ?
          )${where.length > 0 ? ` AND ${where.join(' AND ')}` : ''}`
      : clause;
    const totalRow = this.#db
      .stmt(`SELECT COUNT(*) AS total FROM users${ftsClause}`)
      .get(...(match ? [match, ...params] : params)) as unknown as { total: number };

    const from = match
      ? `users JOIN (
           SELECT rowid AS fts_rowid, bm25(users_fts) AS fts_rank
           FROM users_fts WHERE users_fts MATCH ?
         ) fts ON fts.fts_rowid = users.rowid`
      : 'users';
    const order = match
      ? 'fts.fts_rank ASC, users.name COLLATE NOCASE ASC'
      : 'created_at ASC, name COLLATE NOCASE ASC';
    const rows = this.#db
      .stmt(
        `SELECT ${DIRECTORY_COLUMNS} FROM ${from}${clause}
         ORDER BY ${order}
         LIMIT ? OFFSET ?`,
      )
      .all(
        ...(match ? [match, ...params] : params),
        filters.pageSize,
        (filters.page - 1) * filters.pageSize,
      ) as unknown as {
      id: string;
      name: string;
      email: string;
      role: string;
      status: string;
      is_demo: number;
      avatar_url: string | null;
      created_at: string;
      last_login_at: string | null;
      version: number;
    }[];

    const statsClause = filters.workspaceId ? ' WHERE workspace_id = ?' : '';
    const stats = this.#db
      .stmt(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(status = 'active'), 0) AS active,
                COALESCE(SUM(status = 'disabled'), 0) AS disabled,
                COALESCE(SUM(role = 'admin'), 0) AS admins
         FROM users${statsClause}`,
      )
      .get(...(filters.workspaceId ? [filters.workspaceId] : [])) as unknown as {
      total: number;
      active: number;
      disabled: number;
      admins: number;
    };

    return {
      users: rows.map(toDirectory),
      total: Number(totalRow.total),
      page: filters.page,
      pageSize: filters.pageSize,
      counts: {
        total: Number(stats.total),
        active: Number(stats.active),
        disabled: Number(stats.disabled),
        admins: Number(stats.admins),
      },
    };
  }

  options(workspaceId?: string): UserOption[] {
    const rows = this.#db
      .stmt(
        `SELECT id, name FROM users WHERE status = 'active'
         ${workspaceId ? 'AND workspace_id = ?' : ''}
         ORDER BY name COLLATE NOCASE`,
      )
      .all(...(workspaceId ? [workspaceId] : [])) as unknown as { id: string; name: string }[];
    return rows.map((row) => ({ id: row.id, name: row.name }));
  }

  create(input: {
    id?: string;
    email: string;
    name: string;
    role: Role;
    passwordHash: string;
    timezone?: string;
    isDemo?: boolean;
    workspaceId?: string;
    customRoleId?: string | null;
  }): { ok: true; user: User } | { ok: false; reason: 'duplicate' } {
    const now = new Date().toISOString();
    const id = input.id ?? crypto.randomUUID();
    const workspaceId =
      input.workspaceId ??
      (
        this.#db
          .stmt("SELECT id FROM workspaces ORDER BY id = 'ws_default' DESC LIMIT 1")
          .get() as unknown as { id: string } | undefined
      )?.id ??
      'ws_default';
    try {
      this.#db
        .stmt(
          `INSERT INTO users
             (id, email, name, role, workspace_id, custom_role_id, password_hash, status,
              is_demo, timezone, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.email,
          input.name,
          input.role,
          workspaceId,
          input.customRoleId ?? null,
          input.passwordHash,
          input.isDemo ? 1 : 0,
          input.timezone ?? 'Asia/Shanghai',
          now,
          now,
        );
    } catch (error) {
      if (error instanceof Error && /UNIQUE|constraint/i.test(error.message)) {
        return { ok: false, reason: 'duplicate' };
      }
      throw error;
    }
    const user = this.findById(id);
    if (!user) throw new Error('user creation failed');
    return { ok: true, user };
  }

  update(
    id: string,
    patch: {
      name?: string;
      role?: Role;
      status?: UserStatus;
      timezone?: string;
      workspaceId?: string;
      customRoleId?: string | null;
    },
    expectedVersion?: number,
  ): UserUpdateResult {
    const sets = ['updated_at = ?', 'version = version + 1'];
    const params: (string | number | null)[] = [new Date().toISOString()];

    if (patch.name !== undefined) {
      sets.push('name = ?');
      params.push(patch.name);
    }
    if (patch.role !== undefined) {
      sets.push('role = ?');
      params.push(patch.role);
    }
    if (patch.status !== undefined) {
      sets.push('status = ?');
      params.push(patch.status);
    }
    if (patch.timezone !== undefined) {
      sets.push('timezone = ?');
      params.push(patch.timezone);
    }
    if (patch.workspaceId !== undefined) {
      sets.push('workspace_id = ?');
      params.push(patch.workspaceId);
    }
    if (patch.customRoleId !== undefined) {
      sets.push('custom_role_id = ?');
      params.push(patch.customRoleId);
    }

    params.push(id);
    const guard = expectedVersion === undefined ? '' : ' AND version = ?';
    if (expectedVersion !== undefined) params.push(expectedVersion);
    const result = this.#db
      .stmt(`UPDATE users SET ${sets.join(', ')} WHERE id = ?${guard}`)
      .run(...params);
    if (Number(result.changes) === 0) {
      const current = this.findById(id);
      return current ? { status: 'conflict', current } : { status: 'missing' };
    }
    const user = this.findById(id);
    return user ? { status: 'ok', user } : { status: 'missing' };
  }

  setEmail(id: string, email: string): 'ok' | 'duplicate' {
    try {
      this.#db
        .stmt('UPDATE users SET email = ?, version = version + 1, updated_at = ? WHERE id = ?')
        .run(email, new Date().toISOString(), id);
      return 'ok';
    } catch (error) {
      if (error instanceof Error && /UNIQUE|constraint/i.test(error.message)) return 'duplicate';
      throw error;
    }
  }

  /** Another active admin in the same workspace, used when an owner deletes their account. */
  fallbackAdmin(excludeId: string, workspaceId?: string): User | null {
    const row = this.#db
      .stmt(
        `SELECT * FROM users
         WHERE role = 'admin' AND status = 'active' AND id <> ?
         ORDER BY (workspace_id = ?) DESC, created_at ASC
         LIMIT 1`,
      )
      .get(excludeId, workspaceId ?? '') as unknown as UserRow | undefined;
    if (!row || (workspaceId && (row.workspace_id ?? '') !== workspaceId)) return null;
    return toUser(row);
  }

  setPassword(id: string, passwordHash: string): void {
    this.#db
      .stmt('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(passwordHash, new Date().toISOString(), id);
  }

  setMfaSecret(id: string, secret: string, recoveryHashes: string[] = []): void {
    this.#db
      .stmt(
        'UPDATE users SET mfa_secret = ?, mfa_enabled = 0, mfa_recovery = ?, updated_at = ? WHERE id = ?',
      )
      .run(secret, JSON.stringify(recoveryHashes), new Date().toISOString(), id);
  }

  enableMfa(id: string): void {
    this.#db
      .stmt('UPDATE users SET mfa_enabled = 1, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  }

  disableMfa(id: string): void {
    this.#db
      .stmt(
        "UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_recovery = '[]', updated_at = ? WHERE id = ?",
      )
      .run(new Date().toISOString(), id);
  }

  /** Removes and reports whether a recovery code matched. */
  consumeRecoveryCode(id: string, codeHash: string): boolean {
    const row = this.#db.stmt('SELECT mfa_recovery FROM users WHERE id = ?').get(id) as unknown as
      | { mfa_recovery: string }
      | undefined;
    if (!row) return false;
    const codes = parseRecovery(row.mfa_recovery);
    if (!codes.includes(codeHash)) return false;
    this.#db
      .stmt('UPDATE users SET mfa_recovery = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(codes.filter((code) => code !== codeHash)), new Date().toISOString(), id);
    return true;
  }

  mfaEnabled(id: string): boolean {
    const row = this.#db.stmt('SELECT mfa_enabled FROM users WHERE id = ?').get(id) as unknown as
      | { mfa_enabled: number }
      | undefined;
    return row?.mfa_enabled === 1;
  }

  setAvatar(id: string, avatarUrl: string | null): void {
    this.#db
      .stmt('UPDATE users SET avatar_url = ?, updated_at = ? WHERE id = ?')
      .run(avatarUrl, new Date().toISOString(), id);
  }

  touchLogin(id: string, at: string): void {
    this.#db.stmt('UPDATE users SET last_login_at = ? WHERE id = ?').run(at, id);
  }

  count(): number {
    const row = this.#db.stmt('SELECT COUNT(*) AS total FROM users').get() as unknown as {
      total: number;
    };
    return Number(row.total);
  }

  activeAdmins(excludeId?: string, exclude?: (email: string) => boolean): number {
    const rows = this.#db
      .stmt("SELECT email FROM users WHERE role = 'admin' AND status = 'active' AND id != ?")
      .all(excludeId ?? '') as unknown as { email: string }[];
    return exclude ? rows.filter((row) => !exclude(row.email)).length : rows.length;
  }
}

type SessionUserRow = {
  id: string;
  email: string;
  name: string;
  role: string;
  timezone: string;
  avatar_url: string | null;
  workspace_id: string | null;
  workspace_name: string | null;
  custom_role_id: string | null;
  custom_role_name: string | null;
  custom_role_base: string | null;
  custom_role_permissions: string | null;
};

type SessionRow = SessionUserRow & {
  user_id: string;
  expires_at: string;
  last_seen_at: string;
  status: string;
};

function parsePermissionList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    return sanitizePermissions(JSON.parse(raw));
  } catch {
    return [];
  }
}

function toSessionUser(row: SessionUserRow, jit: readonly string[] = []): SessionUser {
  const role = row.role as Role;
  const jitPermissions = sanitizePermissions(jit);
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role,
    timezone: row.timezone,
    avatarUrl: row.avatar_url,
    workspaceId: row.workspace_id ?? 'ws_default',
    workspaceName: row.workspace_name ?? '默认工作区',
    permissions: permissionsForRole(role, [
      ...parsePermissionList(row.custom_role_permissions),
      ...jitPermissions,
    ]),
    jitPermissions,
    customRole: row.custom_role_id
      ? {
          id: row.custom_role_id,
          name: row.custom_role_name ?? '自定义角色',
          baseRole: (row.custom_role_base as Role | null) ?? role,
        }
      : null,
  };
}

export type SessionLookup = {
  expiresAt: string;
  lastSeenAt: string;
  user: SessionUser;
  status: UserStatus;
};

export class SessionsStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  create(input: {
    tokenHash: string;
    userId: string;
    createdAt: string;
    expiresAt: string;
    ip: string | null;
    userAgent: string | null;
  }): void {
    this.#db
      .stmt(
        `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.tokenHash,
        input.userId,
        input.createdAt,
        input.expiresAt,
        input.createdAt,
        input.ip,
        input.userAgent,
      );
  }

  find(tokenHash: string, now = new Date().toISOString(), idleMs = 0): SessionLookup | null {
    const row = this.#db
      .stmt(
        `SELECT s.user_id, s.expires_at, s.last_seen_at,
                u.id, u.email, u.name, u.role, u.timezone, u.status, u.avatar_url,
                w.id AS workspace_id, w.name AS workspace_name,
                cr.id AS custom_role_id, cr.name AS custom_role_name,
                cr.base_role AS custom_role_base, cr.permissions AS custom_role_permissions
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN workspaces w ON w.id = u.workspace_id
         LEFT JOIN custom_roles cr ON cr.id = u.custom_role_id
         WHERE s.token_hash = ?`,
      )
      .get(tokenHash) as unknown as SessionRow | undefined;
    if (!row) return null;
    if (row.expires_at <= now) {
      this.revoke(tokenHash);
      return null;
    }
    if (idleMs > 0 && Date.parse(row.last_seen_at) + idleMs <= Date.parse(now)) {
      this.revoke(tokenHash);
      return null;
    }
    return {
      expiresAt: row.expires_at,
      lastSeenAt: row.last_seen_at,
      status: row.status as UserStatus,
      user: toSessionUser(row),
    };
  }

  touch(tokenHash: string, at = new Date().toISOString()): void {
    this.#db.stmt('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(at, tokenHash);
  }

  revoke(tokenHash: string): void {
    this.#db.stmt('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  revokeUser(userId: string): number {
    const result = this.#db.stmt('DELETE FROM sessions WHERE user_id = ?').run(userId);
    return Number(result.changes);
  }

  listForUser(userId: string, currentHash: string | undefined): SessionInfo[] {
    const rows = this.#db
      .stmt(
        `SELECT token_hash, created_at, last_seen_at, expires_at, ip, user_agent
         FROM sessions WHERE user_id = ? AND expires_at > ?
         ORDER BY last_seen_at DESC`,
      )
      .all(userId, new Date().toISOString()) as unknown as {
      token_hash: string;
      created_at: string;
      last_seen_at: string;
      expires_at: string;
      ip: string | null;
      user_agent: string | null;
    }[];
    return rows.map((row) => ({
      id: row.token_hash.slice(0, 16),
      current: row.token_hash === currentHash,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
      ip: row.ip,
      userAgent: row.user_agent,
    }));
  }

  /** Revoke one session by its public prefix; returns the full hashes removed. */
  revokeById(userId: string, id: string): string[] {
    const rows = this.#db
      .stmt(
        `SELECT token_hash FROM sessions
         WHERE user_id = ? AND substr(token_hash, 1, 16) = ?`,
      )
      .all(userId, id) as unknown as { token_hash: string }[];
    if (rows.length !== 1) return [];
    const hash = rows[0]?.token_hash;
    if (!hash) return [];
    this.#db.stmt('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    return [hash];
  }

  revokeOthers(userId: string, keepHash: string): string[] {
    const rows = this.#db
      .stmt('SELECT token_hash FROM sessions WHERE user_id = ? AND token_hash != ?')
      .all(userId, keepHash) as unknown as { token_hash: string }[];
    this.#db
      .stmt('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?')
      .run(userId, keepHash);
    return rows.map((row) => row.token_hash);
  }

  cleanup(now = new Date().toISOString()): number {
    const result = this.#db.stmt('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    return Number(result.changes);
  }

  count(): number {
    const row = this.#db.stmt('SELECT COUNT(*) AS total FROM sessions').get() as unknown as {
      total: number;
    };
    return Number(row.total);
  }
}

export class MfaChallengesStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  create(input: { tokenHash: string; userId: string; expiresAt: string; createdAt: string }): void {
    this.#db
      .stmt(
        `INSERT INTO mfa_challenges (token_hash, user_id, expires_at, attempts, created_at)
         VALUES (?, ?, ?, 0, ?)`,
      )
      .run(input.tokenHash, input.userId, input.expiresAt, input.createdAt);
  }

  find(
    tokenHash: string,
    now = new Date().toISOString(),
  ): { userId: string; attempts: number } | null {
    const row = this.#db
      .stmt('SELECT user_id, attempts, expires_at FROM mfa_challenges WHERE token_hash = ?')
      .get(tokenHash) as unknown as
      | { user_id: string; attempts: number; expires_at: string }
      | undefined;
    if (!row) return null;
    if (row.expires_at <= now) {
      this.#db.stmt('DELETE FROM mfa_challenges WHERE token_hash = ?').run(tokenHash);
      return null;
    }
    return { userId: row.user_id, attempts: Number(row.attempts) };
  }

  fail(tokenHash: string): number {
    this.#db
      .stmt('UPDATE mfa_challenges SET attempts = attempts + 1 WHERE token_hash = ?')
      .run(tokenHash);
    const row = this.#db
      .stmt('SELECT attempts FROM mfa_challenges WHERE token_hash = ?')
      .get(tokenHash) as unknown as { attempts: number } | undefined;
    return Number(row?.attempts ?? 0);
  }

  remove(tokenHash: string): void {
    this.#db.stmt('DELETE FROM mfa_challenges WHERE token_hash = ?').run(tokenHash);
  }

  cleanup(now = new Date().toISOString()): number {
    const result = this.#db.stmt('DELETE FROM mfa_challenges WHERE expires_at <= ?').run(now);
    return Number(result.changes);
  }
}

/**
 * Single-use, expiring password-reset tokens. Only the SHA-256 hash is stored;
 * requesting a new token invalidates any earlier one for the same account.
 */
export class PasswordResetsStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  create(input: {
    tokenHash: string;
    userId: string;
    expiresAt: string;
    ip?: string | null;
    createdAt?: string;
  }): void {
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.#db.transaction(() => {
      this.#db.stmt('DELETE FROM password_resets WHERE user_id = ?').run(input.userId);
      this.#db
        .stmt(
          `INSERT INTO password_resets (token_hash, user_id, expires_at, ip, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.tokenHash, input.userId, input.expiresAt, input.ip ?? null, createdAt);
    });
  }

  find(tokenHash: string, now = new Date().toISOString()): { userId: string } | null {
    const row = this.#db
      .stmt('SELECT user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?')
      .get(tokenHash) as unknown as
      | { user_id: string; expires_at: string; used_at: string | null }
      | undefined;
    if (!row) return null;
    if (row.used_at !== null || row.expires_at <= now) {
      if (row.expires_at <= now) {
        this.#db.stmt('DELETE FROM password_resets WHERE token_hash = ?').run(tokenHash);
      }
      return null;
    }
    return { userId: row.user_id };
  }

  consume(tokenHash: string, now = new Date().toISOString()): string | null {
    const result = this.#db
      .stmt(
        'UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?',
      )
      .run(now, tokenHash, now);
    if (Number(result.changes) === 0) return null;
    const row = this.#db
      .stmt('SELECT user_id FROM password_resets WHERE token_hash = ?')
      .get(tokenHash) as unknown as { user_id: string } | undefined;
    return row?.user_id ?? null;
  }

  cleanup(now = new Date().toISOString()): number {
    const result = this.#db
      .stmt('DELETE FROM password_resets WHERE expires_at <= ? OR used_at IS NOT NULL')
      .run(now);
    return Number(result.changes);
  }
}
