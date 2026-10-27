import { type FormEvent, useEffect, useState } from 'react';
import type {
  BudgetSummary,
  CurrencyCode,
  MetricDefinition,
  MetricEvaluation,
} from '../../../../shared/types.ts';
import {
  api,
  type BudgetAlertReport,
  type MetricImpact,
  type QueryReportRun,
  type ScenarioEvaluation,
  type WorkbenchRecord,
} from '../../api.ts';
import { formatCurrency, formatDate } from '../../format.ts';
import { useApi, useToast } from '../../hooks/useApi.ts';
import { Icon } from '../Icon.tsx';
import { EmptyState, ErrorState, Field, Modal, Spinner, Toaster } from '../ui.tsx';
import {
  EnterpriseEmpty,
  EnterpriseStat,
  type EnterpriseTabProps,
  EnterpriseToolbar,
  listOf,
  numberOf,
  objectOf,
  ToneBadge,
  textOf,
} from './shared.tsx';

const AGGREGATIONS = ['sum', 'avg', 'min', 'max', 'count'] as const;

function rangeDefaults(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 29 * 86_400_000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export function InsightsTab({ projects }: EnterpriseTabProps) {
  const metricsState = useApi((signal) => api.metrics({}, signal), []);
  const budgetsState = useApi((signal) => api.budgets(signal), []);
  const [createMetricOpen, setCreateMetricOpen] = useState(false);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [entryOpen, setEntryOpen] = useState(false);
  const [editingBudget, setEditingBudget] = useState<BudgetSummary | null>(null);
  const [evaluations, setEvaluations] = useState<Record<string, MetricEvaluation>>({});
  const [evaluating, setEvaluating] = useState<string | null>(null);
  const [detecting, setDetecting] = useState<string | null>(null);
  const [impactMetric, setImpactMetric] = useState<MetricDefinition | null>(null);
  const [scenarioOpen, setScenarioOpen] = useState(false);
  const [scenarioResults, setScenarioResults] = useState<Record<string, ScenarioEvaluation>>({});
  const [evaluatingScenario, setEvaluatingScenario] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportRun, setReportRun] = useState<{
    report: WorkbenchRecord;
    result: QueryReportRun;
  } | null>(null);
  const [runningReport, setRunningReport] = useState<string | null>(null);
  const [categorySummary, setCategorySummary] = useState<BudgetAlertReport | null>(null);
  const [categoryProject, setCategoryProject] = useState<{ id: string; name: string } | null>(null);
  const [range, setRange] = useState(rangeDefaults);
  const { toasts, show, dismiss } = useToast();

  const anomaliesState = useApi((signal) => api.workbench('anomalies', { limit: 20 }, signal), []);
  const scenariosState = useApi((signal) => api.workbench('scenarios', { limit: 20 }, signal), []);
  const reportsState = useApi(
    (signal) => api.workbench('query-reports', { limit: 20 }, signal),
    [],
  );
  const subscriptionsState = useApi(
    (signal) => api.workbench('report-subscriptions', { limit: 20 }, signal),
    [],
  );

  const metrics = metricsState.data ?? [];
  const budgets = budgetsState.data ?? [];
  const anomalies = anomaliesState.data?.items ?? [];
  const scenarios = scenariosState.data?.items ?? [];
  const reports = reportsState.data?.items ?? [];
  const subscriptions = subscriptionsState.data?.items ?? [];
  const openAnomalies = anomalies.filter((item) => textOf(item, 'status') === 'open');
  const published = metrics.filter((metric) => metric.status === 'published').length;
  const overThreshold = budgets.filter((summary) => summary.thresholdReached).length;

  const evaluate = async (metric: MetricDefinition) => {
    if (evaluating) return;
    setEvaluating(metric.id);
    try {
      const result = await api.evaluateMetric(metric.id, {
        from: range.from,
        to: range.to,
        groupBy: 'day',
      });
      setEvaluations((current) => ({ ...current, [metric.id]: result }));
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '评估失败', 'error');
    } finally {
      setEvaluating(null);
    }
  };

  const detect = async (metric: MetricDefinition) => {
    if (detecting) return;
    setDetecting(metric.id);
    try {
      const result = await api.detectAnomalies({
        metricId: metric.id,
        from: range.from,
        to: range.to,
      });
      show(
        result.message ?? `「${metric.name}」检测到 ${result.anomalies.length} 个异常`,
        'success',
      );
      anomaliesState.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '异常检测失败', 'error');
    } finally {
      setDetecting(null);
    }
  };

  const dismissAnomaly = async (id: string) => {
    try {
      await api.dismissAnomaly(id);
      show('异常已忽略');
      anomaliesState.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '操作失败', 'error');
    }
  };

  const evaluateScenario = async (scenario: WorkbenchRecord) => {
    const id = textOf(scenario, 'id');
    if (!id || evaluatingScenario) return;
    setEvaluatingScenario(id);
    try {
      const result = await api.evaluateScenario(id);
      setScenarioResults((current) => ({ ...current, [id]: result }));
      show(`「${textOf(scenario, 'name')}」评估完成`);
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '情景评估失败', 'error');
    } finally {
      setEvaluatingScenario(null);
    }
  };

  const runReport = async (report: WorkbenchRecord) => {
    const id = textOf(report, 'id');
    if (!id || runningReport) return;
    setRunningReport(id);
    try {
      const result = await api.runQueryReport(id);
      setReportRun({ report, result });
      show(`返回 ${result.rowCount} 行`);
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '报表运行失败', 'error');
    } finally {
      setRunningReport(null);
    }
  };

  const openCategories = async (summary: BudgetSummary) => {
    setCategoryProject({
      id: summary.budget.projectId,
      name: summary.budget.projectName,
    });
    try {
      setCategorySummary(await api.budgetAlerts(summary.budget.projectId));
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '预算详情加载失败', 'error');
      setCategoryProject(null);
    }
  };

  return (
    <div className="enterprise-tab">
      <div className="enterprise-stats">
        <EnterpriseStat label="指标定义" value={metrics.length} hint={`${published} 个已发布`} />
        <EnterpriseStat label="预算项目" value={budgets.length} hint="已配置项目预算" tone="mint" />
        <EnterpriseStat
          label="超出阈值"
          value={overThreshold}
          hint="实际支出达到预警线"
          tone={overThreshold > 0 ? 'peach' : 'sky'}
        />
        <EnterpriseStat
          label="组合剩余预算"
          value={formatCurrency(
            budgets.reduce((sum, summary) => sum + summary.remainingCents / 100, 0),
          )}
          hint="按预算币种粗略合计"
          tone="lilac"
        />
        <EnterpriseStat
          label="未处理异常"
          value={openAnomalies.length}
          hint={`${anomalies.length} 条检测记录`}
          tone={openAnomalies.length > 0 ? 'peach' : 'sky'}
        />
      </div>

      <EnterpriseToolbar>
        <div className="enterprise-range">
          <label>
            评估起
            <input
              className="input input-sm"
              type="date"
              value={range.from}
              onChange={(event) =>
                setRange((current) => ({ ...current, from: event.target.value }))
              }
            />
          </label>
          <label>
            止
            <input
              className="input input-sm"
              type="date"
              value={range.to}
              onChange={(event) => setRange((current) => ({ ...current, to: event.target.value }))}
            />
          </label>
        </div>
        <div className="enterprise-toolbar-actions">
          <button type="button" className="btn btn-soft btn-sm" onClick={() => setEntryOpen(true)}>
            <Icon name="plus" size={15} />
            记录成本
          </button>
          <button type="button" className="btn btn-soft btn-sm" onClick={() => setBudgetOpen(true)}>
            <Icon name="database" size={15} />
            设置预算
          </button>
          <button
            type="button"
            className="btn btn-soft btn-sm"
            onClick={() => setScenarioOpen(true)}
          >
            <Icon name="trend" size={15} />
            新建情景
          </button>
          <button type="button" className="btn btn-soft btn-sm" onClick={() => setReportOpen(true)}>
            <Icon name="analytics" size={15} />
            新建报表
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setCreateMetricOpen(true)}
          >
            <Icon name="plus" size={16} />
            新建指标
          </button>
        </div>
      </EnterpriseToolbar>

      <section className="card card-pad">
        <header className="card-head">
          <div>
            <h2>指标定义</h2>
            <p className="card-sub">公式基于日指标数据源求值，支持按天/周/月聚合。</p>
          </div>
        </header>
        {metricsState.error && !metricsState.data ? (
          <ErrorState message={metricsState.error} onRetry={metricsState.reload} compact />
        ) : null}
        {metrics.length === 0 ? (
          <EmptyState
            icon="analytics"
            title="还没有指标定义"
            description="例如：sum(revenue) / sum(sessions)，用于统一口径。"
            compact
          />
        ) : (
          <ul className="enterprise-sublist">
            {metrics.map((metric) => {
              const evaluation = evaluations[metric.id];
              return (
                <li key={metric.id}>
                  <div className="enterprise-subject">
                    <span>
                      {metric.name}{' '}
                      <ToneBadge tone={metric.status === 'published' ? 'success' : 'muted'}>
                        {metric.status === 'published' ? '已发布' : metric.status}
                      </ToneBadge>
                    </span>
                    <span className="table-muted">
                      {metric.formula} · {metric.aggregation} · v{metric.version}
                    </span>
                    <div className="enterprise-row-actions">
                      <button
                        type="button"
                        className="btn btn-soft btn-sm"
                        disabled={evaluating === metric.id}
                        onClick={() => void evaluate(metric)}
                      >
                        {evaluating === metric.id ? (
                          <Spinner size={14} />
                        ) : (
                          <Icon name="trend" size={14} />
                        )}
                        评估
                      </button>
                      <button
                        type="button"
                        className="btn btn-soft btn-sm"
                        disabled={detecting === metric.id}
                        onClick={() => void detect(metric)}
                      >
                        {detecting === metric.id ? (
                          <Spinner size={14} />
                        ) : (
                          <Icon name="alert" size={14} />
                        )}
                        检测异常
                      </button>
                      <button
                        type="button"
                        className="btn btn-soft btn-sm"
                        onClick={() => setImpactMetric(metric)}
                      >
                        <Icon name="database" size={14} />
                        血缘与影响
                      </button>
                    </div>
                  </div>
                  {evaluation ? (
                    <p className="enterprise-hint">
                      {evaluation.from} ~ {evaluation.to}：{' '}
                      <strong>
                        {evaluation.value === null ? '无数据' : evaluation.value.toFixed(2)}
                        {evaluation.unit}
                      </strong>{' '}
                      · {evaluation.series.length} 个数据点
                      {evaluation.warnings.length > 0 ? ` · ${evaluation.warnings.join('；')}` : ''}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card card-pad">
        <header className="card-head">
          <div>
            <h2>指标异常</h2>
            <p className="card-sub">基于基线均值与标准差的 Z-score 检测，可按需忽略。</p>
          </div>
        </header>
        {anomaliesState.error && !anomaliesState.data ? (
          <ErrorState message={anomaliesState.error} onRetry={anomaliesState.reload} compact />
        ) : null}
        {anomalies.length === 0 ? (
          <EmptyState
            icon="alert"
            title="暂无异常"
            description="在指标旁点击「检测异常」，按当前评估区间运行检测。"
            compact
          />
        ) : (
          <div className="card table-card">
            <table className="data-table">
              <thead>
                <tr>
                  <th>指标</th>
                  <th>周期</th>
                  <th>数值</th>
                  <th>基线</th>
                  <th>偏离</th>
                  <th>严重度</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {anomalies.map((anomaly) => {
                  const id = textOf(anomaly, 'id');
                  const metricName =
                    metrics.find((metric) => metric.id === textOf(anomaly, 'metricId'))?.name ??
                    textOf(anomaly, 'metricId', '—');
                  const severity = textOf(anomaly, 'severity', 'warn');
                  const status = textOf(anomaly, 'status', 'open');
                  return (
                    <tr key={id}>
                      <td>{metricName}</td>
                      <td>{textOf(anomaly, 'period')}</td>
                      <td>{numberOf(anomaly, 'value').toFixed(2)}</td>
                      <td className="table-muted">{numberOf(anomaly, 'baseline').toFixed(2)}</td>
                      <td className={numberOf(anomaly, 'deviation') < 0 ? 'is-negative' : ''}>
                        {numberOf(anomaly, 'deviation').toFixed(1)}%
                      </td>
                      <td>
                        <ToneBadge tone={severity === 'critical' ? 'danger' : 'warning'}>
                          {severity === 'critical' ? '严重' : '警告'}
                        </ToneBadge>
                      </td>
                      <td className="table-muted">{status === 'open' ? '待处理' : status}</td>
                      <td>
                        {status === 'open' ? (
                          <button
                            type="button"
                            className="btn btn-soft btn-sm"
                            onClick={() => void dismissAnomaly(id)}
                          >
                            忽略
                          </button>
                        ) : null}
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
            <h2>情景预测</h2>
            <p className="card-sub">基于增长、转化与成本假设，预测收入、成本与毛利。</p>
          </div>
        </header>
        {scenariosState.error && !scenariosState.data ? (
          <ErrorState message={scenariosState.error} onRetry={scenariosState.reload} compact />
        ) : null}
        {scenarios.length === 0 ? (
          <EmptyState
            icon="trend"
            title="还没有情景"
            description="新建情景并填写假设，即可评估敏感性与毛利变化。"
            compact
          />
        ) : (
          <ul className="enterprise-sublist">
            {scenarios.map((scenario) => {
              const id = textOf(scenario, 'id');
              const projected = scenarioResults[id]?.result.projected ?? null;
              const margin = projected ? formatCurrency(projected.marginCents / 100) : '—';
              return (
                <li key={id}>
                  <div className="enterprise-subject">
                    <span>
                      {textOf(scenario, 'name')}{' '}
                      <ToneBadge
                        tone={textOf(scenario, 'status') === 'published' ? 'success' : 'muted'}
                      >
                        {textOf(scenario, 'status', 'draft')}
                      </ToneBadge>
                    </span>
                    <span className="table-muted">
                      基准日 {textOf(scenario, 'baseDate')} · 预测毛利 {margin}
                    </span>
                    <button
                      type="button"
                      className="btn btn-soft btn-sm"
                      disabled={evaluatingScenario === id}
                      onClick={() => void evaluateScenario(scenario)}
                    >
                      {evaluatingScenario === id ? (
                        <Spinner size={14} />
                      ) : (
                        <Icon name="trend" size={14} />
                      )}
                      评估
                    </button>
                  </div>
                  {projected ? (
                    <p className="enterprise-hint">
                      收入 {formatCurrency(projected.revenueCents / 100)} · 成本{' '}
                      {formatCurrency(projected.costCents / 100)} · 毛利{' '}
                      {formatCurrency(projected.marginCents / 100)}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card card-pad">
        <header className="card-head">
          <div>
            <h2>自助报表与订阅</h2>
            <p className="card-sub">按数据集组合字段、聚合和过滤，运行后按订阅周期交付。</p>
          </div>
          <button
            type="button"
            className="btn btn-soft btn-sm"
            onClick={() => {
              void api
                .runReportSubscriptions()
                .then((result) => {
                  show(`已处理 ${result.delivered} 个订阅`);
                  subscriptionsState.reload();
                })
                .catch((cause: unknown) =>
                  show(cause instanceof Error ? cause.message : '订阅执行失败', 'error'),
                );
            }}
          >
            <Icon name="mail" size={14} />
            执行到期订阅
          </button>
        </header>
        {reportsState.error && !reportsState.data ? (
          <ErrorState message={reportsState.error} onRetry={reportsState.reload} compact />
        ) : null}
        {reports.length === 0 ? (
          <EmptyState
            icon="analytics"
            title="还没有自助报表"
            description="新建报表后可保存口径、共享给团队并配置订阅。"
            compact
          />
        ) : (
          <ul className="enterprise-sublist">
            {reports.map((report) => {
              const id = textOf(report, 'id');
              const config = objectOf(report, 'configJson');
              const subscriptionCount = subscriptions.filter(
                (item) => textOf(item, 'reportId') === id,
              ).length;
              return (
                <li key={id}>
                  <div className="enterprise-subject">
                    <span>
                      {textOf(report, 'name')}{' '}
                      <ToneBadge tone={report.shared ? 'success' : 'muted'}>
                        {report.shared ? '已共享' : '私有'}
                      </ToneBadge>
                    </span>
                    <span className="table-muted">
                      {textOf(config, 'dataset')} · {listOf<string>(config, 'fields').join(', ')} ·{' '}
                      {textOf(config, 'visualization', 'table')} · {subscriptionCount} 个订阅
                    </span>
                    <button
                      type="button"
                      className="btn btn-soft btn-sm"
                      disabled={runningReport === id}
                      onClick={() => void runReport(report)}
                    >
                      {runningReport === id ? <Spinner size={14} /> : <Icon name="eye" size={14} />}
                      运行
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {subscriptions.length > 0 ? (
          <div className="card table-card enterprise-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>订阅报表</th>
                  <th>收件人</th>
                  <th>格式</th>
                  <th>下次运行</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {subscriptions.map((subscription) => (
                  <tr key={textOf(subscription, 'id')}>
                    <td>
                      {textOf(
                        reports.find((report) => report.id === textOf(subscription, 'reportId')),
                        'name',
                        textOf(subscription, 'reportId'),
                      )}
                    </td>
                    <td className="table-muted">
                      {listOf<string>(subscription, 'recipientsJson').join(', ')}
                    </td>
                    <td>{textOf(subscription, 'format')}</td>
                    <td className="table-muted">{textOf(subscription, 'nextRunAt')}</td>
                    <td>
                      <ToneBadge tone={subscription.active ? 'success' : 'muted'}>
                        {subscription.active ? '启用' : '停用'}
                      </ToneBadge>
                    </td>
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
            <h2>项目预算</h2>
            <p className="card-sub">承诺、实际与预测成本，多币种按录入汇率折算。</p>
          </div>
        </header>
        {budgetsState.error && !budgetsState.data ? (
          <ErrorState message={budgetsState.error} onRetry={budgetsState.reload} compact />
        ) : null}
        {budgets.length === 0 ? (
          <EmptyState icon="database" title="还没有项目预算" compact />
        ) : (
          <div className="card table-card">
            <table className="data-table">
              <thead>
                <tr>
                  <th>项目</th>
                  <th>预算</th>
                  <th>已承诺</th>
                  <th>实际</th>
                  <th>预测</th>
                  <th>消耗</th>
                  <th>剩余</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {budgets.map((summary) => (
                  <tr key={summary.budget.id}>
                    <td>{summary.budget.projectName}</td>
                    <td>{formatCurrency(summary.budget.budgetCents / 100)}</td>
                    <td className="table-muted">
                      {formatCurrency(summary.budget.committedCents / 100)}
                    </td>
                    <td>{formatCurrency(summary.budget.actualCents / 100)}</td>
                    <td className="table-muted">
                      {formatCurrency(summary.budget.forecastCents / 100)}
                    </td>
                    <td>
                      <ToneBadge tone={summary.thresholdReached ? 'danger' : 'success'}>
                        {summary.burnPct.toFixed(1)}%
                      </ToneBadge>
                    </td>
                    <td>{formatCurrency(summary.remainingCents / 100)}</td>
                    <td>
                      <div className="enterprise-row-actions">
                        <button
                          type="button"
                          className="btn btn-soft btn-sm"
                          onClick={() => void openCategories(summary)}
                        >
                          分类与预警
                        </button>
                        <button
                          type="button"
                          className="btn btn-soft btn-sm"
                          onClick={() => {
                            setEditingBudget(summary);
                            setBudgetOpen(true);
                          }}
                        >
                          调整
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <EnterpriseEmpty>预算条目支持幂等键，重复提交不会重复计入成本。</EnterpriseEmpty>
      </section>

      <CreateMetricDialog
        open={createMetricOpen}
        onClose={() => setCreateMetricOpen(false)}
        onCreated={(metric) => {
          setCreateMetricOpen(false);
          show(`已创建指标「${metric.name}」`);
          metricsState.reload();
        }}
        onError={(message) => show(message, 'error')}
      />

      <BudgetDialog
        open={budgetOpen}
        projects={projects}
        existing={editingBudget}
        onClose={() => {
          setBudgetOpen(false);
          setEditingBudget(null);
        }}
        onSaved={(summary) => {
          setBudgetOpen(false);
          setEditingBudget(null);
          show(`「${summary.budget.projectName}」预算已保存`);
          budgetsState.reload();
        }}
        onError={(message) => show(message, 'error')}
      />

      <BudgetEntryDialog
        open={entryOpen}
        projects={projects}
        budgets={budgets}
        onClose={() => setEntryOpen(false)}
        onSaved={(summary, replayed) => {
          setEntryOpen(false);
          show(
            replayed ? '该条目已存在，未重复计入' : `成本已记录到「${summary.budget.projectName}」`,
          );
          budgetsState.reload();
        }}
        onError={(message) => show(message, 'error')}
      />

      <MetricImpactDialog
        metric={impactMetric}
        onClose={() => setImpactMetric(null)}
        onChanged={() => {
          metricsState.reload();
        }}
        onError={(message) => show(message, 'error')}
      />

      <ScenarioDialog
        open={scenarioOpen}
        onClose={() => setScenarioOpen(false)}
        onCreated={(scenario) => {
          setScenarioOpen(false);
          show(`已创建情景「${textOf(scenario, 'name')}」`);
          scenariosState.reload();
        }}
        onError={(message) => show(message, 'error')}
      />

      <QueryReportDialog
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        onCreated={(report) => {
          setReportOpen(false);
          show(`已创建报表「${textOf(report, 'name')}」`);
          reportsState.reload();
        }}
        onError={(message) => show(message, 'error')}
      />

      <ReportRunDialog
        run={reportRun}
        subscriptions={subscriptions}
        onClose={() => setReportRun(null)}
        onSubscribed={() => {
          show('订阅已创建');
          subscriptionsState.reload();
        }}
        onError={(message) => show(message, 'error')}
      />

      <BudgetCategoriesDialog
        project={categoryProject}
        summary={categorySummary}
        onClose={() => {
          setCategoryProject(null);
          setCategorySummary(null);
        }}
        onChanged={async () => {
          if (!categoryProject) return;
          try {
            setCategorySummary(await api.budgetAlerts(categoryProject.id));
            budgetsState.reload();
          } catch (cause) {
            show(cause instanceof Error ? cause.message : '预算详情加载失败', 'error');
          }
        }}
        onError={(message) => show(message, 'error')}
      />

      <Toaster toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

function MetricImpactDialog({
  metric,
  onClose,
  onChanged,
  onError,
}: {
  metric: MetricDefinition | null;
  onClose: () => void;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [impact, setImpact] = useState<MetricImpact | null>(null);
  const [loading, setLoading] = useState(false);
  const [sourceType, setSourceType] = useState<
    'table' | 'import' | 'formula' | 'filter' | 'fx' | 'metric' | 'manual'
  >('table');
  const [sourceId, setSourceId] = useState('');
  const [sensitive, setSensitive] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async (id: string, signal?: AbortSignal) => {
    setLoading(true);
    try {
      setImpact(await api.metricImpact(id, signal));
    } catch (cause) {
      if (signal?.aborted) return;
      onError(cause instanceof Error ? cause.message : '血缘加载失败');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    if (!metric) {
      setImpact(null);
      return;
    }
    const controller = new AbortController();
    void load(metric.id, controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metric?.id]);

  const addLineage = async (event: FormEvent) => {
    event.preventDefault();
    if (!metric || !sourceId.trim() || busy) return;
    setBusy(true);
    try {
      await api.addMetricLineage(metric.id, {
        sourceType,
        sourceId: sourceId.trim(),
        sensitive,
      });
      setSourceId('');
      setSensitive(false);
      await load(metric.id);
      onChanged();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : '血缘登记失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(metric)}
      onClose={onClose}
      title={metric ? `血缘与影响 · ${metric.name}` : '血缘与影响'}
      footer={
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          关闭
        </button>
      }
    >
      {loading ? <Spinner size={18} /> : null}
      {impact ? (
        <div className="enterprise-impact">
          <p>
            <ToneBadge tone={impact.lineage.complete ? 'success' : 'danger'}>
              {impact.lineage.complete ? '口径完整' : '口径不完整'}
            </ToneBadge>{' '}
            {impact.lineage.missing.length > 0
              ? `缺少：${impact.lineage.missing.join('、')}`
              : '已覆盖表与上游指标'}
            {impact.trimmed ? ' · 敏感来源已按权限裁剪' : ''}
          </p>
          <ul className="enterprise-sublist">
            {Object.entries(impact.catalog).map(([bucket, values]) =>
              values.length === 0 ? null : (
                <li key={bucket}>
                  <div className="enterprise-subject">
                    <span>{CATALOG_LABELS[bucket] ?? bucket}</span>
                    <span className="table-muted">{values.join('、')}</span>
                  </div>
                </li>
              ),
            )}
          </ul>
          <p className="enterprise-hint">
            下游指标 {impact.downstream.length} 个 · 图表 {impact.affected.charts.length} 个 · 报表{' '}
            {impact.affected.reports.length} 个 · 自动化 {impact.affected.automationRules.length} 个
            · 订阅 {impact.affected.subscriptions.length} 个
          </p>
          {impact.downstream.length > 0 ? (
            <p className="enterprise-hint">
              下游：{impact.downstream.map((item) => `${item.name}(d${item.depth})`).join('、')}
            </p>
          ) : null}
          {impact.affected.charts.length + impact.affected.reports.length > 0 ? (
            <p className="enterprise-hint">
              受影响：
              {[...impact.affected.charts, ...impact.affected.reports]
                .map((item) => item.name)
                .join('、')}
            </p>
          ) : null}
          <form className="form-grid" onSubmit={(event) => void addLineage(event)}>
            <Field label="来源类型" htmlFor="lineage-type">
              <select
                id="lineage-type"
                className="input"
                value={sourceType}
                onChange={(event) => setSourceType(event.target.value as typeof sourceType)}
              >
                {LINEAGE_TYPES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="来源标识" htmlFor="lineage-source" hint="表名、指标 ID 或导入批次">
              <input
                id="lineage-source"
                className="input"
                value={sourceId}
                required
                maxLength={120}
                onChange={(event) => setSourceId(event.target.value)}
              />
            </Field>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={sensitive}
                onChange={(event) => setSensitive(event.target.checked)}
              />
              标记为敏感来源（仅管理员可见）
            </label>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? <Spinner size={16} /> : <Icon name="plus" size={16} />}
              登记血缘
            </button>
          </form>
        </div>
      ) : null}
    </Modal>
  );
}

const LINEAGE_TYPES = [
  ['table', '数据表'],
  ['import', '导入批次'],
  ['formula', '公式'],
  ['filter', '过滤器'],
  ['fx', '汇率'],
  ['metric', '上游指标'],
  ['manual', '人工录入'],
] as const;

const CATALOG_LABELS: Record<string, string> = {
  tables: '数据表',
  imports: '导入批次',
  formulas: '公式',
  filters: '过滤器',
  fx: '汇率',
  metrics: '上游指标',
  manual: '人工录入',
};

function ScenarioDialog({
  open,
  onClose,
  onCreated,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (scenario: WorkbenchRecord) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState('');
  const [baseDate, setBaseDate] = useState(rangeDefaults().to);
  const [revenueGrowth, setRevenueGrowth] = useState('10');
  const [conversionGrowth, setConversionGrowth] = useState('0');
  const [costGrowth, setCostGrowth] = useState('5');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const scenario = await api.workbenchCreate('scenarios', {
        name: name.trim(),
        baseDate,
        assumptions: {
          revenueGrowthPct: Number(revenueGrowth),
          conversionGrowthPct: Number(conversionGrowth),
          costGrowthPct: Number(costGrowth),
        },
      });
      setName('');
      onCreated(scenario);
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
      title="新建情景"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" form="scenario-form" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner size={16} /> : <Icon name="plus" size={16} />}
            创建情景
          </button>
        </>
      }
    >
      <form id="scenario-form" className="form-grid" onSubmit={(event) => void submit(event)}>
        <Field label="情景名称" htmlFor="scenario-name">
          <input
            id="scenario-name"
            className="input"
            value={name}
            required
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="基准日期" htmlFor="scenario-date">
          <input
            id="scenario-date"
            className="input"
            type="date"
            value={baseDate}
            onChange={(event) => setBaseDate(event.target.value)}
          />
        </Field>
        <Field label="收入增长 (%)" htmlFor="scenario-revenue">
          <input
            id="scenario-revenue"
            className="input"
            type="number"
            min={-100}
            max={1000}
            value={revenueGrowth}
            onChange={(event) => setRevenueGrowth(event.target.value)}
          />
        </Field>
        <Field label="转化增长 (%)" htmlFor="scenario-conversion">
          <input
            id="scenario-conversion"
            className="input"
            type="number"
            min={-100}
            max={1000}
            value={conversionGrowth}
            onChange={(event) => setConversionGrowth(event.target.value)}
          />
        </Field>
        <Field label="成本增长 (%)" htmlFor="scenario-cost">
          <input
            id="scenario-cost"
            className="input"
            type="number"
            min={-100}
            max={1000}
            value={costGrowth}
            onChange={(event) => setCostGrowth(event.target.value)}
          />
        </Field>
      </form>
    </Modal>
  );
}

const DATASETS = ['daily_metrics', 'projects', 'tasks', 'opportunities'] as const;
const VISUALIZATIONS = ['table', 'bar', 'line', 'pie'] as const;

function QueryReportDialog({
  open,
  onClose,
  onCreated,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (report: WorkbenchRecord) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState('');
  const [dataset, setDataset] = useState<(typeof DATASETS)[number]>('daily_metrics');
  const [fields, setFields] = useState('date, revenue_cents');
  const [visualization, setVisualization] = useState<(typeof VISUALIZATIONS)[number]>('table');
  const [shared, setShared] = useState(true);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const fieldList = fields
      .split(',')
      .map((field) => field.trim())
      .filter(Boolean);
    if (!name.trim() || fieldList.length === 0 || busy) return;
    setBusy(true);
    try {
      const report = await api.workbenchCreate('query-reports', {
        name: name.trim(),
        shared,
        config: { dataset, fields: fieldList, visualization },
      });
      setName('');
      onCreated(report);
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
      title="新建自助报表"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            form="query-report-form"
            className="btn btn-primary"
            disabled={busy}
          >
            {busy ? <Spinner size={16} /> : <Icon name="plus" size={16} />}
            创建报表
          </button>
        </>
      }
    >
      <form id="query-report-form" className="form-grid" onSubmit={(event) => void submit(event)}>
        <Field label="报表名称" htmlFor="report-name">
          <input
            id="report-name"
            className="input"
            value={name}
            required
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="数据集" htmlFor="report-dataset">
          <select
            id="report-dataset"
            className="input"
            value={dataset}
            onChange={(event) => setDataset(event.target.value as (typeof DATASETS)[number])}
          >
            {DATASETS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>
        <Field label="字段" htmlFor="report-fields" hint="逗号分隔，最多 20 个">
          <input
            id="report-fields"
            className="input"
            value={fields}
            required
            onChange={(event) => setFields(event.target.value)}
          />
        </Field>
        <Field label="可视化" htmlFor="report-visualization">
          <select
            id="report-visualization"
            className="input"
            value={visualization}
            onChange={(event) =>
              setVisualization(event.target.value as (typeof VISUALIZATIONS)[number])
            }
          >
            {VISUALIZATIONS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={shared}
            onChange={(event) => setShared(event.target.checked)}
          />
          共享给同工作区成员
        </label>
      </form>
    </Modal>
  );
}

function ReportRunDialog({
  run,
  subscriptions,
  onClose,
  onSubscribed,
  onError,
}: {
  run: { report: WorkbenchRecord; result: QueryReportRun } | null;
  subscriptions: WorkbenchRecord[];
  onClose: () => void;
  onSubscribed: () => void;
  onError: (message: string) => void;
}) {
  const [recipients, setRecipients] = useState('');
  const [format, setFormat] = useState<'csv' | 'json' | 'pdf' | 'xlsx'>('csv');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (run) setRecipients('');
  }, [run]);

  const reportId = run ? textOf(run.report, 'id') : '';
  const subscribed = subscriptions.some((item) => textOf(item, 'reportId') === reportId);

  const subscribe = async (event: FormEvent) => {
    event.preventDefault();
    if (!run || busy) return;
    const emails = recipients
      .split(',')
      .map((email) => email.trim())
      .filter(Boolean);
    if (emails.length === 0) return;
    setBusy(true);
    try {
      await api.createReportSubscription({
        reportId,
        reportKind: 'query',
        recipients: emails,
        format,
        channel: 'download',
      });
      onSubscribed();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : '订阅失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(run)}
      onClose={onClose}
      title={run ? `运行结果 · ${textOf(run.report, 'name')}` : '运行结果'}
      footer={
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          关闭
        </button>
      }
    >
      {run ? (
        <div className="enterprise-report-result">
          <p className="enterprise-hint">
            共 {run.result.rowCount} 行 · 列：{run.result.columns.join('、')}
          </p>
          <div className="card table-card enterprise-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  {run.result.columns.map((column) => (
                    <th key={column}>{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {run.result.rows.slice(0, 20).map((row, index) => (
                  <tr key={index}>
                    {run.result.columns.map((column) => (
                      <td key={column}>{formatCell(row[column])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {subscribed ? (
            <p className="enterprise-hint">该报表已有订阅。</p>
          ) : (
            <form className="form-grid" onSubmit={(event) => void subscribe(event)}>
              <Field label="订阅收件人" htmlFor="report-recipients" hint="逗号分隔的邮箱">
                <input
                  id="report-recipients"
                  className="input"
                  type="email"
                  multiple
                  value={recipients}
                  onChange={(event) => setRecipients(event.target.value)}
                />
              </Field>
              <Field label="交付格式" htmlFor="report-format">
                <select
                  id="report-format"
                  className="input"
                  value={format}
                  onChange={(event) => setFormat(event.target.value as typeof format)}
                >
                  {['csv', 'json', 'pdf', 'xlsx'].map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </Field>
              <button type="submit" className="btn btn-soft" disabled={busy}>
                {busy ? <Spinner size={16} /> : <Icon name="mail" size={16} />}
                创建订阅
              </button>
            </form>
          )}
        </div>
      ) : null}
    </Modal>
  );
}

function BudgetCategoriesDialog({
  project,
  summary,
  onClose,
  onChanged,
  onError,
}: {
  project: { id: string; name: string } | null;
  summary: BudgetAlertReport | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState('');
  const [planned, setPlanned] = useState('10000');
  const [actual, setActual] = useState('0');
  const [busy, setBusy] = useState(false);
  const budgetId = summary?.budget?.id ?? '';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!budgetId || !name.trim() || busy) return;
    setBusy(true);
    try {
      await api.createBudgetCategory(budgetId, {
        name: name.trim(),
        plannedCents: Math.round(Number(planned) * 100),
        actualCents: Math.round(Number(actual) * 100),
      });
      setName('');
      setActual('0');
      await onChanged();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : '创建失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(project)}
      onClose={onClose}
      title={project ? `预算分类 · ${project.name}` : '预算分类'}
      footer={
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          关闭
        </button>
      }
    >
      {summary ? (
        <div className="enterprise-impact">
          {summary.budget ? (
            <p className="enterprise-hint">
              总预算 {formatCurrency(summary.budget.budgetCents / 100)} · 实际{' '}
              {formatCurrency(summary.budget.actualCents / 100)} · 使用{' '}
              {summary.budget.usagePct.toFixed(1)}%
            </p>
          ) : (
            <p className="enterprise-hint">该项目尚未设置预算。</p>
          )}
          {summary.alerts.length > 0 ? (
            <ul className="enterprise-sublist">
              {summary.alerts.map((alert, index) => (
                <li key={`${alert.scope}-${alert.id ?? index}`}>
                  <div className="enterprise-subject">
                    <span>{alert.name}</span>
                    <span className="table-muted">
                      {alert.usagePct.toFixed(1)}% · 超出 {formatCurrency(alert.overCents / 100)}
                    </span>
                    <ToneBadge tone={alert.level === 'critical' ? 'danger' : 'warning'}>
                      {alert.level === 'critical' ? '超限' : '预警'}
                    </ToneBadge>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="enterprise-hint">暂无预算预警。</p>
          )}
          {summary.categories.length > 0 ? (
            <div className="card table-card enterprise-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>费用类别</th>
                    <th>计划</th>
                    <th>实际</th>
                    <th>预测</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.categories.map((category) => (
                    <tr key={textOf(category, 'id')}>
                      <td>{textOf(category, 'name')}</td>
                      <td>{formatCurrency(numberOf(category, 'planned_cents') / 100)}</td>
                      <td>{formatCurrency(numberOf(category, 'actual_cents') / 100)}</td>
                      <td className="table-muted">
                        {formatCurrency(numberOf(category, 'forecast_cents') / 100)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {summary.budget ? (
            <form className="form-grid" onSubmit={(event) => void submit(event)}>
              <Field label="类别名称" htmlFor="category-name">
                <input
                  id="category-name"
                  className="input"
                  value={name}
                  required
                  maxLength={80}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Field label="计划金额" htmlFor="category-planned">
                <input
                  id="category-planned"
                  className="input"
                  type="number"
                  min={0}
                  step="0.01"
                  value={planned}
                  onChange={(event) => setPlanned(event.target.value)}
                />
              </Field>
              <Field label="实际金额" htmlFor="category-actual">
                <input
                  id="category-actual"
                  className="input"
                  type="number"
                  min={0}
                  step="0.01"
                  value={actual}
                  onChange={(event) => setActual(event.target.value)}
                />
              </Field>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? <Spinner size={16} /> : <Icon name="plus" size={16} />}
                添加类别
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function CreateMetricDialog({
  open,
  onClose,
  onCreated,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (metric: MetricDefinition) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState('');
  const [formula, setFormula] = useState('sum(revenue)');
  const [unit, setUnit] = useState('');
  const [aggregation, setAggregation] = useState<(typeof AGGREGATIONS)[number]>('sum');
  const [dimensions, setDimensions] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const metric = await api.createMetric({
        name,
        formula,
        unit,
        aggregation,
        dimensions: dimensions
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      });
      setName('');
      setDimensions('');
      onCreated(metric);
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
      title="新建指标"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            form="metric-create-form"
            className="btn btn-primary"
            disabled={busy}
          >
            {busy ? <Spinner size={16} /> : <Icon name="plus" size={16} />}
            创建指标
          </button>
        </>
      }
    >
      <form id="metric-create-form" className="form-grid" onSubmit={(event) => void submit(event)}>
        <Field label="指标名称" htmlFor="metric-name">
          <input
            id="metric-name"
            className="input"
            value={name}
            required
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="单位" htmlFor="metric-unit">
          <input
            id="metric-unit"
            className="input"
            value={unit}
            maxLength={20}
            onChange={(event) => setUnit(event.target.value)}
          />
        </Field>
        <Field label="公式" htmlFor="metric-formula" hint="例如 sum(revenue) / sum(sessions)">
          <input
            id="metric-formula"
            className="input"
            value={formula}
            required
            maxLength={500}
            onChange={(event) => setFormula(event.target.value)}
          />
        </Field>
        <Field label="聚合方式" htmlFor="metric-aggregation">
          <select
            id="metric-aggregation"
            className="input"
            value={aggregation}
            onChange={(event) =>
              setAggregation(event.target.value as (typeof AGGREGATIONS)[number])
            }
          >
            {AGGREGATIONS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>
        <Field label="维度" htmlFor="metric-dimensions" hint="逗号分隔，最多 5 个">
          <input
            id="metric-dimensions"
            className="input"
            value={dimensions}
            onChange={(event) => setDimensions(event.target.value)}
          />
        </Field>
      </form>
    </Modal>
  );
}

function BudgetDialog({
  open,
  projects,
  existing,
  onClose,
  onSaved,
  onError,
}: {
  open: boolean;
  projects: EnterpriseTabProps['projects'];
  existing: BudgetSummary | null;
  onClose: () => void;
  onSaved: (summary: BudgetSummary) => void;
  onError: (message: string) => void;
}) {
  const [projectId, setProjectId] = useState(existing?.budget.projectId ?? projects[0]?.id ?? '');
  const [amount, setAmount] = useState(
    existing ? String(existing.budget.budgetCents / 100) : '100000',
  );
  const [costCenter, setCostCenter] = useState(existing?.budget.costCenter ?? '');
  const [threshold, setThreshold] = useState(String(existing?.budget.thresholdPct ?? 80));
  const [currency, setCurrency] = useState<CurrencyCode>(existing?.budget.currency ?? 'USD');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setProjectId(existing?.budget.projectId ?? projects[0]?.id ?? '');
    setAmount(existing ? String(existing.budget.budgetCents / 100) : '100000');
    setCostCenter(existing?.budget.costCenter ?? '');
    setThreshold(String(existing?.budget.thresholdPct ?? 80));
    setCurrency(existing?.budget.currency ?? 'USD');
  }, [open, existing, projects]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!projectId || busy) return;
    setBusy(true);
    try {
      const summary = await api.upsertBudget(projectId, {
        budgetCents: Math.round(Number(amount) * 100),
        costCenter,
        thresholdPct: Number(threshold),
        currency,
        version: existing?.budget.version,
      });
      onSaved(summary);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={existing ? '调整项目预算' : '设置项目预算'}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" form="budget-form" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner size={16} /> : <Icon name="check" size={16} />}
            保存预算
          </button>
        </>
      }
    >
      <form id="budget-form" className="form-grid" onSubmit={(event) => void submit(event)}>
        <Field label="项目" htmlFor="budget-project">
          <select
            id="budget-project"
            className="input"
            value={projectId}
            disabled={Boolean(existing)}
            onChange={(event) => setProjectId(event.target.value)}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="预算金额" htmlFor="budget-amount" hint="按主币种单位填写">
          <input
            id="budget-amount"
            className="input"
            type="number"
            min={0}
            step="0.01"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </Field>
        <Field label="成本中心" htmlFor="budget-cost-center">
          <input
            id="budget-cost-center"
            className="input"
            value={costCenter}
            maxLength={80}
            onChange={(event) => setCostCenter(event.target.value)}
          />
        </Field>
        <Field label="预警阈值 (%)" htmlFor="budget-threshold">
          <input
            id="budget-threshold"
            className="input"
            type="number"
            min={1}
            max={100}
            value={threshold}
            onChange={(event) => setThreshold(event.target.value)}
          />
        </Field>
        <Field label="币种" htmlFor="budget-currency">
          <select
            id="budget-currency"
            className="input"
            value={currency}
            onChange={(event) => setCurrency(event.target.value as CurrencyCode)}
          >
            {['USD', 'CNY', 'EUR', 'GBP', 'JPY'].map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </Field>
      </form>
    </Modal>
  );
}

function BudgetEntryDialog({
  open,
  projects,
  budgets,
  onClose,
  onSaved,
  onError,
}: {
  open: boolean;
  projects: EnterpriseTabProps['projects'];
  budgets: BudgetSummary[];
  onClose: () => void;
  onSaved: (summary: BudgetSummary, replayed: boolean) => void;
  onError: (message: string) => void;
}) {
  const [projectId, setProjectId] = useState('');
  const [kind, setKind] = useState<'committed' | 'actual' | 'forecast'>('actual');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setProjectId(budgets[0]?.budget.projectId ?? '');
  }, [open, budgets]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!projectId || busy) return;
    setBusy(true);
    try {
      const summary = await api.addBudgetEntry(projectId, {
        kind,
        amountCents: Math.round(Number(amount) * 100),
        note,
        idempotencyKey: crypto.randomUUID(),
      });
      setAmount('');
      setNote('');
      onSaved(summary, summary.replayed);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : '记录失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="记录成本"
      description="只有已设置预算的项目可以记录成本条目。"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            form="budget-entry-form"
            className="btn btn-primary"
            disabled={busy}
          >
            {busy ? <Spinner size={16} /> : <Icon name="plus" size={16} />}
            记录
          </button>
        </>
      }
    >
      <form id="budget-entry-form" className="form-grid" onSubmit={(event) => void submit(event)}>
        <Field label="项目" htmlFor="entry-project">
          <select
            id="entry-project"
            className="input"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            {budgets.map((summary) => (
              <option key={summary.budget.id} value={summary.budget.projectId}>
                {summary.budget.projectName}
              </option>
            ))}
          </select>
        </Field>
        <Field label="类型" htmlFor="entry-kind">
          <select
            id="entry-kind"
            className="input"
            value={kind}
            onChange={(event) => setKind(event.target.value as 'committed' | 'actual' | 'forecast')}
          >
            <option value="actual">实际支出</option>
            <option value="committed">已承诺</option>
            <option value="forecast">预测</option>
          </select>
        </Field>
        <Field label="金额" htmlFor="entry-amount" hint={`可选项目 ${projects.length}`}>
          <input
            id="entry-amount"
            className="input"
            type="number"
            step="0.01"
            required
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </Field>
        <Field label="备注" htmlFor="entry-note">
          <input
            id="entry-note"
            className="input"
            value={note}
            maxLength={500}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
      </form>
      {budgets.length === 0 ? <EnterpriseEmpty>请先为项目设置预算。</EnterpriseEmpty> : null}
      {budgets[0] ? (
        <p className="enterprise-hint">最近更新：{formatDate(budgets[0].budget.updatedAt)}</p>
      ) : null}
    </Modal>
  );
}
