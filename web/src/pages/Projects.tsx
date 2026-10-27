import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  canCreateProject,
  canImportProjects,
  canManageProject,
  canViewAllProjects,
  PROJECT_STATUS_LABELS,
  PROJECT_STATUSES,
} from '../../../shared/permissions.ts';
import type {
  ImportResult,
  Project,
  ProjectDetail,
  ProjectDueFilter,
  ProjectStatus,
  ProjectViewQuery,
  SavedView,
  UserOption,
} from '../../../shared/types.ts';
import type { TemplateApplyInput } from '../api.ts';
import { api } from '../api.ts';
import { Icon } from '../components/Icon.tsx';
import { ProjectForm } from '../components/ProjectForm.tsx';
import { TemplatePicker } from '../components/TemplatePicker.tsx';
import {
  Avatar,
  cx,
  DemoBadge,
  EmptyState,
  ErrorState,
  Field,
  Modal,
  Pagination,
  ProgressBar,
  Skeleton,
  StatusBadge,
  Toaster,
} from '../components/ui.tsx';
import { formatDate, formatDateTime } from '../format.ts';
import { useApi, useDebounced, useToast } from '../hooks/useApi.ts';
import { useAuth } from '../hooks/useAuth.tsx';

const SORT_OPTIONS = [
  { value: 'updated', label: '最近更新' },
  { value: 'created', label: '创建时间' },
  { value: 'name', label: '名称' },
  { value: 'progress', label: '进度' },
  { value: 'due', label: '截止日期' },
];

const PAGE_SIZES = [12, 24, 48];

const DUE_OPTIONS: { value: ProjectDueFilter | 'all'; label: string }[] = [
  { value: 'all', label: '全部截止时间' },
  { value: 'overdue', label: '已逾期' },
  { value: 'week', label: '7 天内到期' },
  { value: 'month', label: '30 天内到期' },
];

function isStatus(value: string | null): value is ProjectStatus {
  return value !== null && (PROJECT_STATUSES as readonly string[]).includes(value);
}

function isDue(value: string | null): value is ProjectDueFilter {
  return value === 'overdue' || value === 'week' || value === 'month';
}

export default function ProjectsPage() {
  const { user, features } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const statusParam = params.get('status');
  const status: ProjectStatus | 'all' = isStatus(statusParam) ? statusParam : 'all';
  const owner = params.get('owner') ?? 'all';
  const sort = SORT_OPTIONS.some((option) => option.value === params.get('sort'))
    ? (params.get('sort') as string)
    : 'updated';
  const view = params.get('view') === 'list' ? 'list' : 'grid';
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);
  const tag = params.get('tag') ?? '';
  const due: ProjectDueFilter | 'all' = isDue(params.get('due'))
    ? (params.get('due') as ProjectDueFilter)
    : 'all';
  const favorite = params.get('favorite') === '1';
  const pageSizeParam = Number(params.get('pageSize') ?? 12);
  const pageSize = PAGE_SIZES.includes(pageSizeParam) ? pageSizeParam : 12;

  const [search, setSearch] = useState(query);
  const debouncedSearch = useDebounced(search, 300);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ProjectDetail | null>(null);
  const [editLoading, setEditLoading] = useState(false);
  const editRequest = useRef(0);
  const lastUrlQuery = useRef(query);
  const pendingWrite = useRef<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importPreview, setImportPreview] = useState<{ file: File; result: ImportResult } | null>(
    null,
  );
  const [trashOpen, setTrashOpen] = useState(false);
  const [trash, setTrash] = useState<Project[]>([]);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashBusy, setTrashBusy] = useState<string | null>(null);
  const [confirmPurge, setConfirmPurge] = useState<string | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [favoriteBusy, setFavoriteBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchOwner, setBatchOwner] = useState('');
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [activeView, setActiveView] = useState('');
  const [saveViewOpen, setSaveViewOpen] = useState(false);
  const [viewName, setViewName] = useState('');
  const [viewBusy, setViewBusy] = useState(false);
  const { toasts, show, dismiss } = useToast();

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

  const updateFilter = (patch: Record<string, string | null>) => {
    setActiveView('');
    update(patch);
  };

  useEffect(() => {
    if (debouncedSearch !== query) {
      pendingWrite.current = debouncedSearch;
      setActiveView('');
      update({ q: debouncedSearch || null, page: null });
    }
    // Only react to the debounced value; params are read from the current URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  useEffect(() => {
    const previous = lastUrlQuery.current;
    lastUrlQuery.current = query;
    if (previous === query) return;
    const fromDebounce = pendingWrite.current === query;
    pendingWrite.current = null;
    if (fromDebounce) return;
    setSearch(query);
  }, [query]);

  const options = useApi((signal) => api.userOptions(signal), []);
  const templates = useApi((signal) => api.projectTemplates(signal), []);
  const state = useApi(
    (signal) =>
      api.projects(
        {
          q: debouncedSearch,
          status,
          owner,
          sort,
          tag,
          due,
          favorite,
          page,
          pageSize,
        },
        signal,
      ),
    [debouncedSearch, status, owner, sort, tag, due, favorite, page, pageSize],
  );

  const users: UserOption[] = options.data?.users ?? [];
  const data = state.data;
  const canCreate = user ? canCreateProject(user.role, user.permissions) : false;
  const canImport = user ? canImportProjects(user.role, user.permissions) : false;
  const canFilterOwner = user ? canViewAllProjects(user.role, user.permissions) : false;
  const isAdmin = user?.role === 'admin';
  const canBatch = user ? user.role !== 'viewer' : false;
  const pageIds = data?.projects.map((project) => project.id) ?? [];
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));

  useEffect(() => {
    let active = true;
    api
      .savedViews()
      .then((result) => {
        if (active) setSavedViews(result.views);
      })
      .catch(() => {
        // Saved views are optional; ignore load errors and keep the filters usable.
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    setSelected(new Set());
  }, [debouncedSearch, status, owner, sort, tag, due, favorite, page, pageSize]);

  const toggleSelect = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(pageIds));
  };

  const toggleFavorite = async (project: Project) => {
    setFavoriteBusy(project.id);
    try {
      if (project.favorite) {
        await api.unfavoriteProject(project.id);
        show(`已取消收藏「${project.name}」`);
      } else {
        await api.favoriteProject(project.id);
        show(`已收藏「${project.name}」`);
      }
      state.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '收藏操作失败', 'error');
    } finally {
      setFavoriteBusy(null);
    }
  };

  const runBatch = async (input: {
    action: 'status' | 'owner' | 'archive';
    status?: ProjectStatus;
    ownerId?: string;
  }) => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBatchBusy(true);
    try {
      const result = await api.batchProjects({ ids, ...input });
      show(
        `已更新 ${result.updated} 个项目${
          result.skipped.length > 0 ? `，跳过 ${result.skipped.length} 个` : ''
        }`,
        result.updated > 0 ? undefined : 'error',
      );
      setSelected(new Set());
      setBatchOwner('');
      state.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '批量操作失败', 'error');
    } finally {
      setBatchBusy(false);
    }
  };

  const applySavedView = (view: SavedView) => {
    const next = new URLSearchParams();
    const query = view.query;
    if (query.q) next.set('q', query.q);
    if (query.status && query.status !== 'all') next.set('status', query.status);
    if (query.owner && query.owner !== 'all') next.set('owner', query.owner);
    if (query.sort && query.sort !== 'updated') next.set('sort', query.sort);
    if (query.tag) next.set('tag', query.tag);
    if (query.due) next.set('due', query.due);
    if (query.favorite) next.set('favorite', '1');
    if (query.view === 'list') next.set('view', 'list');
    if (query.pageSize && query.pageSize !== 12) next.set('pageSize', String(query.pageSize));
    setSearch(query.q ?? '');
    setParams(next, { replace: true });
    setActiveView(view.id);
    setSelected(new Set());
  };

  const saveCurrentView = async () => {
    const name = viewName.trim();
    if (!name || viewBusy) return;
    const query: ProjectViewQuery = {};
    if (debouncedSearch) query.q = debouncedSearch;
    if (status !== 'all') query.status = status;
    if (owner !== 'all') query.owner = owner;
    if (sort !== 'updated') query.sort = sort as ProjectViewQuery['sort'];
    if (tag) query.tag = tag;
    if (due !== 'all') query.due = due;
    if (favorite) query.favorite = true;
    if (view === 'list') query.view = 'list';
    if (pageSize !== 12) query.pageSize = pageSize;

    setViewBusy(true);
    try {
      const created = await api.createSavedView({ name, query });
      setSavedViews((current) => [created, ...current]);
      setActiveView(created.id);
      setSaveViewOpen(false);
      setViewName('');
      show(`已保存视图「${created.name}」`);
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '保存视图失败', 'error');
    } finally {
      setViewBusy(false);
    }
  };

  const removeActiveView = async () => {
    const active = savedViews.find((item) => item.id === activeView);
    if (!active) return;
    if (!window.confirm(`删除视图「${active.name}」？`)) return;
    try {
      await api.deleteSavedView(active.id);
      setSavedViews((current) => current.filter((item) => item.id !== active.id));
      setActiveView('');
      show(`已删除视图「${active.name}」`);
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '删除视图失败', 'error');
    }
  };

  const resetFile = () => {
    if (fileRef.current) fileRef.current.value = '';
  };

  const previewFile = async (file: File) => {
    setImporting(true);
    try {
      const result = await api.importProjects(file, true);
      setImportPreview({ file, result });
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '无法预览导入文件', 'error');
      resetFile();
    } finally {
      setImporting(false);
    }
  };

  const confirmImport = async () => {
    if (!importPreview) return;
    setImporting(true);
    try {
      const result = await api.importProjects(importPreview.file);
      show(
        `导入完成：新增 ${result.imported} 个，跳过 ${result.skipped} 行${
          result.duplicates > 0 ? `，其中 ${result.duplicates} 个同名` : ''
        }`,
        result.imported > 0 ? undefined : 'error',
      );
      setImportPreview(null);
      resetFile();
      state.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '导入失败', 'error');
    } finally {
      setImporting(false);
    }
  };

  const openTrash = async () => {
    setTrashOpen(true);
    setTrashLoading(true);
    setConfirmPurge(null);
    try {
      const result = await api.trashProjects();
      setTrash(result.projects);
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '无法加载回收站', 'error');
      setTrashOpen(false);
    } finally {
      setTrashLoading(false);
    }
  };

  const restoreFromTrash = async (project: Project) => {
    setTrashBusy(project.id);
    try {
      await api.restoreProject(project.id);
      setTrash((items) => items.filter((item) => item.id !== project.id));
      setConfirmPurge(null);
      show(`已恢复「${project.name}」`);
      state.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '恢复失败', 'error');
    } finally {
      setTrashBusy(null);
    }
  };

  const purgeFromTrash = async (project: Project) => {
    if (confirmPurge !== project.id) {
      setConfirmPurge(project.id);
      return;
    }
    setTrashBusy(project.id);
    try {
      await api.purgeProject(project.id);
      setTrash((items) => items.filter((item) => item.id !== project.id));
      setConfirmPurge(null);
      show(`已永久删除「${project.name}」`);
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '删除失败', 'error');
    } finally {
      setTrashBusy(null);
    }
  };

  const createFromTemplate = async (input: TemplateApplyInput) => {
    const result = await api.createProjectFromTemplate(input);
    setTemplateOpen(false);
    show(
      `已从模板创建「${result.project.name}」，含 ${result.milestones} 个里程碑、${result.tasks} 个任务`,
    );
    state.reload();
    navigate(`/projects/${result.project.id}`);
  };

  const restoreArchived = async (project: Project) => {
    setRestoringId(project.id);
    try {
      await api.updateProject(project.id, { status: 'active', version: project.version });
      show(`已恢复「${project.name}」`);
      state.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '恢复失败', 'error');
      state.reload();
    } finally {
      setRestoringId(null);
    }
  };

  const openEditor = async (project: Project) => {
    const requestId = ++editRequest.current;
    setEditLoading(true);
    try {
      const detail = await api.project(project.id);
      if (requestId !== editRequest.current) return;
      setEditing(detail);
      setFormOpen(true);
    } catch (cause) {
      if (requestId !== editRequest.current) return;
      show(cause instanceof Error ? cause.message : '无法加载项目', 'error');
    } finally {
      if (requestId === editRequest.current) setEditLoading(false);
    }
  };

  const editingDetail = editing;

  return (
    <div className="page projects-page">
      <header className="page-head">
        <div className="page-head-copy">
          <p className="eyebrow">Projects</p>
          <h1>项目空间</h1>
          <p className="page-sub">
            共 {data?.total ?? '—'} 个可见项目
            {canFilterOwner ? '，你可以查看全部团队项目。' : '，仅展示你拥有或加入的项目。'}
          </p>
        </div>
        <div className="page-head-actions">
          {canFilterOwner ? (
            <button type="button" className="btn btn-ghost" onClick={() => void openTrash()}>
              <Icon name="trash" size={16} />
              回收站
            </button>
          ) : null}
          <a
            className="btn btn-ghost"
            href={api.exportProjectsUrl({
              q: debouncedSearch,
              status,
              owner,
              tag,
              due,
              favorite,
            })}
          >
            <Icon name="download" size={16} />
            导出 CSV
          </a>
          {canImport ? (
            <>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.json,text/csv,application/json"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void previewFile(file);
                }}
              />
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => fileRef.current?.click()}
                disabled={importing}
              >
                <Icon name="upload" size={16} />
                {importing ? '导入中…' : '导入'}
              </button>
            </>
          ) : null}
          {canCreate && features.project_templates ? (
            <button type="button" className="btn btn-ghost" onClick={() => setTemplateOpen(true)}>
              <Icon name="rocket" size={16} />
              从模板创建
            </button>
          ) : null}
          {canCreate ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              <Icon name="plus" size={17} />
              新建项目
            </button>
          ) : null}
          {editLoading ? <span className="spinner" aria-label="加载项目" /> : null}
        </div>
      </header>

      <section className="project-toolbar card">
        <div className="project-toolbar-row">
          <div className="search-inline">
            <Icon name="search" size={16} />
            <input
              type="search"
              value={search}
              placeholder="搜索项目名称或描述…"
              aria-label="搜索项目"
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>

          <div className="toolbar-controls">
            {canFilterOwner ? (
              <select
                className="input input-sm"
                value={owner}
                aria-label="按负责人筛选"
                onChange={(event) => updateFilter({ owner: event.target.value, page: null })}
              >
                <option value="all">全部负责人</option>
                {users.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            ) : null}

            <select
              className="input input-sm"
              value={sort}
              aria-label="排序方式"
              onChange={(event) => updateFilter({ sort: event.target.value, page: null })}
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            <select
              className="input input-sm"
              value={pageSize}
              aria-label="每页数量"
              onChange={(event) =>
                updateFilter({
                  pageSize: event.target.value === '12' ? null : event.target.value,
                  page: null,
                })
              }
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size} / 页
                </option>
              ))}
            </select>

            <div className="view-toggle" role="group" aria-label="视图切换">
              <button
                type="button"
                className={cx('view-toggle-btn', view === 'grid' && 'is-active')}
                onClick={() => update({ view: null })}
                aria-label="卡片视图"
                aria-pressed={view === 'grid'}
              >
                <Icon name="overview" size={16} />
              </button>
              <button
                type="button"
                className={cx('view-toggle-btn', view === 'list' && 'is-active')}
                onClick={() => update({ view: 'list' })}
                aria-label="列表视图"
                aria-pressed={view === 'list'}
              >
                <Icon name="menu" size={16} />
              </button>
            </div>
          </div>
        </div>

        <div className="project-toolbar-filters">
          <div className="saved-view-bar">
            <label className="visually-hidden" htmlFor="saved-view-select">
              我的视图
            </label>
            <select
              id="saved-view-select"
              className="input input-sm"
              value={activeView}
              onChange={(event) => {
                const next = savedViews.find((item) => item.id === event.target.value);
                if (next) applySavedView(next);
                else setActiveView('');
              }}
            >
              <option value="">我的视图</option>
              {savedViews.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={() => {
                setViewName('');
                setSaveViewOpen(true);
              }}
            >
              <Icon name="star" size={14} />
              保存当前视图
            </button>
            {activeView ? (
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                onClick={() => void removeActiveView()}
              >
                删除视图
              </button>
            ) : null}
          </div>

          <div className="toolbar-filter-chips">
            <label className="visually-hidden" htmlFor="project-due-filter">
              按截止时间筛选
            </label>
            <select
              id="project-due-filter"
              className="input input-sm"
              value={due}
              onChange={(event) => updateFilter({ due: event.target.value, page: null })}
            >
              {DUE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={cx('filter-chip', favorite && 'is-active')}
              aria-pressed={favorite}
              onClick={() => updateFilter({ favorite: favorite ? null : '1', page: null })}
            >
              <Icon name="star" size={14} />
              只看收藏
            </button>
          </div>
        </div>

        <div className="status-chips" role="group" aria-label="按状态筛选">
          <button
            type="button"
            className={cx('filter-chip', status === 'all' && 'is-active')}
            onClick={() => updateFilter({ status: null, page: null })}
          >
            全部
            <span>{data?.counts.all ?? 0}</span>
          </button>
          {PROJECT_STATUSES.map((value) => (
            <button
              key={value}
              type="button"
              className={cx('filter-chip', status === value && 'is-active')}
              onClick={() => updateFilter({ status: value, page: null })}
            >
              {PROJECT_STATUS_LABELS[value]}
              <span>{data?.counts[value] ?? 0}</span>
            </button>
          ))}
        </div>

        {data && data.tags.length > 0 ? (
          <div className="tag-chips" role="group" aria-label="按标签筛选">
            <span className="tag-chips-label">标签</span>
            {data.tags.map((item) => (
              <button
                key={item.tag}
                type="button"
                className={cx('tag-chip', tag === item.tag && 'is-active')}
                aria-pressed={tag === item.tag}
                onClick={() =>
                  updateFilter({ tag: tag === item.tag ? null : item.tag, page: null })
                }
              >
                {item.tag}
                <span>{item.count}</span>
              </button>
            ))}
          </div>
        ) : null}
      </section>

      {state.error && !data ? (
        <div className="card card-pad">
          <ErrorState message={state.error} onRetry={state.reload} />
        </div>
      ) : null}

      {state.error && data ? (
        <div className="inline-alert" role="status">
          <Icon name="alert" size={16} />
          刷新失败：{state.error}
        </div>
      ) : null}

      {!data && state.loading ? (
        <div className={cx('projects-grid', view === 'list' && 'is-list')}>
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="card card-pad project-skeleton" aria-hidden="true">
              <Skeleton height={20} width="58%" />
              <Skeleton height={12} width="90%" />
              <Skeleton height={12} width="72%" />
              <Skeleton height={9} width="100%" radius={6} />
              <Skeleton height={26} width="46%" radius={13} />
            </div>
          ))}
        </div>
      ) : null}

      {data && data.projects.length === 0 ? (
        <div className="card card-pad">
          <EmptyState
            icon="projects"
            title={query ? '没有匹配的项目' : '还没有项目'}
            description={
              query
                ? `没有找到与「${query}」相关的项目，试试其他关键词或清除筛选。`
                : canCreate
                  ? '创建第一个项目，团队活动流会立即记录这次操作。'
                  : '你还没有被加入任何项目，请联系管理员或项目经理。'
            }
            action={
              canCreate ? (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    setEditing(null);
                    setFormOpen(true);
                  }}
                >
                  <Icon name="plus" size={16} />
                  新建项目
                </button>
              ) : null
            }
          />
        </div>
      ) : null}

      {canBatch && selected.size > 0 ? (
        <div className="batch-bar card" role="region" aria-label="批量操作">
          <span className="batch-count">已选 {selected.size} 个项目</span>
          <div className="batch-actions">
            <button
              type="button"
              className="btn btn-soft btn-xs"
              disabled={batchBusy}
              onClick={() => void runBatch({ action: 'status', status: 'active' })}
            >
              标记进行中
            </button>
            <button
              type="button"
              className="btn btn-soft btn-xs"
              disabled={batchBusy}
              onClick={() => void runBatch({ action: 'status', status: 'completed' })}
            >
              标记已完成
            </button>
            <button
              type="button"
              className="btn btn-soft btn-xs"
              disabled={batchBusy}
              onClick={() => void runBatch({ action: 'archive' })}
            >
              归档
            </button>
            {canFilterOwner ? (
              <>
                <label className="visually-hidden" htmlFor="batch-owner">
                  转移负责人
                </label>
                <select
                  id="batch-owner"
                  className="input input-sm"
                  value={batchOwner}
                  onChange={(event) => setBatchOwner(event.target.value)}
                >
                  <option value="">转移给…</option>
                  {users.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn-soft btn-xs"
                  disabled={batchBusy || !batchOwner}
                  onClick={() => void runBatch({ action: 'owner', ownerId: batchOwner })}
                >
                  转移
                </button>
              </>
            ) : null}
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              disabled={batchBusy}
              onClick={() => setSelected(new Set())}
            >
              取消选择
            </button>
          </div>
          {batchBusy ? <span className="spinner" aria-label="批量处理中" /> : null}
        </div>
      ) : null}

      {data && data.projects.length > 0 ? (
        view === 'grid' ? (
          <div key="grid" className="projects-grid tab-panel">
            {data.projects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                canEdit={
                  user
                    ? canManageProject(user.role, project.ownerId === user.id, user.permissions)
                    : false
                }
                canSelect={canBatch}
                selected={selected.has(project.id)}
                onSelect={() => toggleSelect(project.id)}
                onFavorite={() => void toggleFavorite(project)}
                favoriteBusy={favoriteBusy === project.id}
                onTag={(value) => updateFilter({ tag: value, page: null })}
                onEdit={() => void openEditor(project)}
                onRestore={() => void restoreArchived(project)}
                restoring={restoringId === project.id}
              />
            ))}
          </div>
        ) : (
          <div key="list" className="card table-card tab-panel">
            <table className="data-table">
              <thead>
                <tr>
                  {canBatch ? (
                    <th className="bulk-cell">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={toggleAll}
                        aria-label="选择当前页全部项目"
                      />
                    </th>
                  ) : null}
                  <th>项目</th>
                  <th>状态</th>
                  <th>负责人</th>
                  <th>进度</th>
                  <th>截止</th>
                  <th>更新</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {data.projects.map((project) => (
                  <tr key={project.id}>
                    {canBatch ? (
                      <td className="bulk-cell">
                        <input
                          type="checkbox"
                          checked={selected.has(project.id)}
                          onChange={() => toggleSelect(project.id)}
                          aria-label={`选择 ${project.name}`}
                        />
                      </td>
                    ) : null}
                    <td>
                      <div className="table-title-row">
                        <Link to={`/projects/${project.id}`} className="table-title">
                          {project.name}
                          {project.isDemo ? <DemoBadge label="Demo" /> : null}
                        </Link>
                        <button
                          type="button"
                          className={cx('star-btn', project.favorite && 'is-active')}
                          aria-label={
                            project.favorite ? `取消收藏 ${project.name}` : `收藏 ${project.name}`
                          }
                          aria-pressed={project.favorite}
                          disabled={favoriteBusy === project.id}
                          onClick={() => void toggleFavorite(project)}
                        >
                          <Icon name="star" size={14} />
                        </button>
                      </div>
                      {project.tags.length > 0 ? (
                        <div className="project-tags">
                          {project.tags.map((value) => (
                            <button
                              key={value}
                              type="button"
                              className="tag-chip"
                              onClick={() => updateFilter({ tag: value, page: null })}
                            >
                              {value}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <StatusBadge status={project.status} />
                    </td>
                    <td>
                      <span className="table-person">
                        <Avatar name={project.ownerName} size={24} />
                        {project.ownerName}
                      </span>
                    </td>
                    <td className="table-progress">
                      <ProgressBar value={project.progress} />
                      <span>{project.progress}%</span>
                    </td>
                    <td>{project.dueDate ? formatDate(project.dueDate) : '—'}</td>
                    <td className="table-muted">{formatDateTime(project.updatedAt)}</td>
                    <td>
                      <div className="trash-actions">
                        {project.status === 'archived' &&
                        user &&
                        canManageProject(
                          user.role,
                          project.ownerId === user.id,
                          user.permissions,
                        ) ? (
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs"
                            aria-label={`恢复 ${project.name}`}
                            disabled={restoringId === project.id}
                            onClick={() => void restoreArchived(project)}
                          >
                            <Icon name="refresh" size={14} />
                            恢复
                          </button>
                        ) : null}
                        {user &&
                        canManageProject(
                          user.role,
                          project.ownerId === user.id,
                          user.permissions,
                        ) ? (
                          <button
                            type="button"
                            className="btn btn-icon btn-ghost btn-xs"
                            aria-label={`编辑 ${project.name}`}
                            onClick={() => void openEditor(project)}
                          >
                            <Icon name="edit" size={15} />
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}

      {data ? (
        <Pagination
          page={data.page}
          pageSize={data.pageSize}
          total={data.total}
          onChange={(next) => update({ page: String(next) })}
        />
      ) : null}

      <ProjectForm
        open={formOpen}
        project={editingDetail}
        users={users}
        onClose={() => {
          editRequest.current++;
          setFormOpen(false);
          setEditing(null);
        }}
        onSaved={(_saved, message) => {
          setFormOpen(false);
          setEditing(null);
          show(message);
          state.reload();
        }}
      />

      <Modal
        open={trashOpen}
        onClose={() => {
          setTrashOpen(false);
          setConfirmPurge(null);
        }}
        title="回收站"
        description="已删除的项目可在此恢复；超过保留期的项目会被自动清理。"
        wide
        footer={
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setTrashOpen(false);
              setConfirmPurge(null);
            }}
          >
            关闭
          </button>
        }
      >
        {trashLoading ? (
          <div className="trash-loading">
            <Skeleton height={14} width="60%" />
            <Skeleton height={14} width="80%" />
            <Skeleton height={14} width="45%" />
          </div>
        ) : trash.length === 0 ? (
          <p className="import-empty">回收站是空的。</p>
        ) : (
          <div className="import-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>项目</th>
                  <th>负责人</th>
                  <th>删除时间</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {trash.map((project) => (
                  <tr key={project.id}>
                    <td>{project.name}</td>
                    <td className="table-muted">{project.ownerName}</td>
                    <td className="table-muted">
                      {project.deletedAt ? formatDateTime(project.deletedAt) : '—'}
                    </td>
                    <td>
                      <div className="trash-actions">
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs"
                          onClick={() => void restoreFromTrash(project)}
                          disabled={trashBusy === project.id}
                        >
                          恢复
                        </button>
                        {isAdmin ? (
                          <button
                            type="button"
                            className={cx(
                              'btn',
                              'btn-xs',
                              confirmPurge === project.id ? 'btn-danger' : 'btn-danger-ghost',
                            )}
                            onClick={() => void purgeFromTrash(project)}
                            disabled={trashBusy === project.id}
                            aria-label={
                              confirmPurge === project.id
                                ? `确认永久删除 ${project.name}`
                                : `永久删除 ${project.name}`
                            }
                          >
                            {confirmPurge === project.id ? '确认永久删除' : '永久删除'}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>

      <Modal
        open={importPreview !== null}
        onClose={() => {
          if (importing) return;
          setImportPreview(null);
          resetFile();
        }}
        title="导入预览"
        description={
          importPreview
            ? `可导入 ${importPreview.result.items.length} 个，跳过 ${importPreview.result.skipped} 行`
            : undefined
        }
        footer={
          <>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setImportPreview(null);
                resetFile();
              }}
              disabled={importing}
            >
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void confirmImport()}
              disabled={importing || (importPreview?.result.items.length ?? 0) === 0}
            >
              {importing ? '导入中…' : '确认导入'}
            </button>
          </>
        }
      >
        {importPreview ? (
          <div className="import-preview">
            <div className="import-summary">
              <span>
                待导入 <strong>{importPreview.result.items.length}</strong>
              </span>
              <span>
                跳过 <strong>{importPreview.result.skipped}</strong>
              </span>
              <span>
                同名重复 <strong>{importPreview.result.duplicates}</strong>
              </span>
            </div>

            {importPreview.result.items.length > 0 ? (
              <div className="import-table-wrap">
                <table className="data-table import-table">
                  <thead>
                    <tr>
                      <th>行</th>
                      <th>名称</th>
                      <th>状态</th>
                      <th>负责人</th>
                      <th>成员</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importPreview.result.items.map((item) => (
                      <tr key={`${item.row}-${item.name}`}>
                        <td className="table-muted">{item.row}</td>
                        <td>{item.name}</td>
                        <td>
                          <StatusBadge status={item.status} />
                        </td>
                        <td className="table-muted">{item.ownerEmail ?? '—'}</td>
                        <td className="table-muted">
                          {item.members.length > 0 ? item.members.join('、') : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="import-empty">没有可导入的行，请检查文件内容后重试。</p>
            )}

            {importPreview.result.errors.length > 0 ? (
              <div className="import-errors" role="status">
                <p className="import-errors-title">问题明细</p>
                <ul>
                  {importPreview.result.errors.slice(0, 10).map((issue) => (
                    <li key={`${issue.row}-${issue.message}`}>
                      第 {issue.row} 行：{issue.message}
                    </li>
                  ))}
                </ul>
                {importPreview.result.errors.length > 10 ? (
                  <p className="table-muted">
                    还有 {importPreview.result.errors.length - 10} 条问题未显示。
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>

      <Modal
        open={saveViewOpen}
        onClose={() => {
          if (viewBusy) return;
          setSaveViewOpen(false);
        }}
        title="保存当前视图"
        description="保存搜索、状态、负责人、标签、截止时间与每页数量，随时一键恢复。"
        footer={
          <>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setSaveViewOpen(false)}
              disabled={viewBusy}
            >
              取消
            </button>
            <button
              type="submit"
              form="saved-view-form"
              className="btn btn-primary"
              disabled={viewBusy || viewName.trim().length === 0}
            >
              {viewBusy ? <span className="spinner" aria-label="保存中" /> : null}
              保存视图
            </button>
          </>
        }
      >
        <form
          id="saved-view-form"
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void saveCurrentView();
          }}
        >
          <div className="form-span-2">
            <Field
              label="视图名称"
              htmlFor="saved-view-name"
              hint="例如「我的逾期项目」「Q4 重点标签」。"
            >
              <input
                id="saved-view-name"
                className="input"
                value={viewName}
                maxLength={40}
                required
                onChange={(event) => setViewName(event.target.value)}
                placeholder="视图名称"
              />
            </Field>
          </div>
        </form>
      </Modal>

      <TemplatePicker
        open={templateOpen}
        templates={templates.data?.templates ?? []}
        loading={templates.loading}
        canPickOwner={canFilterOwner}
        users={users}
        ownerId={user?.id ?? ''}
        onClose={() => setTemplateOpen(false)}
        onSubmit={createFromTemplate}
      />

      <Toaster toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

function ProjectCard({
  project,
  canEdit,
  canSelect,
  selected,
  onSelect,
  onFavorite,
  favoriteBusy,
  onTag,
  onEdit,
  onRestore,
  restoring,
}: {
  project: Project;
  canEdit: boolean;
  canSelect: boolean;
  selected: boolean;
  onSelect: () => void;
  onFavorite: () => void;
  favoriteBusy: boolean;
  onTag: (tag: string) => void;
  onEdit: () => void;
  onRestore: () => void;
  restoring: boolean;
}) {
  const overdue =
    project.dueDate !== null &&
    project.dueDate < new Date().toISOString().slice(0, 10) &&
    project.status !== 'completed' &&
    project.status !== 'archived';

  return (
    <article className="card project-card">
      <div className="project-card-top">
        <div className="project-badges">
          {canSelect ? (
            <label className="bulk-check">
              <input
                type="checkbox"
                checked={selected}
                onChange={onSelect}
                aria-label={`选择 ${project.name}`}
              />
            </label>
          ) : null}
          <StatusBadge status={project.status} />
          {project.visibility === 'private' ? (
            <span className="badge" data-tone="private" title="仅项目负责人和成员可见">
              仅成员
            </span>
          ) : null}
          {project.isDemo ? <DemoBadge label="Demo" /> : null}
        </div>
        <div className="project-card-actions">
          <button
            type="button"
            className={cx('btn btn-icon btn-ghost btn-xs', project.favorite && 'is-favorite')}
            aria-label={project.favorite ? `取消收藏 ${project.name}` : `收藏 ${project.name}`}
            aria-pressed={project.favorite}
            onClick={onFavorite}
            disabled={favoriteBusy}
          >
            <Icon name="star" size={15} />
          </button>
          {canEdit ? (
            <>
              {project.status === 'archived' ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  aria-label={`恢复 ${project.name}`}
                  onClick={onRestore}
                  disabled={restoring}
                >
                  <Icon name="refresh" size={14} />
                  恢复
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn-icon btn-ghost btn-xs"
                aria-label={`编辑 ${project.name}`}
                onClick={onEdit}
              >
                <Icon name="edit" size={15} />
              </button>
            </>
          ) : null}
        </div>
      </div>

      <Link to={`/projects/${project.id}`} className="project-name">
        {project.name}
      </Link>
      <p className="project-desc">{project.description || '暂无描述'}</p>

      {project.tags.length > 0 ? (
        <div className="project-tags">
          {project.tags.map((value) => (
            <button key={value} type="button" className="tag-chip" onClick={() => onTag(value)}>
              {value}
            </button>
          ))}
        </div>
      ) : null}

      <div className="project-progress">
        <div className="project-progress-head">
          <span>进度</span>
          <strong>{project.progress}%</strong>
        </div>
        <ProgressBar value={project.progress} />
      </div>

      <footer className="project-card-foot">
        <span className="project-owner">
          <Avatar name={project.ownerName} size={26} />
          {project.ownerName}
        </span>
        <span className={cx('project-due', overdue && 'is-overdue')}>
          <Icon name="calendar" size={14} />
          {project.dueDate ? formatDate(project.dueDate) : '未设截止'}
        </span>
      </footer>
    </article>
  );
}
