import { useEffect, useMemo, useState } from 'react';
import type { RecurrenceRule, TaskBlocker, TaskDependency } from '../../../../shared/types.ts';
import { api } from '../../api.ts';
import { formatDate } from '../../format.ts';
import { useApi, useToast } from '../../hooks/useApi.ts';
import { Icon } from '../Icon.tsx';
import { ConfirmDialog, EmptyState, ErrorState, Field, Modal, Spinner, Toaster } from '../ui.tsx';
import {
  EnterpriseEmpty,
  EnterpriseStat,
  type EnterpriseTabProps,
  EnterpriseToolbar,
  minutesLabel,
  ProjectPicker,
  ToneBadge,
} from './shared.tsx';

const CATEGORY_LABELS: Record<TaskBlocker['category'], string> = {
  external: '外部依赖',
  decision: '等待决策',
  environment: '环境问题',
  data: '数据问题',
  dependency: '任务依赖',
  other: '其他',
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function PlanningTab({ projects }: EnterpriseTabProps) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const { toasts, show, dismiss } = useToast();

  useEffect(() => {
    if (!projectId && projects[0]) setProjectId(projects[0].id);
  }, [projectId, projects]);

  const tasksState = useApi((signal) => api.projectTasks(projectId, signal), [projectId], {
    skip: !projectId,
  });
  const dependenciesState = useApi((signal) => api.dependencies(projectId, signal), [projectId], {
    skip: !projectId,
  });
  const criticalState = useApi((signal) => api.criticalPath(projectId, signal), [projectId], {
    skip: !projectId,
  });
  const blockersState = useApi((signal) => api.blockers(projectId, 'all', signal), [projectId], {
    skip: !projectId,
  });
  const recurrenceState = useApi((signal) => api.recurrences(projectId, signal), [projectId], {
    skip: !projectId,
  });
  const timeState = useApi((signal) => api.timeLogs({ projectId }, signal), [projectId], {
    skip: !projectId,
  });

  const tasks = tasksState.data?.tasks ?? [];
  const dependencies = dependenciesState.data ?? [];
  const critical = criticalState.data;
  const blockers = blockersState.data ?? [];
  const recurrences = recurrenceState.data ?? [];
  const logs = timeState.data ?? [];

  const [predecessorId, setPredecessorId] = useState('');
  const [successorId, setSuccessorId] = useState('');
  const [depType, setDepType] = useState('FS');
  const [lagDays, setLagDays] = useState('0');
  const [blockerTaskId, setBlockerTaskId] = useState('');
  const [blockerReason, setBlockerReason] = useState('');
  const [blockerCategory, setBlockerCategory] = useState<TaskBlocker['category']>('other');
  const [resolving, setResolving] = useState<TaskBlocker | null>(null);
  const [evidence, setEvidence] = useState('');
  const [logTaskId, setLogTaskId] = useState('');
  const [logMinutes, setLogMinutes] = useState('60');
  const [logDate, setLogDate] = useState(today());
  const [recurrenceTitle, setRecurrenceTitle] = useState('');
  const [recurrenceRule, setRecurrenceRule] = useState('FREQ=WEEKLY;INTERVAL=1');
  const [recurrenceStart, setRecurrenceStart] = useState(today());
  const [deletingRecurrence, setDeletingRecurrence] = useState<RecurrenceRule | null>(null);
  const [busy, setBusy] = useState(false);

  const taskMap = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const openBlockers = blockers.filter((blocker) => blocker.status === 'open');
  const blockedDays = blockers.reduce((sum, blocker) => {
    if (blocker.status !== 'resolved' || !blocker.resolvedAt) return sum;
    const ms = Date.parse(blocker.resolvedAt) - Date.parse(blocker.createdAt);
    return sum + Math.max(0, Math.round(ms / 86_400_000));
  }, 0);

  const reloadPlanning = () => {
    dependenciesState.reload();
    criticalState.reload();
    blockersState.reload();
    recurrenceState.reload();
  };

  const addDependency = async () => {
    if (!predecessorId || !successorId || predecessorId === successorId || busy) return;
    setBusy(true);
    try {
      await api.addDependency(projectId, {
        predecessorId,
        successorId,
        type: depType,
        lagDays: Number(lagDays) || 0,
      });
      show('依赖关系已创建');
      setPredecessorId('');
      setSuccessorId('');
      reloadPlanning();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '创建依赖失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const removeDependency = async (dependency: TaskDependency) => {
    try {
      await api.deleteDependency(projectId, dependency.id);
      show('依赖关系已删除');
      reloadPlanning();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '删除依赖失败', 'error');
    }
  };

  const addBlocker = async () => {
    if (!blockerTaskId || !blockerReason.trim() || busy) return;
    setBusy(true);
    try {
      await api.addBlocker(blockerTaskId, {
        reason: blockerReason,
        category: blockerCategory,
      });
      show('阻塞已登记');
      setBlockerReason('');
      setBlockerTaskId('');
      blockersState.reload();
      recurrenceState.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '登记阻塞失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const resolveBlocker = async () => {
    if (!resolving || !evidence.trim() || busy) return;
    setBusy(true);
    try {
      await api.resolveBlocker(projectId, resolving.id, {
        evidence,
        version: resolving.version,
      });
      show('阻塞已解除');
      setResolving(null);
      setEvidence('');
      blockersState.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '解除阻塞失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const addTimeLog = async () => {
    if (!logTaskId || busy) return;
    setBusy(true);
    try {
      await api.addTimeLog(logTaskId, {
        minutes: Number(logMinutes),
        workDate: logDate,
        idempotencyKey: `${logTaskId}:${logDate}:${logMinutes}:${Date.now()}`,
      });
      show('工时已记录');
      timeState.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '记录工时失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const addRecurrence = async () => {
    if (!recurrenceTitle.trim() || busy) return;
    setBusy(true);
    try {
      await api.createRecurrence(projectId, {
        title: recurrenceTitle,
        rule: recurrenceRule,
        startsOn: recurrenceStart,
      });
      show('重复任务规则已创建');
      setRecurrenceTitle('');
      recurrenceState.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '创建重复规则失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const runRecurrence = async (rule: RecurrenceRule) => {
    try {
      const result = await api.runRecurrence(rule.id, today());
      show(`已生成 ${result.generated.length} 个任务，跳过 ${result.skipped.length} 个日期`);
      recurrenceState.reload();
      tasksState.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '运行重复规则失败', 'error');
    }
  };

  const removeRecurrence = async () => {
    if (!deletingRecurrence) return;
    try {
      await api.deleteRecurrence(deletingRecurrence.id);
      show('重复规则已删除');
      setDeletingRecurrence(null);
      recurrenceState.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '删除重复规则失败', 'error');
    }
  };

  return (
    <div className="enterprise-tab">
      <EnterpriseToolbar>
        <ProjectPicker projects={projects} value={projectId} onChange={setProjectId} />
        <p className="enterprise-hint">依赖、关键路径、阻塞、重复任务与工时统一按项目查看。</p>
      </EnterpriseToolbar>

      {!projectId ? (
        <div className="card card-pad">
          <EmptyState icon="calendar" title="请选择项目" compact />
        </div>
      ) : null}

      <div className="enterprise-stats">
        <EnterpriseStat label="依赖关系" value={dependencies.length} hint="支持 FS/SS/FF/SF" />
        <EnterpriseStat
          label="关键路径"
          value={critical?.chain.length ?? 0}
          hint={
            critical?.estimatedCompletion
              ? `预计完成 ${formatDate(critical.estimatedCompletion)}`
              : '无依赖时为空'
          }
          tone="mint"
        />
        <EnterpriseStat
          label="开放阻塞"
          value={openBlockers.length}
          hint={`累计阻塞 ${blockedDays} 天`}
          tone={openBlockers.length > 0 ? 'peach' : 'sky'}
        />
        <EnterpriseStat label="重复规则" value={recurrences.length} hint="按日历生成任务" />
      </div>

      {critical?.cycles.length ? (
        <div className="card card-pad enterprise-warning" role="alert">
          <Icon name="alert" size={17} />
          <span>
            检测到循环依赖，关键路径可能不完整：
            {critical.cycles.map((cycle) => cycle.join(' → ')).join('；')}
          </span>
        </div>
      ) : null}

      <div className="enterprise-columns">
        <section className="card card-pad">
          <header className="card-head">
            <div>
              <h2>任务依赖</h2>
              <p className="card-sub">定义前置与后置任务，用于排期和关键路径计算。</p>
            </div>
          </header>
          {dependenciesState.error && !dependenciesState.data ? (
            <ErrorState
              message={dependenciesState.error}
              onRetry={dependenciesState.reload}
              compact
            />
          ) : null}
          {dependencies.length === 0 ? (
            <EnterpriseEmpty>当前项目还没有依赖关系。</EnterpriseEmpty>
          ) : (
            <ul className="enterprise-sublist">
              {dependencies.map((dependency) => (
                <li key={dependency.id}>
                  <div className="enterprise-subject">
                    <span>
                      {dependency.predecessorTitle} → {dependency.successorTitle}
                    </span>
                    <span className="table-muted">
                      {dependency.type} · 滞后 {dependency.lagDays} 天
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      aria-label="删除依赖"
                      onClick={() => void removeDependency(dependency)}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="enterprise-inline-form">
            <select
              className="input input-sm"
              value={predecessorId}
              aria-label="前置任务"
              onChange={(event) => setPredecessorId(event.target.value)}
            >
              <option value="">前置任务</option>
              {tasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </select>
            <select
              className="input input-sm"
              value={successorId}
              aria-label="后置任务"
              onChange={(event) => setSuccessorId(event.target.value)}
            >
              <option value="">后置任务</option>
              {tasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </select>
            <select
              className="input input-sm"
              value={depType}
              aria-label="依赖类型"
              onChange={(event) => setDepType(event.target.value)}
            >
              {['FS', 'SS', 'FF', 'SF'].map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
            <input
              className="input input-sm enterprise-narrow"
              type="number"
              min={0}
              max={365}
              value={lagDays}
              aria-label="滞后天数"
              onChange={(event) => setLagDays(event.target.value)}
            />
            <button
              type="button"
              className="btn btn-soft btn-sm"
              onClick={() => void addDependency()}
              disabled={busy || !predecessorId || !successorId}
            >
              <Icon name="plus" size={15} />
              添加
            </button>
          </div>
        </section>

        <section className="card card-pad">
          <header className="card-head">
            <div>
              <h2>关键路径</h2>
              <p className="card-sub">浮动时间为 0 的任务构成关键链，直接影响交付日期。</p>
            </div>
          </header>
          {criticalState.error && !criticalState.data ? (
            <ErrorState message={criticalState.error} onRetry={criticalState.reload} compact />
          ) : null}
          {!critical || critical.nodes.length === 0 ? (
            <EnterpriseEmpty>暂无排期数据。</EnterpriseEmpty>
          ) : (
            <ul className="enterprise-sublist">
              {critical.nodes
                .slice()
                .sort((a, b) => a.earliestStart.localeCompare(b.earliestStart))
                .map((node) => (
                  <li key={node.taskId}>
                    <div className="enterprise-subject">
                      <span>
                        {node.title}{' '}
                        {node.critical ? <ToneBadge tone="danger">关键</ToneBadge> : null}
                      </span>
                      <span className="table-muted">
                        {formatDate(node.earliestStart)} → {formatDate(node.earliestFinish)} · 浮动{' '}
                        {node.floatDays} 天
                      </span>
                    </div>
                  </li>
                ))}
            </ul>
          )}
        </section>
      </div>

      <section className="card card-pad">
        <header className="card-head">
          <div>
            <h2>阻塞与风险</h2>
            <p className="card-sub">记录阻塞原因、责任团队与解除证据，便于复盘阻塞时长。</p>
          </div>
        </header>
        {blockers.length === 0 ? (
          <EnterpriseEmpty>当前项目没有阻塞记录。</EnterpriseEmpty>
        ) : (
          <div className="card table-card">
            <table className="data-table">
              <thead>
                <tr>
                  <th>任务</th>
                  <th>原因</th>
                  <th>分类</th>
                  <th>状态</th>
                  <th>登记时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {blockers.map((blocker) => (
                  <tr key={blocker.id}>
                    <td>{blocker.taskTitle}</td>
                    <td>{blocker.reason}</td>
                    <td className="table-muted">{CATEGORY_LABELS[blocker.category]}</td>
                    <td>
                      <ToneBadge tone={blocker.status === 'open' ? 'danger' : 'success'}>
                        {blocker.status === 'open' ? '未解除' : '已解除'}
                      </ToneBadge>
                    </td>
                    <td className="table-muted">{formatDate(blocker.createdAt)}</td>
                    <td>
                      {blocker.status === 'open' ? (
                        <button
                          type="button"
                          className="btn btn-soft btn-sm"
                          onClick={() => {
                            setResolving(blocker);
                            setEvidence('');
                          }}
                        >
                          解除
                        </button>
                      ) : (
                        <span className="table-muted" title={blocker.evidence}>
                          {blocker.resolvedByName ?? '—'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="enterprise-inline-form">
          <select
            className="input input-sm"
            value={blockerTaskId}
            aria-label="阻塞任务"
            onChange={(event) => setBlockerTaskId(event.target.value)}
          >
            <option value="">选择任务</option>
            {tasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.title}
              </option>
            ))}
          </select>
          <input
            className="input input-sm enterprise-grow"
            value={blockerReason}
            maxLength={500}
            placeholder="阻塞原因"
            aria-label="阻塞原因"
            onChange={(event) => setBlockerReason(event.target.value)}
          />
          <select
            className="input input-sm"
            value={blockerCategory}
            aria-label="阻塞分类"
            onChange={(event) => setBlockerCategory(event.target.value as TaskBlocker['category'])}
          >
            {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-soft btn-sm"
            disabled={busy || !blockerTaskId || !blockerReason.trim()}
            onClick={() => void addBlocker()}
          >
            <Icon name="alert" size={15} />
            登记阻塞
          </button>
        </div>
      </section>

      <div className="enterprise-columns">
        <section className="card card-pad">
          <header className="card-head">
            <div>
              <h2>重复任务</h2>
              <p className="card-sub">使用 iCalendar RRULE 语法，按日/周/月生成任务。</p>
            </div>
          </header>
          {recurrences.length === 0 ? (
            <EnterpriseEmpty>还没有重复规则。</EnterpriseEmpty>
          ) : (
            <ul className="enterprise-sublist">
              {recurrences.map((rule) => (
                <li key={rule.id}>
                  <div className="enterprise-subject">
                    <span>
                      {rule.title}{' '}
                      <ToneBadge tone={rule.active ? 'success' : 'muted'}>
                        {rule.active ? '启用' : '停用'}
                      </ToneBadge>
                    </span>
                    <span className="table-muted">{rule.rule}</span>
                    <button
                      type="button"
                      className="btn btn-soft btn-sm"
                      onClick={() => void runRecurrence(rule)}
                    >
                      生成
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      aria-label="删除重复规则"
                      onClick={() => setDeletingRecurrence(rule)}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="enterprise-inline-form">
            <input
              className="input input-sm enterprise-grow"
              value={recurrenceTitle}
              maxLength={160}
              placeholder="任务标题"
              aria-label="重复任务标题"
              onChange={(event) => setRecurrenceTitle(event.target.value)}
            />
            <input
              className="input input-sm enterprise-grow"
              value={recurrenceRule}
              maxLength={200}
              aria-label="重复规则"
              onChange={(event) => setRecurrenceRule(event.target.value)}
            />
            <input
              className="input input-sm"
              type="date"
              value={recurrenceStart}
              aria-label="开始日期"
              onChange={(event) => setRecurrenceStart(event.target.value)}
            />
            <button
              type="button"
              className="btn btn-soft btn-sm"
              disabled={busy || !recurrenceTitle.trim()}
              onClick={() => void addRecurrence()}
            >
              <Icon name="plus" size={15} />
              新建
            </button>
          </div>
        </section>

        <section className="card card-pad">
          <header className="card-head">
            <div>
              <h2>工时记录</h2>
              <p className="card-sub">按任务登记投入，支持后续成本与偏差分析。</p>
            </div>
          </header>
          {logs.length === 0 ? (
            <EnterpriseEmpty>当前项目还没有工时记录。</EnterpriseEmpty>
          ) : (
            <ul className="enterprise-sublist enterprise-scroll">
              {logs.slice(0, 12).map((log) => (
                <li key={log.id}>
                  <div className="enterprise-subject">
                    <span>{taskMap.get(log.taskId)?.title ?? log.taskTitle}</span>
                    <span className="table-muted">
                      {minutesLabel(log.minutes)} · {log.userName} · {formatDate(log.workDate)}
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      aria-label="删除工时"
                      onClick={() =>
                        void api
                          .deleteTimeLog(log.taskId, log.id)
                          .then(() => {
                            show('工时已删除');
                            timeState.reload();
                          })
                          .catch((cause: unknown) =>
                            show(cause instanceof Error ? cause.message : '删除失败', 'error'),
                          )
                      }
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="enterprise-inline-form">
            <select
              className="input input-sm enterprise-grow"
              value={logTaskId}
              aria-label="工时任务"
              onChange={(event) => setLogTaskId(event.target.value)}
            >
              <option value="">选择任务</option>
              {tasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </select>
            <input
              className="input input-sm enterprise-narrow"
              type="number"
              min={1}
              max={1440}
              value={logMinutes}
              aria-label="分钟数"
              onChange={(event) => setLogMinutes(event.target.value)}
            />
            <input
              className="input input-sm"
              type="date"
              value={logDate}
              aria-label="工作日期"
              onChange={(event) => setLogDate(event.target.value)}
            />
            <button
              type="button"
              className="btn btn-soft btn-sm"
              disabled={busy || !logTaskId}
              onClick={() => void addTimeLog()}
            >
              <Icon name="clock" size={15} />
              记录
            </button>
          </div>
        </section>
      </div>

      <Modal
        open={resolving !== null}
        onClose={() => setResolving(null)}
        title="解除阻塞"
        description={`任务「${resolving?.taskTitle ?? ''}」`}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setResolving(null)}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !evidence.trim()}
              onClick={() => void resolveBlocker()}
            >
              {busy ? <Spinner size={16} /> : <Icon name="check" size={16} />}
              确认解除
            </button>
          </>
        }
      >
        <Field label="解除证据" htmlFor="blocker-evidence" hint="会写入阻塞记录与审计日志">
          <textarea
            id="blocker-evidence"
            className="input textarea"
            value={evidence}
            maxLength={1000}
            onChange={(event) => setEvidence(event.target.value)}
            placeholder="例如：供应商已恢复交付，确认邮件见附件"
          />
        </Field>
      </Modal>

      <ConfirmDialog
        open={deletingRecurrence !== null}
        title="删除重复规则？"
        message={`规则「${deletingRecurrence?.title ?? ''}」将不再生成新任务，已生成任务保留。`}
        onCancel={() => setDeletingRecurrence(null)}
        onConfirm={() => void removeRecurrence()}
      />

      <Toaster toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
