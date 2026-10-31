import type { Permission } from '../../shared/permissions.ts';
import type { ProjectTemplate } from '../../shared/templates.ts';
import type {
  ActivityPage,
  AnalyticsSourceSummary,
  ApprovalMetrics,
  Attachment,
  AttachmentList,
  AttachmentOcr,
  AudienceReport,
  AuditCleanupResult,
  AuditPage,
  AutomationPreview,
  AutomationRule,
  AutomationRun,
  AutomationTrigger,
  BlockerReport,
  BudgetSummary,
  CapacityRow,
  ChannelReport,
  Comment,
  CommentList,
  CriticalPath,
  CurrencyCode,
  CustomRole,
  DashboardSummary,
  DateRangeKey,
  DecisionRecord,
  DecisionVersion,
  DocumentVersion,
  DomainList,
  DomainRecord,
  FeatureFlag,
  FeatureFlagKey,
  FeatureFlags,
  Goal,
  GoalImpact,
  GoalLevel,
  GoalLink,
  GoalTree,
  GoalUpdateMode,
  ImportResult,
  JitGrant,
  KeyResult,
  MetricDay,
  MetricDefinition,
  MetricEvaluation,
  MetricImportResult,
  NotificationList,
  OcrBenchStatus,
  OcrDriftAlertRecord,
  OcrDriftReport,
  OcrEngine,
  OcrExperimentRequest,
  OcrExperimentResult,
  OcrExport,
  OcrFeedbackErrorType,
  OcrFeedbackPool,
  OcrFeedbackSample,
  OcrFeedbackSelection,
  OcrFeedbackStatus,
  OcrFieldList,
  OcrFieldRevision,
  OcrGreyMode,
  OcrKnowledgeGraph,
  OcrMode,
  OcrOptimizationEntry,
  OcrOptimizationRisk,
  OcrOptimizationStatus,
  OcrPassAudit,
  OcrPassAuditStats,
  OcrPassAuditVerdict,
  OcrProductionDashboard,
  OcrRecoveryYield,
  OcrRegistryDecision,
  OcrRegistryEvaluation,
  OcrRegistryPolicy,
  OcrRegistryRole,
  OcrRegistryState,
  OcrRevisionQcItem,
  OcrRevisionQcStats,
  OcrRevisionReviewVerdict,
  OcrStageKind,
  OcrThresholdFitOptions,
  OcrThresholdProfile,
  OcrVersionChain,
  OpsBackup,
  OpsIntegrity,
  OpsSettings,
  OpsStatus,
  PermissionSimulationResult,
  PortfolioConfig,
  PortfolioFactor,
  PortfolioScore,
  Preferences,
  Profile,
  Project,
  ProjectBatchAction,
  ProjectBatchResult,
  ProjectDetail,
  ProjectDocument,
  ProjectDueFilter,
  ProjectListResult,
  ProjectScaffoldResult,
  ProjectTasks,
  ProjectViewQuery,
  ProjectVisibility,
  PushStatus,
  RecurrenceRule,
  RecurrenceRunResult,
  ReportFrequency,
  ReportKind,
  Role,
  SavedReport,
  SavedReportQuery,
  SavedView,
  SearchResults,
  SessionInfo,
  SessionUser,
  Task,
  TaskBlocker,
  TaskDependency,
  TaskPriority,
  TaskStatus,
  TimeLog,
  TimeSummary,
  TokenCreateResult,
  TokenList,
  TokenScope,
  User,
  UserListResult,
  UserOption,
  UserStatus,
  Webhook,
  WebhookCreateResult,
  WebhookDelivery,
  WebhookEvent,
  WorkflowRunResult,
  WorkspaceSettings,
  WorkspaceSummary,
} from '../../shared/types.ts';
import {
  clearSnapshots,
  notifySnapshotFallback,
  primeSessionSnapshot,
  readSnapshot,
  writeSnapshot,
} from './offline.ts';

type ErrorPayload = {
  error?: string;
  message?: string;
  current?: unknown;
};

function fallbackMessage(status: number): string {
  if (status === 403) return '没有权限执行此操作';
  if (status === 429) return '操作过于频繁，请稍后重试';
  return `请求失败（${status}）`;
}

export class ApiError extends Error {
  status: number;
  payload: ErrorPayload | null;
  current?: Project;

  constructor(status: number, payload: ErrorPayload | null) {
    super(payload?.message ?? fallbackMessage(status));
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
    if (payload?.current && typeof payload.current === 'object') {
      this.current = payload.current as Project;
    }
  }
}

const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_DELAYS_MS = [250, 750];
const RETRYABLE_STATUS = new Set([502, 503, 504]);

export type RequestOptions = { signal?: AbortSignal };

export type OcrOptimizationInput = {
  title: string;
  targetError: string;
  expectedGain: number;
  implementationCost: number;
  inferenceCost: number;
  risk: OcrOptimizationRisk;
  benchmarkResult?: string;
  productionResult?: string;
  status?: OcrOptimizationStatus;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request<T>(
  url: string,
  init: RequestInit = {},
  options: RequestOptions = {},
): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const retries = method === 'GET' && !init.body ? RETRY_DELAYS_MS.length : 0;
  const callerSignal = options.signal ?? (init.signal as AbortSignal | undefined);
  if (method !== 'GET' && typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new ApiError(0, { message: '当前离线，仅可查看缓存数据' });
  }

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    const forwardAbort = () => controller.abort();
    if (callerSignal) {
      if (callerSignal.aborted) {
        clearTimeout(timer);
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      callerSignal.addEventListener('abort', forwardAbort, { once: true });
    }

    try {
      const res = await fetch(url, {
        credentials: 'same-origin',
        ...init,
        signal: controller.signal,
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as ErrorPayload | null;
        if (res.status === 401 && !url.startsWith('/api/auth/login')) {
          window.dispatchEvent(new Event('auth:expired'));
        }
        const error = new ApiError(res.status, payload);
        if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
          await sleep(RETRY_DELAYS_MS[attempt]!);
          continue;
        }
        throw error;
      }
      if (res.status === 204) return undefined as T;
      const data = (await res.json()) as T;
      if (method === 'GET') {
        if (url === '/api/auth/me') primeSessionSnapshot(data);
        writeSnapshot(url, data);
      } else if (url === '/api/auth/login' || url === '/api/auth/mfa') {
        primeSessionSnapshot(data);
      }
      return data;
    } catch (cause) {
      if (cause instanceof ApiError) throw cause;
      if (callerSignal?.aborted) throw cause;
      if (timedOut) {
        throw new ApiError(0, { message: '请求超时，请稍后重试' });
      }
      if (attempt < retries) {
        await sleep(RETRY_DELAYS_MS[attempt]!);
        continue;
      }
      if (method === 'GET') {
        const cached = readSnapshot<T>(url);
        if (cached !== null) {
          notifySnapshotFallback();
          return cached;
        }
      }
      throw new ApiError(0, { message: '网络异常，请检查连接后重试' });
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', forwardAbort);
    }
  }
}

function json(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function toQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === 'all') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

export type WorkbenchRecord = DomainRecord;
export type WorkbenchList = DomainList;

export type LineageStatus = {
  complete: boolean;
  missing: string[];
  incompleteSources: string[];
};

export type MetricImpact = {
  metric: { id: string; name: string };
  lineage: LineageStatus;
  upstream: { source_type: string; source_id: string; relation: string; sensitive: number }[];
  catalog: Record<string, string[]>;
  trimmed: boolean;
  downstream: {
    id: string;
    name: string;
    unit: string;
    depth: number;
    lineage: LineageStatus;
  }[];
  affected: {
    charts: { id: string; name: string; visualization: string }[];
    reports: { id: string; name: string; visualization: string }[];
    automationRules: { id: string; name: string }[];
    subscriptions: { id: string; reportId: string; reportKind: string }[];
  };
};

export type ScenarioEvaluation = {
  scenario: WorkbenchRecord;
  result: {
    baseDate: string;
    sampleDays: number;
    baseline: { revenueCents: number; conversionRate: number };
    projected: {
      revenueCents: number;
      conversionRate: number;
      costCents: number;
      marginCents: number;
    };
    delta: { revenueCents: number; revenuePct: number };
    assumptions: Record<string, number>;
  };
};

export type QueryReportRun = {
  reportId: string;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  trimmed?: boolean;
};

export type QueryPreviewResult = QueryReportRun;

export type BudgetAlert = {
  level: 'warn' | 'critical';
  scope: 'budget' | 'category';
  id?: string;
  name: string;
  usagePct: number;
  thresholdPct?: number;
  overCents: number;
};

export type BudgetAlertReport = {
  budget: {
    id: string;
    currency: CurrencyCode;
    budgetCents: number;
    actualCents: number;
    forecastCents: number;
    usagePct: number;
    thresholdPct: number;
  } | null;
  categories: WorkbenchRecord[];
  alerts: BudgetAlert[];
};

export type ConnectorHealth = {
  id: string;
  health: 'ok' | 'degraded' | 'down';
  checkedAt: string;
};

export type RangeQuery = {
  range: DateRangeKey;
  from?: string;
  to?: string;
};

export type ProjectQuery = {
  q?: string;
  status?: string;
  owner?: string;
  sort?: string;
  tag?: string;
  due?: ProjectDueFilter | 'all';
  favorite?: boolean;
  page?: number;
  pageSize?: number;
};

export type ProjectInput = {
  name: string;
  description?: string;
  status?: string;
  progress?: number;
  ownerId?: string;
  startDate?: string | null;
  dueDate?: string | null;
  tags?: string[];
  memberIds?: string[];
  visibility?: ProjectVisibility;
};

export type ProjectUpdateInput = ProjectInput & { version: number };
export type ProjectPatchInput = Partial<ProjectInput> & { version: number };

export type TemplateApplyInput = {
  templateId: string;
  name?: string;
  description?: string;
  ownerId?: string;
  startDate?: string;
  memberIds?: string[];
};

export type DuplicateProjectInput = {
  name?: string;
  dateOffsetDays?: number;
  includeMembers?: boolean;
  includeTasks?: boolean;
};

export type TaskInput = {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assigneeId?: string | null;
  dueDate?: string | null;
  parentId?: string;
  milestoneId?: string | null;
  sortOrder?: number;
};

export type TaskPatchInput = Partial<TaskInput> & { version: number };

export type MilestoneInput = { title: string; dueDate?: string | null };

export type CommentInput = { body: string; taskId?: string | null; mentions?: string[] };

export type ActivityQuery = {
  cursor?: number;
  limit?: number;
  projectId?: string;
  type?: string;
};

export type AuditQuery = {
  q?: string;
  action?: string;
  actor?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
};

export type UserQuery = {
  q?: string;
  role?: string;
  status?: string;
  page?: number;
  pageSize?: number;
};

export type UserInput = {
  email: string;
  name: string;
  role: Role;
  password: string;
  timezone?: string;
  workspaceId?: string;
  customRoleId?: string | null;
};

export type UserPatch = {
  name?: string;
  role?: Role;
  status?: UserStatus;
  timezone?: string;
  customRoleId?: string | null;
  version?: number;
};

export type CustomRoleInput = {
  name: string;
  baseRole: Role;
  permissions: Permission[];
};

export type SessionState = {
  user: SessionUser;
  preferences: Preferences;
  demo: boolean;
  workspace: WorkspaceSettings;
  workspaceInfo?: WorkspaceSummary;
  features?: FeatureFlags;
};
export type LoginState = SessionState | { mfaRequired: true; ticket: string; expiresIn: number };

/** Subset of the stage replay response the lab UI renders. */
export type OcrLabReplayResult = {
  kind: OcrStageKind;
  mode: OcrMode;
  dpi: number | null;
  engine: OcrEngine;
  inputMatches: boolean | null;
  recordedOutputSha256: string | null;
  outputSha256: string | null;
  outputMatches: boolean | null;
  scoreBefore: number | null;
  scoreAfter: number | null;
  scoreDelta: number | null;
  candidate: {
    text: string;
    confidence: number | null;
    engine: string;
    model: string | null;
    seconds: number;
  } | null;
};

export const api = {
  me(): Promise<SessionState> {
    return request('/api/auth/me');
  },
  login(email: string, password: string): Promise<LoginState> {
    return request('/api/auth/login', json('POST', { email, password }));
  },
  mfaLogin(ticket: string, code: string): Promise<SessionState> {
    return request('/api/auth/mfa', json('POST', { ticket, code }));
  },
  requestPasswordReset(
    email: string,
  ): Promise<{ ok: true; expiresIn: number; resetToken?: string }> {
    return request('/api/auth/password-reset/request', json('POST', { email }));
  },
  confirmPasswordReset(token: string, password: string): Promise<{ ok: true }> {
    return request('/api/auth/password-reset/confirm', json('POST', { token, password }));
  },
  async logout(): Promise<void> {
    try {
      await request('/api/auth/logout', { method: 'POST' });
    } finally {
      clearSnapshots();
    }
  },
  demoUsers(): Promise<{
    password: string;
    users: { email: string; name: string; role: Role }[];
  }> {
    return request('/api/auth/demo-users');
  },

  summary(params: RangeQuery, signal?: AbortSignal): Promise<DashboardSummary> {
    return request(`/api/dashboard/summary${toQuery(params)}`, {}, { signal });
  },
  revenue(
    params: RangeQuery & { granularity?: string; compare?: boolean },
    signal?: AbortSignal,
  ): Promise<import('../../shared/types.ts').RevenueReport> {
    return request(
      `/api/analytics/revenue${toQuery({ ...params, compare: params.compare === false ? '0' : undefined })}`,
      {},
      { signal },
    );
  },
  channels(params: RangeQuery, signal?: AbortSignal): Promise<ChannelReport> {
    return request(`/api/analytics/channels${toQuery(params)}`, {}, { signal });
  },
  audience(params: RangeQuery, signal?: AbortSignal): Promise<AudienceReport> {
    return request(`/api/analytics/audience${toQuery(params)}`, {}, { signal });
  },
  projectAnalytics(signal?: AbortSignal): Promise<{
    overview: import('../../shared/types.ts').ProjectOverview;
    counts: import('../../shared/types.ts').ProjectStatusCounts;
  }> {
    return request('/api/analytics/projects', {}, { signal });
  },
  workspace(signal?: AbortSignal): Promise<{ workspace: WorkspaceSettings }> {
    return request('/api/workspace', {}, { signal });
  },
  updateWorkspace(input: {
    currency?: CurrencyCode;
    rate?: number;
    timeLogVisibility?: 'all' | 'managers' | 'self';
  }): Promise<{
    workspace: WorkspaceSettings;
  }> {
    return request('/api/workspace', json('PATCH', input));
  },
  analyticsSources(signal?: AbortSignal): Promise<{
    sources: AnalyticsSourceSummary[];
    currency: CurrencyCode;
    demo: boolean;
  }> {
    return request('/api/analytics/sources', {}, { signal });
  },
  analyticsMetrics(
    from: string,
    to: string,
    signal?: AbortSignal,
  ): Promise<{ records: MetricDay[]; currency: CurrencyCode }> {
    return request(`/api/analytics/metrics${toQuery({ from, to })}`, {}, { signal });
  },
  importMetrics(file: File): Promise<MetricImportResult> {
    const form = new FormData();
    form.append('file', file);
    return request('/api/analytics/import', { method: 'POST', body: form });
  },
  analyticsExportUrl(
    query: { kind?: ReportKind } & RangeQuery & { granularity?: string; compare?: boolean },
  ): string {
    return `/api/analytics/export.csv${toQuery({
      ...query,
      compare: query.compare === false ? '0' : undefined,
    })}`;
  },
  savedReports(signal?: AbortSignal): Promise<{ reports: SavedReport[] }> {
    return request('/api/analytics/reports', {}, { signal });
  },
  createSavedReport(input: {
    name: string;
    query: SavedReportQuery;
    frequency: ReportFrequency;
  }): Promise<{ report: SavedReport }> {
    return request('/api/analytics/reports', json('POST', input));
  },
  updateSavedReport(
    id: string,
    patch: { name?: string; query?: SavedReportQuery; frequency?: ReportFrequency },
  ): Promise<{ report: SavedReport }> {
    return request(`/api/analytics/reports/${encodeURIComponent(id)}`, json('PATCH', patch));
  },
  deleteSavedReport(id: string): Promise<void> {
    return request(`/api/analytics/reports/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  reportExportUrl(id: string): string {
    return `/api/analytics/reports/${encodeURIComponent(id)}/export.csv`;
  },

  projects(query: ProjectQuery = {}, signal?: AbortSignal): Promise<ProjectListResult> {
    return request(
      `/api/projects${toQuery({ ...query, favorite: query.favorite ? '1' : undefined })}`,
      {},
      { signal },
    );
  },
  project(id: string, signal?: AbortSignal): Promise<ProjectDetail> {
    return request(`/api/projects/${encodeURIComponent(id)}`, {}, { signal });
  },
  createProject(input: ProjectInput): Promise<ProjectDetail> {
    return request('/api/projects', json('POST', input));
  },
  updateProject(id: string, input: ProjectPatchInput): Promise<ProjectDetail> {
    return request(`/api/projects/${encodeURIComponent(id)}`, json('PATCH', input));
  },
  projectTemplates(signal?: AbortSignal): Promise<{ templates: ProjectTemplate[] }> {
    return request('/api/project-templates', {}, { signal });
  },
  createProjectFromTemplate(input: TemplateApplyInput): Promise<ProjectScaffoldResult> {
    return request('/api/projects/from-template', json('POST', input));
  },
  duplicateProject(id: string, input: DuplicateProjectInput): Promise<ProjectScaffoldResult> {
    return request(`/api/projects/${encodeURIComponent(id)}/duplicate`, json('POST', input));
  },
  deleteProject(id: string): Promise<void> {
    return request(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  trashProjects(): Promise<{ projects: Project[] }> {
    return request('/api/projects/trash');
  },
  restoreProject(id: string): Promise<ProjectDetail> {
    return request(`/api/projects/${encodeURIComponent(id)}/restore`, { method: 'POST' });
  },
  purgeProject(id: string): Promise<void> {
    return request(`/api/projects/${encodeURIComponent(id)}/purge`, { method: 'DELETE' });
  },
  batchProjects(input: {
    ids: string[];
    action: ProjectBatchAction;
    status?: string;
    ownerId?: string;
  }): Promise<ProjectBatchResult> {
    return request('/api/projects/batch', json('POST', input));
  },
  favoriteProject(id: string): Promise<{ favorite: boolean }> {
    return request(`/api/projects/${encodeURIComponent(id)}/favorite`, { method: 'POST' });
  },
  unfavoriteProject(id: string): Promise<{ favorite: boolean }> {
    return request(`/api/projects/${encodeURIComponent(id)}/favorite`, { method: 'DELETE' });
  },
  savedViews(signal?: AbortSignal): Promise<{ views: SavedView[] }> {
    return request('/api/saved-views', {}, { signal });
  },
  createSavedView(input: { name: string; query: ProjectViewQuery }): Promise<SavedView> {
    return request('/api/saved-views', json('POST', input));
  },
  updateSavedView(
    id: string,
    patch: { name?: string; query?: ProjectViewQuery },
  ): Promise<SavedView> {
    return request(`/api/saved-views/${encodeURIComponent(id)}`, json('PATCH', patch));
  },
  deleteSavedView(id: string): Promise<void> {
    return request(`/api/saved-views/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  importProjects(file: File, preview = false): Promise<ImportResult> {
    const form = new FormData();
    form.append('file', file);
    return request(`/api/projects/import${preview ? '?preview=1' : ''}`, {
      method: 'POST',
      body: form,
    });
  },
  exportProjectsUrl(
    filters: {
      q?: string;
      status?: string;
      owner?: string;
      tag?: string;
      due?: ProjectDueFilter | 'all';
      favorite?: boolean;
      ids?: string[];
    } = {},
  ): string {
    const params = new URLSearchParams();
    if (filters.q) params.set('q', filters.q);
    if (filters.status && filters.status !== 'all') params.set('status', filters.status);
    if (filters.owner && filters.owner !== 'all') params.set('owner', filters.owner);
    if (filters.tag) params.set('tag', filters.tag);
    if (filters.due && filters.due !== 'all') params.set('due', filters.due);
    if (filters.favorite) params.set('favorite', '1');
    if (filters.ids && filters.ids.length > 0) params.set('ids', filters.ids.join(','));
    const query = params.toString();
    return `/api/projects/export.csv${query ? `?${query}` : ''}`;
  },

  activities(query: ActivityQuery = {}, signal?: AbortSignal): Promise<ActivityPage> {
    return request(`/api/activities${toQuery(query)}`, {}, { signal });
  },
  projectTasks(id: string, signal?: AbortSignal): Promise<ProjectTasks> {
    return request(`/api/projects/${encodeURIComponent(id)}/tasks`, {}, { signal });
  },
  createTask(projectId: string, input: TaskInput): Promise<Task> {
    return request(`/api/projects/${encodeURIComponent(projectId)}/tasks`, json('POST', input));
  },
  updateTask(id: string, input: TaskPatchInput): Promise<Task> {
    return request(`/api/tasks/${encodeURIComponent(id)}`, json('PATCH', input));
  },
  deleteTask(id: string): Promise<void> {
    return request(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  createMilestone(projectId: string, input: MilestoneInput) {
    return request<import('../../shared/types.ts').Milestone>(
      `/api/projects/${encodeURIComponent(projectId)}/milestones`,
      json('POST', input),
    );
  },
  deleteMilestone(id: string): Promise<void> {
    return request(`/api/milestones/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  attachments(projectId: string, signal?: AbortSignal): Promise<AttachmentList> {
    return request(`/api/projects/${encodeURIComponent(projectId)}/attachments`, {}, { signal });
  },
  uploadAttachment(projectId: string, file: File): Promise<{ attachment: Attachment }> {
    const form = new FormData();
    form.append('file', file);
    return request(`/api/projects/${encodeURIComponent(projectId)}/attachments`, {
      method: 'POST',
      body: form,
    });
  },
  deleteAttachment(projectId: string, attachmentId: string): Promise<void> {
    return request(
      `/api/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { method: 'DELETE' },
    );
  },
  attachmentOcr(projectId: string, attachmentId: string): Promise<{ ocr: AttachmentOcr }> {
    return request(
      `/api/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(attachmentId)}/ocr`,
    );
  },
  exportAttachmentOcr(projectId: string, attachmentId: string): Promise<OcrExport> {
    return request(
      `/api/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(attachmentId)}/ocr/export`,
    );
  },
  retryAttachmentOcr(
    projectId: string,
    attachmentId: string,
    options: { mode?: OcrMode; dpi?: number } = {},
  ): Promise<{ ocr: AttachmentOcr }> {
    return request(
      `/api/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(attachmentId)}/ocr`,
      json('POST', options),
    );
  },
  attachmentOcrFields(projectId: string, attachmentId: string): Promise<OcrFieldList> {
    return request(
      `/api/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(attachmentId)}/ocr/fields`,
    );
  },
  reviseAttachmentOcrField(
    projectId: string,
    attachmentId: string,
    fieldId: string,
    input: { revisedText: string; reason: string },
  ): Promise<{ revision: OcrFieldRevision }> {
    return request(
      `/api/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(attachmentId)}/ocr/fields/${encodeURIComponent(fieldId)}/revisions`,
      json('POST', input),
    );
  },
  attachmentOcrVersions(
    projectId: string,
    attachmentId: string,
  ): Promise<{ chain: OcrVersionChain }> {
    return request(
      `/api/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(attachmentId)}/ocr/versions`,
    );
  },
  complainAttachmentOcr(
    projectId: string,
    attachmentId: string,
    note: string,
  ): Promise<{ sample: OcrFeedbackSample | null }> {
    return request(
      `/api/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(attachmentId)}/ocr/complaints`,
      json('POST', { note }),
    );
  },
  ocrFeedback(
    query: { status?: OcrFeedbackStatus; errorType?: OcrFeedbackErrorType; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<{ pool: OcrFeedbackPool; samples: OcrFeedbackSample[]; matched: number }> {
    return request(`/api/ocr/feedback${toQuery(query)}`, {}, { signal });
  },
  syncOcrFeedback(days?: number): Promise<{
    scanned: number;
    inserted: number;
    pool: OcrFeedbackPool;
  }> {
    return request('/api/ocr/feedback/sync', json('POST', days === undefined ? {} : { days }));
  },
  sampleOcrFeedback(input: {
    perStratum?: number;
    total?: number;
    budget?: number;
  }): Promise<OcrFeedbackSelection> {
    return request('/api/ocr/feedback/sample', json('POST', input));
  },
  ocrKnowledge(input: { projectId?: string; limit?: number } = {}): Promise<{
    graph: OcrKnowledgeGraph;
  }> {
    const params = new URLSearchParams();
    if (input.projectId) params.set('projectId', input.projectId);
    if (input.limit !== undefined) params.set('limit', String(input.limit));
    const query = params.toString();
    return request(`/api/ocr/knowledge${query ? `?${query}` : ''}`);
  },
  ocrRegistry(signal?: AbortSignal): Promise<OcrRegistryState> {
    return request('/api/ocr/registry', {}, { signal });
  },
  ocrRecoveryYields(
    signal?: AbortSignal,
  ): Promise<{ yields: OcrRecoveryYield[]; minSamples: number }> {
    return request('/api/ocr/recovery-yields', {}, { signal });
  },
  registerOcrRegistry(input: {
    engine: OcrEngine;
    modelId: string;
    pipeline?: string;
    role?: OcrRegistryRole;
    mode?: OcrGreyMode;
    percent?: number;
    auto?: boolean;
    note?: string;
  }): Promise<OcrRegistryState> {
    return request('/api/ocr/registry/register', json('POST', input));
  },
  decideOcrRegistry(input: {
    id?: string;
    engine?: OcrEngine;
    modelId?: string;
    pipeline?: string;
    action: Exclude<OcrRegistryDecision['action'], 'register'>;
    percent?: number;
    mode?: OcrGreyMode;
    pin?: boolean;
    note?: string;
    policy?: Partial<OcrRegistryPolicy>;
  }): Promise<OcrRegistryState & { decision: OcrRegistryDecision }> {
    return request('/api/ocr/registry/decision', json('POST', input));
  },
  evaluateOcrRegistry(
    input: { syncExperiment?: boolean; policy?: Partial<OcrRegistryPolicy> } = {},
  ): Promise<OcrRegistryState & { evaluation: OcrRegistryEvaluation }> {
    return request('/api/ocr/registry/evaluate', json('POST', input));
  },
  markOcrFeedback(
    id: string,
    input: { status: Exclude<OcrFeedbackStatus, 'sampled'>; note?: string },
  ): Promise<{ sample: OcrFeedbackSample }> {
    return request(`/api/ocr/feedback/${encodeURIComponent(id)}/status`, json('POST', input));
  },
  ocrDashboard(
    days = 30,
    signal?: AbortSignal,
  ): Promise<{ dashboard: OcrProductionDashboard; alerts: OcrDriftAlertRecord[] }> {
    return request(`/api/ocr/quality/dashboard${toQuery({ days })}`, {}, { signal });
  },
  ocrDrift(
    days = 30,
    signal?: AbortSignal,
  ): Promise<{ drift: OcrDriftReport; alerts: OcrDriftAlertRecord[] }> {
    return request(`/api/ocr/drift${toQuery({ days })}`, {}, { signal });
  },
  saveOcrDriftBaseline(
    days?: number,
  ): Promise<{ baseline: { samples: number; createdAt: string } }> {
    return request('/api/ocr/drift/baseline', json('POST', days === undefined ? {} : { days }));
  },
  checkOcrDrift(days?: number): Promise<{
    drift: OcrDriftReport;
    inserted: number;
    alerts: OcrDriftAlertRecord[];
  }> {
    return request('/api/ocr/drift/check', json('POST', days === undefined ? {} : { days }));
  },
  ocrOptimizations(signal?: AbortSignal): Promise<{ entries: OcrOptimizationEntry[] }> {
    return request('/api/ocr/optimizations', {}, { signal });
  },
  createOcrOptimization(input: OcrOptimizationInput): Promise<{ entry: OcrOptimizationEntry }> {
    return request('/api/ocr/optimizations', json('POST', input));
  },
  updateOcrOptimization(
    id: string,
    patch: Partial<OcrOptimizationInput>,
  ): Promise<{ entry: OcrOptimizationEntry }> {
    return request(`/api/ocr/optimizations/${encodeURIComponent(id)}`, json('PATCH', patch));
  },
  ocrLab(signal?: AbortSignal): Promise<OcrBenchStatus> {
    return request('/api/ocr/lab', {}, { signal });
  },
  runOcrLab(includePdf: boolean): Promise<OcrBenchStatus> {
    return request('/api/ocr/lab/run', json('POST', { includePdf }));
  },
  replayOcrLab(input: {
    name: string;
    kind: OcrStageKind;
    occurrence?: number;
    page?: number;
    bbox?: { x: number; y: number; width: number; height: number };
    padding?: number;
  }): Promise<OcrLabReplayResult> {
    return request('/api/ocr/lab/replay', json('POST', input));
  },
  ocrExperiment(signal?: AbortSignal): Promise<OcrExperimentResult | null> {
    return request('/api/ocr/lab/experiment', {}, { signal });
  },
  startOcrExperiment(input: OcrExperimentRequest): Promise<OcrExperimentResult> {
    return request('/api/ocr/lab/experiment', json('POST', input));
  },
  ocrCalibration(signal?: AbortSignal): Promise<{ profiles: OcrThresholdProfile[] }> {
    return request('/api/ocr/calibration', {}, { signal });
  },
  fitOcrCalibration(
    input: { options?: OcrThresholdFitOptions } = {},
  ): Promise<{ profiles: OcrThresholdProfile[] }> {
    return request('/api/ocr/calibration/fit', json('POST', input));
  },
  ocrPassAudits(
    query: { status?: 'all' | 'pending' | 'audited'; period?: string } = {},
    signal?: AbortSignal,
  ): Promise<{ audits: OcrPassAudit[]; stats: OcrPassAuditStats; period: string }> {
    return request(`/api/ocr/pass-audits${toQuery(query)}`, {}, { signal });
  },
  sampleOcrPassAudits(input: { fraction?: number; perType?: number; period?: string }): Promise<{
    period: string;
    created: OcrPassAudit[];
    strata: { docType: string; population: number; picked: number }[];
    stats: OcrPassAuditStats;
  }> {
    return request('/api/ocr/pass-audits/sample', json('POST', input));
  },
  markOcrPassAudit(
    id: string,
    input: { verdict: OcrPassAuditVerdict; note?: string },
  ): Promise<{ audit: OcrPassAudit; stats: OcrPassAuditStats }> {
    return request(`/api/ocr/pass-audits/${encodeURIComponent(id)}/verdict`, json('POST', input));
  },
  ocrRevisionQc(
    query: { projectId?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<{ items: OcrRevisionQcItem[]; stats: OcrRevisionQcStats }> {
    return request(`/api/ocr/revision-qc${toQuery(query)}`, {}, { signal });
  },
  reviewOcrRevision(
    id: string,
    input: { verdict: OcrRevisionReviewVerdict; value?: string; note?: string },
  ): Promise<{ item: OcrRevisionQcItem; stats: OcrRevisionQcStats }> {
    return request(`/api/ocr/revision-qc/${encodeURIComponent(id)}/review`, json('POST', input));
  },
  uploadAvatar(file: File): Promise<{ avatarUrl: string }> {
    const form = new FormData();
    form.append('file', file);
    return request('/api/profile/avatar', { method: 'POST', body: form });
  },
  removeAvatar(): Promise<void> {
    return request('/api/profile/avatar', { method: 'DELETE' });
  },
  comments(projectId: string, taskId?: string, signal?: AbortSignal): Promise<CommentList> {
    return request(
      `/api/projects/${encodeURIComponent(projectId)}/comments${toQuery({ taskId })}`,
      {},
      { signal },
    );
  },
  createComment(projectId: string, input: CommentInput): Promise<Comment> {
    return request(`/api/projects/${encodeURIComponent(projectId)}/comments`, json('POST', input));
  },
  deleteComment(id: string): Promise<void> {
    return request(`/api/comments/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  notifications(limit = 20, signal?: AbortSignal): Promise<NotificationList> {
    return request(`/api/notifications${toQuery({ limit })}`, {}, { signal });
  },
  markNotificationsRead(input: { ids?: string[]; all?: boolean }): Promise<{ unread: number }> {
    return request('/api/notifications/read', json('POST', input));
  },
  audit(query: AuditQuery = {}, signal?: AbortSignal): Promise<AuditPage> {
    return request(`/api/audit${toQuery(query)}`, {}, { signal });
  },
  auditExportUrl(query: AuditQuery = {}): string {
    return `/api/audit/export.csv${toQuery(query)}`;
  },
  cleanupAudit(days?: number): Promise<AuditCleanupResult> {
    return request('/api/audit/cleanup', json('POST', days === undefined ? {} : { days }));
  },
  search(q: string, signal?: AbortSignal): Promise<SearchResults> {
    return request(`/api/search${toQuery({ q })}`, {}, { signal });
  },

  users(query: UserQuery = {}, signal?: AbortSignal): Promise<UserListResult> {
    return request(`/api/users${toQuery(query)}`, {}, { signal });
  },
  userOptions(signal?: AbortSignal): Promise<{ users: UserOption[] }> {
    return request('/api/users/options', {}, { signal });
  },
  createUser(input: UserInput): Promise<User> {
    return request('/api/users', json('POST', input));
  },
  updateUser(id: string, patch: UserPatch): Promise<User> {
    return request(`/api/users/${encodeURIComponent(id)}`, json('PATCH', patch));
  },
  resetUserPassword(id: string): Promise<{ temporaryPassword: string; user: User }> {
    return request(`/api/users/${encodeURIComponent(id)}/reset-password`, { method: 'POST' });
  },
  workspaces(signal?: AbortSignal): Promise<{ workspaces: WorkspaceSummary[] }> {
    return request('/api/workspaces', {}, { signal });
  },
  createWorkspace(name: string): Promise<{ workspace: WorkspaceSummary }> {
    return request('/api/workspaces', json('POST', { name }));
  },
  renameWorkspace(id: string, name: string): Promise<{ workspace: WorkspaceSummary }> {
    return request(`/api/workspaces/${encodeURIComponent(id)}`, json('PATCH', { name }));
  },
  customRoles(signal?: AbortSignal): Promise<{ roles: CustomRole[] }> {
    return request('/api/custom-roles', {}, { signal });
  },
  createCustomRole(input: CustomRoleInput): Promise<{ role: CustomRole }> {
    return request('/api/custom-roles', json('POST', input));
  },
  updateCustomRole(id: string, patch: Partial<CustomRoleInput>): Promise<{ role: CustomRole }> {
    return request(`/api/custom-roles/${encodeURIComponent(id)}`, json('PATCH', patch));
  },
  deleteCustomRole(id: string): Promise<void> {
    return request(`/api/custom-roles/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  ops(signal?: AbortSignal): Promise<{ status: OpsStatus }> {
    return request('/api/ops', {}, { signal });
  },
  opsIntegrity(): Promise<{ integrity: OpsIntegrity }> {
    return request('/api/ops/integrity');
  },
  createBackup(): Promise<{ backup: OpsBackup }> {
    return request('/api/ops/backups', { method: 'POST' });
  },
  stageRestore(file: string): Promise<{
    ok: true;
    restartRequired: boolean;
    file: string;
    message: string;
  }> {
    return request('/api/ops/restore', json('POST', { file }));
  },
  updateOpsSettings(
    patch: Partial<Omit<OpsSettings, 'updatedAt'>>,
  ): Promise<{ settings: OpsSettings }> {
    return request('/api/ops/settings', json('PATCH', patch));
  },
  setFeature(key: FeatureFlagKey, enabled: boolean): Promise<{ flag: FeatureFlag }> {
    return request(`/api/ops/features/${encodeURIComponent(key)}`, json('PATCH', { enabled }));
  },
  toggleDemoData(enabled: boolean): Promise<{
    enabled: boolean;
    removed: number;
    demo: { projects: number; users: number };
  }> {
    return request('/api/ops/demo-data', json('POST', { enabled }));
  },
  exportUserUrl(id: string): string {
    return `/api/ops/users/${encodeURIComponent(id)}/export`;
  },
  eraseUser(id: string): Promise<{ ok: true; id: string }> {
    return request(`/api/ops/users/${encodeURIComponent(id)}/erase`, { method: 'POST' });
  },

  profile(signal?: AbortSignal): Promise<Profile> {
    return request('/api/profile', {}, { signal });
  },
  pushStatus(signal?: AbortSignal): Promise<PushStatus> {
    return request('/api/push', {}, { signal });
  },
  subscribePush(input: {
    endpoint: string;
    p256dh: string;
    auth: string;
  }): Promise<{ id: string }> {
    return request(
      '/api/push/subscribe',
      json('POST', { endpoint: input.endpoint, keys: { p256dh: input.p256dh, auth: input.auth } }),
    );
  },
  unsubscribePush(endpoint: string): Promise<void> {
    return request('/api/push/subscribe', json('DELETE', { endpoint }));
  },
  updateProfile(input: { name: string; timezone: string; version?: number }): Promise<Profile> {
    return request('/api/profile', json('PATCH', input));
  },
  changeEmail(input: { email: string; password: string }): Promise<{ ok: true; email: string }> {
    return request('/api/profile/email', json('POST', input));
  },
  deleteAccount(input: { password: string; confirmEmail: string }): Promise<{ ok: true }> {
    return request('/api/profile/delete', json('POST', input));
  },
  changePassword(input: { currentPassword: string; newPassword: string }): Promise<{ ok: true }> {
    return request('/api/profile/password', json('POST', input));
  },
  mfaStatus(signal?: AbortSignal): Promise<{ enabled: boolean }> {
    return request('/api/profile/mfa', {}, { signal });
  },
  setupMfa(): Promise<{ secret: string; otpauth: string; recoveryCodes: string[] }> {
    return request('/api/profile/mfa/setup', { method: 'POST' });
  },
  enableMfa(code: string): Promise<{ ok: true }> {
    return request('/api/profile/mfa/enable', json('POST', { code }));
  },
  disableMfa(password: string): Promise<{ ok: true }> {
    return request('/api/profile/mfa/disable', json('POST', { password }));
  },
  sessions(signal?: AbortSignal): Promise<{ sessions: SessionInfo[] }> {
    return request('/api/sessions', {}, { signal });
  },
  revokeSession(id: string): Promise<void> {
    return request(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  revokeOtherSessions(): Promise<{ revoked: number }> {
    return request('/api/sessions/revoke-others', { method: 'POST' });
  },
  tokens(signal?: AbortSignal): Promise<TokenList> {
    return request('/api/profile/tokens', {}, { signal });
  },
  createToken(input: {
    name: string;
    scopes: TokenScope[];
    expiresInDays: number | null;
  }): Promise<TokenCreateResult> {
    return request('/api/profile/tokens', json('POST', input));
  },
  revokeToken(id: string): Promise<void> {
    return request(`/api/profile/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  webhooks(signal?: AbortSignal): Promise<{ webhooks: Webhook[]; events: WebhookEvent[] }> {
    return request('/api/profile/webhooks', {}, { signal });
  },
  createWebhook(input: { url: string; events: WebhookEvent[] }): Promise<WebhookCreateResult> {
    return request('/api/profile/webhooks', json('POST', input));
  },
  updateWebhook(
    id: string,
    patch: { url?: string; events?: WebhookEvent[]; active?: boolean },
  ): Promise<Webhook> {
    return request(`/api/profile/webhooks/${encodeURIComponent(id)}`, json('PATCH', patch));
  },
  deleteWebhook(id: string): Promise<void> {
    return request(`/api/profile/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  webhookDeliveries(id: string, signal?: AbortSignal): Promise<{ deliveries: WebhookDelivery[] }> {
    return request(`/api/profile/webhooks/${encodeURIComponent(id)}/deliveries`, {}, { signal });
  },
  preferences(signal?: AbortSignal): Promise<Preferences> {
    return request('/api/preferences', {}, { signal });
  },
  updatePreferences(patch: Partial<Preferences>): Promise<Preferences> {
    return request('/api/preferences', json('PATCH', patch));
  },

  goals(
    query: { projectId?: string; level?: GoalLevel; includeArchived?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<GoalTree> {
    return request(
      `/api/goals${toQuery({ ...query, includeArchived: query.includeArchived ? '1' : undefined })}`,
      {},
      { signal },
    );
  },
  goal(id: string, signal?: AbortSignal): Promise<Goal> {
    return request(`/api/goals/${encodeURIComponent(id)}`, {}, { signal });
  },
  createGoal(input: {
    title: string;
    level?: GoalLevel;
    parentId?: string | null;
    projectId?: string | null;
    description?: string;
    ownerId?: string | null;
    weight?: number;
    period?: string;
    baseline?: number | null;
    target?: number | null;
    actual?: number | null;
    unit?: string;
    updateMode?: GoalUpdateMode;
  }): Promise<Goal> {
    return request('/api/goals', json('POST', input));
  },
  updateGoal(
    id: string,
    input: {
      version: number;
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
      status?: Goal['status'];
      reason?: string;
    },
  ): Promise<Goal> {
    return request(`/api/goals/${encodeURIComponent(id)}`, json('PATCH', input));
  },
  deleteGoal(id: string): Promise<void> {
    return request(`/api/goals/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  goalImpact(
    id: string,
    input: {
      actual?: number | null;
      target?: number | null;
      status?: Goal['status'];
      reason?: string;
    },
  ): Promise<GoalImpact> {
    return request(`/api/goals/${encodeURIComponent(id)}/impact`, json('POST', input));
  },
  goalChanges(id: string, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    return request(`/api/goals/${encodeURIComponent(id)}/changes`, {}, { signal });
  },
  addKeyResult(
    goalId: string,
    input: {
      title: string;
      unit?: string;
      baseline?: number | null;
      target?: number | null;
      actual?: number | null;
      weight?: number;
      updateMode?: GoalUpdateMode;
    },
  ): Promise<KeyResult> {
    return request(`/api/goals/${encodeURIComponent(goalId)}/key-results`, json('POST', input));
  },
  updateKeyResult(
    goalId: string,
    keyResultId: string,
    input: {
      version: number;
      title?: string;
      unit?: string;
      baseline?: number | null;
      target?: number | null;
      actual?: number | null;
      weight?: number;
      updateMode?: GoalUpdateMode;
    },
  ): Promise<KeyResult> {
    return request(
      `/api/goals/${encodeURIComponent(goalId)}/key-results/${encodeURIComponent(keyResultId)}`,
      json('PATCH', input),
    );
  },
  deleteKeyResult(goalId: string, keyResultId: string): Promise<void> {
    return request(
      `/api/goals/${encodeURIComponent(goalId)}/key-results/${encodeURIComponent(keyResultId)}`,
      { method: 'DELETE' },
    );
  },
  addGoalLink(
    goalId: string,
    input: { projectId: string; keyResultId?: string | null; taskId?: string | null },
  ): Promise<GoalLink> {
    return request(`/api/goals/${encodeURIComponent(goalId)}/links`, json('POST', input));
  },
  removeGoalLink(goalId: string, linkId: string): Promise<void> {
    return request(`/api/goals/${encodeURIComponent(goalId)}/links/${encodeURIComponent(linkId)}`, {
      method: 'DELETE',
    });
  },

  portfolioConfigs(signal?: AbortSignal): Promise<PortfolioConfig[]> {
    return request('/api/portfolio/configs', {}, { signal });
  },
  createPortfolioConfig(input: {
    name: string;
    weights: PortfolioFactor[];
    active?: boolean;
  }): Promise<PortfolioConfig> {
    return request('/api/portfolio/configs', json('POST', input));
  },
  updatePortfolioConfig(
    id: string,
    input: {
      version: number;
      name?: string;
      weights?: PortfolioFactor[];
      active?: boolean;
    },
  ): Promise<PortfolioConfig> {
    return request(`/api/portfolio/configs/${encodeURIComponent(id)}`, json('PATCH', input));
  },
  deletePortfolioConfig(id: string): Promise<void> {
    return request(`/api/portfolio/configs/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  portfolioScores(configId?: string, signal?: AbortSignal): Promise<PortfolioScore[]> {
    return request(`/api/portfolio/scores${toQuery({ configId })}`, {}, { signal });
  },
  scoreProject(input: {
    projectId: string;
    configId: string;
    factors: { key: string; value: number | null }[];
    overrideScore?: number | null;
    overrideReason?: string | null;
  }): Promise<PortfolioScore> {
    return request('/api/portfolio/scores', json('POST', input));
  },

  dependencies(projectId: string, signal?: AbortSignal): Promise<TaskDependency[]> {
    return request(`/api/projects/${encodeURIComponent(projectId)}/dependencies`, {}, { signal });
  },
  addDependency(
    projectId: string,
    input: { predecessorId: string; successorId: string; type?: string; lagDays?: number },
  ): Promise<TaskDependency> {
    return request(
      `/api/projects/${encodeURIComponent(projectId)}/dependencies`,
      json('POST', input),
    );
  },
  deleteDependency(projectId: string, dependencyId: string): Promise<void> {
    return request(
      `/api/projects/${encodeURIComponent(projectId)}/dependencies/${encodeURIComponent(dependencyId)}`,
      { method: 'DELETE' },
    );
  },
  criticalPath(projectId: string, signal?: AbortSignal): Promise<CriticalPath> {
    return request(`/api/projects/${encodeURIComponent(projectId)}/critical-path`, {}, { signal });
  },
  timeLogs(
    query: { taskId?: string; projectId?: string } = {},
    signal?: AbortSignal,
  ): Promise<TimeLog[]> {
    return request(`/api/time-logs${toQuery(query)}`, {}, { signal });
  },
  addTimeLog(
    taskId: string,
    input: { minutes: number; workDate: string; note?: string; idempotencyKey?: string },
  ): Promise<TimeLog> {
    return request(`/api/tasks/${encodeURIComponent(taskId)}/time-logs`, json('POST', input));
  },
  updateTimeLog(
    taskId: string,
    logId: string,
    input: { version: number; minutes?: number; workDate?: string; note?: string },
  ): Promise<TimeLog> {
    return request(
      `/api/tasks/${encodeURIComponent(taskId)}/time-logs/${encodeURIComponent(logId)}`,
      json('PATCH', input),
    );
  },
  deleteTimeLog(taskId: string, logId: string): Promise<void> {
    return request(
      `/api/tasks/${encodeURIComponent(taskId)}/time-logs/${encodeURIComponent(logId)}`,
      { method: 'DELETE' },
    );
  },
  timeSummary(taskId: string, signal?: AbortSignal): Promise<TimeSummary> {
    return request(`/api/tasks/${encodeURIComponent(taskId)}/time-logs/summary`, {}, { signal });
  },
  stageGates(projectId: string, signal?: AbortSignal): Promise<WorkbenchList> {
    return request(
      `/api/workbench/stage-gates${toQuery({ projectId, limit: 50 })}`,
      {},
      { signal },
    );
  },
  createStageGate(
    projectId: string,
    input: {
      name: string;
      phase?: string;
      slaHours?: number;
      dueAt?: string | null;
      approverIds?: string[];
    },
  ): Promise<WorkbenchRecord> {
    return request(`/api/workbench/stage-gates${toQuery({ projectId })}`, json('POST', input));
  },
  decideStageGate(
    id: string,
    input: {
      action: 'approve' | 'reject' | 'waive' | 'withdraw' | 'escalate';
      note?: string;
      version: number;
    },
  ): Promise<WorkbenchRecord> {
    return request(`/api/gates/${encodeURIComponent(id)}/decisions`, json('POST', input));
  },
  baselines(projectId: string, signal?: AbortSignal): Promise<WorkbenchList> {
    return request(`/api/workbench/baselines${toQuery({ projectId, limit: 50 })}`, {}, { signal });
  },
  createBaseline(
    projectId: string,
    input: { reason: string; label?: string; changeSummary?: string },
  ): Promise<WorkbenchRecord> {
    return request(`/api/projects/${encodeURIComponent(projectId)}/baselines`, json('POST', input));
  },
  decideBaseline(
    id: string,
    input: { action: 'approve' | 'reject'; note?: string },
  ): Promise<WorkbenchRecord> {
    return request(`/api/baselines/${encodeURIComponent(id)}/decisions`, json('POST', input));
  },
  baselineVariance(id: string, signal?: AbortSignal): Promise<WorkbenchRecord> {
    return request(`/api/baselines/${encodeURIComponent(id)}/variance`, {}, { signal });
  },
  changeRequests(projectId: string, signal?: AbortSignal): Promise<WorkbenchList> {
    return request(
      `/api/workbench/change-requests${toQuery({ projectId, limit: 50 })}`,
      {},
      { signal },
    );
  },
  createChangeRequest(
    projectId: string,
    input: {
      title: string;
      kind?: 'scope' | 'schedule' | 'budget' | 'resource' | 'other';
      reason?: string;
    },
  ): Promise<WorkbenchRecord> {
    return request(`/api/workbench/change-requests${toQuery({ projectId })}`, json('POST', input));
  },
  decideChangeRequest(
    id: string,
    input: { action: 'approve' | 'reject' | 'implement'; note?: string; version: number },
  ): Promise<WorkbenchRecord> {
    return request(`/api/changes/${encodeURIComponent(id)}/decisions`, json('POST', input));
  },
  capacity(from?: string, to?: string, signal?: AbortSignal): Promise<CapacityRow[]> {
    return request(`/api/capacity${toQuery({ from, to })}`, {}, { signal });
  },
  updateCapacityProfile(
    userId: string,
    input: { weeklyHours?: number; fte?: number; skills?: string[] },
  ): Promise<WorkbenchRecord> {
    return request(`/api/capacity/profiles/${encodeURIComponent(userId)}`, json('PUT', input));
  },
  capacityScenario(input: {
    adjustments: { userId: string; weeklyHours: number }[];
    from?: string;
    to?: string;
  }): Promise<{ from: string; to: string; items: CapacityRow[] }> {
    return request('/api/capacity/scenarios', json('POST', input));
  },
  projectClosure(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<{ closure: WorkbenchRecord | null; benefits: WorkbenchRecord[] }> {
    return request(`/api/projects/${encodeURIComponent(projectId)}/closure`, {}, { signal });
  },
  closeProject(
    projectId: string,
    input: {
      acceptance: { item: string; accepted: boolean }[];
      actualCostCents?: number;
      openItems?: string[];
      feedback?: string;
      benefitPlan?: { label: string; targetValue: number; dueOn: string }[];
    },
  ): Promise<WorkbenchRecord> {
    return request(`/api/projects/${encodeURIComponent(projectId)}/closure`, json('POST', input));
  },
  reopenClosure(id: string, reason: string): Promise<WorkbenchRecord> {
    return request(`/api/closures/${encodeURIComponent(id)}/reopen`, json('POST', { reason }));
  },
  recordBenefit(
    id: string,
    input: { actual: Record<string, unknown>; note: string },
  ): Promise<WorkbenchRecord> {
    return request(`/api/benefit-reviews/${encodeURIComponent(id)}/records`, json('POST', input));
  },
  deliverables(projectId: string, signal?: AbortSignal): Promise<WorkbenchList> {
    return request(
      `/api/workbench/deliverables${toQuery({ projectId, limit: 50 })}`,
      {},
      { signal },
    );
  },
  createDeliverable(
    projectId: string,
    input: { name: string; required?: boolean },
  ): Promise<WorkbenchRecord> {
    return request(`/api/workbench/deliverables${toQuery({ projectId })}`, json('POST', input));
  },
  deliverableVersions(id: string, signal?: AbortSignal): Promise<WorkbenchList> {
    return request(
      `/api/workbench/deliverable-versions${toQuery({ deliverableId: id })}`,
      {},
      { signal },
    );
  },
  addDeliverableVersion(
    id: string,
    input: { filename: string; checksum?: string; note?: string },
  ): Promise<WorkbenchRecord> {
    return request(`/api/deliverables/${encodeURIComponent(id)}/versions`, json('POST', input));
  },
  reviewDeliverable(
    id: string,
    input: { action: 'approve' | 'reject'; note?: string },
  ): Promise<WorkbenchRecord> {
    return request(`/api/deliverables/${encodeURIComponent(id)}/reviews`, json('POST', input));
  },
  estimateScales(signal?: AbortSignal): Promise<WorkbenchList> {
    return request('/api/estimate-scales', {}, { signal });
  },
  createEstimateScale(input: {
    name: string;
    values: { key: string; label: string; points?: number }[];
  }): Promise<WorkbenchRecord> {
    return request('/api/estimate-scales', json('POST', input));
  },
  updateTaskEstimate(
    taskId: string,
    input: {
      estimatePoints?: number | null;
      estimateHours?: number | null;
      estimateSize?: string | null;
    },
  ): Promise<WorkbenchRecord> {
    return request(`/api/tasks/${encodeURIComponent(taskId)}/estimate`, json('PATCH', input));
  },
  taskTreeBulk(input: {
    projectId: string;
    action: 'indent' | 'outdent' | 'move' | 'delete' | 'status' | 'sync';
    taskIds: string[];
    parentId?: string | null;
    status?: string;
    version?: number;
  }): Promise<WorkbenchRecord> {
    return request('/api/tasks/tree/bulk', json('POST', input));
  },
  slaPolicies(signal?: AbortSignal): Promise<WorkbenchList> {
    return request('/api/workbench/sla-policies', {}, { signal });
  },
  taskSlaInstances(taskId: string, signal?: AbortSignal): Promise<WorkbenchList> {
    return request(`/api/workbench/sla-instances${toQuery({ taskId })}`, {}, { signal });
  },
  attachSla(
    taskId: string,
    input: { policyId?: string; auto?: boolean },
  ): Promise<WorkbenchRecord> {
    return request(`/api/tasks/${encodeURIComponent(taskId)}/sla`, json('POST', input));
  },
  taskSlaAction(
    taskId: string,
    action: 'pause' | 'resume' | 'escalate' | 'respond' | 'review',
    reason?: string,
  ): Promise<WorkbenchRecord> {
    return request(
      `/api/tasks/${encodeURIComponent(taskId)}/sla/${action}`,
      json('POST', { reason }),
    );
  },
  tickSla(): Promise<{ checked: number }> {
    return request('/api/sla/tick', { method: 'POST' });
  },
  dispatchRules(signal?: AbortSignal): Promise<WorkbenchList> {
    return request('/api/workbench/dispatch-rules', {}, { signal });
  },
  dispatchRecommendations(taskId: string, signal?: AbortSignal): Promise<WorkbenchList> {
    return request(
      `/api/workbench/dispatch-recommendations${toQuery({ taskId, limit: 20 })}`,
      {},
      { signal },
    );
  },
  recommendDispatch(input: {
    taskId: string;
    ruleId?: string;
    simulate?: boolean;
    taskIds?: string[];
  }): Promise<WorkbenchRecord[]> {
    return request('/api/dispatch/recommend', json('POST', input));
  },
  decideDispatch(input: {
    recommendationId: string;
    mode?: 'assign' | 'reject';
    fallback?: boolean;
  }): Promise<WorkbenchRecord> {
    return request('/api/dispatch/decision', json('POST', input));
  },
  decideDispatchBatch(input: {
    recommendationIds: string[];
    mode?: 'assign' | 'reject';
    fallback?: boolean;
  }): Promise<{ decided: WorkbenchRecord[]; count: number }> {
    return request('/api/dispatch/batch', json('POST', input));
  },
  handoffs(taskId: string, signal?: AbortSignal): Promise<WorkbenchList> {
    return request(`/api/workbench/handoffs${toQuery({ taskId })}`, {}, { signal });
  },
  createHandoff(
    taskId: string,
    input: {
      toUserId: string;
      note?: string;
      dueAt?: string | null;
      includeComments?: boolean;
      includeAttachments?: boolean;
    },
  ): Promise<WorkbenchRecord> {
    return request(`/api/tasks/${encodeURIComponent(taskId)}/handoffs`, json('POST', input));
  },
  decideHandoff(
    id: string,
    input: { action: 'accept' | 'decline'; note?: string; confirmChecklist?: boolean },
  ): Promise<WorkbenchRecord> {
    return request(`/api/handoffs/${encodeURIComponent(id)}/decision`, json('POST', input));
  },
  tickHandoffs(): Promise<{ escalated: number }> {
    return request('/api/handoffs/tick', { method: 'POST' });
  },
  taskChecklist(taskId: string, signal?: AbortSignal): Promise<WorkbenchList> {
    return request(`/api/workbench/checklist-items${toQuery({ taskId })}`, {}, { signal });
  },
  updateChecklistItem(id: string, input: { done: boolean }): Promise<WorkbenchRecord> {
    return request(
      `/api/workbench/checklist-items/${encodeURIComponent(id)}`,
      json('PATCH', input),
    );
  },
  taskForms(signal?: AbortSignal): Promise<WorkbenchList> {
    return request('/api/workbench/task-forms', {}, { signal });
  },
  putTaskFormValues(
    taskId: string,
    formId: string,
    input: {
      values: Record<string, string | number | boolean>;
      completed?: boolean;
      signature?: string;
      attachmentIds?: string[];
    },
  ): Promise<WorkbenchRecord> {
    return request(
      `/api/tasks/${encodeURIComponent(taskId)}/forms/${encodeURIComponent(formId)}`,
      json('PUT', input),
    );
  },
  blockers(
    projectId: string,
    status: 'all' | 'open' | 'resolved' = 'all',
    signal?: AbortSignal,
  ): Promise<TaskBlocker[]> {
    return request(
      `/api/projects/${encodeURIComponent(projectId)}/blockers${toQuery({ status })}`,
      {},
      { signal },
    );
  },
  blockerReport(projectId: string, signal?: AbortSignal): Promise<BlockerReport> {
    return request(
      `/api/projects/${encodeURIComponent(projectId)}/blockers/report`,
      {},
      { signal },
    );
  },
  addBlocker(
    taskId: string,
    input: {
      reason: string;
      category?: TaskBlocker['category'];
      ownerTeam?: string;
      expectedResolveAt?: string | null;
    },
  ): Promise<TaskBlocker> {
    return request(`/api/tasks/${encodeURIComponent(taskId)}/blockers`, json('POST', input));
  },
  resolveBlocker(
    projectId: string,
    blockerId: string,
    input: { evidence: string; version: number },
  ): Promise<TaskBlocker> {
    return request(
      `/api/projects/${encodeURIComponent(projectId)}/blockers/${encodeURIComponent(blockerId)}/resolve`,
      json('POST', input),
    );
  },
  recurrences(projectId: string, signal?: AbortSignal): Promise<RecurrenceRule[]> {
    return request(`/api/projects/${encodeURIComponent(projectId)}/recurrences`, {}, { signal });
  },
  createRecurrence(
    projectId: string,
    input: {
      title: string;
      rule: string;
      startsOn: string;
      timezone?: string;
      status?: TaskStatus;
      priority?: TaskPriority;
      assigneeId?: string | null;
      description?: string;
      endsOn?: string | null;
      count?: number | null;
    },
  ): Promise<RecurrenceRule> {
    return request(
      `/api/projects/${encodeURIComponent(projectId)}/recurrences`,
      json('POST', input),
    );
  },
  updateRecurrence(
    id: string,
    input: { version: number; title?: string; rule?: string; startsOn?: string; active?: boolean },
  ): Promise<RecurrenceRule> {
    return request(`/api/recurrences/${encodeURIComponent(id)}`, json('PATCH', input));
  },
  deleteRecurrence(id: string): Promise<void> {
    return request(`/api/recurrences/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  runRecurrence(id: string, through?: string): Promise<RecurrenceRunResult> {
    return request(`/api/recurrences/${encodeURIComponent(id)}/run`, json('POST', { through }));
  },

  automationRules(
    query: { trigger?: AutomationTrigger; projectId?: string } = {},
    signal?: AbortSignal,
  ): Promise<AutomationRule[]> {
    return request(`/api/automation/rules${toQuery(query)}`, {}, { signal });
  },
  createAutomationRule(input: {
    name: string;
    trigger: AutomationTrigger;
    actions: AutomationRule['actions'];
    conditions?: AutomationRule['conditions'];
    projectId?: string | null;
    active?: boolean;
    maxRunsPerHour?: number;
  }): Promise<AutomationRule> {
    return request('/api/automation/rules', json('POST', input));
  },
  updateAutomationRule(
    id: string,
    input: {
      version: number;
      name?: string;
      trigger?: AutomationTrigger;
      actions?: AutomationRule['actions'];
      conditions?: AutomationRule['conditions'];
      projectId?: string | null;
      active?: boolean;
      maxRunsPerHour?: number;
    },
  ): Promise<AutomationRule> {
    return request(`/api/automation/rules/${encodeURIComponent(id)}`, json('PATCH', input));
  },
  deleteAutomationRule(id: string): Promise<void> {
    return request(`/api/automation/rules/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  dryRunAutomationRule(
    id: string,
    input: {
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
    },
  ): Promise<AutomationPreview> {
    return request(`/api/automation/rules/${encodeURIComponent(id)}/dry-run`, json('POST', input));
  },
  automationRuns(
    query: { ruleId?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<AutomationRun[]> {
    return request(`/api/automation/runs${toQuery(query)}`, {}, { signal });
  },

  documents(
    projectId: string,
    query: { status?: string; q?: string } = {},
    signal?: AbortSignal,
  ): Promise<ProjectDocument[]> {
    return request(
      `/api/projects/${encodeURIComponent(projectId)}/documents${toQuery(query)}`,
      {},
      { signal },
    );
  },
  document(id: string, signal?: AbortSignal): Promise<ProjectDocument> {
    return request(`/api/documents/${encodeURIComponent(id)}`, {}, { signal });
  },
  createDocument(
    projectId: string,
    input: {
      title: string;
      content?: string;
      format?: 'markdown' | 'text';
      status?: ProjectDocument['status'];
      confidentiality?: ProjectDocument['confidentiality'];
      ownerId?: string | null;
      reviewDueAt?: string | null;
    },
  ): Promise<ProjectDocument> {
    return request(`/api/projects/${encodeURIComponent(projectId)}/documents`, json('POST', input));
  },
  updateDocument(
    id: string,
    input: {
      version: number;
      title?: string;
      content?: string;
      format?: 'markdown' | 'text';
      status?: ProjectDocument['status'];
      confidentiality?: ProjectDocument['confidentiality'];
      ownerId?: string | null;
      reviewDueAt?: string | null;
      changeSummary?: string;
    },
  ): Promise<ProjectDocument> {
    return request(`/api/documents/${encodeURIComponent(id)}`, json('PATCH', input));
  },
  documentVersions(id: string, signal?: AbortSignal): Promise<DocumentVersion[]> {
    return request(`/api/documents/${encodeURIComponent(id)}/versions`, {}, { signal });
  },
  restoreDocument(
    id: string,
    input: { version: number; changeSummary?: string },
  ): Promise<ProjectDocument> {
    return request(`/api/documents/${encodeURIComponent(id)}/restore`, json('POST', input));
  },
  decisions(
    query: { projectId?: string; status?: string; q?: string } = {},
    signal?: AbortSignal,
  ): Promise<DecisionRecord[]> {
    return request(`/api/decisions${toQuery(query)}`, {}, { signal });
  },
  decision(id: string, signal?: AbortSignal): Promise<DecisionRecord> {
    return request(`/api/decisions/${encodeURIComponent(id)}`, {}, { signal });
  },
  createDecision(input: {
    title: string;
    projectId?: string | null;
    status?: DecisionRecord['status'];
    context?: string;
    options?: { title: string; pros?: string; cons?: string }[];
    decision?: string;
    consequences?: string;
    reviewAt?: string | null;
  }): Promise<DecisionRecord> {
    return request('/api/decisions', json('POST', input));
  },
  updateDecision(
    id: string,
    input: {
      version: number;
      title?: string;
      status?: DecisionRecord['status'];
      context?: string;
      options?: { title: string; pros?: string; cons?: string }[];
      decision?: string;
      consequences?: string;
      reviewAt?: string | null;
      changeSummary?: string;
    },
  ): Promise<DecisionRecord> {
    return request(`/api/decisions/${encodeURIComponent(id)}`, json('PATCH', input));
  },
  decisionVersions(id: string, signal?: AbortSignal): Promise<DecisionVersion[]> {
    return request(`/api/decisions/${encodeURIComponent(id)}/versions`, {}, { signal });
  },

  metrics(query: { status?: string } = {}, signal?: AbortSignal): Promise<MetricDefinition[]> {
    return request(`/api/metrics${toQuery(query)}`, {}, { signal });
  },
  createMetric(input: {
    name: string;
    formula: string;
    unit?: string;
    dimensions?: string[];
    aggregation?: 'sum' | 'avg' | 'min' | 'max' | 'count';
    ownerId?: string | null;
  }): Promise<MetricDefinition> {
    return request('/api/metrics', json('POST', input));
  },
  updateMetric(
    id: string,
    input: {
      version: number;
      name?: string;
      formula?: string;
      unit?: string;
      status?: MetricDefinition['status'];
      aggregation?: 'sum' | 'avg' | 'min' | 'max' | 'count';
      changeSummary?: string;
    },
  ): Promise<MetricDefinition> {
    return request(`/api/metrics/${encodeURIComponent(id)}`, json('PATCH', input));
  },
  metricVersions(id: string, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    return request(`/api/metrics/${encodeURIComponent(id)}/versions`, {}, { signal });
  },
  evaluateMetric(
    id: string,
    input: { from: string; to: string; groupBy?: 'day' | 'week' | 'month' },
  ): Promise<MetricEvaluation> {
    return request(`/api/metrics/${encodeURIComponent(id)}/evaluate`, json('POST', input));
  },
  budgets(signal?: AbortSignal): Promise<BudgetSummary[]> {
    return request('/api/budgets', {}, { signal });
  },
  projectBudget(projectId: string, signal?: AbortSignal): Promise<BudgetSummary> {
    return request(`/api/projects/${encodeURIComponent(projectId)}/budget`, {}, { signal });
  },
  upsertBudget(
    projectId: string,
    input: {
      version?: number;
      costCenter?: string;
      currency?: CurrencyCode;
      budgetCents?: number;
      forecastCents?: number;
      fxRate?: number;
      fxDate?: string | null;
      thresholdPct?: number;
    },
  ): Promise<BudgetSummary> {
    return request(`/api/projects/${encodeURIComponent(projectId)}/budget`, json('PUT', input));
  },
  addBudgetEntry(
    projectId: string,
    input: {
      kind: 'committed' | 'actual' | 'forecast';
      amountCents: number;
      currency?: CurrencyCode;
      fxRate?: number;
      fxDate?: string | null;
      note?: string;
      idempotencyKey?: string;
    },
  ): Promise<BudgetSummary & { replayed: boolean }> {
    return request(
      `/api/projects/${encodeURIComponent(projectId)}/budget/entries`,
      json('POST', input),
    );
  },

  workbench(
    resource: string,
    query: Record<string, string | number | undefined> = {},
    signal?: AbortSignal,
  ): Promise<WorkbenchList> {
    return request(
      `/api/workbench/${encodeURIComponent(resource)}${toQuery(query)}`,
      {},
      { signal },
    );
  },
  workbenchRecord(resource: string, id: string, signal?: AbortSignal): Promise<WorkbenchRecord> {
    return request(
      `/api/workbench/${encodeURIComponent(resource)}/${encodeURIComponent(id)}`,
      {},
      { signal },
    );
  },
  workbenchCreate(
    resource: string,
    input: Record<string, unknown>,
    query: Record<string, string> = {},
  ): Promise<WorkbenchRecord> {
    return request(
      `/api/workbench/${encodeURIComponent(resource)}${toQuery(query)}`,
      json('POST', input),
    );
  },
  workbenchUpdate(
    resource: string,
    id: string,
    input: Record<string, unknown>,
  ): Promise<WorkbenchRecord> {
    return request(
      `/api/workbench/${encodeURIComponent(resource)}/${encodeURIComponent(id)}`,
      json('PATCH', input),
    );
  },
  workbenchDelete(resource: string, id: string): Promise<{ ok: true }> {
    return request(`/api/workbench/${encodeURIComponent(resource)}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },
  metricImpact(id: string, signal?: AbortSignal): Promise<MetricImpact> {
    return request(`/api/metrics/${encodeURIComponent(id)}/impact`, {}, { signal });
  },
  addMetricLineage(
    id: string,
    input: {
      sourceType: 'table' | 'import' | 'formula' | 'filter' | 'fx' | 'metric' | 'manual';
      sourceId: string;
      relation?: 'derives' | 'depends' | 'converts';
      sensitive?: boolean;
    },
  ): Promise<WorkbenchRecord> {
    return request(`/api/metrics/${encodeURIComponent(id)}/lineage`, json('POST', input));
  },
  detectAnomalies(input: {
    metricId: string;
    from: string;
    to: string;
    threshold?: number;
  }): Promise<{
    metricId: string;
    baseline?: { mean: number; std: number; samples: number };
    anomalies: WorkbenchRecord[];
    message?: string;
  }> {
    return request('/api/anomalies/detect', json('POST', input));
  },
  dismissAnomaly(id: string, note?: string): Promise<WorkbenchRecord> {
    return request(`/api/anomalies/${encodeURIComponent(id)}/dismiss`, json('POST', { note }));
  },
  evaluateScenario(id: string): Promise<ScenarioEvaluation> {
    return request(`/api/scenarios/${encodeURIComponent(id)}/evaluate`, { method: 'POST' });
  },
  compareScenarios(ids: string[]): Promise<{ scenarios: ScenarioEvaluation[] }> {
    return request('/api/scenarios/compare', json('POST', { ids }));
  },
  runQueryReport(id: string): Promise<QueryReportRun> {
    return request(`/api/query-reports/${encodeURIComponent(id)}/run`, { method: 'POST' });
  },
  previewQuery(config: Record<string, unknown>): Promise<QueryPreviewResult> {
    return request('/api/query/preview', json('POST', { config }));
  },
  createReportSubscription(input: {
    reportId: string;
    reportKind?: 'saved' | 'query';
    recipients: string[];
    format?: 'csv' | 'json' | 'pdf' | 'xlsx';
    channel?: 'email' | 'download';
    active?: boolean;
  }): Promise<WorkbenchRecord> {
    return request('/api/report-subscriptions', json('POST', input));
  },
  runReportSubscriptions(): Promise<{ delivered: number }> {
    return request('/api/report-subscriptions/run', { method: 'POST' });
  },
  budgetAlerts(projectId: string, signal?: AbortSignal): Promise<BudgetAlertReport> {
    return request(`/api/projects/${encodeURIComponent(projectId)}/budget-alerts`, {}, { signal });
  },
  createBudgetCategory(
    budgetId: string,
    input: {
      name: string;
      plannedCents?: number;
      actualCents?: number;
      forecastCents?: number;
    },
  ): Promise<WorkbenchRecord> {
    return request(`/api/budgets/${encodeURIComponent(budgetId)}/categories`, json('POST', input));
  },
  updateBudgetCategory(
    id: string,
    input: {
      version: number;
      name?: string;
      plannedCents?: number;
      actualCents?: number;
      forecastCents?: number;
    },
  ): Promise<WorkbenchRecord> {
    return request(`/api/budget-categories/${encodeURIComponent(id)}`, json('PATCH', input));
  },
  publishWorkflow(id: string, changeSummary?: string): Promise<WorkbenchRecord> {
    return request(
      `/api/workflows/${encodeURIComponent(id)}/publish`,
      json('POST', { changeSummary }),
    );
  },
  testWorkflow(id: string, input: Record<string, unknown> = {}): Promise<WorkflowRunResult> {
    return request(`/api/workflows/${encodeURIComponent(id)}/test`, json('POST', { input }));
  },
  runWorkflow(id: string, input: Record<string, unknown> = {}): Promise<WorkflowRunResult> {
    return request(
      `/api/workflows/${encodeURIComponent(id)}/runs`,
      json('POST', { input, idempotencyKey: crypto.randomUUID(), mode: 'live' }),
    );
  },
  rollbackWorkflow(id: string, version: number): Promise<WorkbenchRecord> {
    return request(`/api/workflows/${encodeURIComponent(id)}/rollback`, json('POST', { version }));
  },
  createApproval(input: {
    title: string;
    kind?: string;
    projectId?: string | null;
    amountCents?: number;
    risk?: 'low' | 'medium' | 'high';
    dueAt?: string | null;
    steps: { name: string; approverIds: string[]; mode?: 'all' | 'any'; slaHours?: number }[];
  }): Promise<WorkbenchRecord> {
    return request('/api/approvals', json('POST', input));
  },
  decideApproval(
    id: string,
    input: {
      action: 'approve' | 'reject' | 'delegate' | 'escalate';
      note?: string;
      delegateTo?: string;
      version: number;
    },
  ): Promise<WorkbenchRecord> {
    return request(`/api/approvals/${encodeURIComponent(id)}/decisions`, json('POST', input));
  },
  withdrawApproval(id: string, note: string, version: number): Promise<WorkbenchRecord> {
    return request(
      `/api/approvals/${encodeURIComponent(id)}/withdraw`,
      json('POST', { note, version }),
    );
  },
  approvalMetrics(
    query: { from?: string; to?: string; kind?: string } = {},
    signal?: AbortSignal,
  ): Promise<ApprovalMetrics> {
    return request(`/api/approvals/metrics${toQuery(query)}`, {}, { signal });
  },
  fireTrigger(
    id: string,
    input: { eventKey?: string; dryRun?: boolean } = {},
  ): Promise<WorkbenchRecord> {
    return request(`/api/triggers/${encodeURIComponent(id)}/fire`, json('POST', input));
  },
  tickTriggers(): Promise<{ fired: number }> {
    return request('/api/triggers/tick', { method: 'POST' });
  },
  rotateConnector(id: string, secret: string): Promise<WorkbenchRecord> {
    return request(`/api/connectors/${encodeURIComponent(id)}/rotate`, json('POST', { secret }));
  },
  connectorHealth(id: string, signal?: AbortSignal): Promise<ConnectorHealth> {
    return request(`/api/connectors/${encodeURIComponent(id)}/health`, {}, { signal });
  },
  publishEvent(input: {
    type: string;
    payload?: Record<string, unknown>;
    dedupeKey?: string;
  }): Promise<WorkbenchRecord> {
    return request('/api/events', json('POST', input));
  },
  retryEventDelivery(id: string): Promise<WorkbenchRecord> {
    return request(`/api/event-deliveries/${encodeURIComponent(id)}/retry`, { method: 'POST' });
  },
  retryJob(id: string): Promise<WorkbenchRecord> {
    return request(`/api/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST' });
  },
  tickJobs(): Promise<{ processed: number }> {
    return request('/api/jobs/tick', json('POST', {}));
  },
  scanQuality(ruleId?: string): Promise<WorkbenchRecord[]> {
    return request('/api/quality/scan', json('POST', { ruleId }));
  },
  fixQualityIssue(
    id: string,
    input: { fixed: Record<string, unknown>; reason: string; preview?: boolean },
  ): Promise<WorkbenchRecord> {
    return request(`/api/quality/issues/${encodeURIComponent(id)}/fix`, json('POST', input));
  },
  rollbackAutomationRule(id: string, version: number): Promise<WorkbenchRecord> {
    return request(
      `/api/automation/rules/${encodeURIComponent(id)}/rollback`,
      json('POST', { version }),
    );
  },
  simulatePermission(input: {
    userId: string;
    resourceType: 'workspace' | 'project' | 'task';
    resourceId: string;
    action: string;
  }): Promise<PermissionSimulationResult> {
    return request('/api/governance/simulate', json('POST', input));
  },
  jitGrants(
    query: { status?: string; userId?: string } = {},
    signal?: AbortSignal,
  ): Promise<JitGrant[]> {
    return request(`/api/governance/jit${toQuery(query)}`, {}, { signal });
  },
  createJitGrant(input: {
    userId?: string;
    permissions: Permission[];
    resourceType: 'workspace' | 'project' | 'task';
    resourceId?: string;
    action?: string;
    reason: string;
    durationMinutes: number;
    startsAt?: string;
  }): Promise<JitGrant> {
    return request('/api/governance/jit', json('POST', input));
  },
  approveJitGrant(id: string): Promise<JitGrant> {
    return request(`/api/governance/jit/${encodeURIComponent(id)}/approve`, { method: 'POST' });
  },
  rejectJitGrant(id: string): Promise<JitGrant> {
    return request(`/api/governance/jit/${encodeURIComponent(id)}/reject`, { method: 'POST' });
  },
  revokeJitGrant(id: string): Promise<JitGrant> {
    return request(`/api/governance/jit/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
  },
};
