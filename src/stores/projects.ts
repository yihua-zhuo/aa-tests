import {
  canViewAllProjects,
  PROJECT_STATUS_LABELS,
  PROJECT_STATUSES,
  permissionsForRole,
  sanitizePermissions,
} from '../../shared/permissions.ts';
import { addDays } from '../../shared/ranges.ts';
import type { ProjectTemplate } from '../../shared/templates.ts';
import type {
  ActivityType,
  Project,
  ProjectBatchAction,
  ProjectBatchResult,
  ProjectDetail,
  ProjectDueFilter,
  ProjectListResult,
  ProjectOverview,
  ProjectScaffoldResult,
  ProjectStatus,
  ProjectStatusCounts,
  ProjectTagCount,
  ProjectViewQuery,
  ProjectVisibility,
  Role,
  SavedView,
  UserOption,
} from '../../shared/types.ts';
import { type Database, escapeLike } from '../db.ts';
import { ftsMatch, searchTerms } from '../search.ts';
import type { ActivitiesStore } from './activities.ts';

type ProjectRow = {
  id: string;
  name: string;
  description: string;
  status: string;
  progress: number;
  owner_id: string;
  owner_name: string;
  workspace_id: string;
  visibility: string;
  start_date: string | null;
  due_date: string | null;
  tags: string;
  favorite?: number | null;
  is_demo: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
};

export type ProjectFilters = {
  q?: string;
  status: ProjectStatus | 'all';
  owner: string;
  sort: 'updated' | 'created' | 'name' | 'progress' | 'due';
  tag?: string;
  due?: ProjectDueFilter | 'all';
  favorite?: boolean;
  page: number;
  pageSize: number;
};

export type ProjectCreate = {
  name: string;
  description?: string;
  status?: ProjectStatus;
  progress?: number;
  ownerId?: string;
  startDate?: string | null;
  dueDate?: string | null;
  tags?: string[];
  memberIds?: string[];
  visibility?: ProjectVisibility;
};

export type ProjectPatch = {
  name?: string;
  description?: string;
  status?: ProjectStatus;
  progress?: number;
  ownerId?: string;
  startDate?: string | null;
  dueDate?: string | null;
  tags?: string[];
  memberIds?: string[];
  visibility?: ProjectVisibility;
};

export type UpdateProjectResult =
  | { status: 'ok'; project: ProjectDetail }
  | { status: 'conflict'; current: ProjectDetail }
  | { status: 'missing' };

export type ImportProjectItem = {
  name: string;
  description: string;
  status: ProjectStatus;
  progress: number;
  startDate: string | null;
  dueDate: string | null;
};

export type ResolvedImportItem = ImportProjectItem & {
  row: number;
  ownerEmail: string | null;
  memberEmails: string[];
  ownerId?: string;
  memberIds?: string[];
};

export type ProjectExportFilters = {
  q?: string;
  status?: ProjectStatus | 'all';
  owner?: string;
  tag?: string;
  due?: ProjectDueFilter | 'all';
  favorite?: boolean;
  ids?: string[];
};

const COLUMNS = `p.id, p.name, p.description, p.status, p.progress, p.owner_id,
  p.workspace_id, p.visibility, p.start_date, p.due_date, p.tags, p.is_demo,
  p.created_at, p.updated_at, p.deleted_at, p.version, u.name AS owner_name`;

function parseTags(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((tag): tag is string => typeof tag === 'string' && tag.length > 0);
  } catch {
    return [];
  }
}

function serializeTags(tags: string[] | undefined): string {
  if (!tags || tags.length === 0) return '';
  return JSON.stringify(tags);
}

function parseViewQuery(value: string): ProjectViewQuery {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as ProjectViewQuery)
      : {};
  } catch {
    return {};
  }
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status as ProjectStatus,
    progress: Number(row.progress),
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    workspaceId: row.workspace_id,
    visibility: (row.visibility === 'private' ? 'private' : 'workspace') as ProjectVisibility,
    startDate: row.start_date,
    dueDate: row.due_date,
    tags: parseTags(row.tags),
    favorite: Number(row.favorite ?? 0) === 1,
    isDemo: row.is_demo === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    version: Number(row.version),
  };
}

function emptyCounts(): ProjectStatusCounts {
  return { all: 0, planning: 0, active: 0, on_hold: 0, completed: 0, archived: 0 };
}

const SORTS = {
  updated: 'p.updated_at DESC',
  created: 'p.created_at DESC',
  name: 'p.name COLLATE NOCASE ASC',
  progress: 'p.progress DESC, p.updated_at DESC',
  due: 'p.due_date IS NULL, p.due_date ASC, p.updated_at DESC',
} as const;

export class ProjectsStore {
  readonly #db: Database;
  readonly #activities: ActivitiesStore;

  constructor(db: Database, activities: ActivitiesStore) {
    this.#db = db;
    this.#activities = activities;
  }

  #scope(role: Role, userId: string): { sql: string; params: string[] } {
    const viewer = this.#db
      .stmt(
        `SELECT u.workspace_id, cr.permissions
         FROM users u LEFT JOIN custom_roles cr ON cr.id = u.custom_role_id
         WHERE u.id = ?`,
      )
      .get(userId) as unknown as
      | { workspace_id: string | null; permissions: string | null }
      | undefined;
    const workspaceId = viewer?.workspace_id ?? 'ws_default';
    let extras: string[] = [];
    try {
      extras = sanitizePermissions(JSON.parse(viewer?.permissions ?? '[]'));
    } catch {
      extras = [];
    }
    const now = new Date().toISOString();
    const jitRows = this.#db
      .stmt(
        `SELECT permissions_json FROM jit_grants
         WHERE user_id = ? AND status = 'active' AND starts_at <= ? AND expires_at > ?`,
      )
      .all(userId, now, now) as unknown as { permissions_json: string }[];
    for (const row of jitRows) {
      try {
        extras.push(...sanitizePermissions(JSON.parse(row.permissions_json)));
      } catch {
        // ignore malformed grants; authorization falls back to base permissions
      }
    }
    const permissions = permissionsForRole(role, extras);
    const member = `(p.owner_id = ? OR EXISTS (
      SELECT 1 FROM project_members m
      WHERE m.project_id = p.id AND m.user_id = ?
    ))`;
    if (role === 'admin') {
      return { sql: 'p.workspace_id = ?', params: [workspaceId] };
    }
    if (canViewAllProjects(role, permissions)) {
      return {
        sql: `p.workspace_id = ? AND (p.visibility = 'workspace' OR ${member})`,
        params: [workspaceId, userId, userId],
      };
    }
    return {
      sql: `p.workspace_id = ? AND ${member}`,
      params: [workspaceId, userId, userId],
    };
  }

  #conditions(
    role: Role,
    userId: string,
    filters: {
      q?: string;
      status?: ProjectStatus | 'all';
      owner?: string;
      tag?: string;
      due?: ProjectDueFilter | 'all';
      favorite?: boolean;
    },
    options: { useFts: boolean; includeStatus: boolean; includeTag?: boolean },
  ): { where: string[]; params: (string | number)[] } {
    const scope = this.#scope(role, userId);
    const where: string[] = [scope.sql, 'p.deleted_at IS NULL'];
    const params: (string | number)[] = [...scope.params];

    if (filters.q) {
      const match = options.useFts ? ftsMatch(filters.q) : null;
      if (match) {
        where.push('p.rowid IN (SELECT rowid FROM projects_fts WHERE projects_fts MATCH ?)');
        params.push(match);
      } else {
        for (const term of searchTerms(filters.q)) {
          where.push("(p.name LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\')");
          const like = `%${escapeLike(term)}%`;
          params.push(like, like);
        }
      }
    }
    if (filters.owner && filters.owner !== 'all') {
      where.push('p.owner_id = ?');
      params.push(filters.owner === 'me' ? userId : filters.owner);
    }
    if (options.includeStatus && filters.status && filters.status !== 'all') {
      where.push('p.status = ?');
      params.push(filters.status);
    }
    if (options.includeTag !== false && filters.tag) {
      where.push(
        `EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(p.tags) THEN p.tags ELSE '[]' END) jt
           WHERE jt.value = ?)`,
      );
      params.push(filters.tag);
    }
    if (filters.favorite) {
      where.push(
        'EXISTS (SELECT 1 FROM project_favorites f WHERE f.project_id = p.id AND f.user_id = ?)',
      );
      params.push(userId);
    }
    if (filters.due && filters.due !== 'all') {
      const today = new Date().toISOString().slice(0, 10);
      if (filters.due === 'overdue') {
        where.push(
          "p.due_date IS NOT NULL AND p.due_date < ? AND p.status NOT IN ('completed', 'archived')",
        );
        params.push(today);
      } else {
        where.push('p.due_date IS NOT NULL AND p.due_date >= ? AND p.due_date <= ?');
        params.push(today, addDays(today, filters.due === 'week' ? 7 : 30));
      }
    }
    return { where, params };
  }

  list(role: Role, userId: string, filters: ProjectFilters): ProjectListResult {
    const useFts = filters.q ? ftsMatch(filters.q) !== null : false;
    try {
      return this.#runList(role, userId, filters, useFts);
    } catch (error) {
      if (!useFts) throw error;
      return this.#runList(role, userId, filters, false);
    }
  }

  #runList(
    role: Role,
    userId: string,
    filters: ProjectFilters,
    useFts: boolean,
  ): ProjectListResult {
    const scoped = this.#conditions(role, userId, filters, {
      useFts,
      includeStatus: true,
    });
    const clause = scoped.where.join(' AND ');
    const totalRow = this.#db
      .stmt(`SELECT COUNT(*) AS total FROM projects p WHERE ${clause}`)
      .get(...scoped.params) as unknown as { total: number };

    const rows = this.#db
      .stmt(
        `SELECT ${COLUMNS},
           EXISTS (
             SELECT 1 FROM project_favorites f WHERE f.project_id = p.id AND f.user_id = ?
           ) AS favorite
         FROM projects p JOIN users u ON u.id = p.owner_id
         WHERE ${clause}
         ORDER BY ${SORTS[filters.sort]}
         LIMIT ? OFFSET ?`,
      )
      .all(
        userId,
        ...scoped.params,
        filters.pageSize,
        (filters.page - 1) * filters.pageSize,
      ) as unknown as ProjectRow[];

    const countFilters = this.#conditions(role, userId, filters, {
      useFts,
      includeStatus: false,
    });
    const countRows = this.#db
      .stmt(
        `SELECT p.status AS status, COUNT(*) AS total
         FROM projects p WHERE ${countFilters.where.join(' AND ')}
         GROUP BY p.status`,
      )
      .all(...countFilters.params) as unknown as { status: string; total: number }[];

    const counts = emptyCounts();
    for (const row of countRows) {
      if (row.status in counts) {
        counts[row.status as ProjectStatus] = Number(row.total);
      }
      counts.all += Number(row.total);
    }

    const tagFilters = this.#conditions(role, userId, filters, {
      useFts,
      includeStatus: true,
      includeTag: false,
    });
    const tagRows = this.#db
      .stmt(
        `SELECT jt.value AS tag, COUNT(*) AS total
         FROM projects p, json_each(CASE WHEN json_valid(p.tags) THEN p.tags ELSE '[]' END) jt
         WHERE ${tagFilters.where.join(' AND ')}
         GROUP BY jt.value
         ORDER BY total DESC, jt.value COLLATE NOCASE ASC
         LIMIT 24`,
      )
      .all(...tagFilters.params) as unknown as { tag: string; total: number }[];

    const tags: ProjectTagCount[] = tagRows.map((row) => ({
      tag: row.tag,
      count: Number(row.total),
    }));

    return {
      projects: rows.map(toProject),
      total: Number(totalRow.total),
      page: filters.page,
      pageSize: filters.pageSize,
      counts,
      tags,
    };
  }

  #members(projectId: string): UserOption[] {
    return this.#db
      .stmt(
        `SELECT u.id, u.name FROM project_members m
         JOIN users u ON u.id = m.user_id
         WHERE m.project_id = ? ORDER BY u.name COLLATE NOCASE`,
      )
      .all(projectId) as unknown as UserOption[];
  }

  #getUnscoped(id: string, includeDeleted = false, viewerId?: string): ProjectDetail | null {
    const favoriteSql = viewerId
      ? `, EXISTS (
           SELECT 1 FROM project_favorites f WHERE f.project_id = p.id AND f.user_id = ?
         ) AS favorite`
      : '';
    const stmt = this.#db.stmt(
      `SELECT ${COLUMNS}${favoriteSql} FROM projects p JOIN users u ON u.id = p.owner_id
       WHERE p.id = ?${includeDeleted ? '' : ' AND p.deleted_at IS NULL'}`,
    );
    const row = (viewerId ? stmt.get(viewerId, id) : stmt.get(id)) as unknown as
      | ProjectRow
      | undefined;
    if (!row) return null;
    return { ...toProject(row), members: this.#members(id) };
  }

  get(id: string, role: Role, userId: string): ProjectDetail | null {
    const scope = this.#scope(role, userId);
    const row = this.#db
      .stmt(
        `SELECT ${COLUMNS},
           EXISTS (
             SELECT 1 FROM project_favorites f WHERE f.project_id = p.id AND f.user_id = ?
           ) AS favorite
         FROM projects p JOIN users u ON u.id = p.owner_id
         WHERE p.id = ? AND p.deleted_at IS NULL AND ${scope.sql}`,
      )
      .get(userId, id, ...scope.params) as unknown as ProjectRow | undefined;
    if (!row) return null;
    return { ...toProject(row), members: this.#members(id) };
  }

  /** IDs the user may see, used to trim cross-entity references. */
  visibleProjectIds(role: Role, userId: string): Set<string> {
    const scope = this.#scope(role, userId);
    const rows = this.#db
      .stmt(`SELECT p.id FROM projects p WHERE p.deleted_at IS NULL AND ${scope.sql}`)
      .all(...scope.params) as unknown as { id: string }[];
    return new Set(rows.map((row) => row.id));
  }

  access(id: string): {
    ownerId: string;
    memberIds: string[];
    visibility: ProjectVisibility;
    workspaceId: string;
  } | null {
    const row = this.#db
      .stmt(
        'SELECT owner_id, visibility, workspace_id FROM projects WHERE id = ? AND deleted_at IS NULL',
      )
      .get(id) as unknown as
      | { owner_id: string; visibility: string; workspace_id: string }
      | undefined;
    if (!row) return null;
    const members = this.#db
      .stmt('SELECT user_id FROM project_members WHERE project_id = ?')
      .all(id) as unknown as { user_id: string }[];
    return {
      ownerId: row.owner_id,
      memberIds: members.map((member) => member.user_id),
      visibility: row.visibility === 'private' ? 'private' : 'workspace',
      workspaceId: row.workspace_id,
    };
  }

  #workspaceFor(userId: string): string {
    const row = this.#db
      .stmt('SELECT workspace_id FROM users WHERE id = ?')
      .get(userId) as unknown as { workspace_id: string | null } | undefined;
    return row?.workspace_id ?? 'ws_default';
  }

  #insertMembers(projectId: string, memberIds: string[], ownerId: string): void {
    const unique = [...new Set(memberIds)].filter((id) => id !== ownerId);
    if (unique.length === 0) return;
    const insert = this.#db.stmt(
      'INSERT OR IGNORE INTO project_members (project_id, user_id, added_at) VALUES (?, ?, ?)',
    );
    const now = new Date().toISOString();
    for (const memberId of unique) insert.run(projectId, memberId, now);
  }

  create(
    input: ProjectCreate,
    actor: UserOption,
    options: { ownerName?: string; isDemo?: boolean; createdAt?: string } = {},
  ): ProjectDetail {
    const now = options.createdAt ?? new Date().toISOString();
    const ownerId = input.ownerId ?? actor.id;
    const id = crypto.randomUUID();
    const status = input.status ?? 'planning';
    const progress = Math.max(0, Math.min(100, Math.round(input.progress ?? 0)));

    return this.#db.transaction(() => {
      this.#db
        .stmt(
          `INSERT INTO projects
             (id, name, description, status, progress, owner_id, workspace_id, visibility,
              start_date, due_date, tags, is_demo, legacy_task_id, created_at, updated_at, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1)`,
        )
        .run(
          id,
          input.name.trim(),
          input.description?.trim() ?? '',
          status,
          progress,
          ownerId,
          this.#workspaceFor(ownerId),
          input.visibility ?? 'workspace',
          input.startDate ?? null,
          input.dueDate ?? null,
          serializeTags(input.tags),
          options.isDemo ? 1 : 0,
          now,
          now,
        );
      this.#insertMembers(id, input.memberIds ?? [], ownerId);

      this.#activities.record({
        type: 'project.created',
        actor,
        project: { id, name: input.name.trim() },
        message: `创建了项目「${input.name.trim()}」`,
        meta: { status },
      });

      const project = this.#getUnscoped(id, false, actor.id);
      if (!project) throw new Error('project creation failed');
      return project;
    });
  }

  applyTemplate(
    template: ProjectTemplate,
    input: {
      name?: string;
      description?: string;
      ownerId?: string;
      startDate: string;
      memberIds?: string[];
    },
    actor: UserOption,
  ): ProjectScaffoldResult {
    const now = new Date().toISOString();
    const ownerId = input.ownerId ?? actor.id;
    const start = input.startDate;
    const name = (input.name?.trim() || template.name).slice(0, 120);
    const description = input.description?.trim() || template.description;
    const dueDate = addDays(start, template.durationDays);

    return this.#db.transaction(() => {
      const id = crypto.randomUUID();
      this.#db
        .stmt(
          `INSERT INTO projects
             (id, name, description, status, progress, owner_id, workspace_id, visibility,
              start_date, due_date, is_demo, legacy_task_id, created_at, updated_at, version)
           VALUES (?, ?, ?, 'planning', 0, ?, ?, 'workspace', ?, ?, 0, NULL, ?, ?, 1)`,
        )
        .run(id, name, description, ownerId, this.#workspaceFor(ownerId), start, dueDate, now, now);
      this.#insertMembers(id, input.memberIds ?? [], ownerId);

      const milestoneIds = new Map<string, string>();
      const insertMilestone = this.#db.stmt(
        `INSERT INTO project_milestones (id, project_id, title, due_date, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const milestone of template.milestones) {
        const milestoneId = crypto.randomUUID();
        milestoneIds.set(milestone.key, milestoneId);
        insertMilestone.run(
          milestoneId,
          id,
          milestone.title,
          addDays(start, milestone.dueOffsetDays),
          now,
        );
      }

      const insertTask = this.#db.stmt(
        `INSERT INTO project_tasks
           (id, project_id, parent_id, milestone_id, title, description, status, priority,
            assignee_id, due_date, sort_order, completed_at, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, 'todo', ?, NULL, ?, ?, NULL, ?, ?, 1)`,
      );
      const dueDateOf = (offset: number | null) =>
        offset === null ? null : addDays(start, offset);
      let sortOrder = 0;
      let taskCount = 0;
      for (const task of template.tasks) {
        const taskId = crypto.randomUUID();
        const milestoneId = task.milestoneKey
          ? (milestoneIds.get(task.milestoneKey) ?? null)
          : null;
        insertTask.run(
          taskId,
          id,
          null,
          milestoneId,
          task.title,
          task.description,
          task.priority,
          dueDateOf(task.dueOffsetDays),
          sortOrder++,
          now,
          now,
        );
        taskCount++;
        for (const subtask of task.subtasks) {
          insertTask.run(
            crypto.randomUUID(),
            id,
            taskId,
            milestoneId,
            subtask.title,
            subtask.description,
            subtask.priority,
            dueDateOf(subtask.dueOffsetDays),
            sortOrder++,
            now,
            now,
          );
          taskCount++;
        }
      }

      this.#activities.record({
        type: 'project.template_applied',
        actor,
        project: { id, name },
        message: `从模板「${template.name}」创建了项目「${name}」`,
        meta: {
          templateId: template.id,
          templateName: template.name,
          tasks: taskCount,
          milestones: template.milestones.length,
        },
      });

      const project = this.#getUnscoped(id);
      if (!project) throw new Error('project creation failed');
      return {
        project,
        tasks: taskCount,
        milestones: template.milestones.length,
      };
    });
  }

  duplicate(
    id: string,
    input: {
      name?: string;
      dateOffsetDays: number;
      includeMembers: boolean;
      includeTasks: boolean;
    },
    actor: UserOption,
  ): ProjectScaffoldResult | null {
    return this.#db.transaction(() => {
      const source = this.#getUnscoped(id);
      if (!source) return null;

      const now = new Date().toISOString();
      const newId = crypto.randomUUID();
      const offset = input.dateOffsetDays;
      const shift = (value: string | null) => (value === null ? null : addDays(value, offset));
      const name = (input.name?.trim() || `${source.name} 副本`).slice(0, 120);
      const status = 'planning';

      const insertProject = this.#db.stmt(
        `INSERT INTO projects
           (id, name, description, status, progress, owner_id, workspace_id, visibility,
            start_date, due_date, is_demo, legacy_task_id, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 0, NULL, ?, ?, 1)`,
      );

      let milestoneCount = 0;
      let taskCount = 0;

      insertProject.run(
        newId,
        name,
        source.description,
        status,
        source.ownerId,
        source.workspaceId,
        source.visibility,
        shift(source.startDate),
        shift(source.dueDate),
        now,
        now,
      );

      if (input.includeMembers) {
        const memberIds = this.#db
          .stmt(
            `SELECT m.user_id FROM project_members m
             JOIN users u ON u.id = m.user_id
             WHERE m.project_id = ? AND u.status = 'active'`,
          )
          .all(id) as unknown as { user_id: string }[];
        this.#insertMembers(
          newId,
          memberIds.map((member) => member.user_id),
          source.ownerId,
        );
      }

      if (input.includeTasks) {
        const milestoneIds = new Map<string, string>();
        const milestones = this.#db
          .stmt(
            `SELECT id, title, due_date FROM project_milestones
             WHERE project_id = ? ORDER BY due_date IS NULL, due_date ASC, created_at ASC`,
          )
          .all(id) as unknown as { id: string; title: string; due_date: string | null }[];
        const insertMilestone = this.#db.stmt(
          `INSERT INTO project_milestones (id, project_id, title, due_date, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        );
        for (const milestone of milestones) {
          const milestoneId = crypto.randomUUID();
          milestoneIds.set(milestone.id, milestoneId);
          insertMilestone.run(milestoneId, newId, milestone.title, shift(milestone.due_date), now);
        }
        milestoneCount = milestones.length;

        const tasks = this.#db
          .stmt(
            `SELECT id, parent_id, milestone_id, title, description, status, priority,
                    assignee_id, due_date, sort_order
             FROM project_tasks WHERE project_id = ?
             ORDER BY parent_id IS NOT NULL, sort_order ASC, created_at ASC`,
          )
          .all(id) as unknown as {
          id: string;
          parent_id: string | null;
          milestone_id: string | null;
          title: string;
          description: string;
          status: string;
          priority: string;
          assignee_id: string | null;
          due_date: string | null;
          sort_order: number;
        }[];
        const taskIds = new Map<string, string>();
        const insertTask = this.#db.stmt(
          `INSERT INTO project_tasks
             (id, project_id, parent_id, milestone_id, title, description, status, priority,
              assignee_id, due_date, sort_order, completed_at, created_at, updated_at, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        );
        for (const task of tasks) {
          const taskId = crypto.randomUUID();
          taskIds.set(task.id, taskId);
          insertTask.run(
            taskId,
            newId,
            task.parent_id ? (taskIds.get(task.parent_id) ?? null) : null,
            task.milestone_id ? (milestoneIds.get(task.milestone_id) ?? null) : null,
            task.title,
            task.description,
            task.status,
            task.priority,
            task.assignee_id,
            shift(task.due_date),
            Number(task.sort_order),
            task.status === 'done' ? now : null,
            now,
            now,
          );
          taskCount++;
        }

        const leaf = this.#db
          .stmt(
            `SELECT COUNT(*) AS total, COALESCE(SUM(t.status = 'done'), 0) AS done
             FROM project_tasks t
             WHERE t.project_id = ?
               AND NOT EXISTS (SELECT 1 FROM project_tasks c WHERE c.parent_id = t.id)`,
          )
          .get(newId) as unknown as { total: number; done: number };
        const total = Number(leaf.total);
        const progress = total > 0 ? Math.round((Number(leaf.done) / total) * 100) : 0;
        this.#db.stmt('UPDATE projects SET progress = ? WHERE id = ?').run(progress, newId);
      }

      this.#activities.record({
        type: 'project.duplicated',
        actor,
        project: { id: newId, name },
        message: `复制项目「${source.name}」创建了「${name}」`,
        meta: {
          sourceId: source.id,
          sourceName: source.name,
          offsetDays: offset,
          tasks: taskCount,
          milestones: milestoneCount,
          members: input.includeMembers,
        },
      });

      const project = this.#getUnscoped(newId);
      if (!project) throw new Error('project duplication failed');
      return { project, tasks: taskCount, milestones: milestoneCount };
    });
  }

  update(
    id: string,
    patch: ProjectPatch,
    expectedVersion: number,
    actor: UserOption,
  ): UpdateProjectResult {
    return this.#db.transaction(() => {
      const current = this.#getUnscoped(id, false, actor.id);
      if (!current) return { status: 'missing' } as const;

      const now = new Date().toISOString();
      const sets = ['updated_at = ?', 'version = version + 1'];
      const params: (string | number | null)[] = [now];

      if (patch.name !== undefined) {
        sets.push('name = ?');
        params.push(patch.name.trim());
      }
      if (patch.description !== undefined) {
        sets.push('description = ?');
        params.push(patch.description.trim());
      }
      if (patch.status !== undefined) {
        sets.push('status = ?');
        params.push(patch.status);
      }
      if (patch.progress !== undefined) {
        sets.push('progress = ?');
        params.push(Math.max(0, Math.min(100, Math.round(patch.progress))));
      }
      if (patch.ownerId !== undefined) {
        sets.push('owner_id = ?');
        params.push(patch.ownerId);
      }
      if (patch.visibility !== undefined) {
        sets.push('visibility = ?');
        params.push(patch.visibility);
      }
      if (patch.startDate !== undefined) {
        sets.push('start_date = ?');
        params.push(patch.startDate);
      }
      if (patch.dueDate !== undefined) {
        sets.push('due_date = ?');
        params.push(patch.dueDate);
      }
      if (patch.tags !== undefined) {
        sets.push('tags = ?');
        params.push(serializeTags(patch.tags));
      }

      params.push(id, expectedVersion);
      const row = this.#db
        .stmt(
          `UPDATE projects SET ${sets.join(', ')}
           WHERE id = ? AND version = ?
           RETURNING id`,
        )
        .get(...params) as unknown as { id: string } | undefined;

      if (!row) {
        const latest = this.#getUnscoped(id, false, actor.id);
        return latest
          ? ({ status: 'conflict', current: latest } as const)
          : ({ status: 'missing' } as const);
      }

      if (patch.memberIds !== undefined) {
        this.#db.stmt('DELETE FROM project_members WHERE project_id = ?').run(id);
        const ownerId = patch.ownerId ?? current.ownerId;
        this.#insertMembers(id, patch.memberIds, ownerId);
      }

      const project = this.#getUnscoped(id, false, actor.id);
      if (!project) throw new Error('project update failed');

      this.#recordUpdate(current, project, patch, actor);
      return { status: 'ok', project } as const;
    });
  }

  #recordUpdate(
    before: ProjectDetail,
    after: ProjectDetail,
    patch: ProjectPatch,
    actor: UserOption,
  ): void {
    const project = { id: after.id, name: after.name };

    if (patch.status !== undefined && patch.status !== before.status) {
      let type: ActivityType = 'project.status_changed';
      let message = `将「${after.name}」状态从 ${PROJECT_STATUS_LABELS[before.status]} 调整为 ${
        PROJECT_STATUS_LABELS[after.status]
      }`;
      if (after.status === 'completed') {
        type = 'project.completed';
        message = `完成了项目「${after.name}」`;
      } else if (after.status === 'archived') {
        type = 'project.archived';
        message = `归档了项目「${after.name}」`;
      } else if (before.status === 'archived') {
        type = 'project.restored';
        message = `恢复了项目「${after.name}」`;
      }
      this.#activities.record({
        type,
        actor,
        project,
        message,
        meta: { from: before.status, to: after.status },
      });
    } else if (
      patch.name !== undefined ||
      patch.description !== undefined ||
      patch.progress !== undefined ||
      patch.ownerId !== undefined ||
      patch.startDate !== undefined ||
      patch.dueDate !== undefined ||
      patch.tags !== undefined
    ) {
      this.#activities.record({
        type: 'project.updated',
        actor,
        project,
        message: `更新了项目「${after.name}」`,
        meta: { progress: after.progress },
      });
    }

    if (patch.memberIds !== undefined) {
      this.#activities.record({
        type: 'project.member_added',
        actor,
        project,
        message: `调整了项目「${after.name}」的成员`,
        meta: { members: after.members.map((member) => member.name) },
      });
    }
  }

  remove(id: string, actor: UserOption): boolean {
    return this.#db.transaction(() => {
      const project = this.#getUnscoped(id);
      if (!project) return false;
      const now = new Date().toISOString();
      this.#activities.record({
        type: 'project.deleted',
        actor,
        project: { id: project.id, name: project.name },
        message: `将项目「${project.name}」移入了回收站`,
      });
      this.#db
        .stmt(
          'UPDATE projects SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?',
        )
        .run(now, now, id);
      return true;
    });
  }

  restore(id: string, actor: UserOption): ProjectDetail | null {
    return this.#db.transaction(() => {
      const project = this.#getUnscoped(id, true);
      if (!project || project.deletedAt === null) return null;
      const now = new Date().toISOString();
      this.#db
        .stmt(
          'UPDATE projects SET deleted_at = NULL, updated_at = ?, version = version + 1 WHERE id = ?',
        )
        .run(now, id);
      this.#activities.record({
        type: 'project.restored',
        actor,
        project: { id: project.id, name: project.name },
        message: `从回收站恢复了项目「${project.name}」`,
      });
      return this.#getUnscoped(id);
    });
  }

  trash(role: Role, userId: string, limit = 100): Project[] {
    const scope = this.#scope(role, userId);
    const rows = this.#db
      .stmt(
        `SELECT ${COLUMNS},
           EXISTS (
             SELECT 1 FROM project_favorites f WHERE f.project_id = p.id AND f.user_id = ?
           ) AS favorite
         FROM projects p JOIN users u ON u.id = p.owner_id
         WHERE p.deleted_at IS NOT NULL AND ${scope.sql}
         ORDER BY p.deleted_at DESC LIMIT ?`,
      )
      .all(userId, ...scope.params, limit) as unknown as ProjectRow[];
    return rows.map(toProject);
  }

  isDeleted(id: string): boolean {
    const row = this.#db
      .stmt('SELECT 1 AS found FROM projects WHERE id = ? AND deleted_at IS NOT NULL')
      .get(id) as unknown as { found: number } | undefined;
    return row !== undefined;
  }

  setFavorite(projectId: string, userId: string, favorite: boolean): void {
    if (favorite) {
      this.#db
        .stmt(
          'INSERT OR IGNORE INTO project_favorites (user_id, project_id, created_at) VALUES (?, ?, ?)',
        )
        .run(userId, projectId, new Date().toISOString());
      return;
    }
    this.#db
      .stmt('DELETE FROM project_favorites WHERE user_id = ? AND project_id = ?')
      .run(userId, projectId);
  }

  batch(
    ids: string[],
    action: ProjectBatchAction,
    patch: { status?: ProjectStatus; ownerId?: string },
    actor: UserOption,
  ): ProjectBatchResult {
    return this.#db.transaction(() => {
      const now = new Date().toISOString();
      const skipped: string[] = [];
      let updated = 0;

      for (const id of new Set(ids)) {
        const before = this.#getUnscoped(id, false, actor.id);
        if (!before) {
          skipped.push(id);
          continue;
        }
        const nextStatus =
          action === 'archive' ? 'archived' : action === 'status' ? patch.status : undefined;
        const nextOwner = action === 'owner' ? patch.ownerId : undefined;
        if (
          (nextStatus === undefined || nextStatus === before.status) &&
          (nextOwner === undefined || nextOwner === before.ownerId)
        ) {
          skipped.push(id);
          continue;
        }

        const sets = ['updated_at = ?', 'version = version + 1'];
        const params: (string | number)[] = [now];
        if (nextStatus !== undefined) {
          sets.push('status = ?');
          params.push(nextStatus);
        }
        if (nextOwner !== undefined) {
          sets.push('owner_id = ?');
          params.push(nextOwner);
        }
        params.push(id);
        this.#db.stmt(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...params);

        const after = this.#getUnscoped(id, false, actor.id);
        if (after) {
          this.#recordUpdate(before, after, { status: nextStatus, ownerId: nextOwner }, actor);
          updated++;
        } else {
          skipped.push(id);
        }
      }

      return { updated, skipped };
    });
  }

  savedViews(userId: string): SavedView[] {
    const rows = this.#db
      .stmt(
        `SELECT id, name, query, created_at, updated_at FROM saved_views
         WHERE user_id = ? ORDER BY updated_at DESC, name COLLATE NOCASE`,
      )
      .all(userId) as unknown as {
      id: string;
      name: string;
      query: string;
      created_at: string;
      updated_at: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      query: parseViewQuery(row.query),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  createSavedView(
    userId: string,
    name: string,
    query: ProjectViewQuery,
    limit = 20,
  ): SavedView | 'limit' | 'duplicate' {
    return this.#db.transaction(() => {
      if (this.#savedViewNameTaken(userId, name)) return 'duplicate' as const;
      const count = this.#db
        .stmt('SELECT COUNT(*) AS total FROM saved_views WHERE user_id = ?')
        .get(userId) as unknown as { total: number };
      if (Number(count.total) >= limit) return 'limit' as const;

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      this.#db
        .stmt(
          `INSERT INTO saved_views (id, user_id, name, query, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, userId, name.trim(), JSON.stringify(query), now, now);
      return {
        id,
        name: name.trim(),
        query,
        createdAt: now,
        updatedAt: now,
      };
    });
  }

  updateSavedView(
    userId: string,
    id: string,
    patch: { name?: string; query?: ProjectViewQuery },
  ): SavedView | 'missing' | 'duplicate' {
    return this.#db.transaction(() => {
      const current = this.#db
        .stmt(
          'SELECT id, name, query, created_at, updated_at FROM saved_views WHERE id = ? AND user_id = ?',
        )
        .get(id, userId) as unknown as
        | { id: string; name: string; query: string; created_at: string; updated_at: string }
        | undefined;
      if (!current) return 'missing' as const;
      if (patch.name !== undefined && this.#savedViewNameTaken(userId, patch.name, id)) {
        return 'duplicate' as const;
      }

      const now = new Date().toISOString();
      const name = patch.name?.trim() ?? current.name;
      const query = patch.query ?? parseViewQuery(current.query);
      this.#db
        .stmt(
          'UPDATE saved_views SET name = ?, query = ?, updated_at = ? WHERE id = ? AND user_id = ?',
        )
        .run(name, JSON.stringify(query), now, id, userId);
      return {
        id,
        name,
        query,
        createdAt: current.created_at,
        updatedAt: now,
      };
    });
  }

  deleteSavedView(userId: string, id: string): boolean {
    const result = this.#db
      .stmt('DELETE FROM saved_views WHERE id = ? AND user_id = ?')
      .run(id, userId);
    return Number(result.changes) > 0;
  }

  #savedViewNameTaken(userId: string, name: string, excludeId?: string): boolean {
    const row = this.#db
      .stmt(
        `SELECT 1 AS found FROM saved_views
         WHERE user_id = ? AND lower(name) = lower(?)${excludeId ? ' AND id != ?' : ''}`,
      )
      .get(...(excludeId ? [userId, name.trim(), excludeId] : [userId, name.trim()]));
    return row !== undefined;
  }

  purge(id: string): boolean {
    const result = this.#db.stmt('DELETE FROM projects WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  cleanupDeleted(days: number, now = Date.now()): number {
    if (!Number.isFinite(days) || days <= 0) return 0;
    const cutoff = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
    const result = this.#db
      .stmt('DELETE FROM projects WHERE deleted_at IS NOT NULL AND deleted_at <= ?')
      .run(cutoff);
    return Number(result.changes);
  }

  *exportRows(role: Role, userId: string, filters: ProjectExportFilters = {}): Generator<Project> {
    const scoped = this.#exportConditions(role, userId, filters);
    const rows = this.#db
      .stmt(
        `SELECT ${COLUMNS}
         FROM projects p JOIN users u ON u.id = p.owner_id
         WHERE ${scoped.where.join(' AND ')}
         ORDER BY p.updated_at DESC`,
      )
      .iterate(...scoped.params) as unknown as Iterable<ProjectRow>;
    for (const row of rows) yield toProject(row);
  }

  #exportConditions(
    role: Role,
    userId: string,
    filters: ProjectExportFilters,
  ): { where: string[]; params: (string | number)[] } {
    const scoped = this.#conditions(
      role,
      userId,
      {
        q: filters.q,
        status: filters.status ?? 'all',
        owner: filters.owner ?? 'all',
        tag: filters.tag,
        due: filters.due,
        favorite: filters.favorite,
      },
      {
        useFts: filters.q ? ftsMatch(filters.q) !== null : false,
        includeStatus: true,
      },
    );
    if (filters.ids && filters.ids.length > 0) {
      scoped.where.push(`p.id IN (${filters.ids.map(() => '?').join(', ')})`);
      scoped.params.push(...filters.ids);
    }
    return scoped;
  }

  importMany(items: ResolvedImportItem[], actor: UserOption, ownerId: string): number {
    if (items.length === 0) return 0;
    return this.#db.transaction(() => {
      const now = new Date().toISOString();
      const insert = this.#db.stmt(
        `INSERT INTO projects
           (id, name, description, status, progress, owner_id, workspace_id, visibility,
            start_date, due_date, is_demo, legacy_task_id, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'workspace', ?, ?, 0, NULL, ?, ?, 1)`,
      );
      for (const item of items) {
        const id = crypto.randomUUID();
        const itemOwner = item.ownerId ?? ownerId;
        insert.run(
          id,
          item.name,
          item.description,
          item.status,
          item.progress,
          itemOwner,
          this.#workspaceFor(itemOwner),
          item.startDate,
          item.dueDate,
          now,
          now,
        );
        this.#insertMembers(id, item.memberIds ?? [], itemOwner);
      }
      this.#activities.record({
        type: 'project.imported',
        actor,
        project: null,
        message: `导入了 ${items.length} 个项目`,
        meta: { count: items.length },
      });
      return items.length;
    });
  }

  names(): Set<string> {
    const rows = this.#db
      .stmt('SELECT name FROM projects WHERE deleted_at IS NULL')
      .all() as unknown as { name: string }[];
    return new Set(rows.map((row) => row.name.trim().toLowerCase()));
  }

  statusCounts(role: Role, userId: string): ProjectStatusCounts {
    const scope = this.#scope(role, userId);
    const rows = this.#db
      .stmt(
        `SELECT p.status AS status, COUNT(*) AS total
         FROM projects p WHERE p.deleted_at IS NULL AND ${scope.sql} GROUP BY p.status`,
      )
      .all(...scope.params) as unknown as { status: string; total: number }[];
    const counts = emptyCounts();
    for (const row of rows) {
      if ((PROJECT_STATUSES as readonly string[]).includes(row.status)) {
        counts[row.status as ProjectStatus] = Number(row.total);
      }
      counts.all += Number(row.total);
    }
    return counts;
  }

  overview(role: Role, userId: string): ProjectOverview {
    const counts = this.statusCounts(role, userId);
    return {
      total: counts.all,
      completed: counts.completed,
      active: counts.active,
      planning: counts.planning,
      onHold: counts.on_hold,
      archived: counts.archived,
      completion: counts.all > 0 ? Math.round((counts.completed / counts.all) * 100) : 0,
    };
  }

  countDemo(): number {
    const row = this.#db
      .stmt('SELECT COUNT(*) AS total FROM projects WHERE is_demo = 1 AND deleted_at IS NULL')
      .get() as unknown as { total: number };
    return Number(row.total);
  }

  total(): number {
    const row = this.#db
      .stmt('SELECT COUNT(*) AS total FROM projects WHERE deleted_at IS NULL')
      .get() as unknown as { total: number };
    return Number(row.total);
  }

  count(role: Role, userId: string, filters: ProjectExportFilters = {}): number {
    const scoped = this.#exportConditions(role, userId, filters);
    const row = this.#db
      .stmt(
        `SELECT COUNT(*) AS total FROM projects p
         WHERE ${scoped.where.join(' AND ')}`,
      )
      .get(...scoped.params) as unknown as { total: number };
    return Number(row.total);
  }
}
