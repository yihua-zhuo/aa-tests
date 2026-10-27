import type {
  Goal,
  GoalImpact,
  GoalLevel,
  GoalLink,
  GoalStatus,
  GoalUpdateMode,
  KeyResult,
  UserOption,
} from '../../shared/types.ts';
import type { Database } from '../db.ts';

type GoalRow = {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  level: string;
  project_id: string | null;
  title: string;
  description: string;
  owner_id: string | null;
  owner_name: string | null;
  weight: number;
  period: string;
  baseline: number | null;
  target: number | null;
  actual: number | null;
  unit: string;
  update_mode: string;
  status: string;
  version: number;
  created_at: string;
  updated_at: string;
};

type KeyResultRow = {
  id: string;
  goal_id: string;
  title: string;
  unit: string;
  baseline: number | null;
  target: number | null;
  actual: number | null;
  weight: number;
  update_mode: string;
  version: number;
  created_at: string;
  updated_at: string;
};

type LinkRow = {
  id: string;
  goal_id: string;
  key_result_id: string | null;
  project_id: string;
  project_name: string;
  task_id: string | null;
  task_title: string | null;
  milestone_id: string | null;
  milestone_title: string | null;
  created_at: string;
};

export type GoalInput = {
  level?: GoalLevel;
  parentId?: string | null;
  projectId?: string | null;
  title?: string;
  description?: string;
  ownerId?: string | null;
  weight?: number;
  period?: string;
  baseline?: number | null;
  target?: number | null;
  actual?: number | null;
  unit?: string;
  updateMode?: GoalUpdateMode;
  status?: GoalStatus;
};

export type GoalUpdateInput = GoalInput & { version: number; reason?: string };

export type GoalResult =
  | { status: 'ok'; goal: Goal }
  | { status: 'missing' }
  | { status: 'conflict'; current: Goal }
  | { status: 'invalid'; message: string };

export type GoalListInput = {
  workspaceId: string;
  projectId?: string;
  level?: GoalLevel;
  includeArchived?: boolean;
  visibleProjectIds: Set<string> | null;
};

const MAX_GOAL_DEPTH = 6;
const MAX_GOAL_TREE_SIZE = 500;

const GOAL_COLUMNS = `g.id, g.workspace_id, g.parent_id, g.level, g.project_id, g.title,
  g.description, g.owner_id, u.name AS owner_name, g.weight, g.period, g.baseline, g.target,
  g.actual, g.unit, g.update_mode, g.status, g.version, g.created_at, g.updated_at`;

const KR_COLUMNS = `id, goal_id, title, unit, baseline, target, actual, weight, update_mode,
  version, created_at, updated_at`;

export function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function measureProgress(
  baseline: number | null,
  target: number | null,
  actual: number | null,
): number {
  if (target === null) return clampPct(actual ?? 0);
  if (baseline !== null && target !== baseline) {
    return clampPct((((actual ?? baseline) - baseline) / (target - baseline)) * 100);
  }
  if (target !== 0) return clampPct(((actual ?? 0) / target) * 100);
  return clampPct(actual ?? 0);
}

function toKeyResult(row: KeyResultRow, progress: number): KeyResult {
  return {
    id: row.id,
    goalId: row.goal_id,
    title: row.title,
    unit: row.unit,
    baseline: row.baseline,
    target: row.target,
    actual: row.actual,
    weight: Number(row.weight),
    updateMode: row.update_mode === 'linked' ? 'linked' : 'manual',
    progress,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toLink(row: LinkRow): GoalLink {
  return {
    id: row.id,
    goalId: row.goal_id,
    keyResultId: row.key_result_id,
    projectId: row.project_id,
    projectName: row.project_name,
    taskId: row.task_id,
    taskTitle: row.task_title,
    milestoneId: row.milestone_id,
    milestoneTitle: row.milestone_title,
    createdAt: row.created_at,
  };
}

export class GoalsStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  #row(id: string): GoalRow | null {
    const row = this.#db
      .stmt(
        `SELECT ${GOAL_COLUMNS} FROM goal_nodes g
         LEFT JOIN users u ON u.id = g.owner_id
         WHERE g.id = ?`,
      )
      .get(id) as unknown as GoalRow | undefined;
    return row ?? null;
  }

  #keyResultRows(goalIds: string[]): KeyResultRow[] {
    if (goalIds.length === 0) return [];
    const placeholders = goalIds.map(() => '?').join(', ');
    return this.#db
      .stmt(
        `SELECT ${KR_COLUMNS} FROM goal_key_results WHERE goal_id IN (${placeholders})
         ORDER BY created_at ASC`,
      )
      .all(...goalIds) as unknown as KeyResultRow[];
  }

  #linkRows(goalIds: string[], visible: Set<string> | null): LinkRow[] {
    if (goalIds.length === 0) return [];
    const placeholders = goalIds.map(() => '?').join(', ');
    const rows = this.#db
      .stmt(
        `SELECT l.id, l.goal_id, l.key_result_id, l.project_id, p.name AS project_name,
                l.task_id, t.title AS task_title, l.milestone_id, m.title AS milestone_title,
                l.created_at
         FROM goal_links l
         JOIN projects p ON p.id = l.project_id
         LEFT JOIN project_tasks t ON t.id = l.task_id
         LEFT JOIN project_milestones m ON m.id = l.milestone_id
         WHERE l.goal_id IN (${placeholders})
         ORDER BY l.created_at ASC`,
      )
      .all(...goalIds) as unknown as LinkRow[];
    return visible ? rows.filter((row) => visible.has(row.project_id)) : rows;
  }

  #linkedProgress(keyResultId: string): number | null {
    const tasks = this.#db
      .stmt(
        `SELECT COUNT(*) AS total, COALESCE(SUM(t.status = 'done'), 0) AS done
         FROM goal_links l JOIN project_tasks t ON t.id = l.task_id
         WHERE l.key_result_id = ?`,
      )
      .get(keyResultId) as unknown as { total: number; done: number };
    if (Number(tasks.total) > 0) {
      return clampPct((Number(tasks.done) / Number(tasks.total)) * 100);
    }
    const milestones = this.#db
      .stmt(
        `SELECT COUNT(t.id) AS total, COALESCE(SUM(t.status = 'done'), 0) AS done
         FROM goal_links l
         JOIN project_milestones m ON m.id = l.milestone_id
         JOIN project_tasks t ON t.milestone_id = m.id
         WHERE l.key_result_id = ?`,
      )
      .get(keyResultId) as unknown as { total: number; done: number };
    if (Number(milestones.total) > 0) {
      return clampPct((Number(milestones.done) / Number(milestones.total)) * 100);
    }
    return null;
  }

  #goalLinkedProgress(goalId: string): number | null {
    const tasks = this.#db
      .stmt(
        `SELECT COUNT(*) AS total, COALESCE(SUM(t.status = 'done'), 0) AS done
         FROM goal_links l JOIN project_tasks t ON t.id = l.task_id
         WHERE l.goal_id = ?`,
      )
      .get(goalId) as unknown as { total: number; done: number };
    if (Number(tasks.total) > 0) return clampPct((Number(tasks.done) / Number(tasks.total)) * 100);
    const milestones = this.#db
      .stmt(
        `SELECT COUNT(t.id) AS total, COALESCE(SUM(t.status = 'done'), 0) AS done
         FROM goal_links l
         JOIN project_milestones m ON m.id = l.milestone_id
         JOIN project_tasks t ON t.milestone_id = m.id
         WHERE l.goal_id = ?`,
      )
      .get(goalId) as unknown as { total: number; done: number };
    if (Number(milestones.total) > 0) {
      return clampPct((Number(milestones.done) / Number(milestones.total)) * 100);
    }
    const projects = this.#db
      .stmt(
        `SELECT COUNT(*) AS total, COALESCE(AVG(p.progress), 0) AS progress
         FROM goal_links l JOIN projects p ON p.id = l.project_id
         WHERE l.goal_id = ?`,
      )
      .get(goalId) as unknown as { total: number; progress: number };
    return Number(projects.total) > 0 ? clampPct(Number(projects.progress)) : null;
  }

  #buildGoals(
    rows: GoalRow[],
    visible: Set<string> | null,
    options: { includeLinks?: boolean } = {},
  ): Goal[] {
    const ids = rows.map((row) => row.id);
    const krRows = this.#keyResultRows(ids);
    const linkRows = options.includeLinks === false ? [] : this.#linkRows(ids, visible);
    const linksByGoal = new Map<string, LinkRow[]>();
    for (const link of linkRows) {
      const list = linksByGoal.get(link.goal_id) ?? [];
      list.push(link);
      linksByGoal.set(link.goal_id, list);
    }

    const krProgress = new Map<string, number>();
    for (const row of krRows) {
      let progress = measureProgress(row.baseline, row.target, row.actual);
      if (row.update_mode === 'linked') {
        progress = this.#linkedProgress(row.id) ?? progress;
      }
      krProgress.set(row.id, progress);
    }

    const progressByGoal = new Map<string, number>();
    for (const row of rows) {
      const krs = krRows.filter((kr) => kr.goal_id === row.id);
      let progress: number;
      if (krs.length > 0) {
        const totalWeight = krs.reduce((sum, kr) => sum + Number(kr.weight), 0) || 1;
        progress =
          krs.reduce((sum, kr) => sum + (krProgress.get(kr.id) ?? 0) * Number(kr.weight), 0) /
          totalWeight;
      } else if (row.update_mode === 'linked') {
        progress =
          this.#goalLinkedProgress(row.id) ?? measureProgress(row.baseline, row.target, row.actual);
      } else {
        progress = measureProgress(row.baseline, row.target, row.actual);
      }
      progressByGoal.set(row.id, clampPct(progress));
    }

    const children = new Map<string | null, GoalRow[]>();
    for (const row of rows) {
      const list = children.get(row.parent_id) ?? [];
      list.push(row);
      children.set(row.parent_id, list);
    }
    const resolved = new Map<string, number>();
    const resolve = (id: string): number => {
      const cached = resolved.get(id);
      if (cached !== undefined) return cached;
      const row = rows.find((item) => item.id === id);
      if (!row) return 0;
      const kids = children.get(id) ?? [];
      const own = progressByGoal.get(id) ?? 0;
      const parts: { value: number; weight: number }[] = [];
      if (kids.length > 0) {
        for (const child of kids)
          parts.push({ value: resolve(child.id), weight: Number(child.weight) });
        if (row.update_mode === 'manual' || (progressByGoal.get(id) ?? 0) !== 0) {
          parts.push({ value: own, weight: Number(row.weight) });
        }
      }
      let value = own;
      if (parts.length > 0) {
        const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0) || 1;
        value = parts.reduce((sum, part) => sum + part.value * part.weight, 0) / totalWeight;
      }
      const result = clampPct(value);
      resolved.set(id, result);
      return result;
    };

    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      parentId: row.parent_id,
      level: row.level as GoalLevel,
      projectId: row.project_id,
      title: row.title,
      description: row.description,
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      weight: Number(row.weight),
      period: row.period,
      baseline: row.baseline,
      target: row.target,
      actual: row.actual,
      unit: row.unit,
      updateMode: row.update_mode === 'linked' ? 'linked' : 'manual',
      status: row.status as GoalStatus,
      progress: resolve(row.id),
      keyResults: krRows
        .filter((kr) => kr.goal_id === row.id)
        .map((kr) => toKeyResult(kr, krProgress.get(kr.id) ?? 0)),
      links: (linksByGoal.get(row.id) ?? []).map(toLink),
      version: Number(row.version),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  #visible(row: GoalRow, visible: Set<string> | null): boolean {
    if (!row.project_id) return true;
    return visible === null || visible.has(row.project_id);
  }

  list(input: GoalListInput): Goal[] {
    const where = ['g.workspace_id = ?'];
    const params: (string | number)[] = [input.workspaceId];
    if (input.projectId) {
      where.push(
        '(g.project_id = ? OR EXISTS (SELECT 1 FROM goal_links gl WHERE gl.goal_id = g.id AND gl.project_id = ?))',
      );
      params.push(input.projectId, input.projectId);
    }
    if (input.level) {
      where.push('g.level = ?');
      params.push(input.level);
    }
    if (!input.includeArchived) where.push("g.status != 'archived'");
    params.push(MAX_GOAL_TREE_SIZE);
    const rows = this.#db
      .stmt(
        `SELECT ${GOAL_COLUMNS} FROM goal_nodes g
         LEFT JOIN users u ON u.id = g.owner_id
         WHERE ${where.join(' AND ')}
         ORDER BY g.created_at ASC LIMIT ?`,
      )
      .all(...params) as unknown as GoalRow[];
    const filtered = rows.filter((row) => this.#visible(row, input.visibleProjectIds));
    return this.#buildGoals(filtered, input.visibleProjectIds);
  }

  get(id: string, workspaceId: string, visible: Set<string> | null): Goal | null {
    const row = this.#row(id);
    if (!row || row.workspace_id !== workspaceId) return null;
    if (!this.#visible(row, visible)) return null;
    const goals = this.#buildGoals([row], visible);
    return goals[0] ?? null;
  }

  #depth(id: string): number {
    let depth = 0;
    let current: string | null = id;
    while (current && depth < MAX_GOAL_DEPTH + 1) {
      const row: { parent_id: string | null } | undefined = this.#db
        .stmt('SELECT parent_id FROM goal_nodes WHERE id = ?')
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
           SELECT id, 1 FROM goal_nodes WHERE id = ?
           UNION ALL
           SELECT g.id, tree.depth + 1 FROM goal_nodes g JOIN tree ON g.parent_id = tree.id
           WHERE tree.depth < ?
         )
         SELECT COALESCE(MAX(depth), 0) AS height FROM tree`,
      )
      .get(id, MAX_GOAL_DEPTH + 1) as unknown as { height: number };
    return Number(row.height);
  }

  #validateParent(
    goalId: string | null,
    parentId: string | null | undefined,
    workspaceId: string,
  ): string | null {
    if (parentId === null || parentId === undefined) return null;
    if (goalId && parentId === goalId) return '目标不能作为自己的父目标';
    const parent = this.#row(parentId);
    if (!parent || parent.workspace_id !== workspaceId) return '父目标不存在';
    let cursor: string | null = parentId;
    const seen = new Set<string>();
    while (cursor) {
      if (goalId && cursor === goalId) return '目标层级存在循环引用';
      if (seen.has(cursor)) return '父目标链存在循环引用';
      seen.add(cursor);
      const row: { parent_id: string | null } | undefined = this.#db
        .stmt('SELECT parent_id FROM goal_nodes WHERE id = ?')
        .get(cursor) as unknown as { parent_id: string | null } | undefined;
      cursor = row?.parent_id ?? null;
    }
    const inheritedHeight = goalId ? this.#subtreeHeight(goalId) : 1;
    if (this.#depth(parentId) + 1 + inheritedHeight > MAX_GOAL_DEPTH) {
      return `目标层级最多 ${MAX_GOAL_DEPTH} 层`;
    }
    return null;
  }

  #workspaceExists(workspaceId: string): boolean {
    const row = this.#db
      .stmt('SELECT 1 AS present FROM workspaces WHERE id = ?')
      .get(workspaceId) as unknown as { present: number } | undefined;
    return Boolean(row);
  }

  #projectInWorkspace(projectId: string, workspaceId: string): boolean {
    const row = this.#db
      .stmt(
        'SELECT 1 AS present FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL',
      )
      .get(projectId, workspaceId) as unknown as { present: number } | undefined;
    return Boolean(row);
  }

  create(workspaceId: string, input: GoalInput & { title: string }, actor: UserOption): GoalResult {
    if (!this.#workspaceExists(workspaceId)) {
      return { status: 'invalid', message: '工作区不存在' };
    }
    if (input.projectId && !this.#projectInWorkspace(input.projectId, workspaceId)) {
      return { status: 'invalid', message: '项目不存在' };
    }
    const parentError = this.#validateParent(null, input.parentId, workspaceId);
    if (parentError) return { status: 'invalid', message: parentError };
    if (input.level === 'project' && !input.projectId) {
      return { status: 'invalid', message: '项目级目标必须关联项目' };
    }
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.#db
      .stmt(
        `INSERT INTO goal_nodes
           (id, workspace_id, parent_id, level, project_id, title, description, owner_id, weight,
            period, baseline, target, actual, unit, update_mode, status, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        input.parentId ?? null,
        input.level ?? (input.parentId ? 'workspace' : 'company'),
        input.projectId ?? null,
        input.title.trim(),
        input.description?.trim() ?? '',
        input.ownerId ?? actor.id,
        input.weight ?? 1,
        input.period ?? '',
        input.baseline ?? null,
        input.target ?? null,
        input.actual ?? null,
        input.unit ?? '',
        input.updateMode ?? 'manual',
        input.status ?? 'active',
        now,
        now,
      );
    const goal = this.get(id, workspaceId, null);
    if (!goal) throw new Error('goal creation failed');
    return { status: 'ok', goal };
  }

  update(id: string, workspaceId: string, input: GoalUpdateInput, actor: UserOption): GoalResult {
    const row = this.#row(id);
    if (!row || row.workspace_id !== workspaceId) return { status: 'missing' };
    if (input.parentId !== undefined) {
      const parentError = this.#validateParent(id, input.parentId, workspaceId);
      if (parentError) return { status: 'invalid', message: parentError };
    }
    if (input.projectId && !this.#projectInWorkspace(input.projectId, workspaceId)) {
      return { status: 'invalid', message: '项目不存在' };
    }
    const nextLevel = input.level ?? (row.level as GoalLevel);
    const nextProject = input.projectId !== undefined ? input.projectId : row.project_id;
    if (nextLevel === 'project' && !nextProject) {
      return { status: 'invalid', message: '项目级目标必须关联项目' };
    }

    const sets: string[] = ['updated_at = ?', 'version = version + 1'];
    const params: (string | number | null)[] = [new Date().toISOString()];
    const fields: [keyof GoalInput, string, (value: unknown) => unknown][] = [
      ['parentId', 'parent_id', (value) => value ?? null],
      ['level', 'level', (value) => value],
      ['projectId', 'project_id', (value) => value ?? null],
      ['title', 'title', (value) => String(value).trim()],
      ['description', 'description', (value) => String(value).trim()],
      ['ownerId', 'owner_id', (value) => value ?? null],
      ['weight', 'weight', (value) => value],
      ['period', 'period', (value) => String(value).trim()],
      ['baseline', 'baseline', (value) => value ?? null],
      ['target', 'target', (value) => value ?? null],
      ['actual', 'actual', (value) => value ?? null],
      ['unit', 'unit', (value) => String(value).trim()],
      ['updateMode', 'update_mode', (value) => value],
      ['status', 'status', (value) => value],
    ];
    for (const [key, column, cast] of fields) {
      if (input[key] !== undefined) {
        sets.push(`${column} = ?`);
        params.push(cast(input[key]) as string | number | null);
      }
    }
    params.push(id, workspaceId, input.version);
    const updated = this.#db
      .stmt(
        `UPDATE goal_nodes SET ${sets.join(', ')}
         WHERE id = ? AND workspace_id = ? AND version = ? RETURNING id`,
      )
      .get(...params) as unknown as { id: string } | undefined;
    if (!updated) {
      const current = this.get(id, workspaceId, null);
      return current
        ? ({ status: 'conflict', current } as const)
        : ({ status: 'missing' } as const);
    }

    const goal = this.get(id, workspaceId, null);
    if (!goal) throw new Error('goal update failed');
    const after = {
      title: goal.title,
      target: goal.target,
      actual: goal.actual,
      status: goal.status,
      parentId: goal.parentId,
    };
    this.#db
      .stmt(
        `INSERT INTO goal_change_logs
           (id, goal_id, actor_id, reason, before_json, after_json, impact_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        id,
        actor.id,
        input.reason ?? '',
        JSON.stringify({
          title: row.title,
          target: row.target,
          actual: row.actual,
          status: row.status,
          parentId: row.parent_id,
        }),
        JSON.stringify(after),
        JSON.stringify({
          fields: Object.keys(input).filter((key) => key !== 'version' && key !== 'reason'),
        }),
        new Date().toISOString(),
      );
    return { status: 'ok', goal };
  }

  remove(id: string, workspaceId: string): boolean {
    const row = this.#row(id);
    if (!row || row.workspace_id !== workspaceId) return false;
    return this.#db.transaction(() => {
      this.#db.stmt('UPDATE goal_nodes SET parent_id = NULL WHERE parent_id = ?').run(id);
      this.#db.stmt('DELETE FROM goal_nodes WHERE id = ?').run(id);
      return true;
    });
  }

  addKeyResult(
    goalId: string,
    workspaceId: string,
    input: {
      title: string;
      unit?: string;
      baseline?: number | null;
      target?: number | null;
      actual?: number | null;
      weight?: number;
      updateMode?: GoalUpdateMode;
    },
  ): KeyResult | null {
    const goal = this.#row(goalId);
    if (!goal || goal.workspace_id !== workspaceId) return null;
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.#db.transaction(() => {
      this.#db
        .stmt(
          `INSERT INTO goal_key_results
             (id, goal_id, title, unit, baseline, target, actual, weight, update_mode, version,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          id,
          goalId,
          input.title.trim(),
          input.unit ?? '',
          input.baseline ?? null,
          input.target ?? null,
          input.actual ?? null,
          input.weight ?? 1,
          input.updateMode ?? 'manual',
          now,
          now,
        );
      this.#touchGoal(goalId, now);
    });
    const row = this.#db
      .stmt(`SELECT ${KR_COLUMNS} FROM goal_key_results WHERE id = ?`)
      .get(id) as unknown as KeyResultRow;
    return toKeyResult(row, measureProgress(row.baseline, row.target, row.actual));
  }

  updateKeyResult(
    id: string,
    goalId: string,
    workspaceId: string,
    input: {
      title?: string;
      unit?: string;
      baseline?: number | null;
      target?: number | null;
      actual?: number | null;
      weight?: number;
      updateMode?: GoalUpdateMode;
      version: number;
    },
  ):
    | { status: 'ok'; keyResult: KeyResult }
    | { status: 'missing' }
    | { status: 'conflict'; current: KeyResult } {
    const goal = this.#row(goalId);
    if (!goal || goal.workspace_id !== workspaceId) return { status: 'missing' };
    const sets: string[] = ['updated_at = ?', 'version = version + 1'];
    const params: (string | number | null)[] = [new Date().toISOString()];
    const fields: [keyof typeof input, string, (value: unknown) => unknown][] = [
      ['title', 'title', (value) => String(value).trim()],
      ['unit', 'unit', (value) => String(value).trim()],
      ['baseline', 'baseline', (value) => value ?? null],
      ['target', 'target', (value) => value ?? null],
      ['actual', 'actual', (value) => value ?? null],
      ['weight', 'weight', (value) => value],
      ['updateMode', 'update_mode', (value) => value],
    ];
    for (const [key, column, cast] of fields) {
      if (input[key] !== undefined) {
        sets.push(`${column} = ?`);
        params.push(cast(input[key]) as string | number | null);
      }
    }
    params.push(id, goalId, input.version);
    return this.#db.transaction(() => {
      const updated = this.#db
        .stmt(
          `UPDATE goal_key_results SET ${sets.join(', ')}
           WHERE id = ? AND goal_id = ? AND version = ? RETURNING id`,
        )
        .get(...params) as unknown as { id: string } | undefined;
      if (!updated) {
        const current = this.#db
          .stmt(`SELECT ${KR_COLUMNS} FROM goal_key_results WHERE id = ? AND goal_id = ?`)
          .get(id, goalId) as unknown as KeyResultRow | undefined;
        return current
          ? {
              status: 'conflict' as const,
              current: toKeyResult(
                current,
                measureProgress(current.baseline, current.target, current.actual),
              ),
            }
          : { status: 'missing' as const };
      }
      this.#touchGoal(goalId, new Date().toISOString());
      const row = this.#db
        .stmt(`SELECT ${KR_COLUMNS} FROM goal_key_results WHERE id = ?`)
        .get(id) as unknown as KeyResultRow;
      return {
        status: 'ok' as const,
        keyResult: toKeyResult(row, measureProgress(row.baseline, row.target, row.actual)),
      };
    });
  }

  removeKeyResult(id: string, goalId: string, workspaceId: string): boolean {
    const goal = this.#row(goalId);
    if (!goal || goal.workspace_id !== workspaceId) return false;
    return this.#db.transaction(() => {
      const result = this.#db
        .stmt('DELETE FROM goal_key_results WHERE id = ? AND goal_id = ?')
        .run(id, goalId);
      if (Number(result.changes) === 0) return false;
      this.#touchGoal(goalId, new Date().toISOString());
      return true;
    });
  }

  #touchGoal(goalId: string, now: string): void {
    this.#db
      .stmt('UPDATE goal_nodes SET updated_at = ?, version = version + 1 WHERE id = ?')
      .run(now, goalId);
  }

  addLink(
    goalId: string,
    workspaceId: string,
    input: {
      projectId: string;
      keyResultId?: string | null;
      taskId?: string | null;
      milestoneId?: string | null;
    },
  ):
    | { status: 'ok'; link: GoalLink }
    | { status: 'invalid'; message: string }
    | { status: 'missing' } {
    const goal = this.#row(goalId);
    if (!goal || goal.workspace_id !== workspaceId) return { status: 'missing' };
    const project = this.#db
      .stmt(
        'SELECT 1 AS present FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL',
      )
      .get(input.projectId, workspaceId) as unknown as { present: number } | undefined;
    if (!project) return { status: 'invalid', message: '项目不存在' };
    if (input.keyResultId) {
      const kr = this.#db
        .stmt('SELECT 1 AS present FROM goal_key_results WHERE id = ? AND goal_id = ?')
        .get(input.keyResultId, goalId) as unknown as { present: number } | undefined;
      if (!kr) return { status: 'invalid', message: '关键结果不存在' };
      if (input.taskId || input.milestoneId) {
        const linkedToKr = this.#db
          .stmt('SELECT 1 AS present FROM goal_links WHERE key_result_id = ? LIMIT 1')
          .get(input.keyResultId) as unknown as { present: number } | undefined;
        if (linkedToKr) return { status: 'invalid', message: '该关键结果已关联跟踪对象' };
      }
    }
    if (input.taskId) {
      const task = this.#db
        .stmt('SELECT 1 AS present FROM project_tasks WHERE id = ? AND project_id = ?')
        .get(input.taskId, input.projectId) as unknown as { present: number } | undefined;
      if (!task) return { status: 'invalid', message: '任务不属于该项目' };
    }
    if (input.milestoneId) {
      const milestone = this.#db
        .stmt('SELECT 1 AS present FROM project_milestones WHERE id = ? AND project_id = ?')
        .get(input.milestoneId, input.projectId) as unknown as { present: number } | undefined;
      if (!milestone) return { status: 'invalid', message: '里程碑不属于该项目' };
    }
    const linkKey = [
      goalId,
      input.keyResultId ?? '',
      input.projectId,
      input.taskId ?? '',
      input.milestoneId ?? '',
    ].join(':');
    this.#db
      .stmt(
        `INSERT OR IGNORE INTO goal_links
           (id, link_key, goal_id, key_result_id, project_id, task_id, milestone_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        linkKey,
        goalId,
        input.keyResultId ?? null,
        input.projectId,
        input.taskId ?? null,
        input.milestoneId ?? null,
        new Date().toISOString(),
      );
    this.#touchGoal(goalId, new Date().toISOString());
    const row = this.#db
      .stmt(
        `SELECT l.id, l.goal_id, l.key_result_id, l.project_id, p.name AS project_name,
                l.task_id, t.title AS task_title, l.milestone_id, m.title AS milestone_title,
                l.created_at
         FROM goal_links l JOIN projects p ON p.id = l.project_id
         LEFT JOIN project_tasks t ON t.id = l.task_id
         LEFT JOIN project_milestones m ON m.id = l.milestone_id
         WHERE l.link_key = ?`,
      )
      .get(linkKey) as unknown as LinkRow;
    return { status: 'ok', link: toLink(row) };
  }

  removeLink(id: string, goalId: string, workspaceId: string): boolean {
    const goal = this.#row(goalId);
    if (!goal || goal.workspace_id !== workspaceId) return false;
    return this.#db.transaction(() => {
      const result = this.#db
        .stmt('DELETE FROM goal_links WHERE id = ? AND goal_id = ?')
        .run(id, goalId);
      if (Number(result.changes) === 0) return false;
      this.#touchGoal(goalId, new Date().toISOString());
      return true;
    });
  }

  changeLogs(goalId: string, workspaceId: string): Record<string, unknown>[] {
    const goal = this.#row(goalId);
    if (!goal || goal.workspace_id !== workspaceId) return [];
    const rows = this.#db
      .stmt(
        `SELECT l.id, l.reason, l.before_json, l.after_json, l.impact_json, l.created_at,
                u.name AS actor_name
         FROM goal_change_logs l LEFT JOIN users u ON u.id = l.actor_id
         WHERE l.goal_id = ? ORDER BY l.created_at DESC LIMIT 50`,
      )
      .all(goalId) as unknown as {
      id: string;
      reason: string;
      before_json: string;
      after_json: string;
      impact_json: string;
      created_at: string;
      actor_name: string | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      reason: row.reason,
      before: JSON.parse(row.before_json) as unknown,
      after: JSON.parse(row.after_json) as unknown,
      impact: JSON.parse(row.impact_json) as unknown,
      actorName: row.actor_name,
      createdAt: row.created_at,
    }));
  }

  impact(
    id: string,
    workspaceId: string,
    changes: GoalInput,
    visible: Set<string> | null,
  ): GoalImpact | null {
    const goal = this.get(id, workspaceId, visible);
    if (!goal) return null;
    const affectedProjects = goal.links
      .filter((link) => visible === null || visible.has(link.projectId))
      .map((link) => ({ id: link.projectId, name: link.projectName }));
    const uniqueProjects = [...new Map(affectedProjects.map((p) => [p.id, p])).values()];
    const affectedTasks = goal.links.filter((link) => link.taskId).length;
    const affectedMilestones = goal.links.filter((link) => link.milestoneId).length;

    const descendants: { id: string; title: string }[] = [];
    const queue = [id];
    while (queue.length > 0 && descendants.length < 100) {
      const current = queue.shift() as string;
      const children = this.#db
        .stmt('SELECT id, title FROM goal_nodes WHERE parent_id = ? AND workspace_id = ?')
        .all(current, workspaceId) as unknown as { id: string; title: string }[];
      for (const child of children) {
        descendants.push(child);
        queue.push(child.id);
      }
    }

    const ownerIds = new Set<string>();
    if (goal.ownerId) ownerIds.add(goal.ownerId);
    for (const project of uniqueProjects) {
      const owner = this.#db
        .stmt('SELECT owner_id FROM projects WHERE id = ?')
        .get(project.id) as unknown as { owner_id: string } | undefined;
      if (owner?.owner_id) ownerIds.add(owner.owner_id);
    }
    if (goal.parentId) {
      const parent = this.#row(goal.parentId);
      if (parent?.owner_id) ownerIds.add(parent.owner_id);
    }
    const owners: UserOption[] = [];
    for (const ownerId of ownerIds) {
      const user = this.#db
        .stmt('SELECT id, name FROM users WHERE id = ? AND status = ?')
        .get(ownerId, 'active') as unknown as { id: string; name: string } | undefined;
      if (user) owners.push({ id: user.id, name: user.name });
    }

    const targetChange =
      changes.target !== undefined && goal.target !== null && goal.target !== 0
        ? Math.abs(((changes.target ?? 0) - goal.target) / goal.target)
        : 0;
    const risk: GoalImpact['risk'] =
      targetChange > 0.2 || changes.parentId !== undefined
        ? 'high'
        : uniqueProjects.length > 0 || descendants.length > 0
          ? 'medium'
          : 'low';

    return {
      goalId: id,
      expectedVersion: goal.version,
      changes: changes as Record<string, unknown>,
      before: {
        title: goal.title,
        target: goal.target,
        actual: goal.actual,
        status: goal.status,
        parentId: goal.parentId,
      },
      after: {
        ...goal,
        ...changes,
      } as unknown as Record<string, unknown>,
      affectedProjects: uniqueProjects,
      affectedTasks,
      affectedMilestones,
      affectedGoals: descendants,
      owners,
      risk,
      requiresConfirmationFrom: owners,
      generatedAt: new Date().toISOString(),
    };
  }
}
