import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { PROJECT_STATUS_LABELS } from '../../../shared/permissions.ts';
import { RANGE_KEYS } from '../../../shared/ranges.ts';
import type {
  ActivityItem,
  ActivityType,
  DateRangeKey,
  KpiValue,
  ProjectOverview,
  SparkPoint,
} from '../../../shared/types.ts';
import { formatCurrency, formatDelta, formatNumber, formatPercent, timeAgo } from '../format.ts';
import { Icon, type IconName, IconTile, type Tone } from './Icon.tsx';
import { cx, EmptyState } from './ui.tsx';

type RangeSelection = {
  key: DateRangeKey;
  from?: string;
  to?: string;
};

export function DateRangeSelector({
  value,
  from,
  to,
  timeZone,
  onChange,
}: {
  value: DateRangeKey;
  from?: string;
  to?: string;
  timeZone?: string;
  onChange: (next: RangeSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState(from ?? '');
  const [draftTo, setDraftTo] = useState(to ?? '');
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const presets = RANGE_KEYS.filter((key) => key !== 'custom');

  return (
    <div className="range-picker">
      <div className="range-presets">
        {presets.map((key) => (
          <button
            key={key}
            type="button"
            className={cx('range-chip', value === key && 'is-active')}
            onClick={() => onChange({ key })}
            aria-pressed={value === key}
          >
            {key === 'today'
              ? '今日'
              : key === '7d'
                ? '7 天'
                : key === '30d'
                  ? '30 天'
                  : key === 'month'
                    ? '本月'
                    : '上月'}
          </button>
        ))}
        <button
          type="button"
          className={cx('range-chip', value === 'custom' && 'is-active')}
          onClick={() => {
            setDraftFrom(from ?? '');
            setDraftTo(to ?? '');
            setOpen((current) => !current);
          }}
          aria-expanded={open}
        >
          <Icon name="calendar" size={14} />
          自定义
        </button>
      </div>

      {open ? (
        <div className="range-popover" ref={panelRef}>
          <div className="range-popover-fields">
            <label>
              开始
              <input
                type="date"
                className="input"
                value={draftFrom}
                max={draftTo || undefined}
                onChange={(event) => setDraftFrom(event.target.value)}
              />
            </label>
            <label>
              结束
              <input
                type="date"
                className="input"
                value={draftTo}
                min={draftFrom || undefined}
                onChange={(event) => setDraftTo(event.target.value)}
              />
            </label>
          </div>
          <p className="range-hint">工作区时区{timeZone ? `（${timeZone}）` : ''}，最多 366 天</p>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!draftFrom || !draftTo || draftFrom > draftTo}
            onClick={() => {
              onChange({ key: 'custom', from: draftFrom, to: draftTo });
              setOpen(false);
            }}
          >
            应用范围
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Sparkline({ points, tone }: { points: SparkPoint[]; tone: string }) {
  const gradientId = useId();
  if (points.length < 2) return null;
  const width = 132;
  const height = 42;
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = width / (points.length - 1);
  const coords = points.map((point, index) => {
    const x = index * step;
    const y = height - 5 - ((point.value - min) / span) * (height - 12);
    return [Math.round(x * 100) / 100, Math.round(y * 100) / 100] as const;
  });
  const line = coords.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x},${y}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;

  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="趋势迷你图"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={tone} stopOpacity="0.32" />
          <stop offset="100%" stopColor={tone} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path
        d={line}
        fill="none"
        stroke={tone}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const KPI_TONES = {
  revenue: { tone: '#8065E9', icon: 'trend' as IconName, tile: 'lilac' as Tone },
  customers: { tone: '#65B99C', icon: 'users' as IconName, tile: 'mint' as Tone },
  conversion: { tone: '#F19A7D', icon: 'spark' as IconName, tile: 'peach' as Tone },
};

export function KpiCard({
  kind,
  label,
  hint,
  kpi,
}: {
  kind: keyof typeof KPI_TONES;
  label: string;
  hint: string;
  kpi: KpiValue;
}) {
  const meta = KPI_TONES[kind];
  const value =
    kpi.format === 'currency'
      ? formatCurrency(kpi.value)
      : kpi.format === 'percent'
        ? formatPercent(kpi.value)
        : formatNumber(kpi.value);
  const positive = kpi.delta !== null && kpi.delta >= 0;
  const unit = kpi.format === 'percent' ? 'point' : 'percent';

  return (
    <article className="card kpi-card">
      <div className="kpi-head">
        <IconTile name={meta.icon} tone={meta.tile} size={44} />
        <div className="kpi-labels">
          <p className="kpi-label">{label}</p>
          <p className="kpi-hint">{hint}</p>
        </div>
      </div>
      <div className="kpi-value-row">
        <strong className="kpi-value">{value}</strong>
        <span
          className={cx(
            'delta',
            kpi.delta === null ? 'is-neutral' : positive ? 'is-up' : 'is-down',
          )}
        >
          {kpi.delta === null ? null : <Icon name={positive ? 'arrowUp' : 'arrowDown'} size={13} />}
          {formatDelta(kpi.delta, unit)}
        </span>
      </div>
      <div className="kpi-foot">
        <span className="kpi-compare">
          较上期{' '}
          {kpi.previous === null
            ? '—'
            : kpi.format === 'currency'
              ? formatCurrency(kpi.previous)
              : kpi.format === 'percent'
                ? formatPercent(kpi.previous)
                : formatNumber(kpi.previous)}
        </span>
        <Sparkline points={kpi.sparkline} tone={meta.tone} />
      </div>
    </article>
  );
}

const STATUS_ROWS: {
  key: keyof ProjectOverview;
  label: string;
  tone: 'lilac' | 'mint' | 'peach' | 'sky' | 'stone';
}[] = [
  { key: 'active', label: PROJECT_STATUS_LABELS.active, tone: 'lilac' },
  { key: 'planning', label: PROJECT_STATUS_LABELS.planning, tone: 'sky' },
  { key: 'onHold', label: PROJECT_STATUS_LABELS.on_hold, tone: 'peach' },
  { key: 'completed', label: PROJECT_STATUS_LABELS.completed, tone: 'mint' },
  { key: 'archived', label: PROJECT_STATUS_LABELS.archived, tone: 'stone' },
];

export function ProjectOverviewWidget({ overview }: { overview: ProjectOverview }) {
  const completion = Math.round(overview.completion);
  return (
    <div className="project-overview">
      <div
        className="progress-ring"
        style={{ background: `conic-gradient(#8065E9 ${completion * 3.6}deg, #EFECF9 0deg)` }}
        role="img"
        aria-label={`整体完成度 ${completion}%`}
      >
        <div className="progress-ring-inner">
          <strong>{completion}%</strong>
          <span>整体完成度</span>
        </div>
      </div>
      <div className="project-overview-body">
        <div className="project-overview-total">
          <strong>{overview.total}</strong>
          <span>个可见项目</span>
        </div>
        <ul className="status-list">
          {STATUS_ROWS.map((row) => (
            <li key={row.key}>
              <Link to={`/projects?status=${row.key === 'onHold' ? 'on_hold' : row.key}`}>
                <span className="status-dot" data-tone={row.tone} />
                {row.label}
                <strong>{overview[row.key]}</strong>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export const ACTIVITY_META: Record<ActivityType, { icon: IconName; tone: Tone }> = {
  'project.created': { icon: 'plus', tone: 'mint' },
  'project.updated': { icon: 'edit', tone: 'sky' },
  'project.status_changed': { icon: 'refresh', tone: 'lilac' },
  'project.completed': { icon: 'check', tone: 'mint' },
  'project.archived': { icon: 'folder', tone: 'stone' },
  'project.restored': { icon: 'refresh', tone: 'peach' },
  'project.deleted': { icon: 'trash', tone: 'coral' },
  'project.member_added': { icon: 'userPlus', tone: 'lilac' },
  'project.member_removed': { icon: 'users', tone: 'peach' },
  'project.imported': { icon: 'upload', tone: 'sky' },
  'project.template_applied': { icon: 'rocket', tone: 'mint' },
  'project.duplicated': { icon: 'projects', tone: 'peach' },
  'task.created': { icon: 'plus', tone: 'mint' },
  'task.updated': { icon: 'edit', tone: 'sky' },
  'task.completed': { icon: 'check', tone: 'mint' },
  'task.reopened': { icon: 'refresh', tone: 'peach' },
  'task.deleted': { icon: 'trash', tone: 'coral' },
  'milestone.created': { icon: 'rocket', tone: 'lilac' },
  'milestone.deleted': { icon: 'trash', tone: 'stone' },
  'comment.created': { icon: 'mail', tone: 'sky' },
  'comment.deleted': { icon: 'trash', tone: 'coral' },
  'user.created': { icon: 'userPlus', tone: 'mint' },
  'user.role_changed': { icon: 'shield', tone: 'lemon' },
  'user.disabled': { icon: 'lock', tone: 'coral' },
  'user.enabled': { icon: 'key', tone: 'mint' },
  'user.password_changed': { icon: 'lock', tone: 'lilac' },
};

export function ActivityFeed({
  activities,
  compact = false,
}: {
  activities: ActivityItem[];
  compact?: boolean;
}) {
  if (activities.length === 0) {
    return (
      <EmptyState
        icon="activity"
        title="暂无活动"
        description="创建或更新项目后，这里会实时显示团队动态。"
        compact
      />
    );
  }

  return (
    <ol className={cx('activity-feed', compact && 'is-compact')}>
      {activities.map((item) => {
        const meta = ACTIVITY_META[item.type] ?? { icon: 'activity', tone: 'stone' };
        return (
          <li key={item.seq} className="activity-item">
            <span className="activity-rail" aria-hidden="true" />
            <IconTile name={meta.icon} tone={meta.tone} size={compact ? 34 : 38} />
            <div className="activity-content">
              <p className="activity-message">
                {item.project ? (
                  <Link to={`/projects/${item.project.id}`} className="activity-project">
                    {item.project.name}
                  </Link>
                ) : null}
                <span>{item.message}</span>
              </p>
              <p className="activity-meta">
                {item.actor?.name ?? '系统'}
                <span aria-hidden="true">·</span>
                <time dateTime={item.createdAt}>{timeAgo(item.createdAt)}</time>
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
