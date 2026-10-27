import { type FormEvent, useMemo, useState } from 'react';
import type { Goal, GoalImpact, GoalLevel, GoalStatus } from '../../../../shared/types.ts';
import { api } from '../../api.ts';
import { formatDate } from '../../format.ts';
import { useApi, useToast } from '../../hooks/useApi.ts';
import { Icon } from '../Icon.tsx';
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Modal,
  ProgressBar,
  Spinner,
  Toaster,
} from '../ui.tsx';
import {
  EnterpriseEmpty,
  EnterpriseStat,
  type EnterpriseTabProps,
  EnterpriseToolbar,
  ToneBadge,
} from './shared.tsx';

const LEVEL_LABELS: Record<GoalLevel, string> = {
  company: '公司',
  department: '部门',
  workspace: '工作区',
  project: '项目',
};

const STATUS_LABELS: Record<GoalStatus, string> = {
  active: '进行中',
  locked: '已锁定',
  archived: '已归档',
};

function goalTone(status: GoalStatus): 'success' | 'muted' | 'warning' {
  if (status === 'active') return 'success';
  if (status === 'locked') return 'warning';
  return 'muted';
}

function currentPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-Q${Math.floor(now.getUTCMonth() / 3) + 1}`;
}

export function GoalsTab({ projects, people }: EnterpriseTabProps) {
  const state = useApi((signal) => api.goals({}, signal), []);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Goal | null>(null);
  const [deleting, setDeleting] = useState<Goal | null>(null);
  const [impact, setImpact] = useState<GoalImpact | null>(null);
  const [actual, setActual] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const { toasts, show, dismiss } = useToast();

  const goals = state.data?.goals ?? [];
  const active = goals.filter((goal) => goal.status === 'active');
  const keyResults = goals.reduce((sum, goal) => sum + goal.keyResults.length, 0);
  const average = goals.length
    ? Math.round(goals.reduce((sum, goal) => sum + goal.progress, 0) / goals.length)
    : 0;
  const atRisk = active.filter((goal) => goal.progress < 50).length;

  const openEdit = (goal: Goal) => {
    setEditing(goal);
    setActual(goal.actual === null ? '' : String(goal.actual));
    setReason('');
    setImpact(null);
  };

  const runImpact = async () => {
    if (!editing || busy) return;
    setBusy(true);
    try {
      const result = await api.goalImpact(editing.id, {
        actual: actual === '' ? null : Number(actual),
        reason: reason || undefined,
      });
      setImpact(result);
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '影响分析失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const saveProgress = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing || busy) return;
    setBusy(true);
    try {
      const updated = await api.updateGoal(editing.id, {
        version: editing.version,
        actual: actual === '' ? null : Number(actual),
        reason: reason || undefined,
      });
      show(`目标「${updated.title}」已更新到 ${updated.progress}%`);
      setEditing(null);
      setImpact(null);
      state.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '更新失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!deleting || busy) return;
    setBusy(true);
    try {
      await api.deleteGoal(deleting.id);
      show(`已删除目标「${deleting.title}」`);
      setDeleting(null);
      state.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '删除失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="enterprise-tab">
      <div className="enterprise-stats">
        <EnterpriseStat label="目标总数" value={goals.length} hint={`${active.length} 个进行中`} />
        <EnterpriseStat label="关键结果" value={keyResults} hint="可独立跟踪进度" />
        <EnterpriseStat label="平均进度" value={`${average}%`} hint="按目标简单平均" tone="mint" />
        <EnterpriseStat
          label="进度风险"
          value={atRisk}
          hint="进行中且低于 50%"
          tone={atRisk > 0 ? 'peach' : 'sky'}
        />
      </div>

      <EnterpriseToolbar>
        <p className="enterprise-hint">
          支持公司 / 部门 / 工作区 / 项目四级目标，修改前可预览影响面。
        </p>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => setCreateOpen(true)}
        >
          <Icon name="plus" size={16} />
          新建目标
        </button>
      </EnterpriseToolbar>

      {state.error && !state.data ? (
        <div className="card card-pad">
          <ErrorState message={state.error} onRetry={state.reload} />
        </div>
      ) : null}

      {!state.data && state.loading ? (
        <div className="card card-pad">
          <Spinner />
        </div>
      ) : null}

      {state.data && goals.length === 0 ? (
        <div className="card card-pad">
          <EmptyState
            icon="trend"
            title="还没有战略目标"
            description="从公司级目标开始，向下拆解关键结果并关联项目。"
            action={
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => setCreateOpen(true)}
              >
                新建目标
              </button>
            }
          />
        </div>
      ) : null}

      <div className="enterprise-list">
        {goals.map((goal) => {
          const linkedProjects = new Set(goal.links.map((link) => link.projectId));
          return (
            <article key={goal.id} className="card card-pad enterprise-card">
              <header className="card-head">
                <div>
                  <div className="card-title-row">
                    <h2>{goal.title}</h2>
                    <span className="badge" data-tone="muted">
                      {LEVEL_LABELS[goal.level]}
                    </span>
                    <ToneBadge tone={goalTone(goal.status)}>{STATUS_LABELS[goal.status]}</ToneBadge>
                  </div>
                  <p className="card-sub">
                    {goal.ownerName ?? '未指派负责人'} · {goal.period || '未设周期'} ·{' '}
                    {goal.updateMode === 'linked' ? '自动联动' : '手动更新'}
                    {goal.target !== null ? ` · 目标 ${goal.target}${goal.unit}` : ''}
                  </p>
                </div>
                <div className="enterprise-card-actions">
                  <button
                    type="button"
                    className="btn btn-soft btn-sm"
                    onClick={() => openEdit(goal)}
                  >
                    <Icon name="edit" size={15} />
                    更新进度
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    aria-label={`删除目标 ${goal.title}`}
                    onClick={() => setDeleting(goal)}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              </header>

              <div className="enterprise-progress-row">
                <ProgressBar value={goal.progress} label={`${goal.title} 进度`} />
                <strong>{goal.progress}%</strong>
                <span className="table-muted">
                  实际 {goal.actual ?? '—'}
                  {goal.unit} / 目标 {goal.target ?? '—'}
                  {goal.unit}
                </span>
              </div>

              {goal.keyResults.length > 0 ? (
                <ul className="enterprise-sublist">
                  {goal.keyResults.map((kr) => (
                    <li key={kr.id}>
                      <div className="enterprise-subject">
                        <span>{kr.title}</span>
                        <span className="table-muted">
                          {kr.actual ?? '—'} / {kr.target ?? '—'}
                          {kr.unit} · {kr.progress}%
                        </span>
                      </div>
                      <ProgressBar value={kr.progress} tone="mint" label={`${kr.title} 进度`} />
                    </li>
                  ))}
                </ul>
              ) : (
                <EnterpriseEmpty>暂无关键结果，可在目标详情中继续拆解。</EnterpriseEmpty>
              )}

              <footer className="enterprise-meta">
                <span>关联项目 {linkedProjects.size}</span>
                <span>更新于 {formatDate(goal.updatedAt)}</span>
              </footer>
            </article>
          );
        })}
      </div>

      <CreateGoalDialog
        open={createOpen}
        people={people}
        projects={projects}
        onClose={() => setCreateOpen(false)}
        onCreated={(goal) => {
          setCreateOpen(false);
          show(`已创建目标「${goal.title}」`);
          state.reload();
        }}
        onError={(message) => show(message, 'error')}
      />

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={`更新目标${editing ? `：${editing.title}` : ''}`}
        description="写入前可先预览受影响的项目、任务与子目标。"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-soft"
              onClick={() => void runImpact()}
              disabled={busy}
            >
              预览影响
            </button>
            <button
              type="submit"
              form="goal-progress-form"
              className="btn btn-primary"
              disabled={busy}
            >
              {busy ? <Spinner size={16} /> : <Icon name="check" size={16} />}
              保存
            </button>
          </>
        }
      >
        <form
          id="goal-progress-form"
          className="form-grid"
          onSubmit={(event) => void saveProgress(event)}
        >
          <Field label="实际值" htmlFor="goal-actual">
            <input
              id="goal-actual"
              className="input"
              type="number"
              step="any"
              value={actual}
              onChange={(event) => setActual(event.target.value)}
              placeholder="留空表示未知"
            />
          </Field>
          <Field label="更新原因" htmlFor="goal-reason" hint="会记录到审计与目标变更历史">
            <input
              id="goal-reason"
              className="input"
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              placeholder="例如：季度复盘调整"
            />
          </Field>
          {impact ? (
            <div className="form-span-2 enterprise-impact">
              <div className="card-title-row">
                <strong>影响预览</strong>
                <ToneBadge
                  tone={
                    impact.risk === 'high'
                      ? 'danger'
                      : impact.risk === 'medium'
                        ? 'warning'
                        : 'success'
                  }
                >
                  风险 {impact.risk}
                </ToneBadge>
                <span className="table-muted">
                  项目 {impact.affectedProjects.length} · 任务 {impact.affectedTasks} · 子目标{' '}
                  {impact.affectedGoals.length}
                </span>
              </div>
              {impact.affectedProjects.length > 0 ? (
                <p className="enterprise-hint">
                  涉及项目：{impact.affectedProjects.map((project) => project.name).join('、')}
                </p>
              ) : null}
              {impact.requiresConfirmationFrom.length > 0 ? (
                <p className="enterprise-hint">
                  需要确认：
                  {impact.requiresConfirmationFrom.map((person) => person.name).join('、')}
                </p>
              ) : null}
            </div>
          ) : null}
        </form>
      </Modal>

      <ConfirmDialog
        open={deleting !== null}
        title="删除目标？"
        message={`目标「${deleting?.title ?? ''}」及其关键结果、关联关系将被删除，历史变更仍保留在审计中。`}
        busy={busy}
        onCancel={() => setDeleting(null)}
        onConfirm={() => void remove()}
      />

      <Toaster toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

function CreateGoalDialog({
  open,
  people,
  projects,
  onClose,
  onCreated,
  onError,
}: {
  open: boolean;
  people: EnterpriseTabProps['people'];
  projects: EnterpriseTabProps['projects'];
  onClose: () => void;
  onCreated: (goal: Goal) => void;
  onError: (message: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [level, setLevel] = useState<GoalLevel>('company');
  const [period, setPeriod] = useState(currentPeriod());
  const [target, setTarget] = useState('');
  const [actual, setActual] = useState('');
  const [unit, setUnit] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  const ownerOptions = useMemo(
    () => people.map((person) => ({ id: person.id, name: person.name })),
    [people],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const goal = await api.createGoal({
        title,
        level,
        period,
        unit,
        ownerId: ownerId || null,
        projectId: level === 'project' && projectId ? projectId : null,
        target: target === '' ? null : Number(target),
        actual: actual === '' ? null : Number(actual),
        description,
      });
      setTitle('');
      setDescription('');
      setTarget('');
      setActual('');
      setUnit('');
      onCreated(goal);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : '创建失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建目标"
      description="目标支持层级拆解，并可关联项目与关键结果。"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" form="goal-create-form" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner size={16} /> : <Icon name="plus" size={16} />}
            创建目标
          </button>
        </>
      }
    >
      <form id="goal-create-form" className="form-grid" onSubmit={(event) => void submit(event)}>
        <Field label="目标名称" htmlFor="goal-title">
          <input
            id="goal-title"
            className="input"
            value={title}
            required
            maxLength={160}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <Field label="层级" htmlFor="goal-level">
          <select
            id="goal-level"
            className="input"
            value={level}
            onChange={(event) => setLevel(event.target.value as GoalLevel)}
          >
            {(Object.keys(LEVEL_LABELS) as GoalLevel[]).map((value) => (
              <option key={value} value={value}>
                {LEVEL_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>
        {level === 'project' ? (
          <Field label="关联项目" htmlFor="goal-project">
            <select
              id="goal-project"
              className="input"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value="">请选择项目</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field label="周期" htmlFor="goal-period">
          <input
            id="goal-period"
            className="input"
            value={period}
            maxLength={20}
            onChange={(event) => setPeriod(event.target.value)}
            placeholder="2026-Q4"
          />
        </Field>
        <Field label="负责人" htmlFor="goal-owner">
          <select
            id="goal-owner"
            className="input"
            value={ownerId}
            onChange={(event) => setOwnerId(event.target.value)}
          >
            <option value="">未指派</option>
            {ownerOptions.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="单位" htmlFor="goal-unit">
          <input
            id="goal-unit"
            className="input"
            value={unit}
            maxLength={20}
            onChange={(event) => setUnit(event.target.value)}
            placeholder="例如 %、万元"
          />
        </Field>
        <Field label="目标值" htmlFor="goal-target">
          <input
            id="goal-target"
            className="input"
            type="number"
            step="any"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          />
        </Field>
        <Field label="当前值" htmlFor="goal-actual">
          <input
            id="goal-actual"
            className="input"
            type="number"
            step="any"
            value={actual}
            onChange={(event) => setActual(event.target.value)}
          />
        </Field>
        <Field label="说明" htmlFor="goal-description">
          <textarea
            id="goal-description"
            className="input textarea"
            value={description}
            maxLength={2000}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
      </form>
    </Modal>
  );
}
