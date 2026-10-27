import { type FormEvent, lazy, Suspense, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PROJECT_STATUS_LABELS } from '../../../shared/permissions.ts';
import { isRangeKey, RANGE_LABELS, rangeLabel } from '../../../shared/ranges.ts';
import type {
  AnalyticsSourceSummary,
  AudienceReport,
  ChannelReport,
  CurrencyCode,
  DateRangeKey,
  Granularity,
  ProjectOverview,
  ProjectStatus,
  ProjectStatusCounts,
  ReportFrequency,
  ReportKind,
  RevenueReport,
  SavedReport,
  SavedReportQuery,
} from '../../../shared/types.ts';
import { api } from '../api.ts';
import { DateRangeSelector, ProjectOverviewWidget } from '../components/DashboardWidgets.tsx';
import { Icon } from '../components/Icon.tsx';
import {
  CardSkeleton,
  cx,
  DemoBadge,
  EmptyState,
  ErrorState,
  Field,
  SegmentedControl,
  Skeleton,
  Spinner,
} from '../components/ui.tsx';
import {
  formatCurrency,
  formatDate,
  formatDateTime,
  formatDelta,
  formatNumber,
  formatPercent,
} from '../format.ts';
import type { ApiState } from '../hooks/useApi.ts';
import { useApi } from '../hooks/useApi.ts';
import { useAuth } from '../hooks/useAuth.tsx';

const RevenueChart = lazy(() => import('../components/RevenueChart.tsx'));
const ChannelDonut = lazy(() => import('../components/ChannelDonut.tsx'));

type Tab = 'overview' | 'sales' | 'audience' | 'reports' | 'data' | 'projects';

const TABS: { value: Tab; label: string }[] = [
  { value: 'overview', label: '总览' },
  { value: 'sales', label: '销售额' },
  { value: 'audience', label: '用户' },
  { value: 'reports', label: '保存报表' },
  { value: 'data', label: '数据源' },
  { value: 'projects', label: '项目' },
];

function parseTab(value: string | null): Tab {
  return value === 'sales' ||
    value === 'audience' ||
    value === 'reports' ||
    value === 'data' ||
    value === 'projects'
    ? value
    : 'overview';
}

function parseGranularity(value: string | null): Granularity | undefined {
  return value === 'day' || value === 'week' || value === 'month' ? value : undefined;
}

const STATUS_KEYS: {
  key: 'planning' | 'active' | 'on_hold' | 'completed' | 'archived';
  status: ProjectStatus;
}[] = [
  { key: 'active', status: 'active' },
  { key: 'planning', status: 'planning' },
  { key: 'on_hold', status: 'on_hold' },
  { key: 'completed', status: 'completed' },
  { key: 'archived', status: 'archived' },
];

export default function AnalyticsPage() {
  const { user, workspace } = useAuth();
  const admin = user?.role === 'admin';
  const [params, setParams] = useSearchParams();
  const tab = parseTab(params.get('tab'));
  const rangeParam = params.get('range');
  const rangeKey: DateRangeKey = isRangeKey(rangeParam) ? rangeParam : '30d';
  const from = params.get('from') ?? undefined;
  const to = params.get('to') ?? undefined;
  const granularity = parseGranularity(params.get('granularity'));
  const compare = params.get('compare') !== '0';

  const update = (patch: Record<string, string | null>) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(patch)) {
          if (value === null || value === '') next.delete(key);
          else next.set(key, value);
        }
        return next;
      },
      { replace: true },
    );
  };

  const revenueState = useApi(
    (signal) =>
      api.revenue(
        {
          range: rangeKey,
          from,
          to,
          granularity,
          compare,
        },
        signal,
      ),
    [rangeKey, from, to, granularity, compare],
    { skip: tab !== 'overview' && tab !== 'sales' },
  );

  const channelState = useApi(
    (signal) => api.channels({ range: rangeKey, from, to }, signal),
    [rangeKey, from, to],
    { skip: tab !== 'overview' && tab !== 'sales' },
  );

  const audienceState = useApi(
    (signal) => api.audience({ range: rangeKey, from, to }, signal),
    [rangeKey, from, to],
    { skip: tab !== 'audience' },
  );

  const projectState = useApi((signal) => api.projectAnalytics(signal), [], {
    skip: tab !== 'projects',
  });

  const rangeText = revenueState.data
    ? rangeLabel(revenueState.data.range)
    : audienceState.data
      ? rangeLabel(audienceState.data.range)
      : RANGE_LABELS[rangeKey];
  const rangeZone = revenueState.data?.range.timezone ?? audienceState.data?.range.timezone;

  return (
    <div className="page analytics-page">
      <header className="page-head">
        <div className="page-head-copy">
          <p className="eyebrow">Analytics</p>
          <h1>分析报表</h1>
          <p className="page-sub">
            收入、渠道与用户指标来自日指标数据源（{rangeText}，支持 CSV 导入），展示币种{' '}
            {workspace?.currency ?? 'USD'}；项目指标来自真实工作区。
          </p>
        </div>
        <div className="page-head-actions">
          <DemoBadge />
          <DateRangeSelector
            value={rangeKey}
            from={from}
            to={to}
            timeZone={rangeZone}
            onChange={(next) =>
              update({
                range: next.key,
                from: next.from ?? null,
                to: next.to ?? null,
                granularity: null,
              })
            }
          />
        </div>
      </header>

      <div className="analytics-tabs">
        <SegmentedControl
          options={TABS}
          value={tab}
          onChange={(next) => update({ tab: next === 'overview' ? null : next })}
          label="分析页签"
        />
      </div>

      <div className="analytics-panel tab-panel" key={tab}>
        {tab === 'overview' ? (
          <OverviewTab revenueState={revenueState} channelState={channelState} compare={compare} />
        ) : null}

        {tab === 'sales' ? (
          <SalesTab
            revenueState={revenueState}
            channelState={channelState}
            compare={compare}
            granularity={granularity}
            exportUrl={api.analyticsExportUrl({
              kind: 'revenue',
              range: rangeKey,
              from,
              to,
              granularity,
              compare,
            })}
            onCompareChange={(next) => update({ compare: next ? null : '0' })}
            onGranularityChange={(next) => update({ granularity: next })}
          />
        ) : null}

        {tab === 'audience' ? (
          <AudienceTab
            state={audienceState}
            exportUrl={api.analyticsExportUrl({ kind: 'audience', range: rangeKey, from, to })}
          />
        ) : null}

        {tab === 'reports' ? (
          <ReportsTab rangeKey={rangeKey} from={from} to={to} granularity={granularity} />
        ) : null}

        {tab === 'data' ? <DataSourcesTab admin={admin} /> : null}

        {tab === 'projects' ? <ProjectsTab state={projectState} /> : null}
      </div>
    </div>
  );
}

type RevenueState = ApiState<RevenueReport>;
type ChannelState = ApiState<ChannelReport>;
type AudienceState = ApiState<AudienceReport>;
type ProjectAnalyticsState = ApiState<{ overview: ProjectOverview; counts: ProjectStatusCounts }>;

function OverviewTab({
  revenueState,
  channelState,
  compare,
}: {
  revenueState: RevenueState;
  channelState: ChannelState;
  compare: boolean;
}) {
  if (revenueState.error && !revenueState.data) {
    return (
      <div className="card card-pad">
        <ErrorState message={revenueState.error} onRetry={revenueState.reload} />
      </div>
    );
  }

  if (!revenueState.data) {
    return (
      <div className="analytics-overview">
        <CardSkeleton rows={3} height={330} />
        <CardSkeleton rows={4} height={330} />
      </div>
    );
  }

  const report = revenueState.data;

  return (
    <>
      <section className="analytics-kpis">
        <article className="card stat-tile">
          <span className="stat-label">周期收入</span>
          <strong className="stat-value">{formatCurrency(report.total)}</strong>
          <span
            className={cx(
              'delta',
              report.delta === null ? 'is-neutral' : report.delta >= 0 ? 'is-up' : 'is-down',
            )}
          >
            {formatDelta(report.delta)}
          </span>
        </article>
        <article className="card stat-tile">
          <span className="stat-label">上期收入</span>
          <strong className="stat-value">
            {report.previousTotal === null ? '—' : formatCurrency(report.previousTotal)}
          </strong>
          <span className="stat-hint">
            对比周期 {report.range.previous.from} ~ {report.range.previous.to}
          </span>
        </article>
        <article className="card stat-tile">
          <span className="stat-label">数据粒度</span>
          <strong className="stat-value">
            {report.granularity === 'day'
              ? '按日'
              : report.granularity === 'week'
                ? '按周'
                : '按月'}
          </strong>
          <span className="stat-hint">
            {report.points.length} 个聚合区间 · {report.range.timezone}
          </span>
        </article>
      </section>

      <div className="analytics-overview">
        <article className="card card-pad">
          <header className="card-head">
            <div>
              <div className="card-title-row">
                <h2>收入趋势</h2>
                <DemoBadge label="Demo" />
              </div>
              <p className="card-sub">
                {rangeLabel(report.range)} ·{' '}
                {report.granularity === 'day'
                  ? '每日'
                  : report.granularity === 'week'
                    ? '每周'
                    : '每月'}
                汇总
              </p>
            </div>
          </header>
          <Suspense
            fallback={
              <div className="chart-skeleton">
                <Skeleton height={280} radius={18} />
              </div>
            }
          >
            <RevenueChart
              points={report.points}
              granularity={report.granularity}
              comparison={compare}
              height={280}
            />
          </Suspense>
        </article>

        <article className="card card-pad">
          <header className="card-head">
            <div>
              <div className="card-title-row">
                <h2>渠道份额</h2>
                <DemoBadge label="Demo" />
              </div>
              <p className="card-sub">会话来源 · 当前周期</p>
            </div>
          </header>
          {channelState.data && channelState.data.channels.length > 0 ? (
            <Suspense fallback={<Skeleton height={210} radius={18} />}>
              <ChannelDonut channels={channelState.data.channels} />
            </Suspense>
          ) : channelState.loading ? (
            <Skeleton height={210} radius={18} />
          ) : (
            <EmptyState icon="analytics" title="暂无渠道数据" compact />
          )}
        </article>
      </div>
    </>
  );
}

function SalesTab({
  revenueState,
  channelState,
  compare,
  granularity,
  exportUrl,
  onCompareChange,
  onGranularityChange,
}: {
  revenueState: RevenueState;
  channelState: ChannelState;
  compare: boolean;
  granularity: Granularity | undefined;
  exportUrl: string;
  onCompareChange: (next: boolean) => void;
  onGranularityChange: (next: Granularity) => void;
}) {
  const report = revenueState.data;
  const activeGranularity = granularity ?? report?.granularity ?? 'day';

  return (
    <>
      <section className="card card-pad">
        <header className="card-head sales-head">
          <div>
            <h2>收入报告</h2>
            <p className="card-sub">
              {report
                ? `${rangeLabel(report.range)} · ${report.granularity === 'day' ? '日' : report.granularity === 'week' ? '周' : '月'}粒度`
                : '加载中…'}
            </p>
          </div>
          <div className="sales-controls">
            <a className="btn btn-ghost btn-sm" href={exportUrl} download>
              <Icon name="download" size={15} />
              导出 CSV
            </a>
            <SegmentedControl
              options={[
                { value: 'day', label: '日' },
                { value: 'week', label: '周' },
                { value: 'month', label: '月' },
              ]}
              value={activeGranularity}
              onChange={onGranularityChange}
              label="聚合粒度"
            />
            <label className="switch">
              <input
                type="checkbox"
                checked={compare}
                onChange={(event) => onCompareChange(event.target.checked)}
              />
              <span className="switch-track" aria-hidden="true" />
              对比上一周期
            </label>
          </div>
        </header>

        {revenueState.loading && !report ? (
          <div className="chart-skeleton">
            <Skeleton height={300} radius={18} />
          </div>
        ) : report ? (
          <>
            <div className="sales-summary">
              <div>
                <span>当前周期</span>
                <strong>{formatCurrency(report.total)}</strong>
              </div>
              <div>
                <span>上一周期</span>
                <strong>
                  {report.previousTotal === null ? '—' : formatCurrency(report.previousTotal)}
                </strong>
              </div>
              <div>
                <span>变化</span>
                <strong
                  className={cx(
                    'delta-text',
                    report.delta === null ? 'is-neutral' : report.delta >= 0 ? 'is-up' : 'is-down',
                  )}
                >
                  {formatDelta(report.delta)}
                </strong>
              </div>
            </div>
            <Suspense
              fallback={
                <div className="chart-skeleton">
                  <Skeleton height={300} radius={18} />
                </div>
              }
            >
              <RevenueChart
                points={report.points}
                granularity={report.granularity}
                comparison={compare}
                height={300}
              />
            </Suspense>

            <div className="table-scroll">
              <table className="data-table compact-table">
                <thead>
                  <tr>
                    <th>区间</th>
                    <th>收入</th>
                    <th>上一周期</th>
                    <th>变化</th>
                  </tr>
                </thead>
                <tbody>
                  {report.points.map((point) => {
                    const delta =
                      point.previous === null || point.previous === 0
                        ? null
                        : ((point.revenue - point.previous) / point.previous) * 100;
                    return (
                      <tr key={point.bucket}>
                        <td>{point.label}</td>
                        <td className="mono">{formatCurrency(point.revenue)}</td>
                        <td className="mono table-muted">
                          {point.previous === null ? '—' : formatCurrency(point.previous)}
                        </td>
                        <td>
                          <span
                            className={cx(
                              'delta',
                              delta === null ? 'is-neutral' : delta >= 0 ? 'is-up' : 'is-down',
                            )}
                          >
                            {formatDelta(delta)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <ErrorState message={revenueState.error ?? '暂无数据'} onRetry={revenueState.reload} />
        )}
      </section>

      <section className="card card-pad">
        <header className="card-head">
          <div>
            <h2>渠道明细</h2>
            <p className="card-sub">与上一周期对比的会话数</p>
          </div>
        </header>
        {channelState.data ? (
          <div className="table-scroll">
            <table className="data-table compact-table">
              <thead>
                <tr>
                  <th>渠道</th>
                  <th>会话</th>
                  <th>份额</th>
                  <th>上一周期</th>
                  <th>变化</th>
                </tr>
              </thead>
              <tbody>
                {channelState.data.channels.map((channel) => (
                  <tr key={channel.channel}>
                    <td>{channel.channel}</td>
                    <td className="mono">{formatNumber(channel.sessions)}</td>
                    <td>{formatPercent(channel.share)}</td>
                    <td className="mono table-muted">
                      {channel.previousSessions === null
                        ? '—'
                        : formatNumber(channel.previousSessions)}
                    </td>
                    <td>
                      <span
                        className={cx(
                          'delta',
                          channel.delta === null
                            ? 'is-neutral'
                            : channel.delta >= 0
                              ? 'is-up'
                              : 'is-down',
                        )}
                      >
                        {formatDelta(channel.delta)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Skeleton height={140} radius={16} />
        )}
      </section>
    </>
  );
}

function AudienceTab({ state, exportUrl }: { state: AudienceState; exportUrl: string }) {
  const report = state.data;

  if (state.error && !report) {
    return (
      <div className="card card-pad">
        <ErrorState message={state.error} onRetry={state.reload} />
      </div>
    );
  }

  if (!report) {
    return <CardSkeleton rows={5} height={320} />;
  }

  return (
    <>
      <section className="analytics-kpis is-four">
        <article className="card stat-tile">
          <span className="stat-label">新增客户</span>
          <strong className="stat-value">{formatNumber(report.customers)}</strong>
          <span
            className={cx(
              'delta',
              report.customerDelta === null
                ? 'is-neutral'
                : report.customerDelta >= 0
                  ? 'is-up'
                  : 'is-down',
            )}
          >
            {formatDelta(report.customerDelta)}
          </span>
        </article>
        <article className="card stat-tile">
          <span className="stat-label">访客</span>
          <strong className="stat-value">{formatNumber(report.visitors)}</strong>
          <span className="stat-hint">同期去重访客</span>
        </article>
        <article className="card stat-tile">
          <span className="stat-label">转化率</span>
          <strong className="stat-value">{formatPercent(report.conversion)}</strong>
          <span
            className={cx(
              'delta',
              report.conversionDelta === null
                ? 'is-neutral'
                : report.conversionDelta >= 0
                  ? 'is-up'
                  : 'is-down',
            )}
          >
            {formatDelta(report.conversionDelta, 'point')}
          </span>
        </article>
        <article className="card stat-tile">
          <span className="stat-label">上期客户</span>
          <strong className="stat-value">
            {report.previousCustomers === null ? '—' : formatNumber(report.previousCustomers)}
          </strong>
          <span className="stat-hint">
            上期转化{' '}
            {report.previousConversion === null ? '—' : formatPercent(report.previousConversion)}
          </span>
        </article>
      </section>

      <section className="card card-pad">
        <header className="card-head">
          <div>
            <div className="card-title-row">
              <h2>每日新增客户</h2>
              <DemoBadge label="Demo" />
            </div>
            <p className="card-sub">{rangeLabel(report.range)} · 单位：人</p>
          </div>
          <a className="btn btn-ghost btn-sm" href={exportUrl} download>
            <Icon name="download" size={15} />
            导出 CSV
          </a>
        </header>
        <Suspense
          fallback={
            <div className="chart-skeleton">
              <Skeleton height={280} radius={18} />
            </div>
          }
        >
          <RevenueChart
            points={report.daily.map((point) => ({
              bucket: point.date,
              label: point.date.slice(5),
              revenue: point.value,
              previous: null,
            }))}
            granularity="day"
            valueFormat="number"
            seriesLabel="新增客户"
            height={280}
          />
        </Suspense>
        <footer className="chart-foot">
          <span className="chart-foot-note">
            转化率 = 转化数 / 访客数；环比使用百分点（pt），基数为 0 时显示 —。
          </span>
        </footer>
      </section>
    </>
  );
}

const REPORT_KIND_LABELS: Record<ReportKind, string> = {
  revenue: '收入',
  channels: '渠道',
  audience: '用户',
};

const REPORT_FREQUENCY_LABELS: Record<ReportFrequency, string> = {
  none: '仅手动导出',
  weekly: '每周邮件',
  monthly: '每月邮件',
};

function ReportsTab({
  rangeKey,
  from,
  to,
  granularity,
}: {
  rangeKey: DateRangeKey;
  from?: string;
  to?: string;
  granularity?: Granularity;
}) {
  const state = useApi((signal) => api.savedReports(signal), [], { live: false });
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ReportKind>('revenue');
  const [frequency, setFrequency] = useState<ReportFrequency>('weekly');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const rangeText =
    rangeKey === 'custom' && from && to ? `${from} ~ ${to}` : RANGE_LABELS[rangeKey];

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('请填写报表名称');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const query: SavedReportQuery = {
        kind,
        range: rangeKey,
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(granularity ? { granularity } : {}),
      };
      await api.createSavedReport({ name: trimmed, query, frequency });
      setName('');
      setNotice('报表已保存');
      state.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (report: SavedReport) => {
    if (!window.confirm(`删除报表「${report.name}」？`)) return;
    setError(null);
    try {
      await api.deleteSavedReport(report.id);
      state.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除失败');
    }
  };

  const reports = state.data?.reports ?? [];

  return (
    <>
      <section className="card card-pad">
        <header className="card-head">
          <div>
            <h2>保存当前报表</h2>
            <p className="card-sub">
              金额按工作区币种展示；选择每周或每月后，CSV 会通过通知邮件附件正文发送给当前账号。
            </p>
          </div>
          <Icon name="download" size={20} />
        </header>
        <form className="form-grid" onSubmit={create}>
          <Field label="报表名称" htmlFor="report-name">
            <input
              id="report-name"
              className="input"
              value={name}
              maxLength={60}
              placeholder="例如：每周收入概览"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="指标" htmlFor="report-kind">
            <select
              id="report-kind"
              className="input"
              value={kind}
              onChange={(event) => setKind(event.target.value as ReportKind)}
            >
              {(Object.keys(REPORT_KIND_LABELS) as ReportKind[]).map((value) => (
                <option key={value} value={value}>
                  {REPORT_KIND_LABELS[value]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="发送频率" htmlFor="report-frequency">
            <select
              id="report-frequency"
              className="input"
              value={frequency}
              onChange={(event) => setFrequency(event.target.value as ReportFrequency)}
            >
              {(Object.keys(REPORT_FREQUENCY_LABELS) as ReportFrequency[]).map((value) => (
                <option key={value} value={value}>
                  {REPORT_FREQUENCY_LABELS[value]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="数据范围" hint="范围取自分析页当前筛选条件">
            <div className="readonly-pill">{rangeText}</div>
          </Field>
          {error ? <p className="field-error form-span-2">{error}</p> : null}
          {notice ? <p className="card-note form-span-2">{notice}</p> : null}
          <div className="form-span-2">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? <Spinner size={16} /> : null}
              保存报表
            </button>
          </div>
        </form>
      </section>

      <section className="card card-pad">
        <header className="card-head">
          <div>
            <h2>我的报表</h2>
            <p className="card-sub">共 {reports.length} 个 · 仅自己可见</p>
          </div>
        </header>
        {state.loading && !state.data ? (
          <Skeleton height={120} radius={16} />
        ) : reports.length === 0 ? (
          <EmptyState icon="analytics" title="还没有保存的报表" compact />
        ) : (
          <div className="table-scroll">
            <table className="data-table compact-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>配置</th>
                  <th>上次运行</th>
                  <th>下次运行</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((report) => (
                  <tr key={report.id}>
                    <td>{report.name}</td>
                    <td className="table-muted">
                      {REPORT_KIND_LABELS[report.query.kind]} · {report.query.range} ·{' '}
                      {REPORT_FREQUENCY_LABELS[report.frequency]}
                    </td>
                    <td className="table-muted">
                      {report.lastRunAt ? formatDateTime(report.lastRunAt) : '—'}
                    </td>
                    <td>{report.nextRunAt ? formatDate(report.nextRunAt) : '不自动发送'}</td>
                    <td>
                      <div className="table-actions">
                        <a
                          className="btn btn-ghost btn-xs"
                          href={api.reportExportUrl(report.id)}
                          download
                        >
                          <Icon name="download" size={14} />
                          导出
                        </a>
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs"
                          onClick={() => void remove(report)}
                        >
                          <Icon name="trash" size={14} />
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function DataSourcesTab({ admin }: { admin: boolean }) {
  const state = useApi((signal) => api.analyticsSources(signal), [], { live: false });
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    imported: number;
    skipped: number;
    errors: { row: number; message: string }[];
  } | null>(null);

  const upload = async (event: FormEvent) => {
    event.preventDefault();
    const file = fileInput.current?.files?.[0];
    if (!file) {
      setError('请选择 CSV 或 JSON 文件');
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.importMetrics(file));
      if (fileInput.current) fileInput.current.value = '';
      state.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '导入失败');
    } finally {
      setBusy(false);
    }
  };

  const sources = state.data?.sources ?? [];
  const currency: CurrencyCode = state.data?.currency ?? 'USD';

  return (
    <>
      <section className="card card-pad">
        <header className="card-head">
          <div>
            <h2>数据源覆盖</h2>
            <p className="card-sub">
              当前展示币种 {currency} · 收入以美元为基准入库后按工作区汇率换算
            </p>
          </div>
          <Icon name="database" size={20} />
        </header>
        {state.loading && !state.data ? (
          <Skeleton height={120} radius={16} />
        ) : sources.length === 0 ? (
          <EmptyState icon="analytics" title="尚无可用的日指标" compact />
        ) : (
          <div className="table-scroll">
            <table className="data-table compact-table">
              <thead>
                <tr>
                  <th>数据源</th>
                  <th>天数</th>
                  <th>覆盖范围</th>
                  <th>收入</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((source: AnalyticsSourceSummary) => (
                  <tr key={source.source}>
                    <td>
                      <span
                        className="badge"
                        data-tone={source.source === 'seed' ? 'demo' : 'success'}
                      >
                        {source.source === 'seed'
                          ? '内置种子'
                          : source.source === 'csv'
                            ? 'CSV 导入'
                            : source.source === 'api'
                              ? 'API 写入'
                              : source.source}
                      </span>
                    </td>
                    <td className="mono">{source.days}</td>
                    <td className="mono table-muted">
                      {source.from} ~ {source.to}
                    </td>
                    <td className="mono">{formatCurrency(source.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="card-note">
          同一日期的数据会被后一次导入覆盖；演示数据集仅用于展示，可在生产环境通过 CSV 或 API
          写入真实指标。
        </p>
      </section>

      {admin ? (
        <section className="card card-pad">
          <header className="card-head">
            <div>
              <h2>导入日指标</h2>
              <p className="card-sub">支持 CSV / JSON，单次最多 366 行、文件不超过 2MB</p>
            </div>
            <Icon name="download" size={20} />
          </header>
          <form className="form-grid" onSubmit={upload}>
            <Field
              label="指标文件"
              htmlFor="metrics-file"
              hint="列：date,revenue,customers,conversions,visitors[,currency]"
            >
              <input
                id="metrics-file"
                ref={fileInput}
                className="input"
                type="file"
                accept=".csv,.json,text/csv,application/json"
              />
            </Field>
            {error ? <p className="field-error">{error}</p> : null}
            {result ? (
              <div className="form-span-2">
                <p className="card-note">
                  已导入 {result.imported} 行，跳过 {result.skipped} 行。
                </p>
                {result.errors.length > 0 ? (
                  <ul className="info-list">
                    {result.errors.slice(0, 10).map((issue) => (
                      <li key={`${issue.row}-${issue.message}`}>
                        <span>
                          第 {issue.row} 行：{issue.message}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            <div className="form-span-2">
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? <Spinner size={16} /> : null}
                上传并导入
              </button>
            </div>
          </form>
        </section>
      ) : null}
    </>
  );
}

function ProjectsTab({ state }: { state: ProjectAnalyticsState }) {
  const data = state.data;

  if (state.error && !data) {
    return (
      <div className="card card-pad">
        <ErrorState message={state.error} onRetry={state.reload} />
      </div>
    );
  }

  if (!data) return <CardSkeleton rows={5} height={340} />;

  const total = Math.max(1, data.overview.total);

  return (
    <div className="analytics-projects">
      <section className="card card-pad">
        <header className="card-head">
          <div>
            <h2>项目完成度</h2>
            <p className="card-sub">基于你可见范围内的 {data.overview.total} 个项目</p>
          </div>
          <Link to="/projects" className="btn btn-ghost btn-sm">
            前往 Projects
            <Icon name="arrowRight" size={15} />
          </Link>
        </header>
        <ProjectOverviewWidget overview={data.overview} />
      </section>

      <section className="card card-pad">
        <header className="card-head">
          <div>
            <h2>状态分布</h2>
            <p className="card-sub">按项目状态统计占比</p>
          </div>
        </header>
        <ul className="status-bars">
          {STATUS_KEYS.map(({ status, key }) => {
            const count = data.counts[key];
            const share = Math.round((count / total) * 100);
            return (
              <li key={status}>
                <div className="status-bar-head">
                  <Link to={`/projects?status=${status}`}>{PROJECT_STATUS_LABELS[status]}</Link>
                  <span>
                    {count} · {share}%
                  </span>
                </div>
                <div className="status-bar-track">
                  <span data-status={status} style={{ width: `${share}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
        <p className="card-note">
          项目数据来自真实的 Project 表；Demo 示例项目带有 Demo
          标记，可通过导入/创建产生新的真实数据。
        </p>
      </section>
    </div>
  );
}
