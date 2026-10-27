import { useEffect, useState } from 'react';
import { AUDIT_CATEGORY_LABELS, auditActionLabel, auditCategory } from '../../../shared/audit.ts';
import { type AuditQuery, api } from '../api.ts';
import { Icon } from '../components/Icon.tsx';
import {
  ConfirmDialog,
  cx,
  EmptyState,
  ErrorState,
  Pagination,
  Skeleton,
  Toaster,
} from '../components/ui.tsx';
import { formatDateTime } from '../format.ts';
import { useApi, useDebounced, useToast } from '../hooks/useApi.ts';

const PAGE_SIZE = 20;

export default function AuditPage() {
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 300);
  const [action, setAction] = useState('all');
  const [actor, setActor] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const { toasts, show, dismiss } = useToast();

  const state = useApi(
    (signal) =>
      api.audit(
        {
          q: debounced || undefined,
          action,
          actor,
          from: from || undefined,
          to: to || undefined,
          page,
          pageSize: PAGE_SIZE,
        },
        signal,
      ),
    [debounced, action, actor, from, to, page],
  );
  const people = useApi((signal) => api.userOptions(signal), []);

  useEffect(() => {
    setPage(1);
  }, [debounced, action, actor, from, to]);

  const data = state.data;
  const filters: AuditQuery = {
    q: debounced || undefined,
    action,
    actor,
    from: from || undefined,
    to: to || undefined,
  };
  const filtered = Boolean(debounced || action !== 'all' || actor !== 'all' || from || to);

  const resetFilters = () => {
    setSearch('');
    setAction('all');
    setActor('all');
    setFrom('');
    setTo('');
  };

  const cleanup = async () => {
    if (cleaning) return;
    setCleaning(true);
    try {
      const result = await api.cleanupAudit();
      show(`已清理 ${result.removed} 条早于 ${result.days} 天的日志`);
      setConfirmCleanup(false);
      state.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '清理失败', 'error');
    } finally {
      setCleaning(false);
    }
  };

  return (
    <div className="page audit-page">
      <header className="page-head">
        <div className="page-head-copy">
          <p className="eyebrow">Audit</p>
          <h1>审计中心</h1>
          <p className="page-sub">
            查看登录、成员、项目与偏好变更的完整记录；仅管理员可访问，日志按保留期自动裁剪。
          </p>
        </div>
        <div className="page-head-actions">
          <a className="btn btn-ghost" href={api.auditExportUrl(filters)} download>
            <Icon name="download" size={16} />
            导出 CSV
          </a>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setConfirmCleanup(true)}
            disabled={!data}
          >
            <Icon name="trash" size={16} />
            清理过期日志
          </button>
        </div>
      </header>

      <section className="card audit-toolbar">
        <div className="project-toolbar-row">
          <div className="search-inline">
            <Icon name="search" size={16} />
            <input
              type="search"
              value={search}
              placeholder="搜索动作、对象、成员或详情…"
              aria-label="搜索审计日志"
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div className="toolbar-controls">
            <select
              className="input input-sm"
              value={action}
              aria-label="按操作筛选"
              onChange={(event) => setAction(event.target.value)}
            >
              <option value="all">全部操作</option>
              {(data?.actions ?? []).map((entry) => (
                <option key={entry.action} value={entry.action}>
                  {auditActionLabel(entry.action)}（{entry.count}）
                </option>
              ))}
            </select>
            <select
              className="input input-sm"
              value={actor}
              aria-label="按操作者筛选"
              onChange={(event) => setActor(event.target.value)}
            >
              <option value="all">全部操作者</option>
              {(people.data?.users ?? []).map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
            <label className="audit-date-field">
              <span>起</span>
              <input
                type="date"
                className="input input-sm"
                value={from}
                aria-label="开始日期"
                max={to || undefined}
                onChange={(event) => setFrom(event.target.value)}
              />
            </label>
            <label className="audit-date-field">
              <span>止</span>
              <input
                type="date"
                className="input input-sm"
                value={to}
                aria-label="结束日期"
                min={from || undefined}
                onChange={(event) => setTo(event.target.value)}
              />
            </label>
          </div>
        </div>
        {data ? (
          <div className="user-counts audit-meta">
            <span>
              共 <strong>{data.total}</strong> 条
            </span>
            <span>
              操作类型 <strong>{data.actions.length}</strong>
            </span>
            <span>
              单条上限 <strong>{data.retention.maxRows}</strong> 条
            </span>
            <span>
              保留期 <strong>{data.retention.days}</strong> 天
            </span>
            {filtered ? (
              <button type="button" className="link-button" onClick={resetFilters}>
                清除筛选
              </button>
            ) : null}
          </div>
        ) : null}
      </section>

      {state.error && !data ? (
        <div className="card card-pad">
          <ErrorState message={state.error} onRetry={state.reload} />
        </div>
      ) : null}

      {!data && state.loading ? (
        <div className="card card-pad table-skeleton" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((index) => (
            <div key={index} className="table-skeleton-row">
              <Skeleton height={12} width="20%" />
              <Skeleton height={12} width="16%" />
              <Skeleton height={12} width="18%" />
              <Skeleton height={12} width="12%" />
            </div>
          ))}
        </div>
      ) : null}

      {data && data.entries.length === 0 ? (
        <div className="card card-pad">
          <EmptyState
            icon="shield"
            title="没有匹配的审计记录"
            description="调整筛选条件或时间范围后再试。"
            compact
            action={
              filtered ? (
                <button type="button" className="btn btn-soft btn-sm" onClick={resetFilters}>
                  清除筛选
                </button>
              ) : undefined
            }
          />
        </div>
      ) : null}

      {data && data.entries.length > 0 ? (
        <div className="card table-card">
          <table className="data-table audit-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>操作</th>
                <th>操作者</th>
                <th>对象</th>
                <th>IP</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((entry) => (
                <tr key={entry.seq} className="audit-row" data-action={entry.action}>
                  <td className="table-muted audit-time">{formatDateTime(entry.createdAt)}</td>
                  <td>
                    <span
                      className={cx('audit-badge', `is-${auditCategory(entry.action)}`)}
                      title={AUDIT_CATEGORY_LABELS[auditCategory(entry.action)]}
                    >
                      {auditActionLabel(entry.action)}
                    </span>
                    <span className="audit-action-code">{entry.action}</span>
                  </td>
                  <td>{entry.actorName ?? '系统'}</td>
                  <td className="audit-target">{entry.target ?? '—'}</td>
                  <td className="table-muted audit-ip">{entry.ip ?? '—'}</td>
                  <td>
                    <details className="audit-detail">
                      <summary>查看</summary>
                      <pre>{JSON.stringify(entry.detail, null, 2)}</pre>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {data ? (
        <Pagination
          page={data.page}
          pageSize={data.pageSize}
          total={data.total}
          onChange={setPage}
        />
      ) : null}

      <ConfirmDialog
        open={confirmCleanup}
        title="清理过期审计日志？"
        message={`将永久删除早于 ${data?.retention.days ?? 180} 天的记录（单条超出 ${data?.retention.maxRows ?? 10_000} 条上限的旧记录已自动裁剪）。此操作不可撤销。`}
        confirmLabel="清理日志"
        busy={cleaning}
        onCancel={() => setConfirmCleanup(false)}
        onConfirm={() => void cleanup()}
      />

      <Toaster toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
