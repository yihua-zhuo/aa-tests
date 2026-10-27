import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { canManageProject, canManageWorkspace } from '../../shared/permissions.ts';
import type {
  AnomalyDetectSchema,
  AnomalyDismissSchema,
  ApprovalCreateSchema,
  ApprovalDecisionSchema,
  ApprovalMetricsQuerySchema,
  ApprovalRoutingRuleCreateSchema,
  ApprovalWithdrawSchema,
  AutomationRollbackSchema,
  BackgroundJobCreateSchema,
  BackgroundJobTickSchema,
  BaselineCreateSchema,
  BaselineDecisionSchema,
  BenefitRecordSchema,
  BudgetApprovalSchema,
  BudgetCategoryCreateSchema,
  BudgetCategoryUpdateSchema,
  CapacityPlanSchema,
  CapacityProfileUpdateSchema,
  CapacityScenarioSchema,
  ChangeRequestCommentSchema,
  ChangeRequestDecisionSchema,
  ChangeRequestImplementSchema,
  ChannelMessageCreateSchema,
  ChannelMessageUpdateSchema,
  ChannelSearchQuerySchema,
  ClosureCreateSchema,
  ClosureReopenSchema,
  ConnectorCallSchema,
  ConnectorOAuthCallbackSchema,
  ConnectorOAuthStartSchema,
  ConnectorRotateSchema,
  DeliverableReviewSchema,
  DeliverableVersionCreateSchema,
  DepartmentCreateSchema,
  DispatchAcceptSchema,
  DispatchBatchSchema,
  DispatchRecommendSchema,
  DocumentCommentCreateSchema,
  DocumentCommentResolveSchema,
  DocumentDiffQuerySchema,
  EventPublishSchema,
  EventSubscriptionCreateSchema,
  FormValuesPutSchema,
  FunnelQuerySchema,
  GateDecisionSchema,
  HandoffCreateSchema,
  HandoffDecisionSchema,
  HealthConfigSchema,
  JitPostReviewSchema,
  JitUsageSchema,
  KnowledgeGraphQuerySchema,
  KnowledgeLinkCreateSchema,
  KnowledgeSearchQuerySchema,
  KnowledgeSynonymCreateSchema,
  LineageCreateSchema,
  MeetingActionConvertSchema,
  MeetingCompleteSchema,
  OrganizationCreateSchema,
  OrgMembershipCreateSchema,
  PermissionSampleRunSchema,
  PlaybookFeedbackSchema,
  PortalAccountCreateSchema,
  PortalCreateSchema,
  PortalDeliveryConfirmSchema,
  PortalInternalCommentSchema,
  PortalRequestCommentSchema,
  PortalRequestCreateSchema,
  PortalRequestUpdateSchema,
  QualityBatchFixSchema,
  QualityFixSchema,
  QualityRevertSchema,
  QualityScanSchema,
  QueryPreviewSchema,
  ReportSubscriptionCreateSchema,
  SandboxRunSchema,
  TaskEstimateSchema,
  TaskSlaActionSchema,
  TaskSlaAttachSchema,
  TaskTreeBulkSchema,
  TriggerFireSchema,
  WorkflowPublishSchema,
  WorkflowReplaySchema,
  WorkflowRetryNodeSchema,
  WorkflowRollbackSchema,
  WorkflowRunStartSchema,
  WorkflowTestSchema,
  WorkspaceMemberCreateSchema,
  WorkspaceSwitchSchema,
} from '../../shared/schemas.ts';
import type { CapacityRow, SessionUser } from '../../shared/types.ts';
import { webhookUrlIssue } from '../../shared/webhooks.ts';
import type { Store } from '../store.ts';
import { webhookSignature } from '../webhook-worker.ts';
import {
  connectorRateIssue,
  connectorView,
  decryptConnectorSecret,
  encryptConnectorSecret,
  logConnectorCall,
  safeConnectorTarget,
} from './connectors.ts';

type Row = Record<string, unknown>;
export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: 400 | 403 | 404 | 409 | 500; message: string; current?: unknown };

type GateDecision = z.infer<typeof GateDecisionSchema>;
type BaselineCreate = z.infer<typeof BaselineCreateSchema>;
type BaselineDecision = z.infer<typeof BaselineDecisionSchema>;
type ChangeDecision = z.infer<typeof ChangeRequestDecisionSchema>;
type ChangeComment = z.infer<typeof ChangeRequestCommentSchema>;
type ChangeImplement = z.infer<typeof ChangeRequestImplementSchema>;
type ApprovalRoutingRuleCreate = z.infer<typeof ApprovalRoutingRuleCreateSchema>;
type CapacityProfileUpdate = z.infer<typeof CapacityProfileUpdateSchema>;
type CapacityScenario = z.infer<typeof CapacityScenarioSchema>;
type CapacityPlan = z.infer<typeof CapacityPlanSchema>;
type HealthConfig = z.infer<typeof HealthConfigSchema>;
type BudgetApproval = z.infer<typeof BudgetApprovalSchema>;
type QualityRevert = z.infer<typeof QualityRevertSchema>;
type ClosureCreate = z.infer<typeof ClosureCreateSchema>;
type ClosureReopen = z.infer<typeof ClosureReopenSchema>;
type BenefitRecord = z.infer<typeof BenefitRecordSchema>;
type SlaAttach = z.infer<typeof TaskSlaAttachSchema>;
type SlaAction = z.infer<typeof TaskSlaActionSchema>;
type FormValuesPut = z.infer<typeof FormValuesPutSchema>;
type DispatchRecommend = z.infer<typeof DispatchRecommendSchema>;
type DispatchAccept = z.infer<typeof DispatchAcceptSchema>;
type DispatchBatch = z.infer<typeof DispatchBatchSchema>;
type HandoffCreate = z.infer<typeof HandoffCreateSchema>;
type HandoffDecision = z.infer<typeof HandoffDecisionSchema>;
type DeliverableVersionCreate = z.infer<typeof DeliverableVersionCreateSchema>;
type DeliverableReview = z.infer<typeof DeliverableReviewSchema>;
type MeetingComplete = z.infer<typeof MeetingCompleteSchema>;
type MeetingActionConvert = z.infer<typeof MeetingActionConvertSchema>;
type TaskTreeBulk = z.infer<typeof TaskTreeBulkSchema>;
type TaskEstimate = z.infer<typeof TaskEstimateSchema>;
type DocumentCommentCreate = z.infer<typeof DocumentCommentCreateSchema>;
type DocumentCommentResolve = z.infer<typeof DocumentCommentResolveSchema>;
type DocumentDiff = z.infer<typeof DocumentDiffQuerySchema>;
type KnowledgeLinkCreate = z.infer<typeof KnowledgeLinkCreateSchema>;
type KnowledgeGraphQuery = z.infer<typeof KnowledgeGraphQuerySchema>;
type KnowledgeSearchQuery = z.infer<typeof KnowledgeSearchQuerySchema>;
type KnowledgeSynonymCreate = z.infer<typeof KnowledgeSynonymCreateSchema>;
type ChannelMessageCreate = z.infer<typeof ChannelMessageCreateSchema>;
type ChannelMessageUpdate = z.infer<typeof ChannelMessageUpdateSchema>;
type ChannelSearch = z.infer<typeof ChannelSearchQuerySchema>;
type PortalCreate = z.infer<typeof PortalCreateSchema>;
type PortalAccountCreate = z.infer<typeof PortalAccountCreateSchema>;
type PortalRequestCreate = z.infer<typeof PortalRequestCreateSchema>;
type PortalRequestUpdate = z.infer<typeof PortalRequestUpdateSchema>;
type PortalComment = z.infer<typeof PortalRequestCommentSchema>;
type PortalInternalComment = z.infer<typeof PortalInternalCommentSchema>;
type PortalDeliveryConfirm = z.infer<typeof PortalDeliveryConfirmSchema>;
type PlaybookFeedback = z.infer<typeof PlaybookFeedbackSchema>;
type WorkflowPublish = z.infer<typeof WorkflowPublishSchema>;
type WorkflowTest = z.infer<typeof WorkflowTestSchema>;
type WorkflowRollback = z.infer<typeof WorkflowRollbackSchema>;
type WorkflowReplay = z.infer<typeof WorkflowReplaySchema>;
type WorkflowRetryNode = z.infer<typeof WorkflowRetryNodeSchema>;
type WorkflowRunStart = z.infer<typeof WorkflowRunStartSchema>;
type ApprovalCreate = z.infer<typeof ApprovalCreateSchema>;
type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
type ApprovalWithdraw = z.infer<typeof ApprovalWithdrawSchema>;
type ApprovalMetricsQuery = z.infer<typeof ApprovalMetricsQuerySchema>;
type TriggerFire = z.infer<typeof TriggerFireSchema>;
type ConnectorRotate = z.infer<typeof ConnectorRotateSchema>;
type ConnectorOAuthStart = z.infer<typeof ConnectorOAuthStartSchema>;
type ConnectorOAuthCallback = z.infer<typeof ConnectorOAuthCallbackSchema>;
type ConnectorCall = z.infer<typeof ConnectorCallSchema>;
type EventPublish = z.infer<typeof EventPublishSchema>;
type EventSubscriptionCreate = z.infer<typeof EventSubscriptionCreateSchema>;
type SandboxRun = z.infer<typeof SandboxRunSchema>;
type BackgroundJobCreate = z.infer<typeof BackgroundJobCreateSchema>;
type BackgroundJobTick = z.infer<typeof BackgroundJobTickSchema>;
type AnomalyDetect = z.infer<typeof AnomalyDetectSchema>;
type AnomalyDismiss = z.infer<typeof AnomalyDismissSchema>;
type QualityScan = z.infer<typeof QualityScanSchema>;
type QualityFix = z.infer<typeof QualityFixSchema>;
type QualityBatchFix = z.infer<typeof QualityBatchFixSchema>;
type FunnelQuery = z.infer<typeof FunnelQuerySchema>;
type QueryPreview = z.infer<typeof QueryPreviewSchema>;
type LineageCreate = z.infer<typeof LineageCreateSchema>;
type BudgetCategoryCreate = z.infer<typeof BudgetCategoryCreateSchema>;
type BudgetCategoryUpdate = z.infer<typeof BudgetCategoryUpdateSchema>;
type OrganizationCreate = z.infer<typeof OrganizationCreateSchema>;
type DepartmentCreate = z.infer<typeof DepartmentCreateSchema>;
type OrgMembershipCreate = z.infer<typeof OrgMembershipCreateSchema>;
type WorkspaceMemberCreate = z.infer<typeof WorkspaceMemberCreateSchema>;
type WorkspaceSwitch = z.infer<typeof WorkspaceSwitchSchema>;
type PermissionSampleRun = z.infer<typeof PermissionSampleRunSchema>;
type JitUsage = z.infer<typeof JitUsageSchema>;
type JitPostReview = z.infer<typeof JitPostReviewSchema>;
type ReportSubscriptionCreate = z.infer<typeof ReportSubscriptionCreateSchema>;

export function actionOk<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

export function actionFail<T>(
  status: 400 | 403 | 404 | 409 | 500,
  message: string,
  current?: unknown,
): ActionResult<T> {
  return { ok: false, status, message, current };
}

class TransactionFailure extends Error {
  readonly status: 400 | 403 | 404 | 409 | 500;

  constructor(status: 400 | 403 | 404 | 409 | 500, message: string) {
    super(message);
    this.status = status;
  }
}

function text(row: Row, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : '';
}

function number(row: Row | null, key: string): number {
  return Number(row?.[key] ?? 0);
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function jsonArray(raw: unknown): unknown[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function jsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(day: string, days: number): string {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

function evaluateArithmetic(expression: string, values: Row): number | null {
  const tokens = expression.match(/[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[()+\-*/]/g);
  if (!tokens || tokens.join('') !== expression.replace(/\s+/g, '')) return null;
  let index = 0;
  const peek = (): string | undefined => tokens[index];
  const fail = (): never => {
    throw new Error('invalid_expression');
  };
  const primary = (): number => {
    const token = peek();
    if (token === undefined) throw new Error('invalid_expression');
    if (token === '(') {
      index++;
      const value = expr();
      if (peek() !== ')') fail();
      index++;
      return value;
    }
    if (token === '-') {
      index++;
      return -unary();
    }
    if (token === '+') {
      index++;
      return unary();
    }
    if (/^\d/.test(token)) {
      index++;
      return Number(token);
    }
    if (/^[A-Za-z_]/.test(token)) {
      index++;
      const raw = values[token];
      const value =
        typeof raw === 'boolean'
          ? raw
            ? 1
            : 0
          : raw === null || raw === undefined
            ? Number.NaN
            : Number(raw);
      return Number.isFinite(value) ? value : Number.NaN;
    }
    return fail();
  };
  const unary = (): number => primary();
  const term = (): number => {
    let left = unary();
    while (peek() === '*' || peek() === '/') {
      const op = tokens[index++];
      const right = unary();
      left = op === '*' ? left * right : right === 0 ? Number.NaN : left / right;
    }
    return left;
  };
  const expr = (): number => {
    let left = term();
    while (peek() === '+' || peek() === '-') {
      const op = tokens[index++];
      const right = term();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  };
  try {
    const value = expr();
    if (index !== tokens.length || !Number.isFinite(value)) return null;
    return Math.round(value * 1_000_000) / 1_000_000;
  } catch {
    return null;
  }
}

type DiffLine = {
  type: 'same' | 'added' | 'removed';
  oldLine: number | null;
  newLine: number | null;
  text: string;
};

function diffLines(before: string, after: string, limit = 1200) {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  const truncated = oldLines.length > limit || newLines.length > limit;
  const oldPart = oldLines.slice(0, limit);
  const newPart = newLines.slice(0, limit);
  const rows = oldPart.length;
  const cols = newPart.length;
  const width = cols + 1;
  const table = new Uint32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        oldPart[i] === newPart[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (oldPart[i] === newPart[j]) {
      lines.push({ type: 'same', oldLine: i + 1, newLine: j + 1, text: oldPart[i] });
      unchanged += 1;
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      lines.push({ type: 'removed', oldLine: i + 1, newLine: null, text: oldPart[i] });
      removed += 1;
      i += 1;
    } else {
      lines.push({ type: 'added', oldLine: null, newLine: j + 1, text: newPart[j] });
      added += 1;
      j += 1;
    }
  }
  while (i < rows) {
    lines.push({ type: 'removed', oldLine: i + 1, newLine: null, text: oldPart[i] });
    removed += 1;
    i += 1;
  }
  while (j < cols) {
    lines.push({ type: 'added', oldLine: null, newLine: j + 1, text: newPart[j] });
    added += 1;
    j += 1;
  }
  return { lines, stats: { added, removed, unchanged }, truncated };
}

export class DomainActions {
  readonly #store: Store;

  constructor(store: Store) {
    this.#store = store;
  }

  get #db() {
    return this.#store.db;
  }

  #now(): string {
    return this.#store.now().toISOString();
  }

  #workspace(user: SessionUser): string {
    return user.workspaceId ?? 'ws_default';
  }

  #manageWorkspace(user: SessionUser): boolean {
    return canManageWorkspace(user.role, user.permissions);
  }

  #project(projectId: string, user: SessionUser) {
    const project = this.#store.projects.get(projectId, user.role, user.id);
    if (!project || project.workspaceId !== this.#workspace(user)) return null;
    return project;
  }

  #manage(project: { ownerId: string }, user: SessionUser): boolean {
    return canManageProject(user.role, project.ownerId === user.id, user.permissions);
  }

  #audit(user: SessionUser, action: string, target: string, detail: unknown): void {
    this.#store.domain.audit(user.id, action, target, detail);
  }

  #notify(userId: string | null, type: string, title: string, body = ''): void {
    if (userId) this.#store.domain.notify(userId, type, title, body);
  }

  #publish(type: string, payload: Record<string, unknown>, user: SessionUser): void {
    this.#store.domain.publishEvent(this.#workspace(user), type, payload, user.id);
  }

  #row(sql: string, params: (string | number | null)[] = []): Row | null {
    return (this.#db.stmt(sql).get(...params) as unknown as Row | undefined) ?? null;
  }

  #rows(sql: string, params: (string | number | null)[] = []): Row[] {
    return this.#db.stmt(sql).all(...params) as unknown as Row[];
  }

  #event(
    table: 'stage_gate_events' | 'task_blocker_events' | 'workflow_run_events',
    values: Record<string, unknown>,
  ): void {
    const keys = Object.keys(values);
    this.#db
      .stmt(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
      .run(...(Object.values(values) as (string | number | null)[]));
  }

  // -------------------------------------------------------------------------
  // Stage gates
  // -------------------------------------------------------------------------

  decideGate(user: SessionUser, gateId: string, input: GateDecision): ActionResult<Row> {
    const gate = this.#row('SELECT * FROM stage_gates WHERE id = ?', [gateId]);
    if (!gate) return actionFail(404, '阶段门不存在');
    const project = this.#project(text(gate, 'project_id'), user);
    if (!project) return actionFail(404, '阶段门不存在');
    const approvers = jsonArray(gate.approver_ids_json).map(String);
    const delegated =
      approvers.includes(user.id) ||
      this.#row(
        `SELECT 1 AS hit FROM delegations
         WHERE delegate_id = ? AND active = 1 AND starts_at <= ? AND ends_at >= ?
           AND (scope = '' OR scope = ?) LIMIT 1`,
        [user.id, this.#now(), this.#now(), 'stage_gate'],
      ) !== null;
    const manager = this.#manage(project, user);
    if (!manager && !(approvers.includes(user.id) || delegated)) {
      return actionFail(403, '没有审批该阶段门的权限');
    }
    if (number(gate, 'version') !== input.version) {
      return actionFail(409, '阶段门已被其他会话修改', gate);
    }
    const status = text(gate, 'status');
    if (status !== 'pending' && input.action !== 'escalate') {
      return actionFail(409, '阶段门已完成决策');
    }
    if (input.action === 'withdraw' && !manager && text(gate, 'created_by') !== user.id) {
      return actionFail(403, '只有申请人或项目管理员可以撤回');
    }
    if (input.action === 'waive' && !manager) {
      return actionFail(403, '只有项目管理员可以豁免阶段门');
    }
    let next = status;
    if (input.action === 'approve') next = 'approved';
    if (input.action === 'reject') next = 'rejected';
    if (input.action === 'waive') next = 'waived';
    if (input.action === 'escalate') {
      this.#notify(
        text(gate, 'created_by') || project.ownerId,
        'stage_gate',
        '阶段门已升级',
        gateId,
      );
      this.#audit(user, 'stage_gate.escalate', gateId, { note: input.note ?? '', req: 'action' });
      return actionOk(gate);
    }
    const now = this.#now();
    const updated = this.#row(
      `UPDATE stage_gates SET status = ?, decision_note = ?, decided_by = ?, decided_at = ?,
         version = version + 1, updated_at = ? WHERE id = ? AND version = ? RETURNING *`,
      [next, input.note ?? '', user.id, now, now, gateId, input.version],
    );
    if (!updated) return actionFail(409, '阶段门已被其他会话修改');
    this.#event('stage_gate_events', {
      id: randomUUID(),
      gate_id: gateId,
      actor_id: user.id,
      action: input.action,
      note: input.note ?? '',
      before_json: JSON.stringify({ status, version: input.version }),
      after_json: JSON.stringify({ status: next, version: number(updated, 'version') }),
      created_at: now,
    });
    this.#audit(user, 'stage_gate.decide', gateId, {
      action: input.action,
      before: gate,
      after: updated,
      reason: input.note ?? '',
    });
    this.#publish('stage_gate.decided', { gateId, action: input.action, status: next }, user);
    if (next === 'approved' && !manager) {
      this.#notify(text(gate, 'created_by'), 'stage_gate', '阶段门已通过', gateId);
    }
    return actionOk(updated);
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  #healthSetting(projectId: string): {
    thresholds: Record<string, number>;
    weights: Record<string, number>;
  } {
    const defaults = {
      thresholds: {
        progress: 60,
        overdueRate: 0.2,
        blockers: 3,
        budgetUsage: 1,
        criticalPath: 3,
        defectTrend: 0.5,
        workload: 1,
      },
      weights: {
        progress: 0.25,
        overdueRate: 0.35,
        blockers: 2,
        budgetUsage: 0.15,
        criticalPath: 1.5,
        defectTrend: 2,
        workload: 10,
      },
    };
    const stored = this.#row(
      `SELECT value FROM app_settings WHERE key IN (?, ?) ORDER BY key = ? DESC LIMIT 1`,
      [
        `health:config:${projectId}`,
        `health:config:${this.#workspaceOfProject(projectId)}`,
        `health:config:${projectId}`,
      ],
    );
    const parsed = stored ? jsonObject(stored.value) : {};
    const numberRecord = (raw: unknown): Record<string, number> =>
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? Object.fromEntries(
            Object.entries(raw as Record<string, unknown>)
              .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
              .map(([key, value]) => [key, value as number]),
          )
        : {};
    const thresholds = { ...defaults.thresholds, ...numberRecord(parsed.thresholds) };
    const weights = { ...defaults.weights, ...numberRecord(parsed.weights) };
    return { thresholds, weights };
  }

  #workspaceOfProject(projectId: string): string {
    return text(
      this.#row('SELECT workspace_id FROM projects WHERE id = ?', [projectId]) ?? {},
      'workspace_id',
    );
  }

  healthConfig(user: SessionUser, projectId: string): ActionResult<Row> {
    const project = this.#project(projectId, user);
    if (!project) return actionFail(404, '项目不存在');
    const stored = this.#row('SELECT value FROM app_settings WHERE key = ?', [
      `health:config:${projectId}`,
    ]);
    return actionOk({
      projectId,
      ...this.#healthSetting(projectId),
      source: stored ? 'project' : 'default',
    });
  }

  updateHealthConfig(user: SessionUser, projectId: string, input: HealthConfig): ActionResult<Row> {
    const project = this.#project(projectId, user);
    if (!project) return actionFail(404, '项目不存在');
    if (!this.#manage(project, user)) return actionFail(403, '没有配置健康度阈值的权限');
    const current = this.#healthSetting(projectId);
    const next = {
      thresholds: { ...current.thresholds, ...(input.thresholds ?? {}) },
      weights: { ...current.weights, ...(input.weights ?? {}) },
    };
    this.#db
      .stmt(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(`health:config:${projectId}`, JSON.stringify(next), this.#now());
    this.#audit(user, 'project.health.config', projectId, { before: current, after: next });
    return actionOk({ projectId, ...next, source: 'project' });
  }

  computeHealth(user: SessionUser, projectId: string): ActionResult<Row> {
    const project = this.#project(projectId, user);
    if (!project) return actionFail(404, '项目不存在');
    if (!this.#manage(project, user)) return actionFail(403, '没有计算健康度的权限');
    const now = this.#now();
    const day = today();
    const config = this.#healthSetting(projectId);
    const tasks = this.#rows(
      `SELECT status, due_date, assignee_id FROM project_tasks WHERE project_id = ?`,
      [projectId],
    );
    const openBlockers = this.#row(
      `SELECT COUNT(*) AS count FROM task_blockers b
       JOIN project_tasks t ON t.id = b.task_id
       WHERE t.project_id = ? AND b.status = 'open'`,
      [projectId],
    );
    const budget = this.#row('SELECT * FROM project_budgets WHERE project_id = ?', [projectId]);
    const done = tasks.filter((task) => text(task, 'status') === 'done').length;
    const overdue = tasks.filter(
      (task) =>
        text(task, 'status') !== 'done' &&
        text(task, 'due_date') !== '' &&
        text(task, 'due_date') < day,
    ).length;
    const progress = tasks.length ? done / tasks.length : 0;

    let criticalPath: {
      nodes: { critical: boolean; title: string; taskId: string }[];
      estimatedCompletion: string | null;
    } | null = null;
    try {
      criticalPath = this.#store.planning.criticalPath(projectId, this.#workspace(user));
    } catch {
      criticalPath = null;
    }
    const criticalOpen = (criticalPath?.nodes ?? []).filter((node) => node.critical).length;
    const blockerTrend = this.#row(
      `SELECT
         SUM(CASE WHEN b.created_at >= ? THEN 1 ELSE 0 END) AS recent,
         SUM(CASE WHEN b.created_at >= ? AND b.created_at < ? THEN 1 ELSE 0 END) AS previous
       FROM task_blockers b JOIN project_tasks t ON t.id = b.task_id
       WHERE t.project_id = ?`,
      [addDays(day, -14), addDays(day, -28), addDays(day, -14), projectId],
    );
    const recentBlockers = number(blockerTrend ?? {}, 'recent');
    const previousBlockers = number(blockerTrend ?? {}, 'previous');
    const defectTrend =
      previousBlockers === 0
        ? recentBlockers
        : Math.round(((recentBlockers - previousBlockers) / previousBlockers) * 100) / 100;
    const weekEnd = addDays(day, 6);
    const capacity = this.#rows(
      `SELECT a.user_id, a.kind, a.weekly_hours, p.weekly_hours AS profile_hours, p.fte
       FROM capacity_allocations a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN capacity_profiles p ON p.user_id = u.id
       WHERE u.workspace_id = ? AND u.status = 'active'
         AND a.start_date <= ? AND a.end_date >= ?`,
      [this.#workspace(user), weekEnd, day],
    );
    const supplyByUser = new Map<string, number>();
    const loadByUser = new Map<string, number>();
    for (const row of capacity) {
      const userId = text(row, 'user_id');
      const supply = (number(row, 'profile_hours') || 40) * (number(row, 'fte') || 1);
      supplyByUser.set(userId, supply);
      if (text(row, 'kind') === 'allocation') {
        loadByUser.set(userId, (loadByUser.get(userId) ?? 0) + number(row, 'weekly_hours'));
      }
    }
    let workload = 0;
    for (const [userId, supply] of supplyByUser) {
      if (supply <= 0) continue;
      workload = Math.max(workload, (loadByUser.get(userId) ?? 0) / supply);
    }
    workload = Math.round(workload * 100) / 100;

    const factors: Record<string, number> = {
      progress: Math.round(progress * 100),
      overdueRate: tasks.length ? Math.round((overdue / tasks.length) * 100) : 0,
      blockers: Number(openBlockers?.count ?? 0),
      budgetUsage: budget
        ? Math.round(
            (number(budget, 'actual_cents') / Math.max(number(budget, 'budget_cents'), 1)) * 100,
          )
        : 0,
      criticalPath: criticalOpen,
      defectTrend,
      workload,
    };
    const missing: string[] = [];
    if (!project.dueDate) missing.push('dueDate');
    if (tasks.length === 0) missing.push('tasks');
    if (!budget) missing.push('budget');
    if (!criticalPath || criticalPath.nodes.length === 0) missing.push('criticalPath');
    if (supplyByUser.size === 0) missing.push('capacity');

    const thresholds = {
      progress: config.thresholds.progress,
      overdueRate: config.thresholds.overdueRate * 100,
      blockers: config.thresholds.blockers,
      budgetUsage: config.thresholds.budgetUsage * 100,
      criticalPath: config.thresholds.criticalPath,
      defectTrend: config.thresholds.defectTrend,
      workload: config.thresholds.workload,
    };
    const higherIsWorse: Record<string, boolean> = {
      progress: false,
      overdueRate: true,
      blockers: true,
      budgetUsage: true,
      criticalPath: true,
      defectTrend: true,
      workload: true,
    };
    const explanations = Object.entries(factors).map(([key, value]) => {
      const threshold = thresholds[key as keyof typeof thresholds] ?? 0;
      const worse = higherIsWorse[key] ?? true;
      const ratio = worse
        ? threshold > 0
          ? value / threshold
          : value > 0
            ? 2
            : 0
        : threshold > 0
          ? value / threshold
          : 1;
      const status = worse
        ? ratio > 1.5
          ? 'critical'
          : ratio > 1
            ? 'warn'
            : 'ok'
        : ratio < 0.6
          ? 'critical'
          : ratio < 1
            ? 'warn'
            : 'ok';
      return {
        key,
        value,
        threshold,
        direction: worse ? 'higher_is_worse' : 'lower_is_worse',
        status,
      };
    });
    const weights = config.weights;
    const score = clamp(
      Math.round(
        70 +
          factors.progress * weights.progress -
          factors.overdueRate * weights.overdueRate -
          Math.min(factors.blockers, 10) * weights.blockers -
          Math.max(0, factors.budgetUsage - 100) * weights.budgetUsage -
          Math.min(factors.criticalPath, 10) * weights.criticalPath -
          Math.max(0, factors.defectTrend) * weights.defectTrend -
          Math.max(0, factors.workload - 1) * weights.workload,
      ),
      0,
      100,
    );
    const confidence = clamp(
      Math.round(
        (100 - missing.length * 15 - (tasks.length < 3 ? 20 : 0) - (criticalPath ? 0 : 10)) * 10,
      ) / 100,
      0.2,
      1,
    );
    const snapshotFactors = {
      ...factors,
      thresholds,
      weights,
      explanations,
      predictionSource: 'heuristic',
      criticalPathNodes: criticalPath?.nodes.filter((node) => node.critical).length ?? 0,
    };
    const predictedCompletion = project.dueDate ?? criticalPath?.estimatedCompletion ?? null;
    const id = randomUUID();
    this.#db
      .stmt(
        `INSERT INTO project_health_snapshots
           (id, project_id, score, confidence, factors_json, missing_json,
            predicted_completion, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        projectId,
        score,
        confidence,
        JSON.stringify(snapshotFactors),
        JSON.stringify(missing),
        predictedCompletion,
        user.id,
        now,
      );
    const snapshot = this.#row('SELECT * FROM project_health_snapshots WHERE id = ?', [id]);
    this.#audit(user, 'project.health.compute', projectId, { snapshot });
    return actionOk(snapshot ?? {});
  }

  latestHealth(user: SessionUser, projectId: string): ActionResult<Row> {
    const project = this.#project(projectId, user);
    if (!project) return actionFail(404, '项目不存在');
    const row = this.#row(
      `SELECT * FROM project_health_snapshots WHERE project_id = ?
       ORDER BY created_at DESC LIMIT 1`,
      [projectId],
    );
    if (!row) return actionFail(404, '暂无健康度快照');
    return actionOk(row);
  }

  healthTrend(user: SessionUser, projectId: string, limit = 20): ActionResult<Row> {
    const project = this.#project(projectId, user);
    if (!project) return actionFail(404, '项目不存在');
    const cap = Math.min(Math.max(limit, 1), 100);
    const rows = this.#rows(
      `SELECT * FROM project_health_snapshots WHERE project_id = ?
       ORDER BY created_at DESC LIMIT ?`,
      [projectId, cap],
    );
    const snapshots = [...rows].reverse().map((row) => ({
      ...row,
      factors: jsonObject(row.factors_json),
      missing: jsonArray(row.missing_json).map(String),
      predictionSource: 'heuristic',
    }));
    const first = snapshots[0];
    const last = snapshots.at(-1);
    const delta =
      first && last ? Math.round((number(last, 'score') - number(first, 'score')) * 10) / 10 : 0;
    return actionOk({
      projectId,
      snapshots,
      trend: delta > 2 ? 'improving' : delta < -2 ? 'declining' : 'stable',
      delta,
    });
  }

  // -------------------------------------------------------------------------
  // Baselines
  // -------------------------------------------------------------------------

  createBaseline(user: SessionUser, projectId: string, input: BaselineCreate): ActionResult<Row> {
    const project = this.#project(projectId, user);
    if (!project) return actionFail(404, '项目不存在');
    if (!this.#manage(project, user)) return actionFail(403, '没有创建基线的权限');
    const versionRow = this.#row(
      'SELECT COALESCE(MAX(version_no), 0) AS version FROM project_baselines WHERE project_id = ?',
      [projectId],
    );
    const versionNo = number(versionRow ?? {}, 'version') + 1;
    const tasks = this.#rows(
      `SELECT id, title, status, assignee_id, due_date, estimate_points, estimate_hours
       FROM project_tasks WHERE project_id = ? ORDER BY sort_order`,
      [projectId],
    );
    const milestones = this.#rows(
      'SELECT id, title, due_date FROM project_milestones WHERE project_id = ?',
      [projectId],
    );
    const budget = this.#row('SELECT * FROM project_budgets WHERE project_id = ?', [projectId]);
    const snapshot = { project: { id: project.id, name: project.name }, tasks, milestones, budget };
    const id = randomUUID();
    const now = this.#now();
    this.#db
      .stmt(
        `INSERT INTO project_baselines
           (id, project_id, version_no, label, reason, snapshot_json, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        id,
        projectId,
        versionNo,
        input.label ?? '',
        input.reason,
        JSON.stringify(snapshot),
        user.id,
        now,
      );
    const row = this.#row('SELECT * FROM project_baselines WHERE id = ?', [id]);
    this.#audit(user, 'project.baseline.create', id, { reason: input.reason, snapshot });
    return actionOk(row ?? {});
  }

  decideBaseline(
    user: SessionUser,
    baselineId: string,
    input: BaselineDecision,
  ): ActionResult<Row> {
    const baseline = this.#row('SELECT * FROM project_baselines WHERE id = ?', [baselineId]);
    if (!baseline) return actionFail(404, '基线不存在');
    const project = this.#project(text(baseline, 'project_id'), user);
    if (!project) return actionFail(404, '基线不存在');
    if (!this.#manage(project, user)) return actionFail(403, '没有审批基线的权限');
    if (text(baseline, 'status') !== 'pending') return actionFail(409, '基线已完成审批');
    const now = this.#now();
    if (input.action === 'approve') {
      this.#db
        .stmt(
          `UPDATE project_baselines SET status = 'superseded'
           WHERE project_id = ? AND status = 'active'`,
        )
        .run(text(baseline, 'project_id'));
    }
    const updated = this.#row(
      `UPDATE project_baselines SET status = ?, approved_by = ?, approved_at = ?
       WHERE id = ? RETURNING *`,
      [input.action === 'approve' ? 'active' : 'rejected', user.id, now, baselineId],
    );
    this.#audit(user, 'project.baseline.decide', baselineId, {
      action: input.action,
      note: input.note,
      before: baseline,
      after: updated,
    });
    return actionOk(updated ?? {});
  }

  baselineVariance(user: SessionUser, baselineId: string): ActionResult<Row> {
    const baseline = this.#row('SELECT * FROM project_baselines WHERE id = ?', [baselineId]);
    if (!baseline) return actionFail(404, '基线不存在');
    const project = this.#project(text(baseline, 'project_id'), user);
    if (!project) return actionFail(404, '基线不存在');
    const snapshot = jsonObject(baseline.snapshot_json);
    const before = Array.isArray(snapshot.tasks) ? (snapshot.tasks as Row[]) : [];
    const current = this.#rows(
      `SELECT id, title, status, assignee_id, due_date, estimate_points, estimate_hours
       FROM project_tasks WHERE project_id = ? ORDER BY sort_order`,
      [project.id],
    );
    const currentMap = new Map(current.map((task) => [text(task, 'id'), task]));
    const beforeMap = new Map(before.map((task) => [text(task, 'id'), task]));
    const added = current.filter((task) => !beforeMap.has(text(task, 'id')));
    const removed = before.filter((task) => !currentMap.has(text(task, 'id')));
    const changed = current
      .filter((task) => {
        const old = beforeMap.get(text(task, 'id'));
        if (!old) return false;
        return (
          text(old, 'status') !== text(task, 'status') ||
          text(old, 'due_date') !== text(task, 'due_date') ||
          text(old, 'title') !== text(task, 'title')
        );
      })
      .map((task) => ({
        id: text(task, 'id'),
        before: beforeMap.get(text(task, 'id')),
        after: task,
      }));
    return actionOk({
      baselineId,
      versionNo: number(baseline, 'version_no'),
      added,
      removed,
      changed,
      unchanged: current.length - added.length - changed.length,
    });
  }

  // -------------------------------------------------------------------------
  // Change requests
  // -------------------------------------------------------------------------

  decideChange(user: SessionUser, changeId: string, input: ChangeDecision): ActionResult<Row> {
    const change = this.#row('SELECT * FROM change_requests WHERE id = ?', [changeId]);
    if (!change) return actionFail(404, '变更请求不存在');
    const project = this.#project(text(change, 'project_id'), user);
    if (!project) return actionFail(404, '变更请求不存在');
    if (!this.#manage(project, user)) return actionFail(403, '没有审批变更请求的权限');
    if (number(change, 'version') !== input.version) {
      return actionFail(409, '变更请求已被其他会话修改', change);
    }
    const status = text(change, 'status');
    if (input.action === 'implement' && status !== 'approved') {
      return actionFail(409, '只有已批准的变更可以实施');
    }
    if (input.action !== 'implement' && status !== 'draft' && status !== 'submitted') {
      return actionFail(409, '变更请求已完成审批');
    }
    const next =
      input.action === 'approve'
        ? 'approved'
        : input.action === 'reject'
          ? 'rejected'
          : 'implemented';
    const now = this.#now();
    const updated = this.#row(
      `UPDATE change_requests SET status = ?, decision_note = ?, decided_by = ?, decided_at = ?,
         version = version + 1, updated_at = ? WHERE id = ? AND version = ? RETURNING *`,
      [next, input.note ?? '', user.id, now, now, changeId, input.version],
    );
    if (!updated) return actionFail(409, '变更请求已被其他会话修改');
    this.#audit(user, 'change_request.decide', changeId, {
      action: input.action,
      note: input.note,
      before: change,
      after: updated,
    });
    this.#notify(text(change, 'requested_by'), 'change_request', `变更请求已${next}`, changeId);
    this.#publish('change_request.decided', { changeId, status: next }, user);
    return actionOk(updated);
  }

  commentChangeRequest(
    user: SessionUser,
    changeId: string,
    input: ChangeComment,
  ): ActionResult<Row> {
    const change = this.#row('SELECT * FROM change_requests WHERE id = ?', [changeId]);
    if (!change) return actionFail(404, '变更请求不存在');
    const project = this.#project(text(change, 'project_id'), user);
    if (!project) return actionFail(404, '变更请求不存在');
    const id = randomUUID();
    const now = this.#now();
    this.#db
      .stmt(
        `INSERT INTO change_request_comments (id, change_id, author_id, body, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, changeId, user.id, input.body, now);
    this.#notify(
      text(change, 'requested_by'),
      'change_request',
      '变更请求有新讨论',
      input.body.slice(0, 120),
    );
    this.#audit(user, 'change_request.comment', changeId, {});
    return actionOk(this.#row('SELECT * FROM change_request_comments WHERE id = ?', [id]) ?? {});
  }

  changeRequestComments(user: SessionUser, changeId: string): ActionResult<Row[]> {
    const change = this.#row('SELECT * FROM change_requests WHERE id = ?', [changeId]);
    if (!change) return actionFail(404, '变更请求不存在');
    const project = this.#project(text(change, 'project_id'), user);
    if (!project) return actionFail(404, '变更请求不存在');
    return actionOk(
      this.#rows(
        `SELECT c.*, u.name AS author_name FROM change_request_comments c
         LEFT JOIN users u ON u.id = c.author_id
         WHERE c.change_id = ? ORDER BY c.created_at ASC`,
        [changeId],
      ),
    );
  }

  implementChangeRequest(
    user: SessionUser,
    changeId: string,
    input: ChangeImplement,
  ): ActionResult<Row> {
    const change = this.#row('SELECT * FROM change_requests WHERE id = ?', [changeId]);
    if (!change) return actionFail(404, '变更请求不存在');
    const project = this.#project(text(change, 'project_id'), user);
    if (!project) return actionFail(404, '变更请求不存在');
    if (!this.#manage(project, user)) return actionFail(403, '没有实施变更请求的权限');
    if (number(change, 'version') !== input.version) {
      return actionFail(409, '变更请求已被其他会话修改', change);
    }
    if (text(change, 'status') !== 'approved') {
      return actionFail(409, '只有已批准的变更可以实施');
    }
    const titles: string[] = [];
    for (const title of input.taskTitles ?? []) {
      const trimmed = title.trim();
      if (trimmed && !titles.includes(trimmed)) titles.push(trimmed);
    }
    if (titles.length === 0) {
      const proposed = jsonObject(change.proposed_json);
      const proposedTasks = Array.isArray(proposed.tasks)
        ? proposed.tasks.map((item) => String(item).trim()).filter(Boolean)
        : [];
      titles.push(...proposedTasks.slice(0, 40));
    }
    if (titles.length === 0) titles.push(`实施变更：${text(change, 'title')}`);
    let taskIds: string[] = [];
    let updated: Row | null = null;
    try {
      const outcome = this.#db.transaction(() => {
        const ids: string[] = [];
        for (const title of titles) {
          const created = this.#store.tasks.create(
            project.id,
            {
              title: title.slice(0, 200),
              description: `变更实施：${text(change, 'title')}`,
            } as never,
            { id: user.id, name: user.name },
          );
          if (created.status !== 'ok') throw new TransactionFailure(400, created.message);
          ids.push(created.task.id);
        }
        const now = this.#now();
        const row = this.#row(
          `UPDATE change_requests SET status = 'implemented', decision_note = ?, decided_by = ?,
             decided_at = ?, task_ids_json = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND version = ? RETURNING *`,
          [input.note ?? '', user.id, now, JSON.stringify(ids), now, changeId, input.version],
        );
        if (!row) throw new TransactionFailure(409, '变更请求已被其他会话修改');
        return { ids, row };
      });
      taskIds = outcome.ids;
      updated = outcome.row;
    } catch (error) {
      if (error instanceof TransactionFailure) return actionFail(error.status, error.message);
      throw error;
    }
    this.#notify(
      text(change, 'requested_by'),
      'change_request',
      '变更请求已实施',
      `已创建 ${taskIds.length} 个实施任务`,
    );
    this.#audit(user, 'change_request.implement', changeId, {
      note: input.note,
      taskIds,
      before: change,
      after: updated,
    });
    this.#publish('change_request.implemented', { changeId, taskIds }, user);
    return actionOk({ ...updated, taskIds });
  }

  // -------------------------------------------------------------------------
  // Capacity
  // -------------------------------------------------------------------------

  updateCapacityProfile(
    user: SessionUser,
    userId: string,
    input: CapacityProfileUpdate,
  ): ActionResult<Row> {
    if (userId !== user.id && !this.#manageWorkspace(user)) {
      return actionFail(403, '只能维护自己的容量档案');
    }
    const target = this.#row('SELECT id FROM users WHERE id = ?', [userId]);
    if (!target) return actionFail(404, '成员不存在');
    const now = this.#now();
    this.#db
      .stmt(
        `INSERT INTO capacity_profiles (user_id, weekly_hours, fte, skills_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           weekly_hours = excluded.weekly_hours,
           fte = excluded.fte,
           skills_json = excluded.skills_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        userId,
        input.weeklyHours ?? 40,
        input.fte ?? 1,
        JSON.stringify(input.skills ?? []),
        now,
      );
    const row = this.#row('SELECT * FROM capacity_profiles WHERE user_id = ?', [userId]);
    this.#audit(user, 'capacity.profile.update', userId, { after: row });
    return actionOk(row ?? {});
  }

  capacity(user: SessionUser, from: string, to: string): ActionResult<CapacityRow[]> {
    if (!this.#manageWorkspace(user)) return actionFail(403, '只有管理员可以查看容量');
    const workspace = this.#workspace(user);
    const users = this.#rows(
      `SELECT u.id, u.name, u.role,
              p.weekly_hours, p.fte, p.skills_json
       FROM users u
       LEFT JOIN capacity_profiles p ON p.user_id = u.id
       WHERE u.workspace_id = ? AND u.status = 'active'
       ORDER BY u.name`,
      [workspace],
    );
    const allocations = this.#rows(
      `SELECT * FROM capacity_allocations
       WHERE workspace_id = ? AND start_date <= ? AND end_date >= ?`,
      [workspace, to, from],
    );
    const rows = users.map((member) => {
      const id = text(member, 'id');
      const mine = allocations.filter((item) => text(item, 'user_id') === id);
      const allocated = mine
        .filter((item) => text(item, 'kind') === 'allocation')
        .reduce((sum, item) => sum + number(item, 'weekly_hours'), 0);
      const leave = mine
        .filter((item) => text(item, 'kind') === 'leave')
        .reduce((sum, item) => sum + number(item, 'weekly_hours'), 0);
      const weekly = number(member, 'weekly_hours') || 40;
      const fte = number(member, 'fte') || 1;
      const supply = weekly * fte;
      return {
        userId: id,
        userName: text(member, 'name'),
        role: text(member, 'role'),
        skills: jsonArray(member.skills_json).map(String),
        weeklyHours: weekly,
        fte,
        supplyHours: supply,
        allocatedHours: allocated,
        leaveHours: leave,
        gapHours: Math.round((supply - allocated - leave) * 100) / 100,
        overloaded: allocated + leave > supply,
      };
    });
    return actionOk(rows);
  }

  capacityScenario(user: SessionUser, input: CapacityScenario): ActionResult<Row> {
    if (!this.#manageWorkspace(user)) return actionFail(403, '只有管理员可以模拟容量');
    const from = input.from ?? today();
    const to = input.to ?? addDays(from, 30);
    const result = this.capacity(user, from, to);
    if (!result.ok) return result;
    const adjustments = new Map(input.adjustments.map((item) => [item.userId, item.weeklyHours]));
    const items = result.data.map((row) => {
      const weekly = adjustments.get(row.userId) ?? row.weeklyHours;
      const supply = weekly * row.fte;
      return {
        ...row,
        proposedWeeklyHours: weekly,
        proposedSupplyHours: supply,
        proposedGapHours: Math.round((supply - row.allocatedHours - row.leaveHours) * 100) / 100,
        deltaHours: Math.round((supply - row.supplyHours) * 100) / 100,
      };
    });
    return actionOk({ from, to, items });
  }

  capacityPlan(user: SessionUser, input: CapacityPlan): ActionResult<Row> {
    const manager = this.#manageWorkspace(user);
    if (input.userId && input.userId !== user.id && !manager) {
      return actionFail(403, '没有查看他人负载的权限');
    }
    const from = input.from ?? today();
    const to = input.to ?? addDays(from, 59);
    if (from > to) return actionFail(400, '开始日期不能晚于结束日期');
    const spanDays = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
    if (spanDays > 366) return actionFail(400, '容量规划区间不能超过一年');
    const bucket = input.bucket ?? 'week';
    const workspace = this.#workspace(user);
    const users = this.#rows(
      `SELECT u.id, u.name, u.role, p.weekly_hours, p.fte, p.skills_json
       FROM users u LEFT JOIN capacity_profiles p ON p.user_id = u.id
       WHERE u.workspace_id = ? AND u.status = 'active' ORDER BY u.name`,
      [workspace],
    ).filter((row) => {
      if (!manager && text(row, 'id') !== user.id) return false;
      if (input.userId && text(row, 'id') !== input.userId) return false;
      if (input.role && text(row, 'role') !== input.role) return false;
      if (input.skill) {
        const skills = jsonArray(row.skills_json).map(String);
        if (!skills.includes(input.skill)) return false;
      }
      return true;
    });
    const allocations = this.#rows(
      `SELECT a.*, p.name AS project_name FROM capacity_allocations a
       LEFT JOIN projects p ON p.id = a.project_id
       WHERE a.workspace_id = ? AND a.start_date <= ? AND a.end_date >= ?`,
      [workspace, to, from],
    );
    const bucketStart = (date: string): string => {
      if (bucket === 'month') return `${date.slice(0, 7)}-01`;
      const value = new Date(`${date}T00:00:00.000Z`);
      const day = (value.getUTCDay() + 6) % 7;
      value.setUTCDate(value.getUTCDate() - day);
      return value.toISOString().slice(0, 10);
    };
    const bucketEnd = (start: string): string => {
      if (bucket === 'month') {
        const value = new Date(`${start}T00:00:00.000Z`);
        value.setUTCMonth(value.getUTCMonth() + 1);
        value.setUTCDate(0);
        return value.toISOString().slice(0, 10);
      }
      return addDays(start, 6);
    };
    const keys: string[] = [];
    let cursor = bucketStart(from);
    while (cursor <= to) {
      keys.push(cursor);
      cursor = bucket === 'month' ? addDays(bucketEnd(cursor), 1) : addDays(cursor, 7);
    }
    const overlapDays = (start: string, end: string, low: string, high: string): number => {
      const left = start > low ? start : low;
      const right = end < high ? end : high;
      if (left > right) return 0;
      return Math.round((Date.parse(right) - Date.parse(left)) / 86_400_000) + 1;
    };
    const conflicts: Row[] = [];
    const result = users.map((member) => {
      const userId = text(member, 'id');
      const weekly = number(member, 'weekly_hours') || 40;
      const fte = number(member, 'fte') || 1;
      const mine = allocations.filter((row) => text(row, 'user_id') === userId);
      const buckets = keys.map((start) => {
        const end = bucketEnd(start);
        const days = overlapDays(start, end, from, to);
        const supply = Math.round(weekly * fte * (days / 7) * 100) / 100;
        let allocated = 0;
        let leave = 0;
        const projects = new Map<
          string,
          { projectId: string; projectName: string; hours: number }
        >();
        for (const row of mine) {
          const overlap = overlapDays(text(row, 'start_date'), text(row, 'end_date'), start, end);
          if (overlap === 0) continue;
          const hours = number(row, 'weekly_hours') * (overlap / 7);
          if (text(row, 'kind') === 'leave') {
            leave += hours;
          } else {
            allocated += hours;
            const projectId = text(row, 'project_id');
            const entry = projects.get(projectId) ?? {
              projectId,
              projectName: text(row, 'project_name') || '未分配项目',
              hours: 0,
            };
            entry.hours += hours;
            projects.set(projectId, entry);
          }
        }
        allocated = Math.round(allocated * 100) / 100;
        leave = Math.round(leave * 100) / 100;
        const gap = Math.round((supply - allocated - leave) * 100) / 100;
        const overloaded = allocated + leave > supply + 0.01;
        if (overloaded) {
          conflicts.push({
            userId,
            userName: text(member, 'name'),
            bucket: start,
            bucketEnd: end,
            supplyHours: supply,
            allocatedHours: allocated,
            leaveHours: leave,
            overHours: Math.round((allocated + leave - supply) * 100) / 100,
            projects: [...projects.values()],
          });
        }
        return {
          bucket: start,
          bucketEnd: end,
          days,
          supplyHours: supply,
          allocatedHours: allocated,
          leaveHours: leave,
          gapHours: gap,
          overloaded,
          projects: [...projects.values()].map((project) => ({
            ...project,
            hours: Math.round(project.hours * 100) / 100,
          })),
        };
      });
      const sum = (field: 'supplyHours' | 'allocatedHours' | 'leaveHours'): number =>
        Math.round(buckets.reduce((total, row) => total + row[field], 0) * 100) / 100;
      return {
        userId,
        userName: text(member, 'name'),
        role: text(member, 'role'),
        skills: jsonArray(member.skills_json).map(String),
        weeklyHours: weekly,
        fte,
        buckets,
        totals: {
          supplyHours: sum('supplyHours'),
          allocatedHours: sum('allocatedHours'),
          leaveHours: sum('leaveHours'),
          gapHours: sum('supplyHours') - sum('allocatedHours') - sum('leaveHours'),
        },
      };
    });
    return actionOk({
      from,
      to,
      bucket,
      users: result,
      conflicts,
      totals: {
        members: result.length,
        supplyHours:
          Math.round(result.reduce((sum, row) => sum + row.totals.supplyHours, 0) * 100) / 100,
        allocatedHours:
          Math.round(result.reduce((sum, row) => sum + row.totals.allocatedHours, 0) * 100) / 100,
        leaveHours:
          Math.round(result.reduce((sum, row) => sum + row.totals.leaveHours, 0) * 100) / 100,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Closure and benefits
  // -------------------------------------------------------------------------

  closeProject(user: SessionUser, projectId: string, input: ClosureCreate): ActionResult<Row> {
    const project = this.#project(projectId, user);
    if (!project) return actionFail(404, '项目不存在');
    if (!this.#manage(project, user)) return actionFail(403, '没有结项权限');
    const existing = this.#row('SELECT * FROM project_closures WHERE project_id = ?', [projectId]);
    if (existing && text(existing, 'status') === 'closed') {
      return actionFail(409, '项目已结项');
    }
    const rejected = input.acceptance.filter((item) => !item.accepted);
    if (rejected.length > 0) {
      return actionFail(400, `仍有 ${rejected.length} 项验收未通过`);
    }
    const openTasks = this.#row(
      `SELECT COUNT(*) AS count FROM project_tasks WHERE project_id = ? AND status <> 'done'`,
      [projectId],
    );
    const openCount = number(openTasks ?? {}, 'count');
    const pendingDeliverables = number(
      this.#row(
        `SELECT COUNT(*) AS count FROM task_deliverables d
         JOIN project_tasks t ON t.id = d.task_id
         WHERE t.project_id = ? AND d.required = 1 AND d.status <> 'approved'`,
        [projectId],
      ),
      'count',
    );
    if (pendingDeliverables > 0) {
      return actionFail(400, `仍有 ${pendingDeliverables} 个必填交付物未通过审核`);
    }
    const deliverables = [...new Set(input.deliverables ?? [])];
    if (deliverables.length === 0) {
      const rows = this.#rows(
        `SELECT d.name FROM task_deliverables d
         JOIN project_tasks t ON t.id = d.task_id
         WHERE t.project_id = ? ORDER BY d.created_at`,
        [projectId],
      );
      for (const row of rows) {
        const name = text(row, 'name');
        if (name && !deliverables.includes(name)) deliverables.push(name);
      }
    }
    const openItems = [...(input.openItems ?? [])];
    const unresolvedComments = this.#rows(
      `SELECT c.body, d.title FROM document_comments c
       JOIN project_documents d ON d.id = c.document_id
       WHERE d.project_id = ? AND c.status = 'open' ORDER BY c.created_at`,
      [projectId],
    );
    for (const comment of unresolvedComments) {
      const label = `未解决评论：${text(comment, 'title')} · ${text(comment, 'body').slice(0, 160)}`;
      if (!openItems.includes(label)) openItems.push(label);
    }
    if (openCount > 0 && openItems.length === 0) {
      return actionFail(400, `仍有 ${openCount} 个未完成任务，请登记遗留项`);
    }
    const now = this.#now();
    const id = existing ? text(existing, 'id') : randomUUID();
    if (existing) {
      this.#db
        .stmt(
          `UPDATE project_closures SET status = 'closed', acceptance_json = ?,
             actual_cost_cents = ?, deliverables_json = ?, open_items_json = ?, feedback = ?,
             benefit_plan_json = ?, closed_by = ?, closed_at = ?, version = version + 1,
             updated_at = ? WHERE id = ?`,
        )
        .run(
          JSON.stringify(input.acceptance),
          input.actualCostCents,
          JSON.stringify(deliverables),
          JSON.stringify(openItems),
          input.feedback ?? '',
          JSON.stringify(input.benefitPlan ?? []),
          user.id,
          now,
          now,
          id,
        );
    } else {
      this.#db
        .stmt(
          `INSERT INTO project_closures
             (id, project_id, status, acceptance_json, actual_cost_cents, deliverables_json,
              open_items_json, feedback, benefit_plan_json, closed_by, closed_at, created_at, updated_at)
           VALUES (?, ?, 'closed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          projectId,
          JSON.stringify(input.acceptance),
          input.actualCostCents,
          JSON.stringify(deliverables),
          JSON.stringify(openItems),
          input.feedback ?? '',
          JSON.stringify(input.benefitPlan ?? []),
          user.id,
          now,
          now,
          now,
        );
    }
    this.#db
      .stmt(
        `UPDATE projects SET status = 'completed', updated_at = ?, version = version + 1
         WHERE id = ?`,
      )
      .run(now, projectId);
    for (const plan of input.benefitPlan ?? []) {
      this.#db
        .stmt(
          `INSERT OR IGNORE INTO benefit_reviews
             (id, closure_id, due_on, status, actual_json, version, created_at)
           VALUES (?, ?, ?, 'pending', '{}', 1, ?)`,
        )
        .run(randomUUID(), id, plan.dueOn, now);
    }
    const closure = this.#row('SELECT * FROM project_closures WHERE id = ?', [id]);
    this.#audit(user, 'project.closure', projectId, { before: existing, after: closure });
    this.#publish('project.closed', { projectId, closureId: id }, user);
    return actionOk(closure ?? {});
  }

  projectClosure(user: SessionUser, projectId: string): ActionResult<Row> {
    const project = this.#project(projectId, user);
    if (!project) return actionFail(404, '项目不存在');
    const closure =
      this.#row(
        `SELECT * FROM project_closures WHERE project_id = ?
         ORDER BY created_at DESC LIMIT 1`,
        [projectId],
      ) ?? null;
    const benefits = closure
      ? this.#rows(`SELECT * FROM benefit_reviews WHERE closure_id = ? ORDER BY due_on ASC`, [
          text(closure, 'id'),
        ])
      : [];
    return actionOk({ closure, benefits });
  }

  reopenClosure(user: SessionUser, closureId: string, input: ClosureReopen): ActionResult<Row> {
    const closureRow = this.#row('SELECT * FROM project_closures WHERE id = ?', [closureId]);
    if (!closureRow) return actionFail(404, '结项记录不存在');
    const project = this.#project(text(closureRow, 'project_id'), user);
    if (!project) return actionFail(404, '结项记录不存在');
    if (!this.#manage(project, user)) return actionFail(403, '没有重新打开项目的权限');
    if (text(closureRow, 'status') !== 'closed') return actionFail(409, '项目未处于已结项状态');
    const now = this.#now();
    this.#db
      .stmt(
        `UPDATE project_closures SET status = 'reopened', reopened_by = ?, reopen_reason = ?,
           version = version + 1, updated_at = ? WHERE id = ?`,
      )
      .run(user.id, input.reason, now, closureId);
    this.#db
      .stmt(
        `UPDATE projects SET status = 'active', updated_at = ?, version = version + 1 WHERE id = ?`,
      )
      .run(now, project.id);
    const updated = this.#row('SELECT * FROM project_closures WHERE id = ?', [closureId]);
    this.#audit(user, 'project.reopen', closureId, {
      reason: input.reason,
      before: closureRow,
      after: updated,
    });
    return actionOk(updated ?? {});
  }

  recordBenefit(user: SessionUser, reviewId: string, input: BenefitRecord): ActionResult<Row> {
    const review = this.#row('SELECT * FROM benefit_reviews WHERE id = ?', [reviewId]);
    if (!review) return actionFail(404, '收益复盘不存在');
    const closureRow = this.#row('SELECT * FROM project_closures WHERE id = ?', [
      text(review, 'closure_id'),
    ]);
    const project = closureRow ? this.#project(text(closureRow, 'project_id'), user) : null;
    if (!project) return actionFail(404, '收益复盘不存在');
    if (!this.#manage(project, user)) return actionFail(403, '没有记录收益的权限');
    if (number(review, 'version') !== 1 && text(review, 'status') === 'completed') {
      return actionFail(409, '收益复盘已完成');
    }
    const now = this.#now();
    const updated = this.#row(
      `UPDATE benefit_reviews SET status = 'completed', actual_json = ?, recorded_by = ?,
         recorded_at = ?, version = version + 1 WHERE id = ? RETURNING *`,
      [JSON.stringify({ ...input.actual, note: input.note }), user.id, now, reviewId],
    );
    this.#audit(user, 'benefit.record', reviewId, {
      note: input.note,
      before: review,
      after: updated,
    });
    return actionOk(updated ?? {});
  }

  // -------------------------------------------------------------------------
  // SLA
  // -------------------------------------------------------------------------

  #slaDue(now: Date, minutes: number): string {
    return new Date(now.getTime() + minutes * 60_000).toISOString();
  }

  #clockMinutes(value: string): number | null {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 24 || minute > 59) return null;
    return hour * 60 + minute;
  }

  #businessWindows(policy: Row): Map<number, [number, number][]> {
    const windows = new Map<number, [number, number][]>();
    const add = (day: number, start: number, end: number) => {
      if (day < 0 || day > 6 || end <= start) return;
      const list = windows.get(day) ?? [];
      list.push([start, end]);
      windows.set(day, list);
    };
    for (const item of jsonArray(policy.business_hours_json)) {
      if (typeof item === 'string') {
        const [startRaw, endRaw] = item.split('-');
        const start = this.#clockMinutes(startRaw ?? '');
        const end = this.#clockMinutes(endRaw ?? '');
        if (start !== null && end !== null) {
          for (const day of [1, 2, 3, 4, 5]) add(day, start, end);
        }
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const start = this.#clockMinutes(String(record.start ?? ''));
      const end = this.#clockMinutes(String(record.end ?? ''));
      if (start === null || end === null) continue;
      const days = Array.isArray(record.days)
        ? record.days.map((day) => Number(day))
        : record.day !== undefined
          ? [Number(record.day)]
          : [1, 2, 3, 4, 5];
      for (const day of days) add(day, start, end);
    }
    return windows;
  }

  #zonedParts(ms: number, timeZone: string): { weekday: number; minute: number } | null {
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        weekday: 'short',
        hourCycle: 'h23',
      });
      const parts = new Map(
        formatter.formatToParts(new Date(ms)).map((part) => [part.type, part.value]),
      );
      const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const weekday = names.indexOf(parts.get('weekday') ?? '');
      const hour = Number(parts.get('hour') ?? '0');
      const minute = Number(parts.get('minute') ?? '0');
      if (weekday < 0 || Number.isNaN(hour) || Number.isNaN(minute)) return null;
      return { weekday, minute: hour * 60 + minute };
    } catch {
      return null;
    }
  }

  #businessDue(now: Date, minutes: number, policy: Row): string {
    const windows = this.#businessWindows(policy);
    if (windows.size === 0) return this.#slaDue(now, minutes);
    const timeZone = text(policy, 'timezone') || 'Asia/Shanghai';
    const holidays = new Set(jsonArray(policy.holidays_json).map((day) => String(day)));
    let cursor = now.getTime();
    let remaining = Math.max(1, minutes);
    const maxSteps = Math.min(600_000, Math.max(20_160, remaining * 3 + 20_160));
    for (let step = 0; step < maxSteps; step++) {
      const parts = this.#zonedParts(cursor, timeZone);
      const dateParts = this.#zonedScheduleParts(cursor, timeZone);
      const onHoliday =
        dateParts !== null && holidays.has(`${dateParts.year}-${dateParts.month}-${dateParts.day}`);
      const slots = parts ? (windows.get(parts.weekday) ?? []) : [];
      const inside =
        !onHoliday &&
        parts !== null &&
        slots.some(([start, end]) => parts.minute >= start && parts.minute < end);
      if (inside) {
        remaining--;
        if (remaining === 0) return new Date(cursor + 60_000).toISOString();
      }
      cursor += 60_000;
    }
    return this.#slaDue(now, minutes);
  }

  attachSla(user: SessionUser, taskId: string, input: SlaAttach): ActionResult<Row> {
    const project = this.#store.domain.projectOfTask(taskId, user);
    if (!project) return actionFail(404, '任务不存在');
    if (!this.#manage({ ownerId: project.projectOwnerId ?? '' }, user)) {
      return actionFail(403, '没有配置 SLA 的权限');
    }
    const task = this.#row('SELECT * FROM project_tasks WHERE id = ?', [taskId]);
    if (!task) return actionFail(404, '任务不存在');
    let policy: Row | null = null;
    if (input.policyId) {
      policy = this.#row('SELECT * FROM task_sla_policies WHERE id = ?', [input.policyId]);
      if (!policy || text(policy, 'workspace_id') !== this.#workspace(user)) {
        return actionFail(404, 'SLA 策略不存在');
      }
    } else {
      policy = this.#row(
        `SELECT * FROM task_sla_policies
         WHERE workspace_id = ? AND active = 1
           AND (task_type = 'any' OR task_type = ?)
           AND (priority = 'any' OR priority = ?)
           AND (customer_tier = 'any' OR customer_tier = ?)
         ORDER BY (task_type <> 'any') DESC, (priority <> 'any') DESC,
                  (customer_tier <> 'any') DESC, created_at ASC LIMIT 1`,
        [
          this.#workspace(user),
          text(task, 'task_type') || 'general',
          text(task, 'priority') || 'medium',
          text(task, 'customer_tier') || 'standard',
        ],
      );
      if (!policy) return actionFail(404, '没有匹配的 SLA 策略');
    }
    if (!policy.active) return actionFail(400, 'SLA 策略未启用');
    const now = new Date(this.#store.now());
    const responseDue = this.#businessDue(now, number(policy, 'response_minutes'), policy);
    const resolveDue = this.#businessDue(now, number(policy, 'resolve_minutes'), policy);
    const reviewDue = this.#businessDue(now, number(policy, 'review_minutes'), policy);
    const existing = this.#row('SELECT * FROM task_sla_instances WHERE task_id = ?', [taskId]);
    if (existing) {
      return actionFail(409, '任务已关联 SLA', existing);
    }
    const id = randomUUID();
    this.#db
      .stmt(
        `INSERT INTO task_sla_instances
           (id, task_id, policy_id, state, response_due_at, resolve_due_at, review_due_at,
            created_at, updated_at)
         VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        taskId,
        text(policy, 'id'),
        responseDue,
        resolveDue,
        reviewDue,
        this.#now(),
        this.#now(),
      );
    const row = this.#row('SELECT * FROM task_sla_instances WHERE id = ?', [id]);
    this.#audit(user, 'task.sla.attach', taskId, {
      policyId: text(policy, 'id'),
      auto: !input.policyId,
    });
    return actionOk(row ?? {});
  }

  slaAction(
    user: SessionUser,
    taskId: string,
    action: 'pause' | 'resume' | 'escalate' | 'respond' | 'review',
    input: SlaAction,
  ): ActionResult<Row> {
    const project = this.#store.domain.projectOfTask(taskId, user);
    if (!project) return actionFail(404, '任务不存在');
    const instance = this.#row('SELECT * FROM task_sla_instances WHERE task_id = ?', [taskId]);
    if (!instance) return actionFail(404, '任务未关联 SLA');
    const now = this.#store.now();
    if (action === 'respond') {
      const updated = this.#row(
        `UPDATE task_sla_instances SET response_at = ?, updated_at = ?, version = version + 1
         WHERE id = ? RETURNING *`,
        [now.toISOString(), now.toISOString(), text(instance, 'id')],
      );
      this.#audit(user, 'task.sla.respond', taskId, { at: now.toISOString() });
      return actionOk(updated ?? {});
    }
    if (action === 'review') {
      if (!this.#manage({ ownerId: project.projectOwnerId ?? '' }, user)) {
        return actionFail(403, '没有确认 SLA 审核的权限');
      }
      const updated = this.#row(
        `UPDATE task_sla_instances SET reviewed_at = ?, updated_at = ?, version = version + 1
         WHERE id = ? RETURNING *`,
        [now.toISOString(), now.toISOString(), text(instance, 'id')],
      );
      this.#audit(user, 'task.sla.review', taskId, { at: now.toISOString() });
      return actionOk(updated ?? {});
    }
    if (!this.#manage({ ownerId: project.projectOwnerId ?? '' }, user)) {
      return actionFail(403, '没有管理 SLA 的权限');
    }
    if (action === 'pause') {
      if (text(instance, 'state') !== 'running') return actionFail(409, 'SLA 未处于运行状态');
      if (!input.reason?.trim()) return actionFail(400, '暂停 SLA 需要填写原因');
      const updated = this.#row(
        `UPDATE task_sla_instances SET state = 'paused', paused_at = ?, pause_reason = ?,
           updated_at = ?, version = version + 1 WHERE id = ? RETURNING *`,
        [now.toISOString(), input.reason.trim(), now.toISOString(), text(instance, 'id')],
      );
      this.#audit(user, 'task.sla.pause', taskId, { reason: input.reason.trim() });
      return actionOk(updated ?? {});
    }
    if (action === 'resume') {
      if (text(instance, 'state') !== 'paused') return actionFail(409, 'SLA 未暂停');
      const pausedAt = text(instance, 'paused_at');
      const pausedMinutes = pausedAt
        ? Math.max(0, Math.round((now.getTime() - new Date(pausedAt).getTime()) / 60_000))
        : 0;
      const shift = (value: string | null): string | null =>
        value ? new Date(new Date(value).getTime() + pausedMinutes * 60_000).toISOString() : null;
      const updated = this.#row(
        `UPDATE task_sla_instances SET state = 'running', paused_at = NULL, pause_reason = NULL,
           paused_minutes = paused_minutes + ?, response_due_at = ?,
           resolve_due_at = ?, review_due_at = ?, updated_at = ?, version = version + 1
         WHERE id = ? RETURNING *`,
        [
          pausedMinutes,
          shift(nullableText(instance, 'response_due_at')),
          shift(text(instance, 'resolve_due_at')),
          shift(nullableText(instance, 'review_due_at')),
          now.toISOString(),
          text(instance, 'id'),
        ],
      );
      this.#audit(user, 'task.sla.resume', taskId, { pausedMinutes });
      return actionOk(updated ?? {});
    }
    if (!input.reason?.trim()) return actionFail(400, '升级 SLA 需要填写原因');
    const level = number(instance, 'escalated_level') + 1;
    const updated = this.#row(
      `UPDATE task_sla_instances SET escalated_level = ?, escalated_at = ?, updated_at = ?,
         version = version + 1 WHERE id = ? RETURNING *`,
      [level, now.toISOString(), now.toISOString(), text(instance, 'id')],
    );
    this.#audit(user, 'task.sla.escalate', taskId, {
      level,
      reason: input.reason.trim(),
      before: instance,
      after: updated,
    });
    this.#notify(project.projectOwnerId ?? '', 'sla', 'SLA 已升级', input.reason.trim());
    return actionOk(updated ?? {});
  }

  tickSla(user: SessionUser, input: { limit?: number } = {}): ActionResult<Row> {
    if (!this.#manageWorkspace(user)) return actionFail(403, '没有运行 SLA 巡检的权限');
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const rows = this.#rows(
      `SELECT i.*, p.auto_escalate, p.escalation_json, p.advance_reminder_minutes,
              t.title AS task_title, t.status AS task_status, t.completed_at,
              t.assignee_id, pr.owner_id AS project_owner, pr.name AS project_name
       FROM task_sla_instances i
       JOIN task_sla_policies p ON p.id = i.policy_id
       JOIN project_tasks t ON t.id = i.task_id
       JOIN projects pr ON pr.id = t.project_id
       WHERE i.state IN ('running', 'paused') AND pr.workspace_id = ?
       ORDER BY i.resolve_due_at ASC LIMIT ?`,
      [this.#workspace(user), limit],
    );
    const now = this.#now();
    const nowMs = Date.parse(now);
    const result = { checked: rows.length, breached: 0, met: 0, reminded: 0, escalated: 0 };
    for (const row of rows) {
      const id = text(row, 'id');
      const state = text(row, 'state');
      if (text(row, 'task_status') === 'done') {
        const due = text(row, 'resolve_due_at');
        const completedAt = text(row, 'completed_at') || now;
        const next = due && Date.parse(completedAt) > Date.parse(due) ? 'breached' : 'met';
        this.#db
          .stmt(
            `UPDATE task_sla_instances SET state = ?, resolved_at = ?, updated_at = ?,
               version = version + 1 WHERE id = ?`,
          )
          .run(next, completedAt, now, id);
        result[next === 'met' ? 'met' : 'breached']++;
        continue;
      }
      if (state === 'paused') continue;
      const responseDue = text(row, 'response_due_at');
      if (
        responseDue &&
        nowMs >= Date.parse(responseDue) &&
        !text(row, 'response_at') &&
        !text(row, 'response_notified_at')
      ) {
        const target = text(row, 'assignee_id') || text(row, 'project_owner');
        this.#notify(target, 'sla', 'SLA 响应已超时', text(row, 'task_title'));
        this.#db
          .stmt('UPDATE task_sla_instances SET response_notified_at = ? WHERE id = ?')
          .run(now, id);
      }
      const resolveDue = text(row, 'resolve_due_at');
      if (!resolveDue) continue;
      const dueMs = Date.parse(resolveDue);
      const reminderAt = dueMs - Math.max(0, number(row, 'advance_reminder_minutes')) * 60_000;
      if (nowMs >= reminderAt && nowMs < dueMs && !text(row, 'reminded_at')) {
        const target = text(row, 'assignee_id') || text(row, 'project_owner');
        this.#notify(target, 'sla', 'SLA 即将到期', text(row, 'task_title'));
        this.#db.stmt('UPDATE task_sla_instances SET reminded_at = ? WHERE id = ?').run(now, id);
        result.reminded++;
      }
      if (nowMs < dueMs) continue;
      const targets = new Set<string>();
      if (text(row, 'assignee_id')) targets.add(text(row, 'assignee_id'));
      if (text(row, 'project_owner')) targets.add(text(row, 'project_owner'));
      const escalation = jsonArray(row.escalation_json) as (
        | string
        | { level?: number; userId?: string; role?: string }
      )[];
      const level = number(row, 'escalated_level');
      const nextEscalation = escalation[Math.min(level, escalation.length - 1)];
      if (typeof nextEscalation === 'string') targets.add(nextEscalation);
      else if (nextEscalation?.userId) targets.add(nextEscalation.userId);
      else if (nextEscalation?.role) {
        for (const candidate of this.#rows(
          'SELECT id FROM users WHERE role = ? AND status = ? AND workspace_id = ?',
          [nextEscalation.role, 'active', this.#workspace(user)],
        )) {
          targets.add(text(candidate, 'id'));
        }
      }
      const wasBreached = Boolean(text(row, 'breach_notified_at'));
      if (!wasBreached) {
        for (const target of targets) {
          this.#notify(target, 'sla', 'SLA 已违约', text(row, 'task_title'));
        }
        this.#db
          .stmt(
            `UPDATE task_sla_instances SET state = 'breached', breach_notified_at = ?,
               updated_at = ? WHERE id = ?`,
          )
          .run(now, now, id);
        result.breached++;
      }
      if (number(row, 'auto_escalate') === 1 && level < escalation.length) {
        const nextLevel = level + 1;
        this.#db
          .stmt(
            `UPDATE task_sla_instances SET escalated_level = ?, escalated_at = ?,
               updated_at = ? WHERE id = ?`,
          )
          .run(nextLevel, now, now, id);
        this.#audit(user, 'task.sla.auto_escalate', text(row, 'task_id'), {
          level: nextLevel,
          targets: [...targets],
        });
        result.escalated++;
      }
    }
    return actionOk(result);
  }

  tickBenefitReviews(user: SessionUser): ActionResult<Row> {
    if (!this.#manageWorkspace(user)) return actionFail(403, '没有运行收益复核提醒的权限');
    const todayKey = this.#now().slice(0, 10);
    const horizon = addDays(todayKey, 7);
    const rows = this.#rows(
      `SELECT b.*, c.project_id, p.name AS project_name, p.owner_id
       FROM benefit_reviews b
       JOIN project_closures c ON c.id = b.closure_id
       JOIN projects p ON p.id = c.project_id
       WHERE b.status = 'pending' AND b.due_on <= ? AND b.reminder_sent_at IS NULL
       ORDER BY b.due_on ASC LIMIT 200`,
      [horizon],
    );
    const now = this.#now();
    for (const row of rows) {
      this.#notify(
        text(row, 'owner_id'),
        'benefit',
        '收益复核即将到期',
        `${text(row, 'project_name')} · ${text(row, 'due_on')}`,
      );
      this.#db
        .stmt('UPDATE benefit_reviews SET reminder_sent_at = ? WHERE id = ?')
        .run(now, text(row, 'id'));
    }
    return actionOk({ reminded: rows.length, today: todayKey });
  }

  tickDocumentReminders(user: SessionUser): ActionResult<Row> {
    if (!this.#manageWorkspace(user)) return actionFail(403, '没有运行文档提醒的权限');
    const todayKey = this.#now().slice(0, 10);
    const workspaceId = this.#workspace(user);
    const overdue = this.#rows(
      `SELECT d.id, d.title, d.owner_id, p.name AS project_name
       FROM project_documents d JOIN projects p ON p.id = d.project_id
       WHERE d.status IN ('published', 'review') AND d.review_due_at IS NOT NULL
         AND d.review_due_at < ? AND p.workspace_id = ? AND p.deleted_at IS NULL
       ORDER BY d.review_due_at ASC LIMIT 200`,
      [todayKey, workspaceId],
    );
    const now = this.#now();
    for (const row of overdue) {
      this.#db
        .stmt(
          `UPDATE project_documents SET status = 'expired', updated_at = ?
           WHERE id = ? AND status IN ('published', 'review')`,
        )
        .run(now, text(row, 'id'));
      this.#notify(
        text(row, 'owner_id'),
        'document',
        '文档已过期，请安排复核',
        `${text(row, 'project_name')} · ${text(row, 'title')}`,
      );
      this.#audit(user, 'document.expire', text(row, 'id'), {});
    }
    const horizon = new Date(Date.parse(this.#now()) + 7 * 86_400_000).toISOString();
    const rows = this.#rows(
      `SELECT d.id, d.title, d.review_due_at, p.owner_id, p.name AS project_name
       FROM project_documents d JOIN projects p ON p.id = d.project_id
       WHERE d.status IN ('published', 'review') AND d.review_due_at IS NOT NULL
         AND d.review_due_at <= ? AND d.reminder_sent_at IS NULL
         AND p.workspace_id = ? AND p.deleted_at IS NULL
       ORDER BY d.review_due_at ASC LIMIT 200`,
      [horizon, this.#workspace(user)],
    );
    for (const row of rows) {
      this.#notify(
        text(row, 'owner_id'),
        'document',
        '文档复核即将到期',
        `${text(row, 'project_name')} · ${text(row, 'title')}`,
      );
      this.#db
        .stmt('UPDATE project_documents SET reminder_sent_at = ? WHERE id = ?')
        .run(now, text(row, 'id'));
    }
    return actionOk({ reminded: rows.length, expired: overdue.length });
  }

  // -------------------------------------------------------------------------
  // Dynamic forms
  // -------------------------------------------------------------------------

  putFormValues(
    user: SessionUser,
    taskId: string,
    formId: string,
    input: FormValuesPut,
  ): ActionResult<Row> {
    const project = this.#store.domain.projectOfTask(taskId, user);
    if (!project) return actionFail(404, '任务不存在');
    const form = this.#row('SELECT * FROM task_forms WHERE id = ?', [formId]);
    if (!form || text(form, 'workspace_id') !== this.#workspace(user)) {
      return actionFail(404, '表单不存在');
    }
    const fields = jsonArray(form.fields_json) as {
      key?: string;
      label?: string;
      required?: boolean;
      type?: string;
      options?: unknown[];
      visibleWhen?: { key?: string; equals?: unknown };
      min?: number;
      max?: number;
      attachmentRequired?: boolean;
    }[];
    const values = input.values;
    const errors: string[] = [];
    const isVisible = (field: (typeof fields)[number]): boolean => {
      const rule = field.visibleWhen;
      if (!rule || typeof rule !== 'object' || typeof rule.key !== 'string') return true;
      return values[rule.key] === rule.equals;
    };
    const attachmentIds = input.attachmentIds ?? [];
    for (const attachmentId of attachmentIds) {
      const owned = this.#row(
        `SELECT id FROM attachments WHERE id = ? AND (task_id = ? OR project_id = ?)`,
        [attachmentId, taskId, project.projectId],
      );
      if (!owned) {
        errors.push('附件不存在或不属于当前任务');
        break;
      }
    }
    for (const field of fields) {
      if (!isVisible(field)) continue;
      const key = String(field.key ?? '');
      if (!key) continue;
      const label = String(field.label ?? key);
      const value = values[key];
      const missing =
        value === undefined ||
        value === null ||
        value === '' ||
        (field.type === 'checkbox' && value === false);
      if (input.completed && field.required && missing) errors.push(`${label} 为必填项`);
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        errors.push(`${label} 的值无效`);
        continue;
      }
      if (field.type === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          errors.push(`${label} 必须是数字`);
        } else if (typeof field.min === 'number' && value < field.min) {
          errors.push(`${label} 不能小于 ${field.min}`);
        } else if (typeof field.max === 'number' && value > field.max) {
          errors.push(`${label} 不能大于 ${field.max}`);
        }
      } else if (field.type === 'date') {
        const valid =
          typeof value === 'string' &&
          /^\d{4}-\d{2}-\d{2}$/.test(value) &&
          !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
        if (!valid) errors.push(`${label} 必须是有效日期`);
      } else if (field.type === 'select') {
        const options = Array.isArray(field.options)
          ? field.options.map((item) => String(item))
          : [];
        if (typeof value !== 'string' || !options.includes(value)) {
          errors.push(`${label} 的选项无效`);
        }
      } else if (field.type === 'checkbox') {
        if (typeof value !== 'boolean') errors.push(`${label} 必须是布尔值`);
      } else if (field.type === 'text' || field.type === 'textarea') {
        const limit = field.type === 'text' ? 5_000 : 20_000;
        if (typeof value !== 'string') errors.push(`${label} 必须是文本`);
        else if (value.length > limit) errors.push(`${label} 内容过长`);
      } else if (field.type === 'signature' && typeof value !== 'string') {
        errors.push(`${label} 签名无效`);
      }
    }
    if (input.completed) {
      const signed = Boolean(input.signature?.trim());
      const signatureFields = fields.filter(
        (field) => field.type === 'signature' && field.required && isVisible(field),
      );
      if (signatureFields.length > 0 && !signed) {
        errors.push(`${String(signatureFields[0]?.label ?? '签名')} 需要签名`);
      }
      const needAttachment = fields.some((field) => field.attachmentRequired && isVisible(field));
      if (needAttachment && attachmentIds.length === 0) errors.push('请上传所需附件');
    }
    if (errors.length > 0) return actionFail(400, errors.join('；'));
    if (input.completed) {
      const requiredItems = this.#rows(
        `SELECT * FROM task_checklist_items WHERE task_id = ? AND form_id = ? AND required = 1`,
        [taskId, formId],
      );
      const pending = requiredItems.filter((item) => !item.done);
      if (pending.length > 0) return actionFail(400, `仍有 ${pending.length} 个必填检查项未完成`);
    }
    const now = this.#now();
    const existing = this.#row('SELECT * FROM task_form_values WHERE task_id = ? AND form_id = ?', [
      taskId,
      formId,
    ]);
    if (existing) {
      this.#db
        .stmt(
          `UPDATE task_form_values SET values_json = ?, form_version = ?,
             completed_at = ?, completed_by = ?, signature_name = ?, signature_at = ?,
             version = version + 1, updated_at = ?
           WHERE task_id = ? AND form_id = ?`,
        )
        .run(
          JSON.stringify(values),
          number(form, 'schema_version'),
          input.completed ? now : null,
          input.completed ? user.id : null,
          input.completed ? (input.signature ?? '') : '',
          input.completed ? now : null,
          now,
          taskId,
          formId,
        );
    } else {
      this.#db
        .stmt(
          `INSERT INTO task_form_values
             (task_id, form_id, values_json, form_version, completed_at, completed_by,
              signature_name, signature_at, version, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .run(
          taskId,
          formId,
          JSON.stringify(values),
          number(form, 'schema_version'),
          input.completed ? now : null,
          input.completed ? user.id : null,
          input.completed ? (input.signature ?? '') : '',
          input.completed ? now : null,
          now,
        );
    }
    const row = this.#row('SELECT * FROM task_form_values WHERE task_id = ? AND form_id = ?', [
      taskId,
      formId,
    ]);
    this.#audit(user, 'task.form.submit', taskId, { formId, completed: Boolean(input.completed) });
    return actionOk(row ?? {});
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  #dispatchCandidates(taskId: string, rule: Row, workspace: string, projectId: string): Row[] {
    const required = jsonArray(rule.skills_json).map((item) => String(item).toLowerCase());
    const strategy = text(rule, 'strategy') || 'balanced';
    const maxLoad = number(rule, 'max_load_hours') || 40;
    const taskRow = this.#row('SELECT priority, assignee_id FROM project_tasks WHERE id = ?', [
      taskId,
    ]);
    const taskPriority = text(taskRow ?? {}, 'priority') || 'medium';
    const priorityWeight: Record<string, number> = {
      urgent: 1.25,
      high: 1.1,
      medium: 1,
      low: 0.9,
    };
    const owner = this.#row(
      'SELECT timezone FROM users WHERE id = (SELECT owner_id FROM projects WHERE id = ?)',
      [projectId],
    );
    const referenceTimezone = text(owner ?? {}, 'timezone') || 'UTC';
    const members = this.#rows(
      `SELECT u.id, u.name, u.timezone, COALESCE(p.skills_json, '[]') AS skills_json
       FROM users u
       JOIN projects pr ON pr.id = ?
       LEFT JOIN capacity_profiles p ON p.user_id = u.id
       WHERE u.workspace_id = ? AND u.status = 'active'
         AND (u.id = pr.owner_id OR EXISTS (
           SELECT 1 FROM project_members pm WHERE pm.project_id = pr.id AND pm.user_id = u.id
         ))`,
      [projectId, workspace],
    );
    const load = this.#rows(
      `SELECT assignee_id, SUM(COALESCE(estimate_hours, 4)) AS hours
       FROM project_tasks WHERE project_id = ? AND status <> 'done' AND assignee_id IS NOT NULL
       GROUP BY assignee_id`,
      [projectId],
    );
    const loadMap = new Map(load.map((row) => [text(row, 'assignee_id'), number(row, 'hours')]));
    const historyRows = this.#rows(
      `SELECT candidate_id, COUNT(*) AS count FROM dispatch_recommendations
       WHERE rule_id = ? GROUP BY candidate_id`,
      [text(rule, 'id')],
    );
    const history = new Map(
      historyRows.map((row) => [text(row, 'candidate_id'), number(row, 'count')]),
    );
    const build = (requireSkills: boolean): Row[] => {
      const candidates: Row[] = [];
      for (const member of members) {
        const skills = jsonArray(member.skills_json).map((item) => String(item).toLowerCase());
        const matched = required.filter((skill) => skills.includes(skill)).length;
        if (requireSkills && required.length > 0 && matched === 0) continue;
        const hours = loadMap.get(text(member, 'id')) ?? 0;
        const memberTimezone = text(member, 'timezone') || 'UTC';
        const timezoneMatch = memberTimezone === referenceTimezone;
        const effectiveMax = maxLoad * (priorityWeight[taskPriority] ?? 1);
        const skillScore = (matched / Math.max(required.length, 1)) * 60;
        const loadScore = Math.max(0, 1 - hours / effectiveMax) * 40;
        const timezoneScore = timezoneMatch ? 10 : 0;
        const score = Math.round(skillScore + loadScore + timezoneScore);
        candidates.push({
          taskId,
          ruleId: text(rule, 'id'),
          candidateId: text(member, 'id'),
          candidateName: text(member, 'name'),
          score,
          reasons: {
            matchedSkills: matched,
            requiredSkills: required.length,
            currentLoadHours: hours,
            maxLoadHours: maxLoad,
            effectiveMaxHours: Number(effectiveMax.toFixed(1)),
            taskPriority,
            timezone: memberTimezone,
            timezoneMatch,
            strategy,
            historyCount: history.get(text(member, 'id')) ?? 0,
            fallback: !requireSkills,
          },
        });
      }
      return candidates;
    };
    let candidates = build(true);
    if (candidates.length === 0) candidates = build(false);
    candidates.sort((left, right) => {
      if (strategy === 'round_robin') {
        const leftCount = Number((left.reasons as Row).historyCount ?? 0);
        const rightCount = Number((right.reasons as Row).historyCount ?? 0);
        if (leftCount !== rightCount) return leftCount - rightCount;
      }
      if (strategy === 'load') {
        const leftLoad = Number((left.reasons as Row).currentLoadHours ?? 0);
        const rightLoad = Number((right.reasons as Row).currentLoadHours ?? 0);
        if (leftLoad !== rightLoad) return leftLoad - rightLoad;
      }
      if (strategy === 'timezone') {
        const leftMatch = (left.reasons as Row).timezoneMatch === true ? 1 : 0;
        const rightMatch = (right.reasons as Row).timezoneMatch === true ? 1 : 0;
        if (leftMatch !== rightMatch) return rightMatch - leftMatch;
      }
      const difference = Number(right.score) - Number(left.score);
      if (difference !== 0) return difference;
      return String(left.candidateId).localeCompare(String(right.candidateId));
    });
    if (strategy === 'round_robin') return candidates.slice(0, 1);
    return candidates;
  }

  recommendDispatch(user: SessionUser, input: DispatchRecommend): ActionResult<Row[]> {
    const workspace = this.#workspace(user);
    const taskIds = [...new Set(input.taskIds?.length ? input.taskIds : [input.taskId])];
    const rules = input.ruleId
      ? this.#rows(
          `SELECT * FROM dispatch_rules WHERE id = ? AND workspace_id = ? AND active = 1`,
          [input.ruleId, workspace],
        )
      : this.#rows(`SELECT * FROM dispatch_rules WHERE workspace_id = ? AND active = 1`, [
          workspace,
        ]);
    if (rules.length === 0) return actionFail(400, '没有启用的分派规则');
    const targets: { taskId: string; projectId: string }[] = [];
    for (const taskId of taskIds) {
      const project = this.#store.domain.projectOfTask(taskId, user);
      if (!project) return actionFail(404, '任务不存在');
      if (!this.#manage({ ownerId: project.projectOwnerId ?? '' }, user)) {
        return actionFail(403, '没有分派任务的权限');
      }
      const task = this.#row('SELECT id FROM project_tasks WHERE id = ?', [taskId]);
      if (!task) return actionFail(404, '任务不存在');
      targets.push({ taskId, projectId: project.projectId ?? '' });
    }
    const created: Row[] = [];
    const run = () => {
      for (const target of targets) {
        for (const rule of rules) {
          const candidates = this.#dispatchCandidates(
            target.taskId,
            rule,
            workspace,
            target.projectId,
          );
          for (const candidate of candidates) {
            if (input.simulate) {
              created.push({ ...candidate, simulate: true });
              continue;
            }
            const id = randomUUID();
            const inserted = this.#db
              .stmt(
                `INSERT INTO dispatch_recommendations
                   (id, rule_id, task_id, candidate_id, score, reasons_json, status, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'recommended', ?)
                 ON CONFLICT (rule_id, task_id, candidate_id) DO NOTHING`,
              )
              .run(
                id,
                text(rule, 'id'),
                target.taskId,
                String(candidate.candidateId ?? ''),
                Number(candidate.score ?? 0),
                JSON.stringify(candidate.reasons ?? {}),
                this.#now(),
              );
            if (Number(inserted.changes) === 0) continue;
            const row = this.#row('SELECT * FROM dispatch_recommendations WHERE id = ?', [id]);
            if (row) created.push(row);
          }
        }
      }
    };
    if (input.simulate) run();
    else this.#db.transaction(run);
    if (created.length === 0) return actionFail(400, '没有符合条件的候选人');
    if (!input.simulate) {
      this.#audit(user, 'task.dispatch.recommend', taskIds.join(','), {
        ruleIds: rules.map((rule) => text(rule, 'id')),
        batch: taskIds.length > 1,
      });
    }
    return actionOk(created);
  }

  #applyDispatchDecision(user: SessionUser, rec: Row, input: DispatchAccept): ActionResult<Row> {
    const now = this.#now();
    const updated = this.#row(
      `UPDATE dispatch_recommendations SET status = ?, decided_by = ?, decided_at = ?
       WHERE id = ? RETURNING *`,
      [input.mode === 'assign' ? 'accepted' : 'rejected', user.id, now, input.recommendationId],
    );
    let assigned: Row | null = input.mode === 'assign' ? rec : null;
    if (input.mode === 'assign') {
      this.#db
        .stmt(
          `UPDATE project_tasks SET assignee_id = ?, updated_at = ?, version = version + 1
           WHERE id = ?`,
        )
        .run(text(rec, 'candidate_id'), now, text(rec, 'task_id'));
      this.#db
        .stmt(
          `UPDATE dispatch_recommendations SET status = 'rejected', decided_by = ?, decided_at = ?
           WHERE task_id = ? AND id <> ? AND status = 'recommended'`,
        )
        .run(user.id, now, text(rec, 'task_id'), text(rec, 'id'));
      this.#notify(
        text(rec, 'candidate_id'),
        'task',
        '任务已通过自动分派指派给你',
        text(rec, 'task_id'),
      );
    } else if (input.fallback) {
      const next = this.#row(
        `SELECT * FROM dispatch_recommendations
         WHERE task_id = ? AND status = 'recommended'
         ORDER BY score DESC, created_at ASC LIMIT 1`,
        [text(rec, 'task_id')],
      );
      if (next) {
        this.#db
          .stmt(
            `UPDATE dispatch_recommendations SET status = 'accepted', decided_by = ?, decided_at = ?
             WHERE id = ?`,
          )
          .run(user.id, now, text(next, 'id'));
        this.#db
          .stmt(
            `UPDATE project_tasks SET assignee_id = ?, updated_at = ?, version = version + 1
             WHERE id = ?`,
          )
          .run(text(next, 'candidate_id'), now, text(rec, 'task_id'));
        this.#notify(
          text(next, 'candidate_id'),
          'task',
          '任务已通过分派回退指派给你',
          text(rec, 'task_id'),
        );
        assigned = next;
      }
    }
    this.#audit(user, 'task.dispatch.decide', text(rec, 'task_id'), {
      mode: input.mode,
      fallback: Boolean(input.fallback),
      before: rec,
      after: updated,
    });
    return actionOk({
      ...(updated ?? {}),
      fallback: assigned && assigned !== rec ? assigned : null,
    });
  }

  decideDispatch(user: SessionUser, input: DispatchAccept): ActionResult<Row> {
    const rec = this.#row('SELECT * FROM dispatch_recommendations WHERE id = ?', [
      input.recommendationId,
    ]);
    if (!rec) return actionFail(404, '推荐记录不存在');
    const project = this.#store.domain.projectOfTask(text(rec, 'task_id'), user);
    if (!project) return actionFail(404, '推荐记录不存在');
    if (!this.#manage({ ownerId: project.projectOwnerId ?? '' }, user)) {
      return actionFail(403, '没有分派任务的权限');
    }
    if (text(rec, 'status') !== 'recommended') return actionFail(409, '推荐已处理');
    return this.#db.transaction(() => this.#applyDispatchDecision(user, rec, input));
  }

  decideDispatchBatch(user: SessionUser, input: DispatchBatch): ActionResult<Row> {
    const ids = [...new Set(input.recommendationIds)];
    const records: Row[] = [];
    for (const id of ids) {
      const rec = this.#row('SELECT * FROM dispatch_recommendations WHERE id = ?', [id]);
      if (!rec) return actionFail(404, '推荐记录不存在');
      const project = this.#store.domain.projectOfTask(text(rec, 'task_id'), user);
      if (!project) return actionFail(404, '推荐记录不存在');
      if (!this.#manage({ ownerId: project.projectOwnerId ?? '' }, user)) {
        return actionFail(403, '没有分派任务的权限');
      }
      if (text(rec, 'status') !== 'recommended') return actionFail(409, '推荐已处理');
      records.push(rec);
    }
    const decided = this.#db.transaction(() => {
      const seen = new Set<string>();
      const rows: Row[] = [];
      for (const rec of records) {
        if (input.mode === 'assign') {
          const taskId = text(rec, 'task_id');
          if (seen.has(taskId)) continue;
          seen.add(taskId);
        }
        const result = this.#applyDispatchDecision(user, rec, {
          recommendationId: text(rec, 'id'),
          mode: input.mode,
          fallback: input.fallback,
        });
        if (result.ok) rows.push(result.data);
      }
      return rows;
    });
    return actionOk({ decided, count: decided.length });
  }

  // -------------------------------------------------------------------------
  // Handoffs
  // -------------------------------------------------------------------------

  #handoffChecklist(taskId: string): { item: string; done: boolean }[] {
    const items: { item: string; done: boolean }[] = [];
    const subtasks = this.#rows(
      `SELECT title FROM project_tasks
       WHERE parent_id = ? AND status <> 'done'
       ORDER BY sort_order ASC LIMIT 20`,
      [taskId],
    );
    for (const row of subtasks) {
      items.push({ item: `完成子任务：${text(row, 'title')}`, done: false });
    }
    const open = this.#rows(
      `SELECT label FROM task_checklist_items
       WHERE task_id = ? AND done = 0
       ORDER BY sort_order ASC LIMIT 20`,
      [taskId],
    );
    for (const row of open) {
      const label = `完成检查项：${text(row, 'label')}`;
      if (!items.some((item) => item.item === label)) items.push({ item: label, done: false });
    }
    return items;
  }

  createHandoff(user: SessionUser, taskId: string, input: HandoffCreate): ActionResult<Row> {
    const project = this.#store.domain.projectOfTask(taskId, user);
    if (!project) return actionFail(404, '任务不存在');
    const task = this.#row('SELECT * FROM project_tasks WHERE id = ?', [taskId]);
    if (!task) return actionFail(404, '任务不存在');
    if (
      text(task, 'assignee_id') &&
      text(task, 'assignee_id') !== user.id &&
      !this.#manage({ ownerId: project.projectOwnerId ?? '' }, user)
    ) {
      return actionFail(403, '只有任务负责人或项目管理员可以发起交接');
    }
    const target = this.#row(
      `SELECT u.id FROM users u
       JOIN projects pr ON pr.id = ?
       WHERE u.id = ? AND u.status = 'active' AND u.workspace_id = ?
         AND (u.id = pr.owner_id OR EXISTS (
           SELECT 1 FROM project_members pm WHERE pm.project_id = pr.id AND pm.user_id = u.id
         ))`,
      [project.projectId, input.toUserId, this.#workspace(user)],
    );
    if (!target) return actionFail(404, '接收人不存在');
    const comments = input.includeComments
      ? this.#rows('SELECT * FROM comments WHERE task_id = ? ORDER BY created_at', [taskId])
      : [];
    const attachments = input.includeAttachments
      ? this.#rows('SELECT id, name FROM attachments WHERE task_id = ?', [taskId])
      : [];
    const id = randomUUID();
    const now = this.#now();
    const checklist = (input.checklist ?? this.#handoffChecklist(taskId)).map((item) => ({
      item: item.item,
      done: Boolean(item.done),
    }));
    const dueAt = input.dueAt ?? (task.due_date ? text(task, 'due_date') : null);
    this.#db
      .stmt(
        `INSERT INTO task_handoffs
           (id, task_id, from_user, to_user, status, summary_json, note, due_at, created_by,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        taskId,
        user.id,
        input.toUserId,
        JSON.stringify({
          task,
          comments,
          attachments,
          checklist,
          risks: input.risks ?? [],
        }),
        input.note ?? '',
        dueAt,
        user.id,
        now,
        now,
      );
    const row = this.#row('SELECT * FROM task_handoffs WHERE id = ?', [id]);
    this.#notify(input.toUserId, 'handoff', '有任务交接等待确认', taskId);
    this.#audit(user, 'task.handoff.create', taskId, { toUserId: input.toUserId });
    return actionOk(row ?? {});
  }

  decideHandoff(user: SessionUser, handoffId: string, input: HandoffDecision): ActionResult<Row> {
    const handoff = this.#row('SELECT * FROM task_handoffs WHERE id = ?', [handoffId]);
    if (!handoff) return actionFail(404, '交接记录不存在');
    if (text(handoff, 'to_user') !== user.id && !this.#manageWorkspace(user)) {
      return actionFail(403, '只有接收人可以确认交接');
    }
    if (text(handoff, 'status') !== 'pending') return actionFail(409, '交接已处理');
    const summary = jsonObject(handoff.summary_json);
    const checklist = Array.isArray(summary.checklist)
      ? (summary.checklist as { item?: string; done?: boolean }[])
      : [];
    const pending = checklist.filter((item) => !item.done);
    if (input.action === 'accept' && pending.length > 0 && !input.confirmChecklist) {
      return actionFail(400, `仍有 ${pending.length} 项交接检查未确认`);
    }
    const nextSummary =
      input.action === 'accept' && input.confirmChecklist && checklist.length > 0
        ? JSON.stringify({
            ...summary,
            checklist: checklist.map((item) => ({ ...item, done: true })),
          })
        : text(handoff, 'summary_json');
    const now = this.#now();
    const updated = this.#row(
      `UPDATE task_handoffs SET status = ?, accepted_at = ?, declined_reason = ?,
         summary_json = ?, version = version + 1, updated_at = ? WHERE id = ? RETURNING *`,
      [
        input.action === 'accept' ? 'accepted' : 'declined',
        input.action === 'accept' ? now : null,
        input.action === 'accept' ? '' : (input.note ?? ''),
        nextSummary,
        now,
        handoffId,
      ],
    );
    if (input.action === 'accept') {
      this.#db
        .stmt(
          `UPDATE project_tasks SET assignee_id = ?, updated_at = ?, version = version + 1
           WHERE id = ?`,
        )
        .run(user.id, now, text(handoff, 'task_id'));
    }
    this.#notify(
      text(handoff, 'from_user'),
      'handoff',
      `交接已${input.action === 'accept' ? '接受' : '拒绝'}`,
    );
    this.#audit(user, 'task.handoff.decide', text(handoff, 'task_id'), {
      action: input.action,
      note: input.note,
      before: handoff,
      after: updated,
    });
    return actionOk(updated ?? {});
  }

  tickHandoffs(user: SessionUser): ActionResult<Row> {
    if (!this.#manageWorkspace(user)) return actionFail(403, '没有运行交接超时升级的权限');
    const now = this.#now();
    const rows = this.#rows(
      `SELECT h.id, h.task_id, h.from_user, h.due_at, t.title AS task_title, p.owner_id
       FROM task_handoffs h
       JOIN project_tasks t ON t.id = h.task_id
       JOIN projects p ON p.id = t.project_id
       WHERE h.status = 'pending' AND h.due_at IS NOT NULL AND h.due_at <= ?
         AND p.workspace_id = ? AND p.deleted_at IS NULL
       ORDER BY h.due_at ASC LIMIT 200`,
      [now, this.#workspace(user)],
    );
    const escalated: string[] = [];
    for (const row of rows) {
      const updated = this.#row(
        `UPDATE task_handoffs SET status = 'expired', escalated_at = ?,
           version = version + 1, updated_at = ?
         WHERE id = ? AND status = 'pending' RETURNING *`,
        [now, now, text(row, 'id')],
      );
      if (!updated) continue;
      const title = text(row, 'task_title');
      this.#notify(
        text(row, 'owner_id'),
        'handoff',
        '任务交接超时，需要跟进',
        `${title}（接收人未在截止时间前确认）`,
      );
      this.#notify(
        text(row, 'from_user'),
        'handoff',
        '任务交接已超时',
        `${title} 的交接未按时确认，已升级给项目负责人`,
      );
      this.#audit(user, 'task.handoff.escalate', text(row, 'task_id'), {
        handoffId: text(row, 'id'),
        dueAt: text(row, 'due_at'),
      });
      escalated.push(text(row, 'id'));
    }
    return actionOk({ escalated, count: escalated.length });
  }

  // -------------------------------------------------------------------------
  // Deliverables
  // -------------------------------------------------------------------------

  addDeliverableVersion(
    user: SessionUser,
    deliverableId: string,
    input: DeliverableVersionCreate,
  ): ActionResult<Row> {
    const project = this.#store.domain.projectOfDeliverable(deliverableId, user);
    if (!project) return actionFail(404, '交付物不存在');
    const deliverable = this.#row('SELECT * FROM task_deliverables WHERE id = ?', [deliverableId]);
    if (!deliverable) return actionFail(404, '交付物不存在');
    if (input.attachmentId) {
      const attachment = this.#row('SELECT id FROM attachments WHERE id = ? AND task_id = ?', [
        input.attachmentId,
        text(deliverable, 'task_id'),
      ]);
      if (!attachment) return actionFail(400, '附件不存在或不属于当前任务');
    }
    const version = number(deliverable, 'current_version') + 1;
    const id = randomUUID();
    const now = this.#now();
    this.#db
      .stmt(
        `INSERT INTO deliverable_versions
           (id, deliverable_id, version, filename, checksum, attachment_id, note, status,
            uploaded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?)`,
      )
      .run(
        id,
        deliverableId,
        version,
        input.filename,
        input.checksum ?? '',
        input.attachmentId ?? null,
        input.note ?? '',
        user.id,
        now,
      );
    this.#db
      .stmt(
        `UPDATE task_deliverables SET current_version = ?, status = 'submitted',
           updated_at = ?, version = version + 1 WHERE id = ?`,
      )
      .run(version, now, deliverableId);
    const row = this.#row('SELECT * FROM deliverable_versions WHERE id = ?', [id]);
    this.#audit(user, 'deliverable.version.create', deliverableId, {
      version,
      filename: input.filename,
    });
    return actionOk(row ?? {});
  }

  reviewDeliverable(
    user: SessionUser,
    deliverableId: string,
    input: DeliverableReview,
  ): ActionResult<Row> {
    const project = this.#store.domain.projectOfDeliverable(deliverableId, user);
    if (!project) return actionFail(404, '交付物不存在');
    if (!this.#manage({ ownerId: project.projectOwnerId ?? '' }, user)) {
      return actionFail(403, '没有审阅交付物的权限');
    }
    const deliverable = this.#row('SELECT * FROM task_deliverables WHERE id = ?', [deliverableId]);
    if (!deliverable) return actionFail(404, '交付物不存在');
    if (text(deliverable, 'status') === 'approved') {
      return actionFail(409, '交付物已签收，需提交新版本后重新审阅');
    }
    const latest = this.#row(
      `SELECT * FROM deliverable_versions WHERE deliverable_id = ?
       ORDER BY version DESC LIMIT 1`,
      [deliverableId],
    );
    if (!latest) return actionFail(400, '交付物尚无版本');
    if (input.action === 'approve' && !text(latest, 'checksum')) {
      return actionFail(400, '签收前必须提供版本校验和');
    }
    const now = this.#now();
    const status = input.action === 'approve' ? 'approved' : 'rejected';
    const versionRow = this.#row(
      `UPDATE deliverable_versions SET status = ?, review_note = ?, reviewed_by = ?,
         reviewed_at = ? WHERE id = ? RETURNING *`,
      [status, input.note ?? '', user.id, now, text(latest, 'id')],
    );
    const updated = this.#row(
      `UPDATE task_deliverables SET status = ?, updated_at = ?, version = version + 1
       WHERE id = ? RETURNING *`,
      [status, now, deliverableId],
    );
    this.#audit(user, 'deliverable.review', deliverableId, {
      action: input.action,
      note: input.note ?? '',
      version: versionRow,
    });
    return actionOk(updated ?? {});
  }

  // -------------------------------------------------------------------------
  // Meetings
  // -------------------------------------------------------------------------

  completeMeeting(user: SessionUser, meetingId: string, input: MeetingComplete): ActionResult<Row> {
    const project = this.#store.domain.projectOfMeeting(meetingId, user);
    if (!project) return actionFail(404, '会议不存在');
    const meeting = this.#row('SELECT * FROM meetings WHERE id = ?', [meetingId]);
    if (!meeting) return actionFail(404, '会议不存在');
    if (number(meeting, 'version') !== input.version) {
      return actionFail(409, '会议已被其他会话修改', meeting);
    }
    const now = this.#now();
    const updated = this.#row(
      `UPDATE meetings SET status = 'completed', minutes = ?, version = version + 1,
         updated_at = ? WHERE id = ? AND version = ? RETURNING *`,
      [input.minutes, now, meetingId, input.version],
    );
    if (!updated) return actionFail(409, '会议已被其他会话修改');
    const actions: Row[] = [];
    for (const action of input.actions ?? []) {
      const id = randomUUID();
      this.#db
        .stmt(
          `INSERT INTO meeting_actions
             (id, meeting_id, title, assignee_id, due_on, status, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'open', 1, ?, ?)`,
        )
        .run(
          id,
          meetingId,
          action.title,
          action.assigneeId ?? null,
          action.dueOn ?? null,
          now,
          now,
        );
      const row = this.#row('SELECT * FROM meeting_actions WHERE id = ?', [id]);
      if (row) actions.push(row);
    }
    this.#audit(user, 'meeting.complete', meetingId, {
      before: meeting,
      after: updated,
      actions,
    });
    return actionOk({ meeting: updated, actions });
  }

  convertMeetingAction(
    user: SessionUser,
    actionId: string,
    input: MeetingActionConvert,
  ): ActionResult<Row> {
    const action = this.#row('SELECT * FROM meeting_actions WHERE id = ?', [actionId]);
    if (!action) return actionFail(404, '行动项不存在');
    const project = this.#store.domain.projectOfMeeting(text(action, 'meeting_id'), user);
    if (!project) return actionFail(404, '行动项不存在');
    if (text(action, 'task_id')) return actionFail(409, '行动项已转为任务');
    const projectId = input.projectId ?? project.projectId;
    if (!projectId || !this.#project(projectId, user)) return actionFail(404, '项目不存在');
    const task = this.#store.tasks.create(
      projectId,
      {
        title: text(action, 'title'),
        status: 'todo',
        priority: 'medium',
        assigneeId: nullableText(action, 'assignee_id') ?? user.id,
        dueDate: nullableText(action, 'due_on'),
      } as never,
      { id: user.id, name: user.name },
    );
    if (task.status !== 'ok') return actionFail(400, '任务创建失败');
    const now = this.#now();
    const updated = this.#row(
      `UPDATE meeting_actions SET task_id = ?, status = 'done', version = version + 1,
         updated_at = ? WHERE id = ? RETURNING *`,
      [task.task.id, now, actionId],
    );
    this.#audit(user, 'meeting.action.convert', actionId, { taskId: task.task.id });
    return actionOk(updated ?? {});
  }

  // -------------------------------------------------------------------------
  // Task tree, estimates and time summary
  // -------------------------------------------------------------------------

  taskTreeBulk(user: SessionUser, input: TaskTreeBulk): ActionResult<Row> {
    const project = this.#project(input.projectId, user);
    if (!project) return actionFail(404, '项目不存在');
    const tasks = this.#rows(
      `SELECT * FROM project_tasks WHERE project_id = ? AND id IN (${input.taskIds
        .map(() => '?')
        .join(', ')})`,
      [input.projectId, ...input.taskIds],
    );
    if (tasks.length !== input.taskIds.length) return actionFail(404, '任务不存在');
    if (input.action === 'sync') {
      return actionOk({ synced: tasks.length, tasks });
    }
    if (
      !this.#manage(project, user) &&
      !tasks.every((task) => text(task, 'assignee_id') === user.id)
    ) {
      return actionFail(403, '没有批量修改这些任务的权限');
    }
    const now = this.#now();
    const outcome = this.#db.transaction((): ActionResult<Row> => {
      const affected: Row[] = [];
      if (input.action === 'indent') {
        const ordered = [...tasks].sort(
          (a, b) => number(a, 'sort_order') - number(b, 'sort_order'),
        );
        const first = ordered[0];
        if (!first) return actionOk({ affected, count: 0 });
        const previous = this.#row(
          `SELECT * FROM project_tasks
           WHERE project_id = ? AND sort_order < ?
             AND (parent_id IS ? OR parent_id = ?)
           ORDER BY sort_order DESC LIMIT 1`,
          [
            input.projectId,
            number(first, 'sort_order'),
            typeof first.parent_id === 'string' ? first.parent_id : null,
            typeof first.parent_id === 'string' ? first.parent_id : null,
          ],
        );
        if (!previous) return actionFail(400, '同级任务中没有可挂载的上级任务');
        const previousId = text(previous, 'id');
        if (input.taskIds.includes(previousId)) return actionFail(400, '无法缩进到所选任务之下');
        for (const task of ordered) {
          if (text(task, 'id') === previousId) continue;
          const error = this.#store.tasks.validateMove(
            input.projectId,
            text(task, 'id'),
            previousId,
          );
          if (error) return actionFail(400, error);
          const updated = this.#row(
            `UPDATE project_tasks SET parent_id = ?, updated_at = ?, version = version + 1
             WHERE id = ? RETURNING *`,
            [previousId, now, text(task, 'id')],
          );
          if (updated) affected.push(updated);
        }
      } else if (input.action === 'outdent') {
        const parents = new Map<string, string | null>();
        for (const task of tasks) {
          const parentId = task.parent_id ? text(task, 'parent_id') : null;
          if (!parentId) {
            parents.set(text(task, 'id'), null);
            continue;
          }
          const parent = this.#row('SELECT parent_id FROM project_tasks WHERE id = ?', [parentId]);
          parents.set(text(task, 'id'), parent?.parent_id ? text(parent, 'parent_id') : null);
        }
        for (const task of tasks) {
          const nextParent = parents.get(text(task, 'id'));
          if (nextParent === undefined) continue;
          const error = this.#store.tasks.validateMove(
            input.projectId,
            text(task, 'id'),
            nextParent,
          );
          if (error) return actionFail(400, error);
          const updated = this.#row(
            `UPDATE project_tasks SET parent_id = ?, updated_at = ?, version = version + 1
             WHERE id = ? RETURNING *`,
            [nextParent, now, text(task, 'id')],
          );
          if (updated) affected.push(updated);
        }
      } else {
        for (const task of tasks) {
          if (input.version !== undefined && number(task, 'version') !== input.version) {
            return actionFail(409, '任务已被其他会话修改', task);
          }
          if (input.action === 'delete') {
            this.#db.stmt('DELETE FROM project_tasks WHERE id = ?').run(text(task, 'id'));
            continue;
          }
          if (input.action === 'status') {
            if (input.status === 'done') {
              const pending = this.#row(
                `SELECT COUNT(*) AS total FROM task_checklist_items
                 WHERE task_id = ? AND required = 1 AND done = 0`,
                [text(task, 'id')],
              );
              if (Number(pending?.total ?? 0) > 0) {
                return actionFail(400, `仍有 ${number(pending ?? {}, 'total')} 项必填检查未完成`);
              }
            }
            const updated = this.#row(
              `UPDATE project_tasks SET status = ?, completed_at = ?, updated_at = ?,
                 version = version + 1 WHERE id = ? RETURNING *`,
              [input.status ?? 'todo', input.status === 'done' ? now : null, now, text(task, 'id')],
            );
            if (updated) affected.push(updated);
            continue;
          }
          if (input.action === 'move') {
            const parent = input.parentId
              ? this.#row('SELECT * FROM project_tasks WHERE id = ? AND project_id = ?', [
                  input.parentId,
                  input.projectId,
                ])
              : null;
            if (input.parentId && !parent) return actionFail(404, '目标父任务不存在');
            const error = this.#store.tasks.validateMove(
              input.projectId,
              text(task, 'id'),
              input.parentId ?? null,
            );
            if (error) return actionFail(400, error);
            const updated = this.#row(
              `UPDATE project_tasks SET parent_id = ?, updated_at = ?, version = version + 1
               WHERE id = ? RETURNING *`,
              [input.parentId ?? null, now, text(task, 'id')],
            );
            if (updated) affected.push(updated);
          }
        }
      }
      return actionOk({ affected, count: affected.length });
    });
    if (!outcome.ok) return outcome;
    this.#store.tasks.reconcile(input.projectId);
    this.#audit(user, 'task.tree.bulk', input.projectId, {
      action: input.action,
      ids: input.taskIds,
    });
    return actionOk({ affected: outcome.data.affected, count: outcome.data.count });
  }

  #estimateSize(workspace: string, size: string | null | undefined): string | null {
    const value = size?.trim();
    if (!value) return null;
    const normalized = value.toLowerCase();
    const builtIn = ['xs', 's', 'm', 'l', 'xl', 'xxl', '2xl', '3xl'];
    if (builtIn.includes(normalized)) return value;
    const scales = this.#rows('SELECT values_json FROM estimate_scales WHERE workspace_id = ?', [
      workspace,
    ]);
    const known = scales.some((row) =>
      jsonArray(row.values_json).some(
        (entry) =>
          String((entry as Row).key ?? '')
            .trim()
            .toLowerCase() === normalized,
      ),
    );
    return known ? value : null;
  }

  updateEstimate(user: SessionUser, taskId: string, input: TaskEstimate): ActionResult<Row> {
    const project = this.#store.domain.projectOfTask(taskId, user);
    if (!project) return actionFail(404, '任务不存在');
    const task = this.#row('SELECT * FROM project_tasks WHERE id = ?', [taskId]);
    if (!task) return actionFail(404, '任务不存在');
    if (
      input.estimateSize != null &&
      !this.#estimateSize(this.#workspace(user), input.estimateSize)
    ) {
      return actionFail(400, '估算量级不在内置或自定义量级中');
    }
    const now = this.#now();
    const updated = this.#row(
      `UPDATE project_tasks SET estimate_points = ?, estimate_hours = ?, estimate_size = ?,
         updated_at = ?, version = version + 1 WHERE id = ? RETURNING *`,
      [
        input.estimatePoints ?? null,
        input.estimateHours ?? null,
        input.estimateSize ?? null,
        now,
        taskId,
      ],
    );
    this.#audit(user, 'task.estimate.update', taskId, { before: task, after: updated });
    return actionOk(updated ?? {});
  }

  listTaskTemplates(user: SessionUser): ActionResult<Row[]> {
    const rows = this.#rows(
      `SELECT * FROM task_templates WHERE workspace_id = ? ORDER BY created_at DESC`,
      [this.#workspace(user)],
    );
    return actionOk(rows.map((row) => this.#templateRow(row)));
  }

  #templateRow(row: Row): Row {
    return {
      ...row,
      tasks: jsonArray(row.tasks_json),
    };
  }

  createTaskTemplate(
    user: SessionUser,
    input: {
      name: string;
      description?: string;
      tasks: {
        title: string;
        description?: string;
        status?: string;
        priority?: string;
        estimateHours?: number;
        estimatePoints?: number;
        estimateSize?: string;
        parentIndex?: number;
        dueInDays?: number;
      }[];
    },
  ): ActionResult<Row> {
    if (!this.#manageWorkspace(user)) return actionFail(403, '没有管理任务模板的权限');
    for (const [index, task] of input.tasks.entries()) {
      if (task.parentIndex !== undefined && task.parentIndex >= index) {
        return actionFail(400, '模板任务的父任务必须在当前任务之前');
      }
    }
    const id = randomUUID();
    const now = this.#now();
    this.#db
      .stmt(
        `INSERT INTO task_templates
           (id, workspace_id, name, description, tasks_json, created_by, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        id,
        this.#workspace(user),
        input.name.trim(),
        input.description?.trim() ?? '',
        JSON.stringify(input.tasks),
        user.id,
        now,
        now,
      );
    const row = this.#row('SELECT * FROM task_templates WHERE id = ?', [id]);
    if (!row) return actionFail(500, '模板创建失败');
    this.#audit(user, 'task.template.create', id, { name: input.name, count: input.tasks.length });
    return actionOk(this.#templateRow(row));
  }

  deleteTaskTemplate(user: SessionUser, id: string): ActionResult<true> {
    if (!this.#manageWorkspace(user)) return actionFail(403, '没有管理任务模板的权限');
    const row = this.#row('SELECT id FROM task_templates WHERE id = ? AND workspace_id = ?', [
      id,
      this.#workspace(user),
    ]);
    if (!row) return actionFail(404, '模板不存在');
    this.#db.stmt('DELETE FROM task_templates WHERE id = ?').run(id);
    this.#audit(user, 'task.template.delete', id, {});
    return actionOk(true);
  }

  applyTaskTemplate(
    user: SessionUser,
    templateId: string,
    input: { projectId: string; startDate?: string; parentId?: string | null },
  ): ActionResult<Row> {
    const project = this.#project(input.projectId, user);
    if (!project) return actionFail(404, '项目不存在');
    if (!this.#manage(project, user)) return actionFail(403, '没有创建任务的权限');
    const template = this.#row('SELECT * FROM task_templates WHERE id = ? AND workspace_id = ?', [
      templateId,
      this.#workspace(user),
    ]);
    if (!template) return actionFail(404, '模板不存在');
    const tasks = jsonArray(template.tasks_json) as Row[];
    if (tasks.length === 0) return actionFail(400, '模板没有任务');
    const start = input.startDate ?? today();
    const workspace = this.#workspace(user);
    for (const [index, item] of tasks.entries()) {
      if (item.parentIndex !== undefined && item.parentIndex !== null) {
        const parentIndex = Number(item.parentIndex);
        if (!Number.isInteger(parentIndex) || parentIndex < 0 || parentIndex >= index) {
          return actionFail(400, '模板父任务索引无效');
        }
      }
      const size =
        item.estimateSize === undefined || item.estimateSize === null
          ? ''
          : String(item.estimateSize).trim();
      if (size && !this.#estimateSize(workspace, size)) {
        return actionFail(400, '模板估算量级不在内置或自定义量级中');
      }
      for (const entry of Array.isArray(item.checklist) ? (item.checklist as Row[]) : []) {
        if (!String(entry.label ?? '').trim()) return actionFail(400, '检查项名称不能为空');
        const formId = typeof entry.formId === 'string' ? entry.formId : null;
        if (formId) {
          const bound = this.#row('SELECT id FROM task_forms WHERE id = ? AND workspace_id = ?', [
            formId,
            workspace,
          ]);
          if (!bound) return actionFail(400, '模板引用的表单不存在');
        }
      }
    }
    let outcome: ActionResult<Row>;
    try {
      outcome = this.#db.transaction((): ActionResult<Row> => {
        const created: Row[] = [];
        const ids: string[] = [];
        const now = this.#now();
        for (const item of tasks) {
          const parentIndex =
            item.parentIndex === undefined || item.parentIndex === null
              ? undefined
              : Number(item.parentIndex);
          if (parentIndex !== undefined && ids[parentIndex] === undefined) {
            throw new TransactionFailure(400, '模板父任务索引无效');
          }
          const dueInDays = item.dueInDays === undefined ? null : Number(item.dueInDays);
          const result = this.#store.tasks.create(
            project.id,
            {
              title: String(item.title ?? ''),
              description: item.description ? String(item.description) : '',
              status: (item.status ?? 'todo') as 'todo' | 'in_progress' | 'review' | 'done',
              priority: (item.priority ?? 'medium') as 'low' | 'medium' | 'high' | 'urgent',
              parentId:
                input.parentId ?? (parentIndex === undefined ? undefined : ids[parentIndex]),
              dueDate: dueInDays === null ? null : addDays(start, dueInDays),
              estimateHours: item.estimateHours === undefined ? null : Number(item.estimateHours),
              estimatePoints:
                item.estimatePoints === undefined ? null : Number(item.estimatePoints),
              estimateSize:
                item.estimateSize === undefined ? null : String(item.estimateSize).trim(),
            },
            { id: user.id, name: user.name },
          );
          if (result.status !== 'ok') {
            throw new TransactionFailure(400, result.message);
          }
          const taskId = result.task.id;
          ids.push(taskId);
          created.push(result.task as unknown as Row);

          const checklist: { label: string; required: boolean; formId: string | null }[] = [];
          if (Array.isArray(item.checklist)) {
            for (const entry of item.checklist as Row[]) {
              checklist.push({
                label: String(entry.label ?? '').trim(),
                required: Boolean(entry.required),
                formId: typeof entry.formId === 'string' ? entry.formId : null,
              });
            }
          }
          const form =
            item.form && typeof item.form === 'object' && !Array.isArray(item.form)
              ? (item.form as { name?: unknown; fields?: unknown })
              : null;
          if (form) {
            const formId = randomUUID();
            const name = String(form.name ?? '').trim() || '模板表单';
            this.#db
              .stmt(
                `INSERT INTO task_forms
                   (id, workspace_id, name, schema_version, fields_json, active, created_by,
                    version, created_at, updated_at)
                 VALUES (?, ?, ?, 1, ?, 1, ?, 1, ?, ?)`,
              )
              .run(
                formId,
                workspace,
                name,
                JSON.stringify(Array.isArray(form.fields) ? form.fields : []),
                user.id,
                now,
                now,
              );
            checklist.push({ label: `填写表单：${name}`, required: true, formId });
          }
          for (const [position, entry] of checklist.entries()) {
            this.#db
              .stmt(
                `INSERT INTO task_checklist_items
                   (id, task_id, form_id, label, required, done, sort_order, created_at)
                 VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
              )
              .run(
                randomUUID(),
                taskId,
                entry.formId,
                entry.label,
                entry.required ? 1 : 0,
                position,
                now,
              );
          }
        }
        return actionOk({ templateId, projectId: project.id, tasks: created });
      });
    } catch (error) {
      if (error instanceof TransactionFailure) return actionFail(error.status, error.message);
      throw error;
    }
    if (!outcome.ok) return outcome;
    const applied = outcome.data.tasks as Row[];
    this.#audit(user, 'task.template.apply', project.id, {
      templateId,
      taskIds: applied.map((task) => text(task, 'id')),
    });
    return outcome;
  }

  listEstimateScales(user: SessionUser): ActionResult<Row[]> {
    const rows = this.#rows(
      'SELECT * FROM estimate_scales WHERE workspace_id = ? ORDER BY created_at DESC',
      [this.#workspace(user)],
    );
    return actionOk(rows.map((row) => ({ ...row, values: jsonArray(row.values_json) })));
  }

  createEstimateScale(
    user: SessionUser,
    input: { name: string; values: { key: string; label: string; points?: number }[] },
  ): ActionResult<Row> {
    if (!this.#manageWorkspace(user)) return actionFail(403, '没有管理估算量级的权限');
    const keys = new Set(input.values.map((value) => value.key.trim().toLowerCase()));
    if (keys.size !== input.values.length) return actionFail(400, '估算量级键不能重复');
    const id = randomUUID();
    const now = this.#now();
    this.#db
      .stmt(
        `INSERT INTO estimate_scales
           (id, workspace_id, name, values_json, created_by, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        id,
        this.#workspace(user),
        input.name.trim(),
        JSON.stringify(input.values),
        user.id,
        now,
        now,
      );
    const row = this.#row('SELECT * FROM estimate_scales WHERE id = ?', [id]);
    if (!row) return actionFail(500, '估算量级创建失败');
    this.#audit(user, 'estimate.scale.create', id, { name: input.name });
    return actionOk({ ...row, values: input.values });
  }

  timeSummary(user: SessionUser, projectId?: string, taskId?: string): ActionResult<Row> {
    if (taskId) {
      const project = this.#store.domain.projectOfTask(taskId, user);
      if (!project) return actionFail(404, '任务不存在');
    } else if (projectId && !this.#project(projectId, user)) {
      return actionFail(404, '项目不存在');
    }
    const clauses = ['1 = 1'];
    const params: (string | number)[] = [];
    if (taskId) {
      clauses.push('l.task_id = ?');
      params.push(taskId);
    } else if (projectId) {
      clauses.push('t.project_id = ?');
      params.push(projectId);
    }
    const rows = this.#rows(
      `SELECT l.user_id, u.name AS user_name, SUM(l.minutes) AS minutes, COUNT(*) AS entries
       FROM task_time_logs l
       JOIN project_tasks t ON t.id = l.task_id
       LEFT JOIN users u ON u.id = l.user_id
       WHERE ${clauses.join(' AND ')}
       GROUP BY l.user_id
       ORDER BY minutes DESC`,
      params,
    );
    const total = rows.reduce((sum, row) => sum + number(row, 'minutes'), 0);
    return actionOk({ totalMinutes: total, byUser: rows });
  }

  // -------------------------------------------------------------------------
  // Knowledge and collaboration
  // -------------------------------------------------------------------------

  #hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  #visibleProjectIds(user: SessionUser): string[] {
    return [...this.#store.projects.visibleProjectIds(user.role, user.id)].filter((id) => {
      const project = this.#store.projects.get(id, 'admin', user.id);
      return project?.workspaceId === this.#workspace(user);
    });
  }

  addKnowledgeLink(user: SessionUser, input: KnowledgeLinkCreate): ActionResult<Row> {
    if (input.fromType === input.toType && input.fromId === input.toId) {
      return actionFail(400, '不能链接到自身');
    }
    if (input.fromType === 'document') {
      const doc = this.#row(
        `SELECT d.* FROM project_documents d JOIN projects p ON p.id = d.project_id
         WHERE d.id = ? AND p.workspace_id = ? AND p.deleted_at IS NULL`,
        [input.fromId, this.#workspace(user)],
      );
      if (!doc || !this.#project(text(doc, 'project_id'), user)) {
        return actionFail(404, '源文档不存在');
      }
    }
    const id = randomUUID();
    this.#db
      .stmt(
        `INSERT INTO knowledge_links
           (id, workspace_id, from_type, from_id, to_type, to_id, label, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (from_type, from_id, to_type, to_id) DO NOTHING`,
      )
      .run(
        id,
        this.#workspace(user),
        input.fromType,
        input.fromId,
        input.toType,
        input.toId,
        input.label ?? '',
        user.id,
        this.#now(),
      );
    this.#audit(user, 'knowledge.link.create', id, input);
    return actionOk({ id, ...input });
  }

  #knowledgeNode(user: SessionUser, type: string, id: string, visible: Set<string>): Row | null {
    const workspace = this.#workspace(user);
    if (type === 'document') {
      const row = this.#row(
        `SELECT d.id, 'document' AS type, d.title AS label, d.project_id, d.status AS status
         FROM project_documents d JOIN projects p ON p.id = d.project_id
         WHERE d.id = ? AND p.workspace_id = ? AND p.deleted_at IS NULL`,
        [id, workspace],
      );
      return row && visible.has(text(row, 'project_id')) ? row : null;
    }
    if (type === 'decision') {
      const row = this.#row(
        `SELECT c.id, 'decision' AS type, c.title AS label, c.project_id, c.status AS status
         FROM decisions c LEFT JOIN projects p ON p.id = c.project_id
         WHERE c.id = ? AND c.workspace_id = ?
           AND (c.project_id IS NULL OR p.deleted_at IS NULL)`,
        [id, workspace],
      );
      if (!row) return null;
      const projectId = text(row, 'project_id');
      return projectId && !visible.has(projectId) ? null : row;
    }
    if (type === 'task') {
      const row = this.#row(
        `SELECT t.id, 'task' AS type, t.title AS label, t.project_id, t.status AS status
         FROM project_tasks t JOIN projects p ON p.id = t.project_id
         WHERE t.id = ? AND p.workspace_id = ? AND p.deleted_at IS NULL`,
        [id, workspace],
      );
      return row && visible.has(text(row, 'project_id')) ? row : null;
    }
    if (type === 'playbook') {
      return this.#row(
        `SELECT id, 'playbook' AS type, title AS label, NULL AS project_id,
                NULL AS status
         FROM playbooks WHERE id = ? AND workspace_id = ?`,
        [id, workspace],
      );
    }
    return null;
  }

  #resolveKnowledgeNode(user: SessionUser, id: string, visible: Set<string>): Row | null {
    for (const type of ['document', 'decision', 'task', 'playbook']) {
      const node = this.#knowledgeNode(user, type, id, visible);
      if (node) return node;
    }
    return null;
  }

  knowledgeGraph(user: SessionUser, input: KnowledgeGraphQuery): ActionResult<Row> {
    const projectIds = input.projectId ? [input.projectId] : this.#visibleProjectIds(user);
    if (input.projectId && !this.#project(input.projectId, user)) {
      return actionFail(404, '项目不存在');
    }
    if (input.focus) {
      const visible = new Set(projectIds);
      const focusNode = this.#resolveKnowledgeNode(user, input.focus, visible);
      if (!focusNode) return actionFail(404, '节点不存在');
      const key = (type: unknown, id: unknown) => `${String(type)}:${String(id)}`;
      const nodes = new Map<string, Row>([[key(focusNode.type, focusNode.id), focusNode]]);
      const links = this.#rows(
        `SELECT * FROM knowledge_links WHERE workspace_id = ?
           AND (from_id = ? OR to_id = ?) ORDER BY created_at DESC LIMIT ?`,
        [this.#workspace(user), input.focus, input.focus, input.limit * 4],
      );
      const edges: Row[] = [];
      for (const link of links) {
        if (nodes.size >= input.limit) break;
        const from = this.#knowledgeNode(
          user,
          text(link, 'from_type'),
          text(link, 'from_id'),
          visible,
        );
        const to = this.#knowledgeNode(user, text(link, 'to_type'), text(link, 'to_id'), visible);
        if (!from || !to) continue;
        const fromKey = key(from.type, from.id);
        const toKey = key(to.type, to.id);
        if (nodes.size + Number(!nodes.has(fromKey)) + Number(!nodes.has(toKey)) > input.limit) {
          continue;
        }
        nodes.set(fromKey, from);
        nodes.set(toKey, to);
        edges.push({
          id: link.id,
          fromType: link.from_type,
          fromId: link.from_id,
          toType: link.to_type,
          toId: link.to_id,
          label: link.label,
        });
      }
      return actionOk({ nodes: [...nodes.values()], edges, orphans: [], focus: input.focus });
    }
    if (projectIds.length === 0) return actionOk({ nodes: [], edges: [], orphans: [] });
    const placeholders = projectIds.map(() => '?').join(', ');
    const like = `%${input.q ?? ''}%`;
    const documents = this.#rows(
      `SELECT d.id, 'document' AS type, d.title AS label, d.project_id
       FROM project_documents d JOIN projects p ON p.id = d.project_id
       WHERE d.project_id IN (${placeholders}) AND p.deleted_at IS NULL
         AND (? = '' OR d.title LIKE ?)
       ORDER BY d.updated_at DESC LIMIT ?`,
      [...projectIds, input.q ?? '', like, input.limit],
    );
    const decisions = this.#rows(
      `SELECT c.id, 'decision' AS type, c.title AS label, c.project_id
       FROM decisions c JOIN projects p ON p.id = c.project_id
       WHERE c.project_id IN (${placeholders}) AND p.deleted_at IS NULL
         AND (? = '' OR c.title LIKE ?)
       ORDER BY c.updated_at DESC LIMIT ?`,
      [...projectIds, input.q ?? '', like, input.limit],
    );
    const tasks = this.#rows(
      `SELECT t.id, 'task' AS type, t.title AS label, t.project_id
       FROM project_tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.project_id IN (${placeholders}) AND p.deleted_at IS NULL
         AND (? = '' OR t.title LIKE ?)
       ORDER BY t.created_at DESC LIMIT ?`,
      [...projectIds, input.q ?? '', like, input.limit],
    );
    const nodes = [...documents, ...decisions, ...tasks].slice(0, input.limit);
    const ids = nodes.map((node) => text(node, 'id'));
    const idSet = new Set(ids);
    const links = this.#rows(`SELECT * FROM knowledge_links WHERE workspace_id = ? LIMIT ?`, [
      this.#workspace(user),
      input.limit * 4,
    ]);
    const edges = links
      .filter((link) => idSet.has(text(link, 'from_id')) || idSet.has(text(link, 'to_id')))
      .map((link) => ({
        id: link.id,
        fromType: link.from_type,
        fromId: link.from_id,
        toType: link.to_type,
        toId: link.to_id,
        label: link.label,
      }));
    const linked = new Set(edges.flatMap((edge) => [edge.fromId, edge.toId]));
    const orphans = nodes
      .filter((node) => text(node, 'type') === 'document' && !linked.has(text(node, 'id')))
      .map((node) => ({ id: node.id, title: node.label, projectId: node.project_id }));
    return actionOk({ nodes, edges, orphans });
  }

  knowledgeSearch(user: SessionUser, input: KnowledgeSearchQuery): ActionResult<Row> {
    const types = input.types
      ? input.types
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : ['document', 'decision', 'task', 'playbook', 'comment', 'attachment'];
    const projectIds = input.projectId ? [input.projectId] : this.#visibleProjectIds(user);
    if (input.projectId && !this.#project(input.projectId, user)) {
      return actionFail(404, '项目不存在');
    }
    const baseTerm = input.q.trim().toLowerCase();
    const terms = new Map<string, string>([[baseTerm, input.q.trim()]]);
    const synonymRows = this.#rows(
      'SELECT term, synonyms_json FROM search_synonyms WHERE workspace_id = ?',
      [this.#workspace(user)],
    );
    for (const row of synonymRows) {
      const term = text(row, 'term');
      const synonyms = jsonArray(row.synonyms_json).map(String);
      const candidates = [term, ...synonyms].map((value) => value.toLowerCase());
      const matched = candidates.some(
        (value) => value.length >= 2 && (baseTerm.includes(value) || value.includes(baseTerm)),
      );
      if (matched) {
        for (const value of [term, ...synonyms]) {
          if (value.trim().length > 0) terms.set(value.toLowerCase(), value);
        }
      }
    }
    const termList = [...terms.values()].slice(0, 8);
    const likes = termList.map((term) => `%${term}%`);
    const result: Row[] = [];
    if (projectIds.length > 0) {
      const placeholders = projectIds.map(() => '?').join(', ');
      if (types.includes('document')) {
        const where = termList.map(() => '(d.title LIKE ? OR d.content LIKE ?)').join(' OR ');
        result.push(
          ...this.#rows(
            `SELECT d.id, 'document' AS type, d.title, d.project_id, d.status,
                    substr(d.content, 1, 160) AS snippet, d.updated_at AS created_at
             FROM project_documents d JOIN projects p ON p.id = d.project_id
             WHERE d.project_id IN (${placeholders}) AND p.deleted_at IS NULL AND (${where})
             ORDER BY d.updated_at DESC LIMIT ?`,
            [...projectIds, ...likes.flatMap((like) => [like, like]), input.limit],
          ),
        );
      }
      if (types.includes('decision')) {
        const where = termList.map(() => '(c.title LIKE ? OR c.decision LIKE ?)').join(' OR ');
        result.push(
          ...this.#rows(
            `SELECT c.id, 'decision' AS type, c.title, c.project_id, c.status,
                    substr(c.decision, 1, 160) AS snippet, c.updated_at AS created_at
             FROM decisions c JOIN projects p ON p.id = c.project_id
             WHERE c.project_id IN (${placeholders}) AND p.deleted_at IS NULL AND (${where})
             ORDER BY c.updated_at DESC LIMIT ?`,
            [...projectIds, ...likes.flatMap((like) => [like, like]), input.limit],
          ),
        );
      }
      if (types.includes('task')) {
        const where = termList.map(() => '(t.title LIKE ? OR t.description LIKE ?)').join(' OR ');
        result.push(
          ...this.#rows(
            `SELECT t.id, 'task' AS type, t.title, t.project_id, t.status,
                    substr(t.description, 1, 160) AS snippet, t.updated_at AS created_at
             FROM project_tasks t JOIN projects p ON p.id = t.project_id
             WHERE t.project_id IN (${placeholders}) AND p.deleted_at IS NULL AND (${where})
             ORDER BY t.updated_at DESC LIMIT ?`,
            [...projectIds, ...likes.flatMap((like) => [like, like]), input.limit],
          ),
        );
      }
      if (types.includes('comment') || types.includes('document_comment')) {
        const where = termList.map(() => 'c.body LIKE ?').join(' OR ');
        result.push(
          ...this.#rows(
            `SELECT c.id, 'comment' AS type, d.title, d.project_id, c.status,
                    substr(c.body, 1, 160) AS snippet, c.document_id, c.created_at
             FROM document_comments c
             JOIN project_documents d ON d.id = c.document_id
             JOIN projects p ON p.id = d.project_id
             WHERE d.project_id IN (${placeholders}) AND p.deleted_at IS NULL AND (${where})
             ORDER BY c.created_at DESC LIMIT ?`,
            [...projectIds, ...likes, input.limit],
          ),
        );
      }
      if (types.includes('attachment')) {
        const where = termList.map(() => 'a.name LIKE ?').join(' OR ');
        result.push(
          ...this.#rows(
            `SELECT a.id, 'attachment' AS type, a.name AS title, p.id AS project_id,
                    a.id AS attachment_id,
                    substr(a.mime || ' · ' || a.size || ' 字节', 1, 160) AS snippet,
                    a.created_at
             FROM attachments a
             LEFT JOIN project_tasks t ON t.id = a.task_id
             JOIN projects p ON p.id = COALESCE(a.project_id, t.project_id)
             WHERE p.id IN (${placeholders}) AND p.deleted_at IS NULL AND (${where})
             ORDER BY a.created_at DESC LIMIT ?`,
            [...projectIds, ...likes, input.limit],
          ),
        );
      }
    }
    if (types.includes('playbook')) {
      const where = termList.map(() => '(title LIKE ? OR content LIKE ?)').join(' OR ');
      result.push(
        ...this.#rows(
          `SELECT id, 'playbook' AS type, title, NULL AS project_id, NULL AS status,
                  substr(content, 1, 160) AS snippet, updated_at AS created_at
           FROM playbooks WHERE workspace_id = ? AND (${where})
           ORDER BY updated_at DESC LIMIT ?`,
          [this.#workspace(user), ...likes.flatMap((like) => [like, like]), input.limit],
        ),
      );
    }
    const weight: Record<string, number> = {
      document: 10,
      decision: 8,
      task: 6,
      playbook: 5,
      comment: 4,
      attachment: 3,
    };
    const scored = result
      .map((row): Row => {
        const title = String(row.title ?? '').toLowerCase();
        const snippet = String(row.snippet ?? '').toLowerCase();
        let score = weight[String(row.type)] ?? 0;
        for (const term of termList) {
          const value = term.toLowerCase();
          if (title === value) score += 120;
          else if (title.startsWith(value)) score += 70;
          else if (title.includes(value)) score += 45;
          if (snippet.includes(value)) score += 20;
        }
        return { ...row, score };
      })
      .sort((left, right) => Number(right.score) - Number(left.score))
      .slice(0, input.limit);
    return actionOk({
      query: input.q,
      expandedTerms: termList,
      total: result.length,
      results: scored.map((row) => ({
        type: row.type,
        id: row.id,
        title: row.title,
        projectId: row.project_id ?? null,
        snippet: row.snippet ?? '',
        score: row.score,
        documentId: row.document_id ?? null,
        attachmentId: row.attachment_id ?? null,
        status: row.status ?? null,
        createdAt: row.created_at ?? null,
      })),
    });
  }

  knowledgeReviewQueue(user: SessionUser): ActionResult<Row> {
    const projectIds = this.#visibleProjectIds(user);
    if (projectIds.length === 0)
      return actionOk({ items: [], counts: { documents: 0, decisions: 0, orphans: 0 } });
    const placeholders = projectIds.map(() => '?').join(', ');
    const day = today();
    const documents = this.#rows(
      `SELECT d.id, 'document' AS type, d.title, d.project_id, d.review_due_at, d.updated_at,
              CASE WHEN d.review_due_at IS NOT NULL AND d.review_due_at <= ? THEN 1 ELSE 0 END AS overdue
       FROM project_documents d JOIN projects p ON p.id = d.project_id
       WHERE d.project_id IN (${placeholders}) AND p.deleted_at IS NULL
         AND (d.review_due_at IS NOT NULL AND d.review_due_at <= ?
              OR NOT EXISTS (SELECT 1 FROM knowledge_links l
                             WHERE l.from_type = 'document' AND l.from_id = d.id))
       ORDER BY overdue DESC, d.review_due_at ASC LIMIT 50`,
      [day, ...projectIds, day],
    );
    const decisions = this.#rows(
      `SELECT c.id, 'decision' AS type, c.title, c.project_id, c.review_at,
              c.updated_at, 1 AS overdue
       FROM decisions c JOIN projects p ON p.id = c.project_id
       WHERE c.project_id IN (${placeholders}) AND p.deleted_at IS NULL
         AND c.review_at IS NOT NULL AND c.review_at <= ?
       ORDER BY c.review_at ASC LIMIT 50`,
      [...projectIds, day],
    );
    const items = [...documents, ...decisions];
    return actionOk({
      items,
      counts: {
        documents: documents.length,
        decisions: decisions.length,
        orphans: documents.filter((doc) => number(doc, 'overdue') === 0).length,
      },
    });
  }

  createDocumentComment(
    user: SessionUser,
    documentId: string,
    input: DocumentCommentCreate,
  ): ActionResult<Row> {
    const doc = this.#row('SELECT * FROM project_documents WHERE id = ?', [documentId]);
    if (!doc) return actionFail(404, '文档不存在');
    const project = this.#project(text(doc, 'project_id'), user);
    if (!project) return actionFail(404, '文档不存在');
    const now = this.#now();
    const id = randomUUID();
    this.#db
      .stmt(
        `INSERT INTO document_comments
           (id, document_id, author_id, anchor_json, body, status, suggestion_json,
            assignee_id, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?, 1, ?, ?)`,
      )
      .run(
        id,
        documentId,
        user.id,
        JSON.stringify(input.anchor ?? {}),
        input.body,
        JSON.stringify(input.suggestion ?? {}),
        input.assigneeId ?? null,
        now,
        now,
      );
    this.#audit(user, 'document.comment.create', id, { documentId, body: input.body });
    if (input.assigneeId) {
      this.#notify(input.assigneeId, 'document_comment', '你有一条新的文档评论', input.body);
    }
    return actionOk(this.#row('SELECT * FROM document_comments WHERE id = ?', [id]) ?? {});
  }

  resolveDocumentComment(
    user: SessionUser,
    commentId: string,
    input: DocumentCommentResolve,
  ): ActionResult<Row> {
    const comment = this.#row('SELECT * FROM document_comments WHERE id = ?', [commentId]);
    if (!comment) return actionFail(404, '评论不存在');
    const doc = this.#row('SELECT * FROM project_documents WHERE id = ?', [
      text(comment, 'document_id'),
    ]);
    if (!doc) return actionFail(404, '评论不存在');
    const project = this.#project(text(doc, 'project_id'), user);
    if (!project) return actionFail(404, '评论不存在');
    const manager = this.#manage(project, user);
    if (
      !manager &&
      text(comment, 'author_id') !== user.id &&
      text(comment, 'assignee_id') !== user.id
    ) {
      return actionFail(403, '没有处理该评论的权限');
    }
    if (number(comment, 'version') !== input.version) {
      return actionFail(409, '评论已被其他会话修改', comment);
    }
    const now = this.#now();
    const status = input.action === 'reopen' ? 'open' : 'resolved';
    const updated = this.#row(
      `UPDATE document_comments SET status = ?, resolved_by = ?, resolved_at = ?,
         version = version + 1, updated_at = ? WHERE id = ? AND version = ? RETURNING *`,
      [
        status,
        status === 'resolved' ? user.id : null,
        status === 'resolved' ? now : null,
        now,
        commentId,
        input.version,
      ],
    );
    if (!updated) return actionFail(409, '评论已被其他会话修改');
    if (input.action === 'accept' && manager) {
      const suggestion = jsonObject(comment.suggestion_json);
      const replacement = typeof suggestion.replacement === 'string' ? suggestion.replacement : '';
      const anchor = jsonObject(comment.anchor_json);
      const quote = typeof anchor.quote === 'string' ? anchor.quote : '';
      if (replacement) {
        const content = text(doc, 'content');
        const nextContent =
          quote && content.includes(quote)
            ? content.replace(quote, replacement)
            : `${content}\n\n${replacement}`;
        const version = number(doc, 'version') + 1;
        this.#db
          .stmt(
            `UPDATE project_documents SET content = ?, version = ?, updated_at = ? WHERE id = ?`,
          )
          .run(nextContent, version, now, text(doc, 'id'));
        this.#db
          .stmt(
            `INSERT INTO document_versions
               (id, document_id, version, title, content, change_summary, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            text(doc, 'id'),
            version,
            text(doc, 'title'),
            nextContent,
            `接受评论建议 ${commentId}`,
            user.id,
            now,
          );
      }
    }
    this.#audit(user, `document.comment.${input.action}`, commentId, {
      before: comment,
      after: updated,
    });
    return actionOk(updated);
  }

  listDocumentComments(user: SessionUser, documentId: string): ActionResult<Row> {
    const doc = this.#row(
      `SELECT d.* FROM project_documents d JOIN projects p ON p.id = d.project_id
       WHERE d.id = ? AND p.workspace_id = ? AND p.deleted_at IS NULL`,
      [documentId, this.#workspace(user)],
    );
    if (!doc || !this.#project(text(doc, 'project_id'), user)) {
      return actionFail(404, '文档不存在');
    }
    const rows = this.#rows(
      `SELECT c.*, u.name AS author_name, a.name AS assignee_name
       FROM document_comments c
       LEFT JOIN users u ON u.id = c.author_id
       LEFT JOIN users a ON a.id = c.assignee_id
       WHERE c.document_id = ?
       ORDER BY CASE WHEN c.status = 'open' THEN 0 ELSE 1 END, c.created_at DESC`,
      [documentId],
    );
    return actionOk({
      items: rows.map((row) => ({
        id: row.id,
        body: row.body,
        status: row.status,
        anchor: jsonObject(row.anchor_json),
        suggestion: jsonObject(row.suggestion_json),
        authorId: row.author_id ?? null,
        authorName: text(row, 'author_name'),
        assigneeId: row.assignee_id ?? null,
        assigneeName: text(row, 'assignee_name'),
        version: row.version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        resolvedAt: row.resolved_at ?? null,
      })),
    });
  }

  documentDiff(user: SessionUser, documentId: string, input: DocumentDiff): ActionResult<Row> {
    const doc = this.#row(
      `SELECT d.* FROM project_documents d JOIN projects p ON p.id = d.project_id
       WHERE d.id = ? AND p.workspace_id = ? AND p.deleted_at IS NULL`,
      [documentId, this.#workspace(user)],
    );
    if (!doc || !this.#project(text(doc, 'project_id'), user)) {
      return actionFail(404, '文档不存在');
    }
    const pool = new Map<number, Row>();
    pool.set(0, {
      version: 0,
      title: '',
      content: '',
      change_summary: '初始版本',
      created_at: doc.created_at,
    });
    const versions = this.#rows(
      `SELECT version, title, content, change_summary, created_at
       FROM document_versions WHERE document_id = ? ORDER BY version ASC`,
      [documentId],
    );
    for (const version of versions) pool.set(number(version, 'version'), version);
    const currentVersion = number(doc, 'version');
    pool.set(currentVersion, {
      version: currentVersion,
      title: doc.title,
      content: doc.content,
      change_summary: '当前版本',
      created_at: doc.updated_at,
    });
    const ordered = [...pool.values()].sort(
      (left, right) => number(left, 'version') - number(right, 'version'),
    );
    const latest = number(ordered[ordered.length - 1] ?? {}, 'version');
    const previous =
      ordered.length > 1 ? number(ordered[ordered.length - 2] ?? {}, 'version') : latest;
    const fromVersion = input.from ?? previous;
    const toVersion = input.to ?? latest;
    const before = pool.get(fromVersion);
    const after = pool.get(toVersion);
    if (!before || !after) return actionFail(404, '版本不存在');
    if (fromVersion === toVersion) return actionFail(400, '请选择不同的版本进行对比');
    const diff = diffLines(text(before, 'content'), text(after, 'content'));
    return actionOk({
      documentId,
      title: doc.title,
      from: {
        version: fromVersion,
        title: before.title,
        changeSummary: before.change_summary,
        createdAt: before.created_at,
      },
      to: {
        version: toVersion,
        title: after.title,
        changeSummary: after.change_summary,
        createdAt: after.created_at,
      },
      titleChanged: text(before, 'title') !== text(after, 'title'),
      lines: diff.lines,
      stats: diff.stats,
      truncated: diff.truncated,
    });
  }

  listKnowledgeSynonyms(user: SessionUser): ActionResult<Row> {
    const rows = this.#rows(
      `SELECT term, synonyms_json, created_at FROM search_synonyms
       WHERE workspace_id = ? ORDER BY term ASC`,
      [this.#workspace(user)],
    );
    return actionOk({
      items: rows.map((row) => ({
        term: row.term,
        synonyms: jsonArray(row.synonyms_json).map(String),
        createdAt: row.created_at,
      })),
    });
  }

  createKnowledgeSynonym(user: SessionUser, input: KnowledgeSynonymCreate): ActionResult<Row> {
    if (!this.#manageWorkspace(user)) return actionFail(403, '没有管理知识库的权限');
    const term = input.term.trim();
    const synonyms = [...new Set(input.synonyms.map((item) => item.trim()).filter(Boolean))];
    this.#db
      .stmt(
        `INSERT INTO search_synonyms (workspace_id, term, synonyms_json, created_by, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, term)
         DO UPDATE SET synonyms_json = excluded.synonyms_json`,
      )
      .run(this.#workspace(user), term, JSON.stringify(synonyms), user.id, this.#now());
    this.#audit(user, 'knowledge.synonym.upsert', term, { synonyms });
    return actionOk({ term, synonyms });
  }

  deleteKnowledgeSynonym(user: SessionUser, term: string): ActionResult<Row> {
    if (!this.#manageWorkspace(user)) return actionFail(403, '没有管理知识库的权限');
    const result = this.#db
      .stmt('DELETE FROM search_synonyms WHERE workspace_id = ? AND term = ?')
      .run(this.#workspace(user), term);
    if (Number(result.changes) === 0) return actionFail(404, '词条不存在');
    this.#audit(user, 'knowledge.synonym.delete', term, {});
    return actionOk({ term, deleted: true });
  }

  subscribeChannel(user: SessionUser, channelId: string): ActionResult<Row> {
    const channel = this.#row('SELECT * FROM discussion_channels WHERE id = ?', [channelId]);
    if (!channel || !this.#project(text(channel, 'project_id'), user)) {
      return actionFail(404, '频道不存在');
    }
    this.#db
      .stmt(
        `INSERT INTO channel_subscriptions (channel_id, user_id, created_at)
         VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(channelId, user.id, this.#now());
    return actionOk({ channelId, subscribed: true });
  }

  unsubscribeChannel(user: SessionUser, channelId: string): ActionResult<Row> {
    this.#db
      .stmt('DELETE FROM channel_subscriptions WHERE channel_id = ? AND user_id = ?')
      .run(channelId, user.id);
    return actionOk({ channelId, subscribed: false });
  }

  postChannelMessage(
    user: SessionUser,
    channelId: string,
    input: ChannelMessageCreate,
  ): ActionResult<Row> {
    const channel = this.#row('SELECT * FROM discussion_channels WHERE id = ?', [channelId]);
    if (!channel || !this.#project(text(channel, 'project_id'), user)) {
      return actionFail(404, '频道不存在');
    }
    const project = this.#project(text(channel, 'project_id'), user);
    if (number(channel, 'read_only') === 1 && !this.#manage(project ?? { ownerId: '' }, user)) {
      return actionFail(403, '频道为只读');
    }
    const now = this.#now();
    const id = randomUUID();
    this.#db
      .stmt(
        `INSERT INTO channel_messages
           (id, channel_id, author_id, body, parent_id, pinned, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        channelId,
        user.id,
        input.body,
        input.parentId ?? null,
        input.pinned ? 1 : 0,
        now,
        now,
      );
    const members = [
      ...jsonArray(channel.member_ids_json).map(String),
      ...this.#rows('SELECT user_id FROM channel_subscriptions WHERE channel_id = ?', [
        channelId,
      ]).map((row) => text(row, 'user_id')),
    ];
    for (const member of new Set(members)) {
      if (member !== user.id) {
        this.#notify(member, 'channel_message', `#${text(channel, 'name')} 有新消息`, input.body);
      }
    }
    this.#audit(user, 'channel.message.create', id, { channelId });
    this.#publish('channel.message.created', { channelId, messageId: id }, user);
    return actionOk(this.#row('SELECT * FROM channel_messages WHERE id = ?', [id]) ?? {});
  }

  updateChannelMessage(
    user: SessionUser,
    messageId: string,
    input: ChannelMessageUpdate,
  ): ActionResult<Row> {
    const message = this.#row('SELECT * FROM channel_messages WHERE id = ?', [messageId]);
    if (!message) return actionFail(404, '消息不存在');
    const channel = this.#row('SELECT * FROM discussion_channels WHERE id = ?', [
      text(message, 'channel_id'),
    ]);
    const project = channel ? this.#project(text(channel, 'project_id'), user) : null;
    if (!channel || !project) return actionFail(404, '消息不存在');
    if (text(message, 'author_id') !== user.id && !this.#manage(project, user)) {
      return actionFail(403, '只能编辑自己的消息');
    }
    const now = this.#now();
    const updated = this.#row(
      `UPDATE channel_messages SET body = ?, edited_at = ?, updated_at = ?
       WHERE id = ? RETURNING *`,
      [input.body, now, now, messageId],
    );
    this.#audit(user, 'channel.message.update', messageId, { before: message, after: updated });
    return actionOk(updated ?? {});
  }

  messageToTask(user: SessionUser, messageId: string, projectId?: string): ActionResult<Row> {
    const message = this.#row('SELECT * FROM channel_messages WHERE id = ?', [messageId]);
    if (!message) return actionFail(404, '消息不存在');
    const channel = this.#row('SELECT * FROM discussion_channels WHERE id = ?', [
      text(message, 'channel_id'),
    ]);
    if (!channel) return actionFail(404, '消息不存在');
    const targetProjectId = projectId ?? text(channel, 'project_id');
    const project = this.#project(targetProjectId, user);
    if (!project) return actionFail(404, '项目不存在');
    const created = this.#store.tasks.create(
      targetProjectId,
      {
        title: text(message, 'body').slice(0, 200),
        description: text(message, 'body'),
        status: 'todo',
        priority: 'medium',
      } as never,
      { id: user.id, name: user.name },
    );
    if (created.status !== 'ok') {
      return actionFail(400, created.status === 'invalid' ? created.message : '任务创建失败');
    }
    this.#db
      .stmt('UPDATE channel_messages SET task_id = ?, updated_at = ? WHERE id = ?')
      .run(created.task.id, this.#now(), messageId);
    this.#audit(user, 'channel.message.to_task', messageId, { taskId: created.task.id });
    return actionOk({ messageId, task: created.task });
  }

  searchChannelMessages(
    user: SessionUser,
    channelId: string,
    input: ChannelSearch,
  ): ActionResult<Row> {
    const channel = this.#row('SELECT * FROM discussion_channels WHERE id = ?', [channelId]);
    if (!channel || !this.#project(text(channel, 'project_id'), user)) {
      return actionFail(404, '频道不存在');
    }
    const rows = this.#rows(
      `SELECT m.id, m.body, m.parent_id, m.pinned, m.task_id, m.author_id,
              m.created_at, m.updated_at, u.name AS author_name
       FROM channel_messages m LEFT JOIN users u ON u.id = m.author_id
       WHERE m.channel_id = ? AND m.deleted_at IS NULL AND m.body LIKE ?
       ORDER BY m.pinned DESC, m.created_at DESC LIMIT ?`,
      [channelId, `%${input.q}%`, input.limit],
    );
    return actionOk({
      channelId,
      query: input.q,
      total: rows.length,
      messages: rows.map((row) => ({
        id: row.id,
        body: row.body,
        parentId: row.parent_id ?? null,
        pinned: number(row, 'pinned') === 1,
        taskId: row.task_id ?? null,
        authorId: row.author_id ?? null,
        authorName: text(row, 'author_name'),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    });
  }

  publishRetro(user: SessionUser, retroId: string): ActionResult<Row> {
    const retro = this.#row('SELECT * FROM retrospectives WHERE id = ?', [retroId]);
    if (!retro || !this.#project(text(retro, 'project_id'), user)) {
      return actionFail(404, '复盘不存在');
    }
    const project = this.#project(text(retro, 'project_id'), user);
    if (!project || !this.#manage(project, user)) return actionFail(403, '没有发布复盘的权限');
    if (text(retro, 'status') === 'published') return actionOk({ retro, playbookId: null });
    const now = this.#now();
    const updated = this.#row(
      `UPDATE retrospectives SET status = 'published', version = version + 1, updated_at = ?
       WHERE id = ? RETURNING *`,
      [now, retroId],
    );
    const lessons = jsonArray(retro.lessons_json).map(String);
    const improvements = jsonArray(retro.improvements_json).map(String);
    const content = [
      lessons.length ? `经验教训:\n${lessons.map((item) => `- ${item}`).join('\n')}` : '',
      improvements.length ? `改进项:\n${improvements.map((item) => `- ${item}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const playbookId = randomUUID();
    this.#db
      .stmt(
        `INSERT INTO playbooks
           (id, workspace_id, title, source_retro_id, scope, content, feedback_json,
            version, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, '[]', 1, ?, ?, ?)`,
      )
      .run(
        playbookId,
        this.#workspace(user),
        text(retro, 'title'),
        retroId,
        project.name ?? '',
        content,
        user.id,
        now,
        now,
      );
    this.#audit(user, 'retro.publish', retroId, { playbookId });
    this.#publish('retro.published', { retroId, playbookId }, user);
    return actionOk({ retro: updated, playbookId });
  }

  playbookFeedback(
    user: SessionUser,
    playbookId: string,
    input: PlaybookFeedback,
  ): ActionResult<Row> {
    const playbook = this.#row('SELECT * FROM playbooks WHERE id = ?', [playbookId]);
    if (!playbook || text(playbook, 'workspace_id') !== this.#workspace(user)) {
      return actionFail(404, 'Playbook 不存在');
    }
    const feedback = [
      ...jsonArray(playbook.feedback_json),
      {
        userId: user.id,
        useful: input.useful,
        note: input.note ?? '',
        reference: input.reference ?? '',
        at: this.#now(),
      },
    ];
    const updated = this.#row(
      `UPDATE playbooks SET feedback_json = ?, version = version + 1, updated_at = ?
       WHERE id = ? RETURNING *`,
      [JSON.stringify(feedback), this.#now(), playbookId],
    );
    this.#audit(user, 'playbook.feedback', playbookId, input);
    return actionOk(updated ?? {});
  }

  // -------------------------------------------------------------------------
  // Customer portal
  // -------------------------------------------------------------------------

  createPortal(user: SessionUser, projectId: string, input: PortalCreate): ActionResult<Row> {
    const project = this.#project(projectId, user);
    if (!project) return actionFail(404, '项目不存在');
    if (!this.#manage(project, user)) return actionFail(403, '没有创建客户门户的权限');
    if (this.#row('SELECT 1 AS hit FROM customer_portals WHERE project_id = ?', [projectId])) {
      return actionFail(409, '该项目已存在客户门户');
    }
    const now = this.#now();
    const id = randomUUID();
    this.#db
      .stmt(
        `INSERT INTO customer_portals
           (id, project_id, name, active, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(id, projectId, input.name, user.id, now, now);
    let token: string | null = null;
    if (input.accountEmail) {
      token = `np_${randomUUID().replaceAll('-', '')}`;
      this.#db
        .stmt(
          `INSERT INTO portal_accounts (id, portal_id, email, name, token_hash, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?)`,
        )
        .run(
          randomUUID(),
          id,
          input.accountEmail,
          input.accountName ?? input.accountEmail,
          this.#hash(token),
          now,
        );
    }
    this.#audit(user, 'portal.create', id, { projectId, name: input.name });
    return actionOk({
      portal: this.#row('SELECT * FROM customer_portals WHERE id = ?', [id]),
      token,
    });
  }

  createPortalAccount(
    user: SessionUser,
    portalId: string,
    input: PortalAccountCreate,
  ): ActionResult<Row> {
    const portal = this.#row('SELECT * FROM customer_portals WHERE id = ?', [portalId]);
    if (!portal || !this.#project(text(portal, 'project_id'), user)) {
      return actionFail(404, '客户门户不存在');
    }
    const project = this.#project(text(portal, 'project_id'), user);
    if (!project || !this.#manage(project, user)) return actionFail(403, '没有管理客户门户的权限');
    const token = `np_${randomUUID().replaceAll('-', '')}`;
    const id = randomUUID();
    try {
      this.#db
        .stmt(
          `INSERT INTO portal_accounts (id, portal_id, email, name, token_hash, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?)`,
        )
        .run(id, portalId, input.email, input.name, this.#hash(token), this.#now());
    } catch {
      return actionFail(409, '该邮箱已开通门户账号');
    }
    this.#audit(user, 'portal.account.create', id, { portalId, email: input.email });
    return actionOk({ id, portalId, email: input.email, name: input.name, token });
  }

  #portalByToken(token: string) {
    if (!token) return null;
    const account = this.#row(
      `SELECT a.*, p.project_id, p.name AS portal_name, p.active AS portal_active
       FROM portal_accounts a JOIN customer_portals p ON p.id = a.portal_id
       WHERE a.token_hash = ? AND a.status = 'active'`,
      [this.#hash(token)],
    );
    if (!account || number(account, 'portal_active') !== 1) return null;
    const project = this.#row('SELECT id, name, status, progress FROM projects WHERE id = ?', [
      text(account, 'project_id'),
    ]);
    if (!project) return null;
    return { account, project };
  }

  portalView(token: string): ActionResult<Row> {
    const access = this.#portalByToken(token);
    if (!access) return actionFail(404, '门户链接无效');
    const requests = this.#rows(
      `SELECT id, title, body, status, progress_note, attachments_json, created_at, updated_at,
              (SELECT COUNT(*) FROM portal_request_comments c
               WHERE c.request_id = portal_requests.id AND c.internal = 0) AS comment_count
       FROM portal_requests WHERE portal_id = ? ORDER BY created_at DESC`,
      [text(access.account, 'portal_id')],
    );
    const comments = this.#rows(
      `SELECT c.* FROM portal_request_comments c
       JOIN portal_requests r ON r.id = c.request_id
       WHERE r.portal_id = ? AND c.internal = 0 ORDER BY c.created_at ASC`,
      [text(access.account, 'portal_id')],
    );
    return actionOk({
      portal: { id: access.account.portal_id, name: access.account.portal_name },
      account: { name: access.account.name, email: access.account.email },
      project: access.project,
      requests,
      comments,
    });
  }

  portalSubmit(token: string, input: PortalRequestCreate): ActionResult<Row> {
    const access = this.#portalByToken(token);
    if (!access) return actionFail(404, '门户链接无效');
    const now = this.#now();
    const id = randomUUID();
    this.#db
      .stmt(
        `INSERT INTO portal_requests
           (id, portal_id, account_id, title, body, status, progress_note, attachments_json,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'submitted', '', ?, ?, ?)`,
      )
      .run(
        id,
        text(access.account, 'portal_id'),
        text(access.account, 'id'),
        input.title,
        input.body ?? '',
        JSON.stringify(input.attachments ?? []),
        now,
        now,
      );
    const owners = this.#rows(
      `SELECT owner_id FROM projects WHERE id = ? AND owner_id IS NOT NULL`,
      [text(access.project, 'id')],
    );
    for (const owner of owners) {
      this.#notify(text(owner, 'owner_id'), 'portal_request', '客户提交了新需求', input.title);
    }
    const projectRow = this.#row('SELECT workspace_id FROM projects WHERE id = ?', [
      text(access.project, 'id'),
    ]);
    this.#store.domain.publishEvent(
      text(projectRow ?? {}, 'workspace_id') || this.#workspaceFromProject(),
      'portal.request.created',
      { requestId: id, projectId: access.project.id, title: input.title },
      null,
    );
    this.#store.domain.audit(null, 'portal.request.create', id, {
      portalId: text(access.account, 'portal_id'),
      accountId: text(access.account, 'id'),
    });
    return actionOk({
      request: this.#row('SELECT * FROM portal_requests WHERE id = ?', [id]),
    });
  }

  #workspaceFromProject(): string {
    return 'ws_default';
  }

  portalUpdateRequest(
    token: string,
    requestId: string,
    input: PortalRequestUpdate,
  ): ActionResult<Row> {
    const access = this.#portalByToken(token);
    if (!access) return actionFail(404, '门户链接无效');
    const request = this.#row('SELECT * FROM portal_requests WHERE id = ?', [requestId]);
    if (!request || text(request, 'portal_id') !== text(access.account, 'portal_id')) {
      return actionFail(404, '需求不存在');
    }
    const updated = this.#row(
      `UPDATE portal_requests SET status = ?, progress_note = ?, updated_at = ?
       WHERE id = ? RETURNING *`,
      [
        input.status ?? text(request, 'status'),
        input.progressNote ?? text(request, 'progress_note'),
        this.#now(),
        requestId,
      ],
    );
    this.#store.domain.audit(null, 'portal.request.update', requestId, {
      portalId: text(access.account, 'portal_id'),
      accountId: text(access.account, 'id'),
      before: { status: text(request, 'status') },
      after: { status: text(updated ?? {}, 'status') },
    });
    return actionOk(updated ?? {});
  }

  #portalRequestForStaff(user: SessionUser, requestId: string) {
    const request = this.#row('SELECT * FROM portal_requests WHERE id = ?', [requestId]);
    if (!request) return null;
    const portal = this.#row('SELECT * FROM customer_portals WHERE id = ?', [
      text(request, 'portal_id'),
    ]);
    if (!portal) return null;
    const project = this.#project(text(portal, 'project_id'), user);
    if (!project) return null;
    return { request, portal, project };
  }

  #mapPortalComment(row: Row) {
    return {
      id: row.id,
      requestId: row.request_id,
      body: row.body,
      internal: number(row, 'internal') === 1,
      authorKind: row.author_kind,
      authorId: row.author_id ?? null,
      authorName: row.author_name,
      accountId: row.account_id ?? null,
      createdAt: row.created_at,
    };
  }

  listPortalRequests(user: SessionUser, portalId: string): ActionResult<Row> {
    const portal = this.#row('SELECT * FROM customer_portals WHERE id = ?', [portalId]);
    if (!portal) return actionFail(404, '客户门户不存在');
    const project = this.#project(text(portal, 'project_id'), user);
    if (!project) return actionFail(404, '客户门户不存在');
    const requests = this.#rows(
      `SELECT r.*,
              (SELECT COUNT(*) FROM portal_request_comments c
               WHERE c.request_id = r.id AND c.internal = 0) AS comment_count
       FROM portal_requests r WHERE r.portal_id = ? ORDER BY r.created_at DESC`,
      [portalId],
    );
    return actionOk({
      portal: { id: portal.id, name: portal.name, active: portal.active },
      project,
      requests,
    });
  }

  portalRequestComments(token: string, requestId: string): ActionResult<Row> {
    const access = this.#portalByToken(token);
    if (!access) return actionFail(404, '门户链接无效');
    const request = this.#row('SELECT * FROM portal_requests WHERE id = ?', [requestId]);
    if (!request || text(request, 'portal_id') !== text(access.account, 'portal_id')) {
      return actionFail(404, '需求不存在');
    }
    const rows = this.#rows(
      `SELECT * FROM portal_request_comments
       WHERE request_id = ? AND internal = 0 ORDER BY created_at ASC`,
      [requestId],
    );
    return actionOk({ requestId, comments: rows.map((row) => this.#mapPortalComment(row)) });
  }

  portalAddComment(token: string, requestId: string, input: PortalComment): ActionResult<Row> {
    const access = this.#portalByToken(token);
    if (!access) return actionFail(404, '门户链接无效');
    const request = this.#row('SELECT * FROM portal_requests WHERE id = ?', [requestId]);
    if (!request || text(request, 'portal_id') !== text(access.account, 'portal_id')) {
      return actionFail(404, '需求不存在');
    }
    if (text(request, 'status') === 'closed') {
      return actionFail(409, '需求已关闭，无法继续回复');
    }
    const now = this.#now();
    const id = randomUUID();
    this.#db
      .stmt(
        `INSERT INTO portal_request_comments
           (id, request_id, account_id, author_id, author_name, author_kind, body, internal, created_at)
         VALUES (?, ?, ?, NULL, ?, 'customer', ?, 0, ?)`,
      )
      .run(
        id,
        requestId,
        text(access.account, 'id'),
        text(access.account, 'name'),
        input.body,
        now,
      );
    const owners = this.#rows(
      'SELECT owner_id FROM projects WHERE id = ? AND owner_id IS NOT NULL',
      [text(access.project, 'id')],
    );
    for (const owner of owners) {
      this.#notify(text(owner, 'owner_id'), 'portal_comment', '客户回复了门户需求', input.body);
    }
    const created = this.#row('SELECT * FROM portal_request_comments WHERE id = ?', [id]);
    this.#store.domain.audit(null, 'portal.request.comment', requestId, {
      commentId: id,
      portalId: text(access.account, 'portal_id'),
      accountId: text(access.account, 'id'),
    });
    return actionOk(created ? this.#mapPortalComment(created) : { id });
  }

  staffPortalRequestComments(user: SessionUser, requestId: string): ActionResult<Row> {
    const found = this.#portalRequestForStaff(user, requestId);
    if (!found) return actionFail(404, '需求不存在');
    const rows = this.#rows(
      'SELECT * FROM portal_request_comments WHERE request_id = ? ORDER BY created_at ASC',
      [requestId],
    );
    return actionOk({
      request: found.request,
      comments: rows.map((row) => this.#mapPortalComment(row)),
    });
  }

  addPortalInternalComment(
    user: SessionUser,
    requestId: string,
    input: PortalInternalComment,
  ): ActionResult<Row> {
    const found = this.#portalRequestForStaff(user, requestId);
    if (!found) return actionFail(404, '需求不存在');
    if (text(found.request, 'status') === 'closed') {
      return actionFail(409, '需求已关闭，无法继续回复');
    }
    const now = this.#now();
    const id = randomUUID();
    this.#db
      .stmt(
        `INSERT INTO portal_request_comments
           (id, request_id, account_id, author_id, author_name, author_kind, body, internal, created_at)
         VALUES (?, ?, NULL, ?, ?, 'staff', ?, ?, ?)`,
      )
      .run(id, requestId, user.id, user.name, input.body, input.internal === false ? 0 : 1, now);
    this.#audit(user, 'portal.request.comment', requestId, {
      body: input.body,
      internal: input.internal !== false,
    });
    const created = this.#row('SELECT * FROM portal_request_comments WHERE id = ?', [id]);
    return actionOk(created ? this.#mapPortalComment(created) : { id });
  }

  confirmPortalDelivery(
    user: SessionUser,
    requestId: string,
    input: PortalDeliveryConfirm,
  ): ActionResult<Row> {
    const found = this.#portalRequestForStaff(user, requestId);
    if (!found) return actionFail(404, '需求不存在');
    if (!this.#manage(found.project, user)) {
      return actionFail(403, '没有确认交付的权限');
    }
    const status = text(found.request, 'status');
    if (status === 'closed') return actionFail(409, '需求已关闭');
    if (status === 'delivered') return actionFail(409, '需求已确认交付');
    const now = this.#now();
    const note = input.note?.trim() ?? '';
    const updated = this.#row(
      `UPDATE portal_requests SET status = 'delivered',
         progress_note = CASE WHEN ? = '' THEN progress_note ELSE ? END,
         updated_at = ? WHERE id = ? RETURNING *`,
      [note, note, now, requestId],
    );
    if (!updated) return actionFail(409, '需求状态已变化');
    this.#db
      .stmt(
        `INSERT INTO portal_request_comments
           (id, request_id, account_id, author_id, author_name, author_kind, body, internal, created_at)
         VALUES (?, ?, NULL, ?, ?, 'staff', ?, 0, ?)`,
      )
      .run(
        randomUUID(),
        requestId,
        user.id,
        user.name,
        note ? `已确认交付：${note}` : '已确认交付',
        now,
      );
    this.#audit(user, 'portal.request.deliver', requestId, { note });
    this.#publish('portal.request.delivered', { requestId, projectId: found.project.id }, user);
    return actionOk({ request: updated });
  }

  portalConfirmDelivery(
    token: string,
    requestId: string,
    input: PortalDeliveryConfirm,
  ): ActionResult<Row> {
    const access = this.#portalByToken(token);
    if (!access) return actionFail(404, '门户链接无效');
    const request = this.#row('SELECT * FROM portal_requests WHERE id = ?', [requestId]);
    if (!request || text(request, 'portal_id') !== text(access.account, 'portal_id')) {
      return actionFail(404, '需求不存在');
    }
    if (text(request, 'delivery_confirmed_at')) {
      return actionOk({ request, replayed: true });
    }
    if (text(request, 'status') !== 'delivered') {
      return actionFail(409, '需求尚未交付，无法确认');
    }
    const now = this.#now();
    const note = input.note?.trim() ?? '';
    const updated = this.#row(
      `UPDATE portal_requests SET delivery_confirmed_at = ?, delivery_confirmed_by = ?,
         status = 'closed', progress_note = CASE WHEN ? = '' THEN progress_note ELSE ? END,
         updated_at = ? WHERE id = ? AND delivery_confirmed_at IS NULL RETURNING *`,
      [now, text(access.account, 'id'), note, note, now, requestId],
    );
    if (!updated) {
      const current = this.#row('SELECT * FROM portal_requests WHERE id = ?', [requestId]);
      return actionOk({ request: current, replayed: true });
    }
    this.#db
      .stmt(
        `INSERT INTO portal_request_comments
           (id, request_id, account_id, author_id, author_name, author_kind, body, internal, created_at)
         VALUES (?, ?, ?, NULL, ?, 'customer', ?, 0, ?)`,
      )
      .run(
        randomUUID(),
        requestId,
        text(access.account, 'id'),
        text(access.account, 'name'),
        note ? `客户已确认交付：${note}` : '客户已确认交付',
        now,
      );
    this.#store.domain.audit(null, 'portal.request.confirm', requestId, {
      portalId: text(access.account, 'portal_id'),
      accountId: text(access.account, 'id'),
      note,
    });
    const projectRow = this.#row('SELECT workspace_id FROM projects WHERE id = ?', [
      text(access.project, 'id'),
    ]);
    this.#store.domain.publishEvent(
      text(projectRow ?? {}, 'workspace_id') || this.#workspaceFromProject(),
      'portal.request.confirmed',
      { requestId, projectId: text(access.project, 'id') },
      null,
    );
    return actionOk({ request: updated, replayed: false });
  }

  // -------------------------------------------------------------------------
  // Workflows
  // -------------------------------------------------------------------------

  #workflow(user: SessionUser, id: string) {
    const workflow = this.#row('SELECT * FROM workflows WHERE id = ?', [id]);
    if (!workflow || text(workflow, 'workspace_id') !== this.#workspace(user)) return null;
    if (text(workflow, 'project_id')) {
      const project = this.#project(text(workflow, 'project_id'), user);
      if (!project) return null;
    }
    return workflow;
  }

  #validateWorkflow(definition: {
    nodes: { id: string; type: string }[];
    edges: { from: string; to: string }[];
  }): string | null {
    const ids = new Set(definition.nodes.map((node) => node.id));
    if (ids.size !== definition.nodes.length) return '节点 ID 必须唯一';
    if (!definition.nodes.some((node) => node.type === 'start')) return '工作流必须包含开始节点';
    if (!definition.nodes.some((node) => node.type === 'end')) return '工作流必须包含结束节点';
    for (const edge of definition.edges) {
      if (!ids.has(edge.from) || !ids.has(edge.to))
        return `连线引用了不存在的节点 ${edge.from}→${edge.to}`;
    }
    const outgoing = new Map<string, string[]>();
    for (const edge of definition.edges) {
      outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
    }
    const visiting = new Set<string>();
    const done = new Set<string>();
    const walk = (id: string): boolean => {
      if (visiting.has(id)) return false;
      if (done.has(id)) return true;
      visiting.add(id);
      for (const next of outgoing.get(id) ?? []) {
        if (!walk(next)) return false;
      }
      visiting.delete(id);
      done.add(id);
      return true;
    };
    for (const node of definition.nodes) {
      if (!walk(node.id)) return '工作流连线存在环';
    }
    return null;
  }

  publishWorkflow(
    user: SessionUser,
    workflowId: string,
    input: WorkflowPublish,
  ): ActionResult<Row> {
    const workflow = this.#workflow(user, workflowId);
    if (!workflow) return actionFail(404, '工作流不存在');
    if (!this.#manageWorkspace(user)) return actionFail(403, '没有发布工作流的权限');
    const definition = jsonObject(workflow.definition_json) as unknown as {
      nodes?: { id: string; type: string }[];
      edges?: { from: string; to: string }[];
    };
    if (!definition.nodes || !definition.edges) return actionFail(400, '工作流定义不完整');
    const problem = this.#validateWorkflow({
      nodes: definition.nodes,
      edges: definition.edges,
    });
    if (problem) return actionFail(400, problem);
    const now = this.#now();
    const version = number(workflow, 'version') + 1;
    this.#db
      .stmt(
        `INSERT INTO workflow_versions
           (id, workflow_id, version, definition_json, change_summary, published_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        workflowId,
        version,
        JSON.stringify(definition),
        input.changeSummary ?? '',
        user.id,
        now,
      );
    const updated = this.#row(
      `UPDATE workflows SET status = 'published', version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? RETURNING *`,
      [now, workflowId, number(workflow, 'version')],
    );
    if (!updated) return actionFail(409, '工作流已被其他会话修改');
    this.#audit(user, 'workflow.publish', workflowId, {
      version,
      changeSummary: input.changeSummary ?? '',
    });
    this.#publish('workflow.published', { workflowId, version }, user);
    return actionOk(updated);
  }

  #runWorkflowNode(
    user: SessionUser,
    workflow: Row,
    runId: string,
    node: { id: string; type: string; name?: string; config?: Record<string, unknown> },
    mode: 'live' | 'test',
  ): { output: Row; wait: boolean } {
    const output: Record<string, unknown> = { node: node.id, type: node.type };
    let wait = false;
    if (mode === 'live') {
      if (node.type === 'task') {
        const projectId = text(workflow, 'project_id');
        if (projectId) {
          const title = String(node.config?.title ?? node.name ?? '工作流任务');
          const created = this.#store.tasks.create(
            projectId,
            { title: title.slice(0, 200), status: 'todo', priority: 'medium' } as never,
            { id: user.id, name: user.name },
          );
          if (created.status === 'ok') output.taskId = created.task.id;
        }
      } else if (node.type === 'notify') {
        const target = String(node.config?.userId ?? text(workflow, 'created_by') ?? '');
        if (target) {
          this.#notify(
            target,
            'workflow',
            String(node.config?.title ?? '工作流通知'),
            String(node.config?.body ?? ''),
          );
          output.notified = target;
        }
      } else if (node.type === 'webhook') {
        this.#publish(
          'workflow.webhook',
          { workflowId: text(workflow, 'id'), runId, node: node.id },
          user,
        );
        output.published = true;
      } else if (node.type === 'approval') {
        const approvers = Array.isArray(node.config?.approverIds)
          ? (node.config?.approverIds as string[])
          : [];
        if (approvers.length === 0) {
          output.skipped = 'no approver';
        } else {
          const approvalId = randomUUID();
          const now = this.#now();
          this.#db
            .stmt(
              `INSERT INTO approval_requests
                 (id, workspace_id, project_id, title, kind, status, amount_cents, risk,
                  steps_json, current_step, resource_type, resource_id, requested_by,
                  due_at, version, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'workflow', 'pending', 0, 'low', ?, 0, 'workflow_run',
                       ?, ?, NULL, 1, ?, ?)`,
            )
            .run(
              approvalId,
              this.#workspace(user),
              text(workflow, 'project_id') || null,
              `工作流审批: ${text(workflow, 'name')}`,
              JSON.stringify([{ name: '审批', approverIds: approvers, mode: 'all' }]),
              runId,
              user.id,
              now,
              now,
            );
          for (const approver of approvers) {
            this.#notify(approver, 'approval', '有新的工作流审批待处理', text(workflow, 'name'));
          }
          output.approvalId = approvalId;
          wait = true;
        }
      } else if (node.type === 'delay') {
        const ms = Math.min(Number(node.config?.ms ?? 0) || 0, 2000);
        if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(ms, 50));
        output.delayed = ms;
      }
    }
    const previous = this.#row(
      `SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt FROM workflow_run_events
       WHERE run_id = ? AND node_id = ?`,
      [runId, node.id],
    );
    this.#event('workflow_run_events', {
      id: randomUUID(),
      run_id: runId,
      node_id: node.id,
      status: wait ? 'waiting' : 'completed',
      output_json: JSON.stringify(output),
      attempt: number(previous ?? {}, 'attempt') || 1,
      created_at: this.#now(),
    });
    return { output, wait };
  }

  #executeWorkflow(
    user: SessionUser,
    workflow: Row,
    runId: string,
    input: Record<string, unknown>,
    mode: 'live' | 'test',
    limits: Record<string, unknown>,
  ): { status: 'completed' | 'waiting' | 'failed'; trace: Row[]; error: string | null } {
    const definition = jsonObject(workflow.definition_json) as unknown as {
      nodes?: { id: string; type: string; name?: string; config?: Record<string, unknown> }[];
      edges?: { from: string; to: string; condition?: string }[];
    };
    const nodes = definition.nodes ?? [];
    const edges = definition.edges ?? [];
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const current = nodes.find((node) => node.type === 'start');
    if (!current) return { status: 'failed', trace: [], error: '缺少开始节点' };
    const maxActions = Math.min(Number(limits.maxActions ?? 50) || 50, 100);
    const maxMs = Math.min(Number(limits.maxMs ?? 5000) || 5000, 60_000);
    const started = Date.now();
    const trace: Row[] = [];
    let node: { id: string; type: string; name?: string; config?: Record<string, unknown> } | null =
      current;
    let steps = 0;
    while (node && steps < maxActions) {
      const active: { id: string; type: string; name?: string; config?: Record<string, unknown> } =
        node;
      steps += 1;
      if (Date.now() - started > maxMs) {
        return { status: 'failed', trace, error: '执行超出时间限制' };
      }
      const { output, wait } = this.#runWorkflowNode(user, workflow, runId, active, mode);
      trace.push(output);
      if (active.type === 'end') return { status: 'completed', trace, error: null };
      if (wait) return { status: 'waiting', trace, error: null };
      const nextEdge: { from: string; to: string; condition?: string } | undefined = edges.find(
        (edge) =>
          edge.from === active.id &&
          (!edge.condition || Boolean(input[edge.condition]) || edge.condition === 'always'),
      );
      node = nextEdge ? (byId.get(nextEdge.to) ?? null) : null;
    }
    if (steps >= maxActions) return { status: 'failed', trace, error: '执行步骤超出限制' };
    return { status: 'failed', trace, error: '工作流未到达结束节点' };
  }

  #startWorkflow(
    user: SessionUser,
    workflow: Row,
    input: WorkflowRunStart,
    mode: 'live' | 'test',
    replayOf: string | null = null,
  ): ActionResult<Row> {
    const now = this.#now();
    if (input.idempotencyKey) {
      const existing = this.#row('SELECT * FROM workflow_runs WHERE idempotency_key = ?', [
        input.idempotencyKey,
      ]);
      if (existing) return actionOk(existing);
    }
    const runId = randomUUID();
    const limits = jsonObject(workflow.sandbox_limits_json);
    // Insert the run before executing: run events reference it via foreign key.
    this.#db
      .stmt(
        `INSERT INTO workflow_runs
           (id, workflow_id, workflow_version, status, mode, input_json, state_json,
            current_node, error, idempotency_key, started_by, started_at, finished_at, replay_of)
         VALUES (?, ?, ?, 'running', ?, ?, '{}', NULL, NULL, ?, ?, ?, NULL, ?)`,
      )
      .run(
        runId,
        text(workflow, 'id'),
        number(workflow, 'version'),
        mode,
        JSON.stringify(input.input ?? {}),
        input.idempotencyKey ?? null,
        user.id,
        now,
        replayOf,
      );
    let result: { status: 'completed' | 'waiting' | 'failed'; trace: Row[]; error: string | null };
    try {
      result = this.#executeWorkflow(user, workflow, runId, input.input ?? {}, mode, limits);
    } catch (error) {
      this.#db
        .stmt(`UPDATE workflow_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`)
        .run(error instanceof Error ? error.message : 'run failed', this.#now(), runId);
      throw error;
    }
    const lastNode = result.trace.at(-1)?.node;
    this.#db
      .stmt(
        `UPDATE workflow_runs
           SET status = ?, state_json = ?, current_node = ?, error = ?, finished_at = ?
         WHERE id = ?`,
      )
      .run(
        result.status,
        JSON.stringify({ trace: result.trace }),
        typeof lastNode === 'string' ? lastNode : null,
        result.error,
        result.status === 'waiting' ? null : this.#now(),
        runId,
      );
    this.#audit(user, `workflow.${mode}.run`, runId, {
      workflowId: workflow.id,
      status: result.status,
      steps: result.trace.length,
    });
    this.#publish('workflow.run', { workflowId: workflow.id, runId, status: result.status }, user);
    return actionOk(this.#row('SELECT * FROM workflow_runs WHERE id = ?', [runId]) ?? {});
  }

  testWorkflow(user: SessionUser, workflowId: string, input: WorkflowTest): ActionResult<Row> {
    const workflow = this.#workflow(user, workflowId);
    if (!workflow) return actionFail(404, '工作流不存在');
    return this.#startWorkflow(user, workflow, { input: input.input, mode: 'test' }, 'test');
  }

  runWorkflow(user: SessionUser, workflowId: string, input: WorkflowRunStart): ActionResult<Row> {
    const workflow = this.#workflow(user, workflowId);
    if (!workflow) return actionFail(404, '工作流不存在');
    if (text(workflow, 'status') !== 'published' && input.mode !== 'test') {
      return actionFail(409, '工作流尚未发布');
    }
    return this.#startWorkflow(user, workflow, input, input.mode === 'test' ? 'test' : 'live');
  }

  replayWorkflow(user: SessionUser, workflowId: string, input: WorkflowReplay): ActionResult<Row> {
    const workflow = this.#workflow(user, workflowId);
    if (!workflow) return actionFail(404, '工作流不存在');
    const source = this.#row('SELECT * FROM workflow_runs WHERE id = ? AND workflow_id = ?', [
      input.fromRunId,
      workflowId,
    ]);
    if (!source) return actionFail(404, '运行记录不存在');
    const mode = text(source, 'mode') === 'test' ? 'test' : 'live';
    if (mode === 'live' && text(workflow, 'status') !== 'published') {
      return actionFail(409, '工作流尚未发布');
    }
    const sourceInput = input.input ?? jsonObject(source.input_json);
    const result = this.#startWorkflow(
      user,
      workflow,
      { input: sourceInput },
      mode,
      text(source, 'id'),
    );
    if (result.ok) {
      this.#audit(user, 'workflow.replay', text(result.data, 'id'), {
        workflowId,
        fromRunId: text(source, 'id'),
      });
    }
    return result;
  }

  retryWorkflowNode(user: SessionUser, runId: string, input: WorkflowRetryNode): ActionResult<Row> {
    const run = this.#row('SELECT * FROM workflow_runs WHERE id = ?', [runId]);
    if (!run) return actionFail(404, '运行记录不存在');
    const workflow = this.#workflow(user, text(run, 'workflow_id'));
    if (!workflow) return actionFail(404, '工作流不存在');
    const status = text(run, 'status');
    if (status !== 'failed' && status !== 'waiting') {
      return actionFail(409, '仅失败或等待中的运行可重试');
    }
    const definition = jsonObject(workflow.definition_json) as unknown as {
      nodes?: { id: string; type: string; name?: string; config?: Record<string, unknown> }[];
    };
    const nodes = definition.nodes ?? [];
    let node = input.nodeId ? (nodes.find((item) => item.id === input.nodeId) ?? null) : null;
    if (!node) {
      const lastEvent = this.#row(
        `SELECT node_id FROM workflow_run_events WHERE run_id = ?
         ORDER BY created_at DESC, attempt DESC LIMIT 1`,
        [runId],
      );
      const fallbackId = text(run, 'current_node') || text(lastEvent ?? {}, 'node_id');
      node = nodes.find((item) => item.id === fallbackId) ?? null;
    }
    if (!node) return actionFail(404, '节点不存在');
    if (node.type === 'start') return actionFail(400, '开始节点不可重试');
    const mode = text(run, 'mode') === 'test' ? 'test' : 'live';
    const now = this.#now();
    const { output, wait } = this.#runWorkflowNode(user, workflow, runId, node, mode);
    const updated = this.#row(
      `UPDATE workflow_runs
         SET status = ?, state_json = ?, current_node = ?, error = NULL, finished_at = ?
       WHERE id = ? RETURNING *`,
      [
        wait ? 'waiting' : 'completed',
        JSON.stringify({ trace: [output] }),
        node.id,
        wait ? null : now,
        runId,
      ],
    );
    this.#audit(user, 'workflow.node.retry', runId, {
      nodeId: node.id,
      status: wait ? 'waiting' : 'completed',
    });
    this.#publish(
      'workflow.node.retried',
      { workflowId: text(run, 'workflow_id'), runId, nodeId: node.id },
      user,
    );
    return actionOk(updated ?? {});
  }

  rollbackWorkflow(
    user: SessionUser,
    workflowId: string,
    input: WorkflowRollback,
  ): ActionResult<Row> {
    const workflow = this.#workflow(user, workflowId);
    if (!workflow) return actionFail(404, '工作流不存在');
    if (!this.#manageWorkspace(user)) return actionFail(403, '没有回滚工作流的权限');
    const target = this.#row(
      'SELECT * FROM workflow_versions WHERE workflow_id = ? AND version = ?',
      [workflowId, input.version],
    );
    if (!target) return actionFail(404, '目标版本不存在');
    const now = this.#now();
    const updated = this.#row(
      `UPDATE workflows SET definition_json = ?, status = 'draft', version = version + 1,
         updated_at = ? WHERE id = ? AND version = ? RETURNING *`,
      [text(target, 'definition_json'), now, workflowId, number(workflow, 'version')],
    );
    if (!updated) return actionFail(409, '工作流已被其他会话修改');
    this.#audit(user, 'workflow.rollback', workflowId, {
      toVersion: input.version,
      before: workflow,
      after: updated,
    });
    return actionOk(updated);
  }

  // -------------------------------------------------------------------------
  // Approvals and delegations
  // -------------------------------------------------------------------------

  #routingSteps(rule: Row): {
    name: string;
    approverIds: string[];
    mode: 'all';
    slaHours?: number;
  }[] {
    const steps = jsonArray(rule.steps_json) as {
      role?: string;
      userId?: string;
      label?: string;
      slaHours?: number;
    }[];
    const resolved: { name: string; approverIds: string[]; mode: 'all'; slaHours?: number }[] = [];
    for (const step of steps) {
      const ids = new Set<string>();
      if (step.userId) {
        const member = this.#row(
          `SELECT id FROM users WHERE id = ? AND workspace_id = ? AND status = 'active'`,
          [step.userId, text(rule, 'workspace_id')],
        );
        if (member) ids.add(step.userId);
      }
      if (step.role) {
        const members = this.#rows(
          `SELECT id FROM users WHERE workspace_id = ? AND role = ? AND status = 'active'`,
          [text(rule, 'workspace_id'), step.role],
        );
        for (const member of members) ids.add(text(member, 'id'));
      }
      if (ids.size === 0) continue;
      resolved.push({
        name: step.label ?? step.role ?? '审批',
        approverIds: [...ids],
        mode: 'all',
        slaHours: step.slaHours,
      });
    }
    return resolved;
  }

  listApprovalRoutingRules(user: SessionUser): ActionResult<Row[]> {
    if (!this.#manageWorkspace(user)) return actionFail(403, '没有查看审批路由的权限');
    return actionOk(
      this.#rows(
        `SELECT * FROM approval_routing_rules WHERE workspace_id = ?
         ORDER BY priority ASC, created_at ASC`,
        [this.#workspace(user)],
      ),
    );
  }

  createApprovalRoutingRule(
    user: SessionUser,
    input: ApprovalRoutingRuleCreate,
  ): ActionResult<Row> {
    if (!this.#manageWorkspace(user)) return actionFail(403, '没有配置审批路由的权限');
    const now = this.#now();
    const id = randomUUID();
    const steps = input.steps.filter((step) => step.userId || step.role);
    if (steps.length === 0) return actionFail(400, '审批步骤需要指定角色或审批人');
    this.#db
      .stmt(
        `INSERT INTO approval_routing_rules
           (id, workspace_id, name, kind, min_amount_cents, max_amount_cents, risk, steps_json,
            priority, active, version, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        id,
        this.#workspace(user),
        input.name,
        input.kind,
        input.minAmountCents,
        input.maxAmountCents ?? null,
        input.risk,
        JSON.stringify(steps),
        input.priority,
        input.active === false ? 0 : 1,
        user.id,
        now,
        now,
      );
    this.#audit(user, 'approval.routing.create', id, { name: input.name });
    return actionOk(this.#row('SELECT * FROM approval_routing_rules WHERE id = ?', [id]) ?? {});
  }

  deleteApprovalRoutingRule(user: SessionUser, ruleId: string): ActionResult<true> {
    if (!this.#manageWorkspace(user)) return actionFail(403, '没有配置审批路由的权限');
    const rule = this.#row(
      'SELECT * FROM approval_routing_rules WHERE id = ? AND workspace_id = ?',
      [ruleId, this.#workspace(user)],
    );
    if (!rule) return actionFail(404, '路由规则不存在');
    this.#db.stmt('DELETE FROM approval_routing_rules WHERE id = ?').run(ruleId);
    this.#audit(user, 'approval.routing.delete', ruleId, {});
    return actionOk(true);
  }

  createApproval(user: SessionUser, input: ApprovalCreate): ActionResult<Row> {
    if (input.projectId && !this.#project(input.projectId, user)) {
      return actionFail(404, '项目不存在');
    }
    const routing = this.#row(
      `SELECT * FROM approval_routing_rules
       WHERE workspace_id = ? AND active = 1
         AND (kind = 'any' OR kind = ?)
         AND min_amount_cents <= ?
         AND (max_amount_cents IS NULL OR max_amount_cents >= ?)
         AND (risk = 'any' OR risk = ?)
       ORDER BY priority ASC, created_at ASC LIMIT 1`,
      [
        this.#workspace(user),
        input.kind ?? 'general',
        input.amountCents ?? 0,
        input.amountCents ?? 0,
        input.risk ?? 'low',
      ],
    );
    const routed = routing ? this.#routingSteps(routing) : [];
    const steps = routed.length > 0 ? routed : input.steps;
    const now = this.#now();
    const id = randomUUID();
    this.#db
      .stmt(
        `INSERT INTO approval_requests
           (id, workspace_id, project_id, title, kind, status, amount_cents, risk, steps_json,
            current_step, resource_type, resource_id, requested_by, due_at, version,
            created_at, updated_at, routing_rule_id)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, 0, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        id,
        this.#workspace(user),
        input.projectId ?? null,
        input.title,
        input.kind ?? 'general',
        input.amountCents ?? 0,
        input.risk ?? 'low',
        JSON.stringify(steps),
        input.resourceType ?? '',
        input.resourceId ?? '',
        user.id,
        input.dueAt ?? null,
        now,
        now,
        routing ? text(routing, 'id') : null,
      );
    for (const approver of steps[0]?.approverIds ?? []) {
      this.#notify(approver, 'approval', '有新的审批待处理', input.title);
    }
    this.#audit(user, 'approval.create', id, {
      title: input.title,
      steps: steps.length,
      routingRuleId: routing ? text(routing, 'id') : null,
    });
    this.#publish('approval.created', { approvalId: id, title: input.title }, user);
    return actionOk(this.#row('SELECT * FROM approval_requests WHERE id = ?', [id]) ?? {});
  }

  decideApproval(
    user: SessionUser,
    approvalId: string,
    input: ApprovalDecision,
  ): ActionResult<Row> {
    const request = this.#row('SELECT * FROM approval_requests WHERE id = ?', [approvalId]);
    if (!request || text(request, 'workspace_id') !== this.#workspace(user)) {
      return actionFail(404, '审批不存在');
    }
    if (text(request, 'status') !== 'pending') return actionFail(409, '审批已完成');
    if (number(request, 'version') !== input.version) {
      return actionFail(409, '审批已被其他会话修改', request);
    }
    const steps = jsonArray(request.steps_json) as {
      name?: string;
      approverIds?: string[];
      mode?: 'all' | 'any';
    }[];
    const stepIndex = number(request, 'current_step');
    const step = steps[stepIndex];
    if (!step) return actionFail(409, '审批步骤状态异常');
    const approvers = step.approverIds ?? [];
    const delegated =
      this.#row(
        `SELECT 1 AS hit FROM delegations
         WHERE delegate_id = ? AND active = 1 AND starts_at <= ? AND ends_at >= ?
           AND (scope = '' OR scope = 'approval') LIMIT 1`,
        [user.id, this.#now(), this.#now()],
      ) !== null;
    const manager = this.#manageWorkspace(user);
    if (!manager && !approvers.includes(user.id) && !delegated) {
      return actionFail(403, '没有审批该请求的权限');
    }
    const now = this.#now();
    this.#db
      .stmt(
        `INSERT INTO approval_decisions
           (id, request_id, step, approver_id, delegate_id, action, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        approvalId,
        stepIndex,
        user.id,
        input.delegateTo ?? null,
        input.action,
        input.note ?? '',
        now,
      );
    let status = text(request, 'status');
    let nextStep = stepIndex;
    if (input.action === 'reject') {
      status = 'rejected';
    } else if (input.action === 'delegate') {
      if (!input.delegateTo) return actionFail(400, '请选择代理人');
      this.#notify(input.delegateTo, 'approval', '你被指定为审批代理人', text(request, 'title'));
    } else if (input.action === 'escalate') {
      nextStep = Math.min(stepIndex + 1, steps.length - 1);
      this.#notify(text(request, 'requested_by'), 'approval', '审批已升级', text(request, 'title'));
    } else {
      const approvals = this.#rows(
        `SELECT DISTINCT approver_id FROM approval_decisions
         WHERE request_id = ? AND step = ? AND action = 'approve'`,
        [approvalId, stepIndex],
      ).map((row) => text(row, 'approver_id'));
      const satisfied =
        step.mode === 'any'
          ? approvals.length > 0
          : approvers.every((approver) => approvals.includes(approver));
      if (satisfied) {
        nextStep = stepIndex + 1;
        status = nextStep >= steps.length ? 'approved' : 'pending';
      }
    }
    const updated = this.#row(
      `UPDATE approval_requests SET status = ?, current_step = ?, version = version + 1,
         updated_at = ? WHERE id = ? AND version = ? RETURNING *`,
      [status, nextStep, now, approvalId, input.version],
    );
    if (!updated) return actionFail(409, '审批已被其他会话修改');
    if (status === 'approved' && steps[nextStep]) {
      for (const approver of steps[nextStep]?.approverIds ?? []) {
        this.#notify(approver, 'approval', '有新的审批步骤待处理', text(request, 'title'));
      }
    }
    if (status === 'approved' || status === 'rejected') {
      this.#notify(
        text(request, 'requested_by'),
        'approval',
        `审批${status === 'approved' ? '已通过' : '已拒绝'}`,
        text(request, 'title'),
      );
    }
    this.#audit(user, 'approval.decide', approvalId, {
      action: input.action,
      before: request,
      after: updated,
      reason: input.note ?? '',
    });
    this.#publish('approval.decided', { approvalId, status }, user);
    return actionOk(updated);
  }

  withdrawApproval(
    user: SessionUser,
    approvalId: string,
    input: ApprovalWithdraw,
  ): ActionResult<Row> {
    const request = this.#row('SELECT * FROM approval_requests WHERE id = ?', [approvalId]);
    if (!request || text(request, 'workspace_id') !== this.#workspace(user)) {
      return actionFail(404, '审批不存在');
    }
    if (number(request, 'version') !== input.version) {
      return actionFail(409, '审批已被其他会话修改', request);
    }
    if (text(request, 'requested_by') !== user.id && !this.#manageWorkspace(user)) {
      return actionFail(403, '只有申请人或管理员可以撤回');
    }
    if (text(request, 'status') !== 'pending') return actionFail(409, '审批已完成');
    const now = this.#now();
    const updated = this.#row(
      `UPDATE approval_requests SET status = 'withdrawn', version = version + 1,
         updated_at = ? WHERE id = ? AND version = ? RETURNING *`,
      [now, approvalId, input.version],
    );
    if (!updated) return actionFail(409, '审批已被其他会话修改');
    this.#db
      .stmt(
        `INSERT INTO approval_decisions
           (id, request_id, step, approver_id, action, note, created_at)
         VALUES (?, ?, ?, ?, 'withdraw', ?, ?)`,
      )
      .run(
        randomUUID(),
        approvalId,
        number(request, 'current_step'),
        user.id,
        input.note ?? '',
        now,
      );
    this.#audit(user, 'approval.withdraw', approvalId, {
      before: request,
      after: updated,
      reason: input.note,
    });
    return actionOk(updated);
  }

  approvalMetrics(user: SessionUser, input: ApprovalMetricsQuery): ActionResult<Row> {
    const clauses = ['workspace_id = ?'];
    const params: (string | number)[] = [this.#workspace(user)];
    if (input.from) {
      clauses.push('created_at >= ?');
      params.push(`${input.from}T00:00:00.000Z`);
    }
    if (input.to) {
      clauses.push('created_at <= ?');
      params.push(`${input.to}T23:59:59.999Z`);
    }
    if (input.kind) {
      clauses.push('kind = ?');
      params.push(input.kind);
    }
    const where = clauses.join(' AND ');
    const byStatus = this.#rows(
      `SELECT status, COUNT(*) AS count FROM approval_requests WHERE ${where} GROUP BY status`,
      params,
    );
    const byRisk = this.#rows(
      `SELECT risk, COUNT(*) AS count FROM approval_requests WHERE ${where} GROUP BY risk`,
      params,
    );
    const timing = this.#row(
      `SELECT AVG((julianday(updated_at) - julianday(created_at)) * 24) AS avg_hours
       FROM approval_requests WHERE ${where} AND status IN ('approved', 'rejected')`,
      params,
    );
    const breached = this.#row(
      `SELECT COUNT(*) AS count FROM approval_requests
       WHERE ${where} AND status = 'pending' AND due_at IS NOT NULL AND due_at < ?`,
      [...params, this.#now()],
    );
    const counts = new Map(
      byStatus.map((row) => [String(row.status ?? ''), number(row, 'count')] as const),
    );
    const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
    const approved = counts.get('approved') ?? 0;
    const rejected = counts.get('rejected') ?? 0;
    const pending = counts.get('pending') ?? 0;
    const decided = approved + rejected;
    const stepWhere = where.replace(/\b(status|due_at|created_at|kind|workspace_id)\b/g, 'r.$1');
    const byStepRows = this.#rows(
      `SELECT d.step AS step, COUNT(*) AS decisions,
              AVG((julianday(d.created_at) - julianday(r.created_at)) * 24) AS avg_hours
       FROM approval_decisions d
       JOIN approval_requests r ON r.id = d.request_id
       WHERE ${stepWhere} AND d.action IN ('approve', 'reject')
       GROUP BY d.step ORDER BY d.step`,
      params,
    );
    const departmentScope = where.replace(
      /\b(status|due_at|created_at|kind|workspace_id)\b/g,
      'r.$1',
    );
    const byDepartment = this.#rows(
      `SELECT COALESCE((
         SELECT d.name FROM org_memberships m JOIN departments d ON d.id = m.department_id
         WHERE m.user_id = r.requested_by AND m.status = 'active' ORDER BY d.name LIMIT 1
       ), '未分配') AS department,
       COUNT(*) AS total,
       SUM(CASE WHEN r.status = 'approved' THEN 1 ELSE 0 END) AS approved,
       SUM(CASE WHEN r.status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
       SUM(CASE WHEN r.status = 'pending' THEN 1 ELSE 0 END) AS pending,
       AVG(CASE WHEN r.status IN ('approved', 'rejected')
         THEN (julianday(r.updated_at) - julianday(r.created_at)) * 24 END) AS avg_hours
       FROM approval_requests r WHERE ${departmentScope}
       GROUP BY department ORDER BY total DESC`,
      params,
    ).map((row) => ({
      department: text(row, 'department'),
      total: number(row, 'total'),
      approved: number(row, 'approved'),
      rejected: number(row, 'rejected'),
      pending: number(row, 'pending'),
      averageHours: Number(row.avg_hours ?? 0),
      returnRate:
        number(row, 'approved') + number(row, 'rejected') > 0
          ? number(row, 'rejected') / (number(row, 'approved') + number(row, 'rejected'))
          : 0,
      lowSample: number(row, 'total') < 5,
    }));
    const byKind = this.#rows(
      `SELECT r.kind AS kind, COUNT(*) AS total,
              SUM(CASE WHEN r.status = 'approved' THEN 1 ELSE 0 END) AS approved,
              SUM(CASE WHEN r.status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
              SUM(CASE WHEN r.status = 'pending' THEN 1 ELSE 0 END) AS pending,
              AVG(CASE WHEN r.status IN ('approved', 'rejected')
                THEN (julianday(r.updated_at) - julianday(r.created_at)) * 24 END) AS avg_hours
       FROM approval_requests r WHERE ${departmentScope}
       GROUP BY r.kind ORDER BY total DESC`,
      params,
    ).map((row) => ({
      kind: text(row, 'kind'),
      total: number(row, 'total'),
      approved: number(row, 'approved'),
      rejected: number(row, 'rejected'),
      pending: number(row, 'pending'),
      averageHours: Number(row.avg_hours ?? 0),
      lowSample: number(row, 'total') < 5,
    }));
    const amountBands = this.#rows(
      `SELECT CASE
         WHEN r.amount_cents = 0 THEN '0'
         WHEN r.amount_cents < 1000000 THEN '0-10k'
         WHEN r.amount_cents < 10000000 THEN '10k-100k'
         WHEN r.amount_cents < 100000000 THEN '100k-1m'
         ELSE '1m+' END AS band,
       COUNT(*) AS total,
       SUM(CASE WHEN r.status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
       AVG(CASE WHEN r.status IN ('approved', 'rejected')
         THEN (julianday(r.updated_at) - julianday(r.created_at)) * 24 END) AS avg_hours
       FROM approval_requests r WHERE ${departmentScope}
       GROUP BY band ORDER BY MIN(r.amount_cents)`,
      params,
    ).map((row) => ({
      band: text(row, 'band'),
      total: number(row, 'total'),
      rejected: number(row, 'rejected'),
      averageHours: Number(row.avg_hours ?? 0),
      lowSample: number(row, 'total') < 5,
    }));
    const managerView = this.#manageWorkspace(user);
    const approverRows = this.#rows(
      `SELECT d.approver_id AS approver_id, u.name AS approver_name,
              COUNT(*) AS decisions,
              SUM(CASE WHEN d.action = 'reject' THEN 1 ELSE 0 END) AS rejected,
              AVG((julianday(d.created_at) - julianday(r.created_at)) * 24) AS avg_hours
       FROM approval_decisions d
       JOIN approval_requests r ON r.id = d.request_id
       LEFT JOIN users u ON u.id = d.approver_id
       WHERE ${departmentScope} AND d.action IN ('approve', 'reject')
       GROUP BY d.approver_id ORDER BY avg_hours DESC LIMIT 20`,
      params,
    );
    const byApprover = approverRows.map((row, index) => ({
      approver: managerView
        ? text(row, 'approver_name') || '未知审批人'
        : `审批人${String.fromCharCode(65 + (index % 26))}`,
      approverId: managerView ? text(row, 'approver_id') : null,
      decisions: number(row, 'decisions'),
      rejected: number(row, 'rejected'),
      averageHours: Number(row.avg_hours ?? 0),
      lowSample: number(row, 'decisions') < 5,
    }));
    const bottleneckStep = byStepRows.reduce<Row | null>(
      (worst, row) =>
        !worst || Number(row.avg_hours ?? 0) > Number(worst.avg_hours ?? 0) ? row : worst,
      null,
    );
    const drillWhere = managerView
      ? `${departmentScope} AND r.status = 'pending'`
      : `${departmentScope} AND r.status = 'pending' AND r.requested_by = ?`;
    const drillParams = managerView ? params : [...params, user.id];
    const drillDown = this.#rows(
      `SELECT r.id, r.title, r.kind, r.status, r.risk, r.amount_cents, r.due_at, r.created_at
       FROM approval_requests r WHERE ${drillWhere}
       ORDER BY r.due_at IS NULL, r.due_at ASC, r.created_at ASC LIMIT 20`,
      drillParams,
    ).map((row) => ({
      id: text(row, 'id'),
      title: text(row, 'title'),
      kind: text(row, 'kind'),
      status: text(row, 'status'),
      risk: text(row, 'risk'),
      amountCents: number(row, 'amount_cents'),
      dueAt: nullableText(row, 'due_at'),
      createdAt: text(row, 'created_at'),
    }));
    return actionOk({
      byStatus,
      byRisk,
      byDepartment,
      byKind,
      amountBands,
      byApprover,
      total,
      approved,
      rejected,
      pending,
      averageHours: Number(timing?.avg_hours ?? 0),
      overdueRate: pending > 0 ? Number(breached?.count ?? 0) / pending : 0,
      returnRate: decided > 0 ? rejected / decided : 0,
      byStep: byStepRows.map((row) => ({
        step: number(row, 'step'),
        label: `第 ${number(row, 'step') + 1} 步`,
        averageHours: Number(row.avg_hours ?? 0),
        decisions: number(row, 'decisions'),
        lowSample: number(row, 'decisions') < 5,
      })),
      bottleneck: bottleneckStep
        ? {
            step: number(bottleneckStep, 'step'),
            label: `第 ${number(bottleneckStep, 'step') + 1} 步`,
            averageHours: Number(bottleneckStep.avg_hours ?? 0),
            decisions: number(bottleneckStep, 'decisions'),
          }
        : null,
      drillDown,
      drillDownScope: managerView ? 'workspace' : 'own',
      anonymized: !managerView,
      lowSample: total < 5,
      avgDecisionHours: Number(timing?.avg_hours ?? 0),
      slaBreaches: Number(breached?.count ?? 0),
    });
  }

  // -------------------------------------------------------------------------
  // Triggers, connectors and events
  // -------------------------------------------------------------------------

  #trigger(user: SessionUser, id: string) {
    const trigger = this.#row('SELECT * FROM workflow_triggers WHERE id = ?', [id]);
    if (!trigger || text(trigger, 'workspace_id') !== this.#workspace(user)) return null;
    return trigger;
  }

  #cronFieldMatches(field: string, value: number, min: number, max: number): boolean {
    for (const part of field.split(',')) {
      const [range, stepRaw] = part.split('/');
      const step = stepRaw === undefined ? 1 : Number(stepRaw);
      if (!Number.isInteger(step) || step < 1) continue;
      let start = min;
      let end = max;
      if (range !== '*') {
        const [fromRaw, toRaw] = (range ?? '').split('-');
        const from = Number(fromRaw);
        if (!Number.isInteger(from)) continue;
        start = from;
        end = toRaw === undefined ? (stepRaw === undefined ? from : max) : Number(toRaw);
        if (!Number.isInteger(end)) continue;
      }
      if (value >= start && value <= end && (value - start) % step === 0) return true;
    }
    return false;
  }

  #zonedScheduleParts(
    ms: number,
    timeZone: string,
  ): {
    year: string;
    month: string;
    day: string;
    hour: number;
    minute: number;
    weekday: number;
  } | null {
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        weekday: 'short',
        hourCycle: 'h23',
      });
      const parts = new Map(
        formatter.formatToParts(new Date(ms)).map((part) => [part.type, part.value]),
      );
      const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const weekday = names.indexOf(parts.get('weekday') ?? '');
      const hour = Number(parts.get('hour') ?? '0');
      const minute = Number(parts.get('minute') ?? '0');
      if (weekday < 0 || Number.isNaN(hour) || Number.isNaN(minute)) return null;
      return {
        year: parts.get('year') ?? '1970',
        month: parts.get('month') ?? '01',
        day: parts.get('day') ?? '01',
        hour,
        minute,
        weekday,
      };
    } catch {
      return null;
    }
  }

  #cronMatches(expression: string, ms: number, timeZone: string): boolean {
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5) return false;
    const parts = this.#zonedScheduleParts(ms, timeZone);
    if (!parts) return false;
    if (!this.#cronFieldMatches(fields[0] ?? '', parts.minute, 0, 59)) return false;
    if (!this.#cronFieldMatches(fields[1] ?? '', parts.hour, 0, 23)) return false;
    if (!this.#cronFieldMatches(fields[3] ?? '', Number(parts.month), 1, 12)) return false;
    const day = Number(parts.day);
    const dom = this.#cronFieldMatches(fields[2] ?? '', day, 1, 31);
    const dowField = fields[4] ?? '';
    const dow =
      this.#cronFieldMatches(dowField, parts.weekday, 0, 7) ||
      (parts.weekday === 0 && this.#cronFieldMatches(dowField, 7, 0, 7));
    const domRestricted = (fields[2] ?? '*') !== '*';
    const dowRestricted = dowField !== '*';
    return domRestricted && dowRestricted ? dom || dow : dom && dow;
  }

  #triggerMetric(trigger: Row, config: Record<string, unknown>): number | null {
    const workspaceId = text(trigger, 'workspace_id');
    const projectId = typeof config.projectId === 'string' ? config.projectId : '';
    const projectClause = projectId ? ' AND t.project_id = ?' : '';
    const projectParams = projectId ? [projectId] : [];
    const workspaceParams = projectId ? [workspaceId, projectId] : [workspaceId];
    const metric = String(config.metric ?? '');
    const today = new Date().toISOString().slice(0, 10);
    if (metric === 'overdue_tasks') {
      return number(
        this.#row(
          `SELECT COUNT(*) AS count FROM project_tasks t
           JOIN projects p ON p.id = t.project_id
           WHERE p.workspace_id = ? AND p.deleted_at IS NULL AND t.status <> 'done'
             AND t.due_date IS NOT NULL AND t.due_date < ?${projectClause}`,
          [workspaceId, today, ...projectParams],
        ),
        'count',
      );
    }
    if (metric === 'open_blockers') {
      return number(
        this.#row(
          `SELECT COUNT(*) AS count FROM task_blockers b
           JOIN project_tasks t ON t.id = b.task_id
           JOIN projects p ON p.id = t.project_id
           WHERE p.workspace_id = ? AND b.status = 'open'${projectClause}`,
          workspaceParams,
        ),
        'count',
      );
    }
    if (metric === 'sla_breaches') {
      return number(
        this.#row(
          `SELECT COUNT(*) AS count FROM task_sla_instances s
           JOIN project_tasks t ON t.id = s.task_id
           JOIN projects p ON p.id = t.project_id
           WHERE p.workspace_id = ? AND s.state = 'breached'${projectClause}`,
          workspaceParams,
        ),
        'count',
      );
    }
    if (metric === 'budget_usage') {
      const row = this.#row(
        `SELECT CASE WHEN SUM(b.budget_cents) > 0
             THEN SUM(b.actual_cents + b.committed_cents) * 100.0 / SUM(b.budget_cents)
             ELSE 0 END AS value
         FROM project_budgets b JOIN projects p ON p.id = b.project_id
         WHERE p.workspace_id = ?${projectId ? ' AND b.project_id = ?' : ''}`,
        workspaceParams,
      );
      return Number(row?.value ?? 0);
    }
    if (metric === 'pending_approvals' || metric === 'overdue_approvals') {
      const overdue = metric === 'overdue_approvals';
      return number(
        this.#row(
          `SELECT COUNT(*) AS count FROM approval_requests
           WHERE workspace_id = ? AND status = 'pending'${overdue ? ' AND due_at IS NOT NULL AND due_at < ?' : ''}`,
          overdue ? [workspaceId, this.#now()] : [workspaceId],
        ),
        'count',
      );
    }
    if (config.field && projectId) {
      const project = this.#row(
        'SELECT * FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL',
        [projectId, workspaceId],
      );
      const value = project?.[String(config.field)];
      return typeof value === 'number' ? value : null;
    }
    return null;
  }

  #compareMetric(actual: number, operator: string, expected: number): boolean {
    if (operator === 'gt') return actual > expected;
    if (operator === 'gte') return actual >= expected;
    if (operator === 'lt') return actual < expected;
    if (operator === 'lte') return actual <= expected;
    if (operator === 'eq') return actual === expected;
    if (operator === 'neq') return actual !== expected;
    return false;
  }

  #conditionMatches(actual: unknown, operator: string, expected: unknown): boolean {
    if (operator === 'exists') return actual !== null && actual !== undefined && actual !== '';
    if (operator === 'gte' || operator === 'gt' || operator === 'lte' || operator === 'lt') {
      const left = Number(actual);
      const right = Number(expected);
      return this.#compareMetric(left, operator, right);
    }
    if (operator === 'eq') return String(actual ?? '') === String(expected ?? '');
    if (operator === 'neq') return String(actual ?? '') !== String(expected ?? '');
    if (operator === 'contains') return String(actual ?? '').includes(String(expected ?? ''));
    if (operator === 'in') {
      const list = Array.isArray(expected) ? expected : String(expected ?? '').split(',');
      return list.some((item) => String(actual ?? '') === String(item));
    }
    return false;
  }

  #triggerSnapshot(trigger: Row, config: Record<string, unknown>): Record<string, unknown> {
    const workspaceId = text(trigger, 'workspace_id');
    const projectId = typeof config.projectId === 'string' ? config.projectId : '';
    const project = projectId
      ? this.#row(
          'SELECT * FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL',
          [projectId, workspaceId],
        )
      : null;
    const metrics = {
      overdue_tasks: this.#triggerMetric(trigger, { ...config, metric: 'overdue_tasks' }),
      open_blockers: this.#triggerMetric(trigger, { ...config, metric: 'open_blockers' }),
      sla_breaches: this.#triggerMetric(trigger, { ...config, metric: 'sla_breaches' }),
      budget_usage: this.#triggerMetric(trigger, { ...config, metric: 'budget_usage' }),
      pending_approvals: this.#triggerMetric(trigger, { ...config, metric: 'pending_approvals' }),
      overdue_approvals: this.#triggerMetric(trigger, { ...config, metric: 'overdue_approvals' }),
    };
    const camel = Object.fromEntries(
      Object.entries(metrics).map(([key, value]) => [
        key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase()),
        value,
      ]),
    );
    const extra =
      config.snapshot && typeof config.snapshot === 'object' && !Array.isArray(config.snapshot)
        ? (config.snapshot as Record<string, unknown>)
        : {};
    return {
      ...(project ?? {}),
      project_id: projectId,
      projectId,
      ...metrics,
      ...camel,
      ...extra,
    };
  }

  #triggerState(id: string): string | null {
    return nullableText(
      this.#row('SELECT value FROM app_settings WHERE key = ?', [`trigger:state:${id}`]) ?? {},
      'value',
    );
  }

  #setTriggerState(id: string, value: string): void {
    const now = this.#now();
    this.#db
      .stmt(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(`trigger:state:${id}`, value, now);
  }

  #triggerSince(id: string): number | null {
    const row = this.#row('SELECT value FROM app_settings WHERE key = ?', [`trigger:since:${id}`]);
    const value = row ? Number(nullableText(row, 'value')) : Number.NaN;
    return Number.isFinite(value) ? value : null;
  }

  #setTriggerSince(id: string, ms: number | null): void {
    const key = `trigger:since:${id}`;
    if (ms === null) {
      this.#db.stmt('DELETE FROM app_settings WHERE key = ?').run(key);
      return;
    }
    const now = this.#now();
    this.#db
      .stmt(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, String(ms), now);
  }

  fireTrigger(user: SessionUser, triggerId: string, input: TriggerFire): ActionResult<Row> {
    const trigger = this.#trigger(user, triggerId);
    if (!trigger) return actionFail(404, '触发器不存在');
    if (!this.#manageWorkspace(user)) return actionFail(403, '没有触发工作流的权限');
    if (number(trigger, 'active') !== 1) return actionFail(409, '触发器已停用');
    const now = this.#now();
    const quiet = jsonArray(trigger.quiet_hours_json) as { start?: string; end?: string }[];
    const timezone = text(trigger, 'timezone') || 'Asia/Shanghai';
    const zoned = this.#zonedScheduleParts(Date.parse(now), timezone);
    const clock = zoned
      ? `${String(zoned.hour).padStart(2, '0')}:${String(zoned.minute).padStart(2, '0')}`
      : now.slice(11, 16);
    if (
      quiet.some(
        (window) => window.start && window.end && clock >= window.start && clock < window.end,
      )
    ) {
      return actionFail(409, '当前处于静默时段');
    }
    const last = text(trigger, 'last_fired_at');
    const dedupe = number(trigger, 'dedupe_window_seconds');
    if (last && dedupe > 0) {
      const elapsed = (Date.parse(now) - Date.parse(last)) / 1000;
      if (elapsed < dedupe) {
        return actionFail(409, `触发去重窗口内（${Math.ceil(dedupe - elapsed)} 秒后重试）`);
      }
    }
    const keySetting = input.eventKey
      ? `trigger:key:${triggerId}:${this.#hash(input.eventKey).slice(0, 24)}`
      : null;
    if (keySetting && dedupe > 0) {
      const previous = this.#row('SELECT value FROM app_settings WHERE key = ?', [keySetting]);
      const previousAt = previous ? text(previous, 'value') : '';
      if (previousAt && (Date.parse(now) - Date.parse(previousAt)) / 1000 < dedupe) {
        return actionFail(409, '相同事件键在去重窗口内已触发');
      }
    }
    const firedLastHour = number(
      this.#row(
        `SELECT COUNT(*) AS count FROM domain_events
         WHERE workspace_id = ? AND type = 'trigger.fired'
           AND json_extract(payload_json, '$.triggerId') = ?
           AND created_at >= ?`,
        [this.#workspace(user), triggerId, new Date(Date.parse(now) - 3_600_000).toISOString()],
      ),
      'count',
    );
    const workflowRunsLastHour = number(
      this.#row(
        `SELECT COUNT(*) AS count FROM workflow_runs r
         JOIN workflows w ON w.id = r.workflow_id
         WHERE w.workspace_id = ? AND r.idempotency_key LIKE ?
           AND r.started_at >= ?`,
        [
          this.#workspace(user),
          `trigger:${triggerId}:%`,
          new Date(Date.parse(now) - 3_600_000).toISOString(),
        ],
      ),
      'count',
    );
    if (firedLastHour + workflowRunsLastHour >= number(trigger, 'max_per_hour')) {
      return actionFail(409, '已达到每小时触发上限');
    }
    if (input.dryRun) {
      return actionOk({
        triggerId,
        dryRun: true,
        workflowId: trigger.workflow_id,
        wouldFireAt: now,
        eventKey: input.eventKey ?? '',
      });
    }
    let run: Row | null = null;
    const workflowId = text(trigger, 'workflow_id');
    if (workflowId) {
      const workflow = this.#workflow(user, workflowId);
      if (!workflow) return actionFail(404, '关联工作流不存在');
      const started = this.#startWorkflow(
        user,
        workflow,
        {
          input: { triggerId, eventKey: input.eventKey ?? '' },
          idempotencyKey: `trigger:${triggerId}:${input.eventKey ?? now}`,
        },
        'live',
      );
      if (!started.ok) return started;
      run = started.data;
    } else {
      this.#store.domain.publishEvent(
        this.#workspace(user),
        'trigger.fired',
        { triggerId, eventKey: input.eventKey ?? '', workflowId: null },
        user.id,
        `trigger:${triggerId}:${input.eventKey ?? now}`,
      );
    }
    this.#db
      .stmt('UPDATE workflow_triggers SET last_fired_at = ?, updated_at = ? WHERE id = ?')
      .run(now, now, triggerId);
    if (keySetting) {
      this.#db
        .stmt(
          `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value,
             updated_at = excluded.updated_at`,
        )
        .run(keySetting, now, now);
    }
    this.#audit(user, 'trigger.fire', triggerId, {
      eventKey: input.eventKey ?? '',
      runId: run?.id ?? null,
    });
    return actionOk({ triggerId, firedAt: now, run });
  }

  tickTriggers(user: SessionUser): ActionResult<Row> {
    if (!this.#manageWorkspace(user)) return actionFail(403, '没有运行触发器的权限');
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const triggers = this.#rows(
      `SELECT * FROM workflow_triggers
       WHERE workspace_id = ? AND active = 1 AND type <> 'event'`,
      [this.#workspace(user)],
    );
    const fired: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    const catchUps: string[] = [];
    for (const trigger of triggers) {
      const id = text(trigger, 'id');
      const type = text(trigger, 'type');
      const config = jsonObject(trigger.config_json);
      const timezone = text(trigger, 'timezone') || 'Asia/Shanghai';
      const last = text(trigger, 'last_fired_at');
      if (last && Date.parse(last) > nowMs) {
        skipped.push({ id, reason: 'clock_skew' });
        continue;
      }
      const parts = this.#zonedScheduleParts(nowMs, timezone);
      let eventKey = '';
      if (type === 'schedule') {
        const at = typeof config.at === 'string' ? config.at.trim() : '';
        if (at) {
          const clock = parts
            ? `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`
            : '';
          if (clock !== at) continue;
          const days = Array.isArray(config.daysOfWeek)
            ? config.daysOfWeek.map((day) => Number(day))
            : [];
          if (days.length > 0 && parts && !days.includes(parts.weekday)) continue;
          eventKey = `schedule:${parts?.year ?? ''}-${parts?.month ?? ''}-${parts?.day ?? ''}T${at}`;
        } else {
          const everyMinutes = Math.max(Number(config.everyMinutes ?? 15) || 15, 1);
          if (last && nowMs - Date.parse(last) < everyMinutes * 60_000) continue;
          if (last && nowMs - Date.parse(last) > everyMinutes * 2 * 60_000) catchUps.push(id);
          eventKey = `schedule:${Math.floor(nowMs / (everyMinutes * 60_000))}`;
        }
      } else if (type === 'cron') {
        const expression = String(config.expression ?? config.cron ?? '');
        if (!expression || !this.#cronMatches(expression, nowMs, timezone)) continue;
        eventKey = `cron:${parts?.year ?? ''}${parts?.month ?? ''}${parts?.day ?? ''}T${String(
          parts?.hour ?? 0,
        ).padStart(2, '0')}:${String(parts?.minute ?? 0).padStart(2, '0')}`;
      } else if (type === 'threshold') {
        const actual = this.#triggerMetric(trigger, config);
        if (actual === null) continue;
        const matched = this.#compareMetric(
          actual,
          String(config.operator ?? 'gt'),
          Number(config.value ?? 0),
        );
        const stateLabel = `${String(config.metric ?? '')}:${actual}`;
        if (!matched) {
          this.#setTriggerSince(id, null);
          this.#setTriggerState(id, `0:${stateLabel}`);
          continue;
        }
        const sustained = Math.max(Number(config.sustainedSeconds ?? 0) || 0, 0);
        if (sustained > 0) {
          const since = this.#triggerSince(id);
          if (since === null) {
            this.#setTriggerSince(id, nowMs);
            this.#setTriggerState(id, `0:${stateLabel}`);
            continue;
          }
          if (nowMs - since < sustained * 1000) continue;
        }
        const previous = this.#triggerState(id);
        this.#setTriggerState(id, `1:${stateLabel}`);
        if (String(config.mode ?? 'edge') === 'edge') {
          if (previous === null || previous.startsWith('1:')) continue;
        }
        eventKey = `threshold:${stateLabel}`;
      } else if (type === 'condition') {
        const conditions = (Array.isArray(config.conditions) ? config.conditions : []) as {
          field?: string;
          operator?: string;
          value?: unknown;
        }[];
        if (conditions.length === 0) continue;
        const snapshot = this.#triggerSnapshot(trigger, config);
        const matched = conditions.every((condition) =>
          this.#conditionMatches(
            snapshot[String(condition.field ?? '')],
            String(condition.operator ?? 'eq'),
            condition.value,
          ),
        );
        if (!matched) {
          this.#setTriggerSince(id, null);
          this.#setTriggerState(id, '0');
          continue;
        }
        const sustained = Math.max(Number(config.sustainedSeconds ?? 0) || 0, 0);
        if (sustained > 0) {
          const since = this.#triggerSince(id);
          if (since === null) {
            this.#setTriggerSince(id, nowMs);
            this.#setTriggerState(id, '0');
            continue;
          }
          if (nowMs - since < sustained * 1000) continue;
        }
        const previous = this.#triggerState(id);
        this.#setTriggerState(id, '1');
        if (String(config.mode ?? 'edge') === 'edge' && previous === '1') continue;
        eventKey = 'condition:matched';
      } else {
        continue;
      }
      const result = this.fireTrigger(user, id, { dryRun: false, eventKey });
      if (result.ok) fired.push(id);
      else skipped.push({ id, reason: result.message });
    }
    return actionOk({ fired, count: fired.length, catchUps, skipped, checkedAt: now });
  }

  #requireConnector(
    user: SessionUser,
    connectorId: string,
    manage = true,
  ): { connector: Row } | { error: ActionResult<Row> } {
    const connector = this.#row('SELECT * FROM connectors WHERE id = ?', [connectorId]);
    if (!connector || text(connector, 'workspace_id') !== this.#workspace(user)) {
      return { error: actionFail(404, '连接器不存在') };
    }
    if (manage && !this.#manageWorkspace(user)) {
      return { error: actionFail(403, '没有管理连接器的权限') };
    }
    return { connector };
  }

  #connectorDomains(connector: Row): string[] {
    return jsonArray(connector.allowed_domains_json).map((domain) => String(domain));
  }

  #oauthTokenState(connector: Row): Record<string, unknown> {
    const raw = decryptConnectorSecret(this.#db, text(connector, 'secret_ref'));
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  rotateConnector(
    user: SessionUser,
    connectorId: string,
    input: ConnectorRotate,
  ): ActionResult<Row> {
    const found = this.#requireConnector(user, connectorId);
    if ('error' in found) return found.error;
    const connector = found.connector;
    const now = this.#now();
    const updated = this.#row(
      `UPDATE connectors SET secret_ref = ?, health = 'ok', token_expires_at = NULL,
         version = version + 1, updated_at = ? WHERE id = ? AND version = ? RETURNING *`,
      [
        encryptConnectorSecret(this.#db, input.secret),
        now,
        connectorId,
        number(connector, 'version'),
      ],
    );
    if (!updated) return actionFail(409, '连接器已被其他会话修改');
    this.#audit(user, 'connector.rotate', connectorId, {
      before: { health: text(connector, 'health') },
      after: { health: 'ok' },
    });
    return actionOk(connectorView(updated));
  }

  connectorHealth(user: SessionUser, connectorId: string): ActionResult<Row> {
    const found = this.#requireConnector(user, connectorId, false);
    if ('error' in found) return found.error;
    const connector = found.connector;
    const active = number(connector, 'active') === 1;
    const kind = text(connector, 'kind');
    const credential =
      kind === 'oauth'
        ? text(connector, 'client_secret_ref') !== ''
        : text(connector, 'secret_ref') !== '';
    const expiresAt = text(connector, 'token_expires_at');
    const expired = expiresAt !== '' && Date.parse(expiresAt) <= Date.now();
    const health = !active ? 'down' : !credential ? 'degraded' : expired ? 'degraded' : 'ok';
    this.#db
      .stmt('UPDATE connectors SET health = ?, updated_at = ? WHERE id = ?')
      .run(health, this.#now(), connectorId);
    return actionOk({ id: connectorId, health, checkedAt: this.#now() });
  }

  connectorOauthStart(
    user: SessionUser,
    connectorId: string,
    input: ConnectorOAuthStart,
  ): ActionResult<Row> {
    const found = this.#requireConnector(user, connectorId);
    if ('error' in found) return found.error;
    const connector = found.connector;
    if (text(connector, 'kind') !== 'oauth') return actionFail(400, '该连接器不是 OAuth 类型');
    const authUrl = text(connector, 'auth_url');
    const clientId = text(connector, 'client_id');
    const redirectUri = input.redirectUri?.trim() || text(connector, 'redirect_uri');
    if (!authUrl || !clientId) return actionFail(400, '请先配置 OAuth 授权地址和客户端 ID');
    if (!redirectUri) return actionFail(400, '请提供 OAuth 回调地址');
    const target = new URL(authUrl);
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      return actionFail(400, 'OAuth 授权地址无效');
    }
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const now = this.#now();
    this.#db
      .stmt(
        `INSERT INTO connector_oauth_states
           (state, connector_id, workspace_id, code_verifier, redirect_uri, created_by,
            expires_at, used_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        this.#hash(state),
        connectorId,
        text(connector, 'workspace_id'),
        verifier,
        redirectUri,
        user.id,
        new Date(Date.parse(now) + 600_000).toISOString(),
        now,
      );
    target.searchParams.set('response_type', 'code');
    target.searchParams.set('client_id', clientId);
    target.searchParams.set('redirect_uri', redirectUri);
    target.searchParams.set('state', state);
    target.searchParams.set('code_challenge', challenge);
    target.searchParams.set('code_challenge_method', 'S256');
    const scopes = jsonArray(connector.scopes_json).map((scope) => String(scope));
    if (scopes.length > 0) target.searchParams.set('scope', scopes.join(' '));
    this.#audit(user, 'connector.oauth.start', connectorId, { redirectUri, scopes });
    return actionOk({ authorizeUrl: target.toString(), state, expiresIn: 600 });
  }

  async #exchangeOAuthToken(
    connector: Row,
    form: URLSearchParams,
  ): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; message: string }> {
    const tokenUrl = text(connector, 'token_url');
    if (!tokenUrl) return { ok: false, message: '请先配置 OAuth 令牌地址' };
    const target = await safeConnectorTarget(tokenUrl, this.#connectorDomains(connector));
    if ('issue' in target) return { ok: false, message: target.issue };
    try {
      const response = await fetch(target.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: form,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      const raw = await response.text();
      let payload: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>;
        }
      } catch {
        payload = {};
      }
      if (!response.ok || typeof payload.access_token !== 'string') {
        return { ok: false, message: `OAuth 令牌交换失败 (${response.status})` };
      }
      return { ok: true, payload };
    } catch {
      return { ok: false, message: 'OAuth 令牌交换超时或网络不可达' };
    }
  }

  async connectorOauthCallback(
    user: SessionUser,
    connectorId: string,
    input: ConnectorOAuthCallback,
  ): Promise<ActionResult<Row>> {
    const found = this.#requireConnector(user, connectorId);
    if ('error' in found) return found.error;
    const connector = found.connector;
    if (text(connector, 'kind') !== 'oauth') return actionFail(400, '该连接器不是 OAuth 类型');
    const stateRow = this.#row(
      'SELECT * FROM connector_oauth_states WHERE state = ? AND connector_id = ?',
      [this.#hash(input.state), connectorId],
    );
    if (
      !stateRow ||
      text(stateRow, 'workspace_id') !== text(connector, 'workspace_id') ||
      text(stateRow, 'used_at') !== ''
    ) {
      return actionFail(400, 'OAuth 授权状态无效或已使用');
    }
    if (Date.parse(text(stateRow, 'expires_at')) <= Date.now()) {
      return actionFail(400, 'OAuth 授权已过期');
    }
    const markUsed = (): void => {
      this.#db
        .stmt('UPDATE connector_oauth_states SET used_at = ? WHERE state = ?')
        .run(this.#now(), text(stateRow, 'state'));
    };
    const clientId = text(connector, 'client_id');
    if (!clientId) return actionFail(400, '请先配置 OAuth 客户端 ID');
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: text(stateRow, 'redirect_uri'),
      client_id: clientId,
      code_verifier: text(stateRow, 'code_verifier'),
    });
    const clientSecret = decryptConnectorSecret(this.#db, text(connector, 'client_secret_ref'));
    if (clientSecret) form.set('client_secret', clientSecret);
    const exchanged = await this.#exchangeOAuthToken(connector, form);
    if (!exchanged.ok) return actionFail(400, exchanged.message);
    markUsed();
    const payload = exchanged.payload;
    const accessToken = String(payload.access_token);
    const refreshToken = typeof payload.refresh_token === 'string' ? payload.refresh_token : '';
    const expiresIn = Number(payload.expires_in);
    const tokenExpiresAt =
      Number.isFinite(expiresIn) && expiresIn > 0
        ? new Date(Date.now() + expiresIn * 1000).toISOString()
        : null;
    const stored = JSON.stringify({
      accessToken,
      refreshToken,
      tokenType: typeof payload.token_type === 'string' ? payload.token_type : 'Bearer',
      scope: typeof payload.scope === 'string' ? payload.scope : '',
      expiresAt: tokenExpiresAt,
    });
    const now = this.#now();
    this.#db
      .stmt(
        `UPDATE connectors SET secret_ref = ?, health = 'ok', token_expires_at = ?,
           version = version + 1, updated_at = ? WHERE id = ?`,
      )
      .run(encryptConnectorSecret(this.#db, stored), tokenExpiresAt, now, connectorId);
    this.#audit(user, 'connector.oauth.callback', connectorId, {
      tokenExpiresAt,
      scope: typeof payload.scope === 'string' ? payload.scope : '',
    });
    return actionOk({
      id: connectorId,
      health: 'ok',
      tokenExpiresAt,
      hasRefreshToken: refreshToken !== '',
    });
  }

  async connectorOauthRefresh(user: SessionUser, connectorId: string): Promise<ActionResult<Row>> {
    const found = this.#requireConnector(user, connectorId);
    if ('error' in found) return found.error;
    const connector = found.connector;
    if (text(connector, 'kind') !== 'oauth') return actionFail(400, '该连接器不是 OAuth 类型');
    const current = this.#oauthTokenState(connector);
    const refreshToken = typeof current.refreshToken === 'string' ? current.refreshToken : '';
    if (!refreshToken) return actionFail(400, '连接器没有可用的刷新令牌');
    const clientId = text(connector, 'client_id');
    if (!clientId) return actionFail(400, '请先配置 OAuth 客户端 ID');
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    });
    const clientSecret = decryptConnectorSecret(this.#db, text(connector, 'client_secret_ref'));
    if (clientSecret) form.set('client_secret', clientSecret);
    const exchanged = await this.#exchangeOAuthToken(connector, form);
    if (!exchanged.ok) return actionFail(400, exchanged.message);
    const payload = exchanged.payload;
    const expiresIn = Number(payload.expires_in);
    const tokenExpiresAt =
      Number.isFinite(expiresIn) && expiresIn > 0
        ? new Date(Date.now() + expiresIn * 1000).toISOString()
        : null;
    const stored = JSON.stringify({
      accessToken: String(payload.access_token),
      refreshToken:
        typeof payload.refresh_token === 'string' ? payload.refresh_token : refreshToken,
      tokenType: typeof payload.token_type === 'string' ? payload.token_type : 'Bearer',
      scope: typeof payload.scope === 'string' ? payload.scope : current.scope,
      expiresAt: tokenExpiresAt,
    });
    this.#db
      .stmt(
        `UPDATE connectors SET secret_ref = ?, health = 'ok', token_expires_at = ?,
           version = version + 1, updated_at = ? WHERE id = ?`,
      )
      .run(encryptConnectorSecret(this.#db, stored), tokenExpiresAt, this.#now(), connectorId);
    this.#audit(user, 'connector.oauth.refresh', connectorId, { tokenExpiresAt });
    return actionOk({ id: connectorId, health: 'ok', tokenExpiresAt });
  }

  async connectorCall(
    user: SessionUser,
    connectorId: string,
    input: ConnectorCall,
  ): Promise<ActionResult<Row>> {
    const found = this.#requireConnector(user, connectorId);
    if ('error' in found) return found.error;
    const connector = found.connector;
    if (number(connector, 'active') !== 1) return actionFail(400, '连接器已停用');
    const method = input.method ?? 'GET';
    if (method !== 'GET' && (!input.confirm || !input.reason?.trim())) {
      return actionFail(400, '写操作需要确认并提供原因');
    }
    const target = await safeConnectorTarget(input.url, this.#connectorDomains(connector));
    if ('issue' in target) return actionFail(400, target.issue);
    const rateLimit = Math.max(number(connector, 'rate_limit'), 1);
    const limited = connectorRateIssue(this.#db, connectorId, rateLimit, this.#now());
    if (limited) return actionFail(409, limited);
    const kind = text(connector, 'kind');
    const stored = decryptConnectorSecret(this.#db, text(connector, 'secret_ref'));
    const tokenState = kind === 'oauth' ? this.#oauthTokenState(connector) : {};
    const bearer =
      kind === 'oauth'
        ? typeof tokenState.accessToken === 'string'
          ? tokenState.accessToken
          : ''
        : (stored ?? '');
    const headers: Record<string, string> = { accept: 'application/json' };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    if (input.body !== undefined) headers['content-type'] = 'application/json';
    const started = Date.now();
    try {
      const response = await fetch(target.url, {
        method,
        headers,
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      const raw = await response.text();
      const durationMs = Date.now() - started;
      const ok = response.ok;
      logConnectorCall(this.#db, {
        connectorId,
        workspaceId: text(connector, 'workspace_id'),
        method,
        url: target.url.toString(),
        status: response.status,
        ok,
        error: null,
        durationMs,
        userId: user.id,
        now: this.#now(),
      });
      this.#db
        .stmt(`UPDATE connectors SET health = ?, updated_at = ? WHERE id = ?`)
        .run(ok ? 'ok' : 'degraded', this.#now(), connectorId);
      this.#audit(user, 'connector.call', connectorId, {
        method,
        host: target.url.host,
        status: response.status,
        reason: input.reason ?? null,
      });
      return actionOk({
        status: response.status,
        ok,
        durationMs,
        body: raw.slice(0, 5_000),
        truncated: raw.length > 5_000,
      });
    } catch {
      logConnectorCall(this.#db, {
        connectorId,
        workspaceId: text(connector, 'workspace_id'),
        method,
        url: target.url.toString(),
        status: null,
        ok: false,
        error: 'network_error',
        durationMs: Date.now() - started,
        userId: user.id,
        now: this.#now(),
      });
      this.#db
        .stmt('UPDATE connectors SET health = ?, updated_at = ? WHERE id = ?')
        .run('degraded', this.#now(), connectorId);
      return actionFail(500, '连接器调用失败或超时');
    }
  }

  publishDomainEvent(user: SessionUser, input: EventPublish): ActionResult<Row> {
    if (!this.#manageWorkspace(user)) return actionFail(403, '没有发布领域事件的权限');
    const event = this.#store.domain.publishEvent(
      this.#workspace(user),
      input.type,
      input.payload ?? {},
      user.id,
      input.dedupeKey,
      input.version,
    );
    if (!event) return actionOk({ duplicate: true, type: input.type });
    this.#audit(user, 'event.publish', text(event, 'id'), { type: input.type });
    const triggers = this.#rows(
      `SELECT * FROM workflow_triggers
       WHERE workspace_id = ? AND active = 1 AND type = 'event'`,
      [this.#workspace(user)],
    );
    const triggered: string[] = [];
    for (const trigger of triggers) {
      const config = jsonObject(trigger.config_json);
      const expected = String(config.eventType ?? '');
      if (expected && expected !== input.type) continue;
      const result = this.fireTrigger(user, text(trigger, 'id'), {
        dryRun: false,
        eventKey: `event:${text(event, 'id')}`,
      });
      if (result.ok) triggered.push(text(trigger, 'id'));
    }
    return actionOk({ ...event, triggered });
  }

  createEventSubscription(user: SessionUser, input: EventSubscriptionCreate): ActionResult<Row> {
    if (!this.#manageWorkspace(user)) return actionFail(403, '没有管理事件订阅的权限');
    const now = this.#now();
    const id = randomUUID();
    this.#db
      .stmt(
        `INSERT INTO event_subscriptions
           (id, workspace_id, event_type, filter_json, endpoint, secret, active, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.#workspace(user),
        input.eventType,
        JSON.stringify(input.filter ?? {}),
        input.endpoint ?? '',
        input.secret ?? '',
        input.active === false ? 0 : 1,
        user.id,
        now,
      );
    this.#audit(user, 'event.subscription.create', id, { eventType: input.eventType });
    return actionOk(this.#row('SELECT * FROM event_subscriptions WHERE id = ?', [id]) ?? {});
  }

  async tickEventDeliveries(user: SessionUser): Promise<ActionResult<Row>> {
    const now = this.#now();
    const due = this.#rows(
      `SELECT d.* FROM event_deliveries d
       JOIN domain_events e ON e.id = d.event_id
       WHERE e.workspace_id = ? AND d.status IN ('pending', 'failed')
         AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)
       ORDER BY d.created_at ASC LIMIT 100`,
      [this.#workspace(user), now],
    );
    let delivered = 0;
    let failed = 0;
    let dead = 0;
    for (const delivery of due) {
      const subscription = this.#row('SELECT * FROM event_subscriptions WHERE id = ?', [
        text(delivery, 'subscription_id'),
      ]);
      const event = this.#row('SELECT * FROM domain_events WHERE id = ?', [
        text(delivery, 'event_id'),
      ]);
      const endpoint = subscription ? text(subscription, 'endpoint') : '';
      const attempts = number(delivery, 'attempts') + 1;
      let error = '';
      let ok = false;
      const simulated = Boolean(process.env.NODE_TEST_CONTEXT) || endpoint.endsWith('.test');
      if (simulated) {
        ok = !endpoint.includes('fail.test');
        error = ok ? '' : '端点返回失败';
      } else {
        const issue = endpoint ? webhookUrlIssue(endpoint) : '订阅未配置端点';
        if (issue) {
          error = issue;
        } else {
          try {
            const payload = event ? jsonObject(event.payload_json) : {};
            const body = JSON.stringify({
              id: delivery.event_id,
              type: event ? text(event, 'type') : '',
              version: event ? number(event, 'schema_version') : 1,
              createdAt: event ? text(event, 'created_at') : now,
              payload,
            });
            const timestamp = Math.floor(Date.now() / 1000);
            const signature = webhookSignature(
              subscription ? text(subscription, 'secret') : '',
              timestamp,
              body,
            );
            const response = await fetch(endpoint, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'user-agent': 'Pulse-Events/1.0',
                'x-event-id': text(delivery, 'event_id'),
                'x-event-delivery': text(delivery, 'id'),
                'x-event-version': String(event ? number(event, 'schema_version') : 1),
                'x-event-attempt': String(attempts),
                'x-event-timestamp': String(timestamp),
                'x-event-signature': `sha256=${signature}`,
              },
              body,
              redirect: 'error',
              signal: AbortSignal.timeout(5_000),
            });
            ok = response.ok;
            if (!ok) error = `HTTP ${response.status}`;
            await response.body?.cancel().catch(() => {});
          } catch (fetchError) {
            error = fetchError instanceof Error ? fetchError.message : '投递失败';
          }
        }
      }
      if (ok) {
        delivered += 1;
        this.#db
          .stmt(
            `UPDATE event_deliveries SET status = 'delivered', attempts = ?, delivered_at = ?,
               next_attempt_at = NULL, last_error = NULL WHERE id = ?`,
          )
          .run(attempts, this.#now(), text(delivery, 'id'));
      } else {
        const nextStatus = attempts >= 5 ? 'dead' : 'failed';
        if (nextStatus === 'dead') dead += 1;
        else failed += 1;
        this.#db
          .stmt(
            `UPDATE event_deliveries SET status = ?, attempts = ?, last_error = ?,
               next_attempt_at = ? WHERE id = ?`,
          )
          .run(
            nextStatus,
            attempts,
            error.slice(0, 200),
            nextStatus === 'dead' ? null : new Date(Date.now() + attempts * 60_000).toISOString(),
            text(delivery, 'id'),
          );
      }
    }
    return actionOk({ processed: due.length, delivered, failed, dead });
  }

  retryEventDelivery(user: SessionUser, deliveryId: string): ActionResult<Row> {
    const delivery = this.#row(
      `SELECT d.* FROM event_deliveries d JOIN domain_events e ON e.id = d.event_id
       WHERE d.id = ? AND e.workspace_id = ?`,
      [deliveryId, this.#workspace(user)],
    );
    if (!delivery) return actionFail(404, '投递记录不存在');
    this.#db
      .stmt(
        `UPDATE event_deliveries SET status = 'pending', next_attempt_at = NULL,
           last_error = NULL WHERE id = ?`,
      )
      .run(deliveryId);
    this.#audit(user, 'event.delivery.retry', deliveryId, {});
    return actionOk({ id: deliveryId, status: 'pending' });
  }

  // -------------------------------------------------------------------------
  // Background jobs and sandbox
  // -------------------------------------------------------------------------

  createBackgroundJob(user: SessionUser, input: BackgroundJobCreate): ActionResult<Row> {
    const existing = input.idempotencyKey
      ? this.#row('SELECT * FROM background_jobs WHERE idempotency_key = ?', [input.idempotencyKey])
      : null;
    if (existing) return actionOk(existing);
    const id = randomUUID();
    const now = this.#now();
    this.#db
      .stmt(
        `INSERT INTO background_jobs
           (id, kind, status, payload_json, result_json, attempts, max_attempts,
            next_attempt_at, idempotency_key, created_at, updated_at)
         VALUES (?, ?, 'pending', ?, '{}', 0, 3, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.kind,
        JSON.stringify(input.payload ?? {}),
        input.runAt ?? now,
        input.idempotencyKey ?? null,
        now,
        now,
      );
    this.#audit(user, 'job.create', id, { kind: input.kind });
    return actionOk(this.#row('SELECT * FROM background_jobs WHERE id = ?', [id]) ?? {});
  }

  async tickBackgroundJobs(
    user: SessionUser,
    input: BackgroundJobTick,
  ): Promise<ActionResult<Row>> {
    if (!this.#manageWorkspace(user)) return actionFail(403, '没有运行后台任务的权限');
    const limit = input.limit ?? 20;
    const now = this.#now();
    const jobs = this.#rows(
      `SELECT * FROM background_jobs
       WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY next_attempt_at ASC LIMIT ?`,
      [now, limit],
    );
    const processed: Row[] = [];
    for (const job of jobs) {
      const claimed = this.#row(
        `UPDATE background_jobs SET status = 'running', locked_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending' RETURNING *`,
        [now, now, text(job, 'id')],
      );
      if (!claimed) continue;
      let result: Record<string, unknown> = { ok: true };
      let error: string | null = null;
      try {
        const kind = text(job, 'kind');
        if (kind === 'reindex') {
          result = {
            projects: number(this.#row('SELECT COUNT(*) AS count FROM projects'), 'count'),
          };
        } else if (kind === 'snapshot') {
          result = {
            metrics: number(this.#row('SELECT COUNT(*) AS count FROM daily_metrics'), 'count'),
          };
        } else if (kind === 'event.delivery') {
          const tick = await this.tickEventDeliveries(user);
          result = tick.ok ? (tick.data as Row) : { error: tick.message };
        } else if (kind === 'noop') {
          result = { ok: true };
        } else {
          result = { ok: true, kind };
        }
      } catch (issue) {
        error = issue instanceof Error ? issue.message : '任务执行失败';
      }
      const attempts = number(job, 'attempts') + 1;
      const maxAttempts = number(job, 'max_attempts');
      const status = error ? (attempts >= maxAttempts ? 'failed' : 'pending') : 'succeeded';
      const updated = this.#row(
        `UPDATE background_jobs SET status = ?, attempts = ?, result_json = ?, error = ?,
           next_attempt_at = ?, locked_at = NULL, updated_at = ?
         WHERE id = ? RETURNING *`,
        [
          status,
          attempts,
          JSON.stringify(result),
          error,
          error && status === 'pending'
            ? new Date(Date.now() + attempts * 60_000).toISOString()
            : null,
          this.#now(),
          text(job, 'id'),
        ],
      );
      processed.push(updated ?? {});
      this.#audit(user, 'job.tick', text(job, 'id'), { kind: job.kind, status, error });
    }
    return actionOk({ processed });
  }

  retryBackgroundJob(user: SessionUser, jobId: string): ActionResult<Row> {
    if (!this.#manageWorkspace(user)) return actionFail(403, '没有重试后台任务的权限');
    const job = this.#row('SELECT * FROM background_jobs WHERE id = ?', [jobId]);
    if (!job) return actionFail(404, '任务不存在');
    const updated = this.#row(
      `UPDATE background_jobs SET status = 'pending', next_attempt_at = NULL, locked_at = NULL,
         error = NULL, updated_at = ? WHERE id = ? RETURNING *`,
      [this.#now(), jobId],
    );
    return actionOk(updated ?? {});
  }

  sandboxRun(user: SessionUser, input: SandboxRun): ActionResult<Row> {
    if (!this.#manageWorkspace(user)) return actionFail(403, '没有运行沙箱的权限');
    const maxActions = Math.min(input.limits?.maxActions ?? 50, 100);
    if (input.actions.length > maxActions) {
      return actionFail(400, `沙箱最多允许 ${maxActions} 个动作`);
    }
    const maxCpuMs = Math.min(input.limits?.maxCpuMs ?? 5_000, 60_000);
    const maxMs = Math.min(input.limits?.maxMs ?? 5_000, 60_000);
    const maxMemoryMb = Math.min(input.limits?.maxMemoryMb ?? 256, 1024);
    const allowedNetwork = (input.limits?.network ?? []).map((domain) =>
      String(domain).trim().toLowerCase(),
    );
    const allowedActions = new Set(
      (input.limits?.allowedActions ?? []).map((action) => String(action)),
    );
    const allowedFields = new Set((input.limits?.fields ?? []).map((field) => String(field)));
    const workspaceId = this.#workspace(user);
    const now = this.#now();
    const results: Row[] = [];
    let startIndex = 0;
    if (input.resumeFrom) {
      const checkpoint = this.#row(
        `SELECT * FROM sandbox_checkpoints WHERE id = ? AND workspace_id = ?`,
        [input.resumeFrom, workspaceId],
      );
      if (!checkpoint || Date.parse(text(checkpoint, 'expires_at')) <= Date.now()) {
        return actionFail(404, '沙箱检查点不存在或已过期');
      }
      const state = jsonObject(checkpoint.state_json);
      const savedActions = JSON.stringify(state.actions ?? []);
      if (savedActions !== JSON.stringify(input.actions)) {
        return actionFail(400, '检查点与当前动作列表不匹配');
      }
      for (const previous of Array.isArray(state.results) ? state.results : []) {
        if (previous && typeof previous === 'object') results.push(previous as Row);
      }
      startIndex = Math.max(0, Number(state.nextIndex ?? 0));
    }
    const started = Date.now();
    for (let index = startIndex; index < input.actions.length; index += 1) {
      const action = input.actions[index] as SandboxRun['actions'][number];
      if (allowedActions.size > 0 && !allowedActions.has(action.type)) {
        return actionFail(400, `沙箱动作 ${action.type} 不在允许列表内`);
      }
      if (action.fields?.some((field) => allowedFields.size > 0 && !allowedFields.has(field))) {
        return actionFail(400, '沙箱动作包含未授权的字段');
      }
      if (action.type === 'network') {
        let host = String(action.value ?? '');
        try {
          host = new URL(host).hostname.toLowerCase();
        } catch {
          return actionFail(400, '沙箱网络动作地址无效');
        }
        if (
          allowedNetwork.length === 0 ||
          !allowedNetwork.some(
            (domain) => host === domain.replace(/^\*\./, '') || host.endsWith(`.${domain}`),
          )
        ) {
          return actionFail(400, `沙箱禁止访问网络域 ${host}`);
        }
      }
      const elapsed = Date.now() - started;
      if (elapsed > maxCpuMs || elapsed > maxMs) {
        return actionFail(400, '沙箱执行超出时间限制');
      }
      results.push({ type: action.type, value: action.value ?? null, status: 'simulated' });
    }
    const checkpointId = randomUUID();
    this.#db
      .stmt(
        `INSERT INTO sandbox_checkpoints
           (id, workspace_id, state_json, created_by, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        checkpointId,
        workspaceId,
        JSON.stringify({ actions: input.actions, results, nextIndex: input.actions.length }),
        user.id,
        new Date(Date.now() + 3_600_000).toISOString(),
        now,
      );
    this.#audit(user, 'sandbox.run', 'sandbox', {
      actions: input.actions.length,
      resumedFrom: input.resumeFrom ?? null,
      checkpointId,
    });
    return actionOk({
      results,
      elapsedMs: Date.now() - started,
      limits: {
        maxActions,
        maxMs,
        maxCpuMs,
        maxMemoryMb,
        network: allowedNetwork,
      },
      checkpoint: checkpointId,
      resumedFrom: input.resumeFrom ?? null,
    });
  }

  rollbackAutomationRule(
    user: SessionUser,
    ruleId: string,
    input: z.infer<typeof AutomationRollbackSchema>,
  ): ActionResult<Row> {
    const rule = this.#row('SELECT * FROM automation_rules WHERE id = ?', [ruleId]);
    if (!rule || text(rule, 'workspace_id') !== this.#workspace(user)) {
      return actionFail(404, '自动化规则不存在');
    }
    if (!this.#manageWorkspace(user)) return actionFail(403, '没有回滚自动化规则的权限');
    const target = this.#row(
      'SELECT * FROM automation_rule_versions WHERE rule_id = ? AND version = ?',
      [ruleId, input.version],
    );
    if (!target) return actionFail(404, '目标版本不存在');
    const snapshot = jsonObject(target.snapshot_json);
    const now = this.#now();
    const current = this.#store.automation.recordVersion(ruleId, this.#workspace(user));
    if (!current) return actionFail(404, '自动化规则不存在');
    const updated = this.#row(
      `UPDATE automation_rules SET name = ?, project_id = ?, trigger_event = ?,
         conditions_json = ?, actions_json = ?, active = ?, max_runs_per_hour = ?,
         version = version + 1, updated_at = ? WHERE id = ? AND version = ? RETURNING *`,
      [
        typeof snapshot.name === 'string' ? snapshot.name : text(rule, 'name'),
        typeof snapshot.projectId === 'string'
          ? snapshot.projectId
          : text(rule, 'project_id') || null,
        typeof snapshot.trigger === 'string' ? snapshot.trigger : text(rule, 'trigger_event'),
        Array.isArray(snapshot.conditions)
          ? JSON.stringify(snapshot.conditions)
          : text(rule, 'conditions_json'),
        Array.isArray(snapshot.actions)
          ? JSON.stringify(snapshot.actions)
          : text(rule, 'actions_json'),
        snapshot.active === false ? 0 : 1,
        typeof snapshot.maxRunsPerHour === 'number'
          ? snapshot.maxRunsPerHour
          : number(rule, 'max_runs_per_hour'),
        now,
        ruleId,
        current.version,
      ],
    );
    if (!updated) return actionFail(409, '自动化规则已被其他会话修改，请重试');
    this.#audit(user, 'automation.rollback', ruleId, {
      toVersion: input.version,
      before: rule,
      after: updated,
    });
    return actionOk(updated);
  }

  // -------------------------------------------------------------------------
  // Analytics, quality and forecasting
  // -------------------------------------------------------------------------

  detectAnomalies(user: SessionUser, input: AnomalyDetect): ActionResult<Row> {
    const metric = this.#row('SELECT * FROM metric_definitions WHERE id = ?', [input.metricId]);
    if (!metric || text(metric, 'workspace_id') !== this.#workspace(user)) {
      return actionFail(404, '指标不存在');
    }
    if (input.from > input.to) return actionFail(400, '开始日期不能晚于结束日期');
    const threshold = input.threshold ?? 3;
    const current = this.#store.insights.evaluateMetric(input.metricId, this.#workspace(user), {
      from: input.from,
      to: input.to,
      groupBy: 'day',
    });
    if (!current) return actionFail(404, '指标不存在');
    const span = Math.max(
      1,
      Math.round((Date.parse(input.to) - Date.parse(input.from)) / 86_400_000) + 1,
    );
    const windowDays = Math.min(Math.max(input.window ?? span, 3), 365);
    const previous = this.#store.insights.evaluateMetric(input.metricId, this.#workspace(user), {
      from: addDays(input.from, -windowDays),
      to: addDays(input.from, -1),
      groupBy: 'day',
    });
    const baselinePoints = (previous?.series ?? [])
      .filter((point) => point.value !== null && Number.isFinite(point.value))
      .map((point) => ({ bucket: point.bucket, value: Number(point.value) }));
    const currentValues = (current.series ?? [])
      .filter((point) => point.value !== null && Number.isFinite(point.value))
      .map((point) => ({ bucket: point.bucket, value: Number(point.value) }));
    if (currentValues.length === 0) {
      return actionOk({ metricId: input.metricId, anomalies: [], message: '区间内没有可评估数据' });
    }
    const weekday = (bucket: string): number => new Date(`${bucket}T00:00:00.000Z`).getUTCDay();
    const weekdayPools = new Map<number, number[]>();
    for (const point of baselinePoints) {
      const key = weekday(point.bucket);
      weekdayPools.set(key, [...(weekdayPools.get(key) ?? []), point.value]);
    }
    const stats = (values: number[]): { mean: number; std: number; samples: number } => {
      if (values.length === 0) return { mean: 0, std: 0, samples: 0 };
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
      return { mean, std: Math.sqrt(variance), samples: values.length };
    };
    const fallbackPool =
      baselinePoints.length >= 2
        ? baselinePoints.map((point) => point.value)
        : currentValues.map((point) => point.value);
    const globalStats = stats(fallbackPool);
    const comparison =
      input.compare && input.compare !== 'none'
        ? (() => {
            const shift = input.compare === 'yoy' ? -365 : -30;
            const series = this.#store.insights.evaluateMetric(
              input.metricId,
              this.#workspace(user),
              { from: addDays(input.from, shift), to: addDays(input.to, shift), groupBy: 'day' },
            );
            const map = new Map(
              (series?.series ?? [])
                .filter((point) => point.value !== null)
                .map((point) => [point.bucket, Number(point.value)] as const),
            );
            return { type: input.compare, shift, map };
          })()
        : null;
    const now = this.#now();
    if ((input.quietWindowHours ?? 0) > 0) {
      const recent = this.#row(
        `SELECT * FROM metric_anomalies WHERE metric_id = ? AND detected_at >= ?
         ORDER BY detected_at DESC LIMIT 1`,
        [
          input.metricId,
          new Date(Date.parse(now) - (input.quietWindowHours ?? 0) * 3_600_000).toISOString(),
        ],
      );
      if (recent) {
        this.#audit(user, 'anomaly.detect', input.metricId, {
          from: input.from,
          to: input.to,
          quieted: true,
        });
        return actionOk({
          metricId: input.metricId,
          anomalies: [],
          quieted: true,
          suppressed: currentValues.length,
          lastDetectedAt: text(recent, 'detected_at'),
          message: '静默窗口内已存在异常提醒',
        });
      }
    }
    const projectIds = new Set(this.#visibleProjectIds(user));
    const cluesFor = (bucket: string): Row[] => {
      const clues: Row[] = [];
      const channels = this.#rows(
        `SELECT channel, SUM(sessions) AS sessions FROM channel_daily
         WHERE date = ? GROUP BY channel ORDER BY sessions DESC LIMIT 10`,
        [bucket],
      );
      const baselineChannels = this.#rows(
        `SELECT channel, AVG(sessions) AS sessions, COUNT(*) AS samples FROM (
           SELECT date, channel, SUM(sessions) AS sessions FROM channel_daily
           WHERE date >= ? AND date <= ? GROUP BY date, channel
         ) GROUP BY channel`,
        [addDays(bucket, -windowDays), addDays(bucket, -1)],
      );
      const channelBase = new Map(
        baselineChannels.map((row) => [text(row, 'channel'), number(row, 'sessions')] as const),
      );
      const channelClues = channels
        .map((row) => {
          const value = number(row, 'sessions');
          const base = channelBase.get(text(row, 'channel')) ?? 0;
          if (base <= 0) return null;
          const changePct = Math.round(((value - base) / base) * 1000) / 10;
          if (Math.abs(changePct) < 20) return null;
          return {
            type: 'channel' as const,
            label: text(row, 'channel'),
            value,
            baseline: base,
            changePct,
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null)
        .slice(0, 5);
      clues.push(...channelClues);
      const overdue = this.#rows(
        `SELECT p.id, p.name, COUNT(*) AS overdue FROM project_tasks t
         JOIN projects p ON p.id = t.project_id
         WHERE p.workspace_id = ? AND p.deleted_at IS NULL AND t.status <> 'done'
           AND t.due_date IS NOT NULL AND t.due_date <> '' AND t.due_date < ?
         GROUP BY p.id ORDER BY overdue DESC LIMIT 5`,
        [this.#workspace(user), bucket],
      );
      for (const row of overdue) {
        if (!projectIds.has(text(row, 'id'))) continue;
        clues.push({
          type: 'project',
          id: text(row, 'id'),
          label: text(row, 'name'),
          value: number(row, 'overdue'),
          detail: '逾期任务数',
        });
      }
      const opportunities = this.#rows(
        `SELECT stage, COUNT(*) AS count FROM crm_opportunities
         WHERE workspace_id = ? AND substr(entered_stage_at, 1, 10) = ?
         GROUP BY stage ORDER BY count DESC`,
        [this.#workspace(user), bucket],
      );
      for (const row of opportunities) {
        clues.push({
          type: 'opportunity',
          label: text(row, 'stage'),
          value: number(row, 'count'),
          detail: '当日进入阶段的商机数',
        });
      }
      return clues.slice(0, 8);
    };
    const anomalies: Row[] = [];
    let lowSample = false;
    for (const point of currentValues) {
      const pool = input.seasonal
        ? (weekdayPools.get(weekday(point.bucket)) ?? [])
        : baselinePoints.map((item) => item.value);
      const usePool = pool.length >= 2 ? pool : fallbackPool;
      const pointStats = usePool === fallbackPool ? globalStats : stats(usePool);
      if (pointStats.samples < 3) lowSample = true;
      const mean = pointStats.mean;
      const std = pointStats.std;
      if (std === 0) {
        if (point.value === mean) continue;
      }
      const z = std === 0 ? Number.POSITIVE_INFINITY : (point.value - mean) / std;
      if (Math.abs(z) < threshold) continue;
      const severity = Math.abs(z) >= threshold + 1 ? 'critical' : 'warn';
      const dedupe = `${input.metricId}:${point.bucket}`;
      const id = randomUUID();
      const deviation = mean === 0 ? 0 : ((point.value - mean) / Math.abs(mean)) * 100;
      const compareValue = comparison?.map.get(addDays(point.bucket, comparison.shift)) ?? null;
      const compareChangePct =
        compareValue === null || compareValue === 0
          ? null
          : Math.round(((point.value - compareValue) / Math.abs(compareValue)) * 1000) / 10;
      const dimensions = {
        baselineMethod: input.seasonal ? 'weekday' : 'moving_window',
        samples: pointStats.samples,
        clues: cluesFor(point.bucket),
        comparison: comparison
          ? { type: comparison.type, value: compareValue, changePct: compareChangePct }
          : null,
      };
      this.#db
        .stmt(
          `INSERT INTO metric_anomalies
             (id, metric_id, period, value, baseline, deviation, severity, dimensions_json,
              status, dedupe_key, detected_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
           ON CONFLICT (dedupe_key) DO NOTHING`,
        )
        .run(
          id,
          input.metricId,
          point.bucket,
          point.value,
          mean,
          deviation,
          severity,
          JSON.stringify(dimensions),
          dedupe,
          now,
          now,
        );
      const stored = this.#row('SELECT * FROM metric_anomalies WHERE dedupe_key = ?', [dedupe]);
      anomalies.push({
        ...(stored ?? { id, period: point.bucket, value: point.value, baseline: mean, severity }),
        zScore: Number.isFinite(z) ? Math.round(z * 100) / 100 : null,
        dimensions,
      });
    }
    this.#audit(user, 'anomaly.detect', input.metricId, {
      from: input.from,
      to: input.to,
      threshold,
      count: anomalies.length,
      seasonal: input.seasonal === true,
    });
    if (anomalies.length > 0) {
      this.#publish(
        'anomaly.detected',
        { metricId: input.metricId, count: anomalies.length },
        user,
      );
    }
    return actionOk({
      metricId: input.metricId,
      baseline: {
        mean: globalStats.mean,
        std: globalStats.std,
        samples: globalStats.samples,
        method: input.seasonal ? 'weekday' : 'moving_window',
        windowDays,
      },
      comparison: comparison?.type ?? 'none',
      lowSample,
      anomalies,
    });
  }

  dismissAnomaly(user: SessionUser, anomalyId: string, input: AnomalyDismiss): ActionResult<Row> {
    if (!this.#manageWorkspace(user)) return actionFail(403, '没有处理异常的权限');
    const anomaly = this.#row('SELECT * FROM metric_anomalies WHERE id = ?', [anomalyId]);
    if (!anomaly) return actionFail(404, '异常不存在');
    const metric = this.#row('SELECT * FROM metric_definitions WHERE id = ?', [
      text(anomaly, 'metric_id'),
    ]);
    if (!metric || text(metric, 'workspace_id') !== this.#workspace(user)) {
      return actionFail(404, '异常不存在');
    }
    const updated = this.#row(
      `UPDATE metric_anomalies SET status = 'dismissed' WHERE id = ? RETURNING *`,
      [anomalyId],
    );
    this.#audit(user, 'anomaly.dismiss', anomalyId, { note: input.note ?? '' });
    return actionOk(updated ?? {});
  }

  #qualityIssue(
    rule: Row,
    key: string,
    details: Record<string, unknown>,
    record: Row | null,
  ): boolean {
    const issueKey = `${text(rule, 'id')}:${key}`;
    const result = this.#db
      .stmt(
        `INSERT INTO data_quality_issues
           (id, rule_id, issue_key, details_json, status, original_json, fixed_json,
            fix_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'open', ?, '{}', '', ?, ?)
         ON CONFLICT (issue_key) DO NOTHING`,
      )
      .run(
        randomUUID(),
        text(rule, 'id'),
        issueKey,
        JSON.stringify(details),
        JSON.stringify(record ?? {}),
        this.#now(),
        this.#now(),
      );
    return Number(result.changes) > 0;
  }

  scanQuality(user: SessionUser, input: QualityScan): ActionResult<Row> {
    if (!this.#manageWorkspace(user)) return actionFail(403, '没有运行数据质量扫描的权限');
    const rules = input.ruleId
      ? this.#rows('SELECT * FROM data_quality_rules WHERE id = ? AND workspace_id = ?', [
          input.ruleId,
          this.#workspace(user),
        ])
      : this.#rows('SELECT * FROM data_quality_rules WHERE workspace_id = ? AND active = 1', [
          this.#workspace(user),
        ]);
    let created = 0;
    for (const rule of rules) {
      const dataset = text(rule, 'dataset');
      const type = text(rule, 'rule_type');
      const ruleConfig = jsonObject(rule.config_json);
      const record = (key: string, row: Row, details: Record<string, unknown>) => {
        if (this.#qualityIssue(rule, key, { ...details, recordId: row.id, dataset }, row)) {
          created += 1;
        }
      };
      const metricFields = ['revenue_cents', 'customers', 'conversions', 'visitors'];
      const field = typeof ruleConfig.field === 'string' ? ruleConfig.field : '';
      const left = typeof ruleConfig.left === 'string' ? ruleConfig.left : '';
      const right = typeof ruleConfig.right === 'string' ? ruleConfig.right : '';
      const operator = typeof ruleConfig.operator === 'string' ? ruleConfig.operator : '';
      const compareOps: Record<string, string> = {
        eq: '=',
        neq: '!=',
        gt: '>',
        gte: '>=',
        lt: '<',
        lte: '<=',
      };
      if (dataset === 'daily_metrics') {
        if (type === 'completeness') {
          const chosen = Array.isArray(ruleConfig.fields)
            ? ruleConfig.fields.map(String).filter((name) => metricFields.includes(name))
            : [];
          const fieldsToCheck =
            chosen.length > 0 ? chosen : ['revenue_cents', 'customers', 'visitors'];
          for (const row of this.#rows(
            `SELECT * FROM daily_metrics WHERE ${fieldsToCheck.map((name) => `${name} = 0`).join(' AND ')}
             ORDER BY date DESC LIMIT 20`,
          )) {
            record(
              `empty:${text(row, 'date')}`,
              { ...row, id: text(row, 'date') },
              {
                date: row.date,
                issue: '指标值全部为空',
                fields: fieldsToCheck,
              },
            );
          }
        } else if (type === 'range') {
          if (metricFields.includes(field)) {
            const min = typeof ruleConfig.min === 'number' ? ruleConfig.min : null;
            const max = typeof ruleConfig.max === 'number' ? ruleConfig.max : null;
            const clauses: string[] = [];
            if (min !== null) clauses.push(`${field} < ?`);
            if (max !== null) clauses.push(`${field} > ?`);
            if (clauses.length > 0) {
              const params: (string | number)[] = [];
              if (min !== null) params.push(min);
              if (max !== null) params.push(max);
              for (const row of this.#rows(
                `SELECT * FROM daily_metrics WHERE ${clauses.join(' OR ')} LIMIT 50`,
                params,
              )) {
                record(
                  `range:${text(row, 'date')}:${field}`,
                  { ...row, id: text(row, 'date') },
                  { date: row.date, issue: '指标超出配置范围', field, min, max },
                );
              }
            }
          }
          for (const row of this.#rows(
            'SELECT * FROM daily_metrics WHERE revenue_cents < 0 OR customers < 0 LIMIT 50',
          )) {
            record(
              `negative:${text(row, 'date')}`,
              { ...row, id: text(row, 'date') },
              {
                date: row.date,
                issue: '负值指标',
              },
            );
          }
        } else if (type === 'consistency') {
          const pairs: [string, string, string][] = [];
          if (metricFields.includes(left) && metricFields.includes(right) && compareOps[operator]) {
            pairs.push([left, compareOps[operator] as string, right]);
          } else {
            pairs.push(['visitors', '>=', 'conversions'], ['conversions', '>=', 'customers']);
          }
          for (const [first, op, second] of pairs) {
            for (const row of this.#rows(
              `SELECT * FROM daily_metrics WHERE NOT (${first} ${op} ${second}) LIMIT 50`,
            )) {
              record(
                `cross:${text(row, 'date')}:${first}:${second}`,
                { ...row, id: text(row, 'date') },
                {
                  date: row.date,
                  issue: '跨字段一致性校验失败',
                  expression: `${first} ${op} ${second}`,
                  left: row[first],
                  right: row[second],
                },
              );
            }
          }
        } else if (type === 'continuity') {
          const days = this.#rows(`SELECT date FROM daily_metrics WHERE date >= ? ORDER BY date`, [
            addDays(today(), -30),
          ]);
          const present = new Set(days.map((row) => text(row, 'date')));
          for (let index = 0; index < 30; index += 1) {
            const day = addDays(today(), -30 + index);
            if (!present.has(day)) {
              if (
                this.#qualityIssue(
                  rule,
                  `gap:${day}`,
                  { date: day, issue: '日期缺失', dataset },
                  null,
                )
              ) {
                created += 1;
              }
            }
          }
        }
      } else if (dataset === 'opportunities') {
        if (type === 'uniqueness') {
          for (const row of this.#rows(
            `SELECT customer_email, COUNT(*) AS count, MIN(id) AS id FROM crm_opportunities
             WHERE workspace_id = ? GROUP BY customer_email HAVING COUNT(*) > 1`,
            [this.#workspace(user)],
          )) {
            record(`duplicate:${text(row, 'customer_email')}`, row, {
              email: row.customer_email,
              count: row.count,
            });
          }
        } else if (type === 'completeness') {
          for (const row of this.#rows(
            `SELECT * FROM crm_opportunities
             WHERE workspace_id = ? AND (owner_id IS NULL OR customer_email = '') LIMIT 50`,
            [this.#workspace(user)],
          )) {
            record(`missing:${text(row, 'id')}`, row, { issue: '缺少负责人或邮箱' });
          }
        } else if (type === 'range') {
          for (const row of this.#rows(
            `SELECT * FROM crm_opportunities WHERE workspace_id = ? AND amount_cents < 0 LIMIT 50`,
            [this.#workspace(user)],
          )) {
            record(`range:${text(row, 'id')}`, row, { issue: '商机金额为负' });
          }
        }
      } else if (dataset === 'projects') {
        if (type === 'completeness') {
          for (const row of this.#rows(
            `SELECT * FROM projects WHERE workspace_id = ? AND deleted_at IS NULL
             AND (owner_id IS NULL OR due_date IS NULL) LIMIT 50`,
            [this.#workspace(user)],
          )) {
            record(`missing:${text(row, 'id')}`, row, {
              issue: '项目缺少负责人或截止日期',
            });
          }
        } else if (type === 'consistency') {
          for (const row of this.#rows(
            `SELECT p.*,
                    (SELECT COUNT(*) FROM project_tasks t WHERE t.project_id = p.id) AS total,
                    (SELECT COUNT(*) FROM project_tasks t WHERE t.project_id = p.id
                      AND t.status = 'done') AS done
             FROM projects p WHERE p.workspace_id = ? AND p.deleted_at IS NULL LIMIT 50`,
            [this.#workspace(user)],
          )) {
            const total = number(row, 'total');
            if (total === 0) continue;
            const actual = Math.round((number(row, 'done') / total) * 100);
            if (Math.abs(actual - number(row, 'progress')) > 20) {
              record(`progress:${text(row, 'id')}`, row, {
                issue: '进度与任务完成度不一致',
                reported: number(row, 'progress'),
                actual,
              });
            }
          }
        }
      } else if (dataset === 'tasks') {
        if (type === 'completeness') {
          for (const row of this.#rows(
            `SELECT t.* FROM project_tasks t JOIN projects p ON p.id = t.project_id
             WHERE p.workspace_id = ? AND p.deleted_at IS NULL
               AND (t.assignee_id IS NULL OR t.due_date IS NULL) LIMIT 50`,
            [this.#workspace(user)],
          )) {
            record(`missing:${text(row, 'id')}`, row, { issue: '任务缺少负责人或截止日期' });
          }
        } else if (type === 'uniqueness') {
          for (const row of this.#rows(
            `SELECT t.title, t.project_id, COUNT(*) AS count, MIN(t.id) AS id
             FROM project_tasks t JOIN projects p ON p.id = t.project_id
             WHERE p.workspace_id = ? AND p.deleted_at IS NULL
             GROUP BY t.project_id, t.title HAVING COUNT(*) > 1`,
            [this.#workspace(user)],
          )) {
            record(`duplicate:${text(row, 'project_id')}:${text(row, 'title')}`, row, {
              issue: '同一项目内任务标题重复',
              count: row.count,
            });
          }
        }
      }
    }
    const open = this.#row(
      `SELECT COUNT(*) AS count FROM data_quality_issues i
       JOIN data_quality_rules r ON r.id = i.rule_id
       WHERE r.workspace_id = ? AND i.status = 'open'`,
      [this.#workspace(user)],
    );
    this.#audit(user, 'quality.scan', this.#workspace(user), {
      rules: rules.length,
      created,
    });
    return actionOk({ rules: rules.length, created, open: Number(open?.count ?? 0) });
  }

  #qualityChanges(dataset: string, fixed: Record<string, unknown>): Record<string, unknown> {
    const allowed: Record<string, string[]> = {
      daily_metrics: ['revenue_cents', 'customers', 'conversions', 'visitors'],
      projects: ['name', 'status', 'progress', 'due_date', 'owner_id'],
      tasks: ['title', 'status', 'priority', 'assignee_id', 'due_date'],
      opportunities: ['customer_name', 'customer_email', 'stage', 'amount_cents', 'owner_id'],
    };
    const keys = allowed[dataset] ?? [];
    return Object.fromEntries(
      Object.entries(fixed).filter(([key, value]) => keys.includes(key) && value !== undefined),
    );
  }

  #issueRecord(issue: Row): { dataset: string; recordId: string; table: string } | null {
    const rule = this.#row('SELECT * FROM data_quality_rules WHERE id = ?', [
      text(issue, 'rule_id'),
    ]);
    if (!rule) return null;
    const details = jsonObject(issue.details_json);
    const recordId = typeof details.recordId === 'string' ? details.recordId : '';
    const dataset = text(rule, 'dataset');
    const table: Record<string, string> = {
      daily_metrics: 'daily_metrics',
      projects: 'projects',
      tasks: 'project_tasks',
      opportunities: 'crm_opportunities',
    };
    return { dataset, recordId, table: table[dataset] ?? '' };
  }

  #applyQualityFix(
    user: SessionUser,
    issue: Row,
    input: { fixed: Record<string, unknown>; reason: string; preview?: boolean },
  ): ActionResult<Row> {
    const rule = this.#row('SELECT * FROM data_quality_rules WHERE id = ?', [
      text(issue, 'rule_id'),
    ]);
    if (!rule || text(rule, 'workspace_id') !== this.#workspace(user)) {
      return actionFail(404, '质量问题不存在');
    }
    const target = this.#issueRecord(issue);
    if (!target?.recordId) return actionFail(409, '该问题无法自动修复');
    const changes = this.#qualityChanges(target.dataset, input.fixed);
    if (Object.keys(changes).length === 0) return actionFail(400, '没有可修复的字段');
    const original = jsonObject(issue.original_json);
    const rollback = Object.fromEntries(
      Object.keys(changes).map((key) => [key, original[key] ?? null]),
    );
    if (input.preview) {
      return actionOk({
        issueId: issue.id,
        dataset: target.dataset,
        recordId: target.recordId,
        changes,
        rollback,
      });
    }
    const sets = Object.keys(changes).map((key) => `${key} = ?`);
    const where = target.dataset === 'daily_metrics' ? 'date = ?' : 'id = ?';
    this.#db
      .stmt(`UPDATE ${target.table} SET ${sets.join(', ')} WHERE ${where}`)
      .run(...(Object.values(changes) as (string | number | null)[]), target.recordId);
    const now = this.#now();
    const updated = this.#row(
      `UPDATE data_quality_issues SET status = 'fixed', fixed_json = ?, fix_reason = ?,
         resolved_by = ?, resolved_at = ?, updated_at = ? WHERE id = ? RETURNING *`,
      [JSON.stringify(changes), input.reason, user.id, now, now, text(issue, 'id')],
    );
    this.#audit(user, 'quality.fix', text(issue, 'id'), {
      before: issue,
      after: updated,
      reason: input.reason,
    });
    return actionOk(updated ?? {});
  }

  fixQualityIssue(user: SessionUser, issueId: string, input: QualityFix): ActionResult<Row> {
    const issue = this.#row('SELECT * FROM data_quality_issues WHERE id = ?', [issueId]);
    if (!issue) return actionFail(404, '质量问题不存在');
    const rule = this.#row('SELECT * FROM data_quality_rules WHERE id = ?', [
      text(issue, 'rule_id'),
    ]);
    if (!rule || text(rule, 'workspace_id') !== this.#workspace(user)) {
      return actionFail(404, '质量问题不存在');
    }
    if (!this.#manageWorkspace(user) && text(issue, 'assignee_id') !== user.id) {
      return actionFail(403, '没有修复数据质量问题的权限');
    }
    return this.#applyQualityFix(user, issue, {
      fixed: input.fixed,
      reason: input.reason,
      preview: input.preview,
    });
  }

  batchFixQuality(user: SessionUser, input: QualityBatchFix): ActionResult<Row> {
    if (!this.#manageWorkspace(user)) return actionFail(403, '没有批量修复的权限');
    const results: Row[] = [];
    const skipped: string[] = [];
    for (const issueId of input.issueIds) {
      const issue = this.#row('SELECT * FROM data_quality_issues WHERE id = ?', [issueId]);
      if (!issue) {
        skipped.push(issueId);
        continue;
      }
      if (input.preview) {
        const preview = this.#applyQualityFix(user, issue, {
          fixed: input.fixed,
          reason: input.reason,
          preview: true,
        });
        results.push(preview.ok ? (preview.data as Row) : { issueId, error: preview.message });
        continue;
      }
      const result = this.#applyQualityFix(user, issue, {
        fixed: input.fixed,
        reason: input.reason,
      });
      if (result.ok) results.push(result.data as Row);
      else skipped.push(issueId);
    }
    return actionOk({ fixed: results.length, skipped, results });
  }

  revertQualityFix(user: SessionUser, issueId: string, input: QualityRevert): ActionResult<Row> {
    if (!this.#manageWorkspace(user)) return actionFail(403, '没有回滚数据修复的权限');
    const issue = this.#row('SELECT * FROM data_quality_issues WHERE id = ?', [issueId]);
    if (!issue) return actionFail(404, '质量问题不存在');
    const rule = this.#row('SELECT * FROM data_quality_rules WHERE id = ?', [
      text(issue, 'rule_id'),
    ]);
    if (!rule || text(rule, 'workspace_id') !== this.#workspace(user)) {
      return actionFail(404, '质量问题不存在');
    }
    if (text(issue, 'status') !== 'fixed') return actionFail(409, '只有已修复的问题可以回滚');
    const target = this.#issueRecord(issue);
    if (!target?.recordId) return actionFail(409, '该问题无法回滚');
    const original = jsonObject(issue.original_json);
    const changes = this.#qualityChanges(target.dataset, jsonObject(issue.fixed_json));
    const keys = Object.keys(changes);
    if (keys.length === 0) return actionFail(409, '该问题没有可回滚的字段');
    const restore = Object.fromEntries(keys.map((key) => [key, original[key] ?? null]));
    const sets = keys.map((key) => `${key} = ?`);
    const where = target.dataset === 'daily_metrics' ? 'date = ?' : 'id = ?';
    this.#db
      .stmt(`UPDATE ${target.table} SET ${sets.join(', ')} WHERE ${where}`)
      .run(...(Object.values(restore) as (string | number | null)[]), target.recordId);
    const now = this.#now();
    const details = jsonObject(issue.details_json);
    const updated = this.#row(
      `UPDATE data_quality_issues SET status = 'open', resolved_by = NULL, resolved_at = NULL,
         details_json = ?, updated_at = ? WHERE id = ? RETURNING *`,
      [
        JSON.stringify({
          ...details,
          rollback: { reason: input.reason, by: user.id, at: now, restored: restore },
        }),
        now,
        issueId,
      ],
    );
    this.#audit(user, 'quality.revert', issueId, {
      before: issue,
      after: updated,
      reason: input.reason,
      restored: restore,
    });
    return actionOk(updated ?? {});
  }

  evaluateScenario(user: SessionUser, scenarioId: string): ActionResult<Row> {
    const scenario = this.#row('SELECT * FROM forecast_scenarios WHERE id = ?', [scenarioId]);
    if (!scenario || text(scenario, 'workspace_id') !== this.#workspace(user)) {
      return actionFail(404, '预测情景不存在');
    }
    const assumptions = jsonObject(scenario.assumptions_json);
    const baseDate = text(scenario, 'base_date') || today();
    const from = addDays(baseDate, -30);
    const metrics = this.#rows(
      `SELECT date, revenue_cents, visitors, conversions FROM daily_metrics
       WHERE date <= ? AND date >= ? ORDER BY date`,
      [baseDate, from],
    );
    const revenue = metrics.reduce((sum, row) => sum + number(row, 'revenue_cents'), 0);
    const visitors = metrics.reduce((sum, row) => sum + number(row, 'visitors'), 0);
    const conversions = metrics.reduce((sum, row) => sum + number(row, 'conversions'), 0);
    const conversionRate = visitors > 0 ? conversions / visitors : 0;
    const days = Math.max(metrics.length, 1);
    const meanDaily = revenue / days;
    const variance =
      metrics.reduce((sum, row) => sum + (number(row, 'revenue_cents') - meanDaily) ** 2, 0) / days;
    const stdDaily = Math.sqrt(variance);
    const parameters = {
      revenueGrowthPct: Number(assumptions.revenueGrowthPct ?? 0),
      conversionGrowthPct: Number(assumptions.conversionGrowthPct ?? 0),
      costGrowthPct: Number(assumptions.costGrowthPct ?? 0),
      personnelCostPct: Number(assumptions.personnelCostPct ?? 0),
      deliveryShiftDays: Number(assumptions.deliveryShiftDays ?? 0),
    };
    const project = (values: typeof parameters) => {
      const projectedRevenue = Math.round(revenue * (1 + values.revenueGrowthPct / 100));
      const personnelCost = Math.round(revenue * 0.4 * (1 + values.personnelCostPct / 100));
      const otherCost = Math.round(revenue * 0.2 * (1 + values.costGrowthPct / 100));
      const delayCost = Math.round(Math.max(0, values.deliveryShiftDays) * (revenue / days) * 0.1);
      const cost = personnelCost + otherCost + delayCost;
      return {
        revenueCents: projectedRevenue,
        personnelCostCents: personnelCost,
        otherCostCents: otherCost,
        deliveryCostCents: delayCost,
        costCents: cost,
        marginCents: projectedRevenue - cost,
      };
    };
    const baseProjection = project(parameters);
    const interval = Math.round(1.645 * stdDaily * Math.sqrt(days));
    const pctVariable = (
      key: keyof typeof parameters,
      delta: number,
    ): { low: number; high: number } => ({
      low: project({ ...parameters, [key]: parameters[key] - delta }).marginCents,
      high: project({ ...parameters, [key]: parameters[key] + delta }).marginCents,
    });
    const sensitivity = [
      { variable: 'revenueGrowthPct', ...pctVariable('revenueGrowthPct', 10) },
      { variable: 'conversionGrowthPct', ...pctVariable('conversionGrowthPct', 10) },
      { variable: 'costGrowthPct', ...pctVariable('costGrowthPct', 10) },
      { variable: 'personnelCostPct', ...pctVariable('personnelCostPct', 10) },
      {
        variable: 'deliveryShiftDays',
        low: project({ ...parameters, deliveryShiftDays: parameters.deliveryShiftDays - 7 })
          .marginCents,
        high: project({ ...parameters, deliveryShiftDays: parameters.deliveryShiftDays + 7 })
          .marginCents,
      },
    ]
      .map((item) => ({ ...item, impactCents: Math.abs(item.high - item.low) }))
      .sort((a, b) => b.impactCents - a.impactCents);
    const actual = {
      from,
      to: baseDate,
      sampleDays: metrics.length,
      revenueCents: revenue,
      visitors,
      conversions,
      conversionRate: Number(conversionRate.toFixed(4)),
    };
    const forecast = {
      ...baseProjection,
      revenueLowCents: Math.max(0, baseProjection.revenueCents - interval),
      revenueHighCents: baseProjection.revenueCents + interval,
      conversionRate: Number(
        (conversionRate * (1 + parameters.conversionGrowthPct / 100)).toFixed(4),
      ),
      confidenceLevel: 0.9,
      method: 'historical_baseline_with_scenario_adjustments',
    };
    const result = {
      baseDate,
      dataCutoff: baseDate,
      sampleDays: metrics.length,
      actual,
      forecast,
      baseline: {
        revenueCents: revenue,
        conversionRate: Number(conversionRate.toFixed(4)),
      },
      projected: {
        ...forecast,
        costCents: baseProjection.costCents,
        marginCents: baseProjection.marginCents,
      },
      delta: {
        revenueCents: baseProjection.revenueCents - revenue,
        revenuePct: Number(
          (revenue === 0 ? 0 : ((baseProjection.revenueCents - revenue) / revenue) * 100).toFixed(
            2,
          ),
        ),
      },
      assumptions: parameters,
      sensitivity,
      confidenceInterval: {
        level: 0.9,
        revenueLowCents: forecast.revenueLowCents,
        revenueHighCents: forecast.revenueHighCents,
        samples: metrics.length,
        lowSample: metrics.length < 7,
      },
      storage: { actual: 'daily_metrics', forecast: 'scenario.result_json' },
    };
    const updated = this.#row(
      `UPDATE forecast_scenarios SET result_json = ?, updated_at = ? WHERE id = ?
       RETURNING *`,
      [JSON.stringify(result), this.#now(), scenarioId],
    );
    this.#audit(user, 'scenario.evaluate', scenarioId, { result });
    return actionOk({ scenario: updated, result });
  }

  compareScenarios(user: SessionUser, scenarioIds: string[]): ActionResult<Row> {
    const results: Row[] = [];
    for (const id of scenarioIds) {
      const evaluated = this.evaluateScenario(user, id);
      if (!evaluated.ok) return evaluated;
      results.push(evaluated.data);
    }
    const margin = (entry: Row): number => {
      const inner = entry.result;
      if (!inner || typeof inner !== 'object') return 0;
      const projected = (inner as Row).projected;
      if (!projected || typeof projected !== 'object') return 0;
      return Number((projected as Row).marginCents ?? 0);
    };
    const ranked = [...results]
      .sort((a, b) => margin(b) - margin(a))
      .map((entry, index) => ({ rank: index + 1, ...entry }));
    return actionOk({ scenarios: results, ranked });
  }

  funnel(user: SessionUser, input: FunnelQuery): ActionResult<Row> {
    const clauses = ['workspace_id = ?'];
    const params: (string | number)[] = [this.#workspace(user)];
    if (input.from) {
      clauses.push('entered_stage_at >= ?');
      params.push(`${input.from}T00:00:00.000Z`);
    }
    if (input.to) {
      clauses.push('entered_stage_at <= ?');
      params.push(`${input.to}T23:59:59.999Z`);
    }
    if (input.ownerId) {
      clauses.push('owner_id = ?');
      params.push(input.ownerId);
    }
    const stages = ['lead', 'opportunity', 'contract', 'renewal', 'churned'] as const;
    const dedupeBy = input.dedupeBy ?? 'email';
    const countExpr =
      dedupeBy === 'customer' ? 'COUNT(DISTINCT customer_name)' : 'COUNT(DISTINCT customer_email)';
    const counts = new Map(
      this.#rows(
        `SELECT stage, ${countExpr} AS count, COALESCE(SUM(amount_cents), 0) AS amount
         FROM crm_opportunities WHERE ${clauses.join(' AND ')} GROUP BY stage`,
        params,
      ).map((row) => [text(row, 'stage'), row]),
    );
    let previous: number | null = null;
    const steps = stages
      .filter((stage) => stage !== 'churned')
      .map((stage) => {
        const row = counts.get(stage);
        const count = Number(row?.count ?? 0);
        const conversion = previous === null || previous === 0 ? null : count / previous;
        const step = {
          stage,
          count,
          amountCents: Number(row?.amount ?? 0),
          conversionRate: conversion === null ? null : Number(conversion.toFixed(4)),
        };
        previous = count;
        return step;
      });
    const churned = counts.get('churned');
    const durations = this.#rows(
      `SELECT stage, COUNT(*) AS count,
              AVG(julianday(?) - julianday(substr(entered_stage_at, 1, 10))) AS avg_days
       FROM crm_opportunities WHERE ${clauses.join(' AND ')} GROUP BY stage`,
      [today(), ...params],
    ).map((row) => ({
      stage: text(row, 'stage'),
      count: number(row, 'count'),
      averageAgeDays: Math.round(Number(row.avg_days ?? 0) * 10) / 10,
    }));
    const cohortExpr =
      input.cohort === 'week'
        ? "strftime('%Y-%W', entered_stage_at)"
        : 'substr(entered_stage_at, 1, 7)';
    const cohortRows = this.#rows(
      `SELECT ${cohortExpr} AS cohort, stage, ${countExpr} AS count,
              COALESCE(SUM(amount_cents), 0) AS amount
       FROM crm_opportunities WHERE ${clauses.join(' AND ')}
       GROUP BY cohort, stage ORDER BY cohort`,
      params,
    );
    const cohorts = [
      ...new Map(cohortRows.map((row) => [text(row, 'cohort'), row] as const)).keys(),
    ]
      .sort()
      .map((cohort) => {
        const rows = cohortRows.filter((row) => text(row, 'cohort') === cohort);
        const byStage = Object.fromEntries(
          rows.map((row) => [text(row, 'stage'), number(row, 'count')]),
        );
        const lead = Number(byStage.lead ?? 0);
        const contract = Number(byStage.contract ?? 0);
        return {
          cohort,
          total: rows.reduce((sum, row) => sum + number(row, 'count'), 0),
          byStage,
          contractRate: lead > 0 ? Number((contract / lead).toFixed(4)) : null,
          amountCents: rows.reduce((sum, row) => sum + number(row, 'amount'), 0),
        };
      });
    return actionOk({
      steps,
      churned: { count: Number(churned?.count ?? 0), amountCents: Number(churned?.amount ?? 0) },
      durations,
      cohorts,
      cohortBy: input.cohort ?? 'month',
      dedupeBy,
      privacy: '仅输出聚合结果，不包含客户个人信息',
    });
  }

  #queryConfig(
    config: Record<string, unknown>,
    workspaceId: string,
    user: SessionUser,
  ):
    | {
        sql: string;
        params: (string | number)[];
        countSql: string;
        countParams: (string | number)[];
        limit: number;
        dataset: string;
      }
    | { error: string; forbidden?: boolean } {
    const datasets: Record<string, { table: string; fields: string[]; scope: string }> = {
      projects: {
        table: 'projects',
        fields: [
          'id',
          'name',
          'status',
          'progress',
          'owner_id',
          'workspace_id',
          'due_date',
          'start_date',
          'created_at',
          'updated_at',
        ],
        scope: 'workspace_id = ? AND deleted_at IS NULL',
      },
      tasks: {
        table: 'project_tasks',
        fields: [
          'id',
          'project_id',
          'title',
          'status',
          'priority',
          'assignee_id',
          'due_date',
          'completed_at',
          'estimate_points',
          'created_at',
          'updated_at',
        ],
        scope:
          'project_id IN (SELECT id FROM projects WHERE workspace_id = ? AND deleted_at IS NULL)',
      },
      daily_metrics: {
        table: 'daily_metrics',
        fields: ['date', 'revenue_cents', 'customers', 'conversions', 'visitors'],
        scope: '1 = 1',
      },
      opportunities: {
        table: 'crm_opportunities',
        fields: [
          'id',
          'customer_name',
          'customer_email',
          'stage',
          'amount_cents',
          'owner_id',
          'entered_stage_at',
          'created_at',
        ],
        scope: 'workspace_id = ?',
      },
    };
    const datasetName = typeof config.dataset === 'string' ? config.dataset : '';
    const dataset = datasets[datasetName];
    if (!dataset) return { error: '查询配置无效' };
    const fields = Array.isArray(config.fields) ? config.fields.map(String) : [];
    if (fields.length === 0 || fields.some((field) => !dataset.fields.includes(field))) {
      return { error: '查询配置无效' };
    }
    const groupBy = Array.isArray(config.groupBy) ? config.groupBy.map(String) : [];
    if (groupBy.some((field) => !dataset.fields.includes(field))) return { error: '查询配置无效' };
    const aggregates = Array.isArray(config.aggregate)
      ? (config.aggregate as { field?: string; fn?: string; alias?: string }[])
      : [];
    const funcs: Record<string, string> = {
      count: 'COUNT',
      sum: 'SUM',
      avg: 'AVG',
      min: 'MIN',
      max: 'MAX',
    };
    const selects: string[] = [];
    if (aggregates.length === 0) {
      for (const field of fields) selects.push(field);
    } else {
      for (const field of groupBy) selects.push(field);
      for (const aggregate of aggregates) {
        const fn = funcs[String(aggregate.fn ?? '')];
        const field = String(aggregate.field ?? '');
        if (!fn || (field !== '*' && !dataset.fields.includes(field))) {
          return { error: '查询配置无效' };
        }
        const expression =
          fn === 'COUNT' && (field === '*' || field === '') ? 'COUNT(*)' : `${fn}(${field})`;
        selects.push(
          `${expression} AS ${aggregate.alias ?? `${fn.toLowerCase()}_${field || 'all'}`}`,
        );
      }
    }
    if (selects.length === 0) return { error: '查询配置无效' };
    const clauses = [dataset.scope];
    const params: (string | number)[] = datasetName === 'daily_metrics' ? [] : [workspaceId];
    if (datasetName === 'projects' || datasetName === 'tasks') {
      const ids = this.#visibleProjectIds(user);
      const column = datasetName === 'projects' ? 'id' : 'project_id';
      if (ids.length === 0) {
        clauses.push('1 = 0');
      } else {
        clauses.push(`${column} IN (${ids.map(() => '?').join(', ')})`);
        params.push(...ids);
      }
    }
    const filters = Array.isArray(config.filters)
      ? (config.filters as { field?: string; operator?: string; value?: unknown }[])
      : [];
    const operators: Record<string, string> = {
      eq: '=',
      neq: '!=',
      gt: '>',
      gte: '>=',
      lt: '<',
      lte: '<=',
    };
    for (const filter of filters) {
      const field = String(filter.field ?? '');
      const operator = String(filter.operator ?? '');
      if (!dataset.fields.includes(field)) return { error: '查询配置无效' };
      if (operator === 'contains') {
        clauses.push(`${field} LIKE ?`);
        params.push(`%${String(filter.value ?? '')}%`);
      } else if (operator === 'in') {
        const values = Array.isArray(filter.value) ? filter.value.map(String) : [];
        if (values.length === 0) return { error: '查询配置无效' };
        clauses.push(`${field} IN (${values.map(() => '?').join(', ')})`);
        params.push(...values);
      } else if (operators[operator]) {
        clauses.push(`${field} ${operators[operator]} ?`);
        const value = filter.value;
        params.push(typeof value === 'boolean' ? (value ? 1 : 0) : (value as string | number));
      } else {
        return { error: '查询配置无效' };
      }
    }
    const orderCandidate = typeof config.orderBy === 'string' ? config.orderBy : '';
    const sensitive = datasetName === 'opportunities' ? ['customer_email'] : [];
    if (!this.#manageWorkspace(user)) {
      const requested = [
        ...fields,
        ...groupBy,
        ...filters.map((filter) => String(filter.field ?? '')),
        ...aggregates.map((aggregate) => String(aggregate.field ?? '')),
        orderCandidate,
      ];
      if (requested.some((field) => sensitive.includes(field))) {
        return { error: '无权查询敏感字段', forbidden: true };
      }
    }
    const order = [...selects.map((item) => item.split(' AS ').at(-1) ?? item)].includes(
      orderCandidate,
    )
      ? orderCandidate
      : (selects[0]?.split(' AS ').at(-1) ?? dataset.fields[0]);
    const limit = Math.min(Math.max(Number(config.limit ?? 100) || 100, 1), 1000);
    const countSql = `SELECT COUNT(*) AS count FROM ${dataset.table}
      WHERE ${clauses.join(' AND ')}`;
    const countParams = [...params];
    const sql = `SELECT ${selects.join(', ')} FROM ${dataset.table}
      WHERE ${clauses.join(' AND ')}
      ${groupBy.length ? `GROUP BY ${groupBy.join(', ')}` : ''}
      ORDER BY ${order} LIMIT ?`;
    params.push(limit);
    return { sql, params, countSql, countParams, limit, dataset: datasetName };
  }

  previewQuery(user: SessionUser, input: QueryPreview): ActionResult<Row> {
    if (!user.workspaceId && user.role !== 'admin') {
      return actionFail(403, '没有查询权限');
    }
    const rawConfig = input.config as unknown as Record<string, unknown>;
    const built = this.#queryConfig(rawConfig, this.#workspace(user), user);
    if ('error' in built) {
      return built.forbidden ? actionFail(403, built.error) : actionFail(400, built.error);
    }
    const scannedRow = this.#row(built.countSql, built.countParams);
    const scannedRows = number(scannedRow ?? {}, 'count');
    if (scannedRows > 50_000) {
      return actionFail(400, `查询预计扫描 ${scannedRows} 行，超过 50000 行限制`);
    }
    const started = Date.now();
    let rows: Row[];
    try {
      rows = this.#rows(built.sql, built.params);
    } catch {
      return actionFail(400, '查询执行失败');
    }
    if (Date.now() - started > 2_000) {
      return actionFail(400, '查询执行超过 2 秒限制');
    }
    const baseColumns = Object.keys(rows[0] ?? {});
    const calculatedDefs = Array.isArray(rawConfig.calculated)
      ? (rawConfig.calculated as { key?: unknown; label?: unknown; expression?: unknown }[])
      : [];
    const calculated: { key: string; label: string }[] = [];
    for (const definition of calculatedDefs) {
      const key = String(definition.key ?? '');
      const label = String(definition.label ?? key);
      const expression = String(definition.expression ?? '');
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || expression.length === 0) {
        return actionFail(400, '计算字段标识或表达式无效');
      }
      if (baseColumns.includes(key) || calculated.some((item) => item.key === key)) {
        return actionFail(400, `计算字段标识重复：${key}`);
      }
      for (const row of rows) {
        const value = evaluateArithmetic(expression, row);
        row[key] = value;
      }
      calculated.push({ key, label });
    }
    const columns = Object.keys(rows[0] ?? {});
    let pivot: Row | null = null;
    const pivotConfig = rawConfig.pivot as
      | { rows?: unknown; columns?: unknown; values?: unknown }
      | undefined;
    if (pivotConfig) {
      const rowFields = Array.isArray(pivotConfig.rows)
        ? pivotConfig.rows.map(String).filter((field) => columns.includes(field))
        : [];
      const columnField = String(pivotConfig.columns ?? '');
      const valueField = String(pivotConfig.values ?? '');
      if (rowFields.length === 0 || !columns.includes(columnField)) {
        return actionFail(400, '透视表字段无效');
      }
      const rowKeys = [
        ...new Set(
          rows.map((row) => rowFields.map((field) => String(row[field] ?? '')).join(' / ')),
        ),
      ];
      const columnKeys = [...new Set(rows.map((row) => String(row[columnField] ?? '')))].sort();
      const buckets = new Map<string, Map<string, number>>();
      for (const row of rows) {
        const rowKey = rowFields.map((field) => String(row[field] ?? '')).join(' / ');
        const columnKey = String(row[columnField] ?? '');
        const value = valueField ? Number(row[valueField] ?? 0) : 1;
        if (!Number.isFinite(value)) continue;
        const bucket = buckets.get(rowKey) ?? new Map<string, number>();
        bucket.set(columnKey, (bucket.get(columnKey) ?? 0) + value);
        buckets.set(rowKey, bucket);
      }
      pivot = {
        rowFields,
        columnField,
        valueField: valueField || null,
        rowKeys,
        columnKeys,
        matrix: rowKeys.map((key) => {
          const bucket = buckets.get(key) ?? new Map<string, number>();
          return {
            key,
            values: Object.fromEntries(
              columnKeys.map((column) => [column, bucket.get(column) ?? 0]),
            ),
            total: [...bucket.values()].reduce((sum, value) => sum + value, 0),
          };
        }),
      };
    }
    let chart: Row | null = null;
    const chartConfig = rawConfig.chart as { type?: unknown; x?: unknown; y?: unknown } | undefined;
    if (chartConfig && String(chartConfig.type ?? 'table') !== 'table') {
      const x = String(chartConfig.x ?? '');
      const y = String(chartConfig.y ?? '');
      if (!columns.includes(x)) return actionFail(400, '图表 X 轴字段无效');
      if (y && !columns.includes(y)) return actionFail(400, '图表 Y 轴字段无效');
      chart = {
        type: String(chartConfig.type),
        x,
        y: y || null,
        points: rows
          .map((row) => ({
            x: row[x],
            y: y ? Number(row[y] ?? 0) : 1,
          }))
          .filter((point) => Number.isFinite(point.y)),
      };
    }
    return actionOk({
      dataset: built.dataset,
      columns,
      rows,
      rowCount: rows.length,
      scannedRows,
      truncated: scannedRows > rows.length,
      limit: built.limit,
      calculated,
      pivot,
      chart,
    });
  }

  runQueryReport(user: SessionUser, reportId: string): ActionResult<Row> {
    const report = this.#row('SELECT * FROM query_reports WHERE id = ?', [reportId]);
    if (!report || text(report, 'workspace_id') !== this.#workspace(user)) {
      return actionFail(404, '查询报表不存在');
    }
    if (
      text(report, 'user_id') !== user.id &&
      number(report, 'shared') !== 1 &&
      !this.#manageWorkspace(user)
    ) {
      return actionFail(403, '没有查看该报表的权限');
    }
    const preview = this.previewQuery(user, {
      config: jsonObject(report.config_json) as never,
    });
    if (!preview.ok) return preview;
    this.#db
      .stmt('UPDATE query_reports SET updated_at = ? WHERE id = ?')
      .run(this.#now(), reportId);
    return actionOk({ reportId, ...(preview.data as Row) });
  }

  #reportNextRun(cadence: string, from = Date.now()): string {
    const days = cadence === 'weekly' ? 7 : cadence === 'monthly' ? 30 : 1;
    return new Date(from + days * 86_400_000).toISOString();
  }

  #reportPeriod(cadence: string, timezone: string, date = new Date()): string {
    let day = date.toISOString().slice(0, 10);
    try {
      day = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(date);
    } catch {
      day = date.toISOString().slice(0, 10);
    }
    if (cadence === 'monthly') return day.slice(0, 7);
    if (cadence !== 'weekly') return day;
    const parsed = new Date(`${day}T00:00:00Z`);
    const weekday = (parsed.getUTCDay() + 6) % 7;
    parsed.setUTCDate(parsed.getUTCDate() - weekday + 3);
    const year = parsed.getUTCFullYear();
    const yearStart = new Date(Date.UTC(year, 0, 4));
    const week = 1 + Math.round((parsed.getTime() - yearStart.getTime()) / 604_800_000);
    return `${year}-W${String(week).padStart(2, '0')}`;
  }

  createReportSubscription(user: SessionUser, input: ReportSubscriptionCreate): ActionResult<Row> {
    const reportKind = input.reportKind ?? 'saved';
    const report =
      reportKind === 'query'
        ? this.#row('SELECT * FROM query_reports WHERE id = ?', [input.reportId])
        : this.#row('SELECT * FROM saved_reports WHERE id = ?', [input.reportId]);
    if (!report) return actionFail(404, '报表不存在');
    const now = this.#now();
    const cadence = input.cadence ?? 'daily';
    const id = randomUUID();
    this.#db
      .stmt(
        `INSERT INTO report_subscriptions
           (id, workspace_id, report_id, report_kind, recipients_json, timezone, cadence, format,
            channel, failure_notify, next_run_at, active, version, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        id,
        this.#workspace(user),
        input.reportId,
        reportKind,
        JSON.stringify(input.recipients),
        input.timezone ?? 'Asia/Shanghai',
        cadence,
        input.format ?? 'csv',
        input.channel ?? 'email',
        input.failureNotify === false ? 0 : 1,
        input.nextRunAt ?? this.#reportNextRun(cadence),
        input.active === false ? 0 : 1,
        user.id,
        now,
        now,
      );
    this.#audit(user, 'report.subscription.create', id, {
      reportId: input.reportId,
      recipients: input.recipients.length,
      cadence,
    });
    return actionOk(this.#row('SELECT * FROM report_subscriptions WHERE id = ?', [id]) ?? {});
  }

  runReportSubscriptions(user: SessionUser): ActionResult<Row> {
    if (!this.#manageWorkspace(user)) return actionFail(403, '没有运行报表订阅的权限');
    const now = this.#now();
    const due = this.#rows(
      `SELECT * FROM report_subscriptions
       WHERE workspace_id = ? AND active = 1
         AND (next_run_at IS NULL OR next_run_at <= ?)
       ORDER BY next_run_at ASC LIMIT 50`,
      [this.#workspace(user), now],
    );
    const deliveries: Row[] = [];
    let failed = 0;
    for (const subscription of due) {
      const cadence = text(subscription, 'cadence') || 'daily';
      const timezone = text(subscription, 'timezone') || 'Asia/Shanghai';
      const period = this.#reportPeriod(cadence, timezone);
      const subscriptionId = text(subscription, 'id');
      try {
        const token = `rpt_${randomUUID().replaceAll('-', '')}`;
        const deliveryId = randomUUID();
        this.#db
          .stmt(
            `INSERT INTO report_deliveries
               (id, subscription_id, period_key, status, attempts, download_token,
                link_expires_at, delivered_at, created_at)
             VALUES (?, ?, ?, 'sent', 1, ?, ?, ?, ?)
             ON CONFLICT (subscription_id, period_key) DO UPDATE SET
               status = 'sent', attempts = report_deliveries.attempts + 1,
               error = NULL, delivered_at = excluded.delivered_at`,
          )
          .run(
            deliveryId,
            subscriptionId,
            period,
            token,
            new Date(Date.now() + 7 * 86_400_000).toISOString(),
            now,
            now,
          );
        const delivery = this.#row(
          'SELECT * FROM report_deliveries WHERE subscription_id = ? AND period_key = ?',
          [subscriptionId, period],
        );
        if (delivery) deliveries.push(delivery);
        const link = `/reports?delivery=${text(delivery ?? {}, 'id')}&token=${
          text(delivery ?? {}, 'download_token') || token
        }`;
        const name =
          (text(subscription, 'report_kind') === 'query'
            ? text(
                this.#row('SELECT * FROM query_reports WHERE id = ?', [
                  text(subscription, 'report_id'),
                ]) ?? {},
                'name',
              )
            : text(
                this.#row('SELECT * FROM saved_reports WHERE id = ?', [
                  text(subscription, 'report_id'),
                ]) ?? {},
                'name',
              )) || '定期报表';
        for (const recipient of jsonArray(subscription.recipients_json)) {
          const member = this.#row(
            `SELECT id FROM users WHERE lower(email) = lower(?) AND workspace_id = ?
               AND status = 'active'`,
            [String(recipient), text(subscription, 'workspace_id')],
          );
          if (!member) continue;
          this.#store.domain.notify(
            text(member, 'id'),
            'report_ready',
            `报表已生成：${name}`,
            `周期 ${period}，点击下载`,
            link,
          );
        }
        this.#db
          .stmt(
            `UPDATE report_subscriptions SET last_run_at = ?, next_run_at = ?,
               failure_count = 0, last_error = NULL, updated_at = ? WHERE id = ?`,
          )
          .run(now, this.#reportNextRun(cadence), now, subscriptionId);
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : '报表投递失败';
        this.#db
          .stmt(
            `UPDATE report_subscriptions SET failure_count = failure_count + 1,
               last_error = ?, next_run_at = ?, updated_at = ? WHERE id = ?`,
          )
          .run(
            message.slice(0, 200),
            new Date(Date.now() + 1_800_000).toISOString(),
            now,
            subscriptionId,
          );
        if (number(subscription, 'failure_notify') === 1) {
          const owner = text(subscription, 'created_by');
          if (owner) {
            this.#store.domain.notify(
              owner,
              'report_failed',
              '报表投递失败',
              message.slice(0, 200),
              '/reports',
            );
          }
        }
      }
    }
    return actionOk({ processed: due.length, failed, deliveries });
  }

  addLineage(user: SessionUser, metricId: string, input: LineageCreate): ActionResult<Row> {
    const metric = this.#row('SELECT * FROM metric_definitions WHERE id = ?', [metricId]);
    if (!metric || text(metric, 'workspace_id') !== this.#workspace(user)) {
      return actionFail(404, '指标不存在');
    }
    if (!this.#manageWorkspace(user)) return actionFail(403, '没有维护指标血缘的权限');
    if (input.sourceType === 'metric') {
      if (input.sourceId === metricId) return actionFail(400, '指标不能以自身为血缘来源');
      const source = this.#row('SELECT * FROM metric_definitions WHERE id = ?', [input.sourceId]);
      if (!source || text(source, 'workspace_id') !== this.#workspace(user)) {
        return actionFail(404, '来源指标不存在');
      }
      const seen = new Set<string>();
      const queue = [metricId];
      while (queue.length > 0) {
        const current = queue.shift() as string;
        if (current === input.sourceId) return actionFail(400, '血缘关系存在循环依赖');
        if (seen.has(current)) continue;
        seen.add(current);
        const dependents = this.#rows(
          `SELECT DISTINCT metric_id FROM metric_lineage
           WHERE source_type = 'metric' AND source_id = ?`,
          [current],
        );
        for (const dependent of dependents) queue.push(text(dependent, 'metric_id'));
      }
    }
    const existing = this.#row(
      `SELECT * FROM metric_lineage
       WHERE metric_id = ? AND source_type = ? AND source_id = ? AND relation = ?`,
      [metricId, input.sourceType, input.sourceId, input.relation ?? 'derives'],
    );
    if (existing) return actionOk({ ...existing, duplicate: true });
    const id = randomUUID();
    this.#db
      .stmt(
        `INSERT INTO metric_lineage
           (id, metric_id, source_type, source_id, relation, sensitive, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        metricId,
        input.sourceType,
        input.sourceId,
        input.relation ?? 'derives',
        input.sensitive ? 1 : 0,
        this.#now(),
      );
    this.#audit(user, 'metric.lineage.create', metricId, {
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sensitive: input.sensitive === true,
    });
    return actionOk(this.#row('SELECT * FROM metric_lineage WHERE id = ?', [id]) ?? {});
  }

  lineageImpact(user: SessionUser, metricId: string): ActionResult<Row> {
    const metric = this.#row('SELECT * FROM metric_definitions WHERE id = ?', [metricId]);
    if (!metric || text(metric, 'workspace_id') !== this.#workspace(user)) {
      return actionFail(404, '指标不存在');
    }
    const canSeeSensitive = this.#manageWorkspace(user);
    const allUpstream = this.#rows(
      `SELECT source_type, source_id, relation, sensitive
       FROM metric_lineage WHERE metric_id = ? ORDER BY created_at`,
      [metricId],
    );
    const upstream = canSeeSensitive
      ? allUpstream
      : allUpstream.filter((row) => number(row, 'sensitive') !== 1);
    const trimmed = upstream.length !== allUpstream.length;

    const catalog: Record<string, string[]> = {
      tables: [],
      imports: [],
      formulas: [],
      filters: [],
      fx: [],
      metrics: [],
      manual: [],
    };
    for (const row of upstream) {
      const type = text(row, 'source_type');
      const bucket = type === 'table' ? 'tables' : type === 'metric' ? 'metrics' : `${type}s`;
      const entries = catalog[bucket] ?? [];
      entries.push(text(row, 'source_id'));
      catalog[bucket] = entries;
    }

    type Status = { complete: boolean; missing: string[]; incompleteSources: string[] };
    const cache = new Map<string, Status>();
    const statusOf = (id: string, stack = new Set<string>()): Status => {
      const cached = cache.get(id);
      if (cached) return cached;
      if (stack.has(id)) return { complete: false, missing: ['cycle'], incompleteSources: [] };
      const next = new Set(stack).add(id);
      const rows = this.#rows(
        'SELECT source_type, source_id FROM metric_lineage WHERE metric_id = ?',
        [id],
      );
      const metricSources = rows.filter((row) => text(row, 'source_type') === 'metric');
      const missing: string[] = [];
      const incompleteSources: string[] = [];
      if (rows.length === 0) {
        missing.push('all');
      } else if (
        !rows.some((row) => text(row, 'source_type') === 'table') &&
        metricSources.length === 0
      ) {
        missing.push('table');
      }
      for (const source of metricSources) {
        const child = statusOf(text(source, 'source_id'), next);
        if (!child.complete) {
          incompleteSources.push(text(source, 'source_id'));
          if (!missing.includes('upstream')) missing.push('upstream');
        }
      }
      const status = {
        complete: missing.length === 0,
        missing,
        incompleteSources: [...new Set(incompleteSources)],
      };
      cache.set(id, status);
      return status;
    };

    const downstream: Row[] = [];
    const seen = new Set<string>([metricId]);
    let frontier = [metricId];
    for (let depth = 0; depth < 5 && frontier.length > 0; depth += 1) {
      const placeholders = frontier.map(() => '?').join(', ');
      const rows = this.#rows(
        `SELECT DISTINCT m.id, m.name, m.unit, l.source_id AS via
         FROM metric_lineage l JOIN metric_definitions m ON m.id = l.metric_id
         WHERE l.source_type = 'metric' AND l.source_id IN (${placeholders})`,
        frontier,
      );
      frontier = [];
      for (const row of rows) {
        const id = text(row, 'id');
        if (seen.has(id)) continue;
        seen.add(id);
        downstream.push({ ...row, depth: depth + 1, lineage: statusOf(id) });
        frontier.push(id);
      }
    }

    const reportRows = this.#rows(
      'SELECT id, name, config_json FROM query_reports WHERE workspace_id = ?',
      [this.#workspace(user)],
    );
    const charts: Row[] = [];
    const reports: Row[] = [];
    for (const report of reportRows) {
      const config = jsonObject(report.config_json);
      if (config.metricId !== metricId) continue;
      const item = {
        id: report.id,
        name: report.name,
        visualization: config.visualization ?? 'table',
      };
      if (config.visualization && config.visualization !== 'table') charts.push(item);
      else reports.push(item);
    }
    const reportIds = [...charts, ...reports].map((item) => String(item.id));
    const subscriptions: Row[] = [];
    const subs = this.#rows(
      'SELECT id, report_id, report_kind, recipients_json FROM report_subscriptions WHERE workspace_id = ?',
      [this.#workspace(user)],
    );
    for (const subscription of subs) {
      const kind = text(subscription, 'report_kind');
      const reportId = text(subscription, 'report_id');
      if (
        (kind === 'metric' && reportId === metricId) ||
        (kind === 'query' && reportIds.includes(reportId))
      ) {
        subscriptions.push({ id: subscription.id, reportId, reportKind: kind });
      }
    }
    const like = `%${metricId}%`;
    const automationRules = this.#rows(
      `SELECT id, name FROM automation_rules
       WHERE workspace_id = ?
         AND (trigger_event LIKE ? OR conditions_json LIKE ? OR actions_json LIKE ?)`,
      [this.#workspace(user), like, like, like],
    ).map((row) => ({ id: row.id, name: row.name }));
    return actionOk({
      metric: { id: metric.id, name: metric.name },
      lineage: statusOf(metricId),
      upstream,
      catalog,
      trimmed,
      downstream,
      affected: { charts, reports, automationRules, subscriptions },
    });
  }

  createBudgetCategory(
    user: SessionUser,
    budgetId: string,
    input: BudgetCategoryCreate,
  ): ActionResult<Row> {
    const budget = this.#row('SELECT * FROM project_budgets WHERE id = ?', [budgetId]);
    if (!budget) return actionFail(404, '预算不存在');
    const project = this.#project(text(budget, 'project_id'), user);
    if (!project) return actionFail(404, '预算不存在');
    if (!this.#manage(project, user)) return actionFail(403, '没有管理预算的权限');
    try {
      const id = randomUUID();
      this.#db
        .stmt(
          `INSERT INTO budget_categories
             (id, budget_id, name, planned_cents, actual_cents, forecast_cents,
              version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          id,
          budgetId,
          input.name,
          input.plannedCents ?? 0,
          input.actualCents ?? 0,
          input.forecastCents ?? 0,
          this.#now(),
          this.#now(),
        );
      this.#audit(user, 'budget.category.create', id, { budgetId, name: input.name });
      return actionOk(this.#row('SELECT * FROM budget_categories WHERE id = ?', [id]) ?? {});
    } catch {
      return actionFail(409, '费用类别已存在');
    }
  }

  updateBudgetCategory(
    user: SessionUser,
    categoryId: string,
    input: BudgetCategoryUpdate,
  ): ActionResult<Row> {
    const category = this.#row('SELECT * FROM budget_categories WHERE id = ?', [categoryId]);
    if (!category) return actionFail(404, '费用类别不存在');
    const budget = this.#row('SELECT * FROM project_budgets WHERE id = ?', [
      text(category, 'budget_id'),
    ]);
    const project = budget ? this.#project(text(budget, 'project_id'), user) : null;
    if (!budget || !project) return actionFail(404, '费用类别不存在');
    if (!this.#manage(project, user)) return actionFail(403, '没有管理预算的权限');
    if (number(category, 'version') !== input.version) {
      return actionFail(409, '费用类别已被其他会话修改', category);
    }
    const updated = this.#row(
      `UPDATE budget_categories SET name = ?, planned_cents = ?, actual_cents = ?,
         forecast_cents = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? RETURNING *`,
      [
        input.name ?? text(category, 'name'),
        input.plannedCents ?? number(category, 'planned_cents'),
        input.actualCents ?? number(category, 'actual_cents'),
        input.forecastCents ?? number(category, 'forecast_cents'),
        this.#now(),
        categoryId,
        input.version,
      ],
    );
    if (!updated) return actionFail(409, '费用类别已被其他会话修改');
    this.#audit(user, 'budget.category.update', categoryId, {
      before: category,
      after: updated,
    });
    return actionOk(updated);
  }

  requestBudgetApproval(
    user: SessionUser,
    projectId: string,
    input: BudgetApproval,
  ): ActionResult<Row> {
    const project = this.#project(projectId, user);
    if (!project) return actionFail(404, '项目不存在');
    if (!this.#manage(project, user)) return actionFail(403, '没有管理预算的权限');
    const budget = this.#row('SELECT * FROM project_budgets WHERE project_id = ?', [projectId]);
    if (!budget) return actionFail(404, '预算不存在');
    const existingId = text(budget, 'approval_request_id');
    if (existingId) {
      const current = this.#row('SELECT * FROM approval_requests WHERE id = ?', [existingId]);
      if (current && text(current, 'status') === 'pending') {
        return actionFail(409, '预算审批已在进行中', current);
      }
    }
    const amount = input.amountCents ?? number(budget, 'budget_cents');
    const approver =
      this.#row(
        `SELECT id FROM users WHERE workspace_id = ? AND status = 'active'
           AND role IN ('admin', 'manager') AND id <> ?
         ORDER BY role = 'admin' DESC, created_at ASC LIMIT 1`,
        [this.#workspace(user), user.id],
      ) ??
      this.#row(
        `SELECT id FROM users WHERE workspace_id = ? AND status = 'active'
           AND role IN ('admin', 'manager') ORDER BY role = 'admin' DESC, created_at ASC LIMIT 1`,
        [this.#workspace(user)],
      );
    if (!approver) return actionFail(400, '没有可用的预算审批人');
    const usage =
      (number(budget, 'actual_cents') / Math.max(number(budget, 'budget_cents'), 1)) * 100;
    const risk =
      usage >= 100 ? 'high' : usage >= number(budget, 'threshold_pct') ? 'medium' : 'low';
    const created = this.createApproval(user, {
      title: `预算调整审批：${project.name}`,
      kind: 'budget',
      projectId,
      amountCents: amount,
      risk,
      resourceType: 'project_budget',
      resourceId: text(budget, 'id'),
      steps: [
        {
          name: '预算审批',
          approverIds: [text(approver, 'id')],
          mode: 'any',
          slaHours: 48,
        },
      ],
    });
    if (!created.ok) return created;
    const approval = created.data;
    this.#db
      .stmt('UPDATE project_budgets SET approval_request_id = ?, updated_at = ? WHERE id = ?')
      .run(text(approval, 'id'), this.#now(), text(budget, 'id'));
    this.#audit(user, 'budget.approval.request', projectId, {
      approvalId: text(approval, 'id'),
      amountCents: amount,
      note: input.note ?? '',
    });
    const updated = this.#row('SELECT * FROM project_budgets WHERE id = ?', [text(budget, 'id')]);
    return actionOk({ approval, budget: updated ?? budget });
  }

  budgetAlerts(user: SessionUser, projectId: string): ActionResult<Row> {
    const project = this.#project(projectId, user);
    if (!project) return actionFail(404, '项目不存在');
    const budget = this.#row('SELECT * FROM project_budgets WHERE project_id = ?', [projectId]);
    if (!budget) return actionOk({ alerts: [], budget: null });
    const categories = this.#rows('SELECT * FROM budget_categories WHERE budget_id = ?', [
      text(budget, 'id'),
    ]);
    const threshold = number(budget, 'threshold_pct') || 80;
    const usage =
      (number(budget, 'actual_cents') / Math.max(number(budget, 'budget_cents'), 1)) * 100;
    const alerts: Row[] = [];
    if (usage >= threshold) {
      alerts.push({
        level: usage >= 100 ? 'critical' : 'warn',
        scope: 'budget',
        name: text(budget, 'cost_center') || '项目预算',
        usagePct: Number(usage.toFixed(2)),
        thresholdPct: threshold,
        overCents: Math.max(0, number(budget, 'actual_cents') - number(budget, 'budget_cents')),
      });
    }
    for (const category of categories) {
      const planned = Math.max(number(category, 'planned_cents'), 1);
      const used = (number(category, 'actual_cents') / planned) * 100;
      if (used >= 100) {
        alerts.push({
          level: 'critical',
          scope: 'category',
          id: category.id,
          name: category.name,
          usagePct: Number(used.toFixed(2)),
          overCents: Math.max(0, number(category, 'actual_cents') - planned),
        });
      }
    }
    if (alerts.length > 0 && this.#manage(project, user)) {
      this.#notify(project.ownerId, 'budget_alert', '项目预算预警', `${alerts.length} 项预算超限`);
    }
    const approvalId = text(budget, 'approval_request_id');
    const approval = approvalId
      ? this.#row(
          `SELECT id, status, kind, amount_cents, current_step, due_at, created_at
           FROM approval_requests WHERE id = ?`,
          [approvalId],
        )
      : null;
    return actionOk({
      budget: {
        id: budget.id,
        currency: budget.currency,
        budgetCents: number(budget, 'budget_cents'),
        actualCents: number(budget, 'actual_cents'),
        forecastCents: number(budget, 'forecast_cents'),
        usagePct: Number(usage.toFixed(2)),
        thresholdPct: threshold,
      },
      approval,
      categories,
      alerts,
    });
  }

  // -------------------------------------------------------------------------
  // Enterprise governance
  // -------------------------------------------------------------------------

  createOrganization(user: SessionUser, input: OrganizationCreate): ActionResult<Row> {
    if (user.role !== 'admin') return actionFail(403, '只有管理员可以创建组织');
    const now = this.#now();
    const id = randomUUID();
    try {
      this.#db
        .stmt(
          'INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(id, input.name, input.slug, now, now);
    } catch {
      return actionFail(409, '组织标识已存在');
    }
    this.#audit(user, 'organization.create', id, input);
    return actionOk(this.#row('SELECT * FROM organizations WHERE id = ?', [id]) ?? {});
  }

  createDepartment(user: SessionUser, orgId: string, input: DepartmentCreate): ActionResult<Row> {
    if (user.role !== 'admin') return actionFail(403, '只有管理员可以创建部门');
    const organization = this.#row('SELECT * FROM organizations WHERE id = ?', [orgId]);
    if (!organization) return actionFail(404, '组织不存在');
    if (input.parentId) {
      const parent = this.#row('SELECT * FROM departments WHERE id = ? AND org_id = ?', [
        input.parentId,
        orgId,
      ]);
      if (!parent) return actionFail(400, '上级部门不属于该组织');
    }
    const id = randomUUID();
    const now = this.#now();
    this.#db
      .stmt(
        `INSERT INTO departments
           (id, org_id, parent_id, name, manager_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, orgId, input.parentId ?? null, input.name, input.managerId ?? null, now, now);
    this.#audit(user, 'department.create', id, { orgId, name: input.name });
    return actionOk(this.#row('SELECT * FROM departments WHERE id = ?', [id]) ?? {});
  }

  addOrgMembership(
    user: SessionUser,
    orgId: string,
    input: OrgMembershipCreate,
  ): ActionResult<Row> {
    if (user.role !== 'admin') return actionFail(403, '只有管理员可以管理组织成员');
    if (!this.#row('SELECT 1 AS hit FROM organizations WHERE id = ?', [orgId])) {
      return actionFail(404, '组织不存在');
    }
    if (!this.#row('SELECT 1 AS hit FROM users WHERE id = ?', [input.userId])) {
      return actionFail(404, '用户不存在');
    }
    if (input.departmentId) {
      const department = this.#row('SELECT * FROM departments WHERE id = ? AND org_id = ?', [
        input.departmentId,
        orgId,
      ]);
      if (!department) return actionFail(400, '部门不属于该组织');
    }
    this.#db
      .stmt(
        `INSERT INTO org_memberships
           (org_id, user_id, department_id, title, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (org_id, user_id) DO UPDATE SET
           department_id = excluded.department_id,
           title = excluded.title,
           status = excluded.status`,
      )
      .run(
        orgId,
        input.userId,
        input.departmentId ?? null,
        input.title ?? '',
        input.status ?? 'active',
        this.#now(),
      );
    this.#audit(user, 'org.membership.upsert', `${orgId}:${input.userId}`, input);
    return actionOk(
      this.#row('SELECT * FROM org_memberships WHERE org_id = ? AND user_id = ?', [
        orgId,
        input.userId,
      ]) ?? {},
    );
  }

  createWorkspaceMember(user: SessionUser, input: WorkspaceMemberCreate): ActionResult<Row> {
    if (!this.#manageWorkspace(user)) return actionFail(403, '没有管理工作区成员的权限');
    if (!this.#row('SELECT 1 AS hit FROM users WHERE id = ?', [input.userId])) {
      return actionFail(404, '用户不存在');
    }
    this.#db
      .stmt(
        `INSERT INTO workspace_memberships
           (workspace_id, user_id, role, status, joined_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET
           role = excluded.role, status = excluded.status`,
      )
      .run(this.#workspace(user), input.userId, input.role, input.status ?? 'active', this.#now());
    this.#audit(user, 'workspace.member.upsert', input.userId, {
      role: input.role,
      status: input.status ?? 'active',
    });
    return actionOk(
      this.#row('SELECT * FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?', [
        this.#workspace(user),
        input.userId,
      ]) ?? {},
    );
  }

  switchWorkspace(user: SessionUser, input: WorkspaceSwitch): ActionResult<Row> {
    const workspace = this.#row('SELECT * FROM workspaces WHERE id = ?', [input.workspaceId]);
    if (!workspace) return actionFail(404, '工作区不存在');
    if (input.workspaceId !== this.#workspace(user)) {
      const membership = this.#row(
        `SELECT * FROM workspace_memberships
         WHERE workspace_id = ? AND user_id = ? AND status = 'active'`,
        [input.workspaceId, user.id],
      );
      if (!membership && user.role !== 'admin') {
        return actionFail(403, '你不是该工作区成员');
      }
    }
    this.#db
      .stmt('UPDATE users SET workspace_id = ?, updated_at = ? WHERE id = ?')
      .run(input.workspaceId, this.#now(), user.id);
    this.#audit(user, 'workspace.switch', input.workspaceId, {
      from: this.#workspace(user),
    });
    return actionOk({ workspace });
  }

  runPermissionSamples(user: SessionUser, input: PermissionSampleRun): ActionResult<Row> {
    if (!this.#manageWorkspace(user)) return actionFail(403, '没有运行权限回归的权限');
    const samples = input.ids?.length
      ? this.#rows(
          `SELECT * FROM permission_samples
           WHERE workspace_id = ? AND id IN (${input.ids.map(() => '?').join(', ')})`,
          [this.#workspace(user), ...input.ids],
        )
      : this.#rows('SELECT * FROM permission_samples WHERE workspace_id = ?', [
          this.#workspace(user),
        ]);
    const results: Row[] = [];
    for (const sample of samples) {
      const userId = text(sample, 'user_id');
      const targetUser = this.#store.users.findById(userId);
      if (!targetUser) {
        results.push({ id: sample.id, status: 'error', message: '用户不存在' });
        continue;
      }
      const role = targetUser.role;
      const permissions = this.#store.governance.activePermissions(userId, this.#workspace(user));
      const resourceType = text(sample, 'resource_type');
      const resourceId = text(sample, 'resource_id');
      const action = text(sample, 'action');
      let allow = false;
      if (resourceType === 'workspace') {
        allow = action === 'view' || canManageWorkspace(role, permissions);
      } else if (resourceType === 'project') {
        const project = this.#store.projects.get(resourceId, role, userId);
        allow =
          Boolean(project) &&
          (action === 'view' || canManageProject(role, project?.ownerId === userId, permissions));
      } else if (resourceType === 'task') {
        const project = this.#store.domain.projectOfTask(resourceId, {
          ...targetUser,
          permissions,
        } as SessionUser);
        allow =
          Boolean(project) &&
          (action === 'view' ||
            canManageProject(role, project?.projectOwnerId === userId, permissions));
      }
      const expected = number(sample, 'expected_allow') === 1;
      const pass = allow === expected;
      const result = { allow, expected, pass, action, checkedAt: this.#now() };
      this.#db
        .stmt('UPDATE permission_samples SET last_result_json = ? WHERE id = ?')
        .run(JSON.stringify(result), text(sample, 'id'));
      results.push({ id: sample.id, name: sample.name, ...result });
    }
    const failed = results.filter((item) => item.pass === false).length;
    this.#audit(user, 'permission.samples.run', this.#workspace(user), {
      total: results.length,
      failed,
    });
    return actionOk({ total: results.length, passed: results.length - failed, failed, results });
  }

  consumeJitGrant(
    user: SessionUser,
    grantId: string | undefined,
    input: JitUsage,
  ): ActionResult<Row> {
    const now = this.#now();
    const grant = grantId
      ? this.#row('SELECT * FROM jit_grants WHERE id = ? AND user_id = ?', [grantId, user.id])
      : this.#row(
          `SELECT * FROM jit_grants
           WHERE user_id = ? AND workspace_id = ? AND status = 'active'
             AND starts_at <= ? AND expires_at >= ?
           ORDER BY expires_at ASC LIMIT 1`,
          [user.id, this.#workspace(user), now, now],
        );
    if (!grant) return actionFail(404, '没有可用的临时授权');
    if (text(grant, 'status') !== 'active') return actionFail(409, '临时授权尚未生效或已失效');
    if (text(grant, 'starts_at') > now || text(grant, 'expires_at') < now) {
      return actionFail(409, '临时授权不在有效期内');
    }
    this.#db
      .stmt(
        `UPDATE jit_grants SET used_at = COALESCE(used_at, ?), used_count = used_count + 1,
           updated_at = ? WHERE id = ?`,
      )
      .run(now, now, text(grant, 'id'));
    this.#audit(user, 'jit.use', text(grant, 'id'), { note: input.note ?? '' });
    return actionOk(this.#row('SELECT * FROM jit_grants WHERE id = ?', [text(grant, 'id')]) ?? {});
  }

  postReviewJitGrant(user: SessionUser, grantId: string, input: JitPostReview): ActionResult<Row> {
    if (!this.#manageWorkspace(user)) return actionFail(403, '没有事后复核的权限');
    const grant = this.#row('SELECT * FROM jit_grants WHERE id = ?', [grantId]);
    if (!grant || text(grant, 'workspace_id') !== this.#workspace(user)) {
      return actionFail(404, '临时授权不存在');
    }
    const now = this.#now();
    const updated = this.#row(
      `UPDATE jit_grants SET post_reviewed_by = ?, post_reviewed_at = ?,
         status = CASE WHEN ? = 0 THEN 'revoked' ELSE status END, updated_at = ?
       WHERE id = ? RETURNING *`,
      [user.id, now, input.approved ? 1 : 0, now, grantId],
    );
    this.#audit(user, 'jit.post_review', grantId, {
      approved: input.approved,
      note: input.note ?? '',
    });
    if (!input.approved) {
      this.#notify(text(grant, 'user_id'), 'jit', '临时授权事后复核未通过', input.note ?? '');
    }
    return actionOk(updated ?? {});
  }
}
