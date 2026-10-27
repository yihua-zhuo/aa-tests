import { z } from '@hono/zod-openapi';
import {
  AccountDeleteSchema,
  ActivityQuerySchema,
  AnomalyDetectSchema,
  AnomalyDismissSchema,
  ApprovalCreateSchema,
  ApprovalDecisionSchema,
  ApprovalMetricsQuerySchema,
  ApprovalRoutingRuleCreateSchema,
  ApprovalWithdrawSchema,
  AttachmentDownloadQuerySchema,
  AuditCleanupSchema,
  AuditQuerySchema,
  AutomationDryRunSchema,
  AutomationPruneSchema,
  AutomationQuerySchema,
  AutomationRollbackSchema,
  AutomationRuleCreateSchema,
  AutomationRuleUpdateSchema,
  AutomationRunsQuerySchema,
  BackgroundJobCreateSchema,
  BackgroundJobTickSchema,
  BaselineCreateSchema,
  BaselineDecisionSchema,
  BenefitRecordSchema,
  BlockerCreateSchema,
  BlockerQuerySchema,
  BlockerResolveSchema,
  BudgetApprovalSchema,
  BudgetCategoryCreateSchema,
  BudgetCategoryUpdateSchema,
  BudgetEntryCreateSchema,
  BudgetUpsertSchema,
  CapacityPlanSchema,
  CapacityProfileUpdateSchema,
  CapacityQuerySchema,
  CapacityScenarioSchema,
  ChangeRequestCommentSchema,
  ChangeRequestDecisionSchema,
  ChangeRequestImplementSchema,
  ChannelMessageCreateSchema,
  ChannelMessageUpdateSchema,
  ChannelSearchQuerySchema,
  ClosureCreateSchema,
  ClosureReopenSchema,
  CommentCreateSchema,
  CommentQuerySchema,
  ConnectorCallSchema,
  ConnectorOAuthCallbackSchema,
  ConnectorOAuthStartSchema,
  ConnectorRotateSchema,
  CustomRoleCreateSchema,
  CustomRoleUpdateSchema,
  DecisionCreateSchema,
  DecisionQuerySchema,
  DecisionUpdateSchema,
  DeliverableReviewSchema,
  DeliverableVersionCreateSchema,
  DepartmentCreateSchema,
  DependencyCreateSchema,
  DispatchAcceptSchema,
  DispatchBatchSchema,
  DispatchRecommendSchema,
  DocumentCommentCreateSchema,
  DocumentCommentResolveSchema,
  DocumentCreateSchema,
  DocumentDiffQuerySchema,
  DocumentQuerySchema,
  DocumentRestoreSchema,
  DocumentUpdateSchema,
  EmailChangeSchema,
  ErrorSchema,
  EstimateScaleCreateSchema,
  EventPublishSchema,
  EventSubscriptionCreateSchema,
  FormValuesPutSchema,
  FunnelQuerySchema,
  GateDecisionSchema,
  GoalCreateSchema,
  GoalImpactSchema,
  GoalLinkCreateSchema,
  GoalQuerySchema,
  GoalUpdateSchema,
  HandoffCreateSchema,
  HandoffDecisionSchema,
  HealthConfigSchema,
  JitGrantCreateSchema,
  JitPostReviewSchema,
  JitQuerySchema,
  JitUsageSchema,
  KeyResultCreateSchema,
  KeyResultUpdateSchema,
  KnowledgeGraphQuerySchema,
  KnowledgeLinkCreateSchema,
  KnowledgeSearchQuerySchema,
  KnowledgeSynonymCreateSchema,
  LineageCreateSchema,
  LoginSchema,
  MeetingActionConvertSchema,
  MeetingCompleteSchema,
  MetricCreateSchema,
  MetricEvaluateSchema,
  MetricQuerySchema,
  MetricsImportSchema,
  MetricsQuerySchema,
  MetricUpdateSchema,
  MfaDisableSchema,
  MfaEnableSchema,
  MfaLoginSchema,
  MilestoneCreateSchema,
  NotificationQuerySchema,
  NotificationReadSchema,
  OpsDemoDataSchema,
  OpsFeatureUpdateSchema,
  OpsRestoreSchema,
  OpsSettingsUpdateSchema,
  OrganizationCreateSchema,
  OrgMembershipCreateSchema,
  PasswordChangeSchema,
  PasswordResetConfirmSchema,
  PasswordResetRequestSchema,
  PasswordResetSchema,
  PermissionSampleRunSchema,
  PermissionSimulateSchema,
  PlaybookFeedbackSchema,
  PortalAccountCreateSchema,
  PortalCreateSchema,
  PortalDeliveryConfirmSchema,
  PortalInternalCommentSchema,
  PortalRequestCommentSchema,
  PortalRequestCreateSchema,
  PortalRequestUpdateSchema,
  PortfolioConfigCreateSchema,
  PortfolioConfigUpdateSchema,
  PortfolioQuerySchema,
  PortfolioScoreSchema,
  PreferencesUpdateSchema,
  ProfileUpdateSchema,
  ProjectBatchSchema,
  ProjectCreateSchema,
  ProjectDuplicateSchema,
  ProjectQuerySchema,
  ProjectUpdateSchema,
  PushSubscribeSchema,
  PushUnsubscribeSchema,
  QualityBatchFixSchema,
  QualityFixSchema,
  QualityRevertSchema,
  QualityScanSchema,
  QueryPreviewSchema,
  RangeQuerySchema,
  RecurrenceCreateSchema,
  RecurrenceRunSchema,
  RecurrenceSkipSchema,
  RecurrenceUpdateSchema,
  ReportExportQuerySchema,
  ReportSubscriptionCreateSchema,
  SandboxRunSchema,
  SavedReportCreateSchema,
  SavedReportUpdateSchema,
  SavedViewCreateSchema,
  SavedViewUpdateSchema,
  ScenarioCompareSchema,
  SearchQuerySchema,
  SlaTickSchema,
  TaskCreateSchema,
  TaskEstimateSchema,
  TaskSlaActionSchema,
  TaskSlaAttachSchema,
  TaskTemplateApplySchema,
  TaskTemplateCreateSchema,
  TaskTreeBulkSchema,
  TaskUpdateSchema,
  TemplateApplySchema,
  TimeLogCreateSchema,
  TimeLogQuerySchema,
  TimeLogUpdateSchema,
  TimeSummaryQuerySchema,
  TokenCreateSchema,
  TriggerFireSchema,
  UserCreateSchema,
  UserQuerySchema,
  UserUpdateSchema,
  WebhookCreateSchema,
  WebhookUpdateSchema,
  WorkbenchCreateSchema,
  WorkbenchQuerySchema,
  WorkbenchUpdateSchema,
  WorkflowPublishSchema,
  WorkflowReplaySchema,
  WorkflowRetryNodeSchema,
  WorkflowRollbackSchema,
  WorkflowRunStartSchema,
  WorkflowTestSchema,
  WorkspaceCreateSchema,
  WorkspaceMemberCreateSchema,
  WorkspaceRenameSchema,
  WorkspaceSwitchSchema,
  WorkspaceUpdateSchema,
} from '../shared/schemas.ts';
import { WORKBENCH_TAGS } from './domain/registry.ts';

type JsonObject = Record<string, unknown>;
type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';
type BodyDoc = { name: string; schema: z.ZodType; contentType?: string };

type OperationDoc = {
  summary: string;
  tags: string[];
  /** Public endpoints omit the session cookie requirement. */
  public?: boolean;
  /** Endpoints that reject personal access tokens and require a cookie session. */
  sessionOnly?: boolean;
  query?: z.ZodType;
  body?: BodyDoc;
  /** Response bodies that are not JSON, e.g. CSV or SSE. */
  produces?: { contentType: string; description?: string };
};

const TAGS: Record<string, string> = {
  meta: '健康检查、指标与 API 文档',
  auth: '登录、会话与密码重置',
  dashboard: '总览指标',
  analytics: '分析报表',
  projects: '项目与回收站',
  tasks: '任务、子任务与里程碑',
  comments: '项目与任务评论',
  notifications: '站内通知与已读状态',
  activities: '活动流',
  search: '全局搜索',
  users: '成员管理',
  settings: '个人资料、MFA 与会话',
  audit: '审计日志与保留期',
  ops: '管理员运维面板',
  integrations: '个人访问令牌与 Webhook',
  realtime: '实时事件',
  strategy: '目标、关键结果与项目组合评分',
  planning: '依赖、关键路径、工时、阻塞与重复任务',
  automation: '自动化规则、试运行与执行记录',
  knowledge: '项目文档与决策记录',
  insights: '指标定义、计算与项目预算',
  governance: '权限模拟与临时授权',
  workbench: '通用企业领域资源（阶段门、执行、协作、工作流、分析与组织）',
  ...WORKBENCH_TAGS,
};

const PortfolioScoreQuerySchema = PortfolioQuerySchema.extend({
  configId: z.string().uuid(),
});
const BlockerStatusQuerySchema = BlockerQuerySchema.omit({ projectId: true });
const DocumentListQuerySchema = DocumentQuerySchema.omit({ projectId: true });

const OPERATIONS: Record<string, Partial<Record<Method, OperationDoc>>> = {
  '/api/health': {
    get: { summary: '存活检查（不访问数据库）', tags: ['meta'], public: true },
  },
  '/api/health/ready': {
    get: { summary: '就绪检查（数据库与关闭标记，失败返回 503）', tags: ['meta'], public: true },
  },
  '/metrics': {
    get: { summary: 'Prometheus 指标', tags: ['meta'], public: true },
  },
  '/api/openapi.json': {
    get: { summary: '本 OpenAPI 文档', tags: ['meta'], public: true },
  },
  '/api/doc': {
    get: {
      summary: 'Scalar 交互式 API 文档',
      tags: ['meta'],
      public: true,
      produces: { contentType: 'text/html' },
    },
  },
  '/api/auth/login': {
    post: {
      summary: '使用邮箱与密码登录',
      tags: ['auth'],
      public: true,
      body: { name: 'Login', schema: LoginSchema },
    },
  },
  '/api/auth/logout': {
    post: { summary: '结束当前会话', tags: ['auth'], public: true },
  },
  '/api/auth/me': {
    get: { summary: '当前用户与偏好', tags: ['auth'] },
  },
  '/api/auth/demo-users': {
    get: { summary: '演示账号列表（Demo 模式）', tags: ['auth'], public: true },
  },
  '/api/auth/mfa': {
    post: {
      summary: '使用 MFA 票据与验证码完成登录',
      tags: ['auth'],
      public: true,
      body: { name: 'MfaLogin', schema: MfaLoginSchema },
    },
  },
  '/api/auth/password-reset/request': {
    post: {
      summary: '申请密码重置令牌',
      tags: ['auth'],
      public: true,
      body: { name: 'PasswordResetRequest', schema: PasswordResetRequestSchema },
    },
  },
  '/api/auth/password-reset/confirm': {
    post: {
      summary: '使用令牌重置密码',
      tags: ['auth'],
      public: true,
      body: { name: 'PasswordResetConfirm', schema: PasswordResetConfirmSchema },
    },
  },
  '/api/dashboard/summary': {
    get: {
      summary: 'Overview KPI、收入、渠道、项目概览与近期活动',
      tags: ['dashboard'],
      query: RangeQuerySchema,
    },
  },
  '/api/analytics/revenue': {
    get: {
      summary: '收入时间序列与上一周期对比',
      tags: ['analytics'],
      query: RangeQuerySchema.extend({ compare: z.enum(['0', '1']).optional() }),
    },
  },
  '/api/analytics/channels': {
    get: { summary: '渠道份额与环比', tags: ['analytics'], query: RangeQuerySchema },
  },
  '/api/analytics/audience': {
    get: { summary: '客户与转化指标', tags: ['analytics'], query: RangeQuerySchema },
  },
  '/api/analytics/projects': {
    get: { summary: '项目状态分布', tags: ['analytics'] },
  },
  '/api/workspace': {
    get: { summary: '工作区币种与汇率', tags: ['analytics'] },
    patch: {
      summary: '修改展示币种或汇率（管理员）',
      tags: ['analytics'],
      body: { name: 'WorkspaceUpdate', schema: WorkspaceUpdateSchema },
    },
  },
  '/api/analytics/sources': {
    get: { summary: '指标数据源覆盖范围', tags: ['analytics'] },
  },
  '/api/analytics/metrics': {
    get: {
      summary: '原始日指标（管理员）',
      tags: ['analytics'],
      query: MetricsQuerySchema,
    },
    post: {
      summary: '通过 API 导入日指标（管理员）',
      tags: ['analytics'],
      body: { name: 'MetricsImport', schema: MetricsImportSchema },
    },
  },
  '/api/analytics/import': {
    post: {
      summary: '导入指标文件（multipart 字段 file，支持 CSV / JSON）',
      tags: ['analytics'],
      body: {
        name: 'MetricsImportForm',
        contentType: 'multipart/form-data',
        schema: z.object({ file: z.string() }),
      },
    },
  },
  '/api/analytics/export.csv': {
    get: {
      summary: '导出收入、渠道或受众分析 CSV',
      tags: ['analytics'],
      query: ReportExportQuerySchema,
      produces: { contentType: 'text/csv' },
    },
  },
  '/api/analytics/reports': {
    get: { summary: '当前用户的保存报表', tags: ['analytics'] },
    post: {
      summary: '保存分析报表并设置定时邮件',
      tags: ['analytics'],
      body: { name: 'SavedReportCreate', schema: SavedReportCreateSchema },
    },
  },
  '/api/analytics/reports/{id}': {
    patch: {
      summary: '更新保存报表或频率',
      tags: ['analytics'],
      body: { name: 'SavedReportUpdate', schema: SavedReportUpdateSchema },
    },
    delete: { summary: '删除保存报表', tags: ['analytics'] },
  },
  '/api/analytics/reports/{id}/export.csv': {
    get: {
      summary: '按保存报表配置导出 CSV',
      tags: ['analytics'],
      produces: { contentType: 'text/csv' },
    },
  },
  '/api/projects': {
    get: {
      summary: '项目列表（筛选、标签、截止日、收藏、分页与状态计数）',
      tags: ['projects'],
      query: ProjectQuerySchema,
    },
    post: {
      summary: '创建项目',
      tags: ['projects'],
      body: { name: 'ProjectCreate', schema: ProjectCreateSchema },
    },
  },
  '/api/projects/batch': {
    post: {
      summary: '批量修改项目状态、负责人或归档',
      tags: ['projects'],
      body: { name: 'ProjectBatch', schema: ProjectBatchSchema },
    },
  },
  '/api/projects/{id}/favorite': {
    post: { summary: '收藏项目', tags: ['projects'] },
    delete: { summary: '取消收藏项目', tags: ['projects'] },
  },
  '/api/saved-views': {
    get: { summary: '当前用户保存的项目视图', tags: ['projects'] },
    post: {
      summary: '保存当前项目筛选为视图（每人最多 20 个）',
      tags: ['projects'],
      body: { name: 'SavedViewCreate', schema: SavedViewCreateSchema },
    },
  },
  '/api/saved-views/{id}': {
    patch: {
      summary: '重命名或更新保存视图',
      tags: ['projects'],
      body: { name: 'SavedViewUpdate', schema: SavedViewUpdateSchema },
    },
    delete: { summary: '删除保存视图', tags: ['projects'] },
  },
  '/api/project-templates': {
    get: { summary: '内置项目模板（里程碑与任务结构）', tags: ['projects'] },
  },
  '/api/projects/from-template': {
    post: {
      summary: '从模板创建项目、里程碑与任务',
      tags: ['projects'],
      body: { name: 'TemplateApply', schema: TemplateApplySchema },
    },
  },
  '/api/projects/{id}/duplicate': {
    post: {
      summary: '复制项目（成员、里程碑、任务与日期偏移）',
      tags: ['projects'],
      body: { name: 'ProjectDuplicate', schema: ProjectDuplicateSchema },
    },
  },
  '/api/projects/export.csv': {
    get: {
      summary: '按权限范围导出项目 CSV',
      tags: ['projects'],
      query: ProjectQuerySchema,
      produces: { contentType: 'text/csv' },
    },
  },
  '/api/projects/import': {
    post: {
      summary: '导入项目（multipart 字段 file，支持 CSV / JSON）',
      tags: ['projects'],
      body: {
        name: 'ProjectImportForm',
        contentType: 'multipart/form-data',
        schema: z.object({ file: z.string() }),
      },
    },
  },
  '/api/projects/{id}/attachments': {
    get: { summary: '项目附件列表与签名下载链接', tags: ['projects'] },
    post: {
      summary: '上传项目附件（multipart 字段 file，最大 10MB，类型与病毒特征校验）',
      tags: ['projects'],
      body: {
        name: 'AttachmentUploadForm',
        contentType: 'multipart/form-data',
        schema: z.object({ file: z.string() }),
      },
    },
  },
  '/api/projects/{id}/attachments/{attachmentId}': {
    delete: { summary: '删除项目附件（上传者或项目管理者）', tags: ['projects'] },
  },
  '/files/attachments/{id}': {
    get: {
      summary: '使用签名链接下载附件（无需会话，链接 10 分钟内有效）',
      tags: ['projects'],
      public: true,
      query: AttachmentDownloadQuerySchema,
      produces: { contentType: 'application/octet-stream' },
    },
  },
  '/api/projects/trash': {
    get: { summary: '回收站项目（管理员）', tags: ['projects'] },
  },
  '/api/projects/{id}': {
    get: { summary: '项目详情', tags: ['projects'] },
    patch: {
      summary: '更新项目（乐观锁）',
      tags: ['projects'],
      body: { name: 'ProjectUpdate', schema: ProjectUpdateSchema },
    },
    delete: { summary: '软删除项目（移入回收站）', tags: ['projects'] },
  },
  '/api/projects/{id}/restore': {
    post: { summary: '从回收站恢复项目', tags: ['projects'] },
  },
  '/api/projects/{id}/purge': {
    delete: { summary: '永久删除项目（管理员）', tags: ['projects'] },
  },
  '/api/projects/{id}/tasks': {
    get: { summary: '项目的任务、里程碑与完成度', tags: ['tasks'] },
    post: {
      summary: '创建任务或子任务',
      tags: ['tasks'],
      body: { name: 'TaskCreate', schema: TaskCreateSchema },
    },
  },
  '/api/tasks/{id}': {
    patch: {
      summary: '更新任务（乐观锁）',
      tags: ['tasks'],
      body: { name: 'TaskUpdate', schema: TaskUpdateSchema },
    },
    delete: { summary: '删除任务及其子任务', tags: ['tasks'] },
  },
  '/api/projects/{id}/milestones': {
    post: {
      summary: '创建里程碑',
      tags: ['tasks'],
      body: { name: 'MilestoneCreate', schema: MilestoneCreateSchema },
    },
  },
  '/api/milestones/{id}': {
    delete: { summary: '删除里程碑（任务保留并解除关联）', tags: ['tasks'] },
  },
  '/api/projects/{id}/comments': {
    get: {
      summary: '项目或任务的评论',
      tags: ['comments'],
      query: CommentQuerySchema,
    },
    post: {
      summary: '发表评论并 @提及项目成员',
      tags: ['comments'],
      body: { name: 'CommentCreate', schema: CommentCreateSchema },
    },
  },
  '/api/comments/{id}': {
    delete: { summary: '删除自己的评论（管理者可删除任意评论）', tags: ['comments'] },
  },
  '/api/notifications': {
    get: {
      summary: '当前用户的通知与未读数',
      tags: ['notifications'],
      query: NotificationQuerySchema,
    },
  },
  '/api/push': {
    get: { summary: '浏览器推送状态与 VAPID 公钥', tags: ['notifications'] },
  },
  '/api/push/subscribe': {
    post: {
      summary: '登记浏览器推送订阅',
      tags: ['notifications'],
      body: { name: 'PushSubscribe', schema: PushSubscribeSchema },
    },
    delete: {
      summary: '移除当前用户的推送订阅',
      tags: ['notifications'],
      body: { name: 'PushUnsubscribe', schema: PushUnsubscribeSchema },
    },
  },
  '/api/notifications/read': {
    post: {
      summary: '标记通知为已读（按 ID 或全部）',
      tags: ['notifications'],
      body: { name: 'NotificationRead', schema: NotificationReadSchema },
    },
  },
  '/api/activities': {
    get: { summary: '活动流（seq 游标分页）', tags: ['activities'], query: ActivityQuerySchema },
  },
  '/api/search': {
    get: { summary: '全局搜索（按权限范围）', tags: ['search'], query: SearchQuerySchema },
  },
  '/api/users': {
    get: { summary: '用户列表（管理员 / 业务经理）', tags: ['users'], query: UserQuerySchema },
    post: {
      summary: '创建用户（管理员）',
      tags: ['users'],
      body: { name: 'UserCreate', schema: UserCreateSchema },
    },
  },
  '/api/users/options': {
    get: { summary: '成员选择器（最小字段，限当前工作区）', tags: ['users'] },
  },
  '/api/workspaces': {
    get: { summary: '工作区列表与成员 / 项目计数（管理员）', tags: ['users'] },
    post: {
      summary: '创建工作区（管理员）',
      tags: ['users'],
      body: { name: 'WorkspaceCreate', schema: WorkspaceCreateSchema },
    },
  },
  '/api/workspaces/{id}': {
    patch: {
      summary: '重命名工作区（管理员）',
      tags: ['users'],
      body: { name: 'WorkspaceRename', schema: WorkspaceRenameSchema },
    },
  },
  '/api/custom-roles': {
    get: { summary: '当前工作区的自定义角色', tags: ['users'] },
    post: {
      summary: '创建自定义角色（管理员）',
      tags: ['users'],
      body: { name: 'CustomRoleCreate', schema: CustomRoleCreateSchema },
    },
  },
  '/api/custom-roles/{id}': {
    patch: {
      summary: '更新自定义角色名称、基础角色或附加权限（管理员）',
      tags: ['users'],
      body: { name: 'CustomRoleUpdate', schema: CustomRoleUpdateSchema },
    },
    delete: { summary: '删除自定义角色并解除成员绑定（管理员）', tags: ['users'] },
  },
  '/api/users/{id}/avatar': {
    get: {
      summary: '用户头像图片（需登录，PNG / JPEG / GIF / WebP）',
      tags: ['users'],
      produces: { contentType: 'image/png' },
    },
  },
  '/api/users/{id}': {
    patch: {
      summary: '更新用户角色 / 状态（管理员）',
      tags: ['users'],
      body: { name: 'UserUpdate', schema: UserUpdateSchema },
    },
  },
  '/api/users/{id}/reset-password': {
    post: {
      summary: '重置为一次性临时密码（管理员）',
      tags: ['users'],
      body: { name: 'PasswordReset', schema: PasswordResetSchema },
    },
  },
  '/api/profile': {
    get: { summary: '个人资料', tags: ['settings'] },
    patch: {
      summary: '更新个人资料',
      tags: ['settings'],
      body: { name: 'ProfileUpdate', schema: ProfileUpdateSchema },
    },
  },
  '/api/profile/avatar': {
    post: {
      summary: '上传头像（multipart 字段 file，最大 2MB，仅图片）',
      tags: ['settings'],
      body: {
        name: 'AvatarUploadForm',
        contentType: 'multipart/form-data',
        schema: z.object({ file: z.string() }),
      },
    },
    delete: { summary: '移除头像', tags: ['settings'] },
  },
  '/api/profile/email': {
    post: {
      summary: '修改登录邮箱',
      tags: ['settings'],
      sessionOnly: true,
      body: { name: 'EmailChange', schema: EmailChangeSchema },
    },
  },
  '/api/profile/delete': {
    post: {
      summary: '注销当前账号并转交项目',
      tags: ['settings'],
      sessionOnly: true,
      body: { name: 'AccountDelete', schema: AccountDeleteSchema },
    },
  },
  '/api/profile/password': {
    post: {
      summary: '修改密码并吊销其他会话',
      tags: ['settings'],
      sessionOnly: true,
      body: { name: 'PasswordChange', schema: PasswordChangeSchema },
    },
  },
  '/api/profile/mfa': {
    get: { summary: 'MFA 状态', tags: ['settings'], sessionOnly: true },
  },
  '/api/profile/mfa/setup': {
    post: { summary: '生成 MFA 密钥与恢复码', tags: ['settings'], sessionOnly: true },
  },
  '/api/profile/mfa/enable': {
    post: {
      summary: '验证并启用 MFA',
      tags: ['settings'],
      sessionOnly: true,
      body: { name: 'MfaEnable', schema: MfaEnableSchema },
    },
  },
  '/api/profile/mfa/disable': {
    post: {
      summary: '关闭 MFA',
      tags: ['settings'],
      sessionOnly: true,
      body: { name: 'MfaDisable', schema: MfaDisableSchema },
    },
  },
  '/api/preferences': {
    get: { summary: '读取偏好', tags: ['settings'] },
    patch: {
      summary: '更新偏好',
      tags: ['settings'],
      body: { name: 'PreferencesUpdate', schema: PreferencesUpdateSchema },
    },
  },
  '/api/sessions': {
    get: { summary: '当前用户的活跃会话', tags: ['settings'], sessionOnly: true },
  },
  '/api/sessions/{id}': {
    delete: { summary: '吊销指定会话', tags: ['settings'], sessionOnly: true },
  },
  '/api/sessions/revoke-others': {
    post: { summary: '吊销除当前会话外的所有会话', tags: ['settings'], sessionOnly: true },
  },
  '/api/audit': {
    get: {
      summary: '审计日志（管理员：筛选、分页与动作统计）',
      tags: ['audit'],
      query: AuditQuerySchema,
    },
  },
  '/api/audit/export.csv': {
    get: {
      summary: '导出筛选后的审计日志 CSV（管理员）',
      tags: ['audit'],
      query: AuditQuerySchema,
      produces: { contentType: 'text/csv' },
    },
  },
  '/api/audit/cleanup': {
    post: {
      summary: '清理早于保留期的审计日志（管理员）',
      tags: ['audit'],
      body: { name: 'AuditCleanup', schema: AuditCleanupSchema },
    },
  },
  '/api/ops': {
    get: {
      summary: '运维概览：数据库、备份、保留期与功能开关（管理员）',
      tags: ['ops'],
      sessionOnly: true,
    },
  },
  '/api/ops/integrity': {
    get: { summary: '执行 SQLite integrity_check（管理员）', tags: ['ops'], sessionOnly: true },
  },
  '/api/ops/backups': {
    post: { summary: '立即创建一致性备份（管理员）', tags: ['ops'], sessionOnly: true },
  },
  '/api/ops/restore': {
    post: {
      summary: '校验并排队恢复备份，重启后生效（管理员）',
      tags: ['ops'],
      sessionOnly: true,
      body: { name: 'OpsRestore', schema: OpsRestoreSchema },
    },
  },
  '/api/ops/settings': {
    patch: {
      summary: '更新备份、回收站、审计与活动保留期（管理员）',
      tags: ['ops'],
      sessionOnly: true,
      body: { name: 'OpsSettingsUpdate', schema: OpsSettingsUpdateSchema },
    },
  },
  '/api/ops/features/{key}': {
    patch: {
      summary: '切换功能开关（管理员）',
      tags: ['ops'],
      sessionOnly: true,
      body: { name: 'OpsFeatureUpdate', schema: OpsFeatureUpdateSchema },
    },
  },
  '/api/ops/demo-data': {
    post: {
      summary: '启用或清除演示项目数据（管理员）',
      tags: ['ops'],
      sessionOnly: true,
      body: { name: 'OpsDemoData', schema: OpsDemoDataSchema },
    },
  },
  '/api/ops/users/{id}/export': {
    get: {
      summary: '导出成员个人数据 JSON（GDPR，管理员）',
      tags: ['ops'],
      sessionOnly: true,
      produces: { contentType: 'application/json' },
    },
  },
  '/api/ops/users/{id}/erase': {
    post: { summary: '匿名化并删除成员个人数据（GDPR，管理员）', tags: ['ops'], sessionOnly: true },
  },
  '/api/profile/tokens': {
    get: { summary: '个人访问令牌列表与请求配额', tags: ['integrations'], sessionOnly: true },
    post: {
      summary: '创建个人访问令牌（明文仅返回一次）',
      tags: ['integrations'],
      sessionOnly: true,
      body: { name: 'TokenCreate', schema: TokenCreateSchema },
    },
  },
  '/api/profile/tokens/{id}': {
    delete: { summary: '吊销个人访问令牌', tags: ['integrations'], sessionOnly: true },
  },
  '/api/profile/webhooks': {
    get: { summary: 'Webhook 列表与可订阅事件', tags: ['integrations'], sessionOnly: true },
    post: {
      summary: '创建 Webhook（返回签名密钥一次）',
      tags: ['integrations'],
      sessionOnly: true,
      body: { name: 'WebhookCreate', schema: WebhookCreateSchema },
    },
  },
  '/api/profile/webhooks/{id}': {
    patch: {
      summary: '更新 Webhook 地址、事件或启停状态',
      tags: ['integrations'],
      sessionOnly: true,
      body: { name: 'WebhookUpdate', schema: WebhookUpdateSchema },
    },
    delete: { summary: '删除 Webhook 及其投递记录', tags: ['integrations'], sessionOnly: true },
  },
  '/api/profile/webhooks/{id}/deliveries': {
    get: { summary: 'Webhook 最近投递记录', tags: ['integrations'], sessionOnly: true },
  },
  '/api/events': {
    get: {
      summary: '实时事件流（SSE，按权限裁剪）',
      tags: ['realtime'],
      produces: { contentType: 'text/event-stream' },
    },
    post: {
      summary: '发布领域事件并按订阅扇出投递',
      tags: ['workflow'],
      body: { name: 'EventPublish', schema: EventPublishSchema },
    },
  },
  '/api/goals': {
    get: {
      summary: '目标树与关键结果（按项目可见范围裁剪）',
      tags: ['strategy'],
      query: GoalQuerySchema,
    },
    post: {
      summary: '创建公司 / 部门 / 工作区 / 项目级目标',
      tags: ['strategy'],
      body: { name: 'GoalCreate', schema: GoalCreateSchema },
    },
  },
  '/api/goals/{id}': {
    get: { summary: '目标详情、关键结果与关联', tags: ['strategy'] },
    patch: {
      summary: '更新目标（乐观锁，记录变更原因与前后值）',
      tags: ['strategy'],
      body: { name: 'GoalUpdate', schema: GoalUpdateSchema },
    },
    delete: { summary: '删除目标并解除子目标父级', tags: ['strategy'] },
  },
  '/api/goals/{id}/impact': {
    post: {
      summary: '预览目标变更影响、风险与需确认人员',
      tags: ['strategy'],
      body: { name: 'GoalImpact', schema: GoalImpactSchema },
    },
  },
  '/api/goals/{id}/changes': {
    get: { summary: '目标变更历史（操作人、原因、前后值）', tags: ['strategy'] },
  },
  '/api/goals/{id}/key-results': {
    post: {
      summary: '新增关键结果',
      tags: ['strategy'],
      body: { name: 'KeyResultCreate', schema: KeyResultCreateSchema },
    },
  },
  '/api/goals/{id}/key-results/{keyResultId}': {
    patch: {
      summary: '更新关键结果（乐观锁）',
      tags: ['strategy'],
      body: { name: 'KeyResultUpdate', schema: KeyResultUpdateSchema },
    },
    delete: { summary: '删除关键结果', tags: ['strategy'] },
  },
  '/api/goals/{id}/links': {
    post: {
      summary: '关联项目、任务或里程碑并自动计算进度',
      tags: ['strategy'],
      body: { name: 'GoalLinkCreate', schema: GoalLinkCreateSchema },
    },
  },
  '/api/goals/{id}/links/{linkId}': {
    delete: { summary: '解除目标关联', tags: ['strategy'] },
  },
  '/api/portfolio/configs': {
    get: { summary: '项目组合评分模板', tags: ['strategy'] },
    post: {
      summary: '创建评分模板（权重合计必须为 1）',
      tags: ['strategy'],
      body: { name: 'PortfolioConfigCreate', schema: PortfolioConfigCreateSchema },
    },
  },
  '/api/portfolio/configs/{id}': {
    patch: {
      summary: '更新评分模板（乐观锁）',
      tags: ['strategy'],
      body: { name: 'PortfolioConfigUpdate', schema: PortfolioConfigUpdateSchema },
    },
    delete: { summary: '删除评分模板及其评分', tags: ['strategy'] },
  },
  '/api/portfolio/scores': {
    get: {
      summary: '项目组合评分排行（按模板筛选）',
      tags: ['strategy'],
      query: PortfolioQuerySchema,
    },
    post: {
      summary: '按模板因子为项目评分（支持人工覆盖与理由）',
      tags: ['strategy'],
      body: { name: 'PortfolioScore', schema: PortfolioScoreSchema },
    },
  },
  '/api/portfolio/scores/{projectId}': {
    get: {
      summary: '项目在指定模板下的评分',
      tags: ['strategy'],
      query: PortfolioScoreQuerySchema,
    },
  },
  '/api/projects/{id}/dependencies': {
    get: { summary: '项目任务依赖关系', tags: ['planning'] },
    post: {
      summary: '新增 FS / SS / FF / SF 依赖并检测循环',
      tags: ['planning'],
      body: { name: 'DependencyCreate', schema: DependencyCreateSchema },
    },
  },
  '/api/projects/{id}/dependencies/{dependencyId}': {
    delete: { summary: '删除依赖关系', tags: ['planning'] },
  },
  '/api/projects/{id}/critical-path': {
    get: { summary: '关键路径、浮动时间与预计完成日期', tags: ['planning'] },
  },
  '/api/time-logs': {
    get: {
      summary: '工时记录（按任务或项目筛选）',
      tags: ['planning'],
      query: TimeLogQuerySchema,
    },
  },
  '/api/tasks/{id}/time-logs': {
    post: {
      summary: '登记工时（支持幂等键）',
      tags: ['planning'],
      body: { name: 'TimeLogCreate', schema: TimeLogCreateSchema },
    },
  },
  '/api/tasks/{id}/time-logs/{logId}': {
    patch: {
      summary: '更新工时记录（乐观锁）',
      tags: ['planning'],
      body: { name: 'TimeLogUpdate', schema: TimeLogUpdateSchema },
    },
    delete: { summary: '删除工时记录（本人或项目管理者）', tags: ['planning'] },
  },
  '/api/tasks/{id}/time-logs/summary': {
    get: { summary: '任务工时汇总与偏差', tags: ['planning'] },
  },
  '/api/projects/{id}/blockers': {
    get: {
      summary: '项目阻塞列表',
      tags: ['planning'],
      query: BlockerStatusQuerySchema,
    },
  },
  '/api/projects/{id}/blockers/report': {
    get: { summary: '阻塞分类统计与累计阻塞天数', tags: ['planning'] },
  },
  '/api/tasks/{id}/blockers': {
    post: {
      summary: '上报任务阻塞',
      tags: ['planning'],
      body: { name: 'BlockerCreate', schema: BlockerCreateSchema },
    },
  },
  '/api/projects/{id}/blockers/{blockerId}/resolve': {
    post: {
      summary: '解除阻塞（填写证据，乐观锁）',
      tags: ['planning'],
      body: { name: 'BlockerResolve', schema: BlockerResolveSchema },
    },
  },
  '/api/projects/{id}/recurrences': {
    get: { summary: '项目重复任务规则', tags: ['planning'] },
    post: {
      summary: '创建重复任务规则（RRULE 子集）',
      tags: ['planning'],
      body: { name: 'RecurrenceCreate', schema: RecurrenceCreateSchema },
    },
  },
  '/api/recurrences/{id}': {
    patch: {
      summary: '更新重复任务规则（乐观锁）',
      tags: ['planning'],
      body: { name: 'RecurrenceUpdate', schema: RecurrenceUpdateSchema },
    },
    delete: { summary: '删除重复任务规则（保留已生成任务）', tags: ['planning'] },
  },
  '/api/recurrences/{id}/run': {
    post: {
      summary: '物化到指定日期前的任务实例（幂等）',
      tags: ['planning'],
      body: { name: 'RecurrenceRun', schema: RecurrenceRunSchema },
    },
  },
  '/api/automation/rules': {
    get: {
      summary: '自动化规则列表',
      tags: ['automation'],
      query: AutomationQuerySchema,
    },
    post: {
      summary: '创建自动化规则（触发、条件与动作）',
      tags: ['automation'],
      body: { name: 'AutomationRuleCreate', schema: AutomationRuleCreateSchema },
    },
  },
  '/api/automation/rules/{id}': {
    patch: {
      summary: '更新自动化规则（乐观锁）',
      tags: ['automation'],
      body: { name: 'AutomationRuleUpdate', schema: AutomationRuleUpdateSchema },
    },
    delete: { summary: '删除自动化规则', tags: ['automation'] },
  },
  '/api/automation/rules/{id}/dry-run': {
    post: {
      summary: '试运行规则并记录预览结果',
      tags: ['automation'],
      body: { name: 'AutomationDryRun', schema: AutomationDryRunSchema },
    },
  },
  '/api/automation/runs': {
    get: {
      summary: '自动化执行记录（状态、耗时与输出）',
      tags: ['automation'],
      query: AutomationRunsQuerySchema,
    },
  },
  '/api/automation/runs/dead-letter': {
    get: { summary: '自动化死信列表（失败且未重放）', tags: ['automation'] },
  },
  '/api/automation/runs/{id}/replay': {
    post: { summary: '重放自动化运行', tags: ['automation'] },
  },
  '/api/automation/runs/{id}/actions/{index}/retry': {
    post: { summary: '单步重试自动化动作', tags: ['automation'] },
  },
  '/api/automation/runs/prune': {
    post: {
      summary: '按保留期清理自动化执行记录',
      tags: ['automation'],
      body: { name: 'AutomationPrune', schema: AutomationPruneSchema },
    },
  },
  '/api/projects/{id}/documents': {
    get: {
      summary: '项目文档（状态与全文筛选）',
      tags: ['knowledge'],
      query: DocumentListQuerySchema,
    },
    post: {
      summary: '创建项目文档并生成初始版本',
      tags: ['knowledge'],
      body: { name: 'DocumentCreate', schema: DocumentCreateSchema },
    },
  },
  '/api/documents/{id}': {
    get: { summary: '文档详情', tags: ['knowledge'] },
    patch: {
      summary: '更新文档并保存版本快照（乐观锁）',
      tags: ['knowledge'],
      body: { name: 'DocumentUpdate', schema: DocumentUpdateSchema },
    },
  },
  '/api/documents/{id}/versions': {
    get: { summary: '文档版本历史', tags: ['knowledge'] },
  },
  '/api/documents/{id}/restore': {
    post: {
      summary: '恢复文档到指定版本',
      tags: ['knowledge'],
      body: { name: 'DocumentRestore', schema: DocumentRestoreSchema },
    },
  },
  '/api/decisions': {
    get: {
      summary: '决策记录（按项目可见范围裁剪）',
      tags: ['knowledge'],
      query: DecisionQuerySchema,
    },
    post: {
      summary: '记录决策、选项与后果',
      tags: ['knowledge'],
      body: { name: 'DecisionCreate', schema: DecisionCreateSchema },
    },
  },
  '/api/decisions/{id}': {
    get: { summary: '决策详情', tags: ['knowledge'] },
    patch: {
      summary: '更新决策并保存版本快照（乐观锁）',
      tags: ['knowledge'],
      body: { name: 'DecisionUpdate', schema: DecisionUpdateSchema },
    },
  },
  '/api/decisions/{id}/versions': {
    get: { summary: '决策版本历史', tags: ['knowledge'] },
  },
  '/api/metrics': {
    get: {
      summary: '指标定义列表',
      tags: ['insights'],
      query: MetricQuerySchema,
    },
    post: {
      summary: '创建指标（安全公式、依赖与循环检测）',
      tags: ['insights'],
      body: { name: 'MetricCreate', schema: MetricCreateSchema },
    },
  },
  '/api/metrics/{id}': {
    get: { summary: '指标详情', tags: ['insights'] },
    patch: {
      summary: '更新指标并保存版本（乐观锁）',
      tags: ['insights'],
      body: { name: 'MetricUpdate', schema: MetricUpdateSchema },
    },
  },
  '/api/metrics/{id}/versions': {
    get: { summary: '指标版本历史', tags: ['insights'] },
  },
  '/api/metrics/{id}/evaluate': {
    post: {
      summary: '按日 / 周 / 月计算指标序列与汇总值',
      tags: ['insights'],
      body: { name: 'MetricEvaluate', schema: MetricEvaluateSchema },
    },
  },
  '/api/budgets': {
    get: { summary: '预算、已承诺、实际与预警状态', tags: ['insights'] },
  },
  '/api/projects/{id}/budget': {
    get: { summary: '项目预算与流水摘要', tags: ['insights'] },
    put: {
      summary: '创建或更新项目预算（乐观锁与汇率）',
      tags: ['insights'],
      body: { name: 'BudgetUpsert', schema: BudgetUpsertSchema },
    },
  },
  '/api/projects/{id}/budget/entries': {
    post: {
      summary: '登记预算流水并折算本币（支持幂等键）',
      tags: ['insights'],
      body: { name: 'BudgetEntryCreate', schema: BudgetEntryCreateSchema },
    },
  },
  '/api/governance/simulate': {
    post: {
      summary: '模拟成员对资源操作的最终权限与来源',
      tags: ['governance'],
      body: { name: 'PermissionSimulate', schema: PermissionSimulateSchema },
    },
  },
  '/api/governance/jit': {
    get: {
      summary: '临时授权记录（管理员查看全部，成员仅本人）',
      tags: ['governance'],
      query: JitQuerySchema,
    },
    post: {
      summary: '申请临时权限（管理员可代成员申请）',
      tags: ['governance'],
      body: { name: 'JitGrantCreate', schema: JitGrantCreateSchema },
    },
  },
  '/api/governance/jit/{id}/approve': {
    post: { summary: '批准临时授权（禁止自批）', tags: ['governance'] },
  },
  '/api/governance/jit/{id}/reject': {
    post: { summary: '驳回临时授权申请', tags: ['governance'] },
  },
  '/api/governance/jit/{id}/revoke': {
    post: { summary: '撤销待审批或生效中的临时授权', tags: ['governance'] },
  },
  '/api/workbench/{resource}': {
    get: {
      summary: '列出企业领域资源（按可见范围过滤，未知或无权资源返回 404）',
      tags: ['workbench'],
      query: WorkbenchQuerySchema,
    },
    post: {
      summary: '创建企业领域资源（资源特定 Zod 校验、作用域注入与审计）',
      tags: ['workbench'],
      query: WorkbenchQuerySchema,
      body: { name: 'WorkbenchCreate', schema: WorkbenchCreateSchema },
    },
  },
  '/api/workbench/{resource}/{id}': {
    get: { summary: '读取企业领域资源（不可见时返回 404）', tags: ['workbench'] },
    patch: {
      summary: '更新企业领域资源（乐观锁，冲突返回 409 与最新版本）',
      tags: ['workbench'],
      body: { name: 'WorkbenchUpdate', schema: WorkbenchUpdateSchema },
    },
    delete: { summary: '删除企业领域资源（按资源策略校验权限）', tags: ['workbench'] },
  },
  '/api/gates/{id}/decisions': {
    post: {
      summary: '阶段门审批（通过、拒绝、豁免、撤回、升级）',
      tags: ['program'],
      body: { name: 'GateDecision', schema: GateDecisionSchema },
    },
  },
  '/api/projects/{id}/health': {
    get: { summary: '读取最近一次项目健康度快照', tags: ['program'] },
    post: { summary: '计算并记录项目健康度与置信度', tags: ['program'] },
  },
  '/api/projects/{id}/baselines': {
    post: {
      summary: '创建项目基线快照，等待审批',
      tags: ['program'],
      body: { name: 'BaselineCreate', schema: BaselineCreateSchema },
    },
  },
  '/api/baselines/{id}/decisions': {
    post: {
      summary: '审批项目基线',
      tags: ['program'],
      body: { name: 'BaselineDecision', schema: BaselineDecisionSchema },
    },
  },
  '/api/baselines/{id}/variance': {
    get: { summary: '计算基线偏差（新增、移除、变更、未变）', tags: ['program'] },
  },
  '/api/changes/{id}/decisions': {
    post: {
      summary: '审批或实施变更请求',
      tags: ['program'],
      body: { name: 'ChangeRequestDecision', schema: ChangeRequestDecisionSchema },
    },
  },
  '/api/capacity/profiles/{userId}': {
    put: {
      summary: '维护成员容量档案（每周工时、休假）',
      tags: ['program'],
      body: { name: 'CapacityProfileUpdate', schema: CapacityProfileUpdateSchema },
    },
  },
  '/api/capacity': {
    get: {
      summary: '成员容量、分配与缺口分析',
      tags: ['program'],
      query: CapacityQuerySchema,
    },
  },
  '/api/capacity/scenarios': {
    post: {
      summary: '容量情景模拟（调整、供给与缺口）',
      tags: ['program'],
      body: { name: 'CapacityScenario', schema: CapacityScenarioSchema },
    },
  },
  '/api/projects/{id}/closure': {
    get: { summary: '读取项目结项记录与收益复盘', tags: ['program'] },
    post: {
      summary: '项目结项校验、验收与收益复盘计划',
      tags: ['program'],
      body: { name: 'ClosureCreate', schema: ClosureCreateSchema },
    },
  },
  '/api/closures/{id}/reopen': {
    post: {
      summary: '重新打开已结项项目',
      tags: ['program'],
      body: { name: 'ClosureReopen', schema: ClosureReopenSchema },
    },
  },
  '/api/benefit-reviews/{id}/records': {
    post: {
      summary: '记录收益复盘实际值',
      tags: ['program'],
      body: { name: 'BenefitRecord', schema: BenefitRecordSchema },
    },
  },
  '/api/tasks/{id}/sla': {
    post: {
      summary: '为任务附加 SLA 策略与响应/解决时限',
      tags: ['execution'],
      body: { name: 'TaskSlaAttach', schema: TaskSlaAttachSchema },
    },
  },
  '/api/tasks/{id}/sla/{action}': {
    post: {
      summary: '暂停、恢复或升级任务 SLA',
      tags: ['execution'],
      body: { name: 'TaskSlaAction', schema: TaskSlaActionSchema },
    },
  },
  '/api/tasks/{id}/forms/{formId}': {
    put: {
      summary: '保存任务表单值并执行服务端校验',
      tags: ['execution'],
      body: { name: 'FormValuesPut', schema: FormValuesPutSchema },
    },
  },
  '/api/dispatch/recommend': {
    post: {
      summary: '根据规则、技能与负载推荐任务负责人',
      tags: ['execution'],
      body: { name: 'DispatchRecommend', schema: DispatchRecommendSchema },
    },
  },
  '/api/dispatch/decision': {
    post: {
      summary: '接受或拒绝任务分派推荐',
      tags: ['execution'],
      body: { name: 'DispatchAccept', schema: DispatchAcceptSchema },
    },
  },
  '/api/dispatch/batch': {
    post: {
      summary: '批量接受或拒绝任务分派推荐',
      tags: ['execution'],
      body: { name: 'DispatchBatch', schema: DispatchBatchSchema },
    },
  },
  '/api/tasks/{id}/handoffs': {
    post: {
      summary: '创建任务交接与上下文快照',
      tags: ['execution'],
      body: { name: 'HandoffCreate', schema: HandoffCreateSchema },
    },
  },
  '/api/handoffs/{id}/decision': {
    post: {
      summary: '接收人确认或拒绝任务交接',
      tags: ['execution'],
      body: { name: 'HandoffDecision', schema: HandoffDecisionSchema },
    },
  },
  '/api/handoffs/tick': {
    post: { summary: '扫描超时未确认的交接并升级给项目负责人', tags: ['execution'] },
  },
  '/api/deliverables/{id}/versions': {
    post: {
      summary: '提交交付物新版本',
      tags: ['execution'],
      body: { name: 'DeliverableVersionCreate', schema: DeliverableVersionCreateSchema },
    },
  },
  '/api/deliverables/{id}/reviews': {
    post: {
      summary: '审阅交付物最新版本',
      tags: ['execution'],
      body: { name: 'DeliverableReview', schema: DeliverableReviewSchema },
    },
  },
  '/api/meetings/{id}/complete': {
    post: {
      summary: '完成会议并生成纪要、决策与行动项',
      tags: ['collab'],
      body: { name: 'MeetingComplete', schema: MeetingCompleteSchema },
    },
  },
  '/api/meeting-actions/{id}/convert': {
    post: {
      summary: '将会议行动项转换为项目任务',
      tags: ['collab'],
      body: { name: 'MeetingActionConvert', schema: MeetingActionConvertSchema },
    },
  },
  '/api/tasks/tree/bulk': {
    post: {
      summary: '批量缩进、提升、移动、删除或同步任务树',
      tags: ['execution'],
      body: { name: 'TaskTreeBulk', schema: TaskTreeBulkSchema },
    },
  },
  '/api/tasks/{id}/estimate': {
    patch: {
      summary: '更新任务估算（故事点、工时、T 恤尺寸）',
      tags: ['execution'],
      body: { name: 'TaskEstimate', schema: TaskEstimateSchema },
    },
  },
  '/api/time/summary': {
    get: {
      summary: '按成员汇总任务工时',
      tags: ['execution'],
      query: TimeSummaryQuerySchema,
    },
  },
  '/api/knowledge/links': {
    post: {
      summary: '创建知识图谱关联',
      tags: ['collab'],
      body: { name: 'KnowledgeLinkCreate', schema: KnowledgeLinkCreateSchema },
    },
  },
  '/api/knowledge/graph': {
    get: {
      summary: '读取知识图谱节点、边与孤立文档',
      tags: ['collab'],
      query: KnowledgeGraphQuerySchema,
    },
  },
  '/api/knowledge/search': {
    get: {
      summary: '跨文档、决策、任务与 Playbook 搜索',
      tags: ['collab'],
      query: KnowledgeSearchQuerySchema,
    },
  },
  '/api/knowledge/review': {
    get: { summary: '知识复核队列（到期文档、决策与孤立文档）', tags: ['collab'] },
  },
  '/api/documents/{id}/comments': {
    get: { summary: '列出文档的锚点评论与修改建议', tags: ['collab'] },
    post: {
      summary: '创建带锚点或修改建议的文档评论',
      tags: ['collab'],
      body: { name: 'DocumentCommentCreate', schema: DocumentCommentCreateSchema },
    },
  },
  '/api/document-comments/{id}/decisions': {
    post: {
      summary: '解决、重新打开或接受文档评论建议',
      tags: ['collab'],
      body: { name: 'DocumentCommentResolve', schema: DocumentCommentResolveSchema },
    },
  },
  '/api/channels/{id}/subscription': {
    post: { summary: '订阅讨论频道', tags: ['collab'] },
    delete: { summary: '取消订阅讨论频道', tags: ['collab'] },
  },
  '/api/channels/{id}/messages': {
    post: {
      summary: '发送频道消息并提醒订阅者',
      tags: ['collab'],
      body: { name: 'ChannelMessageCreate', schema: ChannelMessageCreateSchema },
    },
  },
  '/api/channel-messages/{id}': {
    patch: {
      summary: '编辑自己发送的频道消息',
      tags: ['collab'],
      body: { name: 'ChannelMessageUpdate', schema: ChannelMessageUpdateSchema },
    },
  },
  '/api/channel-messages/{id}/task': {
    post: { summary: '将频道消息转换为项目任务', tags: ['collab'] },
  },
  '/api/retrospectives/{id}/publish': {
    post: { summary: '发布复盘并生成 Playbook', tags: ['collab'] },
  },
  '/api/playbooks/{id}/feedback': {
    post: {
      summary: '记录 Playbook 使用反馈',
      tags: ['collab'],
      body: { name: 'PlaybookFeedback', schema: PlaybookFeedbackSchema },
    },
  },
  '/api/projects/{id}/portals': {
    post: {
      summary: '为客户项目创建客户门户与首个账号',
      tags: ['collab'],
      body: { name: 'PortalCreate', schema: PortalCreateSchema },
    },
  },
  '/api/portals/{id}/accounts': {
    post: {
      summary: '为客户门户开通客户账号（令牌仅返回一次）',
      tags: ['collab'],
      body: { name: 'PortalAccountCreate', schema: PortalAccountCreateSchema },
    },
  },
  '/api/portal/{token}': {
    get: { summary: '客户门户公开视图（令牌访问）', tags: ['collab'], public: true },
  },
  '/api/portal/{token}/requests': {
    post: {
      summary: '客户通过门户提交需求',
      tags: ['collab'],
      public: true,
      body: { name: 'PortalRequestCreate', schema: PortalRequestCreateSchema },
    },
  },
  '/api/portal/{token}/requests/{id}': {
    patch: {
      summary: '客户门户更新需求状态或进度说明',
      tags: ['collab'],
      public: true,
      body: { name: 'PortalRequestUpdate', schema: PortalRequestUpdateSchema },
    },
  },
  '/api/workflows/{id}/publish': {
    post: {
      summary: '发布工作流版本（校验节点、连线与环）',
      tags: ['workflow'],
      body: { name: 'WorkflowPublish', schema: WorkflowPublishSchema },
    },
  },
  '/api/workflows/{id}/test': {
    post: {
      summary: '沙箱测试工作流并记录运行轨迹',
      tags: ['workflow'],
      body: { name: 'WorkflowTest', schema: WorkflowTestSchema },
    },
  },
  '/api/workflows/{id}/runs': {
    post: {
      summary: '启动工作流运行（支持幂等键与测试模式）',
      tags: ['workflow'],
      body: { name: 'WorkflowRunStart', schema: WorkflowRunStartSchema },
    },
  },
  '/api/workflows/{id}/rollback': {
    post: {
      summary: '回滚工作流到指定历史版本',
      tags: ['workflow'],
      body: { name: 'WorkflowRollback', schema: WorkflowRollbackSchema },
    },
  },
  '/api/approvals': {
    post: {
      summary: '创建多步骤审批请求',
      tags: ['workflow'],
      body: { name: 'ApprovalCreate', schema: ApprovalCreateSchema },
    },
  },
  '/api/approvals/{id}/decisions': {
    post: {
      summary: '审批、拒绝、转交或升级审批',
      tags: ['workflow'],
      body: { name: 'ApprovalDecision', schema: ApprovalDecisionSchema },
    },
  },
  '/api/approvals/{id}/withdraw': {
    post: {
      summary: '撤回未完成的审批请求',
      tags: ['workflow'],
      body: { name: 'ApprovalWithdraw', schema: ApprovalWithdrawSchema },
    },
  },
  '/api/approvals/metrics': {
    get: {
      summary: '审批状态、风险、耗时与 SLA 违约指标',
      tags: ['workflow'],
      query: ApprovalMetricsQuerySchema,
    },
  },
  '/api/triggers/{id}/fire': {
    post: {
      summary: '手动触发工作流（去重、静默时段与频率限制）',
      tags: ['workflow'],
      body: { name: 'TriggerFire', schema: TriggerFireSchema },
    },
  },
  '/api/triggers/tick': {
    post: { summary: '运行到期的时间/周期触发器', tags: ['workflow'] },
  },
  '/api/connectors/{id}/rotate': {
    post: {
      summary: '轮换连接器密钥',
      tags: ['workflow'],
      body: { name: 'ConnectorRotate', schema: ConnectorRotateSchema },
    },
  },
  '/api/connectors/{id}/health': {
    get: { summary: '检查连接器健康状态', tags: ['workflow'] },
  },
  '/api/connectors/{id}/oauth/start': {
    post: {
      summary: '发起 OAuth 授权（state + PKCE S256）',
      tags: ['workflow'],
      body: { name: 'ConnectorOAuthStart', schema: ConnectorOAuthStartSchema },
    },
  },
  '/api/connectors/{id}/oauth/callback': {
    post: {
      summary: '完成 OAuth 授权并加密存储令牌',
      tags: ['workflow'],
      body: { name: 'ConnectorOAuthCallback', schema: ConnectorOAuthCallbackSchema },
    },
  },
  '/api/connectors/{id}/oauth/refresh': {
    post: { summary: '刷新 OAuth 访问令牌', tags: ['workflow'] },
  },
  '/api/connectors/{id}/call': {
    post: {
      summary: '经连接器发起受限的外部调用（域名白名单、限流与调用日志）',
      tags: ['workflow'],
      body: { name: 'ConnectorCall', schema: ConnectorCallSchema },
    },
  },
  '/api/event-subscriptions': {
    post: {
      summary: '创建领域事件订阅',
      tags: ['workflow'],
      body: { name: 'EventSubscriptionCreate', schema: EventSubscriptionCreateSchema },
    },
  },
  '/api/events/tick': {
    post: { summary: '处理到期的领域事件投递（重试与死信）', tags: ['workflow'] },
  },
  '/api/event-deliveries/{id}/retry': {
    post: { summary: '重试领域事件投递', tags: ['workflow'] },
  },
  '/api/jobs': {
    post: {
      summary: '创建幂等的后台任务',
      tags: ['workflow'],
      body: { name: 'BackgroundJobCreate', schema: BackgroundJobCreateSchema },
    },
  },
  '/api/jobs/tick': {
    post: {
      summary: '领取并执行到期的后台任务',
      tags: ['workflow'],
      body: { name: 'BackgroundJobTick', schema: BackgroundJobTickSchema },
    },
  },
  '/api/jobs/{id}/retry': {
    post: { summary: '重试失败的后台任务', tags: ['workflow'] },
  },
  '/api/sandbox/run': {
    post: {
      summary: '在动作、时间与网络限制下运行沙箱脚本',
      tags: ['workflow'],
      body: { name: 'SandboxRun', schema: SandboxRunSchema },
    },
  },
  '/api/automation/rules/{id}/rollback': {
    post: {
      summary: '回滚自动化规则到历史版本',
      tags: ['workflow'],
      body: { name: 'AutomationRollback', schema: AutomationRollbackSchema },
    },
  },
  '/api/anomalies/detect': {
    post: {
      summary: '基于基线标准差检测指标异常',
      tags: ['analysis'],
      body: { name: 'AnomalyDetect', schema: AnomalyDetectSchema },
    },
  },
  '/api/anomalies/{id}/dismiss': {
    post: {
      summary: '忽略指标异常',
      tags: ['analysis'],
      body: { name: 'AnomalyDismiss', schema: AnomalyDismissSchema },
    },
  },
  '/api/quality/scan': {
    post: {
      summary: '运行数据质量规则扫描',
      tags: ['analysis'],
      body: { name: 'QualityScan', schema: QualityScanSchema },
    },
  },
  '/api/quality/issues/batch-fix': {
    post: {
      summary: '批量预览或修复数据质量问题',
      tags: ['analysis'],
      body: { name: 'QualityBatchFix', schema: QualityBatchFixSchema },
    },
  },
  '/api/quality/issues/{id}/fix': {
    post: {
      summary: '预览或修复单条数据质量问题',
      tags: ['analysis'],
      body: { name: 'QualityFix', schema: QualityFixSchema },
    },
  },
  '/api/scenarios/compare': {
    post: {
      summary: '比较多个预测情景并排序',
      tags: ['analysis'],
      body: { name: 'ScenarioCompare', schema: ScenarioCompareSchema },
    },
  },
  '/api/scenarios/{id}/evaluate': {
    post: { summary: '评估预测情景并记录结果', tags: ['analysis'] },
  },
  '/api/crm/funnel': {
    get: {
      summary: '商机阶段漏斗与转化率',
      tags: ['analysis'],
      query: FunnelQuerySchema,
    },
  },
  '/api/query/preview': {
    post: {
      summary: '预览自助查询（数据集、字段、过滤与聚合白名单）',
      tags: ['analysis'],
      body: { name: 'QueryPreview', schema: QueryPreviewSchema },
    },
  },
  '/api/query-reports/{id}/run': {
    post: { summary: '运行保存的自助查询报表', tags: ['analysis'] },
  },
  '/api/report-subscriptions': {
    post: {
      summary: '创建报表订阅与投递计划',
      tags: ['analysis'],
      body: { name: 'ReportSubscriptionCreate', schema: ReportSubscriptionCreateSchema },
    },
  },
  '/api/report-subscriptions/run': {
    post: { summary: '生成到期的报表投递与下载链接', tags: ['analysis'] },
  },
  '/api/metrics/{id}/impact': {
    get: { summary: '指标血缘、口径目录、完整性标记与下游影响分析', tags: ['analysis'] },
  },
  '/api/metrics/{id}/lineage': {
    post: {
      summary: '登记指标血缘来源（表、导入、公式、过滤器、汇率或上游指标）',
      tags: ['analysis'],
      body: { name: 'LineageCreate', schema: LineageCreateSchema },
    },
  },
  '/api/budgets/{id}/categories': {
    post: {
      summary: '创建预算费用类别',
      tags: ['analysis'],
      body: { name: 'BudgetCategoryCreate', schema: BudgetCategoryCreateSchema },
    },
  },
  '/api/budget-categories/{id}': {
    patch: {
      summary: '更新预算费用类别（乐观锁）',
      tags: ['analysis'],
      body: { name: 'BudgetCategoryUpdate', schema: BudgetCategoryUpdateSchema },
    },
  },
  '/api/projects/{id}/budget-alerts': {
    get: { summary: '预算与费用类别超限预警', tags: ['analysis'] },
  },
  '/api/organizations': {
    post: {
      summary: '创建组织（仅管理员）',
      tags: ['org'],
      body: { name: 'OrganizationCreate', schema: OrganizationCreateSchema },
    },
  },
  '/api/organizations/{id}/departments': {
    post: {
      summary: '创建组织部门（仅管理员）',
      tags: ['org'],
      body: { name: 'DepartmentCreate', schema: DepartmentCreateSchema },
    },
  },
  '/api/organizations/{id}/members': {
    post: {
      summary: '新增或更新组织成员',
      tags: ['org'],
      body: { name: 'OrgMembershipCreate', schema: OrgMembershipCreateSchema },
    },
  },
  '/api/workspace/members': {
    post: {
      summary: '新增或更新工作区成员与角色',
      tags: ['org'],
      body: { name: 'WorkspaceMemberCreate', schema: WorkspaceMemberCreateSchema },
    },
  },
  '/api/workspace/switch': {
    post: {
      summary: '切换当前工作区（校验成员关系）',
      tags: ['org'],
      body: { name: 'WorkspaceSwitch', schema: WorkspaceSwitchSchema },
    },
  },
  '/api/permission-samples/run': {
    post: {
      summary: '运行权限回归样例并比较期望结果',
      tags: ['org'],
      body: { name: 'PermissionSampleRun', schema: PermissionSampleRunSchema },
    },
  },
  '/api/governance/jit/use': {
    post: {
      summary: '使用当前有效的临时授权',
      tags: ['org'],
      body: { name: 'JitUsage', schema: JitUsageSchema },
    },
  },
  '/api/governance/jit/{id}/use': {
    post: {
      summary: '使用指定临时授权',
      tags: ['org'],
      body: { name: 'JitUsage', schema: JitUsageSchema },
    },
  },
  '/api/governance/jit/{id}/post-review': {
    post: {
      summary: '事后复核临时授权（不通过时撤销）',
      tags: ['org'],
      body: { name: 'JitPostReview', schema: JitPostReviewSchema },
    },
  },
  '/api/projects/{id}/health/trend': {
    get: { summary: '项目健康度快照趋势与相对变化', tags: ['program'] },
  },
  '/api/projects/{id}/health/config': {
    get: { summary: '读取项目健康度阈值与权重配置', tags: ['program'] },
    put: {
      summary: '更新项目健康度阈值与权重（需项目管理权限）',
      tags: ['program'],
      body: { name: 'HealthConfig', schema: HealthConfigSchema },
    },
  },
  '/api/capacity/plan': {
    get: {
      summary: '按周或月分桶的容量规划、供给缺口、冲突与过滤',
      tags: ['program'],
      query: CapacityPlanSchema,
    },
  },
  '/api/changes/{id}/comments': {
    get: { summary: '列出变更请求讨论', tags: ['program'] },
    post: {
      summary: '添加变更请求评论',
      tags: ['program'],
      body: { name: 'ChangeRequestComment', schema: ChangeRequestCommentSchema },
    },
  },
  '/api/changes/{id}/implement': {
    post: {
      summary: '实施已批准变更并生成关联任务',
      tags: ['program'],
      body: { name: 'ChangeRequestImplement', schema: ChangeRequestImplementSchema },
    },
  },
  '/api/sla/tick': {
    post: {
      summary: '扫描到期 SLA 并发送提醒或升级',
      tags: ['planning'],
      body: { name: 'SlaTick', schema: SlaTickSchema },
    },
  },
  '/api/benefit-reviews/tick': {
    post: { summary: '扫描 30/90/180 天收益复盘提醒', tags: ['program'] },
  },
  '/api/documents/tick-reminders': {
    post: { summary: '扫描到期文档复核提醒', tags: ['collab'] },
  },
  '/api/task-templates': {
    get: { summary: '列出任务模板', tags: ['planning'] },
    post: {
      summary: '创建任务模板',
      tags: ['planning'],
      body: { name: 'TaskTemplateCreate', schema: TaskTemplateCreateSchema },
    },
  },
  '/api/task-templates/{id}': {
    delete: { summary: '删除任务模板', tags: ['planning'] },
  },
  '/api/task-templates/{id}/apply': {
    post: {
      summary: '将任务模板应用到项目（幂等）',
      tags: ['planning'],
      body: { name: 'TaskTemplateApply', schema: TaskTemplateApplySchema },
    },
  },
  '/api/estimate-scales': {
    get: { summary: '列出估算刻度', tags: ['planning'] },
    post: {
      summary: '创建估算刻度',
      tags: ['planning'],
      body: { name: 'EstimateScaleCreate', schema: EstimateScaleCreateSchema },
    },
  },
  '/api/knowledge/synonyms': {
    get: { summary: '列出知识搜索同义词', tags: ['collab'] },
    post: {
      summary: '创建知识搜索同义词',
      tags: ['collab'],
      body: { name: 'KnowledgeSynonymCreate', schema: KnowledgeSynonymCreateSchema },
    },
  },
  '/api/knowledge/synonyms/{term}': {
    delete: { summary: '删除知识搜索同义词', tags: ['collab'] },
  },
  '/api/documents/{id}/diff': {
    get: {
      summary: '比较文档历史版本差异',
      tags: ['collab'],
      query: DocumentDiffQuerySchema,
    },
  },
  '/api/channels/{id}/messages/search': {
    get: {
      summary: '在频道消息中搜索',
      tags: ['collab'],
      query: ChannelSearchQuerySchema,
    },
  },
  '/api/portals/{id}/requests': {
    get: { summary: '列出客户门户需求（按项目可见性过滤）', tags: ['collab'] },
  },
  '/api/portal/{token}/requests/{id}/comments': {
    get: {
      summary: '客户查看需求评论（仅非内部评论）',
      tags: ['collab'],
      public: true,
    },
    post: {
      summary: '客户在门户需求下发表评论',
      tags: ['collab'],
      public: true,
      body: { name: 'PortalRequestComment', schema: PortalRequestCommentSchema },
    },
  },
  '/api/portal-requests/{id}/comments': {
    get: { summary: '员工查看门户需求与全部评论', tags: ['collab'] },
    post: {
      summary: '员工添加门户内部评论',
      tags: ['collab'],
      body: { name: 'PortalInternalComment', schema: PortalInternalCommentSchema },
    },
  },
  '/api/portal-requests/{id}/deliver': {
    post: {
      summary: '员工确认门户需求已交付',
      tags: ['collab'],
      body: { name: 'PortalDeliveryConfirm', schema: PortalDeliveryConfirmSchema },
    },
  },
  '/api/portal/{token}/requests/{id}/confirm': {
    post: {
      summary: '客户确认交付（幂等，关闭需求）',
      tags: ['collab'],
      public: true,
      body: { name: 'PortalDeliveryConfirm', schema: PortalDeliveryConfirmSchema },
    },
  },
  '/api/workflows/{id}/replay': {
    post: {
      summary: '按历史运行重放工作流（幂等）',
      tags: ['workflow'],
      body: { name: 'WorkflowReplay', schema: WorkflowReplaySchema },
    },
  },
  '/api/workflow-runs/{id}/retry': {
    post: {
      summary: '重试工作流运行中的单个节点',
      tags: ['workflow'],
      body: { name: 'WorkflowRetryNode', schema: WorkflowRetryNodeSchema },
    },
  },
  '/api/approval-routing-rules': {
    get: { summary: '列出审批动态路由规则', tags: ['workflow'] },
    post: {
      summary: '创建审批动态路由规则',
      tags: ['workflow'],
      body: { name: 'ApprovalRoutingRuleCreate', schema: ApprovalRoutingRuleCreateSchema },
    },
  },
  '/api/approval-routing-rules/{id}': {
    delete: { summary: '删除审批动态路由规则', tags: ['workflow'] },
  },
  '/api/quality/issues/{id}/revert': {
    post: {
      summary: '回滚数据质量修复并恢复原始值',
      tags: ['analysis'],
      body: { name: 'QualityRevert', schema: QualityRevertSchema },
    },
  },
  '/api/projects/{id}/budget/approval': {
    post: {
      summary: '为项目预算发起版本化审批',
      tags: ['analysis'],
      body: { name: 'BudgetApproval', schema: BudgetApprovalSchema },
    },
  },
  '/api/recurrences/{id}/skip': {
    post: {
      summary: '跳过重复任务的单次实例（乐观锁）',
      tags: ['planning'],
      body: { name: 'RecurrenceSkip', schema: RecurrenceSkipSchema },
    },
  },
};

function jsonSchemaOf(schema: z.ZodType): JsonObject {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
  }) as JsonObject;
  return rest;
}

function queryParameters(schema: z.ZodType): JsonObject[] {
  const json = jsonSchemaOf(schema);
  const properties = (json.properties ?? {}) as Record<string, JsonObject>;
  const required = new Set((json.required as string[] | undefined) ?? []);
  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: 'query',
    ...(required.has(name) ? { required: true } : {}),
    schema: property,
  }));
}

function pathParameters(path: string): JsonObject[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
    name: match[1],
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
}

function okResponse(produces: OperationDoc['produces']): JsonObject {
  if (!produces) return { description: '成功' };
  return {
    description: produces.description ?? '成功',
    content: { [produces.contentType]: { schema: { type: 'string' } } },
  };
}

const ERROR_RESPONSE = {
  description: '请求失败（4xx / 5xx）',
  content: {
    'application/json': { schema: { $ref: '#/components/schemas/Error' } },
  },
};

export function openApiDocument(): JsonObject {
  const paths: Record<string, Record<string, JsonObject>> = {};
  const schemas: Record<string, JsonObject> = { Error: jsonSchemaOf(ErrorSchema) };
  const tags = new Set<string>();

  for (const [path, methods] of Object.entries(OPERATIONS)) {
    const operations: Record<string, JsonObject> = {};
    for (const [method, doc] of Object.entries(methods) as [Method, OperationDoc][]) {
      tags.add(doc.tags[0] as string);
      const operation: JsonObject = {
        summary: doc.summary,
        tags: doc.tags,
        parameters: [...pathParameters(path), ...(doc.query ? queryParameters(doc.query) : [])],
        responses: { '200': okResponse(doc.produces), default: ERROR_RESPONSE },
        ...(doc.public
          ? { security: [] }
          : doc.sessionOnly
            ? { security: [{ cookieAuth: [] }] }
            : {}),
      };
      if (operation.parameters && (operation.parameters as unknown[]).length === 0) {
        delete operation.parameters;
      }
      if (doc.body) {
        const contentType = doc.body.contentType ?? 'application/json';
        schemas[doc.body.name] = jsonSchemaOf(doc.body.schema);
        const schema =
          contentType === 'multipart/form-data'
            ? { type: 'object', properties: { file: { type: 'string', format: 'binary' } } }
            : { $ref: `#/components/schemas/${doc.body.name}` };
        operation.requestBody = { required: true, content: { [contentType]: { schema } } };
      }
      operations[method] = operation;
    }
    paths[path] = operations;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Clay Dashboard API',
      version: '2.0.0',
      description:
        'SaaS 分析平台 API：会话或个人访问令牌认证、RBAC、项目、活动流、分析指标与实时事件。请求体与查询参数由共享 Zod schema 生成。',
    },
    security: [{ cookieAuth: [] }, { bearerAuth: [] }],
    tags: Object.keys(TAGS).map((name) => ({ name, description: TAGS[name] })),
    components: {
      securitySchemes: {
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'np_session' },
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: '个人访问令牌（clp_ 前缀），仅支持 API，不能管理令牌或 Webhook',
        },
      },
      schemas,
    },
    paths,
  };
}
