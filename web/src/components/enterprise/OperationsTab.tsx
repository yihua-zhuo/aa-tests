import { type FormEvent, useState } from 'react';
import type { AutomationRun, AutomationTrigger } from '../../../../shared/types.ts';
import { api, type WorkbenchRecord } from '../../api.ts';
import { useApi, useToast } from '../../hooks/useApi.ts';
import { Icon } from '../Icon.tsx';
import { EmptyState, ErrorState, Field, Modal, Spinner, Toaster } from '../ui.tsx';
import {
  EnterpriseStat,
  type EnterpriseTabProps,
  EnterpriseToolbar,
  numberOf,
  objectOf,
  ToneBadge,
  textOf,
} from './shared.tsx';

const TRIGGERS: AutomationTrigger[] = [
  'task.created',
  'task.updated',
  'task.completed',
  'blocker.created',
  'dependency.created',
];

export function OperationsTab({ projects, people }: EnterpriseTabProps) {
  const workflowsState = useApi((signal) => api.workbench('workflows', { limit: 50 }, signal), []);
  const approvalsState = useApi((signal) => api.workbench('approvals', { limit: 50 }, signal), []);
  const triggersState = useApi((signal) => api.workbench('triggers', { limit: 50 }, signal), []);
  const connectorsState = useApi(
    (signal) => api.workbench('connectors', { limit: 50 }, signal),
    [],
  );
  const jobsState = useApi((signal) => api.workbench('jobs', { limit: 50 }, signal), []);
  const eventsState = useApi((signal) => api.workbench('events', { limit: 20 }, signal), []);
  const qualityRulesState = useApi(
    (signal) => api.workbench('quality-rules', { limit: 50 }, signal),
    [],
  );
  const qualityIssuesState = useApi(
    (signal) => api.workbench('quality-issues', { limit: 50 }, signal),
    [],
  );
  const rulesState = useApi((signal) => api.automationRules({}, signal), []);
  const runsState = useApi((signal) => api.automationRuns({ limit: 20 }, signal), []);
  const metricsState = useApi((signal) => api.approvalMetrics({}, signal), []);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [connectorOpen, setConnectorOpen] = useState(false);
  const [qualityIssue, setQualityIssue] = useState<WorkbenchRecord | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { toasts, show, dismiss } = useToast();

  const workflows = workflowsState.data?.items ?? [];
  const approvals = approvalsState.data?.items ?? [];
  const triggers = triggersState.data?.items ?? [];
  const connectors = connectorsState.data?.items ?? [];
  const jobs = jobsState.data?.items ?? [];
  const events = eventsState.data?.items ?? [];
  const qualityRules = qualityRulesState.data?.items ?? [];
  const qualityIssues = qualityIssuesState.data?.items ?? [];
  const rules = rulesState.data ?? [];
  const runs = runsState.data ?? [];
  const metrics = metricsState.data ?? null;
  const pendingApprovals = approvals.filter((item) => textOf(item, 'status') === 'pending').length;
  const failedJobs = jobs.filter((job) => textOf(job, 'status') === 'failed').length;
  const openIssues = qualityIssues.filter((issue) => textOf(issue, 'status') === 'open').length;

  const act = async (key: string, work: () => Promise<unknown>, done: string) => {
    if (busy) return;
    setBusy(key);
    try {
      await work();
      if (done) show(done);
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '操作失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="enterprise-tab">
      <div className="enterprise-stats">
        <EnterpriseStat
          label="待审批"
          value={pendingApprovals}
          hint={`${approvals.length} 个请求`}
          tone="peach"
        />
        <EnterpriseStat label="工作流" value={workflows.length} hint="已发布与草稿" tone="lilac" />
        <EnterpriseStat
          label="自动化规则"
          value={rules.length}
          hint={`${runs.length} 次运行记录`}
          tone="mint"
        />
        <EnterpriseStat
          label="失败任务"
          value={failedJobs}
          hint={`${jobs.length} 个后台任务`}
          tone={failedJobs > 0 ? 'peach' : 'sky'}
        />
        <EnterpriseStat
          label="质量问题"
          value={openIssues}
          hint={`${qualityRules.length} 条规则`}
          tone={openIssues > 0 ? 'peach' : 'sky'}
        />
      </div>

      <EnterpriseToolbar>
        <span className="enterprise-hint">
          审批、工作流、触发器、连接器、事件总线、后台任务与数据质量统一按工作区隔离。
        </span>
        <div className="enterprise-toolbar-actions">
          <button
            type="button"
            className="btn btn-soft btn-sm"
            onClick={() => setConnectorOpen(true)}
          >
            <Icon name="globe" size={15} />
            登记连接器
          </button>
          <button type="button" className="btn btn-soft btn-sm" onClick={() => setRuleOpen(true)}>
            <Icon name="spark" size={15} />
            新建自动化规则
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setApprovalOpen(true)}
            disabled={people.length === 0}
          >
            <Icon name="check" size={16} />
            发起审批
          </button>
        </div>
      </EnterpriseToolbar>

      <section className="card card-pad">
        <header className="card-head">
          <div>
            <h2>审批中心</h2>
            <p className="card-sub">多级审批支持会签、代理与超时升级，决策带版本校验。</p>
          </div>
        </header>
        {metrics ? (
          <p className="enterprise-hint">
            平均处理 {Number(metrics.averageHours ?? 0).toFixed(1)} 小时 · 超时率{' '}
            {(Number(metrics.overdueRate ?? 0) * 100).toFixed(1)}% · 退回率{' '}
            {(Number(metrics.returnRate ?? 0) * 100).toFixed(1)}%
            {metrics.lowSample ? ' · 样本较少，仅供参考' : ''}
          </p>
        ) : null}
        {approvalsState.error && !approvalsState.data ? (
          <ErrorState message={approvalsState.error} onRetry={approvalsState.reload} compact />
        ) : null}
        {approvals.length === 0 ? (
          <EmptyState
            icon="check"
            title="暂无审批"
            description="发起审批后会出现在这里。"
            compact
          />
        ) : (
          <div className="card table-card enterprise-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>标题</th>
                  <th>风险</th>
                  <th>状态</th>
                  <th>当前步骤</th>
                  <th>截止</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {approvals.map((approval) => {
                  const id = textOf(approval, 'id');
                  const status = textOf(approval, 'status');
                  const version = numberOf(approval, 'version', 1);
                  return (
                    <tr key={id}>
                      <td>
                        {textOf(approval, 'title')}{' '}
                        {textOf(approval, 'kind') ? (
                          <span className="table-muted">· {textOf(approval, 'kind')}</span>
                        ) : null}
                      </td>
                      <td>
                        <ToneBadge
                          tone={
                            textOf(approval, 'risk') === 'high'
                              ? 'danger'
                              : textOf(approval, 'risk') === 'medium'
                                ? 'warning'
                                : 'muted'
                          }
                        >
                          {textOf(approval, 'risk', 'low')}
                        </ToneBadge>
                      </td>
                      <td className="table-muted">{status}</td>
                      <td>{numberOf(approval, 'current_step') + 1}</td>
                      <td className="table-muted">{textOf(approval, 'due_at', '—')}</td>
                      <td>
                        {status === 'pending' ? (
                          <div className="enterprise-row-actions">
                            <button
                              type="button"
                              className="btn btn-soft btn-sm"
                              disabled={busy === `approve-${id}`}
                              onClick={() =>
                                void act(
                                  `approve-${id}`,
                                  () => api.decideApproval(id, { action: 'approve', version }),
                                  '已通过',
                                ).then(() => approvalsState.reload())
                              }
                            >
                              通过
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              disabled={busy === `reject-${id}`}
                              onClick={() =>
                                void act(
                                  `reject-${id}`,
                                  () =>
                                    api.decideApproval(id, {
                                      action: 'reject',
                                      note: '界面驳回',
                                      version,
                                    }),
                                  '已驳回',
                                ).then(() => approvalsState.reload())
                              }
                            >
                              驳回
                            </button>
                          </div>
                        ) : (
                          <span className="table-muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card card-pad">
        <header className="card-head">
          <div>
            <h2>工作流</h2>
            <p className="card-sub">发布版本、沙箱测试与正式运行均记录运行实例与节点事件。</p>
          </div>
        </header>
        {workflowsState.error && !workflowsState.data ? (
          <ErrorState message={workflowsState.error} onRetry={workflowsState.reload} compact />
        ) : null}
        {workflows.length === 0 ? (
          <EmptyState
            icon="rocket"
            title="还没有工作流"
            description="可通过 API 创建工作流定义后再发布。"
            compact
          />
        ) : (
          <div className="card table-card enterprise-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>状态</th>
                  <th>版本</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {workflows.map((workflow) => {
                  const id = textOf(workflow, 'id');
                  const version = numberOf(workflow, 'version', 1);
                  return (
                    <tr key={id}>
                      <td>{textOf(workflow, 'name')}</td>
                      <td>
                        <ToneBadge
                          tone={textOf(workflow, 'status') === 'published' ? 'success' : 'muted'}
                        >
                          {textOf(workflow, 'status', 'draft')}
                        </ToneBadge>
                      </td>
                      <td className="table-muted">v{version}</td>
                      <td>
                        <div className="enterprise-row-actions">
                          <button
                            type="button"
                            className="btn btn-soft btn-sm"
                            disabled={busy === `publish-${id}`}
                            onClick={() =>
                              void act(
                                `publish-${id}`,
                                () => api.publishWorkflow(id, '界面发布'),
                                '工作流已发布',
                              ).then(() => workflowsState.reload())
                            }
                          >
                            发布
                          </button>
                          <button
                            type="button"
                            className="btn btn-soft btn-sm"
                            disabled={busy === `test-${id}`}
                            onClick={() =>
                              void act(`test-${id}`, () => api.testWorkflow(id), '沙箱测试完成')
                            }
                          >
                            测试
                          </button>
                          <button
                            type="button"
                            className="btn btn-soft btn-sm"
                            disabled={busy === `run-${id}`}
                            onClick={() =>
                              void act(`run-${id}`, () => api.runWorkflow(id), '工作流已运行')
                            }
                          >
                            运行
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card card-pad">
        <header className="card-head">
          <div>
            <h2>自动化规则</h2>
            <p className="card-sub">规则支持试运行、每小时限流与版本回滚。</p>
          </div>
        </header>
        {rulesState.error && !rulesState.data ? (
          <ErrorState message={rulesState.error} onRetry={rulesState.reload} compact />
        ) : null}
        {rules.length === 0 ? (
          <EmptyState icon="spark" title="还没有自动化规则" compact />
        ) : (
          <ul className="enterprise-sublist">
            {rules.map((rule) => (
              <li key={rule.id}>
                <div className="enterprise-subject">
                  <span>
                    {rule.name}{' '}
                    <ToneBadge tone={rule.active ? 'success' : 'muted'}>
                      {rule.active ? '启用' : '停用'}
                    </ToneBadge>
                  </span>
                  <span className="table-muted">
                    {rule.trigger} · {rule.actions.length} 个动作 · 限流 {rule.maxRunsPerHour}/小时
                    · v{rule.version}
                  </span>
                  <div className="enterprise-row-actions">
                    <button
                      type="button"
                      className="btn btn-soft btn-sm"
                      disabled={busy === `dry-${rule.id}`}
                      onClick={() =>
                        void act(
                          `dry-${rule.id}`,
                          () =>
                            api.dryRunAutomationRule(rule.id, {
                              trigger: rule.trigger,
                              task: { title: '界面试运行' },
                            }),
                          '试运行完成',
                        ).then(() => runsState.reload())
                      }
                    >
                      试运行
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() =>
                        void act(
                          `toggle-${rule.id}`,
                          () =>
                            api.updateAutomationRule(rule.id, {
                              version: rule.version,
                              active: !rule.active,
                            }),
                          rule.active ? '规则已停用' : '规则已启用',
                        ).then(() => rulesState.reload())
                      }
                    >
                      {rule.active ? '停用' : '启用'}
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        {runs.length > 0 ? (
          <div className="card table-card enterprise-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>规则</th>
                  <th>模式</th>
                  <th>状态</th>
                  <th>耗时</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run: AutomationRun) => (
                  <tr key={run.id}>
                    <td>{run.ruleName}</td>
                    <td className="table-muted">{run.mode}</td>
                    <td>
                      <ToneBadge
                        tone={
                          run.status === 'ok'
                            ? 'success'
                            : run.status === 'failed'
                              ? 'danger'
                              : 'muted'
                        }
                      >
                        {run.status}
                      </ToneBadge>
                    </td>
                    <td>{run.durationMs} ms</td>
                    <td className="table-muted">{run.createdAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="card card-pad">
        <header className="card-head">
          <div>
            <h2>触发器与事件</h2>
            <p className="card-sub">定时、事件与阈值触发器；事件投递支持重试与死信。</p>
          </div>
          <div className="enterprise-row-actions">
            <button
              type="button"
              className="btn btn-soft btn-sm"
              onClick={() =>
                void act('tick-triggers', () => api.tickTriggers(), '触发器已扫描').then(() =>
                  triggersState.reload(),
                )
              }
            >
              <Icon name="clock" size={14} />
              扫描到期触发器
            </button>
          </div>
        </header>
        {triggers.length === 0 ? (
          <EmptyState icon="clock" title="还没有触发器" compact />
        ) : (
          <div className="card table-card enterprise-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>类型</th>
                  <th>状态</th>
                  <th>最近触发</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {triggers.map((trigger) => {
                  const id = textOf(trigger, 'id');
                  return (
                    <tr key={id}>
                      <td>{textOf(trigger, 'name', textOf(trigger, 'type'))}</td>
                      <td className="table-muted">{textOf(trigger, 'type')}</td>
                      <td>
                        <ToneBadge tone={trigger.active ? 'success' : 'muted'}>
                          {trigger.active ? '启用' : '停用'}
                        </ToneBadge>
                      </td>
                      <td className="table-muted">{textOf(trigger, 'last_fired_at', '—')}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-soft btn-sm"
                          onClick={() =>
                            void act(
                              `fire-${id}`,
                              () => api.fireTrigger(id, { eventKey: `ui-${Date.now()}` }),
                              '触发器已执行',
                            )
                          }
                        >
                          触发
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {events.length > 0 ? (
          <p className="enterprise-hint">
            最近事件：
            {events
              .slice(0, 5)
              .map((event) => textOf(event, 'type'))
              .join('、')}
          </p>
        ) : null}
      </section>

      <section className="card card-pad">
        <header className="card-head">
          <div>
            <h2>连接器与任务队列</h2>
            <p className="card-sub">连接器密钥轮换与健康检查；后台任务支持重试与死信处理。</p>
          </div>
          <button
            type="button"
            className="btn btn-soft btn-sm"
            onClick={() =>
              void act('tick-jobs', () => api.tickJobs(), '任务队列已处理').then(() =>
                jobsState.reload(),
              )
            }
          >
            <Icon name="server" size={14} />
            处理队列
          </button>
        </header>
        {connectors.length === 0 ? (
          <EmptyState icon="globe" title="还没有连接器" compact />
        ) : (
          <ul className="enterprise-sublist">
            {connectors.map((connector) => {
              const id = textOf(connector, 'id');
              return (
                <li key={id}>
                  <div className="enterprise-subject">
                    <span>
                      {textOf(connector, 'name')}{' '}
                      <ToneBadge tone={connector.active ? 'success' : 'muted'}>
                        {connector.active ? '启用' : '停用'}
                      </ToneBadge>
                    </span>
                    <span className="table-muted">
                      {textOf(connector, 'kind')} · 健康 {textOf(connector, 'health', 'unknown')}
                    </span>
                    <button
                      type="button"
                      className="btn btn-soft btn-sm"
                      disabled={busy === `health-${id}`}
                      onClick={() =>
                        void act(
                          `health-${id}`,
                          async () => {
                            const health = await api.connectorHealth(id);
                            show(`健康状态：${health.health}`);
                          },
                          '',
                        ).then(() => connectorsState.reload())
                      }
                    >
                      健康检查
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {jobs.length > 0 ? (
          <div className="card table-card enterprise-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>任务</th>
                  <th>状态</th>
                  <th>尝试</th>
                  <th>错误</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => {
                  const id = textOf(job, 'id');
                  const status = textOf(job, 'status');
                  return (
                    <tr key={id}>
                      <td>{textOf(job, 'kind')}</td>
                      <td>
                        <ToneBadge
                          tone={
                            status === 'failed' ? 'danger' : status === 'done' ? 'success' : 'muted'
                          }
                        >
                          {status}
                        </ToneBadge>
                      </td>
                      <td className="table-muted">
                        {numberOf(job, 'attempts')}/{numberOf(job, 'max_attempts')}
                      </td>
                      <td className="table-muted">{textOf(job, 'error', '—')}</td>
                      <td>
                        {status === 'failed' ? (
                          <button
                            type="button"
                            className="btn btn-soft btn-sm"
                            onClick={() =>
                              void act(
                                `retry-${id}`,
                                () => api.retryJob(id),
                                '任务已重新入队',
                              ).then(() => jobsState.reload())
                            }
                          >
                            重试
                          </button>
                        ) : (
                          <span className="table-muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="card card-pad">
        <header className="card-head">
          <div>
            <h2>数据质量</h2>
            <p className="card-sub">规则扫描生成修复工单，修复需填写理由并保留前后快照。</p>
          </div>
          <button
            type="button"
            className="btn btn-soft btn-sm"
            onClick={() =>
              void act(
                'quality-scan',
                async () => {
                  const issues = await api.scanQuality();
                  show(`扫描完成，发现 ${issues.length} 个问题`);
                },
                '',
              ).then(() => {
                qualityRulesState.reload();
                qualityIssuesState.reload();
              })
            }
          >
            <Icon name="shield" size={14} />
            运行全部规则
          </button>
        </header>
        {qualityRules.length === 0 ? (
          <EmptyState
            icon="shield"
            title="还没有质量规则"
            description="规则可通过 API 创建，覆盖完整性、唯一性、范围、一致性与连续性。"
            compact
          />
        ) : (
          <ul className="enterprise-sublist">
            {qualityRules.map((rule) => {
              const id = textOf(rule, 'id');
              return (
                <li key={id}>
                  <div className="enterprise-subject">
                    <span>
                      {textOf(rule, 'name')}{' '}
                      <ToneBadge tone={rule.active ? 'success' : 'muted'}>
                        {rule.active ? '启用' : '停用'}
                      </ToneBadge>
                    </span>
                    <span className="table-muted">
                      {textOf(rule, 'dataset')} · {textOf(rule, 'rule_type')}
                    </span>
                    <button
                      type="button"
                      className="btn btn-soft btn-sm"
                      onClick={() =>
                        void act(
                          `scan-${id}`,
                          async () => {
                            const issues = await api.scanQuality(id);
                            show(`规则扫描完成，发现 ${issues.length} 个问题`);
                          },
                          '',
                        ).then(() => qualityIssuesState.reload())
                      }
                    >
                      扫描
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {qualityIssues.length > 0 ? (
          <div className="card table-card enterprise-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>问题</th>
                  <th>状态</th>
                  <th>负责人</th>
                  <th>修复理由</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {qualityIssues.map((issue) => {
                  const id = textOf(issue, 'id');
                  const status = textOf(issue, 'status');
                  return (
                    <tr key={id}>
                      <td>{textOf(issue, 'issue_key')}</td>
                      <td>
                        <ToneBadge tone={status === 'resolved' ? 'success' : 'danger'}>
                          {status === 'resolved' ? '已修复' : '待处理'}
                        </ToneBadge>
                      </td>
                      <td className="table-muted">{textOf(issue, 'assignee_id', '—')}</td>
                      <td className="table-muted">{textOf(issue, 'fix_reason', '—')}</td>
                      <td>
                        {status !== 'resolved' ? (
                          <button
                            type="button"
                            className="btn btn-soft btn-sm"
                            onClick={() => setQualityIssue(issue)}
                          >
                            修复
                          </button>
                        ) : (
                          <span className="table-muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <ApprovalDialog
        open={approvalOpen}
        projects={projects}
        people={people}
        onClose={() => setApprovalOpen(false)}
        onCreated={() => {
          setApprovalOpen(false);
          show('审批已发起');
          approvalsState.reload();
          metricsState.reload();
        }}
        onError={(message) => show(message, 'error')}
      />

      <AutomationRuleDialog
        open={ruleOpen}
        projects={projects}
        onClose={() => setRuleOpen(false)}
        onCreated={() => {
          setRuleOpen(false);
          show('自动化规则已创建');
          rulesState.reload();
        }}
        onError={(message) => show(message, 'error')}
      />

      <ConnectorDialog
        open={connectorOpen}
        onClose={() => setConnectorOpen(false)}
        onCreated={() => {
          setConnectorOpen(false);
          show('连接器已登记');
          connectorsState.reload();
        }}
        onError={(message) => show(message, 'error')}
      />

      <QualityFixDialog
        issue={qualityIssue}
        onClose={() => setQualityIssue(null)}
        onFixed={() => {
          setQualityIssue(null);
          show('修复已提交');
          qualityIssuesState.reload();
        }}
        onError={(message) => show(message, 'error')}
      />

      <Toaster toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

function ApprovalDialog({
  open,
  projects,
  people,
  onClose,
  onCreated,
  onError,
}: {
  open: boolean;
  projects: EnterpriseTabProps['projects'];
  people: EnterpriseTabProps['people'];
  onClose: () => void;
  onCreated: () => void;
  onError: (message: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('change');
  const [projectId, setProjectId] = useState('');
  const [risk, setRisk] = useState<'low' | 'medium' | 'high'>('medium');
  const [approverId, setApproverId] = useState(people[0]?.id ?? '');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || !approverId || busy) return;
    setBusy(true);
    try {
      await api.createApproval({
        title: title.trim(),
        kind,
        projectId: projectId || null,
        risk,
        steps: [{ name: '审批', approverIds: [approverId], mode: 'all' }],
      });
      setTitle('');
      onCreated();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : '发起失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="发起审批"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" form="approval-form" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner size={16} /> : <Icon name="check" size={16} />}
            提交审批
          </button>
        </>
      }
    >
      <form id="approval-form" className="form-grid" onSubmit={(event) => void submit(event)}>
        <Field label="标题" htmlFor="approval-title">
          <input
            id="approval-title"
            className="input"
            value={title}
            required
            maxLength={160}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <Field label="类型" htmlFor="approval-kind">
          <input
            id="approval-kind"
            className="input"
            value={kind}
            maxLength={40}
            onChange={(event) => setKind(event.target.value)}
          />
        </Field>
        <Field label="项目" htmlFor="approval-project">
          <select
            id="approval-project"
            className="input"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">不关联项目</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="风险" htmlFor="approval-risk">
          <select
            id="approval-risk"
            className="input"
            value={risk}
            onChange={(event) => setRisk(event.target.value as typeof risk)}
          >
            {['low', 'medium', 'high'].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>
        <Field label="审批人" htmlFor="approval-approver">
          <select
            id="approval-approver"
            className="input"
            value={approverId}
            onChange={(event) => setApproverId(event.target.value)}
          >
            {people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </Field>
      </form>
    </Modal>
  );
}

function AutomationRuleDialog({
  open,
  projects,
  onClose,
  onCreated,
  onError,
}: {
  open: boolean;
  projects: EnterpriseTabProps['projects'];
  onClose: () => void;
  onCreated: () => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState<AutomationTrigger>('task.created');
  const [action, setAction] = useState<'set_status' | 'set_priority' | 'notify'>('set_status');
  const [value, setValue] = useState('in_progress');
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await api.createAutomationRule({
        name: name.trim(),
        trigger,
        projectId: projectId || null,
        actions: [{ type: action, value }],
      });
      setName('');
      onCreated();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : '创建失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建自动化规则"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" form="automation-form" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner size={16} /> : <Icon name="plus" size={16} />}
            创建规则
          </button>
        </>
      }
    >
      <form id="automation-form" className="form-grid" onSubmit={(event) => void submit(event)}>
        <Field label="规则名称" htmlFor="automation-name">
          <input
            id="automation-name"
            className="input"
            value={name}
            required
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="触发事件" htmlFor="automation-trigger">
          <select
            id="automation-trigger"
            className="input"
            value={trigger}
            onChange={(event) => setTrigger(event.target.value as AutomationTrigger)}
          >
            {TRIGGERS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>
        <Field label="动作" htmlFor="automation-action">
          <select
            id="automation-action"
            className="input"
            value={action}
            onChange={(event) => setAction(event.target.value as typeof action)}
          >
            <option value="set_status">设置状态</option>
            <option value="set_priority">设置优先级</option>
            <option value="notify">通知</option>
          </select>
        </Field>
        <Field label="动作值" htmlFor="automation-value">
          <input
            id="automation-value"
            className="input"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </Field>
        <Field label="限定项目" htmlFor="automation-project">
          <select
            id="automation-project"
            className="input"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">全部可见项目</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </Field>
      </form>
    </Modal>
  );
}

function ConnectorDialog({
  open,
  onClose,
  onCreated,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'oauth' | 'api_key' | 'webhook' | 'service_account'>('api_key');
  const [secret, setSecret] = useState('');
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await api.workbenchCreate('connectors', {
        name: name.trim(),
        kind,
        secret: secret || undefined,
        allowedDomains: domain
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      });
      setName('');
      setSecret('');
      setDomain('');
      onCreated();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : '创建失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="登记连接器"
      description="密钥仅以引用形式保存，不会在列表或日志中回显。"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" form="connector-form" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner size={16} /> : <Icon name="globe" size={16} />}
            保存连接器
          </button>
        </>
      }
    >
      <form id="connector-form" className="form-grid" onSubmit={(event) => void submit(event)}>
        <Field label="名称" htmlFor="connector-name">
          <input
            id="connector-name"
            className="input"
            value={name}
            required
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="认证方式" htmlFor="connector-kind">
          <select
            id="connector-kind"
            className="input"
            value={kind}
            onChange={(event) => setKind(event.target.value as typeof kind)}
          >
            {['oauth', 'api_key', 'webhook', 'service_account'].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>
        <Field label="密钥" htmlFor="connector-secret" hint="至少 8 位，仅保存引用">
          <input
            id="connector-secret"
            className="input"
            type="password"
            value={secret}
            minLength={8}
            onChange={(event) => setSecret(event.target.value)}
          />
        </Field>
        <Field label="允许域名" htmlFor="connector-domain" hint="逗号分隔，用于 SSRF 防护">
          <input
            id="connector-domain"
            className="input"
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
          />
        </Field>
      </form>
    </Modal>
  );
}

function QualityFixDialog({
  issue,
  onClose,
  onFixed,
  onError,
}: {
  issue: WorkbenchRecord | null;
  onClose: () => void;
  onFixed: () => void;
  onError: (message: string) => void;
}) {
  const [fixed, setFixed] = useState('{}');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const details = issue ? objectOf(issue, 'detailsJson') : {};

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!issue || !reason.trim() || busy) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(fixed) as Record<string, unknown>;
    } catch {
      onError('修复内容必须是合法 JSON');
      return;
    }
    setBusy(true);
    try {
      await api.fixQualityIssue(textOf(issue, 'id'), { fixed: parsed, reason: reason.trim() });
      setReason('');
      onFixed();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : '修复失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(issue)}
      onClose={onClose}
      title="数据质量修复"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" form="quality-fix-form" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner size={16} /> : <Icon name="check" size={16} />}
            提交修复
          </button>
        </>
      }
    >
      <form id="quality-fix-form" className="form-grid" onSubmit={(event) => void submit(event)}>
        <p className="enterprise-hint">
          问题：{issue ? textOf(issue, 'issue_key') : ''} · 详情：
          {JSON.stringify(details).slice(0, 240)}
        </p>
        <Field label="修复后数据 (JSON)" htmlFor="quality-fixed">
          <textarea
            id="quality-fixed"
            className="input"
            rows={5}
            value={fixed}
            onChange={(event) => setFixed(event.target.value)}
          />
        </Field>
        <Field label="修复理由" htmlFor="quality-reason">
          <input
            id="quality-reason"
            className="input"
            value={reason}
            required
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
      </form>
    </Modal>
  );
}
