import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { canManageProject, canViewAllProjects } from '../../../shared/permissions.ts';
import type {
  ActivityItem,
  ProjectDetail,
  ProjectStatus,
  UserOption,
} from '../../../shared/types.ts';
import type { DuplicateProjectInput } from '../api.ts';
import { api } from '../api.ts';
import { AttachmentsPanel } from '../components/AttachmentsPanel.tsx';
import { CommentsPanel } from '../components/CommentsPanel.tsx';
import { ActivityFeed } from '../components/DashboardWidgets.tsx';
import { DuplicateProjectDialog } from '../components/DuplicateProjectDialog.tsx';
import { Icon } from '../components/Icon.tsx';
import { ProjectForm } from '../components/ProjectForm.tsx';
import { TaskPanel } from '../components/TaskPanel.tsx';
import {
  Avatar,
  ConfirmDialog,
  cx,
  DemoBadge,
  EmptyState,
  ErrorState,
  ProgressBar,
  Skeleton,
  StatusBadge,
  Toaster,
} from '../components/ui.tsx';
import { formatDate, formatDateTime } from '../format.ts';
import { useApi, useToast } from '../hooks/useApi.ts';
import { useAuth } from '../hooks/useAuth.tsx';
import { useProjectTyping } from '../hooks/useProjectTyping.ts';

function typingLabel(names: string[]): string {
  if (names.length === 1) return `${names[0]} 正在编辑项目`;
  if (names.length === 2) return `${names[0]} 和 ${names[1]} 正在编辑项目`;
  return `${names[0]} 等 ${names.length} 人正在编辑项目`;
}

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const focusTaskId = searchParams.get('task') ?? undefined;
  const [editing, setEditing] = useState<ProjectDetail | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [extras, setExtras] = useState<ActivityItem[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const { toasts, show, dismiss } = useToast();
  const { typingNames, notifyTyping } = useProjectTyping(id);
  const idRef = useRef(id);
  idRef.current = id;

  useEffect(() => {
    setExtras([]);
    setCursor(null);
    setLoadingMore(false);
  }, [id]);

  const state = useApi((signal) => api.project(id ?? '', signal), [id], { skip: !id });
  const options = useApi((signal) => api.userOptions(signal), []);
  const activityState = useApi(
    (signal) => api.activities({ projectId: id, limit: 20 }, signal),
    [id],
    { skip: !id },
  );

  const project = state.data;
  const canEdit =
    project && user
      ? canManageProject(user.role, project.ownerId === user.id, user.permissions)
      : false;
  const canDelete = user ? canViewAllProjects(user.role, user.permissions) : false;
  const canComment = user?.role !== 'viewer';
  const mentionUsers: UserOption[] = project
    ? [
        { id: project.ownerId, name: project.ownerName },
        ...project.members.filter((member) => member.id !== project.ownerId),
      ]
    : [];

  const baseActivities = activityState.data?.activities ?? [];
  const seen = new Set<number>();
  const activities = [...baseActivities, ...extras].filter((item) => {
    if (seen.has(item.seq)) return false;
    seen.add(item.seq);
    return true;
  });
  const nextCursor = cursor ?? activityState.data?.nextCursor ?? null;

  const loadMore = async () => {
    if (!nextCursor || loadingMore || !id) return;
    const requestedId = id;
    setLoadingMore(true);
    try {
      const page = await api.activities({ projectId: requestedId, cursor: nextCursor, limit: 20 });
      if (idRef.current !== requestedId) return;
      setExtras((current) => [...current, ...page.activities]);
      setCursor(page.nextCursor);
    } catch (cause) {
      if (idRef.current !== requestedId) return;
      show(cause instanceof Error ? cause.message : '加载活动失败', 'error');
    } finally {
      if (idRef.current === requestedId) setLoadingMore(false);
    }
  };

  const remove = async () => {
    if (!project) return;
    const target = project;
    setDeleting(true);
    try {
      await api.deleteProject(target.id);
      navigate('/projects', { replace: true });
      show(`已删除「${target.name}」`, 'success', {
        duration: 9_000,
        action: {
          label: '撤销',
          onClick: async () => {
            try {
              await api.restoreProject(target.id);
              show(`已恢复「${target.name}」`);
              window.dispatchEvent(new Event('live:refresh'));
            } catch (cause) {
              show(cause instanceof Error ? cause.message : '恢复失败', 'error');
            }
          },
        },
      });
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '删除失败', 'error');
      setDeleting(false);
      setConfirming(false);
    }
  };

  const changeStatus = async (next: ProjectStatus) => {
    if (!project || statusBusy) return;
    setStatusBusy(true);
    try {
      await api.updateProject(project.id, { status: next, version: project.version });
      show(next === 'archived' ? `已归档「${project.name}」` : `已恢复「${project.name}」`);
      state.reload();
      activityState.reload();
      setExtras([]);
      setCursor(null);
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '状态更新失败', 'error');
      state.reload();
    } finally {
      setStatusBusy(false);
    }
  };

  const duplicate = async (input: DuplicateProjectInput) => {
    if (!project) return;
    const result = await api.duplicateProject(project.id, input);
    setDuplicating(false);
    show(
      `已复制为「${result.project.name}」，含 ${result.milestones} 个里程碑、${result.tasks} 个任务`,
    );
    navigate(`/projects/${result.project.id}`);
  };

  if (!id) {
    return (
      <div className="page">
        <div className="card card-pad">
          <ErrorState message="缺少项目 ID" onRetry={() => navigate('/projects')} />
        </div>
      </div>
    );
  }

  if (state.loading && !project) {
    return (
      <div className="page">
        <div className="detail-skeleton">
          <Skeleton height={26} width="24%" />
          <Skeleton height={40} width="56%" />
          <Skeleton height={16} width="70%" />
          <Skeleton height={220} radius={24} />
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="page">
        <div className="card card-pad not-found-card">
          <span className="not-found-icon" aria-hidden="true">
            <Icon name="lock" size={30} />
          </span>
          <h1>项目不存在</h1>
          <p>该项目不存在，或者你不在它的可见范围内。</p>
          <div className="not-found-actions">
            <Link to="/projects" className="btn btn-primary">
              <Icon name="arrowRight" size={16} />
              返回项目列表
            </Link>
            <button type="button" className="btn btn-ghost" onClick={state.reload}>
              <Icon name="refresh" size={16} />
              重试
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page project-detail-page">
      <nav className="breadcrumb" aria-label="面包屑">
        <Link to="/projects">Projects</Link>
        <Icon name="chevronRight" size={13} />
        <span>{project.name}</span>
      </nav>

      <header className="page-head detail-head">
        <div className="page-head-copy">
          <div className="detail-badges">
            <StatusBadge status={project.status} />
            {project.visibility === 'private' ? (
              <span className="badge" data-tone="private" title="仅项目负责人和成员可见">
                仅成员
              </span>
            ) : null}
            {project.isDemo ? <DemoBadge label="Demo 项目" /> : null}
            <span className="detail-version">v{project.version}</span>
          </div>
          <h1>{project.name}</h1>
          <p className="page-sub">{project.description || '这个项目还没有描述。'}</p>
          {typingNames.length > 0 ? (
            <p className="typing-indicator" role="status">
              <span className="typing-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              {typingLabel(typingNames)}
            </p>
          ) : null}
        </div>
        <div className="page-head-actions">
          {canEdit && project.status === 'archived' ? (
            <button
              type="button"
              className="btn btn-soft"
              onClick={() => void changeStatus('active')}
              disabled={statusBusy}
            >
              <Icon name="refresh" size={16} />
              恢复项目
            </button>
          ) : null}
          {canEdit && project.status !== 'archived' ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void changeStatus('archived')}
              disabled={statusBusy}
            >
              <Icon name="folder" size={16} />
              归档
            </button>
          ) : null}
          {canEdit ? (
            <button type="button" className="btn btn-ghost" onClick={() => setDuplicating(true)}>
              <Icon name="projects" size={16} />
              复制项目
            </button>
          ) : null}
          {canEdit ? (
            <button type="button" className="btn btn-primary" onClick={() => setEditing(project)}>
              <Icon name="edit" size={16} />
              编辑项目
            </button>
          ) : null}
          {canDelete ? (
            <button
              type="button"
              className="btn btn-danger-ghost"
              onClick={() => setConfirming(true)}
            >
              <Icon name="trash" size={16} />
              删除
            </button>
          ) : null}
        </div>
      </header>

      <div className="detail-grid">
        <div className="detail-main">
          <section className="card card-pad">
            <header className="card-head">
              <div>
                <h2>项目进度</h2>
                <p className="card-sub">最近更新 {formatDateTime(project.updatedAt)}</p>
              </div>
              <strong className="detail-progress-value">{project.progress}%</strong>
            </header>
            <ProgressBar
              value={project.progress}
              tone={project.status === 'completed' ? 'mint' : 'lilac'}
            />
            <div className="detail-stat-row">
              <div>
                <span>开始日期</span>
                <strong>{project.startDate ? formatDate(project.startDate) : '—'}</strong>
              </div>
              <div>
                <span>截止日期</span>
                <strong>{project.dueDate ? formatDate(project.dueDate) : '—'}</strong>
              </div>
              <div>
                <span>负责人</span>
                <strong className="detail-person">
                  <Avatar name={project.ownerName} size={24} />
                  {project.ownerName}
                </strong>
              </div>
              <div>
                <span>状态</span>
                <StatusBadge status={project.status} />
              </div>
            </div>
          </section>

          <TaskPanel
            projectId={project.id}
            canEdit={canEdit}
            canComment={canComment}
            users={options.data?.users ?? []}
            mentionUsers={mentionUsers}
            focusTaskId={focusTaskId}
            show={show}
            onChanged={() => {
              state.reload();
              activityState.reload();
              setExtras([]);
              setCursor(null);
            }}
          />

          <AttachmentsPanel
            projectId={project.id}
            canUpload={canComment}
            canManage={canEdit}
            currentUserId={user?.id}
            show={show}
          />

          <section className="card card-pad">
            <header className="card-head">
              <div>
                <h2>讨论</h2>
                <p className="card-sub">项目级评论、@提及与任务讨论都汇总在这里。</p>
              </div>
            </header>
            <CommentsPanel
              projectId={project.id}
              users={mentionUsers}
              canComment={canComment}
              canManage={canEdit}
              onChanged={() => {
                activityState.reload();
                setExtras([]);
                setCursor(null);
              }}
            />
          </section>

          <section className="card card-pad">
            <header className="card-head">
              <div>
                <h2>项目动态</h2>
                <p className="card-sub">该项目的最近 20 条操作，实时更新</p>
              </div>
              <button
                type="button"
                className="btn btn-icon btn-ghost btn-sm"
                onClick={activityState.reload}
                aria-label="刷新动态"
              >
                <Icon name="refresh" size={16} />
              </button>
            </header>
            {activityState.loading && !activityState.data ? (
              <div className="activity-skeleton">
                {[0, 1, 2].map((index) => (
                  <div key={index} className="activity-skeleton-row">
                    <Skeleton height={34} width={34} radius={12} />
                    <div className="activity-skeleton-lines">
                      <Skeleton height={12} width={`${70 - index * 8}%`} />
                      <Skeleton height={10} width="38%" />
                    </div>
                  </div>
                ))}
              </div>
            ) : activities.length > 0 ? (
              <>
                <ActivityFeed activities={activities} />
                {nextCursor ? (
                  <button
                    type="button"
                    className="btn btn-soft btn-sm load-more"
                    onClick={() => void loadMore()}
                    disabled={loadingMore}
                  >
                    {loadingMore ? (
                      <span className="spinner" />
                    ) : (
                      <Icon name="chevronDown" size={15} />
                    )}
                    加载更多
                  </button>
                ) : null}
              </>
            ) : (
              <EmptyState
                icon="activity"
                title="还没有动态"
                description="编辑项目或调整成员后，活动会出现在这里。"
                compact
              />
            )}
          </section>
        </div>

        <aside className="detail-side">
          <section className="card card-pad">
            <header className="card-head">
              <h2>项目信息</h2>
            </header>
            <dl className="detail-meta">
              <div>
                <dt>创建于</dt>
                <dd>{formatDateTime(project.createdAt)}</dd>
              </div>
              <div>
                <dt>最近更新</dt>
                <dd>{formatDateTime(project.updatedAt)}</dd>
              </div>
              <div>
                <dt>版本</dt>
                <dd>v{project.version}</dd>
              </div>
              <div>
                <dt>数据来源</dt>
                <dd>{project.isDemo ? '演示项目' : '团队创建'}</dd>
              </div>
            </dl>
          </section>

          <section className="card card-pad">
            <header className="card-head">
              <h2>成员</h2>
              <span className="count-pill">{project.members.length}</span>
            </header>
            {project.members.length > 0 ? (
              <ul className="member-list">
                <li>
                  <Avatar name={project.ownerName} size={34} />
                  <div>
                    <strong>{project.ownerName}</strong>
                    <span>项目负责人</span>
                  </div>
                </li>
                {project.members
                  .filter((member) => member.id !== project.ownerId)
                  .map((member) => (
                    <li key={member.id}>
                      <Avatar name={member.name} size={34} />
                      <div>
                        <strong>{member.name}</strong>
                        <span>成员</span>
                      </div>
                    </li>
                  ))}
              </ul>
            ) : (
              <EmptyState
                icon="users"
                title="暂无其他成员"
                description="编辑项目即可邀请团队成员加入。"
                compact
              />
            )}
          </section>

          {state.error ? (
            <div className={cx('inline-alert', 'is-card')} role="status">
              <Icon name="alert" size={16} />
              {state.error}
            </div>
          ) : null}
        </aside>
      </div>

      <ProjectForm
        open={editing !== null}
        project={editing}
        users={options.data?.users ?? []}
        onTyping={notifyTyping}
        onClose={() => {
          notifyTyping(false);
          setEditing(null);
        }}
        onSaved={(_saved, message) => {
          notifyTyping(false);
          setEditing(null);
          show(message);
          state.reload();
          activityState.reload();
          setExtras([]);
          setCursor(null);
        }}
      />

      <DuplicateProjectDialog
        open={duplicating}
        project={project}
        onClose={() => setDuplicating(false)}
        onSubmit={duplicate}
      />

      <ConfirmDialog
        open={confirming}
        title="删除项目？"
        message={`「${project.name}」及其成员关系会移入回收站，活动记录会保留在团队动态中。可在提示中撤销，或稍后从回收站恢复。`}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void remove()}
        busy={deleting}
      />

      <Toaster toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
