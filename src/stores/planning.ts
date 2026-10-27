import type {
  BlockerReport,
  CriticalPath,
  CriticalPathNode,
  DependencyType,
  RecurrenceRule,
  RecurrenceRunResult,
  TaskBlocker,
  TaskDependency,
  TaskPriority,
  TaskStatus,
  TimeLog,
  TimeSummary,
  UserOption,
} from '../../shared/types.ts';
import type { Database } from '../db.ts';
import type { TasksStore } from './tasks.ts';

type DependencyRow = {
  id: string;
  project_id: string | null;
  predecessor_id: string;
  predecessor_title: string;
  predecessor_project_id: string;
  successor_id: string;
  successor_title: string;
  successor_project_id: string;
  type: string;
  lag_days: number;
  created_at: string;
};

type TimeLogRow = {
  id: string;
  task_id: string;
  task_title: string;
  user_id: string | null;
  user_name: string;
  minutes: number;
  work_date: string;
  note: string;
  version: number;
  created_at: string;
  updated_at: string;
};

type BlockerRow = {
  id: string;
  task_id: string;
  task_title: string;
  reason: string;
  category: string;
  owner_team: string;
  expected_resolve_at: string | null;
  status: string;
  resolved_at: string | null;
  resolved_by_name: string | null;
  evidence: string;
  created_by_name: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

type RecurrenceRow = {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  assignee_id: string | null;
  rule: string;
  timezone: string;
  starts_on: string;
  ends_on: string | null;
  count: number | null;
  exceptions_json: string;
  holidays_json: string;
  last_generated_on: string | null;
  active: number;
  version: number;
  created_at: string;
  updated_at: string;
};

type ProjectTaskRow = {
  id: string;
  title: string;
  status: string;
  created_at: string;
  estimate_hours: number | null;
  estimate_points: number | null;
  project_id: string;
  project_name: string;
};

const DAY_MS = 86_400_000;
const MAX_RECURRENCE_DAYS = 3660;

function parseJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseDateKey(value: string): Date {
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
}

function shiftDate(value: string, days: number): string {
  return dateKey(new Date(parseDateKey(value).getTime() + days * DAY_MS));
}

function diffDays(from: string, to: string): number {
  return Math.round((parseDateKey(to).getTime() - parseDateKey(from).getTime()) / DAY_MS);
}

function todayKey(): string {
  return dateKey(new Date());
}

function toDependency(row: DependencyRow): TaskDependency {
  return {
    id: row.id,
    projectId: row.project_id,
    predecessorId: row.predecessor_id,
    predecessorTitle: row.predecessor_title,
    predecessorProjectId: row.predecessor_project_id,
    successorId: row.successor_id,
    successorTitle: row.successor_title,
    successorProjectId: row.successor_project_id,
    type: row.type as DependencyType,
    lagDays: Number(row.lag_days),
    crossProject: row.predecessor_project_id !== row.successor_project_id,
    createdAt: row.created_at,
  };
}

function toTimeLog(row: TimeLogRow): TimeLog {
  return {
    id: row.id,
    taskId: row.task_id,
    taskTitle: row.task_title,
    userId: row.user_id,
    userName: row.user_name,
    minutes: Number(row.minutes),
    workDate: row.work_date,
    note: row.note,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toBlocker(row: BlockerRow): TaskBlocker {
  return {
    id: row.id,
    taskId: row.task_id,
    taskTitle: row.task_title,
    reason: row.reason,
    category: row.category as TaskBlocker['category'],
    ownerTeam: row.owner_team,
    expectedResolveAt: row.expected_resolve_at,
    status: row.status === 'resolved' ? 'resolved' : 'open',
    resolvedAt: row.resolved_at,
    resolvedByName: row.resolved_by_name,
    evidence: row.evidence,
    createdByName: row.created_by_name,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRecurrence(row: RecurrenceRow): RecurrenceRule {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    assigneeId: row.assignee_id,
    rule: row.rule,
    timezone: row.timezone,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    count: row.count === null ? null : Number(row.count),
    exceptions: parseJsonArray(row.exceptions_json),
    holidays: parseJsonArray(row.holidays_json),
    lastGeneratedOn: row.last_generated_on,
    active: Boolean(row.active),
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type ParsedRecurrence = {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY';
  interval: number;
  byDay: number[];
  byDaySpec: { ordinal: number; day: number }[];
  byMonthDay: number[];
  byMonth: number[];
  until: string | null;
  count: number | null;
  adjustWorkday: boolean;
};

const WEEKDAY_INDEX: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

function parseByDay(raw: string | undefined): {
  byDay: number[];
  byDaySpec: { ordinal: number; day: number }[];
} {
  const byDay: number[] = [];
  const byDaySpec: { ordinal: number; day: number }[] = [];
  for (const token of (raw ?? '').split(',')) {
    const value = token.trim().toUpperCase();
    if (!value) continue;
    if (value === 'WORKDAY' || value === 'WORKDAYS') {
      byDay.push(1, 2, 3, 4, 5);
      continue;
    }
    const match = /^([+-]?\d)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(value);
    if (!match) continue;
    const day = WEEKDAY_INDEX[match[2] as string];
    if (day === undefined) continue;
    if (match[1]) {
      const ordinal = Number(match[1]);
      if (Number.isInteger(ordinal) && ordinal !== 0 && Math.abs(ordinal) <= 5) {
        byDaySpec.push({ ordinal, day });
      }
    } else {
      byDay.push(day);
    }
  }
  return { byDay, byDaySpec };
}

function parseIntegerList(raw: string | undefined, low: number, high: number): number[] {
  return (raw ?? '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value !== 0 && value >= low && value <= high);
}

export function parseRecurrenceRule(raw: string): ParsedRecurrence | null {
  const parts = new Map<string, string>();
  for (const token of raw.split(';')) {
    const [key, value] = token.split('=');
    if (key && value) parts.set(key.trim().toUpperCase(), value.trim());
  }
  const freq = parts.get('FREQ')?.toUpperCase();
  if (!freq || !['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'].includes(freq)) return null;
  const intervalRaw = Number(parts.get('INTERVAL') ?? '1');
  const interval =
    Number.isInteger(intervalRaw) && intervalRaw >= 1 && intervalRaw <= 52 ? intervalRaw : 1;
  const { byDay, byDaySpec } = parseByDay(parts.get('BYDAY'));
  let until: string | null = parts.get('UNTIL') ?? null;
  if (until) {
    const digits = until.replace(/[^0-9]/g, '');
    if (digits.length >= 8) {
      until = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
    } else {
      until = null;
    }
  }
  const countRaw = Number(parts.get('COUNT') ?? Number.NaN);
  const count = Number.isInteger(countRaw) && countRaw > 0 ? Math.min(countRaw, 3650) : null;
  return {
    freq: freq as ParsedRecurrence['freq'],
    interval,
    byDay,
    byDaySpec,
    byMonthDay: parseIntegerList(parts.get('BYMONTHDAY'), -31, 31),
    byMonth: parseIntegerList(parts.get('BYMONTH'), 1, 12),
    until,
    count,
    adjustWorkday: /^(1|TRUE|YES)$/i.test(parts.get('ADJUST') ?? ''),
  };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function matchesNthWeekday(date: Date, ordinal: number, weekday: number): boolean {
  if (date.getUTCDay() !== weekday) return false;
  const day = date.getUTCDate();
  if (ordinal > 0) {
    const first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    const offset = (weekday - first.getUTCDay() + 7) % 7;
    return day === 1 + offset + (ordinal - 1) * 7;
  }
  const total = daysInMonth(date.getUTCFullYear(), date.getUTCMonth());
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), total));
  const back = (last.getUTCDay() - weekday + 7) % 7;
  return day === total - back - (Math.abs(ordinal) - 1) * 7;
}

function matchesRecurrence(date: string, start: string, spec: ParsedRecurrence): boolean {
  const delta = diffDays(start, date);
  if (delta < 0) return false;
  const cursor = parseDateKey(date);
  const origin = parseDateKey(start);
  if (spec.freq === 'DAILY') {
    if (delta % spec.interval !== 0) return false;
    return spec.byDay.length === 0 || spec.byDay.includes(cursor.getUTCDay());
  }
  if (spec.freq === 'WEEKLY') {
    const week = Math.floor(delta / 7);
    if (week % spec.interval !== 0) return false;
    const days = spec.byDay.length > 0 ? spec.byDay : [origin.getUTCDay()];
    return days.includes(cursor.getUTCDay());
  }
  const months =
    (cursor.getUTCFullYear() - origin.getUTCFullYear()) * 12 +
    (cursor.getUTCMonth() - origin.getUTCMonth());
  const step = spec.freq === 'QUARTERLY' ? spec.interval * 3 : spec.interval;
  if (spec.freq === 'MONTHLY' || spec.freq === 'QUARTERLY') {
    if (months < 0 || months % step !== 0) return false;
    if (spec.byMonth.length > 0 && !spec.byMonth.includes(cursor.getUTCMonth() + 1)) return false;
    if (spec.byMonthDay.length > 0) {
      const total = daysInMonth(cursor.getUTCFullYear(), cursor.getUTCMonth());
      return spec.byMonthDay.some((value) =>
        value > 0 ? value === cursor.getUTCDate() : total + value + 1 === cursor.getUTCDate(),
      );
    }
    if (spec.byDaySpec.length > 0) {
      return spec.byDaySpec.some((item) => matchesNthWeekday(cursor, item.ordinal, item.day));
    }
    if (spec.byDay.length > 0) return spec.byDay.includes(cursor.getUTCDay());
    return cursor.getUTCDate() === origin.getUTCDate();
  }
  const years = cursor.getUTCFullYear() - origin.getUTCFullYear();
  if (years < 0 || years % spec.interval !== 0) return false;
  if (spec.byMonth.length > 0) {
    if (!spec.byMonth.includes(cursor.getUTCMonth() + 1)) return false;
  } else if (cursor.getUTCMonth() !== origin.getUTCMonth()) {
    return false;
  }
  if (spec.byMonthDay.length > 0) {
    const total = daysInMonth(cursor.getUTCFullYear(), cursor.getUTCMonth());
    return spec.byMonthDay.some((value) =>
      value > 0 ? value === cursor.getUTCDate() : total + value + 1 === cursor.getUTCDate(),
    );
  }
  if (spec.byDaySpec.length > 0) {
    return spec.byDaySpec.some((item) => matchesNthWeekday(cursor, item.ordinal, item.day));
  }
  if (spec.byDay.length > 0) return spec.byDay.includes(cursor.getUTCDay());
  return cursor.getUTCDate() === origin.getUTCDate();
}

function adjustToWorkday(date: string): string {
  let value = date;
  for (let guard = 0; guard < 7; guard++) {
    const day = parseDateKey(value).getUTCDay();
    if (day !== 0 && day !== 6) return value;
    value = shiftDate(value, 1);
  }
  return value;
}

export function recurrenceOccurrences(
  rule: string,
  startsOn: string,
  options: {
    through?: string;
    endsOn?: string | null;
    count?: number | null;
    exceptions?: string[];
    holidays?: string[];
  } = {},
): string[] {
  const spec = parseRecurrenceRule(rule);
  if (!spec) return [];
  const through = options.through ?? startsOn;
  const bounds = [through];
  if (options.endsOn) bounds.push(options.endsOn);
  if (spec.until) bounds.push(spec.until);
  const end = bounds.sort()[0] as string;
  if (diffDays(startsOn, end) < 0) return [];
  const span = Math.min(diffDays(startsOn, end), MAX_RECURRENCE_DAYS);
  const limit = options.count ?? spec.count;
  const excluded = new Set([...(options.exceptions ?? []), ...(options.holidays ?? [])]);
  const result: string[] = [];
  let matched = 0;
  for (let offset = 0; offset <= span; offset++) {
    const date = shiftDate(startsOn, offset);
    if (!matchesRecurrence(date, startsOn, spec)) continue;
    matched++;
    const actual = spec.adjustWorkday ? adjustToWorkday(date) : date;
    if (actual <= end && !excluded.has(actual) && !result.includes(actual)) result.push(actual);
    if (limit !== null && matched >= limit) break;
    if (result.length >= 400) break;
  }
  return result;
}

function nextOccurrence(rule: string, startsOn: string, after: string): string | null {
  const spec = parseRecurrenceRule(rule);
  if (!spec) return null;
  const horizon = shiftDate(after, 366 * 5);
  for (let offset = 1; offset <= MAX_RECURRENCE_DAYS; offset++) {
    const date = shiftDate(after, offset);
    if (date > horizon) break;
    if (!matchesRecurrence(date, startsOn, spec)) continue;
    const actual = spec.adjustWorkday ? adjustToWorkday(date) : date;
    if (actual > after) return actual;
  }
  return null;
}

type DependencyResult =
  | { status: 'ok'; dependency: TaskDependency }
  | { status: 'invalid'; message: string }
  | { status: 'missing' };

type TimeLogResult =
  | { status: 'ok'; log: TimeLog }
  | { status: 'invalid'; message: string }
  | { status: 'missing' }
  | { status: 'conflict'; current: TimeLog };

type BlockerResult =
  | { status: 'ok'; blocker: TaskBlocker }
  | { status: 'invalid'; message: string }
  | { status: 'missing' }
  | { status: 'conflict'; current: TaskBlocker };

type RecurrenceResult =
  | { status: 'ok'; rule: RecurrenceRule }
  | { status: 'invalid'; message: string }
  | { status: 'missing' }
  | { status: 'conflict'; current: RecurrenceRule };

export class PlanningStore {
  readonly #db: Database;
  readonly #tasks: TasksStore;

  constructor(db: Database, tasks: TasksStore) {
    this.#db = db;
    this.#tasks = tasks;
  }

  #project(projectId: string, workspaceId: string): { id: string } | null {
    const row = this.#db
      .stmt('SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL')
      .get(projectId, workspaceId) as unknown as { id: string } | undefined;
    return row ?? null;
  }

  #task(taskId: string, workspaceId: string): { id: string; project_id: string } | null {
    const row = this.#db
      .stmt(
        `SELECT t.id, t.project_id FROM project_tasks t
         JOIN projects p ON p.id = t.project_id
         WHERE t.id = ? AND p.workspace_id = ? AND p.deleted_at IS NULL`,
      )
      .get(taskId, workspaceId) as unknown as { id: string; project_id: string } | undefined;
    return row ?? null;
  }

  #dependencyRow(id: string): DependencyRow | null {
    const row = this.#db
      .stmt(
        `SELECT d.id, d.project_id, d.predecessor_id, p.title AS predecessor_title,
                p.project_id AS predecessor_project_id,
                d.successor_id, s.title AS successor_title,
                s.project_id AS successor_project_id, d.type, d.lag_days, d.created_at
         FROM task_dependencies d
         JOIN project_tasks p ON p.id = d.predecessor_id
         JOIN project_tasks s ON s.id = d.successor_id
         WHERE d.id = ?`,
      )
      .get(id) as unknown as DependencyRow | undefined;
    return row ?? null;
  }

  listDependencies(projectId: string, workspaceId: string): TaskDependency[] | null {
    if (!this.#project(projectId, workspaceId)) return null;
    const rows = this.#db
      .stmt(
        `SELECT d.id, d.project_id, d.predecessor_id, p.title AS predecessor_title,
                p.project_id AS predecessor_project_id,
                d.successor_id, s.title AS successor_title,
                s.project_id AS successor_project_id, d.type, d.lag_days, d.created_at
         FROM task_dependencies d
         JOIN project_tasks p ON p.id = d.predecessor_id
         JOIN project_tasks s ON s.id = d.successor_id
         JOIN projects pp ON pp.id = p.project_id
         JOIN projects sp ON sp.id = s.project_id
         WHERE (d.project_id = ? OR p.project_id = ? OR s.project_id = ?)
           AND pp.workspace_id = ? AND sp.workspace_id = ?
         ORDER BY d.created_at ASC`,
      )
      .all(projectId, projectId, projectId, workspaceId, workspaceId) as unknown as DependencyRow[];
    return rows.map(toDependency);
  }

  #reaches(from: string, target: string, edges: Map<string, string[]>): boolean {
    const queue = [from];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (current === target) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const next of edges.get(current) ?? []) queue.push(next);
    }
    return false;
  }

  addDependency(
    projectId: string,
    workspaceId: string,
    input: { predecessorId: string; successorId: string; type?: DependencyType; lagDays?: number },
  ): DependencyResult {
    if (!this.#project(projectId, workspaceId)) return { status: 'missing' };
    if (input.predecessorId === input.successorId) {
      return { status: 'invalid', message: '任务不能依赖自身' };
    }
    const predecessor = this.#task(input.predecessorId, workspaceId);
    const successor = this.#task(input.successorId, workspaceId);
    if (!predecessor || !successor) {
      return { status: 'invalid', message: '任务不属于当前工作区' };
    }
    const crossProject = predecessor.project_id !== successor.project_id;
    if (
      !crossProject &&
      predecessor.project_id !== projectId &&
      successor.project_id !== projectId
    ) {
      return { status: 'invalid', message: '任务不属于该项目' };
    }

    const edgeRows = this.#db
      .stmt(
        `SELECT d.predecessor_id, d.successor_id FROM task_dependencies d
         JOIN project_tasks p ON p.id = d.predecessor_id
         JOIN project_tasks s ON s.id = d.successor_id
         JOIN projects pp ON pp.id = p.project_id
         JOIN projects sp ON sp.id = s.project_id
         WHERE pp.workspace_id = ? AND sp.workspace_id = ?`,
      )
      .all(workspaceId, workspaceId) as unknown as {
      predecessor_id: string;
      successor_id: string;
    }[];
    const edges = new Map<string, string[]>();
    for (const edge of edgeRows) {
      const list = edges.get(edge.predecessor_id) ?? [];
      list.push(edge.successor_id);
      edges.set(edge.predecessor_id, list);
    }
    if (this.#reaches(input.successorId, input.predecessorId, edges)) {
      return { status: 'invalid', message: '依赖关系存在循环引用' };
    }

    const existing = this.#db
      .stmt(`SELECT id FROM task_dependencies WHERE predecessor_id = ? AND successor_id = ?`)
      .get(input.predecessorId, input.successorId) as unknown as { id: string } | undefined;
    if (existing) {
      const row = this.#dependencyRow(existing.id);
      return row ? { status: 'ok', dependency: toDependency(row) } : { status: 'missing' };
    }

    const id = crypto.randomUUID();
    this.#db
      .stmt(
        `INSERT INTO task_dependencies
           (id, project_id, predecessor_id, successor_id, type, lag_days, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        crossProject ? null : successor.project_id,
        input.predecessorId,
        input.successorId,
        input.type ?? 'FS',
        input.lagDays ?? 0,
        new Date().toISOString(),
      );
    const row = this.#dependencyRow(id);
    if (!row) throw new Error('dependency creation failed');
    return { status: 'ok', dependency: toDependency(row) };
  }

  removeDependency(id: string, projectId: string, workspaceId: string): boolean {
    if (!this.#project(projectId, workspaceId)) return false;
    const row = this.#dependencyRow(id);
    if (!row) return false;
    if (
      row.predecessor_project_id !== projectId &&
      row.successor_project_id !== projectId &&
      row.project_id !== projectId
    ) {
      return false;
    }
    if (
      !this.#task(row.predecessor_id, workspaceId) ||
      !this.#task(row.successor_id, workspaceId)
    ) {
      return false;
    }
    const result = this.#db.stmt('DELETE FROM task_dependencies WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  criticalPath(projectId: string, workspaceId: string): CriticalPath | null {
    if (!this.#project(projectId, workspaceId)) return null;
    const workspaceTasks = this.#db
      .stmt(
        `SELECT t.id, t.title, t.status, t.created_at, t.estimate_hours, t.estimate_points,
                t.project_id, p.name AS project_name
         FROM project_tasks t JOIN projects p ON p.id = t.project_id
         WHERE p.workspace_id = ? AND p.deleted_at IS NULL
         ORDER BY t.created_at ASC`,
      )
      .all(workspaceId) as unknown as ProjectTaskRow[];
    const anchorIds = workspaceTasks
      .filter((row) => row.project_id === projectId)
      .map((row) => row.id);
    if (anchorIds.length === 0) {
      return { projectId, nodes: [], chain: [], estimatedCompletion: null, cycles: [] };
    }
    const workspaceDeps = this.#db
      .stmt(
        `SELECT d.predecessor_id, d.successor_id, d.type, d.lag_days
         FROM task_dependencies d
         JOIN project_tasks p ON p.id = d.predecessor_id
         JOIN project_tasks s ON s.id = d.successor_id
         JOIN projects pp ON pp.id = p.project_id
         JOIN projects sp ON sp.id = s.project_id
         WHERE pp.workspace_id = ? AND sp.workspace_id = ?`,
      )
      .all(workspaceId, workspaceId) as unknown as {
      predecessor_id: string;
      successor_id: string;
      type: DependencyType;
      lag_days: number;
    }[];
    const neighbours = new Map<string, string[]>();
    for (const dep of workspaceDeps) {
      const left = neighbours.get(dep.predecessor_id) ?? [];
      left.push(dep.successor_id);
      neighbours.set(dep.predecessor_id, left);
      const right = neighbours.get(dep.successor_id) ?? [];
      right.push(dep.predecessor_id);
      neighbours.set(dep.successor_id, right);
    }
    const connected = new Set<string>(anchorIds);
    const expansionQueue = [...anchorIds];
    while (expansionQueue.length > 0) {
      const current = expansionQueue.shift() as string;
      for (const next of neighbours.get(current) ?? []) {
        if (connected.has(next)) continue;
        connected.add(next);
        expansionQueue.push(next);
      }
    }
    const taskRows = workspaceTasks.filter((row) => connected.has(row.id));
    const tasks = new Map(taskRows.map((row) => [row.id, row]));
    const depRows = workspaceDeps.filter(
      (dep) => tasks.has(dep.predecessor_id) && tasks.has(dep.successor_id),
    );
    const durations = new Map<string, number>();
    for (const row of taskRows) {
      const fromHours = row.estimate_hours == null ? 0 : Math.ceil(Number(row.estimate_hours) / 8);
      const fromPoints =
        row.estimate_points == null ? 0 : Math.ceil(Number(row.estimate_points) / 3);
      durations.set(row.id, Math.max(1, fromHours || fromPoints || 1));
    }

    const indegree = new Map<string, number>();
    const outgoing = new Map<string, string[]>();
    const incoming = new Map<string, typeof depRows>();
    for (const row of taskRows) {
      indegree.set(row.id, 0);
      outgoing.set(row.id, []);
      incoming.set(row.id, []);
    }
    for (const dep of depRows) {
      if (!tasks.has(dep.predecessor_id) || !tasks.has(dep.successor_id)) continue;
      indegree.set(dep.successor_id, (indegree.get(dep.successor_id) ?? 0) + 1);
      outgoing.get(dep.predecessor_id)?.push(dep.successor_id);
      incoming.get(dep.successor_id)?.push(dep);
    }

    const queue = taskRows.filter((row) => (indegree.get(row.id) ?? 0) === 0).map((row) => row.id);
    const order: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      order.push(current);
      for (const next of outgoing.get(current) ?? []) {
        const left = (indegree.get(next) ?? 0) - 1;
        indegree.set(next, left);
        if (left === 0) queue.push(next);
      }
    }
    const orderedSet = new Set(order);
    const cyclic = taskRows.filter((row) => !orderedSet.has(row.id)).map((row) => row.id);
    const evaluationOrder = [...order, ...cyclic];

    const es = new Map<string, number>();
    const ef = new Map<string, number>();
    for (const id of evaluationOrder) {
      const duration = durations.get(id) ?? 1;
      let earliest = 0;
      for (const dep of incoming.get(id) ?? []) {
        const predStart = es.get(dep.predecessor_id) ?? 0;
        const predFinish =
          ef.get(dep.predecessor_id) ?? predStart + (durations.get(dep.predecessor_id) ?? 1) - 1;
        if (dep.type === 'FS') earliest = Math.max(earliest, predFinish + 1 + dep.lag_days);
        else if (dep.type === 'SS') earliest = Math.max(earliest, predStart + dep.lag_days);
        else if (dep.type === 'FF') {
          earliest = Math.max(earliest, predFinish + dep.lag_days - duration + 1);
        } else {
          earliest = Math.max(earliest, predStart + dep.lag_days - duration + 1);
        }
      }
      es.set(id, earliest);
      ef.set(id, earliest + duration - 1);
    }

    const projectFinish = Math.max(...[...ef.values()], 0);
    const ls = new Map<string, number>();
    const lf = new Map<string, number>();
    for (const id of [...evaluationOrder].reverse()) {
      const duration = durations.get(id) ?? 1;
      const outgoingIds = outgoing.get(id) ?? [];
      let latestFinish = projectFinish;
      for (const next of outgoingIds) {
        if (!es.has(next)) continue;
        const dep = (incoming.get(next) ?? []).find((item) => item.predecessor_id === id);
        if (!dep) continue;
        const nextStart = ls.get(next) ?? es.get(next) ?? 0;
        const nextFinish = lf.get(next) ?? ef.get(next) ?? 0;
        if (dep.type === 'FS') latestFinish = Math.min(latestFinish, nextStart - 1 - dep.lag_days);
        else if (dep.type === 'SS')
          latestFinish = Math.min(latestFinish, nextStart + duration - 1 - dep.lag_days);
        else if (dep.type === 'FF')
          latestFinish = Math.min(latestFinish, nextFinish - dep.lag_days);
        else latestFinish = Math.min(latestFinish, nextFinish - dep.lag_days + duration - 1);
      }
      lf.set(id, latestFinish);
      ls.set(id, latestFinish - duration + 1);
    }

    const anchor = taskRows[0]?.created_at.slice(0, 10) ?? todayKey();
    const nodes: CriticalPathNode[] = taskRows.map((row) => {
      const earliestStart = es.get(row.id) ?? 0;
      const earliestFinish = ef.get(row.id) ?? earliestStart;
      const latestStart = ls.get(row.id) ?? earliestStart;
      const latestFinish = lf.get(row.id) ?? earliestFinish;
      return {
        taskId: row.id,
        title: row.title,
        projectId: row.project_id,
        projectName: row.project_name,
        earliestStart: shiftDate(anchor, earliestStart),
        earliestFinish: shiftDate(anchor, earliestFinish),
        latestStart: shiftDate(anchor, latestStart),
        latestFinish: shiftDate(anchor, latestFinish),
        floatDays: latestStart - earliestStart,
        critical: latestStart - earliestStart <= 0,
      };
    });
    const chain = nodes
      .filter((node) => node.critical)
      .sort((a, b) => a.earliestStart.localeCompare(b.earliestStart))
      .map((node) => node.taskId);
    return {
      projectId,
      nodes,
      chain,
      estimatedCompletion: shiftDate(anchor, projectFinish),
      cycles: cyclic.length > 0 ? [cyclic] : [],
    };
  }

  getTimeLog(id: string, workspaceId: string): TimeLog | null {
    const row = this.#timeLogRow(id);
    if (!row) return null;
    return this.#task(row.task_id, workspaceId) ? toTimeLog(row) : null;
  }

  #timeLogRow(id: string): TimeLogRow | null {
    const row = this.#db
      .stmt(
        `SELECT l.id, l.task_id, t.title AS task_title, l.user_id, l.user_name, l.minutes,
                l.work_date, l.note, l.version, l.created_at, l.updated_at
         FROM task_time_logs l JOIN project_tasks t ON t.id = l.task_id
         WHERE l.id = ?`,
      )
      .get(id) as unknown as TimeLogRow | undefined;
    return row ?? null;
  }

  addTimeLog(
    taskId: string,
    workspaceId: string,
    input: { minutes: number; workDate: string; note?: string; idempotencyKey?: string },
    user: UserOption,
  ): TimeLogResult {
    const task = this.#task(taskId, workspaceId);
    if (!task) return { status: 'missing' };
    if (input.idempotencyKey) {
      const existing = this.#db
        .stmt('SELECT id, task_id FROM task_time_logs WHERE idempotency_key = ?')
        .get(input.idempotencyKey) as unknown as { id: string; task_id: string } | undefined;
      if (existing) {
        if (existing.task_id !== taskId) {
          return { status: 'invalid', message: '幂等键已被其他任务使用' };
        }
        const row = this.#timeLogRow(existing.id);
        return row ? { status: 'ok', log: toTimeLog(row) } : { status: 'missing' };
      }
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.#db
      .stmt(
        `INSERT INTO task_time_logs
           (id, task_id, user_id, user_name, minutes, work_date, note, idempotency_key, version,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        id,
        taskId,
        user.id,
        user.name,
        input.minutes,
        input.workDate,
        input.note?.trim() ?? '',
        input.idempotencyKey ?? null,
        now,
        now,
      );
    const row = this.#timeLogRow(id);
    if (!row) throw new Error('time log creation failed');
    return { status: 'ok', log: toTimeLog(row) };
  }

  updateTimeLog(
    id: string,
    taskId: string,
    workspaceId: string,
    input: { minutes?: number; workDate?: string; note?: string; version: number },
  ): TimeLogResult {
    if (!this.#task(taskId, workspaceId)) return { status: 'missing' };
    const sets = ['updated_at = ?', 'version = version + 1'];
    const params: (string | number | null)[] = [new Date().toISOString()];
    if (input.minutes !== undefined) {
      sets.push('minutes = ?');
      params.push(input.minutes);
    }
    if (input.workDate !== undefined) {
      sets.push('work_date = ?');
      params.push(input.workDate);
    }
    if (input.note !== undefined) {
      sets.push('note = ?');
      params.push(input.note.trim());
    }
    params.push(id, taskId, input.version);
    const updated = this.#db
      .stmt(
        `UPDATE task_time_logs SET ${sets.join(', ')}
         WHERE id = ? AND task_id = ? AND version = ? RETURNING id`,
      )
      .get(...params) as unknown as { id: string } | undefined;
    if (!updated) {
      const current = this.#timeLogRow(id);
      return current ? { status: 'conflict', current: toTimeLog(current) } : { status: 'missing' };
    }
    const row = this.#timeLogRow(id);
    if (!row) throw new Error('time log update failed');
    return { status: 'ok', log: toTimeLog(row) };
  }

  removeTimeLog(id: string, taskId: string, workspaceId: string): boolean {
    if (!this.#task(taskId, workspaceId)) return false;
    const result = this.#db
      .stmt('DELETE FROM task_time_logs WHERE id = ? AND task_id = ?')
      .run(id, taskId);
    return Number(result.changes) > 0;
  }

  timeSummary(taskId: string, workspaceId: string): TimeSummary | null {
    const task = this.#task(taskId, workspaceId);
    if (!task) return null;
    const estimate = this.#db
      .stmt('SELECT estimate_hours FROM project_tasks WHERE id = ?')
      .get(taskId) as unknown as { estimate_hours: number | null };
    const rows = this.#db
      .stmt(
        `SELECT l.id, l.task_id, t.title AS task_title, l.user_id, l.user_name, l.minutes,
                l.work_date, l.note, l.version, l.created_at, l.updated_at
         FROM task_time_logs l JOIN project_tasks t ON t.id = l.task_id
         WHERE l.task_id = ?
         ORDER BY l.work_date DESC, l.created_at DESC`,
      )
      .all(taskId) as unknown as TimeLogRow[];
    const actualMinutes = rows.reduce((sum, row) => sum + Number(row.minutes), 0);
    const actualHours = Number((actualMinutes / 60).toFixed(2));
    const estimateHours = estimate.estimate_hours === null ? null : Number(estimate.estimate_hours);
    return {
      taskId,
      estimateHours,
      actualMinutes,
      actualHours,
      varianceHours:
        estimateHours === null ? null : Number((actualHours - estimateHours).toFixed(2)),
      logs: rows.map(toTimeLog),
    };
  }

  listTimeLogs(input: { taskId?: string; projectId?: string; workspaceId: string }): TimeLog[] {
    const where = ['p.workspace_id = ?', 'p.deleted_at IS NULL'];
    const params: string[] = [input.workspaceId];
    if (input.taskId) {
      where.push('l.task_id = ?');
      params.push(input.taskId);
    }
    if (input.projectId) {
      where.push('t.project_id = ?');
      params.push(input.projectId);
    }
    const rows = this.#db
      .stmt(
        `SELECT l.id, l.task_id, t.title AS task_title, l.user_id, l.user_name, l.minutes,
                l.work_date, l.note, l.version, l.created_at, l.updated_at
         FROM task_time_logs l
         JOIN project_tasks t ON t.id = l.task_id
         JOIN projects p ON p.id = t.project_id
         WHERE ${where.join(' AND ')}
         ORDER BY l.work_date DESC, l.created_at DESC
         LIMIT 500`,
      )
      .all(...params) as unknown as TimeLogRow[];
    return rows.map(toTimeLog);
  }

  #blockerRow(id: string, workspaceId: string): BlockerRow | null {
    const row = this.#db
      .stmt(
        `SELECT b.id, b.task_id, t.title AS task_title, b.reason, b.category, b.owner_team,
                b.expected_resolve_at, b.status, b.resolved_at, ru.name AS resolved_by_name,
                b.evidence, cu.name AS created_by_name, b.version, b.created_at, b.updated_at
         FROM task_blockers b
         JOIN project_tasks t ON t.id = b.task_id
         JOIN projects p ON p.id = t.project_id
         LEFT JOIN users ru ON ru.id = b.resolved_by
         LEFT JOIN users cu ON cu.id = b.created_by
         WHERE b.id = ? AND p.workspace_id = ?`,
      )
      .get(id, workspaceId) as unknown as BlockerRow | undefined;
    return row ?? null;
  }

  addBlocker(
    taskId: string,
    workspaceId: string,
    input: {
      reason: string;
      category?: TaskBlocker['category'];
      ownerTeam?: string;
      expectedResolveAt?: string | null;
    },
    user: UserOption,
  ): BlockerResult {
    if (!this.#task(taskId, workspaceId)) return { status: 'missing' };
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.#db
      .stmt(
        `INSERT INTO task_blockers
           (id, task_id, reason, category, owner_team, expected_resolve_at, status, evidence,
            created_by, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', '', ?, 1, ?, ?)`,
      )
      .run(
        id,
        taskId,
        input.reason.trim(),
        input.category ?? 'other',
        input.ownerTeam?.trim() ?? '',
        input.expectedResolveAt ?? null,
        user.id,
        now,
        now,
      );
    const row = this.#blockerRow(id, workspaceId);
    if (!row) throw new Error('blocker creation failed');
    return { status: 'ok', blocker: toBlocker(row) };
  }

  resolveBlocker(
    id: string,
    workspaceId: string,
    input: { evidence: string; version: number },
    user: UserOption,
  ): BlockerResult {
    const current = this.#blockerRow(id, workspaceId);
    if (!current) return { status: 'missing' };
    const now = new Date().toISOString();
    const updated = this.#db
      .stmt(
        `UPDATE task_blockers
         SET status = 'resolved', evidence = ?, resolved_at = ?, resolved_by = ?,
             updated_at = ?, version = version + 1
         WHERE id = ? AND status = 'open' AND version = ? RETURNING id`,
      )
      .get(input.evidence.trim(), now, user.id, now, id, input.version) as unknown as
      | { id: string }
      | undefined;
    if (!updated) {
      const latest = this.#blockerRow(id, workspaceId);
      return latest ? { status: 'conflict', current: toBlocker(latest) } : { status: 'missing' };
    }
    const row = this.#blockerRow(id, workspaceId);
    if (!row) throw new Error('blocker resolve failed');
    return { status: 'ok', blocker: toBlocker(row) };
  }

  listBlockers(
    projectId: string,
    workspaceId: string,
    status: 'all' | 'open' | 'resolved' = 'all',
  ): TaskBlocker[] | null {
    if (!this.#project(projectId, workspaceId)) return null;
    const where = ['t.project_id = ?'];
    const params: string[] = [projectId];
    if (status !== 'all') {
      where.push('b.status = ?');
      params.push(status);
    }
    const rows = this.#db
      .stmt(
        `SELECT b.id, b.task_id, t.title AS task_title, b.reason, b.category, b.owner_team,
                b.expected_resolve_at, b.status, b.resolved_at, ru.name AS resolved_by_name,
                b.evidence, cu.name AS created_by_name, b.version, b.created_at, b.updated_at
         FROM task_blockers b
         JOIN project_tasks t ON t.id = b.task_id
         LEFT JOIN users ru ON ru.id = b.resolved_by
         LEFT JOIN users cu ON cu.id = b.created_by
         WHERE ${where.join(' AND ')}
         ORDER BY b.status ASC, b.created_at DESC
         LIMIT 500`,
      )
      .all(...params) as unknown as BlockerRow[];
    return rows.map(toBlocker);
  }

  blockerReport(projectId: string, workspaceId: string): BlockerReport | null {
    if (!this.#project(projectId, workspaceId)) return null;
    const rows = this.#db
      .stmt(
        `SELECT b.category, b.status, b.created_at
         FROM task_blockers b JOIN project_tasks t ON t.id = b.task_id
         WHERE t.project_id = ?`,
      )
      .all(projectId) as unknown as { category: string; status: string; created_at: string }[];
    const byCategory = new Map<string, number>();
    let open = 0;
    let resolved = 0;
    let blockedDays = 0;
    const now = Date.now();
    for (const row of rows) {
      byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + 1);
      if (row.status === 'open') {
        open++;
        blockedDays += Math.max(0, Math.ceil((now - Date.parse(row.created_at)) / DAY_MS));
      } else {
        resolved++;
      }
    }
    return {
      open,
      resolved,
      blockedDays,
      byCategory: [...byCategory.entries()].map(([category, count]) => ({ category, count })),
    };
  }

  #recurrenceRow(id: string, workspaceId: string): RecurrenceRow | null {
    const row = this.#db
      .stmt(
        `SELECT r.* FROM recurrence_rules r
         JOIN projects p ON p.id = r.project_id
         WHERE r.id = ? AND p.workspace_id = ? AND p.deleted_at IS NULL`,
      )
      .get(id, workspaceId) as unknown as RecurrenceRow | undefined;
    return row ?? null;
  }

  listRecurrences(projectId: string, workspaceId: string): RecurrenceRule[] | null {
    if (!this.#project(projectId, workspaceId)) return null;
    const rows = this.#db
      .stmt('SELECT * FROM recurrence_rules WHERE project_id = ? ORDER BY created_at ASC')
      .all(projectId) as unknown as RecurrenceRow[];
    return rows.map(toRecurrence);
  }

  getRecurrence(id: string, workspaceId: string): RecurrenceRule | null {
    const row = this.#recurrenceRow(id, workspaceId);
    return row ? toRecurrence(row) : null;
  }

  createRecurrence(
    projectId: string,
    workspaceId: string,
    input: {
      title: string;
      description?: string;
      status?: TaskStatus;
      priority?: TaskPriority;
      assigneeId?: string | null;
      rule: string;
      timezone?: string;
      startsOn: string;
      endsOn?: string | null;
      count?: number | null;
      exceptions?: string[];
      holidays?: string[];
    },
    actor: UserOption,
  ): RecurrenceResult {
    if (!this.#project(projectId, workspaceId)) return { status: 'missing' };
    if (!parseRecurrenceRule(input.rule)) {
      return { status: 'invalid', message: '重复规则格式无效' };
    }
    if (input.assigneeId) {
      const assignee = this.#db
        .stmt("SELECT 1 AS present FROM users WHERE id = ? AND status = 'active'")
        .get(input.assigneeId) as unknown as { present: number } | undefined;
      if (!assignee) return { status: 'invalid', message: '负责人不存在或已停用' };
    }
    if (input.endsOn && input.endsOn < input.startsOn) {
      return { status: 'invalid', message: '结束日期不能早于开始日期' };
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.#db
      .stmt(
        `INSERT INTO recurrence_rules
           (id, project_id, title, description, status, priority, assignee_id, rule, timezone,
            starts_on, ends_on, count, exceptions_json, holidays_json, active, created_by,
            version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, ?)`,
      )
      .run(
        id,
        projectId,
        input.title.trim(),
        input.description?.trim() ?? '',
        input.status ?? 'todo',
        input.priority ?? 'medium',
        input.assigneeId ?? null,
        input.rule.trim(),
        input.timezone ?? 'Asia/Shanghai',
        input.startsOn,
        input.endsOn ?? null,
        input.count ?? null,
        JSON.stringify(input.exceptions ?? []),
        JSON.stringify(input.holidays ?? []),
        actor.id,
        now,
        now,
      );
    const rule = this.getRecurrence(id, workspaceId);
    if (!rule) throw new Error('recurrence creation failed');
    return { status: 'ok', rule };
  }

  updateRecurrence(
    id: string,
    workspaceId: string,
    input: {
      title?: string;
      description?: string;
      status?: TaskStatus;
      priority?: TaskPriority;
      assigneeId?: string | null;
      rule?: string;
      timezone?: string;
      startsOn?: string;
      endsOn?: string | null;
      count?: number | null;
      exceptions?: string[];
      holidays?: string[];
      active?: boolean;
      version: number;
    },
  ): RecurrenceResult {
    const current = this.#recurrenceRow(id, workspaceId);
    if (!current) return { status: 'missing' };
    if (input.rule !== undefined && !parseRecurrenceRule(input.rule)) {
      return { status: 'invalid', message: '重复规则格式无效' };
    }
    if (input.assigneeId) {
      const assignee = this.#db
        .stmt("SELECT 1 AS present FROM users WHERE id = ? AND status = 'active'")
        .get(input.assigneeId) as unknown as { present: number } | undefined;
      if (!assignee) return { status: 'invalid', message: '负责人不存在或已停用' };
    }
    const sets = ['updated_at = ?', 'version = version + 1'];
    const params: (string | number | null)[] = [new Date().toISOString()];
    const fields: [keyof typeof input, string, (value: unknown) => unknown][] = [
      ['title', 'title', (value) => String(value).trim()],
      ['description', 'description', (value) => String(value).trim()],
      ['status', 'status', (value) => value],
      ['priority', 'priority', (value) => value],
      ['assigneeId', 'assignee_id', (value) => value ?? null],
      ['rule', 'rule', (value) => String(value).trim()],
      ['timezone', 'timezone', (value) => value],
      ['startsOn', 'starts_on', (value) => value],
      ['endsOn', 'ends_on', (value) => value ?? null],
      ['count', 'count', (value) => value ?? null],
      ['exceptions', 'exceptions_json', (value) => JSON.stringify(value ?? [])],
      ['holidays', 'holidays_json', (value) => JSON.stringify(value ?? [])],
      ['active', 'active', (value) => (value ? 1 : 0)],
    ];
    for (const [key, column, cast] of fields) {
      if (input[key] !== undefined) {
        sets.push(`${column} = ?`);
        params.push(cast(input[key]) as string | number | null);
      }
    }
    params.push(id, input.version);
    const updated = this.#db
      .stmt(
        `UPDATE recurrence_rules SET ${sets.join(', ')}
         WHERE id = ? AND version = ? RETURNING id`,
      )
      .get(...params) as unknown as { id: string } | undefined;
    if (!updated) {
      const latest = this.#recurrenceRow(id, workspaceId);
      return latest ? { status: 'conflict', current: toRecurrence(latest) } : { status: 'missing' };
    }
    const rule = this.getRecurrence(id, workspaceId);
    if (!rule) throw new Error('recurrence update failed');
    return { status: 'ok', rule };
  }

  removeRecurrence(id: string, workspaceId: string): boolean {
    if (!this.#recurrenceRow(id, workspaceId)) return false;
    this.#db.stmt('DELETE FROM recurrence_rules WHERE id = ?').run(id);
    return true;
  }

  skipOccurrence(
    id: string,
    workspaceId: string,
    input: { date: string; version: number },
  ): RecurrenceResult {
    const current = this.#recurrenceRow(id, workspaceId);
    if (!current) return { status: 'missing' };
    if (Number(current.version) !== input.version) {
      return { status: 'conflict', current: toRecurrence(current) };
    }
    const exceptions = parseJsonArray(current.exceptions_json);
    if (!exceptions.includes(input.date)) exceptions.push(input.date);
    exceptions.sort();
    const updated = this.#db
      .stmt(
        `UPDATE recurrence_rules SET exceptions_json = ?, updated_at = ?,
           version = version + 1 WHERE id = ? AND version = ? RETURNING id`,
      )
      .get(JSON.stringify(exceptions), new Date().toISOString(), id, input.version) as unknown as
      | { id: string }
      | undefined;
    if (!updated) {
      const latest = this.#recurrenceRow(id, workspaceId);
      return latest ? { status: 'conflict', current: toRecurrence(latest) } : { status: 'missing' };
    }
    const rule = this.getRecurrence(id, workspaceId);
    if (!rule) throw new Error('recurrence update failed');
    return { status: 'ok', rule };
  }

  runRecurrence(
    id: string,
    workspaceId: string,
    through: string | undefined,
    actor: UserOption,
  ):
    | ({ status: 'ok' } & RecurrenceRunResult)
    | { status: 'invalid'; message: string }
    | { status: 'missing' } {
    const rule = this.getRecurrence(id, workspaceId);
    if (!rule) return { status: 'missing' };
    if (!rule.active) return { status: 'invalid', message: '重复规则已停用' };
    if (!parseRecurrenceRule(rule.rule)) return { status: 'invalid', message: '重复规则格式无效' };
    const end = through ?? todayKey();
    if (end < rule.startsOn) {
      return { generated: [], skipped: [], nextOccurrence: null, status: 'ok' };
    }
    const dates = recurrenceOccurrences(rule.rule, rule.startsOn, {
      through: end,
      endsOn: rule.endsOn,
      count: rule.count,
      exceptions: rule.exceptions,
      holidays: rule.holidays,
    });
    const generated: { date: string; taskId: string }[] = [];
    const skipped: string[] = [];
    const now = new Date().toISOString();
    for (const date of dates) {
      const occurrenceKey = `${rule.id}:${date}`;
      const existing = this.#db
        .stmt('SELECT 1 AS present FROM recurrence_instances WHERE occurrence_key = ?')
        .get(occurrenceKey) as unknown as { present: number } | undefined;
      if (existing) {
        skipped.push(date);
        continue;
      }
      const instanceId = crypto.randomUUID();
      try {
        this.#db
          .stmt(
            `INSERT INTO recurrence_instances (id, rule_id, occurrence_key, occurrence_date, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(instanceId, rule.id, occurrenceKey, date, now);
      } catch {
        skipped.push(date);
        continue;
      }
      const created = this.#tasks.create(
        rule.projectId,
        {
          title: rule.title,
          description: rule.description,
          status: rule.status,
          priority: rule.priority,
          assigneeId: rule.assigneeId,
          dueDate: date,
        },
        actor,
      );
      if (created.status !== 'ok') {
        this.#db.stmt('DELETE FROM recurrence_instances WHERE id = ?').run(instanceId);
        skipped.push(date);
        continue;
      }
      this.#db
        .stmt('UPDATE recurrence_instances SET task_id = ? WHERE id = ?')
        .run(created.task.id, instanceId);
      generated.push({ date, taskId: created.task.id });
    }
    this.#db
      .stmt(
        `UPDATE recurrence_rules
         SET last_generated_on = ?, updated_at = ?, version = version + 1
         WHERE id = ? AND (last_generated_on IS NULL OR last_generated_on < ?)`,
      )
      .run(end, now, rule.id, end);
    return {
      status: 'ok',
      generated,
      skipped,
      nextOccurrence: nextOccurrence(rule.rule, rule.startsOn, end),
    };
  }
}
