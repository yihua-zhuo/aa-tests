import { type DragEvent, useState } from 'react';
import { TASK_PRIORITY_LABELS, TASK_STATUS_LABELS, TASK_STATUSES } from '../../../shared/tasks.ts';
import type { Milestone, Task, TaskStatus } from '../../../shared/types.ts';
import { formatDate } from '../format.ts';
import { Icon } from './Icon.tsx';
import { Avatar, cx } from './ui.tsx';

type CommonProps = {
  tasks: Task[];
  childrenOf: (id: string) => Task[];
  milestones: Milestone[];
  canEdit: boolean;
  busyId: string | null;
  onEdit: (task: Task) => void;
  onMove: (task: Task, status: TaskStatus) => void;
  onToggle: (task: Task) => void;
};

function dueLabel(task: Task): string | null {
  return task.dueDate ? formatDate(task.dueDate) : null;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftDays(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function TaskCard({
  task,
  subtasks,
  milestone,
  canEdit,
  busy,
  ...handlers
}: {
  task: Task;
  subtasks: Task[];
  milestone?: Milestone;
  canEdit: boolean;
  busy: boolean;
  onEdit: (task: Task) => void;
  onMove: (task: Task, status: TaskStatus) => void;
  onToggle: (task: Task) => void;
}) {
  const doneChildren = subtasks.filter((child) => child.status === 'done').length;
  return (
    <article
      className={cx('task-card', task.status === 'done' && 'is-done')}
      draggable={canEdit && !busy}
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', task.id);
        event.dataTransfer.effectAllowed = 'move';
      }}
    >
      <div className="task-card-head">
        <button
          type="button"
          className={cx('task-check', task.status === 'done' && 'is-checked')}
          onClick={() => handlers.onToggle(task)}
          disabled={!canEdit || busy}
          aria-pressed={task.status === 'done'}
          aria-label={`${task.status === 'done' ? '重新打开' : '完成'}任务：${task.title}`}
        >
          {task.status === 'done' ? <Icon name="check" size={12} /> : null}
        </button>
        <button type="button" className="task-card-title" onClick={() => handlers.onEdit(task)}>
          {task.title}
        </button>
        <span className="task-priority" data-priority={task.priority}>
          {TASK_PRIORITY_LABELS[task.priority]}
        </span>
      </div>
      <div className="task-card-meta">
        {task.assigneeName ? (
          <span className="task-assignee">
            <Avatar name={task.assigneeName} size={18} />
            {task.assigneeName}
          </span>
        ) : (
          <span className="task-unassigned">未指派</span>
        )}
        {task.dueDate ? (
          <span
            className={cx(
              'task-due',
              task.dueDate < todayKey() && task.status !== 'done' && 'is-overdue',
            )}
          >
            <Icon name="calendar" size={13} />
            {dueLabel(task)}
          </span>
        ) : null}
      </div>
      {milestone ? (
        <p className="task-card-milestone">
          <Icon name="rocket" size={13} />
          {milestone.title}
        </p>
      ) : null}
      {subtasks.length > 0 ? (
        <p className="task-card-subtasks">
          {doneChildren}/{subtasks.length} 子任务完成
        </p>
      ) : null}
      {canEdit ? (
        <select
          className="task-status-select"
          aria-label={`状态：${task.title}`}
          value={task.status}
          disabled={busy}
          onChange={(event) => handlers.onMove(task, event.target.value as TaskStatus)}
        >
          {TASK_STATUSES.map((status) => (
            <option key={status} value={status}>
              {TASK_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      ) : null}
    </article>
  );
}

export function TaskBoard(props: CommonProps) {
  const { tasks, childrenOf, milestones, canEdit, busyId, onEdit, onMove, onToggle } = props;
  const milestoneMap = new Map(milestones.map((milestone) => [milestone.id, milestone]));

  const drop = (status: TaskStatus, event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (!canEdit) return;
    const id = event.dataTransfer.getData('text/plain');
    const task = tasks.find((item) => item.id === id);
    if (task && task.status !== status) onMove(task, status);
  };

  return (
    <div className="task-board">
      {TASK_STATUSES.map((status) => {
        const column = tasks.filter((task) => task.status === status);
        return (
          <div
            key={status}
            className="task-column"
            data-status={status}
            onDragOver={(event) => {
              if (canEdit) event.preventDefault();
            }}
            onDrop={(event) => drop(status, event)}
          >
            <header className="task-column-head">
              <span>{TASK_STATUS_LABELS[status]}</span>
              <strong>{column.length}</strong>
            </header>
            <div className="task-column-body">
              {column.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  subtasks={childrenOf(task.id)}
                  milestone={task.milestoneId ? milestoneMap.get(task.milestoneId) : undefined}
                  canEdit={canEdit}
                  busy={busyId === task.id}
                  onEdit={onEdit}
                  onMove={onMove}
                  onToggle={onToggle}
                />
              ))}
              {column.length === 0 ? <p className="task-column-empty">暂无任务</p> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const BUCKETS = [
  { key: 'overdue', label: '已逾期' },
  { key: 'today', label: '今天' },
  { key: 'week', label: '未来 7 天' },
  { key: 'month', label: '未来 30 天' },
  { key: 'later', label: '更晚' },
  { key: 'unscheduled', label: '未排期' },
] as const;

function bucketOf(dueDate: string | null): (typeof BUCKETS)[number]['key'] {
  if (!dueDate) return 'unscheduled';
  const today = todayKey();
  if (dueDate < today) return 'overdue';
  if (dueDate === today) return 'today';
  if (dueDate <= shiftDays(7)) return 'week';
  if (dueDate <= shiftDays(30)) return 'month';
  return 'later';
}

export function TaskTimeline(props: CommonProps) {
  const { tasks, childrenOf, milestones, busyId, onEdit, onMove, onToggle, canEdit } = props;
  const milestoneMap = new Map(milestones.map((milestone) => [milestone.id, milestone]));
  const buckets = new Map<string, Task[]>();
  for (const task of tasks) {
    const key = bucketOf(task.dueDate);
    const list = buckets.get(key) ?? [];
    list.push(task);
    buckets.set(key, list);
  }
  for (const list of buckets.values()) {
    list.sort((left, right) => (left.dueDate ?? '9999').localeCompare(right.dueDate ?? '9999'));
  }

  return (
    <div className="task-timeline">
      {BUCKETS.map((bucket) => {
        const list = buckets.get(bucket.key) ?? [];
        const bucketMilestones = milestones.filter(
          (milestone) => milestone.dueDate && bucketOf(milestone.dueDate) === bucket.key,
        );
        if (list.length === 0 && bucketMilestones.length === 0) return null;
        return (
          <section key={bucket.key} className="timeline-group" data-bucket={bucket.key}>
            <header className="timeline-head">
              <h3>{bucket.label}</h3>
              <span>{list.length} 个任务</span>
            </header>
            {bucketMilestones.length > 0 ? (
              <div className="timeline-milestones">
                {bucketMilestones.map((milestone) => (
                  <span key={milestone.id} className="milestone-chip is-compact">
                    <Icon name="rocket" size={13} />
                    <strong>{milestone.title}</strong>
                    <span>{formatDate(milestone.dueDate as string)}</span>
                  </span>
                ))}
              </div>
            ) : null}
            <ul className="timeline-list">
              {list.map((task) => {
                const children = childrenOf(task.id);
                const milestone = task.milestoneId ? milestoneMap.get(task.milestoneId) : undefined;
                return (
                  <li key={task.id} className="timeline-row">
                    <button
                      type="button"
                      className={cx('task-check', task.status === 'done' && 'is-checked')}
                      onClick={() => onToggle(task)}
                      disabled={!canEdit || busyId === task.id}
                      aria-pressed={task.status === 'done'}
                      aria-label={`${task.status === 'done' ? '重新打开' : '完成'}任务：${task.title}`}
                    >
                      {task.status === 'done' ? <Icon name="check" size={12} /> : null}
                    </button>
                    <div className="timeline-body">
                      <button type="button" className="timeline-title" onClick={() => onEdit(task)}>
                        {task.title}
                      </button>
                      <span className="timeline-meta">
                        <span className="task-status" data-status={task.status}>
                          {TASK_STATUS_LABELS[task.status]}
                        </span>
                        {task.assigneeName ?? '未指派'}
                        {task.dueDate ? ` · ${formatDate(task.dueDate)}` : ''}
                        {milestone ? ` · ${milestone.title}` : ''}
                        {children.length > 0 ? ` · ${children.length} 个子任务` : ''}
                      </span>
                    </div>
                    {canEdit ? (
                      <select
                        className="task-status-select"
                        aria-label={`状态：${task.title}`}
                        value={task.status}
                        disabled={busyId === task.id}
                        onChange={(event) => onMove(task, event.target.value as TaskStatus)}
                      >
                        {TASK_STATUSES.map((status) => (
                          <option key={status} value={status}>
                            {TASK_STATUS_LABELS[status]}
                          </option>
                        ))}
                      </select>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      {tasks.length === 0 ? <p className="task-empty-note">没有可排期的任务。</p> : null}
    </div>
  );
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function TaskCalendar(props: CommonProps) {
  const { tasks, milestones, canEdit, busyId, onEdit, onMove } = props;
  const now = new Date();
  const [month, setMonth] = useState({ year: now.getFullYear(), month: now.getMonth() });

  const firstWeekday = new Date(Date.UTC(month.year, month.month, 1)).getUTCDay();
  const offset = (firstWeekday + 6) % 7;
  const days = new Date(Date.UTC(month.year, month.month + 1, 0)).getUTCDate();
  const cells: (number | null)[] = [
    ...Array.from({ length: offset }, () => null),
    ...Array.from({ length: days }, (_, index) => index + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const byDay = new Map<string, Task[]>();
  for (const task of tasks) {
    if (!task.dueDate) continue;
    const list = byDay.get(task.dueDate) ?? [];
    list.push(task);
    byDay.set(task.dueDate, list);
  }
  const milestoneByDay = new Map<string, Milestone[]>();
  for (const milestone of milestones) {
    if (!milestone.dueDate) continue;
    const list = milestoneByDay.get(milestone.dueDate) ?? [];
    list.push(milestone);
    milestoneByDay.set(milestone.dueDate, list);
  }

  const move = (delta: number) => {
    const next = new Date(Date.UTC(month.year, month.month + delta, 1));
    setMonth({ year: next.getUTCFullYear(), month: next.getUTCMonth() });
  };

  const today = todayKey();

  return (
    <div className="task-calendar-wrap">
      <header className="task-calendar-head">
        <button
          type="button"
          className="btn btn-icon btn-ghost btn-sm"
          onClick={() => move(-1)}
          aria-label="上个月"
        >
          <Icon name="chevronLeft" size={16} />
        </button>
        <strong>
          {month.year} 年 {month.month + 1} 月
        </strong>
        <button
          type="button"
          className="btn btn-icon btn-ghost btn-sm"
          onClick={() => move(1)}
          aria-label="下个月"
        >
          <Icon name="chevronRight" size={16} />
        </button>
      </header>
      <table className="task-calendar">
        <thead>
          <tr>
            {WEEKDAYS.map((weekday) => (
              <th key={weekday} scope="col">
                {weekday}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: cells.length / 7 }, (_, row) => (
            <tr key={row}>
              {cells.slice(row * 7, row * 7 + 7).map((day, column) => {
                if (day === null) {
                  return <td key={`empty-${column}`} className="task-calendar-empty" />;
                }
                const key = `${month.year}-${pad(month.month + 1)}-${pad(day)}`;
                const dayTasks = byDay.get(key) ?? [];
                const dayMilestones = milestoneByDay.get(key) ?? [];
                return (
                  <td key={key} className={cx('task-calendar-day', key === today && 'is-today')}>
                    <span className="task-calendar-number">{day}</span>
                    {dayMilestones.map((milestone) => (
                      <span key={milestone.id} className="task-calendar-milestone">
                        <Icon name="rocket" size={11} />
                        {milestone.title}
                      </span>
                    ))}
                    {dayTasks.slice(0, 2).map((task) => (
                      <span key={task.id} className="task-calendar-item">
                        <button
                          type="button"
                          className={cx('task-calendar-task', task.status === 'done' && 'is-done')}
                          onClick={() => onEdit(task)}
                        >
                          {task.title}
                        </button>
                        {canEdit ? (
                          <select
                            className="task-calendar-status"
                            aria-label={`状态：${task.title}`}
                            value={task.status}
                            disabled={busyId === task.id}
                            onChange={(event) => onMove(task, event.target.value as TaskStatus)}
                          >
                            {TASK_STATUSES.map((status) => (
                              <option key={status} value={status}>
                                {TASK_STATUS_LABELS[status]}
                              </option>
                            ))}
                          </select>
                        ) : null}
                      </span>
                    ))}
                    {dayTasks.length > 2 ? (
                      <span className="task-calendar-more">+{dayTasks.length - 2} 个</span>
                    ) : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {tasks.length === 0 ? <p className="task-empty-note">没有可排期的任务。</p> : null}
    </div>
  );
}
