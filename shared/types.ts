import type { Permission } from './permissions.ts';

export type Role = 'admin' | 'manager' | 'pm' | 'viewer';
export type UserStatus = 'active' | 'disabled';
export type ProjectVisibility = 'workspace' | 'private';

export type CustomRole = {
  id: string;
  workspaceId: string;
  name: string;
  baseRole: Role;
  permissions: Permission[];
  memberCount: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceSummary = {
  id: string;
  name: string;
  createdAt: string;
  memberCount: number;
  projectCount: number;
};
export type DateRangeKey = 'today' | '7d' | '30d' | 'month' | 'last_month' | 'custom';
export type Granularity = 'day' | 'week' | 'month';

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  timezone: string;
  avatarUrl?: string | null;
  workspaceId?: string;
  workspaceName?: string;
  permissions?: Permission[];
  jitPermissions?: Permission[];
  customRole?: { id: string; name: string; baseRole: Role } | null;
};

export type User = SessionUser & {
  status: UserStatus;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  version: number;
};

export type UserOption = {
  id: string;
  name: string;
};

export type UserDirectoryEntry = UserOption & {
  email: string;
  role: Role;
  status: UserStatus;
  isDemo: boolean;
  avatarUrl: string | null;
  workspaceId?: string;
  customRoleId?: string | null;
  customRoleName?: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  version: number;
};

export type UserListResult = {
  users: UserDirectoryEntry[];
  total: number;
  page: number;
  pageSize: number;
  counts: { total: number; active: number; disabled: number; admins: number };
};

export type Profile = SessionUser & {
  avatarUrl: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  version: number;
};

export type Preferences = {
  defaultRange: DateRangeKey;
  emailNotifications: boolean;
  weeklyDigest: boolean;
  sidebarCollapsed: boolean;
  updatedAt: string;
  version: number;
};

export type SessionInfo = {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
};

export type TokenScope = 'read' | 'write';

export type PersonalAccessToken = {
  id: string;
  name: string;
  scopes: TokenScope[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  expired: boolean;
};

export type TokenList = {
  tokens: PersonalAccessToken[];
  quota: { max: number; windowSeconds: number };
};

export type TokenCreateResult = {
  token: string;
  item: PersonalAccessToken;
};

export const WEBHOOK_EVENTS = [
  'project.created',
  'project.updated',
  'project.archived',
  'project.restored',
  'project.deleted',
  'task.created',
  'task.completed',
  'comment.created',
  'user.created',
  'user.disabled',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export type WebhookStatus = 'pending' | 'sent' | 'failed';

export type Webhook = {
  id: string;
  url: string;
  events: WebhookEvent[];
  active: boolean;
  createdAt: string;
  lastStatus: WebhookStatus | null;
  lastDeliveryAt: string | null;
};

export type WebhookCreateResult = {
  webhook: Webhook;
  secret: string;
};

export type WebhookDelivery = {
  id: string;
  event: WebhookEvent;
  status: WebhookStatus;
  attempts: number;
  responseStatus: number | null;
  createdAt: string;
  updatedAt: string;
};

export type ProjectStatus = 'planning' | 'active' | 'on_hold' | 'completed' | 'archived';

export type ProjectDueFilter = 'overdue' | 'week' | 'month';

export type Project = {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  progress: number;
  ownerId: string;
  ownerName: string;
  workspaceId: string;
  visibility: ProjectVisibility;
  startDate: string | null;
  dueDate: string | null;
  tags: string[];
  favorite: boolean;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
};

export type ProjectTagCount = { tag: string; count: number };

export type ProjectBatchAction = 'status' | 'owner' | 'archive';

export type ProjectBatchResult = {
  updated: number;
  skipped: string[];
};

export type ProjectViewQuery = {
  q?: string;
  status?: ProjectStatus | 'all';
  owner?: string;
  sort?: 'updated' | 'created' | 'name' | 'progress' | 'due';
  tag?: string;
  due?: ProjectDueFilter | 'all';
  favorite?: boolean;
  view?: 'grid' | 'list';
  pageSize?: number;
};

export type SavedView = {
  id: string;
  name: string;
  query: ProjectViewQuery;
  createdAt: string;
  updatedAt: string;
};

export type ProjectDetail = Project & {
  members: UserOption[];
};

export type TaskStatus = 'todo' | 'in_progress' | 'review' | 'done';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export type Task = {
  id: string;
  projectId: string;
  parentId: string | null;
  milestoneId: string | null;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId: string | null;
  assigneeName: string | null;
  dueDate: string | null;
  sortOrder: number;
  completedAt: string | null;
  estimatePoints: number | null;
  estimateHours: number | null;
  estimateSize: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  commentCount: number;
  childCount: number;
  doneChildCount: number;
  rollupProgress: number;
  rollupEstimateHours: number;
};

export type Milestone = {
  id: string;
  projectId: string;
  title: string;
  dueDate: string | null;
  createdAt: string;
  taskCount: number;
  doneCount: number;
};

export type ProjectTasks = {
  tasks: Task[];
  milestones: Milestone[];
  progress: number;
  estimateTotals: {
    points: number;
    hours: number;
    sizes: Record<string, number>;
    loggedHours: number;
    varianceHours: number;
  };
};

export type Attachment = {
  id: string;
  projectId: string;
  name: string;
  mime: string;
  size: number;
  uploader: UserOption | null;
  createdAt: string;
  downloadUrl: string;
  downloadExpiresAt: string;
};

export type AttachmentList = {
  attachments: Attachment[];
  limits: { maxBytes: number; maxCount: number; maxTotalBytes: number };
  usage: { count: number; totalBytes: number };
};

export type Comment = {
  id: string;
  projectId: string;
  taskId: string | null;
  taskTitle: string | null;
  author: UserOption | null;
  body: string;
  mentions: UserOption[];
  createdAt: string;
};

export type CommentList = {
  comments: Comment[];
  total: number;
};

export type NotificationType = 'mention' | 'comment' | 'task_assigned' | 'weekly_digest';

export type AppNotification = {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
};

export type NotificationList = {
  notifications: AppNotification[];
  unread: number;
};

export type ProjectStatusCounts = {
  all: number;
  planning: number;
  active: number;
  on_hold: number;
  completed: number;
  archived: number;
};

export type ProjectOverview = {
  total: number;
  completed: number;
  active: number;
  planning: number;
  onHold: number;
  archived: number;
  completion: number;
};

export type ProjectListResult = {
  projects: Project[];
  total: number;
  page: number;
  pageSize: number;
  counts: ProjectStatusCounts;
  tags: ProjectTagCount[];
};

export type ProjectScaffoldResult = {
  project: ProjectDetail;
  milestones: number;
  tasks: number;
};

export type ProjectSearchHit = {
  id: string;
  name: string;
  status: ProjectStatus;
  progress: number;
};

export type ActivityType =
  | 'project.created'
  | 'project.updated'
  | 'project.status_changed'
  | 'project.completed'
  | 'project.archived'
  | 'project.restored'
  | 'project.deleted'
  | 'project.member_added'
  | 'project.member_removed'
  | 'project.imported'
  | 'project.template_applied'
  | 'project.duplicated'
  | 'task.created'
  | 'task.updated'
  | 'task.completed'
  | 'task.reopened'
  | 'task.deleted'
  | 'milestone.created'
  | 'milestone.deleted'
  | 'comment.created'
  | 'comment.deleted'
  | 'user.created'
  | 'user.role_changed'
  | 'user.disabled'
  | 'user.enabled'
  | 'user.password_changed';

export type ActivityItem = {
  seq: number;
  type: ActivityType;
  actor: UserOption | null;
  project: { id: string; name: string } | null;
  message: string;
  createdAt: string;
  meta: Record<string, unknown> | null;
  /** FTS snippet with `<mark>` markers, present on search hits only. */
  highlight?: string | null;
};

export type ActivityPage = {
  activities: ActivityItem[];
  nextCursor: number | null;
};

export type KpiFormat = 'currency' | 'number' | 'percent';

export type SparkPoint = {
  date: string;
  value: number;
};

export type KpiValue = {
  value: number;
  previous: number | null;
  delta: number | null;
  format: KpiFormat;
  sparkline: SparkPoint[];
};

export type RevenuePoint = {
  date: string;
  revenue: number;
};

export type ChannelSlice = {
  channel: string;
  sessions: number;
  share: number;
};

export type RangeInfo = {
  key: DateRangeKey;
  from: string;
  to: string;
  days: number;
  previous: { from: string; to: string; days: number };
  granularity: Granularity;
  timezone: string;
};

export type RuntimeInfo = {
  node: string;
  sqlite: string;
  pid: number;
  uptime: number;
};

export type CurrencyCode = 'USD' | 'CNY' | 'EUR' | 'GBP' | 'JPY' | 'HKD' | 'SGD';

export type WorkspaceSettings = {
  currency: CurrencyCode;
  rates: Record<CurrencyCode, number>;
  timeLogVisibility: 'all' | 'managers' | 'self';
  updatedAt: string;
};

export type PushStatus = {
  enabled: boolean;
  publicKey: string | null;
  subscriptions: number;
};

export type DashboardSummary = {
  range: RangeInfo;
  demo: boolean;
  currency: CurrencyCode;
  kpis: {
    revenue: KpiValue;
    customers: KpiValue;
    conversion: KpiValue;
  };
  revenue: RevenuePoint[];
  channels: ChannelSlice[];
  projects: ProjectOverview;
  activities: ActivityItem[];
  runtime: RuntimeInfo;
};

export type RevenueSeriesPoint = {
  bucket: string;
  label: string;
  revenue: number;
  previous: number | null;
};

export type RevenueReport = {
  range: RangeInfo;
  currency: CurrencyCode;
  granularity: Granularity;
  points: RevenueSeriesPoint[];
  total: number;
  previousTotal: number | null;
  delta: number | null;
  comparison: boolean;
};

export type ChannelPerformance = {
  channel: string;
  sessions: number;
  share: number;
  previousSessions: number | null;
  delta: number | null;
};

export type ChannelReport = {
  range: RangeInfo;
  channels: ChannelPerformance[];
  total: number;
};

export type AudienceReport = {
  range: RangeInfo;
  customers: number;
  previousCustomers: number | null;
  customerDelta: number | null;
  visitors: number;
  conversion: number;
  previousConversion: number | null;
  conversionDelta: number | null;
  daily: SparkPoint[];
};

export type MetricRecord = {
  date: string;
  revenue: number;
  customers: number;
  conversions: number;
  visitors: number;
  currency: CurrencyCode;
};

export type MetricDay = MetricRecord & { source: string };

export type MetricImportResult = {
  imported: number;
  skipped: number;
  errors: { row: number; message: string }[];
};

export type AnalyticsSourceSummary = {
  source: string;
  days: number;
  from: string;
  to: string;
  revenue: number;
};

export type ReportKind = 'revenue' | 'channels' | 'audience';

export type ReportFrequency = 'none' | 'weekly' | 'monthly';

export type SavedReportQuery = {
  kind: ReportKind;
  range: DateRangeKey;
  from?: string;
  to?: string;
  granularity?: Granularity;
  compare?: boolean;
};

export type SavedReport = {
  id: string;
  name: string;
  query: SavedReportQuery;
  frequency: ReportFrequency;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SearchResults = {
  projects: ProjectSearchHit[];
  activities: ActivityItem[];
  users: UserDirectoryEntry[];
};

export type ImportIssue = { row: number; message: string };

export type ImportPreviewItem = {
  row: number;
  name: string;
  status: ProjectStatus;
  ownerEmail: string | null;
  members: string[];
};

export type ImportResult = {
  preview: boolean;
  imported: number;
  skipped: number;
  duplicates: number;
  errors: ImportIssue[];
  items: ImportPreviewItem[];
};

export type PresenceClient = {
  id: string;
  name: string;
  since: string;
};

export type TypingMessage = {
  type: 'typing';
  clientId: string;
  name: string;
  projectId: string;
  active: boolean;
};

export type SnapshotPayload = {
  user: SessionUser;
  projects: Project[];
  counts: ProjectStatusCounts;
  activities: ActivityItem[];
  cursor: number;
  clients: PresenceClient[];
  runtime: RuntimeInfo;
};

export type AuditEntry = {
  seq: number;
  actorId: string | null;
  actorName: string | null;
  action: string;
  target: string | null;
  ip: string | null;
  detail: unknown;
  createdAt: string;
};

export type AuditActionCount = { action: string; count: number };

export type AuditRetention = { maxRows: number; days: number };

export type AuditPage = {
  entries: AuditEntry[];
  total: number;
  page: number;
  pageSize: number;
  actions: AuditActionCount[];
  retention: AuditRetention;
};

export type AuditCleanupResult = { removed: number; days: number };

export const FEATURE_FLAG_KEYS = [
  'analytics',
  'audit_center',
  'webhooks',
  'push_notifications',
  'project_templates',
  'enterprise',
] as const;

export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[number];

export type FeatureFlags = Record<FeatureFlagKey, boolean>;

export type FeatureFlag = {
  key: FeatureFlagKey;
  enabled: boolean;
  updatedAt: string;
  updatedBy: string | null;
};

export type OpsSettings = {
  backupRetentionDays: number;
  trashRetentionDays: number;
  auditRetentionDays: number;
  activityRetentionDays: number;
  demoDataEnabled: boolean;
  updatedAt: string;
};

export type OpsBackup = {
  name: string;
  sizeBytes: number;
  createdAt: string;
};

export type OpsIntegrity = {
  ok: boolean;
  checkedAt: string;
  messages: string[];
};

export type OpsStatus = {
  healthy: boolean;
  schemaVersion: number;
  sqliteVersion: string;
  databaseBytes: number;
  backupDir: string;
  backups: OpsBackup[];
  settings: OpsSettings;
  features: FeatureFlag[];
  demo: { enabled: boolean; users: number; projects: number };
  counts: {
    users: number;
    projects: number;
    sessions: number;
    activities: number;
    auditEntries: number;
  };
  pendingRestore: string | null;
};

export type UserDataExport = {
  generatedAt: string;
  user: Record<string, unknown>;
  preferences: Record<string, unknown> | null;
  ownedProjects: Record<string, unknown>[];
  memberships: Record<string, unknown>[];
  assignedTasks: Record<string, unknown>[];
  comments: Record<string, unknown>[];
  activities: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
  tokens: Record<string, unknown>[];
  webhooks: Record<string, unknown>[];
  notifications: Record<string, unknown>[];
  auditEntries: Record<string, unknown>[];
  attachments: Record<string, unknown>[];
};

// ---------------------------------------------------------------------------
// Enterprise module (schema v15)
// ---------------------------------------------------------------------------

export type GoalLevel = 'company' | 'department' | 'workspace' | 'project';
export type GoalStatus = 'active' | 'locked' | 'archived';
export type GoalUpdateMode = 'manual' | 'linked';

export type KeyResult = {
  id: string;
  goalId: string;
  title: string;
  unit: string;
  baseline: number | null;
  target: number | null;
  actual: number | null;
  weight: number;
  updateMode: GoalUpdateMode;
  progress: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type GoalLink = {
  id: string;
  goalId: string;
  keyResultId: string | null;
  projectId: string;
  projectName: string;
  taskId: string | null;
  taskTitle: string | null;
  milestoneId: string | null;
  milestoneTitle: string | null;
  createdAt: string;
};

export type Goal = {
  id: string;
  workspaceId: string;
  parentId: string | null;
  level: GoalLevel;
  projectId: string | null;
  title: string;
  description: string;
  ownerId: string | null;
  ownerName: string | null;
  weight: number;
  period: string;
  baseline: number | null;
  target: number | null;
  actual: number | null;
  unit: string;
  updateMode: GoalUpdateMode;
  status: GoalStatus;
  progress: number;
  keyResults: KeyResult[];
  links: GoalLink[];
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type GoalTree = {
  goals: Goal[];
  roots: string[];
};

export type GoalImpact = {
  goalId: string;
  expectedVersion: number;
  changes: Record<string, unknown>;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  affectedProjects: { id: string; name: string }[];
  affectedTasks: number;
  affectedMilestones: number;
  affectedGoals: { id: string; title: string }[];
  owners: UserOption[];
  risk: 'low' | 'medium' | 'high';
  requiresConfirmationFrom: UserOption[];
  generatedAt: string;
};

export type PortfolioFactor = {
  key: string;
  label: string;
  weight: number;
  direction: 'positive' | 'negative';
};

export type PortfolioConfig = {
  id: string;
  workspaceId: string;
  name: string;
  weights: PortfolioFactor[];
  version: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type PortfolioFactorValue = {
  key: string;
  value: number | null;
};

export type PortfolioScore = {
  id: string;
  projectId: string;
  projectName: string;
  projectStatus: ProjectStatus;
  configId: string;
  factors: PortfolioFactorValue[];
  missing: string[];
  score: number | null;
  overrideScore: number | null;
  overrideReason: string | null;
  effectiveScore: number | null;
  scoredAt: string;
  version: number;
};

export type DependencyType = 'FS' | 'SS' | 'FF' | 'SF';

export type TaskDependency = {
  id: string;
  projectId: string | null;
  predecessorId: string;
  predecessorTitle: string;
  predecessorProjectId: string;
  successorId: string;
  successorTitle: string;
  successorProjectId: string;
  type: DependencyType;
  lagDays: number;
  crossProject: boolean;
  createdAt: string;
};

export type CriticalPathNode = {
  taskId: string;
  title: string;
  projectId: string;
  projectName: string;
  earliestStart: string;
  earliestFinish: string;
  latestStart: string;
  latestFinish: string;
  floatDays: number;
  critical: boolean;
};

export type CriticalPath = {
  projectId: string;
  nodes: CriticalPathNode[];
  chain: string[];
  estimatedCompletion: string | null;
  cycles: string[][];
};

export type TimeLog = {
  id: string;
  taskId: string;
  taskTitle: string;
  userId: string | null;
  userName: string;
  minutes: number;
  workDate: string;
  note: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type TimeSummary = {
  taskId: string;
  estimateHours: number | null;
  actualMinutes: number;
  actualHours: number;
  varianceHours: number | null;
  logs: TimeLog[];
};

export type TaskBlocker = {
  id: string;
  taskId: string;
  taskTitle: string;
  reason: string;
  category: 'external' | 'decision' | 'environment' | 'data' | 'dependency' | 'other';
  ownerTeam: string;
  expectedResolveAt: string | null;
  status: 'open' | 'resolved';
  resolvedAt: string | null;
  resolvedByName: string | null;
  evidence: string;
  createdByName: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type BlockerReport = {
  open: number;
  resolved: number;
  blockedDays: number;
  byCategory: { category: string; count: number }[];
};

export type RecurrenceRule = {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId: string | null;
  rule: string;
  timezone: string;
  startsOn: string;
  endsOn: string | null;
  count: number | null;
  exceptions: string[];
  holidays: string[];
  lastGeneratedOn: string | null;
  active: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type RecurrenceRunResult = {
  generated: { date: string; taskId: string }[];
  skipped: string[];
  nextOccurrence: string | null;
};

export type AutomationTrigger =
  | 'task.created'
  | 'task.updated'
  | 'task.completed'
  | 'blocker.created'
  | 'dependency.created';

export type AutomationCondition = {
  field: string;
  operator: 'eq' | 'neq' | 'in' | 'contains' | 'exists';
  value?: string | number | boolean | string[] | null;
};

export type AutomationAction = {
  type: 'set_status' | 'set_priority' | 'assign_to' | 'add_comment' | 'create_task' | 'notify';
  value?: string;
  title?: string;
};

export type AutomationRule = {
  id: string;
  workspaceId: string;
  projectId: string | null;
  name: string;
  trigger: AutomationTrigger;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
  active: boolean;
  maxRunsPerHour: number;
  createdById: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type AutomationRun = {
  id: string;
  ruleId: string;
  ruleName: string;
  eventKey: string;
  mode: 'live' | 'dry_run' | 'replay';
  trigger: string;
  status: 'ok' | 'skipped' | 'failed';
  output: unknown;
  error: string | null;
  durationMs: number;
  replayOf: string | null;
  createdAt: string;
};

export type AutomationPreview = {
  matched: boolean;
  blockedReason: string | null;
  actions: { type: string; description: string }[];
  runs: AutomationRun[];
};

export type DocumentStatus = 'draft' | 'review' | 'published' | 'expired' | 'archived';
export type DocumentConfidentiality = 'internal' | 'restricted' | 'confidential';

export type ProjectDocument = {
  id: string;
  projectId: string;
  workspaceId: string | null;
  title: string;
  content: string;
  format: 'markdown' | 'text';
  status: DocumentStatus;
  ownerId: string | null;
  ownerName: string | null;
  confidentiality: DocumentConfidentiality;
  reviewDueAt: string | null;
  reviewCycleDays: number | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type DocumentVersion = {
  id: string;
  documentId: string;
  version: number;
  title: string;
  content: string;
  changeSummary: string;
  createdByName: string | null;
  createdAt: string;
};

export type DecisionStatus = 'proposed' | 'approved' | 'rejected' | 'superseded';

export type DecisionOption = {
  title: string;
  pros?: string;
  cons?: string;
};

export type DecisionRecord = {
  id: string;
  workspaceId: string;
  projectId: string | null;
  projectName: string | null;
  title: string;
  status: DecisionStatus;
  context: string;
  options: DecisionOption[];
  decision: string;
  consequences: string;
  decidedByName: string | null;
  reviewAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type DecisionVersion = {
  id: string;
  decisionId: string;
  version: number;
  snapshot: Record<string, unknown>;
  changeSummary: string;
  changedByName: string | null;
  createdAt: string;
};

export type MetricDefinition = {
  id: string;
  workspaceId: string;
  name: string;
  unit: string;
  formula: string;
  dimensions: string[];
  aggregation: string;
  source: string;
  refreshMinutes: number;
  ownerId: string | null;
  ownerName: string | null;
  status: 'draft' | 'published' | 'archived';
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type MetricPoint = {
  bucket: string;
  value: number | null;
};

export type MetricEvaluation = {
  metricId: string;
  name: string;
  unit: string;
  from: string;
  to: string;
  value: number | null;
  series: MetricPoint[];
  dependencies: string[];
  warnings: string[];
  refreshMinutes: number;
  source: string;
};

export type ProjectBudget = {
  id: string;
  projectId: string;
  projectName: string;
  costCenter: string;
  currency: CurrencyCode;
  budgetCents: number;
  committedCents: number;
  actualCents: number;
  forecastCents: number;
  fxRate: number;
  fxDate: string | null;
  thresholdPct: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type BudgetEntry = {
  id: string;
  budgetId: string;
  kind: 'committed' | 'actual' | 'forecast';
  amountCents: number;
  currency: CurrencyCode;
  fxRate: number;
  fxDate: string | null;
  note: string;
  createdAt: string;
};

export type BudgetSummary = {
  budget: ProjectBudget;
  entries: BudgetEntry[];
  remainingCents: number;
  burnPct: number;
  forecastRemainingCents: number;
  thresholdReached: boolean;
};

export type PermissionSimulationInput = {
  userId: string;
  resourceType: 'workspace' | 'project' | 'task';
  resourceId: string;
  action: string;
};

export type PermissionSource = {
  source: 'role' | 'custom_role' | 'jit';
  label: string;
  grants: string[];
};

export type PermissionSimulationResult = {
  allowed: boolean;
  reason: string;
  effectivePermissions: Permission[];
  sources: PermissionSource[];
  conflicts: string[];
  resourceLabel: string | null;
};

export type JitGrant = {
  id: string;
  workspaceId: string;
  userId: string;
  userName: string;
  resourceType: 'workspace' | 'project' | 'task';
  resourceId: string;
  action: string;
  permissions: Permission[];
  reason: string;
  status: 'pending' | 'active' | 'rejected' | 'revoked' | 'expired';
  requestedByName: string | null;
  approvedByName: string | null;
  startsAt: string;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
  updatedAt: string;
  usedCount?: number;
  postReviewRequired?: boolean;
  postReviewedBy?: string | null;
  postReviewedAt?: string | null;
  emergency?: boolean;
};

/** Generic shape for the schema-v16 workbench resources. */
export type DomainRecord = { id: string } & Record<string, unknown>;

export type DomainList = {
  items: DomainRecord[];
  total: number;
};

export type WorkflowRunResult = {
  run: DomainRecord;
  events: DomainRecord[];
  status: 'completed' | 'waiting' | 'failed';
  error?: string;
};

export type PermissionSample = {
  id: string;
  workspaceId: string;
  name: string;
  userId: string;
  resourceType: string;
  resourceId: string;
  action: string;
  expectedAllow: boolean;
  lastResult?: { allowed: boolean; passed: boolean; reason: string } | null;
  createdAt: string;
};

export type CapacityRow = {
  userId: string;
  userName: string;
  role: string;
  skills: string[];
  weeklyHours: number;
  fte: number;
  supplyHours: number;
  allocatedHours: number;
  leaveHours: number;
  gapHours: number;
  overloaded: boolean;
};

export type ApprovalMetrics = {
  total: number;
  approved: number;
  rejected: number;
  pending: number;
  averageHours: number;
  overdueRate: number;
  returnRate: number;
  byStep: { step: number; label: string; averageHours: number; decisions: number }[];
  lowSample: boolean;
};
