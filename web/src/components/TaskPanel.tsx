import { type FormEvent, useEffect, useRef, useState } from 'react';
import {
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  TASK_STATUS_LABELS,
  TASK_STATUSES,
} from '../../../shared/tasks.ts';
import type {
  Milestone,
  Task,
  TaskPriority,
  TaskStatus,
  UserOption,
} from '../../../shared/types.ts';
import { api, type TaskPatchInput } from '../api.ts';
import { TaskCommentsModal } from '../components/CommentsPanel.tsx';
import { Icon, type IconName } from '../components/Icon.tsx';
import { TaskBoard, TaskCalendar, TaskTimeline } from '../components/TaskViews.tsx';
import {
  Avatar,
  ConfirmDialog,
  cx,
  EmptyState,
  Field,
  Modal,
  ProgressBar,
  Skeleton,
  Spinner,
} from '../components/ui.tsx';
import { formatDate } from '../format.ts';
import { useApi } from '../hooks/useApi.ts';

type ShowToast = (message: string, tone?: 'success' | 'error' | 'info') => number;

type Props = {
  projectId: string;
  canEdit: boolean;
  canComment: boolean;
  users: UserOption[];
  mentionUsers: UserOption[];
  focusTaskId?: string;
  onChanged: () => void;
  show: ShowToast;
};

type EditorState = { task: Task | null; parentId?: string };

type DeleteTarget = { kind: 'task' | 'milestone'; id: string; title: string };

type TaskView = 'list' | 'board' | 'timeline' | 'calendar';

const VIEW_OPTIONS: { value: TaskView; label: string; icon: IconName }[] = [
  { value: 'list', label: '列表', icon: 'menu' },
  { value: 'board', label: '看板', icon: 'folder' },
  { value: 'timeline', label: '时间线', icon: 'clock' },
  { value: 'calendar', label: '日历', icon: 'calendar' },
];

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function TaskPanel({
  projectId,
  canEdit,
  canComment,
  users,
  mentionUsers,
  focusTaskId,
  onChanged,
  show,
}: Props) {
  const state = useApi((signal) => api.projectTasks(projectId, signal), [projectId]);
  const [quickTitle, setQuickTitle] = useState('');
  const [quickPriority, setQuickPriority] = useState<TaskPriority>('medium');
  const [milestoneTitle, setMilestoneTitle] = useState('');
  const [milestoneDue, setMilestoneDue] = useState('');
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [commentTask, setCommentTask] = useState<Task | null>(null);
  const [busy, setBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [view, setView] = useState<TaskView>('list');
  const focusedTask = useRef<string | null>(null);
  const data = state.data;

  useEffect(() => {
    setQuickTitle('');
    setMilestoneTitle('');
    setMilestoneDue('');
    setEditor(null);
    setCommentTask(null);
    setDeleteTarget(null);
    setError(null);
    setView('list');
    focusedTask.current = null;
  }, [projectId]);

  useEffect(() => {
    if (!focusTaskId || !data || focusedTask.current === focusTaskId) return;
    const task = data.tasks.find((item) => item.id === focusTaskId);
    if (!task) return;
    focusedTask.current = focusTaskId;
    setCommentTask(task);
  }, [focusTaskId, data]);

  const refresh = () => {
    state.reload();
    onChanged();
  };

  const addTask = async (event: FormEvent) => {
    event.preventDefault();
    const title = quickTitle.trim();
    if (!title || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.createTask(projectId, { title, priority: quickPriority });
      setQuickTitle('');
      refresh();
      show('任务已创建');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建任务失败');
    } finally {
      setBusy(false);
    }
  };

  const patchTask = async (task: Task, patch: Partial<TaskPatchInput>) => {
    setRowBusy(task.id);
    setError(null);
    try {
      await api.updateTask(task.id, { ...patch, version: task.version });
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '更新任务失败');
      state.reload();
    } finally {
      setRowBusy(null);
    }
  };

  const toggleTask = (task: Task) => {
    void patchTask(task, { status: task.status === 'done' ? 'todo' : 'done' });
  };

  const addMilestone = async (event: FormEvent) => {
    event.preventDefault();
    const title = milestoneTitle.trim();
    if (!title || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.createMilestone(projectId, { title, dueDate: milestoneDue || null });
      setMilestoneTitle('');
      setMilestoneDue('');
      refresh();
      show('里程碑已创建');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建里程碑失败');
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      if (deleteTarget.kind === 'task') {
        await api.deleteTask(deleteTarget.id);
      } else {
        await api.deleteMilestone(deleteTarget.id);
      }
      setDeleteTarget(null);
      refresh();
      show(deleteTarget.kind === 'task' ? '任务已删除' : '里程碑已删除');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除失败');
    } finally {
      setDeleting(false);
    }
  };

  if (state.loading && !data) {
    return (
      <section className="card card-pad">
        <Skeleton height={16} width="30%" />
        <Skeleton height={12} width="60%" />
        <Skeleton height={72} radius={16} />
      </section>
    );
  }

  if (!data) {
    return (
      <section className="card card-pad">
        <EmptyState
          icon="alert"
          title="任务加载失败"
          description={state.error ?? '请稍后重试。'}
          action={
            <button type="button" className="btn btn-soft btn-sm" onClick={state.reload}>
              重试
            </button>
          }
          compact
        />
      </section>
    );
  }

  const roots = data.tasks.filter((task) => task.parentId === null);
  const childrenOf = (id: string) => data.tasks.filter((task) => task.parentId === id);
  const milestones = new Map(data.milestones.map((milestone) => [milestone.id, milestone]));
  const leafTotal = data.tasks.filter((task) => childrenOf(task.id).length === 0).length;
  const doneTotal = data.tasks.filter(
    (task) => childrenOf(task.id).length === 0 && task.status === 'done',
  ).length;

  const renderTask = (task: Task, isChild: boolean) => {
    const children = childrenOf(task.id);
    const milestone = task.milestoneId ? milestones.get(task.milestoneId) : undefined;
    const overdue = task.dueDate !== null && task.dueDate < todayKey() && task.status !== 'done';
    return (
      <li key={task.id} className="task-item">
        <div className={cx('task-row', task.status === 'done' && 'is-done')}>
          <button
            type="button"
            className={cx('task-check', task.status === 'done' && 'is-checked')}
            onClick={() => (canEdit ? toggleTask(task) : undefined)}
            disabled={!canEdit || rowBusy === task.id}
            aria-pressed={task.status === 'done'}
            aria-label={`${task.status === 'done' ? '重新打开' : '完成'}任务：${task.title}`}
          >
            {task.status === 'done' ? <Icon name="check" size={13} /> : null}
          </button>
          <div className="task-body">
            <div className="task-title-line">
              <span className="task-title">{task.title}</span>
              <span className="task-priority" data-priority={task.priority}>
                {TASK_PRIORITY_LABELS[task.priority]}
              </span>
            </div>
            <div className="task-meta">
              <span className="task-status" data-status={task.status}>
                {TASK_STATUS_LABELS[task.status]}
              </span>
              {task.assigneeName ? (
                <span className="task-assignee">
                  <Avatar name={task.assigneeName} size={18} />
                  {task.assigneeName}
                </span>
              ) : (
                <span className="task-unassigned">未指派</span>
              )}
              {task.dueDate ? (
                <span className={cx('task-due', overdue && 'is-overdue')}>
                  <Icon name="calendar" size={13} />
                  {formatDate(task.dueDate)}
                </span>
              ) : null}
              {milestone ? (
                <span className="task-milestone">
                  <Icon name="rocket" size={13} />
                  {milestone.title}
                </span>
              ) : null}
              {children.length > 0 ? (
                <span className="task-subcount">
                  {children.filter((child) => child.status === 'done').length}/{children.length}{' '}
                  子任务
                </span>
              ) : null}
            </div>
            {task.description ? <p className="task-description">{task.description}</p> : null}
          </div>
          <div className="task-actions">
            <button
              type="button"
              className="btn btn-icon btn-ghost btn-sm task-comment-btn"
              aria-label={`评论任务「${task.title}」`}
              title="查看评论"
              onClick={() => setCommentTask(task)}
            >
              <Icon name="mail" size={15} />
              {task.commentCount > 0 ? (
                <span className="task-comment-count" aria-hidden="true">
                  {task.commentCount}
                </span>
              ) : null}
            </button>
            {canEdit ? (
              <>
                <select
                  className="task-status-select"
                  aria-label={`状态：${task.title}`}
                  value={task.status}
                  disabled={rowBusy === task.id}
                  onChange={(event) =>
                    void patchTask(task, { status: event.target.value as TaskStatus })
                  }
                >
                  {TASK_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {TASK_STATUS_LABELS[status]}
                    </option>
                  ))}
                </select>
                {isChild ? null : (
                  <button
                    type="button"
                    className="btn btn-icon btn-ghost btn-sm"
                    aria-label={`为「${task.title}」添加子任务`}
                    onClick={() => setEditor({ task: null, parentId: task.id })}
                  >
                    <Icon name="plus" size={15} />
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-icon btn-ghost btn-sm"
                  aria-label={`编辑任务「${task.title}」`}
                  onClick={() => setEditor({ task })}
                >
                  <Icon name="edit" size={15} />
                </button>
                <button
                  type="button"
                  className="btn btn-icon btn-ghost btn-sm danger"
                  aria-label={`删除任务「${task.title}」`}
                  onClick={() => setDeleteTarget({ kind: 'task', id: task.id, title: task.title })}
                >
                  <Icon name="trash" size={15} />
                </button>
              </>
            ) : null}
          </div>
        </div>
        {children.length > 0 ? (
          <ul className="task-children">{children.map((child) => renderTask(child, true))}</ul>
        ) : null}
      </li>
    );
  };

  return (
    <section className="card card-pad task-panel">
      <header className="card-head task-head">
        <div>
          <h2>任务与里程碑</h2>
          <p className="card-sub">
            {data.tasks.length > 0
              ? `${leafTotal - doneTotal} 个未完成 / ${leafTotal} 个叶子任务`
              : '拆解任务、指派负责人，用完成度自动汇总项目进度。'}
          </p>
        </div>
        <div className="task-progress">
          <strong>{data.progress}%</strong>
          <ProgressBar value={data.progress} tone="mint" label="任务完成度" />
        </div>
      </header>

      {error ? (
        <div className="inline-alert is-card" role="alert">
          <Icon name="alert" size={16} />
          {error}
        </div>
      ) : null}

      <div className="milestone-row">
        {data.milestones.length > 0 ? (
          data.milestones.map((milestone: Milestone) => (
            <div key={milestone.id} className="milestone-chip">
              <Icon name="rocket" size={15} />
              <div>
                <strong>{milestone.title}</strong>
                <span>
                  {milestone.taskCount > 0
                    ? `${milestone.doneCount}/${milestone.taskCount} 完成`
                    : '暂无任务'}
                  {milestone.dueDate ? ` · ${formatDate(milestone.dueDate)}` : ''}
                </span>
              </div>
              {canEdit ? (
                <button
                  type="button"
                  className="btn btn-icon btn-ghost btn-xs"
                  aria-label={`删除里程碑「${milestone.title}」`}
                  onClick={() =>
                    setDeleteTarget({
                      kind: 'milestone',
                      id: milestone.id,
                      title: milestone.title,
                    })
                  }
                >
                  <Icon name="close" size={13} />
                </button>
              ) : null}
            </div>
          ))
        ) : (
          <p className="task-empty-note">还没有里程碑，可按交付节点创建。</p>
        )}
      </div>

      {canEdit ? (
        <>
          <form className="task-quick-add" onSubmit={addTask}>
            <input
              className="input"
              value={quickTitle}
              maxLength={160}
              placeholder="添加任务，例如：完成登录页视觉走查"
              aria-label="新任务标题"
              onChange={(event) => setQuickTitle(event.target.value)}
            />
            <select
              className="input task-quick-priority"
              value={quickPriority}
              aria-label="新任务优先级"
              onChange={(event) => setQuickPriority(event.target.value as TaskPriority)}
            >
              {TASK_PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {TASK_PRIORITY_LABELS[priority]}优先级
                </option>
              ))}
            </select>
            <button type="submit" className="btn btn-primary" disabled={busy || !quickTitle.trim()}>
              {busy ? <Spinner size={16} /> : <Icon name="plus" size={16} />}
              添加
            </button>
          </form>

          <form className="milestone-form" onSubmit={addMilestone}>
            <input
              className="input"
              value={milestoneTitle}
              maxLength={120}
              placeholder="新里程碑名称"
              aria-label="新里程碑名称"
              onChange={(event) => setMilestoneTitle(event.target.value)}
            />
            <input
              className="input"
              type="date"
              value={milestoneDue}
              aria-label="新里程碑截止日期"
              onChange={(event) => setMilestoneDue(event.target.value)}
            />
            <button
              type="submit"
              className="btn btn-soft"
              disabled={busy || !milestoneTitle.trim()}
            >
              <Icon name="rocket" size={16} />
              创建里程碑
            </button>
          </form>
        </>
      ) : null}

      <div className="task-view-bar" role="group" aria-label="任务视图">
        {VIEW_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={cx('task-view-btn', view === option.value && 'is-active')}
            aria-pressed={view === option.value}
            onClick={() => setView(option.value)}
          >
            <Icon name={option.icon} size={15} />
            {option.label}
          </button>
        ))}
      </div>

      <div className="task-view-panel tab-panel" key={view}>
        {view === 'list' ? (
          roots.length > 0 ? (
            <ul className="task-list">{roots.map((task) => renderTask(task, false))}</ul>
          ) : (
            <EmptyState
              icon="projects"
              title="还没有任务"
              description={
                canEdit ? '从上面的输入框添加第一个任务。' : '项目经理添加任务后，会显示在这里。'
              }
              compact
            />
          )
        ) : view === 'board' ? (
          <TaskBoard
            tasks={roots}
            childrenOf={childrenOf}
            milestones={data.milestones}
            canEdit={canEdit}
            busyId={rowBusy}
            onEdit={(task) => setEditor({ task })}
            onMove={(task, status) => void patchTask(task, { status })}
            onToggle={toggleTask}
          />
        ) : view === 'timeline' ? (
          <TaskTimeline
            tasks={roots}
            childrenOf={childrenOf}
            milestones={data.milestones}
            canEdit={canEdit}
            busyId={rowBusy}
            onEdit={(task) => setEditor({ task })}
            onMove={(task, status) => void patchTask(task, { status })}
            onToggle={toggleTask}
          />
        ) : (
          <TaskCalendar
            tasks={roots}
            childrenOf={childrenOf}
            milestones={data.milestones}
            canEdit={canEdit}
            busyId={rowBusy}
            onEdit={(task) => setEditor({ task })}
            onMove={(task, status) => void patchTask(task, { status })}
            onToggle={toggleTask}
          />
        )}
      </div>

      <TaskCommentsModal
        projectId={projectId}
        task={commentTask}
        users={mentionUsers}
        canComment={canComment}
        canManage={canEdit}
        onClose={() => setCommentTask(null)}
        onChanged={refresh}
      />

      <TaskEditor
        open={editor !== null}
        projectId={projectId}
        task={editor?.task ?? null}
        parentId={editor?.parentId}
        milestones={data.milestones}
        users={users}
        onClose={() => setEditor(null)}
        onSaved={(message) => {
          setEditor(null);
          refresh();
          show(message);
        }}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title={deleteTarget?.kind === 'task' ? '删除任务？' : '删除里程碑？'}
        message={
          deleteTarget?.kind === 'task'
            ? `「${deleteTarget.title}」及其子任务会被删除，完成度会重新计算。`
            : `里程碑「${deleteTarget?.title ?? ''}」会被删除，关联任务会保留并解除里程碑。`
        }
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
        busy={deleting}
      />
    </section>
  );
}

function TaskEditor({
  open,
  projectId,
  task,
  parentId,
  milestones,
  users,
  onClose,
  onSaved,
}: {
  open: boolean;
  projectId: string;
  task: Task | null;
  parentId?: string;
  milestones: Milestone[];
  users: UserOption[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<TaskStatus>('todo');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [assigneeId, setAssigneeId] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [milestoneId, setMilestoneId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialized = useRef('');

  useEffect(() => {
    if (!open) {
      initialized.current = '';
      return;
    }
    const key = `${task?.id ?? 'new'}:${parentId ?? ''}`;
    if (initialized.current === key) return;
    initialized.current = key;
    setTitle(task?.title ?? '');
    setDescription(task?.description ?? '');
    setStatus(task?.status ?? 'todo');
    setPriority(task?.priority ?? 'medium');
    setAssigneeId(task?.assigneeId ?? '');
    setDueDate(task?.dueDate ?? '');
    setMilestoneId(task?.milestoneId ?? '');
    setError(null);
    setBusy(false);
  }, [open, task, parentId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    const payload = {
      title: title.trim(),
      description: description.trim(),
      status,
      priority,
      assigneeId: assigneeId || null,
      dueDate: dueDate || null,
      milestoneId: milestoneId || null,
    };
    try {
      if (task) {
        await api.updateTask(task.id, { ...payload, version: task.version });
        onSaved('任务已更新');
      } else {
        await api.createTask(projectId, {
          ...payload,
          ...(parentId ? { parentId } : {}),
        });
        onSaved(parentId ? '子任务已创建' : '任务已创建');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存任务失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={task ? '编辑任务' : parentId ? '新建子任务' : '新建任务'}
      description="任务完成后会自动汇总到项目完成度，并写入活动流。"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="submit" form="task-form" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner size={16} /> : <Icon name="check" size={16} />}
            {task ? '保存修改' : '创建任务'}
          </button>
        </>
      }
    >
      <form id="task-form" className="form-grid" onSubmit={submit}>
        <div className="form-span-2">
          <Field label="任务标题" htmlFor="task-title">
            <input
              id="task-title"
              className="input"
              value={title}
              maxLength={160}
              required
              placeholder="例如：完成设计稿评审"
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
        </div>

        <div className="form-span-2">
          <Field label="描述" htmlFor="task-description" hint="最多 2000 字。">
            <textarea
              id="task-description"
              className="input textarea"
              rows={3}
              maxLength={2000}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
        </div>

        <Field label="状态" htmlFor="task-status">
          <select
            id="task-status"
            className="input"
            value={status}
            onChange={(event) => setStatus(event.target.value as TaskStatus)}
          >
            {TASK_STATUSES.map((value) => (
              <option key={value} value={value}>
                {TASK_STATUS_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>

        <Field label="优先级" htmlFor="task-priority">
          <select
            id="task-priority"
            className="input"
            value={priority}
            onChange={(event) => setPriority(event.target.value as TaskPriority)}
          >
            {TASK_PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {TASK_PRIORITY_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>

        <Field label="负责人" htmlFor="task-assignee">
          <select
            id="task-assignee"
            className="input"
            value={assigneeId}
            onChange={(event) => setAssigneeId(event.target.value)}
          >
            <option value="">未指派</option>
            {users.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="截止日期" htmlFor="task-due">
          <input
            id="task-due"
            type="date"
            className="input"
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
          />
        </Field>

        <div className="form-span-2">
          <Field label="里程碑" htmlFor="task-milestone">
            <select
              id="task-milestone"
              className="input"
              value={milestoneId}
              onChange={(event) => setMilestoneId(event.target.value)}
            >
              <option value="">不关联里程碑</option>
              {milestones.map((milestone) => (
                <option key={milestone.id} value={milestone.id}>
                  {milestone.title}
                </option>
              ))}
            </select>
          </Field>
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
