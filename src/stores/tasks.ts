import type {
  Milestone,
  ProjectTasks,
  Task,
  TaskPriority,
  TaskStatus,
  UserOption,
} from '../../shared/types.ts';
import type { Database } from '../db.ts';
import type { ActivitiesStore } from './activities.ts';

type TaskRow = {
  id: string;
  project_id: string;
  parent_id: string | null;
  milestone_id: string | null;
  title: string;
  description: string;
  status: string;
  priority: string;
  assignee_id: string | null;
  assignee_name: string | null;
  due_date: string | null;
  sort_order: number;
  completed_at: string | null;
  estimate_points: number | null;
  estimate_hours: number | null;
  estimate_size: string | null;
  created_at: string;
  updated_at: string;
  version: number;
  comment_count: number;
};

type MilestoneRow = {
  id: string;
  project_id: string;
  title: string;
  due_date: string | null;
  created_at: string;
  task_count: number;
  done_count: number;
};

export type TaskCreate = {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assigneeId?: string | null;
  dueDate?: string | null;
  parentId?: string;
  milestoneId?: string | null;
  sortOrder?: number;
  estimatePoints?: number | null;
  estimateHours?: number | null;
  estimateSize?: string | null;
};

export type TaskPatch = {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assigneeId?: string | null;
  dueDate?: string | null;
  parentId?: string | null;
  milestoneId?: string | null;
  sortOrder?: number;
  estimatePoints?: number | null;
  estimateHours?: number | null;
  estimateSize?: string | null;
};

export type TaskCreateResult =
  | { status: 'ok'; task: Task }
  | { status: 'invalid'; message: string };

export type TaskUpdateResult =
  | { status: 'ok'; task: Task }
  | { status: 'invalid'; message: string }
  | { status: 'conflict'; current: Task }
  | { status: 'missing' };

const COLUMNS = `t.id, t.project_id, t.parent_id, t.milestone_id, t.title, t.description,
  t.status, t.priority, t.assignee_id, t.due_date, t.sort_order, t.completed_at,
  t.estimate_points, t.estimate_hours, t.estimate_size,
  t.created_at, t.updated_at, t.version, u.name AS assignee_name,
  (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS comment_count`;

const MAX_TASK_DEPTH = 5;
const MAX_TASKS_PER_PROJECT = 500;

function toTask(row: TaskRow, rollup?: RollupInfo): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    parentId: row.parent_id,
    milestoneId: row.milestone_id,
    title: row.title,
    description: row.description,
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    assigneeId: row.assignee_id,
    assigneeName: row.assignee_name,
    dueDate: row.due_date,
    sortOrder: Number(row.sort_order),
    completedAt: row.completed_at,
    estimatePoints: row.estimate_points,
    estimateHours: row.estimate_hours,
    estimateSize: row.estimate_size,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: Number(row.version),
    commentCount: Number(row.comment_count),
    childCount: rollup?.childCount ?? 0,
    doneChildCount: rollup?.doneChildCount ?? 0,
    rollupProgress: rollup?.rollupProgress ?? (row.status === 'done' ? 100 : 0),
    rollupEstimateHours: rollup?.rollupEstimateHours ?? Number(row.estimate_hours ?? 0),
  };
}

type RollupInfo = {
  childCount: number;
  doneChildCount: number;
  rollupProgress: number;
  rollupEstimateHours: number;
};

function toMilestone(row: MilestoneRow): Milestone {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    dueDate: row.due_date,
    createdAt: row.created_at,
    taskCount: Number(row.task_count),
    doneCount: Number(row.done_count),
  };
}

export class TasksStore {
  readonly #db: Database;
  readonly #activities: ActivitiesStore;

  constructor(db: Database, activities: ActivitiesStore) {
    this.#db = db;
    this.#activities = activities;
  }

  #getRow(id: string): TaskRow | null {
    const row = this.#db
      .stmt(
        `SELECT ${COLUMNS} FROM project_tasks t
         LEFT JOIN users u ON u.id = t.assignee_id
         WHERE t.id = ?`,
      )
      .get(id) as unknown as TaskRow | undefined;
    return row ?? null;
  }

  get(id: string): Task | null {
    const row = this.#getRow(id);
    return row ? toTask(row) : null;
  }

  #projectName(projectId: string): string {
    const row = this.#db.stmt('SELECT name FROM projects WHERE id = ?').get(projectId) as unknown as
      | { name: string }
      | undefined;
    return row?.name ?? '项目';
  }

  #activityProject(projectId: string): { id: string; name: string } {
    return { id: projectId, name: this.#projectName(projectId) };
  }

  #assigneeExists(assigneeId: string): boolean {
    const row = this.#db
      .stmt("SELECT 1 AS present FROM users WHERE id = ? AND status = 'active'")
      .get(assigneeId) as unknown as { present: number } | undefined;
    return Boolean(row);
  }

  #milestoneBelongs(projectId: string, milestoneId: string): boolean {
    const row = this.#db
      .stmt('SELECT 1 AS present FROM project_milestones WHERE id = ? AND project_id = ?')
      .get(milestoneId, projectId) as unknown as { present: number } | undefined;
    return Boolean(row);
  }

  #depth(id: string): number {
    let depth = 0;
    let current: string | null = id;
    while (current && depth <= MAX_TASK_DEPTH + 1) {
      const row: { parent_id: string | null } | undefined = this.#db
        .stmt('SELECT parent_id FROM project_tasks WHERE id = ?')
        .get(current) as unknown as { parent_id: string | null } | undefined;
      if (!row) break;
      current = row.parent_id;
      depth++;
    }
    return depth;
  }

  #subtreeHeight(id: string): number {
    const row = this.#db
      .stmt(
        `WITH RECURSIVE tree(id, depth) AS (
           SELECT id, 1 FROM project_tasks WHERE id = ?
           UNION ALL
           SELECT t.id, tree.depth + 1 FROM project_tasks t JOIN tree ON t.parent_id = tree.id
           WHERE tree.depth < ?
         )
         SELECT COALESCE(MAX(depth), 0) AS height FROM tree`,
      )
      .get(id, MAX_TASK_DEPTH + 1) as unknown as { height: number };
    return Number(row.height);
  }

  #validateParent(projectId: string, parentId: string, taskId?: string): string | null {
    if (taskId && parentId === taskId) return '任务不能作为自己的子任务';
    const parent = this.#getRow(parentId);
    if (!parent || parent.project_id !== projectId) return '父任务不存在';
    if (taskId) {
      let cursor: string | null = parentId;
      const seen = new Set<string>();
      while (cursor) {
        if (cursor === taskId) return '任务层级存在循环引用';
        if (seen.has(cursor)) return '父任务链存在循环引用';
        seen.add(cursor);
        const row: { parent_id: string | null } | undefined = this.#db
          .stmt('SELECT parent_id FROM project_tasks WHERE id = ?')
          .get(cursor) as unknown as { parent_id: string | null } | undefined;
        cursor = row?.parent_id ?? null;
      }
    }
    const height = taskId ? this.#subtreeHeight(taskId) : 1;
    if (this.#depth(parentId) + height > MAX_TASK_DEPTH) {
      return `任务层级最多 ${MAX_TASK_DEPTH} 层`;
    }
    return null;
  }

  validateMove(projectId: string, taskId: string, parentId: string | null): string | null {
    if (!parentId) return null;
    return this.#validateParent(projectId, parentId, taskId);
  }

  reconcile(projectId: string): void {
    const parents = this.#db
      .stmt(
        'SELECT DISTINCT parent_id FROM project_tasks WHERE project_id = ? AND parent_id IS NOT NULL',
      )
      .all(projectId) as unknown as { parent_id: string }[];
    const now = new Date().toISOString();
    for (const row of parents) this.#syncParentChain(row.parent_id, now);
    this.#syncProgress(projectId);
  }

  /** Rolls child status up into ancestors after a structural or status change. */
  #syncParentChain(startingParentId: string | null, now: string): void {
    let cursor = startingParentId;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const children = this.#db
        .stmt('SELECT status FROM project_tasks WHERE parent_id = ?')
        .all(cursor) as unknown as { status: string }[];
      if (children.length === 0) break;
      const statuses = children.map((child) => child.status);
      const next = statuses.every((status) => status === 'done')
        ? 'done'
        : statuses.includes('in_progress')
          ? 'in_progress'
          : statuses.includes('review')
            ? 'review'
            : 'todo';
      const current = this.#db
        .stmt('SELECT status FROM project_tasks WHERE id = ?')
        .get(cursor) as unknown as { status: string } | undefined;
      if (current && current.status !== next) {
        this.#db
          .stmt(
            `UPDATE project_tasks
             SET status = ?, completed_at = ?, updated_at = ?, version = version + 1
             WHERE id = ?`,
          )
          .run(next, next === 'done' ? now : null, now, cursor);
      }
      const parent = this.#db
        .stmt('SELECT parent_id FROM project_tasks WHERE id = ?')
        .get(cursor) as unknown as { parent_id: string | null } | undefined;
      cursor = parent?.parent_id ?? null;
    }
  }

  #validateReferenced(
    projectId: string,
    input: { assigneeId?: string | null; milestoneId?: string | null },
  ): string | null {
    if (input.assigneeId != null && !this.#assigneeExists(input.assigneeId)) {
      return '负责人不存在或已停用';
    }
    if (input.milestoneId != null && !this.#milestoneBelongs(projectId, input.milestoneId)) {
      return '里程碑不存在';
    }
    return null;
  }

  #progress(projectId: string): { total: number; done: number; progress: number } {
    const row = this.#db
      .stmt(
        `SELECT COUNT(*) AS total, COALESCE(SUM(t.status = 'done'), 0) AS done
         FROM project_tasks t
         WHERE t.project_id = ?
           AND NOT EXISTS (SELECT 1 FROM project_tasks c WHERE c.parent_id = t.id)`,
      )
      .get(projectId) as unknown as { total: number; done: number };
    const total = Number(row.total);
    const done = Number(row.done);
    return { total, done, progress: total > 0 ? Math.round((done / total) * 100) : 0 };
  }

  /** Keeps the project progress in sync with leaf tasks and bumps its version. */
  #syncProgress(projectId: string): void {
    const { progress } = this.#progress(projectId);
    const now = new Date().toISOString();
    this.#db
      .stmt(
        `UPDATE projects
         SET progress = ?, updated_at = ?, version = version + 1
         WHERE id = ? AND progress != ?`,
      )
      .run(progress, now, projectId, progress);
  }

  list(projectId: string): ProjectTasks {
    const rows = this.#db
      .stmt(
        `SELECT ${COLUMNS} FROM project_tasks t
         LEFT JOIN users u ON u.id = t.assignee_id
         WHERE t.project_id = ?
         ORDER BY t.parent_id IS NOT NULL, t.sort_order ASC, t.created_at ASC`,
      )
      .all(projectId) as unknown as TaskRow[];
    const milestones = this.#db
      .stmt(
        `SELECT m.id, m.project_id, m.title, m.due_date, m.created_at,
                COUNT(t.id) AS task_count,
                COALESCE(SUM(t.status = 'done'), 0) AS done_count
         FROM project_milestones m
         LEFT JOIN project_tasks t ON t.milestone_id = m.id
         WHERE m.project_id = ?
         GROUP BY m.id
         ORDER BY m.due_date IS NULL, m.due_date ASC, m.created_at ASC`,
      )
      .all(projectId) as unknown as MilestoneRow[];
    const children = new Map<string, TaskRow[]>();
    for (const row of rows) {
      if (!row.parent_id) continue;
      const list = children.get(row.parent_id) ?? [];
      list.push(row);
      children.set(row.parent_id, list);
    }
    const rollups = new Map<string, RollupInfo>();
    const rollupOf = (id: string, seen: Set<string>): RollupInfo => {
      const cached = rollups.get(id);
      if (cached) return cached;
      if (seen.has(id))
        return { childCount: 0, doneChildCount: 0, rollupProgress: 0, rollupEstimateHours: 0 };
      seen.add(id);
      const descendants: TaskRow[] = [];
      const queue = [...(children.get(id) ?? [])];
      while (queue.length > 0) {
        const current = queue.shift() as TaskRow;
        descendants.push(current);
        queue.push(...(children.get(current.id) ?? []));
      }
      const own = rows.find((row) => row.id === id);
      const all = descendants.length > 0 ? descendants : own ? [own] : [];
      const done = all.filter((row) => row.status === 'done').length;
      const info: RollupInfo = {
        childCount: descendants.length,
        doneChildCount: done,
        rollupProgress: all.length > 0 ? Math.round((done / all.length) * 100) : 0,
        rollupEstimateHours: all.reduce((sum, row) => sum + Number(row.estimate_hours ?? 0), 0),
      };
      rollups.set(id, info);
      return info;
    };
    const leaves = rows.filter((row) => !children.get(row.id)?.length);
    const sizes: Record<string, number> = {};
    for (const row of leaves) {
      if (row.estimate_size) sizes[row.estimate_size] = (sizes[row.estimate_size] ?? 0) + 1;
    }
    const hours = leaves.reduce((sum, row) => sum + Number(row.estimate_hours ?? 0), 0);
    const logged = this.#db
      .stmt(
        `SELECT COALESCE(SUM(l.minutes), 0) AS minutes FROM task_time_logs l
         JOIN project_tasks t ON t.id = l.task_id WHERE t.project_id = ?`,
      )
      .get(projectId) as unknown as { minutes: number };
    const loggedHours = Number((Number(logged.minutes) / 60).toFixed(2));
    return {
      tasks: rows.map((row) => toTask(row, rollupOf(row.id, new Set()))),
      milestones: milestones.map(toMilestone),
      progress: this.#progress(projectId).progress,
      estimateTotals: {
        points: leaves.reduce((sum, row) => sum + Number(row.estimate_points ?? 0), 0),
        hours,
        sizes,
        loggedHours,
        varianceHours: Number((loggedHours - hours).toFixed(2)),
      },
    };
  }

  create(projectId: string, input: TaskCreate, actor: UserOption): TaskCreateResult {
    return this.#db.transaction(() => {
      const referenced = this.#validateReferenced(projectId, input);
      if (referenced) return { status: 'invalid', message: referenced } as const;
      if (input.parentId !== undefined) {
        const parentError = this.#validateParent(projectId, input.parentId);
        if (parentError) return { status: 'invalid', message: parentError } as const;
      }
      const count = this.#db
        .stmt('SELECT COUNT(*) AS total FROM project_tasks WHERE project_id = ?')
        .get(projectId) as unknown as { total: number };
      if (Number(count.total) >= MAX_TASKS_PER_PROJECT) {
        return {
          status: 'invalid',
          message: `每个项目最多 ${MAX_TASKS_PER_PROJECT} 个任务`,
        } as const;
      }

      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const status = input.status ?? 'todo';
      let sortOrder = input.sortOrder;
      if (sortOrder === undefined) {
        const row = this.#db
          .stmt(
            'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM project_tasks WHERE project_id = ?',
          )
          .get(projectId) as unknown as { next: number };
        sortOrder = Number(row.next);
      }

      this.#db
        .stmt(
          `INSERT INTO project_tasks
             (id, project_id, parent_id, milestone_id, title, description, status, priority,
              assignee_id, due_date, sort_order, completed_at, estimate_points, estimate_hours,
              estimate_size, created_at, updated_at, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(
          id,
          projectId,
          input.parentId ?? null,
          input.milestoneId ?? null,
          input.title.trim(),
          input.description?.trim() ?? '',
          status,
          input.priority ?? 'medium',
          input.assigneeId ?? null,
          input.dueDate ?? null,
          sortOrder,
          status === 'done' ? now : null,
          input.estimatePoints ?? null,
          input.estimateHours ?? null,
          input.estimateSize ?? null,
          now,
          now,
        );

      this.#syncParentChain(input.parentId ?? null, now);
      this.#syncProgress(projectId);
      this.#activities.record({
        type: 'task.created',
        actor,
        project: this.#activityProject(projectId),
        message: input.parentId
          ? `创建了子任务「${input.title.trim()}」`
          : `创建了任务「${input.title.trim()}」`,
        meta: { taskId: id, status, priority: input.priority ?? 'medium' },
      });

      const task = this.#getRow(id);
      if (!task) throw new Error('task creation failed');
      return { status: 'ok', task: toTask(task) } as const;
    });
  }

  update(
    id: string,
    patch: TaskPatch,
    expectedVersion: number,
    actor: UserOption,
  ): TaskUpdateResult {
    return this.#db.transaction(() => {
      const currentRow = this.#getRow(id);
      if (!currentRow) return { status: 'missing' } as const;
      const projectId = currentRow.project_id;

      const referenced = this.#validateReferenced(projectId, patch);
      if (referenced) return { status: 'invalid', message: referenced } as const;
      if (patch.parentId !== undefined && patch.parentId !== null) {
        const parentError = this.#validateParent(projectId, patch.parentId, id);
        if (parentError) return { status: 'invalid', message: parentError } as const;
      }
      const now = new Date().toISOString();
      const sets = ['updated_at = ?', 'version = version + 1'];
      const params: (string | number | null)[] = [now];

      if (patch.title !== undefined) {
        sets.push('title = ?');
        params.push(patch.title.trim());
      }
      if (patch.description !== undefined) {
        sets.push('description = ?');
        params.push(patch.description.trim());
      }
      if (patch.status !== undefined) {
        sets.push('status = ?', 'completed_at = ?');
        params.push(patch.status, patch.status === 'done' ? now : null);
      }
      if (patch.priority !== undefined) {
        sets.push('priority = ?');
        params.push(patch.priority);
      }
      if (patch.assigneeId !== undefined) {
        sets.push('assignee_id = ?');
        params.push(patch.assigneeId);
      }
      if (patch.dueDate !== undefined) {
        sets.push('due_date = ?');
        params.push(patch.dueDate);
      }
      if (patch.parentId !== undefined) {
        sets.push('parent_id = ?');
        params.push(patch.parentId);
      }
      if (patch.milestoneId !== undefined) {
        sets.push('milestone_id = ?');
        params.push(patch.milestoneId);
      }
      if (patch.sortOrder !== undefined) {
        sets.push('sort_order = ?');
        params.push(patch.sortOrder);
      }
      if (patch.estimatePoints !== undefined) {
        sets.push('estimate_points = ?');
        params.push(patch.estimatePoints);
      }
      if (patch.estimateHours !== undefined) {
        sets.push('estimate_hours = ?');
        params.push(patch.estimateHours);
      }
      if (patch.estimateSize !== undefined) {
        sets.push('estimate_size = ?');
        params.push(patch.estimateSize);
      }

      params.push(id, expectedVersion);
      const updated = this.#db
        .stmt(
          `UPDATE project_tasks SET ${sets.join(', ')}
           WHERE id = ? AND version = ?
           RETURNING id`,
        )
        .get(...params) as unknown as { id: string } | undefined;

      if (!updated) {
        const latest = this.#getRow(id);
        return latest
          ? ({ status: 'conflict', current: toTask(latest) } as const)
          : ({ status: 'missing' } as const);
      }

      if (patch.parentId !== undefined && patch.parentId !== currentRow.parent_id) {
        this.#syncParentChain(currentRow.parent_id, now);
        this.#syncParentChain(patch.parentId, now);
      } else if (patch.status !== undefined) {
        this.#syncParentChain(currentRow.parent_id, now);
      }
      this.#syncProgress(projectId);

      const title = patch.title?.trim() ?? currentRow.title;
      const status = patch.status ?? (currentRow.status as TaskStatus);
      let type: 'task.updated' | 'task.completed' | 'task.reopened' = 'task.updated';
      let message = `更新了任务「${title}」`;
      if (patch.status !== undefined && patch.status !== currentRow.status) {
        if (status === 'done') {
          type = 'task.completed';
          message = `完成了任务「${title}」`;
        } else if (currentRow.status === 'done') {
          type = 'task.reopened';
          message = `重新打开了任务「${title}」`;
        }
      }
      this.#activities.record({
        type,
        actor,
        project: this.#activityProject(projectId),
        message,
        meta: { taskId: id, status },
      });

      const task = this.#getRow(id);
      if (!task) throw new Error('task update failed');
      return { status: 'ok', task: toTask(task) } as const;
    });
  }

  remove(id: string, actor: UserOption): boolean {
    return this.#db.transaction(() => {
      const row = this.#getRow(id);
      if (!row) return false;
      this.#db.stmt('DELETE FROM project_tasks WHERE id = ?').run(id);
      this.#syncParentChain(row.parent_id, new Date().toISOString());
      this.#syncProgress(row.project_id);
      this.#activities.record({
        type: 'task.deleted',
        actor,
        project: this.#activityProject(row.project_id),
        message: `删除了任务「${row.title}」`,
        meta: { taskId: id },
      });
      return true;
    });
  }

  createMilestone(
    projectId: string,
    input: { title: string; dueDate?: string | null },
    actor: UserOption,
  ): Milestone {
    return this.#db.transaction(() => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      this.#db
        .stmt(
          `INSERT INTO project_milestones (id, project_id, title, due_date, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, projectId, input.title.trim(), input.dueDate ?? null, now);
      this.#activities.record({
        type: 'milestone.created',
        actor,
        project: this.#activityProject(projectId),
        message: `创建了里程碑「${input.title.trim()}」`,
        meta: { milestoneId: id },
      });
      const row = this.#db
        .stmt(
          `SELECT id, project_id, title, due_date, created_at, 0 AS task_count, 0 AS done_count
           FROM project_milestones WHERE id = ?`,
        )
        .get(id) as unknown as MilestoneRow;
      return toMilestone(row);
    });
  }

  getMilestone(id: string): Milestone | null {
    const row = this.#db
      .stmt(
        `SELECT m.id, m.project_id, m.title, m.due_date, m.created_at,
                COUNT(t.id) AS task_count, COALESCE(SUM(t.status = 'done'), 0) AS done_count
         FROM project_milestones m
         LEFT JOIN project_tasks t ON t.milestone_id = m.id
         WHERE m.id = ? GROUP BY m.id`,
      )
      .get(id) as unknown as MilestoneRow | undefined;
    return row ? toMilestone(row) : null;
  }

  removeMilestone(id: string, actor: UserOption): Milestone | null {
    return this.#db.transaction(() => {
      const milestone = this.getMilestone(id);
      if (!milestone) return null;
      this.#db.stmt('UPDATE project_tasks SET milestone_id = NULL WHERE milestone_id = ?').run(id);
      this.#db.stmt('DELETE FROM project_milestones WHERE id = ?').run(id);
      this.#activities.record({
        type: 'milestone.deleted',
        actor,
        project: this.#activityProject(milestone.projectId),
        message: `删除了里程碑「${milestone.title}」`,
        meta: { milestoneId: id },
      });
      return milestone;
    });
  }
}
