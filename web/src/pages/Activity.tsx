import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ACTIVITY_TYPES } from '../../../shared/activity.ts';
import type { ActivityItem as ActivityItemType } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { ActivityFeed } from '../components/DashboardWidgets.tsx';
import { Icon } from '../components/Icon.tsx';
import { cx, EmptyState, ErrorState, Skeleton, Toaster } from '../components/ui.tsx';
import { useApi, useToast } from '../hooks/useApi.ts';
import { activityLabel, useLocale } from '../i18n.ts';

export default function ActivityPage() {
  const { t } = useLocale();
  const [params, setParams] = useSearchParams();
  const type = params.get('type') ?? 'all';
  const filters = [
    { value: 'all', label: t('activity.all') },
    ...ACTIVITY_TYPES.map((activityType) => ({
      value: activityType as string,
      label: activityLabel(activityType),
    })),
  ];
  const [extras, setExtras] = useState<ActivityItemType[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const { toasts, show, dismiss } = useToast();
  const typeRef = useRef(type);
  typeRef.current = type;

  const state = useApi(
    (signal) => api.activities({ type: type === 'all' ? undefined : type, limit: 20 }, signal),
    [type],
  );

  const base = state.data?.activities ?? [];
  const seen = new Set<number>();
  const items = [...base, ...extras].filter((item) => {
    if (seen.has(item.seq)) return false;
    seen.add(item.seq);
    return true;
  });
  const nextCursor = cursor ?? state.data?.nextCursor ?? null;

  const changeFilter = (value: string) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value === 'all') next.delete('type');
        else next.set('type', value);
        return next;
      },
      { replace: true },
    );
    setExtras([]);
    setCursor(null);
  };

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    const requestedType = type;
    setLoadingMore(true);
    try {
      const page = await api.activities({
        type: requestedType === 'all' ? undefined : requestedType,
        cursor: nextCursor,
        limit: 20,
      });
      if (typeRef.current !== requestedType) return;
      setExtras((current) => [...current, ...page.activities]);
      setCursor(page.nextCursor);
    } catch (cause) {
      if (typeRef.current !== requestedType) return;
      show(cause instanceof Error ? cause.message : '加载失败', 'error');
    } finally {
      if (typeRef.current === requestedType) setLoadingMore(false);
    }
  };

  return (
    <div className="page activity-page">
      <header className="page-head">
        <div className="page-head-copy">
          <p className="eyebrow">Activity</p>
          <h1>团队动态</h1>
          <p className="page-sub">按时间倒序展示你可见范围内的项目与成员操作，新动态会实时出现。</p>
        </div>
        <div className="page-head-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setExtras([]);
              setCursor(null);
              state.reload();
            }}
          >
            <Icon name="refresh" size={16} />
            刷新
          </button>
        </div>
      </header>

      <div className="filter-scroll" role="group" aria-label="按类型筛选">
        {filters.map((filter) => (
          <button
            key={filter.value}
            type="button"
            className={cx('filter-chip', type === filter.value && 'is-active')}
            onClick={() => changeFilter(filter.value)}
            aria-pressed={type === filter.value}
          >
            {filter.label}
          </button>
        ))}
      </div>

      <section className="card card-pad activity-page-card">
        <header className="card-head">
          <div>
            <h2>
              {type === 'all'
                ? t('activity.title.all')
                : filters.find((filter) => filter.value === type)?.label}
            </h2>
            <p className="card-sub">
              {state.lastUpdated
                ? `更新于 ${state.lastUpdated.toLocaleTimeString('zh-CN')}`
                : '正在加载…'}
            </p>
          </div>
          <span className="count-pill">
            {items.length}
            {nextCursor ? '+' : ''}
          </span>
        </header>

        {state.loading && !state.data ? (
          <div className="activity-skeleton">
            {[0, 1, 2, 3, 4].map((index) => (
              <div key={index} className="activity-skeleton-row">
                <Skeleton height={38} width={38} radius={13} />
                <div className="activity-skeleton-lines">
                  <Skeleton height={12} width={`${82 - index * 7}%`} />
                  <Skeleton height={10} width="36%" />
                </div>
              </div>
            ))}
          </div>
        ) : state.error && !state.data ? (
          <ErrorState message={state.error} onRetry={state.reload} />
        ) : items.length === 0 ? (
          <EmptyState
            icon="activity"
            title="没有符合条件的动态"
            description="尝试切换筛选条件，或创建/更新一个项目。"
            compact
          />
        ) : (
          <>
            <ActivityFeed activities={items} />
            {nextCursor ? (
              <button
                type="button"
                className="btn btn-soft load-more"
                onClick={() => void loadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? <span className="spinner" /> : <Icon name="chevronDown" size={16} />}
                {loadingMore ? '加载中…' : '加载更早的动态'}
              </button>
            ) : (
              <p className="feed-end">已经到达动态的起点</p>
            )}
          </>
        )}
      </section>

      <Toaster toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
