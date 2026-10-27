import type { ProjectStatus, ProjectVisibility, Role } from './types.ts';

export const ROLES: readonly Role[] = ['admin', 'manager', 'pm', 'viewer'];

export const PERMISSIONS = [
  'projects.create',
  'projects.import',
  'projects.view_all',
  'projects.manage_all',
  'users.view',
  'users.manage',
  'audit.view',
  'workspace.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_LABELS: Record<Permission, string> = {
  'projects.create': '创建项目',
  'projects.import': '导入项目',
  'projects.view_all': '查看工作区项目',
  'projects.manage_all': '管理所有项目',
  'users.view': '查看成员目录',
  'users.manage': '管理成员与角色',
  'audit.view': '查看审计日志',
  'workspace.manage': '管理工作区',
};

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: PERMISSIONS,
  manager: [
    'projects.create',
    'projects.import',
    'projects.view_all',
    'projects.manage_all',
    'users.view',
  ],
  pm: ['projects.create'],
  viewer: [],
};

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

/** De-duplicates arbitrary JSON into a safe permission list. */
export function sanitizePermissions(values: unknown): Permission[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter(isPermission))];
}

/** Effective permissions: built-in defaults stay, custom roles only add. */
export function permissionsForRole(role: Role, extras: readonly string[] = []): Permission[] {
  const result = new Set<Permission>(ROLE_PERMISSIONS[role]);
  for (const value of extras) if (isPermission(value)) result.add(value);
  return [...result];
}

export function hasPermission(
  role: Role,
  permissions: readonly string[] | undefined,
  permission: Permission,
): boolean {
  if (permissions === undefined) return ROLE_PERMISSIONS[role].includes(permission);
  return permissions.includes(permission);
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: '管理员',
  manager: '业务经理',
  pm: '项目经理',
  viewer: '只读成员',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: '全局设置、用户与项目权限',
  manager: '查看全部分析与项目，可导入导出',
  pm: '管理自己拥有或加入的项目',
  viewer: '只读访问已加入的项目',
};

export const PROJECT_STATUSES: readonly ProjectStatus[] = [
  'planning',
  'active',
  'on_hold',
  'completed',
  'archived',
];

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  planning: '规划中',
  active: '进行中',
  on_hold: '暂停',
  completed: '已完成',
  archived: '已归档',
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function canViewAllProjects(role: Role, permissions?: readonly string[]): boolean {
  return hasPermission(role, permissions, 'projects.view_all');
}

export function canCreateProject(role: Role, permissions?: readonly string[]): boolean {
  return hasPermission(role, permissions, 'projects.create');
}

export function canManageProject(
  role: Role,
  isOwner: boolean,
  permissions?: readonly string[],
): boolean {
  if (hasPermission(role, permissions, 'projects.manage_all')) return true;
  return isOwner && role === 'pm';
}

export function canImportProjects(role: Role, permissions?: readonly string[]): boolean {
  return hasPermission(role, permissions, 'projects.import');
}

export function canViewUserDirectory(role: Role, permissions?: readonly string[]): boolean {
  return hasPermission(role, permissions, 'users.view');
}

export function canManageUsers(role: Role, permissions?: readonly string[]): boolean {
  return hasPermission(role, permissions, 'users.manage');
}

export function canViewAudit(role: Role, permissions?: readonly string[]): boolean {
  return hasPermission(role, permissions, 'audit.view');
}

export function canManageWorkspace(role: Role, permissions?: readonly string[]): boolean {
  return hasPermission(role, permissions, 'workspace.manage');
}

export type ProjectScope = {
  ownerId: string;
  memberIds: readonly string[];
  visibility?: ProjectVisibility;
};

export function canAccessProject(
  role: Role,
  userId: string,
  scope: ProjectScope,
  permissions?: readonly string[],
): boolean {
  if (scope.ownerId === userId || scope.memberIds.includes(userId)) return true;
  if (role === 'admin') return true;
  if (scope.visibility === 'private') return false;
  return canViewAllProjects(role, permissions);
}

export function canAssignRole(role: Role, permissions?: readonly string[]): boolean {
  return canManageUsers(role, permissions);
}
