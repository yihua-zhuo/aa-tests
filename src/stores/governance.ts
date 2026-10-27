import {
  canAccessProject,
  canManageProject,
  canManageWorkspace,
  canViewAllProjects,
  hasPermission,
  PERMISSION_LABELS,
  type Permission,
  permissionsForRole,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  sanitizePermissions,
} from '../../shared/permissions.ts';
import type {
  JitGrant,
  PermissionSimulationInput,
  PermissionSimulationResult,
  PermissionSource,
  SessionUser,
} from '../../shared/types.ts';
import type { Database } from '../db.ts';
import type { UsersStore } from './users.ts';

type ProjectRow = {
  id: string;
  workspace_id: string;
  name: string;
  owner_id: string;
  visibility: string;
};

type JitRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  user_name: string;
  resource_type: string;
  resource_id: string;
  action: string;
  permissions_json: string;
  reason: string;
  status: string;
  requested_by_name: string | null;
  approved_by_name: string | null;
  starts_at: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
  updated_at: string;
};

export type JitCreateInput = {
  userId?: string;
  permissions: string[];
  resourceType: 'workspace' | 'project' | 'task';
  resourceId?: string;
  action?: string;
  reason: string;
  durationMinutes: number;
  startsAt?: string;
};

type JitResult =
  | { status: 'ok'; grant: JitGrant }
  | { status: 'missing' }
  | { status: 'invalid'; message: string }
  | { status: 'conflict'; current: JitGrant };

const ACTION_PERMISSIONS: Record<string, Permission> = {
  'project.create': 'projects.create',
  'projects.create': 'projects.create',
  'project.import': 'projects.import',
  'projects.import': 'projects.import',
  'project.view_all': 'projects.view_all',
  'projects.view_all': 'projects.view_all',
  'project.manage_all': 'projects.manage_all',
  'projects.manage_all': 'projects.manage_all',
  'users.view': 'users.view',
  'users.manage': 'users.manage',
  'audit.view': 'audit.view',
  'workspace.manage': 'workspace.manage',
};

function parsePermissions(raw: string): Permission[] {
  try {
    return sanitizePermissions(JSON.parse(raw));
  } catch {
    return [];
  }
}

function toGrant(row: JitRow): JitGrant {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    userName: row.user_name,
    resourceType: row.resource_type as JitGrant['resourceType'],
    resourceId: row.resource_id,
    action: row.action,
    permissions: parsePermissions(row.permissions_json),
    reason: row.reason,
    status: row.status as JitGrant['status'],
    requestedByName: row.requested_by_name,
    approvedByName: row.approved_by_name,
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class GovernanceStore {
  readonly #db: Database;
  readonly #users: UsersStore;

  constructor(db: Database, users: UsersStore) {
    this.#db = db;
    this.#users = users;
  }

  #project(projectId: string, workspaceId: string): ProjectRow | null {
    const row = this.#db
      .stmt(
        `SELECT id, workspace_id, name, owner_id, visibility FROM projects
         WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      )
      .get(projectId, workspaceId) as unknown as ProjectRow | undefined;
    return row ?? null;
  }

  #projectForTask(taskId: string): ProjectRow | null {
    const row = this.#db
      .stmt(
        `SELECT p.id, p.workspace_id, p.name, p.owner_id, p.visibility
         FROM project_tasks t JOIN projects p ON p.id = t.project_id
         WHERE t.id = ? AND p.deleted_at IS NULL`,
      )
      .get(taskId) as unknown as ProjectRow | undefined;
    return row ?? null;
  }

  #members(projectId: string): string[] {
    const rows = this.#db
      .stmt('SELECT user_id FROM project_members WHERE project_id = ?')
      .all(projectId) as unknown as { user_id: string }[];
    return rows.map((row) => row.user_id);
  }

  #resourceLabel(
    resourceType: PermissionSimulationInput['resourceType'],
    resourceId: string,
    workspaceId: string,
  ): { label: string | null; project: ProjectRow | null } {
    if (resourceType === 'workspace') {
      const row = this.#db
        .stmt('SELECT name FROM workspaces WHERE id = ?')
        .get(resourceId || workspaceId) as unknown as { name: string } | undefined;
      return { label: row?.name ?? null, project: null };
    }
    if (resourceType === 'project') {
      const project = this.#project(resourceId, workspaceId);
      return { label: project?.name ?? null, project };
    }
    const project = this.#projectForTask(resourceId);
    const task = this.#db
      .stmt('SELECT title FROM project_tasks WHERE id = ?')
      .get(resourceId) as unknown as { title: string } | undefined;
    return {
      label: task?.title ?? null,
      project: project?.workspace_id === workspaceId ? project : null,
    };
  }

  #decide(
    user: SessionUser,
    action: string,
    project: ProjectRow | null,
  ): { allowed: boolean; reason: string } {
    const normalized = action.trim().toLowerCase();
    const permissions = user.permissions ?? ROLE_PERMISSIONS[user.role];
    const permission = ACTION_PERMISSIONS[normalized];
    if (permission) {
      return hasPermission(user.role, permissions, permission)
        ? { allowed: true, reason: `已获得权限：${PERMISSION_LABELS[permission]}` }
        : { allowed: false, reason: `缺少权限：${PERMISSION_LABELS[permission]}` };
    }
    if (!project) {
      if (normalized === 'view' || normalized === 'read') {
        return { allowed: true, reason: '工作区成员均可查看' };
      }
      return canManageWorkspace(user.role, permissions)
        ? { allowed: true, reason: '已获得工作区管理权限' }
        : { allowed: false, reason: '缺少工作区管理权限' };
    }
    const scope = {
      ownerId: project.owner_id,
      memberIds: this.#members(project.id),
      visibility: project.visibility === 'private' ? ('private' as const) : ('workspace' as const),
    };
    const isOwner = project.owner_id === user.id;
    if (normalized === 'view' || normalized === 'read') {
      return canAccessProject(user.role, user.id, scope, permissions)
        ? { allowed: true, reason: isOwner ? '项目负责人可直接访问' : '项目可见' }
        : { allowed: false, reason: '不是项目成员或负责人' };
    }
    if (normalized === 'delete' || normalized === 'project.delete') {
      return canViewAllProjects(user.role, permissions)
        ? { allowed: true, reason: '已获得跨项目查看权限' }
        : { allowed: false, reason: '只有管理员或业务经理可以删除项目' };
    }
    return canManageProject(user.role, isOwner, permissions)
      ? { allowed: true, reason: isOwner ? '项目负责人可管理项目' : '已获得跨项目管理权限' }
      : { allowed: false, reason: '不是项目负责人且缺少跨项目管理权限' };
  }

  #sources(user: SessionUser, workspaceId: string): PermissionSource[] {
    const roleGrants = [...ROLE_PERMISSIONS[user.role]];
    const jitRows = this.#db
      .stmt(
        `SELECT id, permissions_json, expires_at, resource_type, resource_id
         FROM jit_grants
         WHERE user_id = ? AND workspace_id = ? AND status = 'active'
           AND starts_at <= ? AND expires_at > ?
         ORDER BY expires_at ASC`,
      )
      .all(user.id, workspaceId, new Date().toISOString(), new Date().toISOString()) as unknown as {
      id: string;
      permissions_json: string;
      expires_at: string;
      resource_type: string;
      resource_id: string;
    }[];
    const jitPermissions = new Set<string>();
    const sources: PermissionSource[] = [
      { source: 'role', label: ROLE_LABELS[user.role], grants: roleGrants },
    ];
    const customExtras = (user.permissions ?? []).filter(
      (permission) =>
        !roleGrants.includes(permission) && !(user.jitPermissions ?? []).includes(permission),
    );
    if (customExtras.length > 0) {
      sources.push({
        source: 'custom_role',
        label: user.customRole?.name ?? '自定义角色',
        grants: customExtras,
      });
    }
    for (const row of jitRows) {
      const permissions = parsePermissions(row.permissions_json);
      for (const permission of permissions) jitPermissions.add(permission);
      sources.push({
        source: 'jit',
        label: `临时授权 · ${row.resource_type}${row.resource_id ? `:${row.resource_id}` : ''} · 至 ${row.expires_at.slice(0, 16).replace('T', ' ')}`,
        grants: permissions,
      });
    }
    return sources;
  }

  simulate(
    input: PermissionSimulationInput,
    workspaceId: string,
  ): PermissionSimulationResult | null {
    const user = this.#users.findSessionUser(input.userId);
    if (!user || (user.workspaceId && user.workspaceId !== workspaceId)) return null;
    const { label, project } = this.#resourceLabel(
      input.resourceType,
      input.resourceId,
      workspaceId,
    );
    const decision = this.#decide(user, input.action, project);
    const sources = this.#sources(user, workspaceId);
    const conflicts: string[] = [];
    const roleGrants = new Set(ROLE_PERMISSIONS[user.role]);
    const jitGrants = new Set(
      sources.filter((source) => source.source === 'jit').flatMap((source) => source.grants),
    );
    for (const source of sources) {
      if (source.source !== 'custom_role') continue;
      const overlap = source.grants.filter((permission) =>
        roleGrants.has(permission as Permission),
      );
      if (overlap.length > 0) {
        conflicts.push(`自定义角色重复授予：${overlap.join('、')}`);
      }
    }
    const jitOverlap = [...jitGrants].filter((permission) =>
      roleGrants.has(permission as Permission),
    );
    if (jitOverlap.length > 0) {
      conflicts.push(`临时授权与现有权限重叠：${jitOverlap.join('、')}`);
    }
    const effective = permissionsForRole(user.role, [...(user.permissions ?? [])]);
    return {
      allowed: decision.allowed,
      reason: decision.reason,
      effectivePermissions: effective,
      sources,
      conflicts,
      resourceLabel: label,
    };
  }

  #grantRow(id: string, workspaceId: string): JitRow | null {
    const row = this.#db
      .stmt(
        `SELECT g.id, g.workspace_id, g.user_id, u.name AS user_name, g.resource_type,
                g.resource_id, g.action, g.permissions_json, g.reason, g.status,
                rb.name AS requested_by_name, ab.name AS approved_by_name, g.starts_at,
                g.expires_at, g.used_at, g.created_at, g.updated_at
         FROM jit_grants g
         JOIN users u ON u.id = g.user_id
         LEFT JOIN users rb ON rb.id = g.requested_by
         LEFT JOIN users ab ON ab.id = g.approved_by
         WHERE g.id = ? AND g.workspace_id = ?`,
      )
      .get(id, workspaceId) as unknown as JitRow | undefined;
    return row ?? null;
  }

  listGrants(workspaceId: string, input: { status?: string; userId?: string } = {}): JitGrant[] {
    const where = ['g.workspace_id = ?'];
    const params: string[] = [workspaceId];
    if (input.status && input.status !== 'all') {
      where.push('g.status = ?');
      params.push(input.status);
    }
    if (input.userId) {
      where.push('g.user_id = ?');
      params.push(input.userId);
    }
    const rows = this.#db
      .stmt(
        `SELECT g.id, g.workspace_id, g.user_id, u.name AS user_name, g.resource_type,
                g.resource_id, g.action, g.permissions_json, g.reason, g.status,
                rb.name AS requested_by_name, ab.name AS approved_by_name, g.starts_at,
                g.expires_at, g.used_at, g.created_at, g.updated_at
         FROM jit_grants g
         JOIN users u ON u.id = g.user_id
         LEFT JOIN users rb ON rb.id = g.requested_by
         LEFT JOIN users ab ON ab.id = g.approved_by
         WHERE ${where.join(' AND ')}
         ORDER BY g.created_at DESC LIMIT 200`,
      )
      .all(...params) as unknown as JitRow[];
    return rows.map(toGrant);
  }

  getGrant(id: string, workspaceId: string): JitGrant | null {
    const row = this.#grantRow(id, workspaceId);
    return row ? toGrant(row) : null;
  }

  createGrant(workspaceId: string, input: JitCreateInput, actor: SessionUser): JitResult {
    const target = this.#users.findById(input.userId ?? actor.id);
    if (target?.status !== 'active') {
      return { status: 'invalid', message: '目标用户不存在或已停用' };
    }
    if (target.workspaceId && target.workspaceId !== workspaceId) {
      return { status: 'invalid', message: '目标用户不属于该工作区' };
    }
    const permissions = sanitizePermissions(input.permissions);
    if (permissions.length === 0) {
      return { status: 'invalid', message: '至少选择一项有效权限' };
    }
    if (input.resourceType === 'project' && input.resourceId) {
      if (!this.#project(input.resourceId, workspaceId)) {
        return { status: 'invalid', message: '项目不存在' };
      }
    }
    if (input.resourceType === 'task' && input.resourceId) {
      const project = this.#projectForTask(input.resourceId);
      if (!project || project.workspace_id !== workspaceId) {
        return { status: 'invalid', message: '任务不存在' };
      }
    }
    if (
      input.resourceType === 'workspace' &&
      input.resourceId &&
      input.resourceId !== workspaceId
    ) {
      return { status: 'invalid', message: '工作区标识无效' };
    }
    const startsAt = input.startsAt ? new Date(input.startsAt) : new Date();
    if (Number.isNaN(startsAt.getTime())) {
      return { status: 'invalid', message: '生效时间格式无效' };
    }
    const expiresAt = new Date(startsAt.getTime() + input.durationMinutes * 60_000);
    if (expiresAt.getTime() <= Date.now()) {
      return { status: 'invalid', message: '授权有效期必须晚于当前时间' };
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.#db
      .stmt(
        `INSERT INTO jit_grants
           (id, workspace_id, user_id, resource_type, resource_id, action, permissions_json,
            reason, status, requested_by, approved_by, starts_at, expires_at, used_at,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?, NULL, ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        target.id,
        input.resourceType,
        input.resourceId ?? '',
        input.action ?? '',
        JSON.stringify(permissions),
        input.reason.trim(),
        actor.id,
        startsAt.toISOString(),
        expiresAt.toISOString(),
        now,
        now,
      );
    const grant = this.getGrant(id, workspaceId);
    if (!grant) throw new Error('jit grant creation failed');
    return { status: 'ok', grant };
  }

  approveGrant(id: string, workspaceId: string, approver: SessionUser): JitResult {
    const row = this.#grantRow(id, workspaceId);
    if (!row) return { status: 'missing' };
    if (row.status !== 'pending') {
      return { status: 'invalid', message: '只有待审批的临时授权可以批准' };
    }
    if (row.user_id === approver.id) {
      return { status: 'invalid', message: '不能审批自己的临时授权申请' };
    }
    if (Date.parse(row.expires_at) <= Date.now()) {
      this.#db
        .stmt("UPDATE jit_grants SET status = 'expired', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), id);
      return { status: 'invalid', message: '临时授权已过期' };
    }
    const now = new Date().toISOString();
    this.#db
      .stmt(
        `UPDATE jit_grants SET status = 'active', approved_by = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(approver.id, now, id);
    const grant = this.getGrant(id, workspaceId);
    if (!grant) throw new Error('jit approval failed');
    return { status: 'ok', grant };
  }

  rejectGrant(id: string, workspaceId: string, actor: SessionUser): JitResult {
    const row = this.#grantRow(id, workspaceId);
    if (!row) return { status: 'missing' };
    if (row.status !== 'pending') {
      return { status: 'invalid', message: '只有待审批的临时授权可以驳回' };
    }
    if (row.user_id === actor.id) {
      return { status: 'invalid', message: '不能审批自己的临时授权申请' };
    }
    this.#db
      .stmt(
        `UPDATE jit_grants SET status = 'rejected', approved_by = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(actor.id, new Date().toISOString(), id);
    const grant = this.getGrant(id, workspaceId);
    if (!grant) throw new Error('jit rejection failed');
    return { status: 'ok', grant };
  }

  revokeGrant(id: string, workspaceId: string): JitResult {
    const row = this.#grantRow(id, workspaceId);
    if (!row) return { status: 'missing' };
    if (row.status !== 'pending' && row.status !== 'active') {
      return { status: 'invalid', message: '该临时授权已结束' };
    }
    this.#db
      .stmt(
        `UPDATE jit_grants SET status = 'revoked', updated_at = ?
         WHERE id = ? AND status IN ('pending', 'active')`,
      )
      .run(new Date().toISOString(), id);
    const grant = this.getGrant(id, workspaceId);
    if (!grant) throw new Error('jit revoke failed');
    return { status: 'ok', grant };
  }

  expireGrants(workspaceId: string, now = new Date().toISOString()): number {
    const result = this.#db
      .stmt(
        `UPDATE jit_grants SET status = 'expired', updated_at = ?
         WHERE workspace_id = ? AND status IN ('pending', 'active') AND expires_at <= ?`,
      )
      .run(now, workspaceId, now);
    return Number(result.changes);
  }

  markUsed(id: string): void {
    this.#db
      .stmt('UPDATE jit_grants SET used_at = ? WHERE id = ? AND used_at IS NULL')
      .run(new Date().toISOString(), id);
  }

  markActiveUsed(userId: string, workspaceId: string): void {
    const now = new Date().toISOString();
    this.#db
      .stmt(
        `UPDATE jit_grants SET used_at = ?
         WHERE user_id = ? AND workspace_id = ? AND status = 'active'
           AND starts_at <= ? AND expires_at > ? AND used_at IS NULL`,
      )
      .run(now, userId, workspaceId, now, now);
  }

  activePermissions(userId: string, workspaceId: string, now = new Date()): Permission[] {
    const timestamp = now.toISOString();
    const rows = this.#db
      .stmt(
        `SELECT permissions_json FROM jit_grants
         WHERE user_id = ? AND workspace_id = ? AND status = 'active'
           AND starts_at <= ? AND expires_at > ?`,
      )
      .all(userId, workspaceId, timestamp, timestamp) as unknown as { permissions_json: string }[];
    const result = new Set<Permission>();
    for (const row of rows) {
      for (const permission of parsePermissions(row.permissions_json)) result.add(permission);
    }
    return [...result];
  }
}
