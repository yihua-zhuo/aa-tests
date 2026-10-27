import type {
  AutomationAction,
  AutomationCondition,
  AutomationPreview,
  AutomationRule,
  AutomationRun,
  AutomationTrigger,
  TaskPriority,
  TaskStatus,
  UserOption,
} from '../../shared/types.ts';
import type { Database } from '../db.ts';
import type { CommentsStore } from './comments.ts';
import type { NotificationsStore } from './notifications.ts';
import type { TasksStore } from './tasks.ts';

type RuleRow = {
  id: string;
  workspace_id: string;
  project_id: string | null;
  name: string;
  trigger_event: string;
  conditions_json: string;
  actions_json: string;
  active: number;
  max_runs_per_hour: number;
  created_by: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

type RunRow = {
  id: string;
  rule_id: string;
  rule_name: string;
  event_key: string;
  mode: string;
  trigger_event: string;
  input_json: string;
  status: string;
  output_json: string;
  error: string | null;
  duration_ms: number;
  replay_of: string | null;
  created_at: string;
};

export type AutomationRuleInput = {
  name: string;
  projectId?: string | null;
  trigger: AutomationTrigger;
  conditions?: AutomationCondition[];
  actions: AutomationAction[];
  active?: boolean;
  maxRunsPerHour?: number;
};

export type AutomationEvent = {
  trigger: AutomationTrigger;
  eventKey: string;
  workspaceId: string;
  projectId: string;
  projectName?: string;
  taskId?: string;
  taskTitle?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assigneeId?: string | null;
  actor?: UserOption | null;
};

export type AutomationDryRunInput = {
  trigger: AutomationTrigger;
  task?: {
    id?: string;
    title?: string;
    status?: TaskStatus;
    priority?: TaskPriority;
    assigneeId?: string | null;
    projectId?: string;
  };
  eventKey?: string;
};

type RuleResult =
  | { status: 'ok'; rule: AutomationRule }
  | { status: 'invalid'; message: string }
  | { status: 'missing' }
  | { status: 'conflict'; current: AutomationRule };

const SYSTEM_USER_ID = '00000000-0000-4000-8000-000000000000';

const ACTION_LABELS: Record<AutomationAction['type'], string> = {
  set_status: '修改状态',
  set_priority: '修改优先级',
  assign_to: '指派负责人',
  add_comment: '添加评论',
  create_task: '创建任务',
  notify: '发送通知',
};

function parseList<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseJsonRecord(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toRule(row: RuleRow): AutomationRule {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    name: row.name,
    trigger: row.trigger_event as AutomationTrigger,
    conditions: parseList<AutomationCondition>(row.conditions_json),
    actions: parseList<AutomationAction>(row.actions_json),
    active: Boolean(row.active),
    maxRunsPerHour: Number(row.max_runs_per_hour),
    createdById: row.created_by,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRun(row: RunRow): AutomationRun {
  let output: unknown = {};
  try {
    output = JSON.parse(row.output_json) as unknown;
  } catch {
    output = {};
  }
  return {
    id: row.id,
    ruleId: row.rule_id,
    ruleName: row.rule_name,
    eventKey: row.event_key,
    mode: row.mode as AutomationRun['mode'],
    trigger: row.trigger_event,
    status: row.status as AutomationRun['status'],
    output,
    error: row.error,
    durationMs: Number(row.duration_ms),
    replayOf: row.replay_of,
    createdAt: row.created_at,
  };
}

function valuesEqual(actual: unknown, expected: unknown): boolean {
  if (typeof expected === 'number') return Number(actual) === expected;
  if (typeof expected === 'boolean') return Boolean(actual) === expected;
  return String(actual ?? '') === String(expected ?? '');
}

export function evaluateConditions(
  conditions: AutomationCondition[],
  snapshot: Record<string, unknown>,
): { matched: boolean; failed: string | null } {
  for (const condition of conditions) {
    const actual = snapshot[condition.field];
    if (condition.operator === 'exists') {
      if (actual === null || actual === undefined || actual === '') {
        return { matched: false, failed: condition.field };
      }
      continue;
    }
    if (condition.operator === 'eq' && !valuesEqual(actual, condition.value)) {
      return { matched: false, failed: condition.field };
    }
    if (condition.operator === 'neq' && valuesEqual(actual, condition.value)) {
      return { matched: false, failed: condition.field };
    }
    if (condition.operator === 'contains') {
      if (!String(actual ?? '').includes(String(condition.value ?? ''))) {
        return { matched: false, failed: condition.field };
      }
    }
    if (condition.operator === 'in') {
      const list = Array.isArray(condition.value)
        ? condition.value
        : String(condition.value ?? '').split(',');
      if (!list.some((item) => valuesEqual(actual, item))) {
        return { matched: false, failed: condition.field };
      }
    }
  }
  return { matched: true, failed: null };
}

export class AutomationStore {
  readonly #db: Database;
  readonly #tasks: TasksStore;
  readonly #comments: CommentsStore;
  readonly #notifications: NotificationsStore;

  constructor(
    db: Database,
    tasks: TasksStore,
    comments: CommentsStore,
    notifications: NotificationsStore,
  ) {
    this.#db = db;
    this.#tasks = tasks;
    this.#comments = comments;
    this.#notifications = notifications;
  }

  #ruleRow(id: string, workspaceId: string): RuleRow | null {
    const row = this.#db
      .stmt('SELECT * FROM automation_rules WHERE id = ? AND workspace_id = ?')
      .get(id, workspaceId) as unknown as RuleRow | undefined;
    return row ?? null;
  }

  listRules(
    workspaceId: string,
    input: { trigger?: AutomationTrigger; projectId?: string } = {},
  ): AutomationRule[] {
    const where = ['workspace_id = ?'];
    const params: string[] = [workspaceId];
    if (input.trigger) {
      where.push('trigger_event = ?');
      params.push(input.trigger);
    }
    if (input.projectId) {
      where.push('project_id = ?');
      params.push(input.projectId);
    }
    const rows = this.#db
      .stmt(
        `SELECT * FROM automation_rules WHERE ${where.join(' AND ')}
         ORDER BY created_at ASC LIMIT 200`,
      )
      .all(...params) as unknown as RuleRow[];
    return rows.map(toRule);
  }

  getRule(id: string, workspaceId: string): AutomationRule | null {
    const row = this.#ruleRow(id, workspaceId);
    return row ? toRule(row) : null;
  }

  #validateInput(workspaceId: string, input: Partial<AutomationRuleInput>): string | null {
    if (input.projectId) {
      const project = this.#db
        .stmt(
          'SELECT 1 AS present FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL',
        )
        .get(input.projectId, workspaceId) as unknown as { present: number } | undefined;
      if (!project) return '项目不存在';
    }
    for (const action of input.actions ?? []) {
      if (
        action.type === 'set_status' &&
        !['todo', 'in_progress', 'review', 'done'].includes(action.value ?? '')
      ) {
        return '状态动作缺少有效的目标状态';
      }
      if (
        action.type === 'set_priority' &&
        !['low', 'medium', 'high', 'urgent'].includes(action.value ?? '')
      ) {
        return '优先级动作缺少有效的目标优先级';
      }
      if (action.type === 'assign_to' && action.value) {
        const user = this.#db
          .stmt("SELECT 1 AS present FROM users WHERE id = ? AND status = 'active'")
          .get(action.value) as unknown as { present: number } | undefined;
        if (!user) return '指派目标用户不存在或已停用';
      }
      if (
        (action.type === 'add_comment' || action.type === 'notify') &&
        !(action.value ?? action.title)
      ) {
        return `${ACTION_LABELS[action.type]}动作缺少内容`;
      }
      if (action.type === 'create_task' && !(action.title ?? action.value)) {
        return '创建任务动作缺少标题';
      }
    }
    return null;
  }

  createRule(
    workspaceId: string,
    input: AutomationRuleInput,
    actorId: string | null,
    now = new Date().toISOString(),
  ): RuleResult {
    const workspace = this.#db
      .stmt('SELECT 1 AS present FROM workspaces WHERE id = ?')
      .get(workspaceId) as unknown as { present: number } | undefined;
    if (!workspace) return { status: 'invalid', message: '工作区不存在' };
    const error = this.#validateInput(workspaceId, input);
    if (error) return { status: 'invalid', message: error };
    const id = crypto.randomUUID();
    this.#db
      .stmt(
        `INSERT INTO automation_rules
           (id, workspace_id, project_id, name, trigger_event, conditions_json, actions_json,
            active, max_runs_per_hour, created_by, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        input.projectId ?? null,
        input.name.trim(),
        input.trigger,
        JSON.stringify(input.conditions ?? []),
        JSON.stringify(input.actions),
        input.active === false ? 0 : 1,
        input.maxRunsPerHour ?? 60,
        actorId,
        now,
        now,
      );
    const rule = this.getRule(id, workspaceId);
    if (!rule) throw new Error('automation rule creation failed');
    return { status: 'ok', rule };
  }

  updateRule(
    id: string,
    workspaceId: string,
    input: Partial<AutomationRuleInput> & { version: number },
    now = new Date().toISOString(),
  ): RuleResult {
    const row = this.#ruleRow(id, workspaceId);
    if (!row) return { status: 'missing' };
    const error = this.#validateInput(workspaceId, input);
    if (error) return { status: 'invalid', message: error };
    this.#snapshotVersion(row, input.version);
    const sets = ['updated_at = ?', 'version = version + 1'];
    const params: (string | number | null)[] = [now];
    const fields: [keyof typeof input, string, (value: unknown) => unknown][] = [
      ['name', 'name', (value) => String(value).trim()],
      ['projectId', 'project_id', (value) => value ?? null],
      ['trigger', 'trigger_event', (value) => value],
      ['conditions', 'conditions_json', (value) => JSON.stringify(value ?? [])],
      ['actions', 'actions_json', (value) => JSON.stringify(value ?? [])],
      ['active', 'active', (value) => (value ? 1 : 0)],
      ['maxRunsPerHour', 'max_runs_per_hour', (value) => value],
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
        `UPDATE automation_rules SET ${sets.join(', ')}
         WHERE id = ? AND workspace_id = ? AND version = ? RETURNING id`,
      )
      .get(...params) as unknown as { id: string } | undefined;
    if (!updated) {
      const current = this.getRule(id, workspaceId);
      return current ? { status: 'conflict', current } : { status: 'missing' };
    }
    const rule = this.getRule(id, workspaceId);
    if (!rule) throw new Error('automation rule update failed');
    return { status: 'ok', rule };
  }

  recordVersion(id: string, workspaceId: string): AutomationRule | null {
    const row = this.#ruleRow(id, workspaceId);
    if (!row) return null;
    this.#snapshotVersion(row, row.version);
    return toRule(row);
  }

  removeRule(id: string, workspaceId: string): boolean {
    const row = this.#ruleRow(id, workspaceId);
    if (!row) return false;
    this.#db.stmt('DELETE FROM automation_rules WHERE id = ?').run(id);
    return true;
  }

  #snapshotVersion(row: RuleRow, version: number): void {
    const rule = toRule(row);
    this.#db
      .stmt(
        `INSERT OR IGNORE INTO automation_rule_versions
           (id, rule_id, version, snapshot_json, change_summary, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        rule.id,
        version,
        JSON.stringify({
          name: rule.name,
          projectId: rule.projectId,
          trigger: rule.trigger,
          conditions: rule.conditions,
          actions: rule.actions,
          active: rule.active,
          maxRunsPerHour: rule.maxRunsPerHour,
        }),
        '更新前自动快照',
        row.created_by,
        new Date().toISOString(),
      );
  }

  #insertRun(input: {
    ruleId: string;
    eventKey: string;
    mode: AutomationRun['mode'];
    trigger: string;
    status: AutomationRun['status'];
    output: unknown;
    input?: unknown;
    error?: string | null;
    durationMs?: number;
    replayOf?: string | null;
  }): AutomationRun | null {
    const id = crypto.randomUUID();
    const result = this.#db
      .stmt(
        `INSERT OR IGNORE INTO automation_runs
           (id, rule_id, event_key, mode, trigger_event, input_json, status, output_json, error,
            duration_ms, replay_of, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.ruleId,
        input.eventKey,
        input.mode,
        input.trigger,
        JSON.stringify(input.input ?? {}),
        input.status,
        JSON.stringify(input.output ?? {}),
        input.error ?? null,
        input.durationMs ?? 0,
        input.replayOf ?? null,
        new Date().toISOString(),
      );
    if (Number(result.changes) === 0) return null;
    const row = this.#db
      .stmt(
        `SELECT r.*, rule.name AS rule_name FROM automation_runs r
         JOIN automation_rules rule ON rule.id = r.rule_id
         WHERE r.id = ?`,
      )
      .get(id) as unknown as RunRow;
    return toRun(row);
  }

  listRuns(workspaceId: string, input: { ruleId?: string; limit?: number } = {}): AutomationRun[] {
    const where = ['rule.workspace_id = ?'];
    const params: (string | number)[] = [workspaceId];
    if (input.ruleId) {
      where.push('r.rule_id = ?');
      params.push(input.ruleId);
    }
    params.push(input.limit ?? 50);
    const rows = this.#db
      .stmt(
        `SELECT r.*, rule.name AS rule_name FROM automation_runs r
         JOIN automation_rules rule ON rule.id = r.rule_id
         WHERE ${where.join(' AND ')}
         ORDER BY r.created_at DESC LIMIT ?`,
      )
      .all(...params) as unknown as RunRow[];
    return rows.map(toRun);
  }

  getRun(id: string, workspaceId: string): AutomationRun | null {
    const row = this.#db
      .stmt(
        `SELECT r.*, rule.name AS rule_name FROM automation_runs r
         JOIN automation_rules rule ON rule.id = r.rule_id
         WHERE r.id = ? AND rule.workspace_id = ?`,
      )
      .get(id, workspaceId) as unknown as RunRow | undefined;
    return row ? toRun(row) : null;
  }

  deadLetters(workspaceId: string, limit = 100): AutomationRun[] {
    const rows = this.#db
      .stmt(
        `SELECT r.*, rule.name AS rule_name FROM automation_runs r
         JOIN automation_rules rule ON rule.id = r.rule_id
         WHERE rule.workspace_id = ? AND r.status = 'failed'
           AND r.replay_of IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM automation_runs replay
             WHERE replay.replay_of = r.id AND replay.status = 'ok'
           )
         ORDER BY r.created_at DESC LIMIT ?`,
      )
      .all(workspaceId, limit) as unknown as RunRow[];
    return rows.map(toRun);
  }

  #eventFromRun(run: RunRow, rule: AutomationRule, eventKey: string): AutomationEvent {
    const snapshot = parseJsonRecord(run.input_json);
    return {
      trigger: rule.trigger,
      eventKey,
      workspaceId: rule.workspaceId,
      projectId: String(snapshot.projectId ?? rule.projectId ?? ''),
      taskId: typeof snapshot.taskId === 'string' ? snapshot.taskId : undefined,
      taskTitle: typeof snapshot.title === 'string' ? snapshot.title : undefined,
      status: typeof snapshot.status === 'string' ? (snapshot.status as TaskStatus) : undefined,
      priority:
        typeof snapshot.priority === 'string' ? (snapshot.priority as TaskPriority) : undefined,
      assigneeId: typeof snapshot.assigneeId === 'string' ? snapshot.assigneeId : undefined,
    };
  }

  replayRun(runId: string, workspaceId: string, actor: UserOption): AutomationRun | null {
    const row = this.#db
      .stmt(
        `SELECT r.*, rule.name AS rule_name FROM automation_runs r
         JOIN automation_rules rule ON rule.id = r.rule_id
         WHERE r.id = ? AND rule.workspace_id = ?`,
      )
      .get(runId, workspaceId) as unknown as RunRow | undefined;
    if (!row) return null;
    const rule = this.getRule(row.rule_id, workspaceId);
    if (!rule) return null;
    const event = this.#eventFromRun(row, rule, `replay_${crypto.randomUUID()}`);
    if (!event.projectId) return null;
    const started = performance.now();
    try {
      const executed = this.#execute(rule, event, actor);
      return this.#insertRun({
        ruleId: rule.id,
        eventKey: event.eventKey,
        mode: 'replay',
        trigger: event.trigger,
        status: 'ok',
        input: parseJsonRecord(row.input_json),
        output: executed.output,
        durationMs: Math.round(performance.now() - started),
        replayOf: runId,
      });
    } catch (error) {
      return this.#insertRun({
        ruleId: rule.id,
        eventKey: event.eventKey,
        mode: 'replay',
        trigger: event.trigger,
        status: 'failed',
        input: parseJsonRecord(row.input_json),
        output: {},
        error: error instanceof Error ? error.message : '自动化重放失败',
        durationMs: Math.round(performance.now() - started),
        replayOf: runId,
      });
    }
  }

  retryRunAction(
    runId: string,
    workspaceId: string,
    actionIndex: number,
    actor: UserOption,
  ): { status: 'ok' | 'missing' | 'invalid'; run?: AutomationRun; message?: string } {
    const row = this.#db
      .stmt(
        `SELECT r.*, rule.name AS rule_name FROM automation_runs r
         JOIN automation_rules rule ON rule.id = r.rule_id
         WHERE r.id = ? AND rule.workspace_id = ?`,
      )
      .get(runId, workspaceId) as unknown as RunRow | undefined;
    if (!row) return { status: 'missing' };
    const rule = this.getRule(row.rule_id, workspaceId);
    if (!rule) return { status: 'missing' };
    if (!Number.isInteger(actionIndex) || actionIndex < 0 || actionIndex >= rule.actions.length) {
      return { status: 'invalid', message: '动作序号无效' };
    }
    const event = this.#eventFromRun(row, rule, `retry_${crypto.randomUUID()}`);
    if (!event.projectId) return { status: 'invalid', message: '运行记录缺少项目信息' };
    const started = performance.now();
    try {
      const executed = this.#execute(rule, event, actor, actionIndex);
      const run = this.#insertRun({
        ruleId: rule.id,
        eventKey: event.eventKey,
        mode: 'replay',
        trigger: event.trigger,
        status: 'ok',
        input: parseJsonRecord(row.input_json),
        output: { retriedAction: actionIndex, ...(executed.output as Record<string, unknown>) },
        durationMs: Math.round(performance.now() - started),
        replayOf: runId,
      });
      return run ? { status: 'ok', run } : { status: 'invalid', message: '重试记录写入失败' };
    } catch (error) {
      return {
        status: 'invalid',
        message: error instanceof Error ? error.message : '动作重试失败',
      };
    }
  }

  pruneRuns(workspaceId: string, olderThanDays = 30): number {
    const days = Math.min(Math.max(Math.floor(olderThanDays), 1), 3650);
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const result = this.#db
      .stmt(
        `DELETE FROM automation_runs WHERE created_at < ? AND rule_id IN (
           SELECT id FROM automation_rules WHERE workspace_id = ?
         )`,
      )
      .run(cutoff, workspaceId);
    return Number(result.changes);
  }

  #snapshotFor(event: AutomationEvent): Record<string, unknown> {
    return {
      trigger: event.trigger,
      projectId: event.projectId,
      projectName: event.projectName ?? '',
      taskId: event.taskId ?? '',
      id: event.taskId ?? '',
      title: event.taskTitle ?? '',
      status: event.status ?? '',
      priority: event.priority ?? '',
      assigneeId: event.assigneeId ?? '',
    };
  }

  #describe(actions: AutomationAction[]): { type: string; description: string }[] {
    return actions.map((action) => {
      const target =
        action.value ?? action.title ?? (action.type === 'create_task' ? '新任务' : '');
      return {
        type: action.type,
        description: `${ACTION_LABELS[action.type]}${target ? `：${target}` : ''}`,
      };
    });
  }

  #systemActor(event: AutomationEvent, rule: AutomationRule): UserOption {
    if (event.actor) return event.actor;
    const row = this.#db
      .stmt('SELECT id, name FROM users WHERE id = ?')
      .get(rule.createdById ?? SYSTEM_USER_ID) as unknown as
      | { id: string; name: string }
      | undefined;
    return row ?? { id: SYSTEM_USER_ID, name: '自动化' };
  }

  dryRun(
    id: string,
    workspaceId: string,
    input: AutomationDryRunInput,
    actorId: string | null,
  ): AutomationPreview | null {
    const rule = this.getRule(id, workspaceId);
    if (!rule?.active) return null;
    const eventKey = input.eventKey?.trim() || `dry_${crypto.randomUUID()}`;
    const event: AutomationEvent = {
      trigger: input.trigger,
      eventKey,
      workspaceId,
      projectId: input.task?.projectId ?? rule.projectId ?? '',
      taskId: input.task?.id,
      taskTitle: input.task?.title,
      status: input.task?.status,
      priority: input.task?.priority,
      assigneeId: input.task?.assigneeId,
    };
    const snapshot = this.#snapshotFor(event);
    const evaluation = evaluateConditions(rule.conditions, snapshot);
    const blockedReason = rule.trigger !== input.trigger ? 'trigger_mismatch' : null;
    const matched = evaluation.matched && blockedReason === null;
    const run = this.#insertRun({
      ruleId: rule.id,
      eventKey,
      mode: 'dry_run',
      trigger: input.trigger,
      status: matched ? 'ok' : 'skipped',
      output: {
        matched,
        failedCondition: evaluation.failed,
        blockedReason,
        actions: this.#describe(rule.actions),
        actorId,
      },
      error: null,
    });
    return {
      matched,
      blockedReason:
        blockedReason ?? (evaluation.matched ? null : `condition:${evaluation.failed ?? ''}`),
      actions: this.#describe(rule.actions),
      runs: run ? [run] : this.listRuns(workspaceId, { ruleId: rule.id, limit: 1 }),
    };
  }

  #hourlyRuns(ruleId: string): number {
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const row = this.#db
      .stmt(
        `SELECT COUNT(*) AS total FROM automation_runs
         WHERE rule_id = ? AND mode = 'live' AND created_at >= ?`,
      )
      .get(ruleId, since) as unknown as { total: number };
    return Number(row.total);
  }

  #execute(
    rule: AutomationRule,
    event: AutomationEvent,
    actor: UserOption,
    onlyAction?: number,
  ): { output: unknown; error: string | null } {
    const output: Record<string, unknown> = { actions: [] };
    const results: unknown[] = [];
    output.actions = results;
    let task: ReturnType<TasksStore['get']> | null = event.taskId
      ? this.#tasks.get(event.taskId)
      : null;
    for (let index = 0; index < rule.actions.length; index += 1) {
      const action = rule.actions[index] as AutomationAction;
      if (onlyAction !== undefined && index !== onlyAction) continue;
      if (
        action.type === 'set_status' ||
        action.type === 'set_priority' ||
        action.type === 'assign_to'
      ) {
        if (!task) {
          results.push({ type: action.type, status: 'skipped', reason: 'missing_task' });
          continue;
        }
        const patch =
          action.type === 'set_status'
            ? { status: action.value as TaskStatus }
            : action.type === 'set_priority'
              ? { priority: action.value as TaskPriority }
              : { assigneeId: action.value ?? null };
        const result = this.#tasks.update(task.id, patch, task.version, actor);
        if (result.status === 'ok') {
          task = result.task;
          results.push({ type: action.type, status: 'ok', taskId: task.id });
        } else {
          results.push({ type: action.type, status: result.status });
        }
        continue;
      }
      if (action.type === 'add_comment') {
        if (!task || !event.projectId) {
          results.push({ type: action.type, status: 'skipped', reason: 'missing_task' });
          continue;
        }
        const project = this.#db
          .stmt('SELECT name FROM projects WHERE id = ?')
          .get(event.projectId) as unknown as { name: string } | undefined;
        this.#comments.create(
          {
            project: { id: event.projectId, name: project?.name ?? '项目' },
            task: { id: task.id, title: task.title, assigneeId: task.assigneeId },
          },
          { body: action.value ?? action.title ?? '' },
          actor,
        );
        results.push({ type: action.type, status: 'ok' });
        continue;
      }
      if (action.type === 'create_task') {
        if (!event.projectId) {
          results.push({ type: action.type, status: 'skipped', reason: 'missing_project' });
          continue;
        }
        const created = this.#tasks.create(
          event.projectId,
          {
            title: action.title ?? action.value ?? '自动化任务',
            description: `由规则「${rule.name}」创建`,
            assigneeId: event.assigneeId ?? null,
          },
          actor,
        );
        results.push({
          type: action.type,
          status: created.status,
          taskId: created.status === 'ok' ? created.task.id : null,
        });
        continue;
      }
      const target = event.assigneeId || rule.createdById;
      if (target) {
        this.#notifications.create({
          userId: target,
          type: 'task_assigned',
          title: `自动化提醒：${rule.name}`,
          body: action.value ?? action.title ?? '规则已触发',
          link: event.projectId ? `/projects/${event.projectId}` : null,
          projectId: event.projectId || null,
          taskId: event.taskId ?? null,
        });
        results.push({ type: action.type, status: 'ok', userId: target });
      } else {
        results.push({ type: action.type, status: 'skipped', reason: 'missing_recipient' });
      }
    }
    return { output, error: null };
  }

  runEvent(event: AutomationEvent): AutomationRun[] {
    if (!event.projectId) return [];
    const rows = this.#db
      .stmt(
        `SELECT * FROM automation_rules
         WHERE workspace_id = ? AND trigger_event = ? AND active = 1
           AND (project_id IS NULL OR project_id = ?)
         ORDER BY created_at ASC`,
      )
      .all(event.workspaceId, event.trigger, event.projectId) as unknown as RuleRow[];
    const runs: AutomationRun[] = [];
    const seen = this.#db.stmt(
      `SELECT 1 AS present FROM automation_runs
       WHERE rule_id = ? AND event_key = ? AND mode = 'live' LIMIT 1`,
    );
    for (const row of rows) {
      const rule = toRule(row);
      if (seen.get(rule.id, event.eventKey)) continue;
      const snapshot = this.#snapshotFor(event);
      if (this.#hourlyRuns(rule.id) >= rule.maxRunsPerHour) {
        const run = this.#insertRun({
          ruleId: rule.id,
          eventKey: event.eventKey,
          mode: 'live',
          trigger: event.trigger,
          status: 'skipped',
          input: snapshot,
          output: { reason: 'rate_limited' },
        });
        if (run) runs.push(run);
        continue;
      }
      const evaluation = evaluateConditions(rule.conditions, snapshot);
      if (!evaluation.matched) {
        const run = this.#insertRun({
          ruleId: rule.id,
          eventKey: event.eventKey,
          mode: 'live',
          trigger: event.trigger,
          status: 'skipped',
          input: snapshot,
          output: {
            reason: 'conditions_not_met',
            failedCondition: evaluation.failed,
            condition: evaluation,
          },
        });
        if (run) runs.push(run);
        continue;
      }
      const started = performance.now();
      try {
        const executed = this.#execute(rule, event, this.#systemActor(event, rule));
        const run = this.#insertRun({
          ruleId: rule.id,
          eventKey: event.eventKey,
          mode: 'live',
          trigger: event.trigger,
          status: 'ok',
          input: snapshot,
          output: {
            ...(executed.output as Record<string, unknown>),
            condition: evaluation,
          },
          durationMs: Math.round(performance.now() - started),
        });
        if (run) runs.push(run);
      } catch (error) {
        const message = error instanceof Error ? error.message : '自动化执行失败';
        const run = this.#insertRun({
          ruleId: rule.id,
          eventKey: event.eventKey,
          mode: 'live',
          trigger: event.trigger,
          status: 'failed',
          input: snapshot,
          output: { condition: evaluation },
          error: message,
          durationMs: Math.round(performance.now() - started),
        });
        if (run) runs.push(run);
      }
    }
    return runs;
  }
}
