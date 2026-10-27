import type { TaskPriority } from './types.ts';

export type TemplateMilestone = {
  key: string;
  title: string;
  dueOffsetDays: number;
};

export type TemplateSubtask = {
  title: string;
  description: string;
  priority: TaskPriority;
  dueOffsetDays: number | null;
};

export type TemplateTask = {
  key: string;
  title: string;
  description: string;
  priority: TaskPriority;
  dueOffsetDays: number | null;
  milestoneKey: string | null;
  subtasks: TemplateSubtask[];
};

export type ProjectTemplate = {
  id: string;
  name: string;
  summary: string;
  description: string;
  category: string;
  durationDays: number;
  milestones: TemplateMilestone[];
  tasks: TemplateTask[];
};

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'product-launch',
    name: '产品发布',
    summary: '从调研到发布复盘的标准产品上线流程。',
    description:
      '适用于新产品或重要版本的发布：先完成调研与范围冻结，再推进设计、开发与内测，最后发布并复盘。',
    category: '产品',
    durationDays: 45,
    milestones: [
      { key: 'discovery', title: '调研与立项', dueOffsetDays: 7 },
      { key: 'build', title: '设计与开发', dueOffsetDays: 28 },
      { key: 'launch', title: '发布与复盘', dueOffsetDays: 45 },
    ],
    tasks: [
      {
        key: 'kickoff',
        title: '项目启动会',
        description: '对齐目标、范围、关键角色与里程碑。',
        priority: 'urgent',
        dueOffsetDays: 2,
        milestoneKey: 'discovery',
        subtasks: [
          {
            title: '邀请关键干系人',
            description: '确认产品、设计、研发与市场方的参会人。',
            priority: 'medium',
            dueOffsetDays: 1,
          },
          {
            title: '准备启动会议程',
            description: '整理目标、约束与待决策事项。',
            priority: 'medium',
            dueOffsetDays: 2,
          },
        ],
      },
      {
        key: 'research',
        title: '市场调研',
        description: '验证目标用户需求与竞争格局。',
        priority: 'high',
        dueOffsetDays: 5,
        milestoneKey: 'discovery',
        subtasks: [
          {
            title: '竞品分析',
            description: '梳理主要竞品的功能、定价与差异化。',
            priority: 'medium',
            dueOffsetDays: 4,
          },
          {
            title: '用户访谈',
            description: '至少完成 5 位目标用户的深度访谈。',
            priority: 'high',
            dueOffsetDays: 5,
          },
        ],
      },
      {
        key: 'scope',
        title: '冻结需求范围',
        description: '确认本期必须交付的功能清单与验收标准。',
        priority: 'urgent',
        dueOffsetDays: 9,
        milestoneKey: 'discovery',
        subtasks: [],
      },
      {
        key: 'design',
        title: '设计与原型',
        description: '完成关键路径的交互与视觉设计。',
        priority: 'high',
        dueOffsetDays: 14,
        milestoneKey: 'build',
        subtasks: [
          {
            title: '交互线框稿',
            description: '覆盖核心用户旅程与异常状态。',
            priority: 'high',
            dueOffsetDays: 10,
          },
          {
            title: '视觉终稿',
            description: '输出可交付给研发的高保真稿。',
            priority: 'high',
            dueOffsetDays: 14,
          },
        ],
      },
      {
        key: 'development',
        title: '开发与联调',
        description: '按需求清单完成开发、自测与前后端联调。',
        priority: 'urgent',
        dueOffsetDays: 26,
        milestoneKey: 'build',
        subtasks: [
          {
            title: '后端接口',
            description: '完成接口开发与自动化测试。',
            priority: 'high',
            dueOffsetDays: 20,
          },
          {
            title: '前端页面',
            description: '完成页面开发与跨端适配。',
            priority: 'high',
            dueOffsetDays: 24,
          },
          {
            title: '端到端联调',
            description: '验证核心链路与异常分支。',
            priority: 'urgent',
            dueOffsetDays: 26,
          },
        ],
      },
      {
        key: 'beta',
        title: '内测与问题修复',
        description: '邀请种子用户试用，收敛高优问题。',
        priority: 'high',
        dueOffsetDays: 28,
        milestoneKey: 'build',
        subtasks: [],
      },
      {
        key: 'launch-assets',
        title: '准备发布物料',
        description: '公告、帮助文档、演示与销售话术。',
        priority: 'high',
        dueOffsetDays: 38,
        milestoneKey: 'launch',
        subtasks: [],
      },
      {
        key: 'go-live',
        title: '正式发布',
        description: '按发布检查清单上线并监控关键指标。',
        priority: 'urgent',
        dueOffsetDays: 42,
        milestoneKey: 'launch',
        subtasks: [],
      },
      {
        key: 'retro',
        title: '发布复盘',
        description: '复盘目标达成、过程问题与下一步计划。',
        priority: 'low',
        dueOffsetDays: 45,
        milestoneKey: 'launch',
        subtasks: [],
      },
    ],
  },
  {
    id: 'client-onboarding',
    name: '客户交付',
    summary: '客户启动、配置、培训与验收的交付流程。',
    description:
      '适用于 B2B 客户交付：快速完成启动与需求确认，随后配置和迁移数据，最后培训、验收并交接。',
    category: '交付',
    durationDays: 30,
    milestones: [
      { key: 'kickoff', title: '启动与需求', dueOffsetDays: 3 },
      { key: 'setup', title: '配置与迁移', dueOffsetDays: 16 },
      { key: 'handover', title: '验收与交接', dueOffsetDays: 30 },
    ],
    tasks: [
      {
        key: 'welcome',
        title: '发送欢迎邮件与资料',
        description: '确认对接人、沟通渠道与项目节奏。',
        priority: 'high',
        dueOffsetDays: 1,
        milestoneKey: 'kickoff',
        subtasks: [],
      },
      {
        key: 'requirements',
        title: '确认交付需求',
        description: '明确业务目标、验收标准与时间约束。',
        priority: 'urgent',
        dueOffsetDays: 3,
        milestoneKey: 'kickoff',
        subtasks: [
          {
            title: '梳理干系人',
            description: '记录决策人、使用者与验收人。',
            priority: 'medium',
            dueOffsetDays: 2,
          },
          {
            title: '定义成功指标',
            description: '与客户共同确认可量化的验收指标。',
            priority: 'high',
            dueOffsetDays: 3,
          },
        ],
      },
      {
        key: 'account-setup',
        title: '开通与基础配置',
        description: '创建账号、权限与组织架构。',
        priority: 'high',
        dueOffsetDays: 7,
        milestoneKey: 'setup',
        subtasks: [],
      },
      {
        key: 'migration',
        title: '数据迁移',
        description: '完成字段映射、试迁移与正式导入。',
        priority: 'high',
        dueOffsetDays: 13,
        milestoneKey: 'setup',
        subtasks: [
          {
            title: '字段映射',
            description: '确认源数据与目标字段的对应关系。',
            priority: 'medium',
            dueOffsetDays: 9,
          },
          {
            title: '试迁移验证',
            description: '抽样校验数据完整性与准确性。',
            priority: 'high',
            dueOffsetDays: 13,
          },
        ],
      },
      {
        key: 'training',
        title: '客户培训',
        description: '覆盖管理员配置与一线使用场景。',
        priority: 'medium',
        dueOffsetDays: 16,
        milestoneKey: 'setup',
        subtasks: [],
      },
      {
        key: 'acceptance',
        title: '验收',
        description: '按验收清单逐项确认并记录结论。',
        priority: 'high',
        dueOffsetDays: 24,
        milestoneKey: 'handover',
        subtasks: [
          {
            title: '准备验收清单',
            description: '将需求转化为可勾选的验收项。',
            priority: 'medium',
            dueOffsetDays: 20,
          },
          {
            title: '客户签字确认',
            description: '获取书面验收结论与遗留问题清单。',
            priority: 'high',
            dueOffsetDays: 24,
          },
        ],
      },
      {
        key: 'handover-doc',
        title: '交付文档',
        description: '整理操作手册、配置说明与运维联系人。',
        priority: 'medium',
        dueOffsetDays: 28,
        milestoneKey: 'handover',
        subtasks: [],
      },
      {
        key: 'review',
        title: '交付复盘',
        description: '复盘延期与问题，沉淀可复用经验。',
        priority: 'low',
        dueOffsetDays: 30,
        milestoneKey: 'handover',
        subtasks: [],
      },
    ],
  },
  {
    id: 'marketing-campaign',
    name: '营销活动',
    summary: '从策略、创意到投放与复盘的整合营销节奏。',
    description:
      '适用于新品推广或季度活动：先确定目标人群与预算，再完成创意与渠道物料，最后投放监控并输出复盘报告。',
    category: '市场',
    durationDays: 40,
    milestones: [
      { key: 'plan', title: '策略与计划', dueOffsetDays: 5 },
      { key: 'produce', title: '创意与物料', dueOffsetDays: 18 },
      { key: 'launch', title: '投放与监控', dueOffsetDays: 35 },
      { key: 'report', title: '复盘', dueOffsetDays: 40 },
    ],
    tasks: [
      {
        key: 'brief',
        title: '确认活动 Brief',
        description: '明确目标、预算、周期与核心信息。',
        priority: 'urgent',
        dueOffsetDays: 2,
        milestoneKey: 'plan',
        subtasks: [],
      },
      {
        key: 'audience',
        title: '人群策略',
        description: '定义目标人群、分层与触达策略。',
        priority: 'high',
        dueOffsetDays: 5,
        milestoneKey: 'plan',
        subtasks: [
          {
            title: '人群分层',
            description: '按价值与生命周期划分核心人群。',
            priority: 'medium',
            dueOffsetDays: 4,
          },
          {
            title: '用户画像',
            description: '整理核心人群的动机与内容偏好。',
            priority: 'medium',
            dueOffsetDays: 5,
          },
        ],
      },
      {
        key: 'budget',
        title: '预算与排期',
        description: '分配渠道预算并确认关键时间点。',
        priority: 'high',
        dueOffsetDays: 5,
        milestoneKey: 'plan',
        subtasks: [],
      },
      {
        key: 'creative',
        title: '创意制作',
        description: '产出核心文案与视觉素材。',
        priority: 'high',
        dueOffsetDays: 12,
        milestoneKey: 'produce',
        subtasks: [
          {
            title: '核心文案',
            description: '完成主标题、卖点与行动号召。',
            priority: 'high',
            dueOffsetDays: 9,
          },
          {
            title: '视觉素材',
            description: '输出各渠道尺寸的主视觉与配图。',
            priority: 'high',
            dueOffsetDays: 12,
          },
        ],
      },
      {
        key: 'channels',
        title: '渠道物料适配',
        description: '按渠道规范完成物料尺寸与文案适配。',
        priority: 'medium',
        dueOffsetDays: 15,
        milestoneKey: 'produce',
        subtasks: [],
      },
      {
        key: 'landing',
        title: '落地页上线',
        description: '搭建并测试转化落地页与追踪参数。',
        priority: 'high',
        dueOffsetDays: 18,
        milestoneKey: 'produce',
        subtasks: [],
      },
      {
        key: 'schedule',
        title: '投放排期确认',
        description: '与渠道确认档期、预算与素材交付时间。',
        priority: 'medium',
        dueOffsetDays: 24,
        milestoneKey: 'launch',
        subtasks: [],
      },
      {
        key: 'launch-campaign',
        title: '活动上线',
        description: '按排期开启投放并检查追踪数据。',
        priority: 'urgent',
        dueOffsetDays: 28,
        milestoneKey: 'launch',
        subtasks: [],
      },
      {
        key: 'monitor',
        title: '数据监控与优化',
        description: '每日检查转化成本并按需调整出价与素材。',
        priority: 'medium',
        dueOffsetDays: 35,
        milestoneKey: 'launch',
        subtasks: [],
      },
      {
        key: 'campaign-report',
        title: '活动复盘报告',
        description: '汇总渠道表现、转化与经验结论。',
        priority: 'low',
        dueOffsetDays: 40,
        milestoneKey: 'report',
        subtasks: [
          {
            title: '整理指标',
            description: '汇总曝光、点击、转化与成本数据。',
            priority: 'medium',
            dueOffsetDays: 38,
          },
          {
            title: '提炼结论',
            description: '形成下一轮活动的优化建议。',
            priority: 'low',
            dueOffsetDays: 40,
          },
        ],
      },
    ],
  },
  {
    id: 'team-sprint',
    name: '双周迭代',
    summary: '两周一个冲刺的团队协作模板。',
    description:
      '适用于研发或业务团队的固定迭代：第一天完成梳理与计划，执行期保持每日同步，最后演示、复盘并发布说明。',
    category: '研发',
    durationDays: 14,
    milestones: [
      { key: 'planning', title: '计划', dueOffsetDays: 2 },
      { key: 'execution', title: '执行', dueOffsetDays: 10 },
      { key: 'review', title: '演示与复盘', dueOffsetDays: 14 },
    ],
    tasks: [
      {
        key: 'grooming',
        title: '需求梳理',
        description: '确认候选需求的优先级与验收标准。',
        priority: 'medium',
        dueOffsetDays: 1,
        milestoneKey: 'planning',
        subtasks: [],
      },
      {
        key: 'goal',
        title: '设定迭代目标',
        description: '用一个可衡量的目标概括本次迭代。',
        priority: 'high',
        dueOffsetDays: 2,
        milestoneKey: 'planning',
        subtasks: [],
      },
      {
        key: 'planning',
        title: '迭代计划会',
        description: '拆分任务、估算工作量并确认负责人。',
        priority: 'high',
        dueOffsetDays: 2,
        milestoneKey: 'planning',
        subtasks: [],
      },
      {
        key: 'delivery',
        title: '迭代开发',
        description: '按计划完成开发、测试与代码评审。',
        priority: 'urgent',
        dueOffsetDays: 9,
        milestoneKey: 'execution',
        subtasks: [
          {
            title: '后端实现',
            description: '完成接口、数据变更与单元测试。',
            priority: 'high',
            dueOffsetDays: 7,
          },
          {
            title: '前端实现',
            description: '完成页面交互与无障碍检查。',
            priority: 'high',
            dueOffsetDays: 8,
          },
          {
            title: '测试与修复',
            description: '执行回归测试并修复高优缺陷。',
            priority: 'urgent',
            dueOffsetDays: 9,
          },
        ],
      },
      {
        key: 'daily',
        title: '每日站会',
        description: '同步进展、风险与需要协作的事项。',
        priority: 'low',
        dueOffsetDays: 10,
        milestoneKey: 'execution',
        subtasks: [],
      },
      {
        key: 'demo',
        title: '迭代演示',
        description: '向干系人演示完成的功能并收集反馈。',
        priority: 'medium',
        dueOffsetDays: 13,
        milestoneKey: 'review',
        subtasks: [],
      },
      {
        key: 'retro',
        title: '迭代复盘',
        description: '总结做得好的、待改进与行动项。',
        priority: 'low',
        dueOffsetDays: 14,
        milestoneKey: 'review',
        subtasks: [],
      },
      {
        key: 'notes',
        title: '发布说明',
        description: '整理面向用户与内部的变更说明。',
        priority: 'low',
        dueOffsetDays: 14,
        milestoneKey: 'review',
        subtasks: [],
      },
    ],
  },
];

export function findTemplate(id: string): ProjectTemplate | undefined {
  return PROJECT_TEMPLATES.find((template) => template.id === id);
}

export function templateTaskCount(template: ProjectTemplate): number {
  return template.tasks.reduce((total, task) => total + 1 + task.subtasks.length, 0);
}

export function templateMilestoneCount(template: ProjectTemplate): number {
  return template.milestones.length;
}
