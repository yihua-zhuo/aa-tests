import { randomUUID } from 'node:crypto';
import {
  canManageProject,
  canManageWorkspace,
  canViewAllProjects,
} from '../../shared/permissions.ts';
import type { DomainRecord, SessionUser } from '../../shared/types.ts';
import type { Store } from '../store.ts';
import { DomainTable } from '../stores/domain.ts';
import { recurrenceOccurrences } from '../stores/planning.ts';
import { connectorCapabilities, connectorView, encryptConnectorSecret } from './connectors.ts';
import type { ResourceDef } from './registry.ts';

export type WorkbenchQuery = {
  workspaceId?: string;
  projectId?: string;
  taskId?: string;
  documentId?: string;
  meetingId?: string;
  channelId?: string;
  portalId?: string;
  workflowId?: string;
  runId?: string;
  gateId?: string;
  closureId?: string;
  deliverableId?: string;
  blockerId?: string;
  requestId?: string;
  subscriptionId?: string;
  budgetId?: string;
  metricId?: string;
  ruleId?: string;
  orgId?: string;
  eventId?: string;
  status?: string;
  q?: string;
  limit: number;
  offset: number;
};

export type ServiceResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409 | 500;
      message: string;
      current?: unknown;
    };

type ProjectAccess = {
  workspaceId: string;
  projectId: string | null;
  projectOwnerId: string | null;
};

type Target = ProjectAccess & { injected: Record<string, unknown> };

function fail<T>(
  status: 400 | 403 | 404 | 409 | 500,
  message: string,
  current?: unknown,
): ServiceResult<T> {
  return { ok: false, status, message, current };
}

function filterValue(payload: Record<string, unknown>, path: string): unknown {
  let current: unknown = payload;
  for (const segment of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function comparable(value: unknown): string | number {
  if (typeof value === 'number') return value;
  const raw = String(value ?? '');
  const parsed = Number(raw);
  return raw.trim() !== '' && Number.isFinite(parsed) ? parsed : raw;
}

/** Event subscription filters: exact values, arrays (any-of) and {operator, value}. */
export function matchesEventFilter(
  payload: Record<string, unknown>,
  filter: Record<string, unknown>,
): boolean {
  return Object.entries(filter).every(([path, expected]) => {
    const actual = filterValue(payload, path);
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      const spec = expected as Record<string, unknown>;
      const operator = String(spec.operator ?? spec.op ?? 'eq');
      const value = 'value' in spec ? spec.value : spec.values;
      switch (operator) {
        case 'eq':
          return String(actual ?? '') === String(value ?? '');
        case 'neq':
          return String(actual ?? '') !== String(value ?? '');
        case 'in':
          return Array.isArray(value)
            ? value.some((item) => String(item) === String(actual ?? ''))
            : false;
        case 'nin':
          return Array.isArray(value)
            ? !value.some((item) => String(item) === String(actual ?? ''))
            : false;
        case 'gt':
          return comparable(actual) > comparable(value);
        case 'gte':
          return comparable(actual) >= comparable(value);
        case 'lt':
          return comparable(actual) < comparable(value);
        case 'lte':
          return comparable(actual) <= comparable(value);
        case 'exists':
          return value === false ? actual === undefined : actual !== undefined;
        case 'contains':
          return Array.isArray(actual)
            ? actual.some((item) => String(item) === String(value ?? ''))
            : String(actual ?? '').includes(String(value ?? ''));
        case 'startsWith':
          return String(actual ?? '').startsWith(String(value ?? ''));
        default:
          return false;
      }
    }
    if (Array.isArray(expected)) {
      return expected.some((item) => String(item) === String(actual ?? ''));
    }
    return String(actual ?? '') === String(expected ?? '');
  });
}

export class DomainService {
  readonly #store: Store;
  readonly #tables = new Map<string, DomainTable>();

  constructor(store: Store) {
    this.#store = store;
  }

  now(): string {
    return this.#store.now().toISOString();
  }

  workspaceOf(user: SessionUser): string {
    return user.workspaceId ?? 'ws_default';
  }

  canManageWorkspace(user: SessionUser): boolean {
    return canManageWorkspace(user.role, user.permissions);
  }

  canViewAll(user: SessionUser): boolean {
    return canViewAllProjects(user.role, user.permissions);
  }

  visibleProjectIds(user: SessionUser): Set<string> {
    return this.#store.projects.visibleProjectIds(user.role, user.id);
  }

  projectAccess(projectId: string, user: SessionUser): ProjectAccess | null {
    const project = this.#store.projects.get(projectId, user.role, user.id);
    if (!project) return null;
    if (project.workspaceId !== this.workspaceOf(user)) return null;
    return {
      workspaceId: project.workspaceId,
      projectId: project.id,
      projectOwnerId: project.ownerId,
    };
  }

  canManageProject(project: ProjectAccess, user: SessionUser): boolean {
    return canManageProject(user.role, project.projectOwnerId === user.id, user.permissions);
  }

  table(def: ResourceDef): DomainTable {
    let table = this.#tables.get(def.key);
    if (!table) {
      table = new DomainTable(this.#store.db, def.table, {
        json: def.json,
        bool: def.bool,
        columns: def.columns,
        versioned: def.versioned,
        created: def.created,
        updated: def.updated,
        order: def.order,
        search: def.search,
      });
      this.#tables.set(def.key, table);
    }
    return table;
  }

  // -------------------------------------------------------------------------
  // Lists and lookups
  // -------------------------------------------------------------------------

  #projectSubquery(user: SessionUser): { sql: string; params: unknown[] } | null {
    if (!this.canViewAll(user)) {
      const ids = [...this.visibleProjectIds(user)];
      if (ids.length === 0) return { sql: 'SELECT id FROM projects WHERE 0', params: [] };
      return {
        sql: `SELECT id FROM projects WHERE id IN (${ids.map(() => '?').join(', ')})`,
        params: ids,
      };
    }
    return {
      sql: 'SELECT id FROM projects WHERE workspace_id = ? AND deleted_at IS NULL',
      params: [this.workspaceOf(user)],
    };
  }

  #scopeFilter(
    def: ResourceDef,
    user: SessionUser,
  ): ServiceResult<{ sql: string; params: unknown[] }> {
    const workspace = this.workspaceOf(user);
    if (def.scope === 'admin') {
      return user.role === 'admin'
        ? { ok: true, data: { sql: '1 = 1', params: [] } }
        : fail(403, '仅平台管理员可访问');
    }
    if (def.scope === 'org') {
      if (user.role !== 'admin') return fail(403, '仅平台管理员可访问');
      return { ok: true, data: { sql: '1 = 1', params: [] } };
    }
    if (def.scope === 'workspace') {
      return { ok: true, data: { sql: 'workspace_id = ?', params: [workspace] } };
    }
    if (def.scope === 'workflow') {
      return {
        ok: true,
        data: {
          sql: 'workflow_id IN (SELECT id FROM workflows WHERE workspace_id = ?)',
          params: [workspace],
        },
      };
    }
    if (def.scope === 'workflow_run') {
      return {
        ok: true,
        data: {
          sql: 'run_id IN (SELECT r.id FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id WHERE w.workspace_id = ?)',
          params: [workspace],
        },
      };
    }
    if (def.scope === 'approval') {
      return {
        ok: true,
        data: {
          sql: 'request_id IN (SELECT id FROM approval_requests WHERE workspace_id = ?)',
          params: [workspace],
        },
      };
    }
    if (def.scope === 'subscription') {
      return {
        ok: true,
        data: {
          sql: 'subscription_id IN (SELECT id FROM report_subscriptions WHERE workspace_id = ?)',
          params: [workspace],
        },
      };
    }
    if (def.scope === 'quality') {
      return {
        ok: true,
        data: {
          sql: 'rule_id IN (SELECT id FROM data_quality_rules WHERE workspace_id = ?)',
          params: [workspace],
        },
      };
    }
    if (def.scope === 'metric') {
      return {
        ok: true,
        data: {
          sql: 'metric_id IN (SELECT id FROM metric_definitions WHERE workspace_id = ?)',
          params: [workspace],
        },
      };
    }
    if (def.scope === 'event') {
      return {
        ok: true,
        data: {
          sql: 'event_id IN (SELECT id FROM domain_events WHERE workspace_id = ?)',
          params: [workspace],
        },
      };
    }
    if (def.scope === 'rule') {
      return {
        ok: true,
        data: {
          sql: 'rule_id IN (SELECT id FROM automation_rules WHERE workspace_id = ?)',
          params: [workspace],
        },
      };
    }
    const projects = this.#projectSubquery(user);
    if (!projects) return fail(404, '工作区不存在');
    const inProjects = `IN (${projects.sql})`;
    const byProject: Partial<Record<ResourceDef['scope'], string>> = {
      project: `project_id ${inProjects}`,
      task: `task_id IN (SELECT id FROM project_tasks WHERE project_id ${inProjects})`,
      document: `document_id IN (SELECT id FROM project_documents WHERE project_id ${inProjects})`,
      deliverable: `deliverable_id IN (SELECT d.id FROM task_deliverables d JOIN project_tasks t ON t.id = d.task_id WHERE t.project_id ${inProjects})`,
      blocker: `blocker_id IN (SELECT b.id FROM task_blockers b JOIN project_tasks t ON t.id = b.task_id WHERE t.project_id ${inProjects})`,
      meeting: `meeting_id IN (SELECT id FROM meetings WHERE project_id ${inProjects})`,
      channel: `channel_id IN (SELECT id FROM discussion_channels WHERE project_id ${inProjects})`,
      portal: `portal_id IN (SELECT id FROM customer_portals WHERE project_id ${inProjects})`,
      gate: `gate_id IN (SELECT id FROM stage_gates WHERE project_id ${inProjects})`,
      closure: `closure_id IN (SELECT id FROM project_closures WHERE project_id ${inProjects})`,
      benefit: `closure_id IN (SELECT id FROM project_closures WHERE project_id ${inProjects})`,
      budget: `budget_id IN (SELECT id FROM project_budgets WHERE project_id ${inProjects})`,
    };
    const sql = byProject[def.scope];
    if (!sql) return fail(500, '不支持的资源范围');
    return { ok: true, data: { sql, params: projects.params } };
  }

  #explicitFilter(query: WorkbenchQuery): { sql: string; params: unknown[] } | null {
    const pairs: [string | undefined, string][] = [
      [query.projectId, 'project_id'],
      [query.taskId, 'task_id'],
      [query.documentId, 'document_id'],
      [query.deliverableId, 'deliverable_id'],
      [query.blockerId, 'blocker_id'],
      [query.meetingId, 'meeting_id'],
      [query.channelId, 'channel_id'],
      [query.portalId, 'portal_id'],
      [query.gateId, 'gate_id'],
      [query.closureId, 'closure_id'],
      [query.budgetId, 'budget_id'],
      [query.requestId, 'request_id'],
      [query.subscriptionId, 'subscription_id'],
      [query.workflowId, 'workflow_id'],
      [query.runId, 'run_id'],
      [query.metricId, 'metric_id'],
      [query.ruleId, 'rule_id'],
      [query.eventId, 'event_id'],
      [query.orgId, 'org_id'],
    ];
    for (const [value, column] of pairs) {
      if (value) return { sql: `${column} = ?`, params: [value] };
    }
    return null;
  }

  list(
    def: ResourceDef,
    user: SessionUser,
    query: WorkbenchQuery,
  ): ServiceResult<{ items: DomainRecord[]; total: number }> {
    if (!def.generic) return fail(400, '该资源请使用专用接口');
    if (query.projectId) {
      const access = this.projectAccess(query.projectId, user);
      if (!access) return fail(404, '项目不存在');
    }
    const scope = this.#scopeFilter(def, user);
    if (!scope.ok) return scope;
    const clauses = [scope.data.sql];
    const params = [...scope.data.params];
    const explicit = this.#explicitFilter(query);
    if (explicit) {
      clauses.push(explicit.sql);
      params.push(...explicit.params);
    }
    if (query.status) {
      clauses.push('status = ?');
      params.push(query.status);
    }
    if (
      (def.key === 'query-reports' || def.key === 'report-subscriptions') &&
      !this.canManageWorkspace(user)
    ) {
      clauses.push('user_id = ?');
      params.push(user.id);
    }
    if (def.key === 'delegations' && !this.canManageWorkspace(user)) {
      clauses.push('(delegator_id = ? OR delegate_id = ?)');
      params.push(user.id, user.id);
    }
    const result = this.table(def).list(clauses.join(' AND '), params, {
      limit: query.limit,
      offset: query.offset,
      q: query.q,
    });
    return {
      ok: true,
      data: { items: result.items.map((row) => this.#view(def, row)), total: result.total },
    };
  }

  #view(def: ResourceDef, record: DomainRecord): DomainRecord {
    return def.key === 'connectors' ? connectorView(record) : record;
  }

  #rowRef(
    sql: string,
    params: unknown[],
  ): { projectId: string | null; workspaceId: string | null; orgId?: string } | null {
    const row = this.#store.db.stmt(sql).get(...(params as string[])) as unknown as
      | { project_id?: string | null; workspace_id?: string | null; org_id?: string | null }
      | undefined;
    if (!row) return null;
    return {
      projectId: row.project_id ?? null,
      workspaceId: row.workspace_id ?? null,
      orgId: row.org_id ?? undefined,
    };
  }

  #rowAccess(def: ResourceDef, row: DomainRecord, user: SessionUser): ProjectAccess | null {
    const workspace = this.workspaceOf(user);
    const value = (key: string): string | null => {
      const candidate = row[key];
      return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
    };
    if (def.scope === 'admin') {
      return user.role === 'admin'
        ? { workspaceId: workspace, projectId: null, projectOwnerId: null }
        : null;
    }
    if (def.scope === 'org') {
      return user.role === 'admin'
        ? { workspaceId: workspace, projectId: null, projectOwnerId: null }
        : null;
    }
    if (def.scope === 'workspace') {
      return value('workspaceId') === workspace
        ? { workspaceId: workspace, projectId: null, projectOwnerId: null }
        : null;
    }
    if (def.scope === 'project') {
      const projectId = value('projectId');
      return projectId ? this.projectAccess(projectId, user) : null;
    }
    if (def.scope === 'approval') {
      const requestId = value('requestId');
      if (!requestId) return null;
      const ref = this.#rowRef(
        'SELECT project_id, workspace_id FROM approval_requests WHERE id = ?',
        [requestId],
      );
      if (!ref || ref.workspaceId !== workspace) return null;
      return ref.projectId
        ? this.projectAccess(ref.projectId, user)
        : { workspaceId: workspace, projectId: null, projectOwnerId: null };
    }
    if (def.scope === 'subscription') {
      const ref = this.#rowRef('SELECT workspace_id FROM report_subscriptions WHERE id = ?', [
        value('subscriptionId') ?? '',
      ]);
      return ref?.workspaceId === workspace
        ? { workspaceId: workspace, projectId: null, projectOwnerId: null }
        : null;
    }
    if (def.scope === 'quality') {
      const ref = this.#rowRef('SELECT workspace_id FROM data_quality_rules WHERE id = ?', [
        value('ruleId') ?? '',
      ]);
      return ref?.workspaceId === workspace
        ? { workspaceId: workspace, projectId: null, projectOwnerId: null }
        : null;
    }
    if (def.scope === 'metric') {
      const ref = this.#rowRef('SELECT workspace_id FROM metric_definitions WHERE id = ?', [
        value('metricId') ?? '',
      ]);
      return ref?.workspaceId === workspace
        ? { workspaceId: workspace, projectId: null, projectOwnerId: null }
        : null;
    }
    if (def.scope === 'event') {
      const ref = this.#rowRef('SELECT workspace_id FROM domain_events WHERE id = ?', [
        value('eventId') ?? '',
      ]);
      return ref?.workspaceId === workspace
        ? { workspaceId: workspace, projectId: null, projectOwnerId: null }
        : null;
    }
    if (def.scope === 'rule') {
      const ref = this.#rowRef('SELECT workspace_id FROM automation_rules WHERE id = ?', [
        value('ruleId') ?? '',
      ]);
      return ref?.workspaceId === workspace
        ? { workspaceId: workspace, projectId: null, projectOwnerId: null }
        : null;
    }
    if (def.scope === 'workflow') {
      const ref = this.#rowRef('SELECT workspace_id, project_id FROM workflows WHERE id = ?', [
        value('workflowId') ?? '',
      ]);
      if (!ref || ref.workspaceId !== workspace) return null;
      return ref.projectId
        ? this.projectAccess(ref.projectId, user)
        : { workspaceId: workspace, projectId: null, projectOwnerId: null };
    }
    if (def.scope === 'workflow_run') {
      const ref = this.#rowRef(
        `SELECT w.workspace_id, w.project_id FROM workflow_runs r
         JOIN workflows w ON w.id = r.workflow_id WHERE r.id = ?`,
        [value('runId') ?? ''],
      );
      if (!ref || ref.workspaceId !== workspace) return null;
      return ref.projectId
        ? this.projectAccess(ref.projectId, user)
        : { workspaceId: workspace, projectId: null, projectOwnerId: null };
    }
    const scopeSql: Partial<Record<ResourceDef['scope'], string>> = {
      task: 'SELECT t.project_id, p.workspace_id FROM project_tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ? AND p.deleted_at IS NULL',
      document:
        'SELECT d.project_id, p.workspace_id FROM project_documents d JOIN projects p ON p.id = d.project_id WHERE d.id = ? AND p.deleted_at IS NULL',
      deliverable:
        'SELECT t.project_id, p.workspace_id FROM task_deliverables d JOIN project_tasks t ON t.id = d.task_id JOIN projects p ON p.id = t.project_id WHERE d.id = ? AND p.deleted_at IS NULL',
      blocker:
        'SELECT t.project_id, p.workspace_id FROM task_blockers b JOIN project_tasks t ON t.id = b.task_id JOIN projects p ON p.id = t.project_id WHERE b.id = ? AND p.deleted_at IS NULL',
      meeting:
        'SELECT m.project_id, p.workspace_id FROM meetings m JOIN projects p ON p.id = m.project_id WHERE m.id = ? AND p.deleted_at IS NULL',
      channel:
        'SELECT c.project_id, p.workspace_id FROM discussion_channels c JOIN projects p ON p.id = c.project_id WHERE c.id = ? AND p.deleted_at IS NULL',
      portal:
        'SELECT c.project_id, p.workspace_id FROM customer_portals c JOIN projects p ON p.id = c.project_id WHERE c.id = ? AND p.deleted_at IS NULL',
      gate: 'SELECT g.project_id, p.workspace_id FROM stage_gates g JOIN projects p ON p.id = g.project_id WHERE g.id = ? AND p.deleted_at IS NULL',
      closure:
        'SELECT c.project_id, p.workspace_id FROM project_closures c JOIN projects p ON p.id = c.project_id WHERE c.id = ? AND p.deleted_at IS NULL',
      benefit:
        'SELECT c.project_id, p.workspace_id FROM benefit_reviews b JOIN project_closures c ON c.id = b.closure_id JOIN projects p ON p.id = c.project_id WHERE b.id = ? AND p.deleted_at IS NULL',
      budget:
        'SELECT b.project_id, p.workspace_id FROM project_budgets b JOIN projects p ON p.id = b.project_id WHERE b.id = ? AND p.deleted_at IS NULL',
    };
    const scopeKey: Partial<Record<ResourceDef['scope'], string>> = {
      task: 'taskId',
      document: 'documentId',
      deliverable: 'deliverableId',
      blocker: 'blockerId',
      meeting: 'meetingId',
      channel: 'channelId',
      portal: 'portalId',
      gate: 'gateId',
      closure: 'closureId',
      benefit: 'closureId',
      budget: 'budgetId',
    };
    const sql = scopeSql[def.scope];
    if (!sql) return null;
    const ref = this.#rowRef(sql, [value(scopeKey[def.scope] ?? 'id') ?? '']);
    if (!ref || ref.workspaceId !== workspace) return null;
    return ref.projectId ? this.projectAccess(ref.projectId, user) : null;
  }

  #canWrite(
    def: ResourceDef,
    user: SessionUser,
    access: ProjectAccess,
    row?: DomainRecord,
  ): boolean {
    if (def.write === 'read') return false;
    if (def.write === 'admin') return user.role === 'admin';
    if (def.write === 'workspace') return this.canManageWorkspace(user);
    if (def.write === 'manage') {
      if (!access.projectId) return this.canManageWorkspace(user);
      return this.canManageProject(access, user);
    }
    if (def.write === 'member') return true;
    if (def.write === 'self') {
      if (this.canManageWorkspace(user)) return true;
      if (!row) return true;
      const owners = [row.userId, row.delegatorId, row.createdBy];
      return owners.some((owner) => owner === user.id);
    }
    return false;
  }

  #canRead(def: ResourceDef, user: SessionUser, row: DomainRecord): boolean {
    if (def.key === 'query-reports') {
      if (row.shared || row.userId === user.id) return true;
      return this.canManageWorkspace(user);
    }
    if (def.key === 'report-subscriptions') {
      return row.createdBy === user.id || this.canManageWorkspace(user);
    }
    return true;
  }

  get(def: ResourceDef, user: SessionUser, id: string): ServiceResult<DomainRecord | null> {
    if (!def.generic) return fail(400, '该资源请使用专用接口');
    const row = this.table(def).get(id);
    if (!row) return { ok: true, data: null };
    const access = this.#rowAccess(def, row, user);
    if (!access || !this.#canRead(def, user, row)) return { ok: true, data: null };
    return { ok: true, data: this.#view(def, row) };
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  #targetFromQuery(
    def: ResourceDef,
    user: SessionUser,
    query: WorkbenchQuery,
  ): ServiceResult<Target> {
    const workspace = query.workspaceId ?? this.workspaceOf(user);
    if (workspace !== this.workspaceOf(user)) return fail(404, '工作区不存在');
    if (def.scope === 'admin' || def.scope === 'org') {
      if (user.role !== 'admin') return fail(403, '仅平台管理员可访问');
      return {
        ok: true,
        data: {
          workspaceId: workspace,
          projectId: null,
          projectOwnerId: null,
          injected: query.orgId ? { org_id: query.orgId } : {},
        },
      };
    }
    if (def.scope === 'workspace') {
      return {
        ok: true,
        data: {
          workspaceId: workspace,
          projectId: null,
          projectOwnerId: null,
          injected: { workspace_id: workspace },
        },
      };
    }
    if (def.scope === 'project') {
      if (!query.projectId) return fail(400, '请选择项目');
      const access = this.projectAccess(query.projectId, user);
      if (!access) return fail(404, '项目不存在');
      return { ok: true, data: { ...access, injected: { project_id: access.projectId } } };
    }
    if (def.scope === 'task') {
      if (!query.taskId) return fail(400, '请选择任务');
      const ref = this.#rowRef(
        'SELECT t.project_id, p.workspace_id FROM project_tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ? AND p.deleted_at IS NULL',
        [query.taskId],
      );
      if (!ref?.projectId) return fail(404, '任务不存在');
      const access = this.projectAccess(ref.projectId, user);
      if (!access) return fail(404, '任务不存在');
      return { ok: true, data: { ...access, injected: { task_id: query.taskId } } };
    }
    if (def.scope === 'document') {
      if (!query.documentId) return fail(400, '请选择文档');
      const ref = this.#rowRef(
        'SELECT d.project_id, p.workspace_id FROM project_documents d JOIN projects p ON p.id = d.project_id WHERE d.id = ? AND p.deleted_at IS NULL',
        [query.documentId],
      );
      if (!ref?.projectId) return fail(404, '文档不存在');
      const access = this.projectAccess(ref.projectId, user);
      if (!access) return fail(404, '文档不存在');
      return { ok: true, data: { ...access, injected: { document_id: query.documentId } } };
    }
    if (def.scope === 'deliverable') {
      if (!query.deliverableId) return fail(400, '请选择交付物');
      const ref = this.#rowRef(
        'SELECT t.project_id, p.workspace_id FROM task_deliverables d JOIN project_tasks t ON t.id = d.task_id JOIN projects p ON p.id = t.project_id WHERE d.id = ? AND p.deleted_at IS NULL',
        [query.deliverableId],
      );
      if (!ref?.projectId) return fail(404, '交付物不存在');
      const access = this.projectAccess(ref.projectId, user);
      if (!access) return fail(404, '交付物不存在');
      return { ok: true, data: { ...access, injected: { deliverable_id: query.deliverableId } } };
    }
    if (def.scope === 'blocker') {
      if (!query.blockerId) return fail(400, '请选择阻塞记录');
      const ref = this.#rowRef(
        'SELECT t.project_id, p.workspace_id FROM task_blockers b JOIN project_tasks t ON t.id = b.task_id JOIN projects p ON p.id = t.project_id WHERE b.id = ? AND p.deleted_at IS NULL',
        [query.blockerId],
      );
      if (!ref?.projectId) return fail(404, '阻塞记录不存在');
      const access = this.projectAccess(ref.projectId, user);
      if (!access) return fail(404, '阻塞记录不存在');
      return { ok: true, data: { ...access, injected: { blocker_id: query.blockerId } } };
    }
    if (def.scope === 'meeting') {
      if (!query.meetingId) return fail(400, '请选择会议');
      const ref = this.#rowRef(
        'SELECT m.project_id, p.workspace_id FROM meetings m JOIN projects p ON p.id = m.project_id WHERE m.id = ? AND p.deleted_at IS NULL',
        [query.meetingId],
      );
      if (!ref?.projectId) return fail(404, '会议不存在');
      const access = this.projectAccess(ref.projectId, user);
      if (!access) return fail(404, '会议不存在');
      return { ok: true, data: { ...access, injected: { meeting_id: query.meetingId } } };
    }
    if (def.scope === 'channel') {
      if (!query.channelId) return fail(400, '请选择频道');
      const ref = this.#rowRef(
        'SELECT c.project_id, p.workspace_id FROM discussion_channels c JOIN projects p ON p.id = c.project_id WHERE c.id = ? AND p.deleted_at IS NULL',
        [query.channelId],
      );
      if (!ref?.projectId) return fail(404, '频道不存在');
      const access = this.projectAccess(ref.projectId, user);
      if (!access) return fail(404, '频道不存在');
      return { ok: true, data: { ...access, injected: { channel_id: query.channelId } } };
    }
    if (def.scope === 'portal') {
      if (!query.portalId) return fail(400, '请选择客户门户');
      const ref = this.#rowRef(
        'SELECT c.project_id, p.workspace_id FROM customer_portals c JOIN projects p ON p.id = c.project_id WHERE c.id = ? AND p.deleted_at IS NULL',
        [query.portalId],
      );
      if (!ref?.projectId) return fail(404, '客户门户不存在');
      const access = this.projectAccess(ref.projectId, user);
      if (!access) return fail(404, '客户门户不存在');
      return { ok: true, data: { ...access, injected: { portal_id: query.portalId } } };
    }
    if (def.scope === 'workflow') {
      if (!query.workflowId) return fail(400, '请选择工作流');
      const ref = this.#rowRef('SELECT workspace_id, project_id FROM workflows WHERE id = ?', [
        query.workflowId,
      ]);
      if (!ref || ref.workspaceId !== this.workspaceOf(user)) return fail(404, '工作流不存在');
      const access = ref.projectId
        ? this.projectAccess(ref.projectId, user)
        : { workspaceId: this.workspaceOf(user), projectId: null, projectOwnerId: null };
      if (!access) return fail(404, '工作流不存在');
      return { ok: true, data: { ...access, injected: { workflow_id: query.workflowId } } };
    }
    if (def.scope === 'workflow_run') {
      if (!query.runId) return fail(400, '请选择运行实例');
      const ref = this.#rowRef(
        'SELECT w.workspace_id, w.project_id FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id WHERE r.id = ?',
        [query.runId],
      );
      if (!ref || ref.workspaceId !== this.workspaceOf(user)) return fail(404, '运行实例不存在');
      const access = ref.projectId
        ? this.projectAccess(ref.projectId, user)
        : { workspaceId: this.workspaceOf(user), projectId: null, projectOwnerId: null };
      if (!access) return fail(404, '运行实例不存在');
      return { ok: true, data: { ...access, injected: { run_id: query.runId } } };
    }
    if (def.scope === 'gate') {
      if (!query.gateId) return fail(400, '请选择阶段门');
      const ref = this.#rowRef('SELECT project_id FROM stage_gates WHERE id = ?', [query.gateId]);
      if (!ref?.projectId) return fail(404, '阶段门不存在');
      const access = this.projectAccess(ref.projectId, user);
      if (!access) return fail(404, '阶段门不存在');
      return { ok: true, data: { ...access, injected: { gate_id: query.gateId } } };
    }
    if (def.scope === 'closure' || def.scope === 'benefit') {
      if (!query.closureId) return fail(400, '请选择结项记录');
      const ref = this.#rowRef('SELECT project_id FROM project_closures WHERE id = ?', [
        query.closureId,
      ]);
      if (!ref?.projectId) return fail(404, '结项记录不存在');
      const access = this.projectAccess(ref.projectId, user);
      if (!access) return fail(404, '结项记录不存在');
      return { ok: true, data: { ...access, injected: { closure_id: query.closureId } } };
    }
    if (def.scope === 'budget') {
      if (!query.budgetId) return fail(400, '请选择预算');
      const ref = this.#rowRef('SELECT project_id FROM project_budgets WHERE id = ?', [
        query.budgetId,
      ]);
      if (!ref?.projectId) return fail(404, '预算不存在');
      const access = this.projectAccess(ref.projectId, user);
      if (!access) return fail(404, '预算不存在');
      return { ok: true, data: { ...access, injected: { budget_id: query.budgetId } } };
    }
    if (def.scope === 'approval') {
      if (!query.requestId) return fail(400, '请选择审批请求');
      const ref = this.#rowRef(
        'SELECT project_id, workspace_id FROM approval_requests WHERE id = ?',
        [query.requestId],
      );
      if (!ref || ref.workspaceId !== this.workspaceOf(user)) return fail(404, '审批请求不存在');
      const access = ref.projectId
        ? this.projectAccess(ref.projectId, user)
        : { workspaceId: this.workspaceOf(user), projectId: null, projectOwnerId: null };
      if (!access) return fail(404, '审批请求不存在');
      return { ok: true, data: { ...access, injected: { request_id: query.requestId } } };
    }
    if (def.scope === 'subscription') {
      if (!query.subscriptionId) return fail(400, '请选择订阅');
      const ref = this.#rowRef('SELECT workspace_id FROM report_subscriptions WHERE id = ?', [
        query.subscriptionId,
      ]);
      if (ref?.workspaceId !== this.workspaceOf(user)) return fail(404, '订阅不存在');
      return {
        ok: true,
        data: {
          workspaceId: this.workspaceOf(user),
          projectId: null,
          projectOwnerId: null,
          injected: { subscription_id: query.subscriptionId },
        },
      };
    }
    if (def.scope === 'quality') {
      if (!query.ruleId) return fail(400, '请选择数据质量规则');
      const ref = this.#rowRef('SELECT workspace_id FROM data_quality_rules WHERE id = ?', [
        query.ruleId,
      ]);
      if (ref?.workspaceId !== this.workspaceOf(user)) return fail(404, '规则不存在');
      return {
        ok: true,
        data: {
          workspaceId: this.workspaceOf(user),
          projectId: null,
          projectOwnerId: null,
          injected: { rule_id: query.ruleId },
        },
      };
    }
    if (def.scope === 'metric') {
      if (!query.metricId) return fail(400, '请选择指标');
      const ref = this.#rowRef('SELECT workspace_id FROM metric_definitions WHERE id = ?', [
        query.metricId,
      ]);
      if (ref?.workspaceId !== this.workspaceOf(user)) return fail(404, '指标不存在');
      return {
        ok: true,
        data: {
          workspaceId: this.workspaceOf(user),
          projectId: null,
          projectOwnerId: null,
          injected: { metric_id: query.metricId },
        },
      };
    }
    if (def.scope === 'event') {
      if (!query.eventId) return fail(400, '请选择事件');
      return {
        ok: true,
        data: {
          workspaceId: this.workspaceOf(user),
          projectId: null,
          projectOwnerId: null,
          injected: { event_id: query.eventId },
        },
      };
    }
    if (def.scope === 'rule') {
      if (!query.ruleId) return fail(400, '请选择自动化规则');
      return {
        ok: true,
        data: {
          workspaceId: this.workspaceOf(user),
          projectId: null,
          projectOwnerId: null,
          injected: { rule_id: query.ruleId },
        },
      };
    }
    return fail(400, '不支持的资源范围');
  }

  create(
    def: ResourceDef,
    user: SessionUser,
    query: WorkbenchQuery,
    input: Record<string, unknown>,
    reqId?: string,
  ): ServiceResult<DomainRecord> {
    if (!def.allowCreate) return fail(400, '该资源不支持直接创建');
    if (!def.generic) return fail(400, '该资源请使用专用接口');
    const target = this.#targetFromQuery(def, user, query);
    if (!target.ok) return target;
    if (!this.#canWrite(def, user, target.data)) return fail(403, '没有创建该资源的权限');
    const record = { ...input, ...target.data.injected };
    if (def.columns.includes('created_by') && record.created_by === undefined) {
      record.created_by = user.id;
    }
    if (def.columns.includes('author_id') && record.author_id === undefined) {
      record.author_id = user.id;
    }
    if (def.columns.includes('requested_by') && record.requested_by === undefined) {
      record.requested_by = user.id;
    }
    if (def.key === 'change-requests') record.workspace_id = target.data.workspaceId;
    if (def.key === 'query-reports') record.user_id = user.id;
    if (def.key === 'report-subscriptions') record.created_by = user.id;
    if (def.key === 'connectors') this.#secureConnector(record);
    if (def.key === 'opportunities' && record.entered_stage_at === undefined) {
      record.entered_stage_at = this.now();
    }
    if (def.key === 'delegations' && record.delegator_id === undefined)
      record.delegator_id = user.id;
    if (
      def.key === 'delegations' &&
      record.delegator_id !== user.id &&
      !this.canManageWorkspace(user)
    ) {
      return fail(403, '只能为自己创建代理');
    }
    if (def.key === 'meetings') {
      const attendeeIds = Array.isArray(input.attendeeIds)
        ? input.attendeeIds.map((id) => String(id))
        : [];
      for (const attendeeId of attendeeIds) {
        const member = this.#store.db
          .stmt('SELECT id FROM users WHERE id = ? AND workspace_id = ?')
          .get(attendeeId, target.data.workspaceId);
        if (!member) return fail(400, '参会人不存在');
      }
    }
    const created = this.table(def).create(record, this.now());
    const data = def.key === 'meetings' ? this.#expandMeetingSeries(created, user, input) : created;
    const view = this.#view(def, data);
    this.audit(user.id, `workbench.${def.key}.create`, view.id, { reqId, record: view });
    this.publish(def, user, 'created', view);
    return { ok: true, data: view };
  }

  #secureConnector(record: Record<string, unknown>): void {
    const secret = typeof record.secret === 'string' ? record.secret.trim() : '';
    const clientSecret = typeof record.clientSecret === 'string' ? record.clientSecret.trim() : '';
    delete record.secret;
    delete record.clientSecret;
    delete record.secret_ref;
    delete record.client_secret_ref;
    delete record.secretRef;
    delete record.clientSecretRef;
    if (secret) record.secret_ref = encryptConnectorSecret(this.#store.db, secret);
    if (clientSecret) {
      record.client_secret_ref = encryptConnectorSecret(this.#store.db, clientSecret);
    }
    if (record.kind !== undefined) {
      const scopes = Array.isArray(record.scopes) ? record.scopes.map((item) => String(item)) : [];
      record.capabilities_json = connectorCapabilities(String(record.kind), scopes);
    }
    if (record.health === undefined) {
      record.health = secret || clientSecret ? 'ok' : 'degraded';
    }
  }

  #expandMeetingSeries(
    created: DomainRecord,
    user: SessionUser,
    input: Record<string, unknown>,
  ): DomainRecord {
    const now = this.now();
    const attendeeIds = [
      ...new Set(
        (Array.isArray(input.attendeeIds) ? input.attendeeIds : []).map((id) => String(id)),
      ),
    ];
    const addAttendees = (meetingId: string): void => {
      for (const attendeeId of attendeeIds) {
        this.#store.db
          .stmt(
            `INSERT OR IGNORE INTO meeting_attendees (meeting_id, user_id, status)
             VALUES (?, ?, 'invited')`,
          )
          .run(meetingId, attendeeId);
      }
    };
    addAttendees(created.id);
    const rule = String(created.seriesRule ?? '').trim();
    const startsAt = String(created.startsAt ?? '');
    if (!rule || !startsAt) return created;
    const startDate = startsAt.slice(0, 10);
    const timeSuffix = startsAt.slice(10);
    const horizon = new Date(Date.parse(startsAt) + 366 * 2 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const dates = recurrenceOccurrences(rule, startDate, { through: horizon }).slice(1, 53);
    const duration = created.endsAt
      ? Date.parse(String(created.endsAt)) - Date.parse(startsAt)
      : null;
    for (const date of dates) {
      const id: string = randomUUID();
      const start = `${date}${timeSuffix}`;
      const endsAt =
        duration !== null ? new Date(Date.parse(start) + duration).toISOString() : null;
      this.#store.db
        .stmt(
          `INSERT INTO meetings
             (id, project_id, title, series_rule, timezone, starts_at, ends_at,
              agenda_json, minutes, status, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          created.projectId == null ? null : String(created.projectId),
          String(created.title ?? ''),
          rule,
          String(created.timezone ?? 'Asia/Shanghai'),
          start,
          endsAt,
          JSON.stringify(created.agenda ?? []),
          '',
          'scheduled',
          user.id,
          now,
          now,
        );
      this.#store.db.stmt('UPDATE meetings SET series_id = ? WHERE id = ?').run(created.id, id);
      addAttendees(id);
    }
    this.#store.db
      .stmt('UPDATE meetings SET series_id = ? WHERE id = ?')
      .run(created.id, created.id);
    return { ...created, seriesId: created.id };
  }

  update(
    def: ResourceDef,
    user: SessionUser,
    id: string,
    input: Record<string, unknown>,
    reqId?: string,
  ): ServiceResult<DomainRecord> {
    if (!def.allowUpdate) return fail(400, '该资源不支持直接更新');
    if (!def.generic) return fail(400, '该资源请使用专用接口');
    const row = this.table(def).get(id);
    if (!row) return fail(404, '资源不存在');
    const access = this.#rowAccess(def, row, user);
    if (!access) return fail(404, '资源不存在');
    if (!this.#canWrite(def, user, access, row)) return fail(403, '没有更新该资源的权限');
    const changes = { ...input };
    if (def.key === 'connectors') {
      const hasSecret = typeof changes.secret === 'string' && changes.secret.trim() !== '';
      const hasClientSecret =
        typeof changes.clientSecret === 'string' && changes.clientSecret.trim() !== '';
      this.#secureConnector(changes);
      if (hasSecret || hasClientSecret) changes.health = 'ok';
      if (changes.kind !== undefined || changes.scopes !== undefined) {
        const scopes = Array.isArray(changes.scopes)
          ? changes.scopes.map((item) => String(item))
          : Array.isArray(row.scopes)
            ? row.scopes.map((item) => String(item))
            : [];
        changes.capabilities_json = connectorCapabilities(
          String(changes.kind ?? row.kind ?? 'api_key'),
          scopes,
        );
      }
      if (!hasSecret && !hasClientSecret) delete changes.health;
    }
    const result = this.table(def).update(id, changes, this.now());
    if (result.status === 'missing') return fail(404, '资源不存在');
    if (result.status === 'invalid') return fail(400, result.message);
    if (result.status === 'conflict') return fail(409, '资源已被其他会话修改', result.current);
    const view = this.#view(def, result.record);
    this.audit(user.id, `workbench.${def.key}.update`, id, {
      reqId,
      before: this.#view(def, row),
      after: view,
    });
    this.publish(def, user, 'updated', view);
    return { ok: true, data: view };
  }

  remove(def: ResourceDef, user: SessionUser, id: string, reqId?: string): ServiceResult<true> {
    if (!def.allowDelete) return fail(403, '该资源不支持删除');
    if (!def.generic) return fail(400, '该资源请使用专用接口');
    const row = this.table(def).get(id);
    if (!row) return fail(404, '资源不存在');
    const access = this.#rowAccess(def, row, user);
    if (!access) return fail(404, '资源不存在');
    if (def.key === 'deliverables' && row.status === 'approved') {
      return fail(409, '交付物已签收，不能删除');
    }
    if (!this.#canWrite(def, user, access, row)) return fail(403, '没有删除该资源的权限');
    this.table(def).remove(id);
    this.audit(user.id, `workbench.${def.key}.delete`, id, { reqId, before: row });
    this.publish(def, user, 'deleted', row);
    return { ok: true, data: true };
  }

  // -------------------------------------------------------------------------
  // Cross-cutting collaborators
  // -------------------------------------------------------------------------

  audit(actorId: string | null, action: string, target: string, detail: unknown): void {
    this.#store.db
      .stmt(
        `INSERT INTO audit_log (actor_id, action, target, ip, detail, created_at)
         VALUES (?, ?, ?, NULL, ?, ?)`,
      )
      .run(actorId, action, target, JSON.stringify(detail ?? {}), this.now());
  }

  notify(userId: string, type: string, title: string, body = '', link?: string): void {
    this.#store.db
      .stmt(
        `INSERT INTO notifications (id, user_id, type, title, body, link, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), userId, type, title, body, link ?? null, this.now());
  }

  publish(
    def: ResourceDef,
    user: SessionUser,
    action: 'created' | 'updated' | 'deleted',
    record: DomainRecord,
  ): void {
    this.publishEvent(
      this.workspaceOf(user),
      `workbench.${def.tag}.${def.key}.${action}`,
      { resource: def.key, id: record.id, action, record },
      user.id,
    );
  }

  publishEvent(
    workspaceId: string,
    type: string,
    payload: Record<string, unknown>,
    actorId: string | null,
    dedupeKey?: string,
    schemaVersion = 1,
  ): DomainRecord | null {
    const key = dedupeKey ?? `${type}:${randomUUID()}`;
    const id = randomUUID();
    try {
      this.#store.db
        .stmt(
          `INSERT INTO domain_events
             (id, workspace_id, type, schema_version, payload_json, dedupe_key, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          workspaceId,
          type,
          Math.max(1, Math.floor(schemaVersion)),
          JSON.stringify(payload),
          key,
          actorId,
          this.now(),
        );
    } catch {
      return null;
    }
    const subscriptions = this.#store.db
      .stmt(
        `SELECT id, filter_json, created_by FROM event_subscriptions
         WHERE workspace_id = ? AND event_type = ? AND active = 1`,
      )
      .all(workspaceId, type) as unknown as {
      id: string;
      filter_json: string;
      created_by: string | null;
    }[];
    const record = payload.record as Record<string, unknown> | undefined;
    const projectId =
      typeof payload.projectId === 'string'
        ? payload.projectId
        : typeof payload.project_id === 'string'
          ? payload.project_id
          : typeof record?.projectId === 'string'
            ? record.projectId
            : typeof record?.project_id === 'string'
              ? record.project_id
              : null;
    for (const subscription of subscriptions) {
      if (projectId && subscription.created_by) {
        const subscriber = this.#store.users.findSessionUser(subscription.created_by);
        if (!subscriber || !this.projectAccess(projectId, subscriber)) continue;
      }
      let filter: Record<string, unknown> = {};
      try {
        filter = JSON.parse(subscription.filter_json) as Record<string, unknown>;
      } catch {
        filter = {};
      }
      const matches = matchesEventFilter(payload, filter);
      if (!matches) continue;
      this.#store.db
        .stmt(
          `INSERT OR IGNORE INTO event_deliveries
             (id, event_id, subscription_id, status, attempts, next_attempt_at, created_at)
           VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
        )
        .run(randomUUID(), id, subscription.id, this.now(), this.now());
    }
    return (
      (this.#store.db.stmt('SELECT * FROM domain_events WHERE id = ?').get(id) as unknown as
        | DomainRecord
        | undefined) ?? null
    );
  }

  scheduleJob(
    kind: string,
    payload: Record<string, unknown>,
    runAt: string | null = null,
    idempotencyKey?: string,
    maxAttempts = 3,
  ): string | null {
    const id = randomUUID();
    try {
      this.#store.db
        .stmt(
          `INSERT INTO background_jobs
             (id, kind, status, payload_json, result_json, attempts, max_attempts,
              next_attempt_at, idempotency_key, created_at, updated_at)
           VALUES (?, ?, 'pending', ?, '{}', 0, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          kind,
          JSON.stringify(payload),
          maxAttempts,
          runAt ?? this.now(),
          idempotencyKey ?? null,
          this.now(),
          this.now(),
        );
      return id;
    } catch {
      return null;
    }
  }

  taskProjectId(taskId: string): string | null {
    const row = this.#store.db
      .stmt('SELECT project_id FROM project_tasks WHERE id = ?')
      .get(taskId) as unknown as { project_id: string } | undefined;
    return row?.project_id ?? null;
  }

  projectOfTask(taskId: string, user: SessionUser): ProjectAccess | null {
    const projectId = this.taskProjectId(taskId);
    return projectId ? this.projectAccess(projectId, user) : null;
  }

  projectOfDocument(documentId: string, user: SessionUser): ProjectAccess | null {
    const row = this.#store.db
      .stmt('SELECT project_id FROM project_documents WHERE id = ?')
      .get(documentId) as unknown as { project_id: string } | undefined;
    return row ? this.projectAccess(row.project_id, user) : null;
  }

  projectOfDeliverable(deliverableId: string, user: SessionUser): ProjectAccess | null {
    const row = this.#store.db
      .stmt(
        `SELECT t.project_id FROM task_deliverables d
         JOIN project_tasks t ON t.id = d.task_id WHERE d.id = ?`,
      )
      .get(deliverableId) as unknown as { project_id: string } | undefined;
    return row ? this.projectAccess(row.project_id, user) : null;
  }

  projectOfMeeting(meetingId: string, user: SessionUser): ProjectAccess | null {
    const row = this.#store.db
      .stmt('SELECT project_id FROM meetings WHERE id = ?')
      .get(meetingId) as unknown as { project_id: string } | undefined;
    return row ? this.projectAccess(row.project_id, user) : null;
  }

  projectOfChannel(channelId: string, user: SessionUser): ProjectAccess | null {
    const row = this.#store.db
      .stmt('SELECT project_id FROM discussion_channels WHERE id = ?')
      .get(channelId) as unknown as { project_id: string } | undefined;
    return row ? this.projectAccess(row.project_id, user) : null;
  }

  projectOfPortal(portalId: string, user: SessionUser): ProjectAccess | null {
    const row = this.#store.db
      .stmt('SELECT project_id FROM customer_portals WHERE id = ?')
      .get(portalId) as unknown as { project_id: string } | undefined;
    return row ? this.projectAccess(row.project_id, user) : null;
  }

  projectOfGate(gateId: string, user: SessionUser): ProjectAccess | null {
    const row = this.#store.db
      .stmt('SELECT project_id FROM stage_gates WHERE id = ?')
      .get(gateId) as unknown as { project_id: string } | undefined;
    return row ? this.projectAccess(row.project_id, user) : null;
  }

  projectOfClosure(closureId: string, user: SessionUser): ProjectAccess | null {
    const row = this.#store.db
      .stmt('SELECT project_id FROM project_closures WHERE id = ?')
      .get(closureId) as unknown as { project_id: string } | undefined;
    return row ? this.projectAccess(row.project_id, user) : null;
  }

  projectOfBudget(budgetId: string, user: SessionUser): ProjectAccess | null {
    const row = this.#store.db
      .stmt('SELECT project_id FROM project_budgets WHERE id = ?')
      .get(budgetId) as unknown as { project_id: string } | undefined;
    return row ? this.projectAccess(row.project_id, user) : null;
  }

  workflowAccess(workflowId: string, user: SessionUser): ProjectAccess | null {
    const row = this.#store.db
      .stmt('SELECT workspace_id, project_id FROM workflows WHERE id = ?')
      .get(workflowId) as unknown as
      | { workspace_id: string; project_id: string | null }
      | undefined;
    if (!row || row.workspace_id !== this.workspaceOf(user)) return null;
    return row.project_id
      ? this.projectAccess(row.project_id, user)
      : { workspaceId: row.workspace_id, projectId: null, projectOwnerId: null };
  }
}
