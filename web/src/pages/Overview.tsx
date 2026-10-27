import { lazy, Suspense, useState } from 'react';
import { Link } from 'react-router-dom';
import { RANGE_LABELS, rangeLabel } from '../../../shared/ranges.ts';
import type { DateRangeKey } from '../../../shared/types.ts';
import { api } from '../api.ts';
import {
  ActivityFeed,
  DateRangeSelector,
  KpiCard,
  ProjectOverviewWidget,
} from '../components/DashboardWidgets.tsx';
import { Icon } from '../components/Icon.tsx';
import {
  CardSkeleton,
  cx,
  DemoBadge,
  EmptyState,
  ErrorState,
  Skeleton,
} from '../components/ui.tsx';
import { greeting } from '../format.ts';
import { useApi } from '../hooks/useApi.ts';
import { useAuth } from '../hooks/useAuth.tsx';

const RevenueChart = lazy(() => import('../components/RevenueChart.tsx'));
const ChannelDonut = lazy(() => import('../components/ChannelDonut.tsx'));

type Selection = { key: DateRangeKey; from?: string; to?: string };

export default function OverviewPage() {
  const { user, preferences, demo } = useAuth();
  const [selection, setSelection] = useState<Selection>(() => {
    const preferred = preferences?.defaultRange;
    return { key: preferred && preferred !== 'custom' ? preferred : '30d' };
  });

  const state = useApi(
    (signal) =>
      api.summary(
        {
          range: selection.key,
          from: selection.from,
          to: selection.to,
        },
        signal,
      ),
    [selection.key, selection.from, selection.to],
  );

  const data = state.data;
  const showSkeleton = state.loading && !data;
  const rangeText = data ? rangeLabel(data.range) : RANGE_LABELS[selection.key];

  return (
    <div className="page overview-page">
      <header className="page-head">
        <div className="page-head-copy">
          <p className="eyebrow">Overview</p>
          <h1>
            {greeting()}，{user?.name ?? '你好'}
          </h1>
          <p className="page-sub">
            这是团队的实时脉搏。
            {data ? (
              <>
                当前查看 <strong>{rangeText}</strong>（{data.range.from} ~ {data.range.to}，
                {data.range.timezone}）。
              </>
            ) : (
              '正在汇总最新数据…'
            )}
          </p>
        </div>
        <div className="page-head-actions">
          {demo ? <DemoBadge /> : null}
          <DateRangeSelector
            value={selection.key}
            from={selection.from ?? data?.range.from}
            to={selection.to ?? data?.range.to}
            timeZone={data?.range.timezone}
            onChange={setSelection}
          />
          <button
            type="button"
            className="btn btn-icon btn-ghost"
            onClick={state.reload}
            aria-label="刷新数据"
            title="刷新数据"
          >
            <Icon name="refresh" size={18} />
          </button>
        </div>
      </header>

      {state.error && data ? (
        <div className="inline-alert" role="status">
          <Icon name="alert" size={16} />
          刷新失败：{state.error}，正在展示上次成功的数据。
        </div>
      ) : null}

      <section className="kpi-grid" aria-label="关键指标">
        {showSkeleton ? (
          <>
            <CardSkeleton rows={2} height={188} />
            <CardSkeleton rows={2} height={188} />
            <CardSkeleton rows={2} height={188} />
          </>
        ) : data ? (
          <>
            <KpiCard
              kind="revenue"
              label="收入"
              hint="选定周期 · 每日收入合计"
              kpi={data.kpis.revenue}
            />
            <KpiCard
              kind="customers"
              label="新增客户"
              hint="选定周期 · 付费客户数"
              kpi={data.kpis.customers}
            />
            <KpiCard
              kind="conversion"
              label="转化率"
              hint="转化 / 访客 · 百分点对比"
              kpi={data.kpis.conversion}
            />
          </>
        ) : (
          <div className="card card-pad kpi-error-span">
            <ErrorState message={state.error ?? '暂无数据'} onRetry={state.reload} />
          </div>
        )}
      </section>

      {data ? (
        <p className="demo-footnote">
          <Icon name="database" size={14} />
          收入、客户与渠道数据来自内置演示数据集（{data.range.days}{' '}
          天）；项目与活动来自真实操作记录。
        </p>
      ) : null}

      <section className="overview-main">
        <article className="card card-pad revenue-card">
          <header className="card-head">
            <div>
              <div className="card-title-row">
                <h2>收入趋势</h2>
                {demo ? <DemoBadge label="Demo" /> : null}
              </div>
              <p className="card-sub">
                {rangeText} · 单位 USD · 每日汇总
                {data
                  ? ` · 较上期 ${data.kpis.revenue.delta === null ? '—' : `${data.kpis.revenue.delta > 0 ? '+' : ''}${data.kpis.revenue.delta}%`}`
                  : ''}
              </p>
            </div>
            <Link to="/analytics" className="btn btn-ghost btn-sm">
              详细分析
              <Icon name="arrowRight" size={15} />
            </Link>
          </header>

          {showSkeleton ? (
            <div className="chart-skeleton">
              <Skeleton height={220} radius={18} />
            </div>
          ) : data ? (
            <Suspense
              fallback={
                <div className="chart-skeleton">
                  <Skeleton height={264} radius={18} />
                </div>
              }
            >
              <RevenueChart
                points={data.revenue.map((point) => ({
                  bucket: point.date,
                  label: point.date.slice(5),
                  revenue: point.revenue,
                  previous: null,
                }))}
                granularity="day"
              />
            </Suspense>
          ) : (
            <ErrorState compact message={state.error ?? '暂无收入数据'} onRetry={state.reload} />
          )}

          <footer className="chart-foot">
            <span>
              <span className="legend-swatch" style={{ background: '#8065E9' }} />
              每日收入
            </span>
            <span className="chart-foot-note">
              数据按工作区时区日边界聚合{data ? `（${data.range.timezone}）` : ''}
            </span>
          </footer>
        </article>

        <article className="card card-pad channel-card">
          <header className="card-head">
            <div>
              <div className="card-title-row">
                <h2>渠道表现</h2>
                {demo ? <DemoBadge label="Demo" /> : null}
              </div>
              <p className="card-sub">会话来源份额 · 选定周期</p>
            </div>
          </header>

          {showSkeleton ? (
            <div className="donut-skeleton">
              <Skeleton height={180} width={180} radius={90} />
              <Skeleton height={12} width="70%" />
              <Skeleton height={12} width="58%" />
            </div>
          ) : data && data.channels.length > 0 ? (
            <Suspense
              fallback={
                <div className="donut-skeleton">
                  <Skeleton height={180} width={180} radius={90} />
                </div>
              }
            >
              <ChannelDonut channels={data.channels} />
            </Suspense>
          ) : (
            <EmptyState
              icon="analytics"
              title="暂无渠道数据"
              description="选定范围内没有会话记录。"
              compact
            />
          )}
        </article>
      </section>

      <section className="overview-secondary">
        <article className="card card-pad">
          <header className="card-head">
            <div>
              <h2>项目概览</h2>
              <p className="card-sub">你可见范围内的项目进度</p>
            </div>
            <Link to="/projects" className="btn btn-ghost btn-sm">
              全部项目
              <Icon name="arrowRight" size={15} />
            </Link>
          </header>
          {showSkeleton ? (
            <div className="project-overview-skeleton">
              <Skeleton height={148} width={148} radius={74} />
              <div className="project-overview-skeleton-lines">
                <Skeleton height={13} width="80%" />
                <Skeleton height={13} width="70%" />
                <Skeleton height={13} width="76%" />
              </div>
            </div>
          ) : data ? (
            <ProjectOverviewWidget overview={data.projects} />
          ) : (
            <ErrorState compact message={state.error ?? '暂无项目数据'} onRetry={state.reload} />
          )}
        </article>

        <article className="card card-pad activity-card">
          <header className="card-head">
            <div>
              <h2>近期活动</h2>
              <p className="card-sub">实时同步自团队操作</p>
            </div>
            <Link to="/activity" className="btn btn-ghost btn-sm">
              全部动态
              <Icon name="arrowRight" size={15} />
            </Link>
          </header>
          {showSkeleton ? (
            <div className="activity-skeleton">
              {[0, 1, 2, 3].map((index) => (
                <div key={index} className={cx('activity-skeleton-row')}>
                  <Skeleton height={34} width={34} radius={12} />
                  <div className="activity-skeleton-lines">
                    <Skeleton height={12} width={`${78 - index * 8}%`} />
                    <Skeleton height={10} width="42%" />
                  </div>
                </div>
              ))}
            </div>
          ) : data ? (
            <ActivityFeed activities={data.activities} compact />
          ) : (
            <ErrorState compact message={state.error ?? '暂无活动'} onRetry={state.reload} />
          )}
        </article>
      </section>

      {data ? (
        <footer className="runtime-strip">
          <span>
            <Icon name="server" size={14} />
            Node {data.runtime.node}
          </span>
          <span>
            <Icon name="database" size={14} />
            SQLite {data.runtime.sqlite}
          </span>
          <span>
            <Icon name="clock" size={14} />
            运行 {Math.floor(data.runtime.uptime / 60)} 分钟
          </span>
          <span className="runtime-spacer" />
          <span className="runtime-updated">
            {state.lastUpdated ? `更新于 ${state.lastUpdated.toLocaleTimeString('zh-CN')}` : ''}
          </span>
        </footer>
      ) : null}
    </div>
  );
}
