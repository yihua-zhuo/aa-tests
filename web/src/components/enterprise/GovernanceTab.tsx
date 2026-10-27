import { type FormEvent, useEffect, useState } from 'react';
import { PERMISSION_LABELS, PERMISSIONS, type Permission } from '../../../../shared/permissions.ts';
import type { JitGrant, PermissionSimulationResult } from '../../../../shared/types.ts';
import { api } from '../../api.ts';
import { formatDateTime } from '../../format.ts';
import { useApi, useToast } from '../../hooks/useApi.ts';
import { useAuth } from '../../hooks/useAuth.tsx';
import { Icon } from '../Icon.tsx';
import { EmptyState, ErrorState, Field, Modal, Spinner, Toaster } from '../ui.tsx';
import { EnterpriseEmpty, EnterpriseStat, type EnterpriseTabProps, ToneBadge } from './shared.tsx';

type ResourceType = 'workspace' | 'project' | 'task';

const RESOURCE_LABELS: Record<ResourceType, string> = {
  workspace: '工作区',
  project: '项目',
  task: '任务',
};

const STATUS_LABELS: Record<JitGrant['status'], string> = {
  pending: '待审批',
  active: '生效中',
  rejected: '已拒绝',
  revoked: '已撤销',
  expired: '已过期',
};

function grantTone(status: JitGrant['status']): 'success' | 'warning' | 'danger' | 'muted' {
  if (status === 'active') return 'success';
  if (status === 'pending') return 'warning';
  if (status === 'expired') return 'muted';
  return 'danger';
}

function hoursUntil(iso: string): number {
  return (Date.parse(iso) - Date.now()) / 3_600_000;
}

export function GovernanceTab({ projects, people }: EnterpriseTabProps) {
  const { user } = useAuth();
  const [status, setStatus] = useState('all');
  const grantsState = useApi((signal) => api.jitGrants({ status }, signal), [status]);
  const [simulateUserId, setSimulateUserId] = useState(people[0]?.id ?? '');
  const [simulateAction, setSimulateAction] = useState<Permission>('projects.view_all');
  const [simulateResource, setSimulateResource] = useState<ResourceType>('workspace');
  const [simulateResourceId, setSimulateResourceId] = useState(user?.workspaceId ?? '');
  const [simulation, setSimulation] = useState<PermissionSimulationResult | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { toasts, show, dismiss } = useToast();

  useEffect(() => {
    if (!simulateUserId && people[0]) setSimulateUserId(people[0].id);
  }, [simulateUserId, people]);

  useEffect(() => {
    if (simulateResource === 'workspace') setSimulateResourceId(user?.workspaceId ?? '');
    if (simulateResource === 'project') setSimulateResourceId(projects[0]?.id ?? '');
    if (simulateResource === 'task') setSimulateResourceId('');
  }, [simulateResource, projects, user?.workspaceId]);

  const grants = grantsState.data ?? [];
  const pending = grants.filter((grant) => grant.status === 'pending').length;
  const active = grants.filter((grant) => grant.status === 'active').length;
  const expiring = grants.filter(
    (grant) => grant.status === 'active' && hoursUntil(grant.expiresAt) <= 24,
  ).length;

  const simulate = async (event: FormEvent) => {
    event.preventDefault();
    if (simulating || !simulateUserId) return;
    setSimulating(true);
    try {
      const result = await api.simulatePermission({
        userId: simulateUserId,
        resourceType: simulateResource,
        resourceId: simulateResourceId,
        action: simulateAction,
      });
      setSimulation(result);
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '权限模拟失败', 'error');
    } finally {
      setSimulating(false);
    }
  };

  const act = async (grant: JitGrant, action: 'approve' | 'reject' | 'revoke') => {
    if (busyId) return;
    setBusyId(grant.id);
    try {
      if (action === 'approve') await api.approveJitGrant(grant.id);
      if (action === 'reject') await api.rejectJitGrant(grant.id);
      if (action === 'revoke') await api.revokeJitGrant(grant.id);
      show(
        action === 'approve'
          ? '临时授权已批准'
          : action === 'reject'
            ? '临时授权已拒绝'
            : '临时授权已撤销',
      );
      grantsState.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '操作失败', 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="enterprise-tab">
      <div className="enterprise-stats">
        <EnterpriseStat
          label="待审批"
          value={pending}
          hint="等待管理员处理"
          tone={pending > 0 ? 'peach' : 'lilac'}
        />
        <EnterpriseStat label="生效中" value={active} hint="按时间窗口自动失效" tone="mint" />
        <EnterpriseStat
          label="24 小时内到期"
          value={expiring}
          hint="可提前续期或撤销"
          tone={expiring > 0 ? 'peach' : 'sky'}
        />
        <EnterpriseStat
          label="历史授权"
          value={
            grants.filter((grant) => ['rejected', 'revoked', 'expired'].includes(grant.status))
              .length
          }
          hint="保留完整审计链路"
        />
      </div>

      <div className="enterprise-columns">
        <section className="card card-pad">
          <header className="card-head">
            <div>
              <h2>权限模拟</h2>
              <p className="card-sub">在不改变实际授权的前提下，验证成员对资源的实际操作权限。</p>
            </div>
          </header>
          <form className="form-grid" onSubmit={(event) => void simulate(event)}>
            <Field label="成员" htmlFor="simulate-user">
              <select
                id="simulate-user"
                className="input"
                value={simulateUserId}
                onChange={(event) => setSimulateUserId(event.target.value)}
              >
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="资源类型" htmlFor="simulate-resource">
              <select
                id="simulate-resource"
                className="input"
                value={simulateResource}
                onChange={(event) => setSimulateResource(event.target.value as ResourceType)}
              >
                {Object.entries(RESOURCE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="资源 ID" htmlFor="simulate-resource-id">
              {simulateResource === 'project' ? (
                <select
                  id="simulate-resource-id"
                  className="input"
                  value={simulateResourceId}
                  onChange={(event) => setSimulateResourceId(event.target.value)}
                >
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="simulate-resource-id"
                  className="input"
                  value={simulateResourceId}
                  onChange={(event) => setSimulateResourceId(event.target.value)}
                />
              )}
            </Field>
            <Field label="操作权限" htmlFor="simulate-action">
              <select
                id="simulate-action"
                className="input"
                value={simulateAction}
                onChange={(event) => setSimulateAction(event.target.value as Permission)}
              >
                {PERMISSIONS.map((permission) => (
                  <option key={permission} value={permission}>
                    {PERMISSION_LABELS[permission]}（{permission}）
                  </option>
                ))}
              </select>
            </Field>
            <div className="form-actions form-span-2">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={simulating || !simulateUserId}
              >
                {simulating ? <Spinner size={16} /> : <Icon name="shield" size={16} />}
                运行模拟
              </button>
            </div>
          </form>

          {simulation ? (
            <div className="enterprise-simulation">
              <div className="card-title-row">
                <ToneBadge tone={simulation.allowed ? 'success' : 'danger'}>
                  {simulation.allowed ? '允许' : '拒绝'}
                </ToneBadge>
                <strong>{simulateAction}</strong>
                <span className="table-muted">
                  {simulation.resourceLabel ?? simulateResourceId}
                </span>
              </div>
              <p className="enterprise-hint">{simulation.reason}</p>
              {simulation.sources.length > 0 ? (
                <ul className="enterprise-sublist">
                  {simulation.sources.map((source) => (
                    <li key={`${source.source}-${source.label}`}>
                      <div className="enterprise-subject">
                        <span>{source.label}</span>
                        <span className="table-muted">
                          {source.source} · {source.grants.join('、') || '无'}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}
              {simulation.conflicts.length > 0 ? (
                <p className="enterprise-warning">{simulation.conflicts.join('；')}</p>
              ) : null}
            </div>
          ) : null}
        </section>

        <section className="card card-pad">
          <header className="card-head">
            <div>
              <h2>临时授权（JIT）</h2>
              <p className="card-sub">限时授予最小权限，到期自动回收并保留审计。</p>
            </div>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => setCreateOpen(true)}
            >
              <Icon name="plus" size={16} />
              申请授权
            </button>
          </header>
          <div className="enterprise-inline-form">
            <select
              className="input input-sm"
              value={status}
              aria-label="授权状态"
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="all">全部状态</option>
              {Object.entries(STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          {grantsState.error && !grantsState.data ? (
            <ErrorState message={grantsState.error} onRetry={grantsState.reload} compact />
          ) : null}
          {grants.length === 0 ? (
            <EmptyState icon="key" title="没有临时授权记录" compact />
          ) : (
            <ul className="enterprise-sublist">
              {grants.map((grant) => (
                <li key={grant.id}>
                  <div className="enterprise-subject">
                    <span>
                      {grant.userName} ·{' '}
                      {grant.permissions
                        .map((permission) => PERMISSION_LABELS[permission])
                        .join('、')}
                    </span>
                    <ToneBadge tone={grantTone(grant.status)}>
                      {STATUS_LABELS[grant.status]}
                    </ToneBadge>
                  </div>
                  <p className="enterprise-hint">
                    {RESOURCE_LABELS[grant.resourceType]} {grant.resourceId} · 至{' '}
                    {formatDateTime(grant.expiresAt)}
                    {grant.approvedByName ? ` · 审批人 ${grant.approvedByName}` : ''}
                  </p>
                  <p className="enterprise-hint">理由：{grant.reason}</p>
                  <div className="enterprise-grant-actions">
                    {grant.status === 'pending' ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-soft btn-sm"
                          disabled={busyId === grant.id}
                          onClick={() => void act(grant, 'approve')}
                        >
                          批准
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={busyId === grant.id}
                          onClick={() => void act(grant, 'reject')}
                        >
                          拒绝
                        </button>
                      </>
                    ) : null}
                    {grant.status === 'active' ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={busyId === grant.id}
                        onClick={() => void act(grant, 'revoke')}
                      >
                        撤销
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <EnterpriseEmpty>授权时间窗口最小 5 分钟、最长 24 小时。</EnterpriseEmpty>
        </section>
      </div>

      <CreateGrantDialog
        open={createOpen}
        people={people}
        projects={projects}
        defaultResourceId={simulateResourceId}
        onClose={() => setCreateOpen(false)}
        onCreated={(grant) => {
          setCreateOpen(false);
          show(`已为「${grant.userName}」提交临时授权申请`);
          grantsState.reload();
        }}
        onError={(message) => show(message, 'error')}
      />

      <Toaster toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

function CreateGrantDialog({
  open,
  people,
  projects,
  defaultResourceId,
  onClose,
  onCreated,
  onError,
}: {
  open: boolean;
  people: EnterpriseTabProps['people'];
  projects: EnterpriseTabProps['projects'];
  defaultResourceId: string;
  onClose: () => void;
  onCreated: (grant: JitGrant) => void;
  onError: (message: string) => void;
}) {
  const [userId, setUserId] = useState('');
  const [permissions, setPermissions] = useState<Permission[]>(['projects.view_all']);
  const [resourceType, setResourceType] = useState<ResourceType>('project');
  const [resourceId, setResourceId] = useState(defaultResourceId);
  const [reason, setReason] = useState('');
  const [duration, setDuration] = useState('60');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setUserId(people[0]?.id ?? '');
    setResourceType('project');
    setResourceId(projects[0]?.id ?? defaultResourceId);
    setReason('');
    setDuration('60');
  }, [open, people, projects, defaultResourceId]);

  const togglePermission = (permission: Permission) => {
    setPermissions((current) =>
      current.includes(permission)
        ? current.filter((item) => item !== permission)
        : [...current, permission],
    );
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || permissions.length === 0) return;
    setBusy(true);
    try {
      const grant = await api.createJitGrant({
        userId,
        permissions,
        resourceType,
        resourceId,
        reason,
        durationMinutes: Number(duration),
      });
      onCreated(grant);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : '申请失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="申请临时授权"
      description="授权到期自动失效；管理员不能审批自己的申请。"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" form="jit-form" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner size={16} /> : <Icon name="key" size={16} />}
            提交申请
          </button>
        </>
      }
    >
      <form id="jit-form" className="form-grid" onSubmit={(event) => void submit(event)}>
        <Field label="成员" htmlFor="jit-user">
          <select
            id="jit-user"
            className="input"
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
          >
            {people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="资源类型" htmlFor="jit-resource">
          <select
            id="jit-resource"
            className="input"
            value={resourceType}
            onChange={(event) => setResourceType(event.target.value as ResourceType)}
          >
            {Object.entries(RESOURCE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="资源 ID" htmlFor="jit-resource-id">
          {resourceType === 'project' ? (
            <select
              id="jit-resource-id"
              className="input"
              value={resourceId}
              onChange={(event) => setResourceId(event.target.value)}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="jit-resource-id"
              className="input"
              value={resourceId}
              onChange={(event) => setResourceId(event.target.value)}
            />
          )}
        </Field>
        <Field label="时长（分钟）" htmlFor="jit-duration" hint="5 - 1440 分钟">
          <input
            id="jit-duration"
            className="input"
            type="number"
            min={5}
            max={1440}
            value={duration}
            onChange={(event) => setDuration(event.target.value)}
          />
        </Field>
        <Field label="申请理由" htmlFor="jit-reason">
          <input
            id="jit-reason"
            className="input"
            value={reason}
            required
            minLength={3}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        <div className="form-span-2">
          <p className="form-label">权限范围（至少一项）</p>
          <div className="enterprise-permission-grid">
            {PERMISSIONS.map((permission) => (
              <label key={permission} className="enterprise-check">
                <input
                  type="checkbox"
                  checked={permissions.includes(permission)}
                  onChange={() => togglePermission(permission)}
                />
                <span>
                  {PERMISSION_LABELS[permission]}
                  <small>{permission}</small>
                </span>
              </label>
            ))}
          </div>
        </div>
      </form>
    </Modal>
  );
}
