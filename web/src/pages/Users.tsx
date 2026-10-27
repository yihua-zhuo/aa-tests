import { type FormEvent, useEffect, useState } from 'react';
import {
  canManageUsers,
  PERMISSION_LABELS,
  PERMISSIONS,
  type Permission,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  ROLES,
} from '../../../shared/permissions.ts';
import type {
  CustomRole,
  Role,
  UserDirectoryEntry,
  UserStatus,
  WorkspaceSummary,
} from '../../../shared/types.ts';
import { ApiError, api } from '../api.ts';
import { Icon } from '../components/Icon.tsx';
import {
  Avatar,
  ConfirmDialog,
  cx,
  DemoBadge,
  EmptyState,
  ErrorState,
  Field,
  Modal,
  Pagination,
  RoleBadge,
  Skeleton,
  Spinner,
  Toaster,
} from '../components/ui.tsx';
import { formatDateTime } from '../format.ts';
import { useApi, useDebounced, useToast } from '../hooks/useApi.ts';
import { useAuth } from '../hooks/useAuth.tsx';

const TIMEZONES = [
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
  'UTC',
];

type ModalState = { mode: 'create' } | { mode: 'edit'; user: UserDirectoryEntry } | null;

export default function UsersPage() {
  const { user, demo } = useAuth();
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 300);
  const [role, setRole] = useState('all');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState<ModalState>(null);
  const [disabling, setDisabling] = useState<UserDirectoryEntry | null>(null);
  const [toggling, setToggling] = useState(false);
  const [resetting, setResetting] = useState<string | null>(null);
  const [resetResult, setResetResult] = useState<{
    name: string;
    email: string;
    temporaryPassword: string;
  } | null>(null);
  const [roles, setRoles] = useState<CustomRole[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [roleModal, setRoleModal] = useState<CustomRole | 'new' | null>(null);
  const [deletingRole, setDeletingRole] = useState<CustomRole | null>(null);
  const [roleBusy, setRoleBusy] = useState(false);
  const { toasts, show, dismiss } = useToast();

  const state = useApi(
    (signal) => api.users({ q: debounced, role, status, page, pageSize: 20 }, signal),
    [debounced, role, status, page],
  );

  const isAdmin = user ? canManageUsers(user.role, user.permissions) : false;
  const data = state.data;

  useEffect(() => {
    if (!user) return;
    let active = true;
    void api
      .customRoles()
      .then((result) => {
        if (active) setRoles(result.roles);
      })
      .catch(() => undefined);
    if (isAdmin) {
      void api
        .workspaces()
        .then((result) => {
          if (active) setWorkspaces(result.workspaces);
        })
        .catch(() => undefined);
    }
    return () => {
      active = false;
    };
  }, [user, isAdmin]);

  const reloadRoles = async () => {
    try {
      const result = await api.customRoles();
      setRoles(result.roles);
    } catch {
      // keep last known roles
    }
  };

  const deleteRole = async () => {
    if (!deletingRole || roleBusy) return;
    setRoleBusy(true);
    try {
      await api.deleteCustomRole(deletingRole.id);
      show(`已删除角色「${deletingRole.name}」，相关成员已恢复为默认权限`);
      setDeletingRole(null);
      await reloadRoles();
      state.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '删除失败', 'error');
    } finally {
      setRoleBusy(false);
    }
  };

  useEffect(() => {
    setPage(1);
  }, [debounced, role, status]);

  const toggleStatus = async (target: UserDirectoryEntry) => {
    if (toggling) return;
    const nextStatus: UserStatus = target.status === 'active' ? 'disabled' : 'active';
    const patchStatus = (next: UserStatus) =>
      state.mutate((current) => ({
        ...current,
        users: current.users.map((entry) =>
          entry.id === target.id ? { ...entry, status: next } : entry,
        ),
      }));

    setToggling(true);
    setDisabling(null);
    patchStatus(nextStatus);
    try {
      const updated = await api.updateUser(target.id, {
        status: nextStatus,
        version: target.version,
      });
      if (nextStatus === 'disabled') {
        show(`已停用「${target.name}」`, 'success', {
          duration: 9_000,
          action: {
            label: '撤销',
            onClick: async () => {
              try {
                await api.updateUser(target.id, { status: 'active', version: updated.version });
                show(`已恢复「${target.name}」`);
                state.reload();
              } catch (cause) {
                show(cause instanceof Error ? cause.message : '恢复失败', 'error');
              }
            },
          },
        });
      } else {
        show(`已恢复「${target.name}」`);
      }
      state.reload();
    } catch (cause) {
      patchStatus(target.status);
      show(cause instanceof Error ? cause.message : '操作失败', 'error');
    } finally {
      setToggling(false);
    }
  };

  const resetPassword = async (target: UserDirectoryEntry) => {
    if (resetting) return;
    setResetting(target.id);
    try {
      const result = await api.resetUserPassword(target.id);
      setResetResult({
        name: target.name,
        email: target.email,
        temporaryPassword: result.temporaryPassword,
      });
      state.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '重置失败', 'error');
    } finally {
      setResetting(null);
    }
  };

  return (
    <div className="page users-page">
      <header className="page-head">
        <div className="page-head-copy">
          <p className="eyebrow">Users</p>
          <h1>成员管理</h1>
          <p className="page-sub">
            {isAdmin
              ? '管理员可以创建成员、调整角色与停用账户；角色变更会立即吊销对方的会话。'
              : '业务经理可以查看成员目录，但只有管理员可以修改账户。'}
          </p>
        </div>
        <div className="page-head-actions">
          {demo ? <DemoBadge label="Demo 账号" /> : null}
          {isAdmin ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setModal({ mode: 'create' })}
            >
              <Icon name="userPlus" size={17} />
              新建成员
            </button>
          ) : null}
        </div>
      </header>

      <section className="card user-toolbar">
        <div className="project-toolbar-row">
          <div className="search-inline">
            <Icon name="search" size={16} />
            <input
              type="search"
              value={search}
              placeholder="搜索姓名或邮箱…"
              aria-label="搜索成员"
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div className="toolbar-controls">
            <select
              className="input input-sm"
              value={role}
              aria-label="按角色筛选"
              onChange={(event) => setRole(event.target.value)}
            >
              <option value="all">全部角色</option>
              {ROLES.map((value) => (
                <option key={value} value={value}>
                  {ROLE_LABELS[value]}
                </option>
              ))}
            </select>
            <select
              className="input input-sm"
              value={status}
              aria-label="按状态筛选"
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="all">全部状态</option>
              <option value="active">启用中</option>
              <option value="disabled">已停用</option>
            </select>
          </div>
        </div>
        {data ? (
          <div className="user-counts">
            <span>
              全部 <strong>{data.counts.total}</strong>
            </span>
            <span>
              启用 <strong>{data.counts.active}</strong>
            </span>
            <span>
              停用 <strong>{data.counts.disabled}</strong>
            </span>
            <span>
              管理员 <strong>{data.counts.admins}</strong>
            </span>
          </div>
        ) : null}
      </section>

      {isAdmin ? (
        <section className="card card-pad">
          <div className="project-toolbar-row">
            <div>
              <h2>自定义角色</h2>
              <p className="field-hint">
                在基础角色之上叠加额外权限；删除角色后，已绑定成员恢复为内置角色权限。
              </p>
            </div>
            <button
              type="button"
              className="btn btn-soft btn-sm"
              onClick={() => setRoleModal('new')}
            >
              <Icon name="userPlus" size={15} />
              新建角色
            </button>
          </div>
          {roles.length === 0 ? (
            <p className="field-hint">还没有自定义角色。</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>角色</th>
                  <th>基础角色</th>
                  <th>额外权限</th>
                  <th>成员</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {roles.map((roleEntry) => (
                  <tr key={roleEntry.id}>
                    <td>
                      <strong>{roleEntry.name}</strong>
                    </td>
                    <td>
                      <RoleBadge role={roleEntry.baseRole} />
                    </td>
                    <td>
                      {roleEntry.permissions.length === 0 ? (
                        <span className="table-muted">无额外权限</span>
                      ) : (
                        <div className="project-tags">
                          {roleEntry.permissions.map((permission) => (
                            <span key={permission} className="badge">
                              {PERMISSION_LABELS[permission]}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="table-muted">{roleEntry.memberCount}</td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="btn btn-soft btn-xs"
                          onClick={() => setRoleModal(roleEntry)}
                        >
                          <Icon name="edit" size={14} />
                          编辑
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger-ghost btn-xs"
                          onClick={() => setDeletingRole(roleEntry)}
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ) : null}

      {state.error && !data ? (
        <div className="card card-pad">
          <ErrorState message={state.error} onRetry={state.reload} />
        </div>
      ) : null}

      {!data && state.loading ? (
        <div className="card card-pad table-skeleton" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((index) => (
            <div key={index} className="table-skeleton-row">
              <Skeleton height={34} width={34} radius={17} />
              <Skeleton height={12} width="22%" />
              <Skeleton height={12} width="16%" />
              <Skeleton height={12} width="14%" />
            </div>
          ))}
        </div>
      ) : null}

      {data && data.users.length === 0 ? (
        <div className="card card-pad">
          <EmptyState
            icon="users"
            title="没有匹配的成员"
            description="调整筛选条件或邀请新的团队成员。"
            compact
          />
        </div>
      ) : null}

      {data && data.users.length > 0 ? (
        <div className="card table-card">
          <table className="data-table users-table">
            <thead>
              <tr>
                <th>成员</th>
                <th>角色</th>
                <th>状态</th>
                <th>最后登录</th>
                <th>创建时间</th>
                {isAdmin ? <th aria-label="操作" /> : null}
              </tr>
            </thead>
            <tbody>
              {data.users.map((entry) => {
                const isSelf = entry.id === user?.id;
                return (
                  <tr
                    key={entry.id}
                    className={entry.status === 'disabled' ? 'is-disabled' : undefined}
                  >
                    <td>
                      <div className="user-cell">
                        <Avatar
                          name={entry.name}
                          src={entry.avatarUrl}
                          size={36}
                          muted={entry.status === 'disabled'}
                        />
                        <div>
                          <strong>
                            {entry.name}
                            {isSelf ? <span className="self-tag">你</span> : null}
                            {entry.isDemo ? <DemoBadge label="Demo" /> : null}
                          </strong>
                          <span>{entry.email}</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <RoleBadge role={entry.role} />
                      {entry.customRoleName ? (
                        <span className="table-muted"> · {entry.customRoleName}</span>
                      ) : null}
                    </td>
                    <td>
                      <span
                        className={cx(
                          'status-text',
                          entry.status === 'active' ? 'is-active' : 'is-off',
                        )}
                      >
                        <span className="live-dot" aria-hidden="true" />
                        {entry.status === 'active' ? '启用中' : '已停用'}
                      </span>
                    </td>
                    <td className="table-muted">
                      {entry.lastLoginAt ? formatDateTime(entry.lastLoginAt) : '从未登录'}
                    </td>
                    <td className="table-muted">{formatDateTime(entry.createdAt)}</td>
                    {isAdmin ? (
                      <td>
                        <div className="row-actions">
                          <button
                            type="button"
                            className="btn btn-soft btn-xs"
                            onClick={() => setModal({ mode: 'edit', user: entry })}
                          >
                            <Icon name="edit" size={14} />
                            编辑
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs"
                            disabled={isSelf || resetting === entry.id}
                            title={isSelf ? '请在设置页修改自己的密码' : '生成一次性临时密码'}
                            onClick={() => void resetPassword(entry)}
                          >
                            <Icon name="key" size={14} />
                            {resetting === entry.id ? '重置中…' : '重置密码'}
                          </button>
                          <button
                            type="button"
                            className={cx(
                              'btn btn-xs',
                              entry.status === 'active' ? 'btn-danger-ghost' : 'btn-ghost',
                            )}
                            disabled={isSelf}
                            title={isSelf ? '不能停用自己' : undefined}
                            onClick={() => setDisabling(entry)}
                          >
                            <Icon name={entry.status === 'active' ? 'lock' : 'key'} size={14} />
                            {entry.status === 'active' ? '停用' : '恢复'}
                          </button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {data ? (
        <Pagination
          page={data.page}
          pageSize={data.pageSize}
          total={data.total}
          onChange={setPage}
        />
      ) : null}

      {isAdmin ? (
        <UserModal
          open={modal !== null}
          target={modal?.mode === 'edit' ? modal.user : null}
          selfId={user?.id ?? ''}
          roles={roles}
          workspaces={workspaces}
          currentWorkspaceId={user?.workspaceId ?? ''}
          onClose={() => setModal(null)}
          onSaved={(message) => {
            setModal(null);
            show(message);
            state.reload();
            void reloadRoles();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={disabling !== null}
        title={disabling?.status === 'active' ? '停用成员？' : '恢复成员？'}
        message={
          disabling
            ? disabling.status === 'active'
              ? `停用「${disabling.name}」后，其全部会话会立即失效，且无法再登录。项目关系会保留。`
              : `恢复「${disabling.name}」后，该成员可以使用原有密码重新登录。`
            : ''
        }
        confirmLabel={disabling?.status === 'active' ? '停用' : '恢复'}
        busy={toggling}
        onCancel={() => setDisabling(null)}
        onConfirm={() => {
          if (disabling) void toggleStatus(disabling);
        }}
      />

      <ConfirmDialog
        open={deletingRole !== null}
        title="删除自定义角色？"
        message={
          deletingRole
            ? `删除「${deletingRole.name}」后，绑定的 ${deletingRole.memberCount} 名成员会恢复为内置角色权限。`
            : ''
        }
        confirmLabel="删除"
        busy={roleBusy}
        onCancel={() => setDeletingRole(null)}
        onConfirm={() => void deleteRole()}
      />

      {isAdmin ? (
        <RoleModal
          open={roleModal !== null}
          role={roleModal === 'new' ? null : roleModal}
          onClose={() => setRoleModal(null)}
          onSaved={async () => {
            setRoleModal(null);
            show('自定义角色已保存');
            await reloadRoles();
            state.reload();
          }}
        />
      ) : null}

      <Modal
        open={resetResult !== null}
        onClose={() => setResetResult(null)}
        title="临时密码已生成"
        description="请通过安全渠道转交。该密码只显示一次，成员登录后应立即修改。"
        footer={
          <button type="button" className="btn btn-primary" onClick={() => setResetResult(null)}>
            我已记录
          </button>
        }
      >
        {resetResult ? (
          <div className="reset-result">
            <p>
              已为 <strong>{resetResult.name}</strong>（{resetResult.email}
              ）重置密码，并注销其全部会话、关闭双因素认证。
            </p>
            <code className="mfa-secret" aria-label="临时密码">
              {resetResult.temporaryPassword}
            </code>
          </div>
        ) : null}
      </Modal>

      {isAdmin ? <Toaster toasts={toasts} onDismiss={dismiss} /> : null}
    </div>
  );
}

function UserModal({
  open,
  target,
  selfId,
  roles,
  workspaces,
  currentWorkspaceId,
  onClose,
  onSaved,
}: {
  open: boolean;
  target: UserDirectoryEntry | null;
  selfId: string;
  roles: CustomRole[];
  workspaces: WorkspaceSummary[];
  currentWorkspaceId: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const editing = target !== null;
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<UserStatus>('active');
  const [timezone, setTimezone] = useState('Asia/Shanghai');
  const [customRoleId, setCustomRoleId] = useState('');
  const [workspaceId, setWorkspaceId] = useState(currentWorkspaceId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(target?.name ?? '');
    setEmail(target?.email ?? '');
    setRole(target?.role ?? 'viewer');
    setStatus(target?.status ?? 'active');
    setPassword('');
    setTimezone('Asia/Shanghai');
    setCustomRoleId(target?.customRoleId ?? '');
    setWorkspaceId(target?.workspaceId ?? currentWorkspaceId);
    setError(null);
    setBusy(false);
  }, [open, target, currentWorkspaceId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!name.trim()) {
      setError('姓名不能为空');
      return;
    }
    if (!editing && password.length < 8) {
      setError('初始密码至少 8 位');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (editing && target) {
        await api.updateUser(target.id, {
          name: name.trim(),
          role,
          status,
          timezone,
          customRoleId: customRoleId || null,
          version: target.version,
        });
        onSaved(`已更新「${name.trim()}」`);
      } else {
        await api.createUser({
          email: email.trim(),
          name: name.trim(),
          role,
          password,
          timezone,
          workspaceId: workspaceId || undefined,
          customRoleId: customRoleId || undefined,
        });
        onSaved(`已创建成员「${name.trim()}」`);
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setError(cause.message);
      } else {
        setError(cause instanceof Error ? cause.message : '保存失败');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? '编辑成员' : '新建成员'}
      description={
        editing
          ? '角色或状态变更会吊销该成员的全部会话，管理员操作会写入审计日志。'
          : '新成员会收到本地账户，请通过安全渠道告知初始密码。'
      }
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="submit" form="user-form" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner size={16} /> : <Icon name="check" size={16} />}
            {editing ? '保存修改' : '创建成员'}
          </button>
        </>
      }
    >
      <form id="user-form" className="form-grid" onSubmit={submit}>
        <Field label="姓名" htmlFor="user-name">
          <input
            id="user-name"
            className="input"
            value={name}
            maxLength={80}
            required
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <Field
          label="邮箱"
          htmlFor="user-email"
          hint={editing ? '邮箱创建后不可修改。' : '会转为小写并保持唯一。'}
        >
          <input
            id="user-email"
            type="email"
            className="input"
            value={email}
            required
            disabled={editing}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>

        {!editing && workspaces.length > 0 ? (
          <Field
            label="工作区"
            htmlFor="user-workspace"
            hint="成员只能看到所属工作区的项目与成员。"
          >
            <select
              id="user-workspace"
              className="input"
              value={workspaceId}
              onChange={(event) => {
                setWorkspaceId(event.target.value);
                setCustomRoleId('');
              }}
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}

        <Field label="角色" htmlFor="user-role" hint={ROLE_DESCRIPTIONS[role]}>
          <select
            id="user-role"
            className="input"
            value={role}
            disabled={customRoleId !== ''}
            onChange={(event) => setRole(event.target.value as Role)}
          >
            {ROLES.map((value) => (
              <option key={value} value={value}>
                {ROLE_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="自定义角色"
          htmlFor="user-custom-role"
          hint="选择后基础角色自动取自该角色，并叠加额外权限。"
        >
          <select
            id="user-custom-role"
            className="input"
            value={customRoleId}
            onChange={(event) => {
              const next = event.target.value;
              setCustomRoleId(next);
              const match = roles.find((entry) => entry.id === next);
              if (match) setRole(match.baseRole);
            }}
          >
            <option value="">无（使用基础角色）</option>
            {roles.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name} · {ROLE_LABELS[entry.baseRole]}
              </option>
            ))}
          </select>
        </Field>

        <Field label="时区" htmlFor="user-timezone">
          <select
            id="user-timezone"
            className="input"
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
          >
            {TIMEZONES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>

        {editing ? (
          <Field
            label="账户状态"
            htmlFor="user-status"
            hint={
              target?.id === selfId ? '不能停用自己的账号。' : '停用会立即吊销该成员的所有会话。'
            }
          >
            <select
              id="user-status"
              className="input"
              value={status}
              disabled={target?.id === selfId}
              onChange={(event) => setStatus(event.target.value as UserStatus)}
            >
              <option value="active">启用中</option>
              <option value="disabled">已停用</option>
            </select>
          </Field>
        ) : (
          <Field label="初始密码" htmlFor="user-password" hint="至少 8 位，使用 scrypt 加盐存储。">
            <input
              id="user-password"
              type="password"
              className="input"
              autoComplete="new-password"
              value={password}
              minLength={8}
              required
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
        )}

        {error ? (
          <div className="form-error form-span-2" role="alert">
            <Icon name="alert" size={16} />
            <span>{error}</span>
          </div>
        ) : null}
      </form>
    </Modal>
  );
}

function RoleModal({
  open,
  role,
  onClose,
  onSaved,
}: {
  open: boolean;
  role: CustomRole | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [name, setName] = useState('');
  const [baseRole, setBaseRole] = useState<Role>('viewer');
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(role?.name ?? '');
    setBaseRole(role?.baseRole ?? 'viewer');
    setPermissions(role?.permissions.slice() ?? []);
    setBusy(false);
    setError(null);
  }, [open, role]);

  const togglePermission = (permission: Permission) => {
    setPermissions((current) =>
      current.includes(permission)
        ? current.filter((entry) => entry !== permission)
        : [...current, permission],
    );
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!name.trim()) {
      setError('角色名称不能为空');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const input = { name: name.trim(), baseRole, permissions };
      if (role) {
        await api.updateCustomRole(role.id, input);
      } else {
        await api.createCustomRole(input);
      }
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={role ? '编辑自定义角色' : '新建自定义角色'}
      description="自定义权限会叠加在基础角色的权限之上，并立即对绑定成员生效。"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="submit" form="role-form" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner size={16} /> : <Icon name="check" size={16} />}
            {role ? '保存角色' : '创建角色'}
          </button>
        </>
      }
    >
      <form id="role-form" className="form-grid" onSubmit={submit}>
        <Field label="角色名称" htmlFor="role-name">
          <input
            id="role-name"
            className="input"
            value={name}
            maxLength={40}
            required
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：项目审批人"
          />
        </Field>

        <Field label="基础角色" htmlFor="role-base" hint={ROLE_DESCRIPTIONS[baseRole]}>
          <select
            id="role-base"
            className="input"
            value={baseRole}
            onChange={(event) => setBaseRole(event.target.value as Role)}
          >
            {ROLES.map((value) => (
              <option key={value} value={value}>
                {ROLE_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>

        <div className="form-span-2">
          <p className="form-label">额外权限</p>
          <div className="member-picker">
            {PERMISSIONS.map((permission) => (
              <label key={permission} className="member-option">
                <input
                  type="checkbox"
                  checked={permissions.includes(permission)}
                  onChange={() => togglePermission(permission)}
                />
                <span>{PERMISSION_LABELS[permission]}</span>
              </label>
            ))}
          </div>
          <p className="field-hint">基础角色本身的权限始终保留，删除角色会撤销全部额外权限。</p>
        </div>

        {error ? (
          <div className="form-error form-span-2" role="alert">
            <Icon name="alert" size={16} />
            <span>{error}</span>
          </div>
        ) : null}
      </form>
    </Modal>
  );
}
