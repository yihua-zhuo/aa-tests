import { z } from '@hono/zod-openapi';
import { passwordIssue } from './passwords.ts';
import { PERMISSIONS } from './permissions.ts';
import { DATE_PATTERN, RANGE_KEYS } from './ranges.ts';
import { WEBHOOK_EVENTS } from './types.ts';
import { webhookUrlIssue } from './webhooks.ts';

function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export const RoleSchema = z.enum(['admin', 'manager', 'pm', 'viewer']).openapi('Role');
export const UserStatusSchema = z.enum(['active', 'disabled']).openapi('UserStatus');
export const PermissionSchema = z.enum(PERMISSIONS).openapi('Permission');
export const ProjectStatusSchema = z
  .enum(['planning', 'active', 'on_hold', 'completed', 'archived'])
  .openapi('ProjectStatus');
export const DateRangeKeySchema = z.enum(RANGE_KEYS).openapi('DateRangeKey');

export const DateKeySchema = z
  .string()
  .refine(isCalendarDate, '需为 YYYY-MM-DD 格式的有效日期')
  .openapi('DateKey');

export const EmailSchema = z
  .string()
  .trim()
  .min(3, '邮箱不能为空')
  .max(160, '邮箱过长')
  .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, '邮箱格式不正确')
  .transform((value) => value.toLowerCase());

export const NameSchema = z.string().trim().min(1, '名称不能为空').max(80, '名称最多 80 个字符');

export const PasswordSchema = z
  .string()
  .min(8, '密码至少 8 位')
  .max(200, '密码过长')
  .superRefine((value, ctx) => {
    const issue = passwordIssue(value);
    if (issue) ctx.addIssue({ code: 'custom', message: issue });
  });

function isTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const TimezoneSchema = z
  .string()
  .trim()
  .min(1, '时区不能为空')
  .max(64, '时区过长')
  .refine(isTimezone, '无效的 IANA 时区');

export const LoginSchema = z
  .object({
    email: EmailSchema,
    password: z.string().min(1, '请输入密码').max(200),
  })
  .openapi('Login');

export const PasswordResetRequestSchema = z
  .object({ email: EmailSchema })
  .openapi('PasswordResetRequest');

export const PasswordResetConfirmSchema = z
  .object({
    token: z.string().trim().min(20, '重置令牌无效').max(300),
    password: PasswordSchema,
  })
  .openapi('PasswordResetConfirm');

export const MfaLoginSchema = z
  .object({
    ticket: z.string().min(20, '验证票据无效').max(200),
    code: z.string().trim().min(6, '请输入 6 位验证码').max(12),
  })
  .openapi('MfaLogin');

export const MfaEnableSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/u, '请输入 6 位验证码'),
  })
  .openapi('MfaEnable');

export const MfaDisableSchema = z
  .object({ password: z.string().min(1, '请输入密码').max(200) })
  .openapi('MfaDisable');

export const PasswordResetSchema = z
  .object({ reason: z.string().trim().max(200).optional() })
  .openapi('PasswordReset');

export const ProjectNameSchema = z
  .string()
  .trim()
  .min(1, '项目名称不能为空')
  .max(120, '项目名称最多 120 个字符');

export const ProjectDescriptionSchema = z.string().trim().max(2000, '描述最多 2000 个字符');

export const ProgressSchema = z.coerce
  .number()
  .int('进度需为整数')
  .min(0, '进度不能小于 0')
  .max(100, '进度不能大于 100');

export const ProjectTagSchema = z
  .string()
  .trim()
  .min(1, '标签不能为空')
  .max(24, '标签最多 24 个字符');

export const ProjectTagsSchema = z
  .array(ProjectTagSchema)
  .max(5, '最多 5 个标签')
  .transform((tags) => [...new Set(tags)]);

export const ProjectDueFilterSchema = z.enum(['overdue', 'week', 'month']);

export const ProjectVisibilitySchema = z.enum(['workspace', 'private']);

export const ProjectCreateSchema = z
  .object({
    name: ProjectNameSchema,
    description: ProjectDescriptionSchema.optional(),
    status: ProjectStatusSchema.optional(),
    progress: ProgressSchema.optional(),
    ownerId: z.string().uuid('负责人无效').optional(),
    visibility: ProjectVisibilitySchema.optional(),
    startDate: DateKeySchema.nullable().optional(),
    dueDate: DateKeySchema.nullable().optional(),
    tags: ProjectTagsSchema.optional(),
    memberIds: z.array(z.string().uuid()).max(50).optional(),
  })
  .refine((value) => !value.startDate || !value.dueDate || value.startDate <= value.dueDate, {
    message: '截止日期不能早于开始日期',
    path: ['dueDate'],
  })
  .openapi('ProjectCreate');

export const ProjectUpdateSchema = z
  .object({
    name: ProjectNameSchema.optional(),
    description: ProjectDescriptionSchema.optional(),
    status: ProjectStatusSchema.optional(),
    progress: ProgressSchema.optional(),
    ownerId: z.string().uuid().optional(),
    visibility: ProjectVisibilitySchema.optional(),
    startDate: DateKeySchema.nullable().optional(),
    dueDate: DateKeySchema.nullable().optional(),
    tags: ProjectTagsSchema.optional(),
    memberIds: z.array(z.string().uuid()).max(50).optional(),
    version: z.number().int().min(1),
  })
  .refine((value) => !value.startDate || !value.dueDate || value.startDate <= value.dueDate, {
    message: '截止日期不能早于开始日期',
    path: ['dueDate'],
  })
  .openapi('ProjectUpdate');

export const TemplateApplySchema = z
  .object({
    templateId: z.string().trim().min(1, '请选择项目模板').max(60),
    name: ProjectNameSchema.optional(),
    description: ProjectDescriptionSchema.optional(),
    ownerId: z.string().uuid('负责人无效').optional(),
    startDate: DateKeySchema.optional(),
    memberIds: z.array(z.string().uuid()).max(50).optional(),
  })
  .openapi('TemplateApply');

export const ProjectDuplicateSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, '项目名称不能为空')
      .max(120, '项目名称最多 120 个字符')
      .optional(),
    dateOffsetDays: z.number().int().min(-365).max(365).default(0),
    includeMembers: z.boolean().default(true),
    includeTasks: z.boolean().default(true),
  })
  .openapi('ProjectDuplicate');

export const ProjectQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(['all', 'planning', 'active', 'on_hold', 'completed', 'archived']).default('all'),
  owner: z.string().trim().max(40).default('all'),
  sort: z.enum(['updated', 'created', 'name', 'progress', 'due']).default('updated'),
  tag: z.string().trim().max(24).optional(),
  due: z.enum(['all', 'overdue', 'week', 'month']).optional(),
  favorite: z.enum(['0', '1']).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(12),
  ids: z.string().trim().max(4_000).optional(),
});

export const ProjectViewQuerySchema = z
  .object({
    q: z.string().trim().max(120).optional(),
    status: z.enum(['all', 'planning', 'active', 'on_hold', 'completed', 'archived']).optional(),
    owner: z.string().trim().max(40).optional(),
    sort: z.enum(['updated', 'created', 'name', 'progress', 'due']).optional(),
    tag: z.string().trim().max(24).optional(),
    due: z.enum(['overdue', 'week', 'month']).optional(),
    favorite: z.boolean().optional(),
    view: z.enum(['grid', 'list']).optional(),
    pageSize: z.number().int().min(1).max(50).optional(),
  })
  .openapi('ProjectViewQuery');

export const SavedViewCreateSchema = z
  .object({
    name: z.string().trim().min(1, '请输入视图名称').max(40, '视图名称最多 40 个字符'),
    query: ProjectViewQuerySchema,
  })
  .openapi('SavedViewCreate');

export const SavedViewUpdateSchema = z
  .object({
    name: z.string().trim().min(1, '请输入视图名称').max(40, '视图名称最多 40 个字符').optional(),
    query: ProjectViewQuerySchema.optional(),
  })
  .refine((value) => value.name !== undefined || value.query !== undefined, {
    message: '请提供要修改的字段',
  })
  .openapi('SavedViewUpdate');

export const ProjectBatchSchema = z
  .object({
    ids: z
      .array(z.string().uuid('项目无效'))
      .min(1, '请选择项目')
      .max(100, '单次最多操作 100 个项目'),
    action: z.enum(['status', 'owner', 'archive']).openapi('ProjectBatchAction'),
    status: ProjectStatusSchema.optional(),
    ownerId: z.string().uuid('负责人无效').optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === 'status' && value.status === undefined) {
      ctx.addIssue({ code: 'custom', message: '请选择目标状态', path: ['status'] });
    }
    if (value.action === 'owner' && value.ownerId === undefined) {
      ctx.addIssue({ code: 'custom', message: '请选择新的负责人', path: ['ownerId'] });
    }
  })
  .openapi('ProjectBatch');

export const TaskStatusSchema = z
  .enum(['todo', 'in_progress', 'review', 'done'])
  .openapi('TaskStatus');
export const TaskPrioritySchema = z
  .enum(['low', 'medium', 'high', 'urgent'])
  .openapi('TaskPriority');

export const TaskTitleSchema = z
  .string()
  .trim()
  .min(1, '任务标题不能为空')
  .max(160, '任务标题最多 160 个字符');

export const TaskCreateSchema = z
  .object({
    title: TaskTitleSchema,
    description: z.string().trim().max(2000, '任务描述最多 2000 个字符').optional(),
    status: TaskStatusSchema.optional(),
    priority: TaskPrioritySchema.optional(),
    assigneeId: z.string().uuid('负责人无效').nullable().optional(),
    dueDate: DateKeySchema.nullable().optional(),
    parentId: z.string().uuid('父任务无效').optional(),
    milestoneId: z.string().uuid('里程碑无效').nullable().optional(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
    estimatePoints: z.number().finite().min(0).max(10_000).nullable().optional(),
    estimateHours: z.number().finite().min(0).max(10_000).nullable().optional(),
    estimateSize: z.string().trim().max(20).nullable().optional(),
  })
  .openapi('TaskCreate');

export const TaskUpdateSchema = z
  .object({
    title: TaskTitleSchema.optional(),
    description: z.string().trim().max(2000, '任务描述最多 2000 个字符').optional(),
    status: TaskStatusSchema.optional(),
    priority: TaskPrioritySchema.optional(),
    assigneeId: z.string().uuid('负责人无效').nullable().optional(),
    dueDate: DateKeySchema.nullable().optional(),
    parentId: z.string().uuid('父任务无效').nullable().optional(),
    milestoneId: z.string().uuid('里程碑无效').nullable().optional(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
    estimatePoints: z.number().finite().min(0).max(10_000).nullable().optional(),
    estimateHours: z.number().finite().min(0).max(10_000).nullable().optional(),
    estimateSize: z.string().trim().max(20).nullable().optional(),
    version: z.number().int().min(1),
  })
  .openapi('TaskUpdate');

export const MilestoneCreateSchema = z
  .object({
    title: z.string().trim().min(1, '里程碑名称不能为空').max(120, '里程碑名称最多 120 个字符'),
    dueDate: DateKeySchema.nullable().optional(),
  })
  .openapi('MilestoneCreate');

export const ActivityQuerySchema = z.object({
  cursor: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  projectId: z.string().uuid().optional(),
  type: z.string().trim().max(40).optional(),
});

export const RangeQuerySchema = z.object({
  range: DateRangeKeySchema.default('30d'),
  from: z.string().trim().max(10).optional(),
  to: z.string().trim().max(10).optional(),
  granularity: z.enum(['day', 'week', 'month']).optional(),
});

export const UserCreateSchema = z
  .object({
    email: EmailSchema,
    name: NameSchema,
    role: RoleSchema,
    password: PasswordSchema,
    timezone: TimezoneSchema.optional(),
    workspaceId: z.string().trim().min(1).max(60).optional(),
    customRoleId: z.string().uuid().nullable().optional(),
  })
  .openapi('UserCreate');

export const UserUpdateSchema = z
  .object({
    name: NameSchema.optional(),
    role: RoleSchema.optional(),
    status: UserStatusSchema.optional(),
    timezone: TimezoneSchema.optional(),
    customRoleId: z.string().uuid().nullable().optional(),
    version: z.coerce.number().int().min(1).optional(),
  })
  .openapi('UserUpdate');

export const CustomRoleCreateSchema = z
  .object({
    name: z.string().trim().min(1, '角色名称不能为空').max(40),
    baseRole: RoleSchema,
    permissions: z.array(PermissionSchema).max(20).default([]),
  })
  .openapi('CustomRoleCreate');

export const CustomRoleUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(40).optional(),
    baseRole: RoleSchema.optional(),
    permissions: z.array(PermissionSchema).max(20).optional(),
  })
  .openapi('CustomRoleUpdate');

export const WorkspaceCreateSchema = z
  .object({
    name: z.string().trim().min(1, '工作区名称不能为空').max(60),
  })
  .openapi('WorkspaceCreate');

export const WorkspaceRenameSchema = z
  .object({
    name: z.string().trim().min(1, '工作区名称不能为空').max(60),
  })
  .openapi('WorkspaceRename');

export const UserQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  role: z.enum(['all', 'admin', 'manager', 'pm', 'viewer']).default('all'),
  status: z.enum(['all', 'active', 'disabled']).default('all'),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export const ProfileUpdateSchema = z
  .object({
    name: NameSchema,
    timezone: TimezoneSchema,
    version: z.coerce.number().int().min(1).optional(),
  })
  .openapi('ProfileUpdate');

export const PasswordChangeSchema = z
  .object({
    currentPassword: z.string().min(1, '请输入当前密码').max(200),
    newPassword: PasswordSchema,
  })
  .openapi('PasswordChange');

export const EmailChangeSchema = z
  .object({
    email: EmailSchema,
    password: z.string().min(1, '请输入当前密码').max(200),
  })
  .openapi('EmailChange');

export const AccountDeleteSchema = z
  .object({
    password: z.string().min(1, '请输入当前密码').max(200),
    confirmEmail: EmailSchema,
  })
  .openapi('AccountDelete');

export const PreferencesUpdateSchema = z
  .object({
    defaultRange: DateRangeKeySchema.optional(),
    emailNotifications: z.boolean().optional(),
    weeklyDigest: z.boolean().optional(),
    sidebarCollapsed: z.boolean().optional(),
    version: z.coerce.number().int().min(1).optional(),
  })
  .openapi('PreferencesUpdate');

export const SearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(120),
});

export const TokenScopeSchema = z.enum(['read', 'write']).openapi('TokenScope');

export const TokenCreateSchema = z
  .object({
    name: NameSchema,
    scopes: z.array(TokenScopeSchema).min(1, '至少选择一个权限').max(2),
    expiresInDays: z.number().int().min(1).max(3650).nullable().default(90),
  })
  .openapi('TokenCreate');

export const WebhookEventSchema = z.enum(WEBHOOK_EVENTS).openapi('WebhookEvent');

export const WebhookCreateSchema = z
  .object({
    url: z
      .string()
      .trim()
      .min(1, '请输入 Webhook 地址')
      .max(500, '地址最多 500 个字符')
      .refine((value) => webhookUrlIssue(value) === null, {
        message: 'Webhook 地址无效或指向内网',
      }),
    events: z.array(WebhookEventSchema).min(1, '至少订阅一个事件').max(10),
  })
  .openapi('WebhookCreate');

export const WebhookUpdateSchema = z
  .object({
    url: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .refine((value) => webhookUrlIssue(value) === null, {
        message: 'Webhook 地址无效或指向内网',
      })
      .optional(),
    events: z.array(WebhookEventSchema).min(1).max(10).optional(),
    active: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '请提供要修改的字段' })
  .openapi('WebhookUpdate');

export const ProjectMemberSchema = z.object({
  memberIds: z.array(z.string().uuid()).max(50),
});

export const ErrorSchema = z
  .object({
    error: z.string(),
    message: z.string().optional(),
  })
  .openapi('Error');

export const ImportResultSchema = z
  .object({ imported: z.number().int(), skipped: z.number().int() })
  .openapi('ImportResult');

export const SessionUserSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    role: RoleSchema,
    timezone: z.string(),
  })
  .openapi('SessionUser');

export const ProjectSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    status: ProjectStatusSchema,
    progress: z.number().int(),
    ownerId: z.string(),
    ownerName: z.string(),
    startDate: z.string().nullable(),
    dueDate: z.string().nullable(),
    tags: z.array(z.string()),
    favorite: z.boolean(),
    isDemo: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
    version: z.number().int(),
  })
  .openapi('Project');

export const ConflictSchema = z
  .object({
    error: z.literal('conflict'),
    message: z.string(),
    current: ProjectSchema,
  })
  .openapi('Conflict');

export const CommentCreateSchema = z
  .object({
    body: z.string().trim().min(1, '评论不能为空').max(2000, '评论最多 2000 个字符'),
    taskId: z.string().uuid('任务无效').nullable().optional(),
    mentions: z.array(z.string().uuid('提及成员无效')).max(10, '最多提及 10 人').optional(),
  })
  .openapi('CommentCreate');

export const CommentQuerySchema = z.object({
  taskId: z.string().uuid('任务无效').optional(),
});

export const NotificationReadSchema = z
  .object({
    ids: z.array(z.string().uuid('通知无效')).max(100).optional(),
    all: z.boolean().optional(),
  })
  .refine((value) => value.all === true || (value.ids?.length ?? 0) > 0, {
    message: '请选择要标记的通知',
  })
  .openapi('NotificationRead');

export const NotificationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export const AuditQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  action: z.string().trim().max(60).default('all'),
  actor: z.string().trim().max(40).default('all'),
  from: DateKeySchema.optional(),
  to: DateKeySchema.optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export const AuditCleanupSchema = z
  .object({
    days: z.number().int().min(1, '至少保留 1 天').max(3650, '最多保留 3650 天').optional(),
  })
  .openapi('AuditCleanup');

export const CurrencySchema = z
  .enum(['USD', 'CNY', 'EUR', 'GBP', 'JPY', 'HKD', 'SGD'])
  .openapi('Currency');

export const WorkspaceUpdateSchema = z
  .object({
    currency: CurrencySchema.optional(),
    rate: z.number().finite().positive('汇率必须大于 0').max(100_000, '汇率过大').optional(),
    timeLogVisibility: z.enum(['all', 'managers', 'self']).optional(),
  })
  .refine(
    (value) =>
      value.currency !== undefined ||
      value.rate !== undefined ||
      value.timeLogVisibility !== undefined,
    {
      message: '至少修改币种、汇率或工时可见范围',
    },
  )
  .openapi('WorkspaceUpdate');

export const MetricRecordSchema = z
  .object({
    date: DateKeySchema,
    revenue: z.number().finite().min(0, '收入不能为负').max(1_000_000_000_000),
    customers: z.number().int().min(0).max(1_000_000_000),
    conversions: z.number().int().min(0).max(1_000_000_000),
    visitors: z.number().int().min(0).max(1_000_000_000),
    currency: CurrencySchema.optional(),
  })
  .openapi('MetricRecord');

export const MetricsImportSchema = z
  .object({
    records: z.array(MetricRecordSchema).min(1, '至少提供一条记录').max(366),
  })
  .openapi('MetricsImport');

export const MetricsQuerySchema = z.object({
  from: DateKeySchema,
  to: DateKeySchema,
});

export const ReportKindSchema = z.enum(['revenue', 'channels', 'audience']).openapi('ReportKind');

export const ReportFrequencySchema = z
  .enum(['none', 'weekly', 'monthly'])
  .openapi('ReportFrequency');

export const SavedReportQuerySchema = RangeQuerySchema.extend({
  kind: ReportKindSchema.default('revenue'),
  compare: z.boolean().optional(),
}).openapi('SavedReportQuery');

export const SavedReportCreateSchema = z
  .object({
    name: NameSchema.max(60, '报表名称最多 60 个字符'),
    query: SavedReportQuerySchema,
    frequency: ReportFrequencySchema.default('none'),
  })
  .openapi('SavedReportCreate');

export const SavedReportUpdateSchema = z
  .object({
    name: NameSchema.max(60, '报表名称最多 60 个字符').optional(),
    query: SavedReportQuerySchema.optional(),
    frequency: ReportFrequencySchema.optional(),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: '至少修改一个字段',
  })
  .openapi('SavedReportUpdate');

export const ReportExportQuerySchema = RangeQuerySchema.extend({
  kind: ReportKindSchema.default('revenue'),
  compare: z.enum(['0', '1']).optional(),
}).openapi('ReportExportQuery');

export const AttachmentDownloadQuerySchema = z
  .object({
    expires: z.string().regex(/^\d+$/, '过期时间无效'),
    sig: z.string().min(32).max(128),
  })
  .openapi('AttachmentDownloadQuery');

const PushEndpointSchema = z
  .string()
  .max(2048, '推送地址过长')
  .regex(/^https:\/\/[^\s]+$/, '推送地址必须是 HTTPS URL')
  .refine((value) => webhookUrlIssue(value) === null, {
    message: '推送地址无效或指向内网',
  });

export const PushSubscribeSchema = z
  .object({
    endpoint: PushEndpointSchema,
    keys: z.object({
      p256dh: z.string().regex(/^[A-Za-z0-9_-]{80,120}$/, 'p256dh 公钥无效'),
      auth: z.string().regex(/^[A-Za-z0-9_-]{16,40}$/, 'auth 密钥无效'),
    }),
  })
  .openapi('PushSubscribe');

export const PushUnsubscribeSchema = z
  .object({ endpoint: PushEndpointSchema })
  .openapi('PushUnsubscribe');

export type LoginInput = z.infer<typeof LoginSchema>;
export type ProjectCreateInput = z.infer<typeof ProjectCreateSchema>;
export type ProjectUpdateInput = z.infer<typeof ProjectUpdateSchema>;
export type UserCreateInput = z.infer<typeof UserCreateSchema>;
export type UserUpdateInput = z.infer<typeof UserUpdateSchema>;

const RetentionDaysSchema = z.number().int().min(1, '至少保留 1 天').max(3650, '最多保留 3650 天');
/** OCR retention accepts 0, which disables automatic purging. */
const OcrRetentionDaysSchema = z.number().int().min(0, '不能为负数').max(3650, '最多保留 3650 天');

export const OpsSettingsUpdateSchema = z
  .object({
    backupRetentionDays: RetentionDaysSchema.optional(),
    trashRetentionDays: RetentionDaysSchema.optional(),
    auditRetentionDays: RetentionDaysSchema.optional(),
    activityRetentionDays: RetentionDaysSchema.optional(),
    ocrRetentionDays: OcrRetentionDaysSchema.optional(),
    demoDataEnabled: z.boolean().optional(),
  })
  .openapi('OpsSettingsUpdate');

export const OpsFeatureUpdateSchema = z
  .object({ enabled: z.boolean() })
  .openapi('OpsFeatureUpdate');

export const OpsDemoDataSchema = z.object({ enabled: z.boolean() }).openapi('OpsDemoData');

export const OpsRestoreSchema = z
  .object({
    file: z
      .string()
      .trim()
      .min(1, '请选择备份文件')
      .max(200, '文件名过长')
      .regex(/^[A-Za-z0-9._-]+\.db$/, '备份文件名无效'),
  })
  .openapi('OpsRestore');

// ---------------------------------------------------------------------------
// Enterprise module (schema v15)
// ---------------------------------------------------------------------------

const OptionalMeasureSchema = z.number().finite().min(-1_000_000_000).max(1_000_000_000).nullable();

export const GoalLevelSchema = z
  .enum(['company', 'department', 'workspace', 'project'])
  .openapi('GoalLevel');
export const GoalStatusSchema = z.enum(['active', 'locked', 'archived']).openapi('GoalStatus');
export const GoalUpdateModeSchema = z.enum(['manual', 'linked']).openapi('GoalUpdateMode');

const GoalFieldsSchema = z.object({
  level: GoalLevelSchema.optional(),
  parentId: z.string().uuid('父目标无效').nullable().optional(),
  projectId: z.string().uuid('项目无效').nullable().optional(),
  title: z
    .string()
    .trim()
    .min(1, '目标名称不能为空')
    .max(160, '目标名称最多 160 个字符')
    .optional(),
  description: z.string().trim().max(2000).optional(),
  ownerId: z.string().uuid('负责人无效').nullable().optional(),
  weight: z.number().finite().positive('权重必须大于 0').max(100).optional(),
  period: z.string().trim().max(20).optional(),
  baseline: OptionalMeasureSchema.optional(),
  target: OptionalMeasureSchema.optional(),
  actual: OptionalMeasureSchema.optional(),
  unit: z.string().trim().max(20).optional(),
  updateMode: GoalUpdateModeSchema.optional(),
  status: GoalStatusSchema.optional(),
});

export const GoalCreateSchema = GoalFieldsSchema.extend({
  title: z.string().trim().min(1, '目标名称不能为空').max(160, '目标名称最多 160 个字符'),
})
  .superRefine((value, ctx) => {
    if (value.level === 'project' && !value.projectId) {
      ctx.addIssue({ code: 'custom', message: '项目级目标必须关联项目', path: ['projectId'] });
    }
  })
  .openapi('GoalCreate');

export const GoalUpdateSchema = GoalFieldsSchema.extend({
  version: z.number().int().min(1),
  reason: z.string().trim().max(500).optional(),
})
  .superRefine((value, ctx) => {
    const keys = Object.keys(value).filter((key) => key !== 'version' && key !== 'reason');
    if (keys.length === 0) {
      ctx.addIssue({ code: 'custom', message: '请提供要修改的字段' });
    }
  })
  .openapi('GoalUpdate');

export const GoalImpactSchema = GoalFieldsSchema.extend({
  reason: z.string().trim().max(500).optional(),
}).openapi('GoalImpact');

export const GoalQuerySchema = z.object({
  projectId: z.string().uuid('项目无效').optional(),
  level: GoalLevelSchema.optional(),
  includeArchived: z.enum(['0', '1']).optional(),
});

export const KeyResultCreateSchema = z
  .object({
    title: z.string().trim().min(1, '关键结果不能为空').max(160),
    unit: z.string().trim().max(20).optional(),
    baseline: OptionalMeasureSchema.optional(),
    target: OptionalMeasureSchema.optional(),
    actual: OptionalMeasureSchema.optional(),
    weight: z.number().finite().positive().max(100).optional(),
    updateMode: GoalUpdateModeSchema.optional(),
  })
  .openapi('KeyResultCreate');

export const KeyResultUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    unit: z.string().trim().max(20).optional(),
    baseline: OptionalMeasureSchema.optional(),
    target: OptionalMeasureSchema.optional(),
    actual: OptionalMeasureSchema.optional(),
    weight: z.number().finite().positive().max(100).optional(),
    updateMode: GoalUpdateModeSchema.optional(),
    version: z.number().int().min(1),
  })
  .openapi('KeyResultUpdate');

export const GoalLinkCreateSchema = z
  .object({
    projectId: z.string().uuid('项目无效'),
    keyResultId: z.string().uuid('关键结果无效').nullable().optional(),
    taskId: z.string().uuid('任务无效').nullable().optional(),
    milestoneId: z.string().uuid('里程碑无效').nullable().optional(),
  })
  .openapi('GoalLinkCreate');

export const PortfolioFactorSchema = z
  .object({
    key: z.string().trim().min(1).max(40),
    label: z.string().trim().min(1).max(40).optional(),
    weight: z.number().finite().min(0).max(1),
    direction: z.enum(['positive', 'negative']).default('positive'),
  })
  .openapi('PortfolioFactor');

const PortfolioWeightsSchema = z
  .array(PortfolioFactorSchema)
  .min(1, '至少配置一个评分因子')
  .max(10, '最多配置 10 个评分因子')
  .refine(
    (factors) => Math.abs(factors.reduce((sum, factor) => sum + factor.weight, 0) - 1) <= 0.001,
    { message: '评分权重合计必须为 1' },
  );

export const PortfolioConfigCreateSchema = z
  .object({
    name: z.string().trim().min(1, '模板名称不能为空').max(80),
    weights: PortfolioWeightsSchema,
    active: z.boolean().optional(),
  })
  .openapi('PortfolioConfigCreate');

export const PortfolioConfigUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    weights: PortfolioWeightsSchema.optional(),
    active: z.boolean().optional(),
    version: z.number().int().min(1),
  })
  .openapi('PortfolioConfigUpdate');

export const PortfolioFactorValueSchema = z.object({
  key: z.string().trim().min(1).max(40),
  value: z.number().finite().min(0).max(5).nullable(),
});

export const PortfolioScoreSchema = z
  .object({
    projectId: z.string().uuid('项目无效'),
    configId: z.string().uuid('评分模板无效'),
    factors: z.array(PortfolioFactorValueSchema).min(1).max(10),
    overrideScore: z.number().finite().min(0).max(5).nullable().optional(),
    overrideReason: z.string().trim().max(500).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.overrideScore != null && !value.overrideReason?.trim()) {
      ctx.addIssue({
        code: 'custom',
        message: '人工覆盖评分必须填写理由',
        path: ['overrideReason'],
      });
    }
  })
  .openapi('PortfolioScore');

export const PortfolioQuerySchema = z.object({
  configId: z.string().uuid('评分模板无效').optional(),
});

export const DependencyTypeSchema = z.enum(['FS', 'SS', 'FF', 'SF']).openapi('DependencyType');

export const DependencyCreateSchema = z
  .object({
    predecessorId: z.string().uuid('前置任务无效'),
    successorId: z.string().uuid('后置任务无效'),
    type: DependencyTypeSchema.default('FS'),
    lagDays: z.number().int().min(0).max(365).default(0),
  })
  .openapi('DependencyCreate');

export const DependencyQuerySchema = z.object({
  projectId: z.string().uuid('项目无效'),
});

export const TimeLogCreateSchema = z
  .object({
    minutes: z.number().int().min(1, '至少记录 1 分钟').max(1440, '单条记录不能超过 24 小时'),
    workDate: DateKeySchema,
    note: z.string().trim().max(500).optional(),
    idempotencyKey: z.string().trim().min(1).max(80).optional(),
  })
  .openapi('TimeLogCreate');

export const TimeLogUpdateSchema = z
  .object({
    minutes: z.number().int().min(1).max(1440).optional(),
    workDate: DateKeySchema.optional(),
    note: z.string().trim().max(500).optional(),
    version: z.number().int().min(1),
  })
  .openapi('TimeLogUpdate');

export const TimeLogQuerySchema = z.object({
  taskId: z.string().uuid('任务无效').optional(),
  projectId: z.string().uuid('项目无效').optional(),
});

export const BlockerCategorySchema = z
  .enum(['external', 'decision', 'environment', 'data', 'dependency', 'other'])
  .openapi('BlockerCategory');

export const BlockerCreateSchema = z
  .object({
    reason: z.string().trim().min(1, '请填写阻塞原因').max(500),
    category: BlockerCategorySchema.default('other'),
    ownerTeam: z.string().trim().max(80).optional(),
    expectedResolveAt: z
      .string()
      .trim()
      .max(40)
      .refine((value) => !Number.isNaN(Date.parse(value)), '预计解除时间格式无效')
      .nullable()
      .optional(),
  })
  .openapi('BlockerCreate');

export const BlockerResolveSchema = z
  .object({
    evidence: z.string().trim().min(1, '请填写解除证据').max(1000),
    version: z.number().int().min(1),
  })
  .openapi('BlockerResolve');

export const BlockerQuerySchema = z.object({
  projectId: z.string().uuid('项目无效'),
  status: z.enum(['all', 'open', 'resolved']).default('all'),
});

export const RecurrenceCreateSchema = z
  .object({
    title: z.string().trim().min(1, '任务标题不能为空').max(160),
    description: z.string().trim().max(2000).optional(),
    status: TaskStatusSchema.optional(),
    priority: TaskPrioritySchema.optional(),
    assigneeId: z.string().uuid('负责人无效').nullable().optional(),
    rule: z
      .string()
      .trim()
      .min(10, '重复规则过短')
      .max(200, '重复规则最多 200 个字符')
      .refine((value) => /FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/.test(value), '缺少 FREQ 规则'),
    timezone: TimezoneSchema.optional(),
    startsOn: DateKeySchema,
    endsOn: DateKeySchema.nullable().optional(),
    count: z.number().int().min(1).max(365).nullable().optional(),
    exceptions: z.array(DateKeySchema).max(100).optional(),
    holidays: z.array(DateKeySchema).max(100).optional(),
  })
  .openapi('RecurrenceCreate');

export const RecurrenceUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().max(2000).optional(),
    status: TaskStatusSchema.optional(),
    priority: TaskPrioritySchema.optional(),
    assigneeId: z.string().uuid().nullable().optional(),
    rule: z.string().trim().min(10).max(200).optional(),
    timezone: TimezoneSchema.optional(),
    startsOn: DateKeySchema.optional(),
    endsOn: DateKeySchema.nullable().optional(),
    count: z.number().int().min(1).max(365).nullable().optional(),
    exceptions: z.array(DateKeySchema).max(100).optional(),
    holidays: z.array(DateKeySchema).max(100).optional(),
    active: z.boolean().optional(),
    version: z.number().int().min(1),
  })
  .openapi('RecurrenceUpdate');

export const RecurrenceRunSchema = z
  .object({ through: DateKeySchema.optional() })
  .openapi('RecurrenceRun');

export const RecurrenceQuerySchema = z.object({
  projectId: z.string().uuid('项目无效'),
});

export const AutomationTriggerSchema = z
  .enum(['task.created', 'task.updated', 'task.completed', 'blocker.created', 'dependency.created'])
  .openapi('AutomationTrigger');

export const AutomationConditionSchema = z
  .object({
    field: z.string().trim().min(1).max(40),
    operator: z.enum(['eq', 'neq', 'in', 'contains', 'exists']),
    value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]).optional(),
  })
  .openapi('AutomationCondition');

export const AutomationActionSchema = z
  .object({
    type: z.enum([
      'set_status',
      'set_priority',
      'assign_to',
      'add_comment',
      'create_task',
      'notify',
    ]),
    value: z.string().trim().max(200).optional(),
    title: z.string().trim().max(160).optional(),
  })
  .openapi('AutomationAction');

export const AutomationRuleCreateSchema = z
  .object({
    name: z.string().trim().min(1, '规则名称不能为空').max(120),
    projectId: z.string().uuid('项目无效').nullable().optional(),
    trigger: AutomationTriggerSchema,
    conditions: z.array(AutomationConditionSchema).max(10).optional(),
    actions: z.array(AutomationActionSchema).min(1, '至少配置一个动作').max(5),
    active: z.boolean().optional(),
    maxRunsPerHour: z.number().int().min(1).max(600).optional(),
  })
  .openapi('AutomationRuleCreate');

export const AutomationRuleUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    projectId: z.string().uuid().nullable().optional(),
    trigger: AutomationTriggerSchema.optional(),
    conditions: z.array(AutomationConditionSchema).max(10).optional(),
    actions: z.array(AutomationActionSchema).min(1).max(5).optional(),
    active: z.boolean().optional(),
    maxRunsPerHour: z.number().int().min(1).max(600).optional(),
    version: z.number().int().min(1),
  })
  .openapi('AutomationRuleUpdate');

export const AutomationDryRunSchema = z
  .object({
    trigger: AutomationTriggerSchema,
    task: z
      .object({
        id: z.string().optional(),
        title: z.string().optional(),
        status: TaskStatusSchema.optional(),
        priority: TaskPrioritySchema.optional(),
        assigneeId: z.string().nullable().optional(),
        projectId: z.string().optional(),
      })
      .optional(),
    eventKey: z.string().trim().max(120).optional(),
  })
  .openapi('AutomationDryRun');

export const AutomationPruneSchema = z
  .object({
    olderThanDays: z.number().int().min(1).max(3650).default(30),
  })
  .openapi('AutomationPrune');

export const AutomationQuerySchema = z.object({
  trigger: AutomationTriggerSchema.optional(),
  projectId: z.string().uuid('项目无效').optional(),
});

export const AutomationRunsQuerySchema = z.object({
  ruleId: z.string().uuid('规则无效').optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const DocumentStatusSchema = z
  .enum(['draft', 'review', 'published', 'expired', 'archived'])
  .openapi('DocumentStatus');
const DocumentConfidentialitySchema = z
  .enum(['internal', 'restricted', 'confidential'])
  .openapi('DocumentConfidentiality');

export const DocumentCreateSchema = z
  .object({
    title: z.string().trim().min(1, '文档标题不能为空').max(160),
    content: z.string().max(100_000, '文档内容最多 100000 个字符').optional(),
    format: z.enum(['markdown', 'text']).optional(),
    status: DocumentStatusSchema.optional(),
    ownerId: z.string().uuid('负责人无效').nullable().optional(),
    confidentiality: DocumentConfidentialitySchema.optional(),
    reviewDueAt: DateKeySchema.nullable().optional(),
    reviewCycleDays: z.number().int().min(1).max(3650).nullable().optional(),
  })
  .openapi('DocumentCreate');

export const DocumentUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    content: z.string().max(100_000).optional(),
    format: z.enum(['markdown', 'text']).optional(),
    status: DocumentStatusSchema.optional(),
    ownerId: z.string().uuid().nullable().optional(),
    confidentiality: DocumentConfidentialitySchema.optional(),
    reviewDueAt: DateKeySchema.nullable().optional(),
    reviewCycleDays: z.number().int().min(1).max(3650).nullable().optional(),
    changeSummary: z.string().trim().max(200).optional(),
    version: z.number().int().min(1),
  })
  .openapi('DocumentUpdate');

export const DocumentRestoreSchema = z
  .object({
    version: z.number().int().min(1),
    changeSummary: z.string().trim().max(200).optional(),
  })
  .openapi('DocumentRestore');

export const DocumentQuerySchema = z.object({
  projectId: z.string().uuid('项目无效'),
  status: z.enum(['all', 'draft', 'review', 'published', 'expired', 'archived']).default('all'),
  q: z.string().trim().max(120).optional(),
});

export const DecisionStatusSchema = z
  .enum(['proposed', 'approved', 'rejected', 'superseded'])
  .openapi('DecisionStatus');

export const DecisionOptionSchema = z.object({
  title: z.string().trim().min(1).max(160),
  pros: z.string().trim().max(1000).optional(),
  cons: z.string().trim().max(1000).optional(),
});

export const DecisionCreateSchema = z
  .object({
    projectId: z.string().uuid('项目无效').nullable().optional(),
    title: z.string().trim().min(1, '决策标题不能为空').max(160),
    status: DecisionStatusSchema.optional(),
    context: z.string().trim().max(5000).optional(),
    options: z.array(DecisionOptionSchema).max(10).optional(),
    decision: z.string().trim().max(5000).optional(),
    consequences: z.string().trim().max(5000).optional(),
    reviewAt: DateKeySchema.nullable().optional(),
  })
  .openapi('DecisionCreate');

export const DecisionUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    status: DecisionStatusSchema.optional(),
    context: z.string().trim().max(5000).optional(),
    options: z.array(DecisionOptionSchema).max(10).optional(),
    decision: z.string().trim().max(5000).optional(),
    consequences: z.string().trim().max(5000).optional(),
    reviewAt: DateKeySchema.nullable().optional(),
    changeSummary: z.string().trim().max(200).optional(),
    version: z.number().int().min(1),
  })
  .openapi('DecisionUpdate');

export const DecisionQuerySchema = z.object({
  projectId: z.string().uuid('项目无效').optional(),
  status: z.enum(['all', 'proposed', 'approved', 'rejected', 'superseded']).default('all'),
  q: z.string().trim().max(120).optional(),
});

export const MetricCreateSchema = z
  .object({
    name: z.string().trim().min(1, '指标名称不能为空').max(80),
    unit: z.string().trim().max(20).optional(),
    formula: z.string().trim().min(1, '公式不能为空').max(500),
    dimensions: z.array(z.string().trim().min(1).max(40)).max(5).optional(),
    aggregation: z.enum(['sum', 'avg', 'min', 'max', 'count']).optional(),
    refreshMinutes: z.number().int().min(1).max(10_080).optional(),
    ownerId: z.string().uuid('负责人无效').nullable().optional(),
  })
  .openapi('MetricCreate');

export const MetricUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    unit: z.string().trim().max(20).optional(),
    formula: z.string().trim().min(1).max(500).optional(),
    dimensions: z.array(z.string().trim().min(1).max(40)).max(5).optional(),
    aggregation: z.enum(['sum', 'avg', 'min', 'max', 'count']).optional(),
    refreshMinutes: z.number().int().min(1).max(10_080).optional(),
    ownerId: z.string().uuid().nullable().optional(),
    status: z.enum(['draft', 'published', 'archived']).optional(),
    changeSummary: z.string().trim().max(200).optional(),
    version: z.number().int().min(1),
  })
  .openapi('MetricUpdate');

export const MetricQuerySchema = z.object({
  status: z.enum(['all', 'draft', 'published', 'archived']).default('all'),
});

export const MetricEvaluateSchema = z
  .object({
    from: DateKeySchema,
    to: DateKeySchema,
    groupBy: z.enum(['day', 'week', 'month']).optional(),
  })
  .openapi('MetricEvaluate');

export const BudgetUpsertSchema = z
  .object({
    costCenter: z.string().trim().max(80).optional(),
    currency: CurrencySchema.optional(),
    budgetCents: z.number().int().min(0).max(1_000_000_000_000).optional(),
    forecastCents: z.number().int().min(0).max(1_000_000_000_000).optional(),
    fxRate: z.number().finite().positive('汇率必须大于 0').max(100_000).optional(),
    fxDate: DateKeySchema.nullable().optional(),
    thresholdPct: z.number().int().min(1).max(100).optional(),
    version: z.number().int().min(1).optional(),
  })
  .openapi('BudgetUpsert');

export const BudgetEntryCreateSchema = z
  .object({
    kind: z.enum(['committed', 'actual', 'forecast']),
    amountCents: z.number().int().min(-1_000_000_000_000).max(1_000_000_000_000),
    currency: CurrencySchema.optional(),
    fxRate: z.number().finite().positive().max(100_000).optional(),
    fxDate: DateKeySchema.nullable().optional(),
    note: z.string().trim().max(500).optional(),
    idempotencyKey: z.string().trim().min(1).max(80).optional(),
  })
  .openapi('BudgetEntryCreate');

export const PermissionSimulateSchema = z
  .object({
    userId: z.string().uuid('用户无效'),
    resourceType: z.enum(['workspace', 'project', 'task']),
    resourceId: z.string().trim().max(80),
    action: z.string().trim().min(1, '请选择操作').max(60),
  })
  .openapi('PermissionSimulate');

export const JitGrantCreateSchema = z
  .object({
    userId: z.string().uuid('用户无效').optional(),
    permissions: z.array(PermissionSchema).min(1, '至少选择一项权限').max(5),
    resourceType: z.enum(['workspace', 'project', 'task']),
    resourceId: z.string().trim().max(80).optional(),
    action: z.string().trim().max(60).optional(),
    reason: z.string().trim().min(3, '请填写申请理由').max(500),
    durationMinutes: z.number().int().min(5, '至少 5 分钟').max(1440, '最多 24 小时'),
    startsAt: z
      .string()
      .trim()
      .max(40)
      .refine((value) => !Number.isNaN(Date.parse(value)), '生效时间格式无效')
      .optional(),
  })
  .openapi('JitGrantCreate');

export const JitNoteSchema = z
  .object({ note: z.string().trim().max(500).optional() })
  .openapi('JitNote');

export const JitQuerySchema = z.object({
  status: z.enum(['all', 'pending', 'active', 'rejected', 'revoked', 'expired']).default('all'),
  userId: z.string().uuid('用户无效').optional(),
});

// ---------------------------------------------------------------------------
// Enterprise operations (schema v16)
// ---------------------------------------------------------------------------

const IdSchema = z.string().trim().min(1).max(80);
const ReasonSchema = z.string().trim().min(3, '请填写至少 3 个字符的理由').max(1000);
const NoteSchema = z.string().trim().max(1000).optional();
const JsonObjectSchema = z.record(z.string(), z.unknown());
const JsonArraySchema = z.array(z.unknown());
const TimestampSchema = z
  .string()
  .trim()
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)), '时间格式无效');
const NullableIdSchema = IdSchema.nullable().optional();

export const WorkbenchResourceSchema = z
  .enum([
    'stage-gates',
    'stage-gate-events',
    'health-snapshots',
    'baselines',
    'change-requests',
    'capacity-allocations',
    'benefit-reviews',
    'sla-policies',
    'sla-instances',
    'task-forms',
    'task-form-values',
    'checklist-items',
    'dispatch-rules',
    'dispatch-recommendations',
    'handoffs',
    'deliverables',
    'deliverable-versions',
    'blocker-events',
    'document-comments',
    'knowledge-links',
    'meetings',
    'meeting-attendees',
    'meeting-actions',
    'channels',
    'channel-messages',
    'portals',
    'portal-accounts',
    'portal-requests',
    'retrospectives',
    'playbooks',
    'workflows',
    'workflow-versions',
    'workflow-runs',
    'workflow-events',
    'approvals',
    'approval-decisions',
    'delegations',
    'triggers',
    'connectors',
    'event-subscriptions',
    'events',
    'event-deliveries',
    'jobs',
    'anomalies',
    'quality-rules',
    'quality-issues',
    'scenarios',
    'opportunities',
    'query-reports',
    'report-subscriptions',
    'report-deliveries',
    'lineage',
    'budget-categories',
    'organizations',
    'departments',
    'org-memberships',
    'workspace-memberships',
    'permission-samples',
    'automation-rule-versions',
  ])
  .openapi('WorkbenchResource');

export const WorkbenchQuerySchema = z.object({
  workspaceId: z.string().uuid('工作区无效').optional(),
  projectId: z.string().uuid('项目无效').optional(),
  taskId: z.string().uuid('任务无效').optional(),
  documentId: z.string().uuid('文档无效').optional(),
  meetingId: z.string().uuid('会议无效').optional(),
  channelId: z.string().uuid('频道无效').optional(),
  portalId: z.string().uuid('门户无效').optional(),
  workflowId: z.string().uuid('工作流无效').optional(),
  runId: z.string().uuid('运行实例无效').optional(),
  gateId: z.string().uuid('阶段门无效').optional(),
  closureId: z.string().uuid('结项记录无效').optional(),
  deliverableId: z.string().uuid('交付物无效').optional(),
  blockerId: z.string().uuid('阻塞无效').optional(),
  requestId: z.string().uuid('审批请求无效').optional(),
  subscriptionId: z.string().uuid('订阅无效').optional(),
  budgetId: z.string().uuid('预算无效').optional(),
  metricId: z.string().uuid('指标无效').optional(),
  ruleId: z.string().uuid('规则无效').optional(),
  orgId: z.string().uuid('组织无效').optional(),
  eventId: z.string().uuid('事件无效').optional(),
  status: z.string().trim().max(40).optional(),
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const WorkbenchCreateSchema = z
  .object({ resource: WorkbenchResourceSchema })
  .catchall(z.unknown())
  .openapi('WorkbenchCreate');

export const WorkbenchUpdateSchema = z
  .object({ version: z.number().int().min(1).optional() })
  .catchall(z.unknown())
  .openapi('WorkbenchUpdate');

export const GateDecisionSchema = z
  .object({
    action: z.enum(['approve', 'reject', 'withdraw', 'waive', 'escalate']),
    note: z.string().trim().max(1000).optional(),
    version: z.number().int().min(1),
  })
  .openapi('GateDecision');

export const StageGateCreateSchema = z
  .object({
    name: z.string().trim().min(1, '阶段门名称不能为空').max(120),
    phase: z.string().trim().max(40).optional(),
    requiredMaterials: z.array(z.string().trim().max(200)).max(30).optional(),
    checklist: z
      .array(
        z.object({ label: z.string().trim().min(1).max(200), required: z.boolean().optional() }),
      )
      .max(50)
      .optional(),
    approverIds: z.array(z.string().uuid()).max(20).optional(),
    slaHours: z.number().int().min(1).max(8760).optional(),
    dueAt: TimestampSchema.nullable().optional(),
    fallback: z.string().trim().max(120).optional(),
  })
  .openapi('StageGateCreate');

export const StageGateUpdateSchema = StageGateCreateSchema.partial().extend({
  decisionNote: z.string().trim().max(1000).optional(),
  version: z.number().int().min(1),
});

export const BaselineCreateSchema = z
  .object({
    label: z.string().trim().max(120).optional(),
    reason: ReasonSchema,
    changeSummary: z.string().trim().max(300).optional(),
  })
  .openapi('BaselineCreate');

export const BaselineDecisionSchema = z
  .object({ action: z.enum(['approve', 'reject']), note: NoteSchema })
  .openapi('BaselineDecision');

export const ChangeRequestCreateSchema = z
  .object({
    title: z.string().trim().min(1, '变更标题不能为空').max(160),
    kind: z.enum(['scope', 'schedule', 'budget', 'resource', 'other']).default('scope'),
    reason: z.string().trim().max(2000).optional(),
    proposed: JsonObjectSchema.optional(),
    impact: JsonObjectSchema.optional(),
  })
  .openapi('ChangeRequestCreate');

export const ChangeRequestUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    kind: z.enum(['scope', 'schedule', 'budget', 'resource', 'other']).optional(),
    reason: z.string().trim().max(2000).optional(),
    status: z.enum(['draft', 'submitted']).optional(),
    proposed: JsonObjectSchema.optional(),
    impact: JsonObjectSchema.optional(),
    version: z.number().int().min(1),
  })
  .openapi('ChangeRequestUpdate');

export const ChangeRequestDecisionSchema = z
  .object({
    action: z.enum(['approve', 'reject', 'implement']),
    note: NoteSchema,
    version: z.number().int().min(1),
  })
  .openapi('ChangeRequestDecision');

export const CapacityProfileUpdateSchema = z
  .object({
    weeklyHours: z.number().min(0).max(168).optional(),
    fte: z.number().min(0).max(1.5).optional(),
    skills: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  })
  .openapi('CapacityProfileUpdate');

export const CapacityAllocationCreateSchema = z
  .object({
    userId: z.string().uuid('成员无效'),
    projectId: z.string().uuid('项目无效').nullable().optional(),
    role: z.string().trim().max(80).optional(),
    weeklyHours: z.number().min(0).max(168),
    startDate: DateKeySchema,
    endDate: DateKeySchema,
    kind: z.enum(['allocation', 'leave']).default('allocation'),
  })
  .superRefine((value, ctx) => {
    if (value.endDate < value.startDate) {
      ctx.addIssue({ code: 'custom', message: '结束日期不能早于开始日期', path: ['endDate'] });
    }
  })
  .openapi('CapacityAllocationCreate');

export const CapacityQuerySchema = z.object({
  from: DateKeySchema.optional(),
  to: DateKeySchema.optional(),
});

export const CapacityPlanSchema = z.object({
  from: DateKeySchema.optional(),
  to: DateKeySchema.optional(),
  bucket: z.enum(['week', 'month']).default('week'),
  role: z.string().trim().max(20).optional(),
  skill: z.string().trim().max(40).optional(),
  userId: z.string().uuid().optional(),
});

export const CapacityScenarioSchema = z
  .object({
    adjustments: z
      .array(z.object({ userId: z.string().uuid(), weeklyHours: z.number().min(0).max(168) }))
      .max(100),
    from: DateKeySchema.optional(),
    to: DateKeySchema.optional(),
  })
  .openapi('CapacityScenario');

export const ClosureCreateSchema = z
  .object({
    acceptance: z.array(z.object({ item: z.string().max(200), accepted: z.boolean() })).max(50),
    actualCostCents: z.number().int().min(0).max(1_000_000_000_000).default(0),
    deliverables: z.array(z.string().trim().max(200)).max(50).optional(),
    openItems: z.array(z.string().trim().max(200)).max(50).optional(),
    feedback: z.string().trim().max(2000).optional(),
    benefitPlan: z
      .array(
        z.object({
          label: z.string().trim().min(1).max(120),
          targetValue: z.number().finite(),
          dueOn: DateKeySchema,
        }),
      )
      .max(20)
      .optional(),
  })
  .openapi('ClosureCreate');

export const ClosureReopenSchema = z.object({ reason: ReasonSchema }).openapi('ClosureReopen');

export const BenefitRecordSchema = z
  .object({ actual: JsonObjectSchema, note: NoteSchema })
  .openapi('BenefitRecord');

export const SlaPolicyCreateSchema = z
  .object({
    name: z.string().trim().min(1, '策略名称不能为空').max(120),
    taskType: z.string().trim().max(40).optional(),
    priority: z.string().trim().max(20).optional(),
    customerTier: z.string().trim().max(40).optional(),
    responseMinutes: z.number().int().min(1).max(525_600).optional(),
    resolveMinutes: z.number().int().min(1).max(525_600).optional(),
    reviewMinutes: z.number().int().min(1).max(525_600).optional(),
    businessHours: JsonArraySchema.optional(),
    holidays: JsonArraySchema.optional(),
    escalation: JsonArraySchema.optional(),
    active: z.boolean().optional(),
  })
  .openapi('SlaPolicyCreate');

export const SlaPolicyUpdateSchema = SlaPolicyCreateSchema.partial().extend({
  version: z.number().int().min(1),
});

export const TaskSlaAttachSchema = z
  .object({
    policyId: z.string().uuid('SLA 策略无效').optional(),
    auto: z.boolean().optional(),
  })
  .refine((value) => Boolean(value.policyId) || value.auto === true, {
    message: '请选择 SLA 策略或启用自动匹配',
  })
  .openapi('TaskSlaAttach');

export const TaskSlaActionSchema = z
  .object({ reason: z.string().trim().max(500).optional() })
  .openapi('TaskSlaAction');

export const FormCreateSchema = z
  .object({
    name: z.string().trim().min(1, '表单名称不能为空').max(120),
    fields: z
      .array(
        z.object({
          key: z.string().trim().min(1).max(40),
          label: z.string().trim().min(1).max(120),
          type: z.enum(['text', 'textarea', 'number', 'date', 'select', 'checkbox', 'signature']),
          required: z.boolean().optional(),
          options: z.array(z.string().max(80)).max(30).optional(),
          visibleWhen: z
            .object({
              key: z.string().max(40),
              equals: z.union([z.string(), z.number(), z.boolean()]),
            })
            .optional(),
          min: z.number().optional(),
          max: z.number().optional(),
          attachmentRequired: z.boolean().optional(),
        }),
      )
      .min(1)
      .max(30),
    active: z.boolean().optional(),
  })
  .openapi('FormCreate');

export const FormUpdateSchema = FormCreateSchema.partial().extend({
  version: z.number().int().min(1),
});

export const FormValuesPutSchema = z
  .object({
    values: JsonObjectSchema,
    completed: z.boolean().optional(),
    attachmentIds: z.array(z.string().uuid()).max(20).optional(),
    signature: z.string().trim().max(200).optional(),
  })
  .openapi('FormValuesPut');

export const ChecklistItemCreateSchema = z
  .object({
    label: z.string().trim().min(1, '检查项不能为空').max(200),
    formId: NullableIdSchema,
    required: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
  })
  .openapi('ChecklistItemCreate');

export const ChecklistItemUpdateSchema = z
  .object({ done: z.boolean().optional(), label: z.string().trim().min(1).max(200).optional() })
  .openapi('ChecklistItemUpdate');

export const DispatchRuleCreateSchema = z
  .object({
    name: z.string().trim().min(1, '规则名称不能为空').max(120),
    strategy: z.enum(['balanced', 'skills', 'load', 'timezone', 'round_robin']).optional(),
    skills: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    maxLoadHours: z.number().min(1).max(168).optional(),
    active: z.boolean().optional(),
  })
  .openapi('DispatchRuleCreate');

export const DispatchRuleUpdateSchema = DispatchRuleCreateSchema.partial().extend({
  version: z.number().int().min(1),
});

export const DispatchRecommendSchema = z
  .object({
    taskId: z.string().uuid('任务无效'),
    ruleId: z.string().uuid('规则无效').optional(),
    simulate: z.boolean().optional(),
    taskIds: z.array(z.string().uuid()).max(50).optional(),
  })
  .openapi('DispatchRecommend');

export const DispatchAcceptSchema = z
  .object({
    recommendationId: z.string().uuid('推荐无效'),
    mode: z.enum(['assign', 'reject']).default('assign'),
    fallback: z.boolean().optional(),
  })
  .openapi('DispatchAccept');

export const DispatchBatchSchema = z
  .object({
    recommendationIds: z.array(z.string().uuid()).min(1).max(50),
    mode: z.enum(['assign', 'reject']).default('assign'),
    fallback: z.boolean().optional(),
  })
  .openapi('DispatchBatch');

export const HandoffCreateSchema = z
  .object({
    toUserId: z.string().uuid('接收人无效'),
    note: z.string().trim().max(1000).optional(),
    dueAt: TimestampSchema.nullable().optional(),
    includeComments: z.boolean().optional(),
    includeAttachments: z.boolean().optional(),
    checklist: z
      .array(
        z.object({
          item: z.string().trim().min(1).max(200),
          done: z.boolean().optional(),
        }),
      )
      .max(30)
      .optional(),
    risks: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
  })
  .openapi('HandoffCreate');

export const HandoffDecisionSchema = z
  .object({
    action: z.enum(['accept', 'decline']),
    note: NoteSchema,
    confirmChecklist: z.boolean().optional(),
  })
  .openapi('HandoffDecision');

export const DeliverableCreateSchema = z
  .object({
    name: z.string().trim().min(1, '交付物名称不能为空').max(160),
    required: z.boolean().optional(),
  })
  .openapi('DeliverableCreate');

export const DeliverableVersionCreateSchema = z
  .object({
    filename: z.string().trim().min(1, '文件名不能为空').max(200),
    checksum: z.string().trim().max(128).optional(),
    attachmentId: z.string().uuid('附件无效').optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .openapi('DeliverableVersionCreate');

export const DeliverableReviewSchema = z
  .object({
    action: z.enum(['approve', 'reject']),
    note: z.string().trim().max(1000).optional(),
  })
  .openapi('DeliverableReview');

export const DocumentCommentCreateSchema = z
  .object({
    body: z.string().trim().min(1, '评论内容不能为空').max(5000),
    anchor: z
      .object({
        start: z.number().int().min(0),
        end: z.number().int().min(0),
        quote: z.string().max(500).optional(),
        path: z.string().max(200).optional(),
      })
      .optional(),
    suggestion: z
      .object({ replacement: z.string().max(5000), reason: z.string().max(500).optional() })
      .optional(),
    assigneeId: NullableIdSchema,
  })
  .openapi('DocumentCommentCreate');

export const DocumentCommentResolveSchema = z
  .object({ action: z.enum(['resolve', 'reopen', 'accept']), version: z.number().int().min(1) })
  .openapi('DocumentCommentResolve');

export const KnowledgeLinkCreateSchema = z
  .object({
    fromType: z.string().trim().min(1).max(40),
    fromId: z.string().trim().min(1).max(80),
    toType: z.string().trim().min(1).max(40),
    toId: z.string().trim().min(1).max(80),
    label: z.string().trim().max(120).optional(),
  })
  .openapi('KnowledgeLinkCreate');

export const KnowledgeGraphQuerySchema = z.object({
  projectId: z.string().uuid('项目无效').optional(),
  q: z.string().trim().max(120).optional(),
  focus: z.string().uuid('节点无效').optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const KnowledgeSearchQuerySchema = z.object({
  q: z.string().trim().min(1, '请输入搜索关键词').max(120),
  projectId: z.string().uuid('项目无效').optional(),
  types: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const MeetingCreateSchema = z
  .object({
    title: z.string().trim().min(1, '会议主题不能为空').max(160),
    startsAt: TimestampSchema,
    endsAt: TimestampSchema.nullable().optional(),
    seriesRule: z.string().trim().max(200).optional(),
    timezone: TimezoneSchema.optional(),
    agenda: z.array(z.string().trim().max(300)).max(30).optional(),
    attendeeIds: z.array(z.string().uuid()).max(100).optional(),
  })
  .openapi('MeetingCreate');

export const MeetingUpdateSchema = MeetingCreateSchema.partial().extend({
  version: z.number().int().min(1),
});

export const MeetingCompleteSchema = z
  .object({
    minutes: z.string().trim().max(20_000),
    decisions: z.array(z.string().trim().max(500)).max(50).optional(),
    actions: z
      .array(
        z.object({
          title: z.string().trim().min(1).max(200),
          assigneeId: z.string().uuid().nullable().optional(),
          dueOn: DateKeySchema.nullable().optional(),
        }),
      )
      .max(50)
      .optional(),
    version: z.number().int().min(1),
  })
  .openapi('MeetingComplete');

export const MeetingActionCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    assigneeId: NullableIdSchema,
    dueOn: DateKeySchema.nullable().optional(),
  })
  .openapi('MeetingActionCreate');

export const MeetingActionConvertSchema = z
  .object({ projectId: z.string().uuid('项目无效').optional() })
  .openapi('MeetingActionConvert');

export const ChannelCreateSchema = z
  .object({
    name: z.string().trim().min(1, '频道名称不能为空').max(80),
    topic: z.string().trim().max(300).optional(),
    readOnly: z.boolean().optional(),
    memberIds: z.array(z.string().uuid()).max(100).optional(),
  })
  .openapi('ChannelCreate');

export const ChannelUpdateSchema = ChannelCreateSchema.partial().extend({
  version: z.number().int().min(1),
});

export const ChannelMessageCreateSchema = z
  .object({
    body: z.string().trim().min(1, '消息不能为空').max(5000),
    parentId: NullableIdSchema,
    pinned: z.boolean().optional(),
  })
  .openapi('ChannelMessageCreate');

export const ChannelMessageUpdateSchema = z
  .object({ body: z.string().trim().min(1).max(5000) })
  .openapi('ChannelMessageUpdate');

export const PortalCreateSchema = z
  .object({
    name: z.string().trim().min(1, '门户名称不能为空').max(120),
    accountEmail: z.string().trim().email('客户邮箱无效').max(200).optional(),
    accountName: z.string().trim().max(80).optional(),
  })
  .openapi('PortalCreate');

export const PortalAccountCreateSchema = z
  .object({
    email: z.string().trim().email('客户邮箱无效').max(200),
    name: z.string().trim().min(1, '客户名称不能为空').max(80),
  })
  .openapi('PortalAccountCreate');

export const PortalRequestCreateSchema = z
  .object({
    title: z.string().trim().min(1, '需求标题不能为空').max(160),
    body: z.string().trim().max(5000).optional(),
    attachments: z.array(z.string().trim().max(300)).max(10).optional(),
  })
  .openapi('PortalRequestCreate');

export const PortalRequestUpdateSchema = z
  .object({
    status: z.enum(['submitted', 'triaged', 'in_progress', 'delivered', 'closed']).optional(),
    progressNote: z.string().trim().max(1000).optional(),
  })
  .openapi('PortalRequestUpdate');

export const RetroCreateSchema = z
  .object({
    title: z.string().trim().min(1, '复盘标题不能为空').max(160),
    factors: JsonObjectSchema.optional(),
    lessons: z.array(z.string().trim().max(500)).max(50).optional(),
    improvements: z.array(z.string().trim().max(500)).max(50).optional(),
    anonymous: z.boolean().optional(),
  })
  .openapi('RetroCreate');

export const RetroUpdateSchema = RetroCreateSchema.partial().extend({
  version: z.number().int().min(1),
  status: z.enum(['draft', 'published']).optional(),
});

export const PlaybookCreateSchema = z
  .object({
    title: z.string().trim().min(1, 'Playbook 标题不能为空').max(160),
    sourceRetroId: NullableIdSchema,
    scope: z.string().trim().max(200).optional(),
    content: z.string().trim().max(20_000).optional(),
    anonymize: z.boolean().optional(),
  })
  .openapi('PlaybookCreate');

export const PlaybookUpdateSchema = PlaybookCreateSchema.partial().extend({
  version: z.number().int().min(1),
});

export const PlaybookFeedbackSchema = z
  .object({
    useful: z.boolean(),
    note: z.string().trim().max(1000).optional(),
    reference: z.string().trim().max(200).optional(),
  })
  .openapi('PlaybookFeedback');

const WorkflowNodeSchema = z.object({
  id: z.string().trim().min(1).max(60),
  type: z.enum([
    'start',
    'condition',
    'approval',
    'task',
    'delay',
    'webhook',
    'notify',
    'parallel',
    'end',
  ]),
  name: z.string().trim().max(120).optional(),
  config: JsonObjectSchema.optional(),
});

const WorkflowEdgeSchema = z.object({
  from: z.string().trim().min(1).max(60),
  to: z.string().trim().min(1).max(60),
  condition: z.string().trim().max(200).optional(),
});

export const WorkflowCreateSchema = z
  .object({
    name: z.string().trim().min(1, '工作流名称不能为空').max(120),
    projectId: z.string().uuid('项目无效').nullable().optional(),
    definition: z
      .object({
        nodes: z.array(WorkflowNodeSchema).min(2).max(100),
        edges: z.array(WorkflowEdgeSchema).max(200),
      })
      .optional(),
    sandboxLimits: JsonObjectSchema.optional(),
  })
  .openapi('WorkflowCreate');

export const WorkflowUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    definition: z
      .object({
        nodes: z.array(WorkflowNodeSchema).min(2).max(100),
        edges: z.array(WorkflowEdgeSchema).max(200),
      })
      .optional(),
    sandboxLimits: JsonObjectSchema.optional(),
    version: z.number().int().min(1),
  })
  .openapi('WorkflowUpdate');

export const WorkflowPublishSchema = z
  .object({ changeSummary: z.string().trim().max(300).optional() })
  .openapi('WorkflowPublish');

export const WorkflowTestSchema = z
  .object({ input: JsonObjectSchema.optional() })
  .openapi('WorkflowTest');

export const WorkflowRollbackSchema = z
  .object({ version: z.number().int().min(1) })
  .openapi('WorkflowRollback');

export const WorkflowRunStartSchema = z
  .object({
    input: JsonObjectSchema.optional(),
    idempotencyKey: z.string().trim().min(1).max(80).optional(),
    mode: z.enum(['live', 'test']).optional(),
  })
  .openapi('WorkflowRunStart');

export const ApprovalCreateSchema = z
  .object({
    title: z.string().trim().min(1, '审批标题不能为空').max(160),
    kind: z.string().trim().max(40).optional(),
    projectId: z.string().uuid('项目无效').nullable().optional(),
    amountCents: z.number().int().min(0).max(1_000_000_000_000).optional(),
    risk: z.enum(['low', 'medium', 'high']).optional(),
    resourceType: z.string().trim().max(40).optional(),
    resourceId: z.string().trim().max(80).optional(),
    dueAt: TimestampSchema.nullable().optional(),
    steps: z
      .array(
        z.object({
          name: z.string().trim().max(80),
          approverIds: z.array(z.string().uuid()).min(1).max(20),
          mode: z.enum(['all', 'any']).default('all'),
          slaHours: z.number().int().min(1).max(720).optional(),
        }),
      )
      .min(1)
      .max(10),
  })
  .openapi('ApprovalCreate');

export const ApprovalDecisionSchema = z
  .object({
    action: z.enum(['approve', 'reject', 'delegate', 'escalate']),
    note: z.string().trim().max(1000).optional(),
    delegateTo: z.string().uuid('代理人无效').optional(),
    version: z.number().int().min(1),
  })
  .openapi('ApprovalDecision');

export const ApprovalWithdrawSchema = z
  .object({ note: NoteSchema, version: z.number().int().min(1) })
  .openapi('ApprovalWithdraw');

export const DelegationCreateSchema = z
  .object({
    delegatorId: z.string().uuid('委托人无效').optional(),
    delegateId: z.string().uuid('代理人无效'),
    startsAt: TimestampSchema,
    endsAt: TimestampSchema,
    scope: z.string().trim().max(200).optional(),
    avoidSelf: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.endsAt <= value.startsAt) {
      ctx.addIssue({ code: 'custom', message: '结束时间必须晚于开始时间', path: ['endsAt'] });
    }
  })
  .openapi('DelegationCreate');

export const TriggerCreateSchema = z
  .object({
    name: z.string().trim().max(120).optional(),
    type: z.enum(['schedule', 'cron', 'event', 'threshold', 'condition']),
    workflowId: NullableIdSchema,
    ruleId: NullableIdSchema,
    config: JsonObjectSchema.optional(),
    timezone: TimezoneSchema.optional(),
    quietHours: JsonArraySchema.optional(),
    dedupeWindowSeconds: z.number().int().min(0).max(86_400).optional(),
    maxPerHour: z.number().int().min(1).max(1000).optional(),
    active: z.boolean().optional(),
  })
  .openapi('TriggerCreate');

export const TriggerUpdateSchema = TriggerCreateSchema.partial().extend({
  version: z.number().int().min(1),
});

export const TriggerFireSchema = z
  .object({ eventKey: z.string().trim().max(120).optional(), dryRun: z.boolean().optional() })
  .openapi('TriggerFire');

export const ConnectorCreateSchema = z
  .object({
    name: z.string().trim().min(1, '连接器名称不能为空').max(120),
    kind: z.enum(['oauth', 'api_key', 'webhook', 'service_account']),
    scopes: z.array(z.string().trim().max(80)).max(30).optional(),
    rateLimit: z.number().int().min(1).max(100_000).optional(),
    secret: z.string().trim().max(500).optional(),
    allowedDomains: z.array(z.string().trim().max(200)).max(20).optional(),
    authUrl: z.string().trim().max(500).optional(),
    tokenUrl: z.string().trim().max(500).optional(),
    clientId: z.string().trim().max(200).optional(),
    clientSecret: z.string().trim().max(500).optional(),
    redirectUri: z.string().trim().max(500).optional(),
    active: z.boolean().optional(),
  })
  .openapi('ConnectorCreate');

export const ConnectorUpdateSchema = ConnectorCreateSchema.partial().extend({
  version: z.number().int().min(1),
});

export const ConnectorRotateSchema = z
  .object({ secret: z.string().trim().min(8, '密钥至少 8 位').max(500) })
  .openapi('ConnectorRotate');

export const ConnectorOAuthStartSchema = z
  .object({
    redirectUri: z.string().trim().max(500).optional(),
  })
  .openapi('ConnectorOAuthStart');

export const ConnectorOAuthCallbackSchema = z
  .object({
    state: z.string().trim().min(16).max(200),
    code: z.string().trim().min(1).max(2000),
  })
  .openapi('ConnectorOAuthCallback');

export const ConnectorCallSchema = z
  .object({
    url: z.string().trim().min(1, '请输入调用地址').max(2048),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
    body: JsonObjectSchema.optional(),
    confirm: z.boolean().optional(),
    reason: z.string().trim().max(200).optional(),
  })
  .openapi('ConnectorCall');

export const EventPublishSchema = z
  .object({
    type: z.string().trim().min(1, '事件类型不能为空').max(80),
    payload: JsonObjectSchema.optional(),
    dedupeKey: z.string().trim().max(120).optional(),
    version: z.number().int().min(1).max(1000).optional(),
  })
  .openapi('EventPublish');

export const EventSubscriptionCreateSchema = z
  .object({
    eventType: z.string().trim().min(1, '事件类型不能为空').max(80),
    filter: JsonObjectSchema.optional(),
    endpoint: z
      .string()
      .trim()
      .max(2048)
      .refine((value) => value === '' || webhookUrlIssue(value) === null, {
        message: '端点地址无效或指向内网',
      })
      .optional(),
    secret: z.string().trim().max(500).optional(),
    active: z.boolean().optional(),
  })
  .openapi('EventSubscriptionCreate');

export const SandboxRunSchema = z
  .object({
    actions: z
      .array(
        z.object({
          type: z.string().trim().min(1).max(40),
          value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
          fields: z.array(z.string().max(40)).max(20).optional(),
        }),
      )
      .max(50),
    limits: z
      .object({
        maxActions: z.number().int().min(1).max(100).optional(),
        maxMs: z.number().int().min(1).max(60_000).optional(),
        maxCpuMs: z.number().int().min(1).max(60_000).optional(),
        maxMemoryMb: z.number().int().min(16).max(1024).optional(),
        network: z.array(z.string().max(200)).max(20).optional(),
        allowedActions: z.array(z.string().trim().max(40)).max(50).optional(),
        fields: z.array(z.string().max(40)).max(100).optional(),
      })
      .optional(),
    resumeFrom: z.string().trim().max(80).optional(),
  })
  .openapi('SandboxRun');

export const ApprovalMetricsQuerySchema = z.object({
  from: DateKeySchema.optional(),
  to: DateKeySchema.optional(),
  kind: z.string().trim().max(40).optional(),
});

export const AnomalyDetectSchema = z
  .object({
    metricId: z.string().uuid('指标无效'),
    from: DateKeySchema,
    to: DateKeySchema,
    threshold: z.number().min(1).max(10).optional(),
    seasonal: z.boolean().optional(),
    window: z.number().int().min(3).max(90).optional(),
    compare: z.enum(['none', 'mom', 'yoy']).optional(),
    quietWindowHours: z.number().int().min(0).max(720).optional(),
  })
  .openapi('AnomalyDetect');

export const AnomalyDismissSchema = z
  .object({ note: z.string().trim().max(500).optional() })
  .openapi('AnomalyDismiss');

export const QualityRuleCreateSchema = z
  .object({
    name: z.string().trim().min(1, '规则名称不能为空').max(120),
    dataset: z.enum(['daily_metrics', 'opportunities', 'projects', 'tasks']),
    ruleType: z.enum(['completeness', 'uniqueness', 'range', 'consistency', 'continuity']),
    config: JsonObjectSchema.optional(),
    active: z.boolean().optional(),
  })
  .openapi('QualityRuleCreate');

export const QualityRuleUpdateSchema = QualityRuleCreateSchema.partial().extend({
  version: z.number().int().min(1),
});

export const QualityScanSchema = z
  .object({ ruleId: z.string().uuid().optional() })
  .openapi('QualityScan');

export const QualityFixSchema = z
  .object({
    fixed: JsonObjectSchema,
    reason: ReasonSchema,
    preview: z.boolean().optional(),
  })
  .openapi('QualityFix');

export const QualityBatchFixSchema = z
  .object({
    issueIds: z.array(z.string().uuid()).min(1).max(100),
    fixed: JsonObjectSchema,
    reason: ReasonSchema,
    preview: z.boolean().optional(),
  })
  .openapi('QualityBatchFix');

export const QualityRevertSchema = z.object({ reason: ReasonSchema }).openapi('QualityRevert');

export const ScenarioCreateSchema = z
  .object({
    name: z.string().trim().min(1, '情景名称不能为空').max(120),
    assumptions: z
      .object({
        revenueGrowthPct: z.number().min(-100).max(1000).optional(),
        conversionGrowthPct: z.number().min(-100).max(1000).optional(),
        costGrowthPct: z.number().min(-100).max(1000).optional(),
        personnelCostPct: z.number().min(-100).max(1000).optional(),
        deliveryShiftDays: z.number().int().min(-365).max(365).optional(),
      })
      .optional(),
    baseDate: DateKeySchema,
  })
  .openapi('ScenarioCreate');

export const ScenarioUpdateSchema = ScenarioCreateSchema.partial().extend({
  version: z.number().int().min(1),
  status: z.enum(['draft', 'published', 'archived']).optional(),
});

export const ScenarioCompareSchema = z
  .object({ ids: z.array(z.string().uuid('情景无效')).min(1).max(10) })
  .openapi('ScenarioCompare');

export const OpportunityCreateSchema = z
  .object({
    customerName: z.string().trim().min(1, '客户名称不能为空').max(160),
    customerEmail: z.string().trim().email('客户邮箱无效').max(200),
    stage: z.enum(['lead', 'opportunity', 'contract', 'renewal', 'churned']).default('lead'),
    amountCents: z.number().int().min(0).max(1_000_000_000_000).optional(),
    ownerId: NullableIdSchema,
  })
  .openapi('OpportunityCreate');

export const OpportunityUpdateSchema = z
  .object({
    customerName: z.string().trim().min(1).max(160).optional(),
    customerEmail: z.string().trim().email().max(200).optional(),
    stage: z.enum(['lead', 'opportunity', 'contract', 'renewal', 'churned']).optional(),
    amountCents: z.number().int().min(0).max(1_000_000_000_000).optional(),
    ownerId: NullableIdSchema,
    version: z.number().int().min(1),
  })
  .openapi('OpportunityUpdate');

export const FunnelQuerySchema = z.object({
  from: DateKeySchema.optional(),
  to: DateKeySchema.optional(),
  ownerId: z.string().uuid().optional(),
  cohort: z.enum(['week', 'month']).optional(),
  dedupeBy: z.enum(['email', 'customer']).default('email'),
});

const QueryCalculatedFieldSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, '计算字段标识只能包含字母、数字和下划线'),
  label: z.string().trim().min(1).max(80),
  expression: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9_+\-*/().\s]+$/, '计算字段仅支持基础算术表达式'),
});

const QueryPivotSchema = z.object({
  rows: z.array(z.string().trim().max(40)).max(3).optional(),
  columns: z.string().trim().max(40).optional(),
  values: z.string().trim().max(40).optional(),
});

const QueryChartSchema = z.object({
  type: z.enum(['bar', 'line', 'pie', 'table']).default('table'),
  x: z.string().trim().max(40).optional(),
  y: z.string().trim().max(40).optional(),
});

const QueryConfigSchema = z.object({
  dataset: z.enum(['projects', 'tasks', 'daily_metrics', 'opportunities']),
  fields: z.array(z.string().trim().min(1).max(40)).min(1).max(20),
  metricId: z.string().uuid('指标无效').optional(),
  visualization: z.enum(['table', 'bar', 'line', 'pie']).optional(),
  groupBy: z.array(z.string().trim().min(1).max(40)).max(5).optional(),
  filters: z
    .array(
      z.object({
        field: z.string().trim().min(1).max(40),
        operator: z.enum(['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'contains']),
        value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
      }),
    )
    .max(10)
    .optional(),
  aggregate: z
    .array(
      z.object({
        field: z.string().trim().min(1).max(40),
        fn: z.enum(['count', 'sum', 'avg', 'min', 'max']),
        alias: z.string().trim().max(40).optional(),
      }),
    )
    .max(10)
    .optional(),
  orderBy: z.string().trim().max(40).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  calculated: z.array(QueryCalculatedFieldSchema).max(5).optional(),
  pivot: QueryPivotSchema.optional(),
  chart: QueryChartSchema.optional(),
});

export const QueryReportCreateSchema = z
  .object({
    name: z.string().trim().min(1, '报表名称不能为空').max(120),
    config: QueryConfigSchema,
    shared: z.boolean().optional(),
    version: z.number().int().min(1).optional(),
  })
  .openapi('QueryReportCreate');

export const QueryReportUpdateSchema = QueryReportCreateSchema.partial().extend({
  version: z.number().int().min(1),
});

export const QueryPreviewSchema = z.object({ config: QueryConfigSchema }).openapi('QueryPreview');

export const ReportSubscriptionCreateSchema = z
  .object({
    reportId: z.string().uuid('报表无效'),
    reportKind: z.enum(['saved', 'query']).optional(),
    recipients: z.array(z.string().trim().email().max(200)).min(1).max(20),
    timezone: TimezoneSchema.optional(),
    cadence: z.enum(['daily', 'weekly', 'monthly']).optional(),
    format: z.enum(['csv', 'json', 'pdf', 'xlsx']).optional(),
    channel: z.enum(['email', 'download']).optional(),
    failureNotify: z.boolean().optional(),
    nextRunAt: TimestampSchema.nullable().optional(),
    active: z.boolean().optional(),
  })
  .openapi('ReportSubscriptionCreate');

export const ReportSubscriptionUpdateSchema = ReportSubscriptionCreateSchema.partial().extend({
  version: z.number().int().min(1),
});

export const LineageCreateSchema = z
  .object({
    sourceType: z.enum(['table', 'import', 'formula', 'filter', 'fx', 'metric', 'manual']),
    sourceId: z.string().trim().min(1).max(120),
    relation: z.enum(['derives', 'depends', 'converts']).optional(),
    sensitive: z.boolean().optional(),
  })
  .openapi('LineageCreate');

export const BudgetCategoryCreateSchema = z
  .object({
    name: z.string().trim().min(1, '费用类别不能为空').max(80),
    plannedCents: z.number().int().min(0).max(1_000_000_000_000).optional(),
    actualCents: z.number().int().min(0).max(1_000_000_000_000).optional(),
    forecastCents: z.number().int().min(0).max(1_000_000_000_000).optional(),
  })
  .openapi('BudgetCategoryCreate');

export const BudgetCategoryUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    plannedCents: z.number().int().min(0).max(1_000_000_000_000).optional(),
    actualCents: z.number().int().min(0).max(1_000_000_000_000).optional(),
    forecastCents: z.number().int().min(0).max(1_000_000_000_000).optional(),
    version: z.number().int().min(1),
  })
  .openapi('BudgetCategoryUpdate');

export const OrganizationCreateSchema = z
  .object({
    name: z.string().trim().min(1, '组织名称不能为空').max(120),
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9-]{2,40}$/, '组织标识只能包含小写字母、数字和连字符'),
  })
  .openapi('OrganizationCreate');

export const DepartmentCreateSchema = z
  .object({
    name: z.string().trim().min(1, '部门名称不能为空').max(120),
    parentId: NullableIdSchema,
    managerId: NullableIdSchema,
  })
  .openapi('DepartmentCreate');

export const DepartmentUpdateSchema = DepartmentCreateSchema.partial().extend({
  orgId: z.string().uuid().optional(),
});

export const OrgMembershipCreateSchema = z
  .object({
    userId: z.string().uuid('成员无效'),
    departmentId: NullableIdSchema,
    title: z.string().trim().max(80).optional(),
    status: z.enum(['active', 'inactive']).optional(),
  })
  .openapi('OrgMembershipCreate');

export const OrgMembershipUpdateSchema = z
  .object({
    departmentId: NullableIdSchema,
    title: z.string().trim().max(80).optional(),
    status: z.enum(['active', 'inactive']).optional(),
  })
  .openapi('OrgMembershipUpdate');

export const WorkspaceMemberCreateSchema = z
  .object({
    userId: z.string().uuid('成员无效'),
    role: z.enum(['admin', 'manager', 'pm', 'viewer']),
    status: z.enum(['active', 'invited', 'disabled']).optional(),
  })
  .openapi('WorkspaceMemberCreate');

export const WorkspaceSwitchSchema = z
  .object({ workspaceId: z.string().trim().min(1, '工作区无效').max(64) })
  .openapi('WorkspaceSwitch');

export const PermissionSampleCreateSchema = z
  .object({
    name: z.string().trim().min(1, '样例名称不能为空').max(120),
    userId: z.string().uuid('用户无效'),
    resourceType: z.enum(['workspace', 'project', 'task']),
    resourceId: z.string().trim().max(80).optional(),
    action: z.string().trim().min(1).max(60),
    expectedAllow: z.boolean(),
  })
  .openapi('PermissionSampleCreate');

export const PermissionSampleRunSchema = z
  .object({ ids: z.array(z.string().uuid()).max(200).optional() })
  .openapi('PermissionSampleRun');

export const JitUsageSchema = z
  .object({ note: z.string().trim().max(500).optional() })
  .openapi('JitUsage');

export const JitPostReviewSchema = z
  .object({ approved: z.boolean(), note: z.string().trim().max(1000).optional() })
  .openapi('JitPostReview');

export const BackgroundJobCreateSchema = z
  .object({
    kind: z.string().trim().min(1).max(60),
    payload: JsonObjectSchema.optional(),
    runAt: TimestampSchema.optional(),
    idempotencyKey: z.string().trim().max(120).optional(),
  })
  .openapi('BackgroundJobCreate');

export const BackgroundJobTickSchema = z
  .object({ limit: z.number().int().min(1).max(200).optional() })
  .openapi('BackgroundJobTick');

export const TaskTreeBulkSchema = z
  .object({
    projectId: z.string().uuid('项目无效'),
    action: z.enum(['indent', 'outdent', 'move', 'delete', 'status', 'sync']),
    taskIds: z.array(z.string().uuid()).min(1).max(200),
    parentId: NullableIdSchema,
    status: z.enum(['todo', 'in_progress', 'review', 'done']).optional(),
    version: z.number().int().min(1).optional(),
  })
  .openapi('TaskTreeBulk');

export const TaskEstimateSchema = z
  .object({
    estimatePoints: z.number().min(0).max(1000).nullable().optional(),
    estimateHours: z.number().min(0).max(100_000).nullable().optional(),
    estimateSize: z.string().trim().min(1).max(40).nullable().optional(),
  })
  .openapi('TaskEstimate');

export const TimeSummaryQuerySchema = z.object({
  projectId: z.string().uuid('项目无效').optional(),
  taskId: z.string().uuid('任务无效').optional(),
});

export const AutomationRollbackSchema = z
  .object({ version: z.number().int().min(1) })
  .openapi('AutomationRollback');

export const TaskTemplateTaskSchema = z.object({
  title: z.string().trim().min(1, '任务标题不能为空').max(200),
  description: z.string().trim().max(2000).optional(),
  status: z.enum(['todo', 'in_progress', 'review', 'done']).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  estimateHours: z.number().min(0).max(100_000).optional(),
  estimatePoints: z.number().min(0).max(1000).optional(),
  estimateSize: z.string().trim().max(40).optional(),
  parentIndex: z.number().int().min(0).max(49).optional(),
  dueInDays: z.number().int().min(-365).max(3650).optional(),
  checklist: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(160),
        required: z.boolean().optional(),
        formId: z.string().uuid().optional(),
      }),
    )
    .max(50)
    .optional(),
  form: z
    .object({
      name: z.string().trim().min(1).max(120),
      fields: z.array(JsonObjectSchema).min(1).max(50),
    })
    .optional(),
});

export const TaskTemplateCreateSchema = z
  .object({
    name: z.string().trim().min(1, '模板名称不能为空').max(120),
    description: z.string().trim().max(1000).optional(),
    tasks: z.array(TaskTemplateTaskSchema).min(1).max(50),
  })
  .openapi('TaskTemplateCreate');

export const TaskTemplateApplySchema = z
  .object({
    projectId: z.string().uuid('项目无效'),
    startDate: DateKeySchema.optional(),
    parentId: NullableIdSchema,
  })
  .openapi('TaskTemplateApply');

export const EstimateScaleCreateSchema = z
  .object({
    name: z.string().trim().min(1, '量级名称不能为空').max(80),
    values: z
      .array(
        z.object({
          key: z.string().trim().min(1).max(40),
          label: z.string().trim().min(1).max(80),
          points: z.number().min(0).max(1000).optional(),
        }),
      )
      .min(1)
      .max(20),
  })
  .openapi('EstimateScaleCreate');

export const ChangeRequestCommentSchema = z
  .object({ body: z.string().trim().min(1, '评论不能为空').max(2000) })
  .openapi('ChangeRequestComment');

export const ChangeRequestImplementSchema = z
  .object({
    action: z.literal('implement'),
    note: NoteSchema,
    version: z.number().int().min(1),
    taskTitles: z.array(z.string().trim().min(1).max(200)).max(40).optional(),
  })
  .openapi('ChangeRequestImplement');

export const ApprovalRoutingRuleCreateSchema = z
  .object({
    name: z.string().trim().min(1, '规则名称不能为空').max(120),
    kind: z.string().trim().max(60).default('any'),
    minAmountCents: z.number().int().min(0).max(1_000_000_000_000).default(0),
    maxAmountCents: z.number().int().min(0).max(1_000_000_000_000).nullable().optional(),
    risk: z.enum(['any', 'low', 'medium', 'high']).default('any'),
    steps: z
      .array(
        z.object({
          role: z.string().trim().min(1).max(40).optional(),
          userId: z.string().uuid().optional(),
          label: z.string().trim().max(80).optional(),
          slaHours: z.number().int().min(1).max(8760).optional(),
        }),
      )
      .min(1)
      .max(10),
    priority: z.number().int().min(0).max(1000).default(100),
    active: z.boolean().optional(),
  })
  .openapi('ApprovalRoutingRuleCreate');

export const PortalRequestCommentSchema = z
  .object({ body: z.string().trim().min(1, '评论不能为空').max(2000) })
  .openapi('PortalRequestComment');

export const PortalInternalCommentSchema = z
  .object({
    body: z.string().trim().min(1, '评论不能为空').max(2000),
    internal: z.boolean().optional(),
  })
  .openapi('PortalInternalComment');

export const PortalDeliveryConfirmSchema = z
  .object({ note: z.string().trim().max(1000).optional() })
  .openapi('PortalDeliveryConfirm');

export const DocumentDiffQuerySchema = z.object({
  from: z.coerce.number().int().min(1).optional(),
  to: z.coerce.number().int().min(1).optional(),
});

export const ChannelSearchQuerySchema = z.object({
  q: z.string().trim().min(1, '请输入搜索关键词').max(120),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const KnowledgeSynonymCreateSchema = z
  .object({
    term: z.string().trim().min(1, '词条不能为空').max(80),
    synonyms: z.array(z.string().trim().min(1).max(80)).min(1).max(20),
  })
  .openapi('KnowledgeSynonymCreate');

export const WorkflowReplaySchema = z
  .object({
    input: JsonObjectSchema.optional(),
    fromRunId: z.string().uuid('运行记录无效'),
  })
  .openapi('WorkflowReplay');

export const WorkflowRetryNodeSchema = z
  .object({ nodeId: z.string().trim().max(80).optional() })
  .openapi('WorkflowRetryNode');

export const SlaTickSchema = z
  .object({ limit: z.number().int().min(1).max(500).optional() })
  .openapi('SlaTick');

export const HealthConfigSchema = z
  .object({
    thresholds: z
      .object({
        progress: z.number().min(0).max(100).optional(),
        overdueRate: z.number().min(0).max(1).optional(),
        blockers: z.number().min(0).max(100).optional(),
        budgetUsage: z.number().min(0).max(2).optional(),
        criticalPath: z.number().min(0).max(100).optional(),
        defectTrend: z.number().min(-1).max(10).optional(),
        workload: z.number().min(0).max(3).optional(),
      })
      .optional(),
    weights: z.record(z.string(), z.number().min(0).max(10)).optional(),
  })
  .openapi('HealthConfig');

export const MetricRefreshSchema = z
  .object({ refreshMinutes: z.number().int().min(1).max(10_080) })
  .openapi('MetricRefresh');

export const BudgetApprovalSchema = z
  .object({
    amountCents: z.number().int().min(0).max(1_000_000_000_000).optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .openapi('BudgetApproval');

export const RecurrenceSkipSchema = z
  .object({ date: DateKeySchema, version: z.number().int().min(1) })
  .openapi('RecurrenceSkip');
