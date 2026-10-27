import { type FormEvent, useState } from 'react';
import type { Comment, UserOption } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { Icon } from '../components/Icon.tsx';
import {
  Avatar,
  ConfirmDialog,
  cx,
  EmptyState,
  Modal,
  Skeleton,
  Spinner,
} from '../components/ui.tsx';
import { formatDateTime } from '../format.ts';
import { useApi } from '../hooks/useApi.ts';
import { useAuth } from '../hooks/useAuth.tsx';

type Props = {
  projectId: string;
  taskId?: string;
  users: UserOption[];
  canComment: boolean;
  canManage: boolean;
  compact?: boolean;
  onChanged?: () => void;
};

export function CommentsPanel({
  projectId,
  taskId,
  users,
  canComment,
  canManage,
  compact = false,
  onChanged,
}: Props) {
  const { user } = useAuth();
  const state = useApi((signal) => api.comments(projectId, taskId, signal), [projectId, taskId]);
  const [body, setBody] = useState('');
  const [mentions, setMentions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Comment | null>(null);
  const [deleting, setDeleting] = useState(false);
  const data = state.data;

  const toggleMention = (id: string) => {
    setMentions((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.createComment(projectId, {
        body: text,
        ...(taskId ? { taskId } : {}),
        ...(mentions.length > 0 ? { mentions } : {}),
      });
      setBody('');
      setMentions([]);
      state.reload();
      onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '发表评论失败');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await api.deleteComment(deleteTarget.id);
      setDeleteTarget(null);
      state.reload();
      onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除评论失败');
    } finally {
      setDeleting(false);
    }
  };

  const comments = data?.comments ?? [];

  return (
    <div className={cx('comments-panel', compact && 'is-compact')}>
      {error ? (
        <div className="inline-alert is-card" role="alert">
          <Icon name="alert" size={16} />
          {error}
        </div>
      ) : null}

      {canComment ? (
        <form className="comment-composer" onSubmit={submit}>
          <textarea
            className="input textarea"
            rows={compact ? 3 : 4}
            maxLength={2000}
            value={body}
            placeholder={taskId ? '写下对这个任务的评论…' : '写下项目评论，可用下方成员进行 @提及…'}
            aria-label="评论内容"
            onChange={(event) => setBody(event.target.value)}
          />
          {users.length > 0 ? (
            <fieldset className="mention-picker">
              <legend>提及成员</legend>
              <div className="mention-options">
                {users.map((option) => {
                  const active = mentions.includes(option.id);
                  return (
                    <label key={option.id} className={cx('mention-option', active && 'is-active')}>
                      <input
                        type="checkbox"
                        checked={active}
                        disabled={!active && mentions.length >= 10}
                        onChange={() => toggleMention(option.id)}
                      />
                      <span>{option.name}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ) : null}
          <div className="comment-composer-foot">
            <span className="comment-hint">
              {body.length > 0 ? `${body.length}/2000` : '支持 @提及项目成员，提及会发送站内通知'}
            </span>
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={busy || !body.trim()}
            >
              {busy ? <Spinner size={15} /> : <Icon name="mail" size={15} />}
              发表评论
            </button>
          </div>
        </form>
      ) : (
        <p className="comment-readonly">只读成员可以查看评论，但不能参与讨论。</p>
      )}

      {state.loading && !data ? (
        <div className="comment-skeletons">
          {[0, 1].map((index) => (
            <div key={index} className="comment-skeleton">
              <Skeleton height={32} width={32} radius={16} />
              <div>
                <Skeleton height={11} width="30%" />
                <Skeleton height={12} width="72%" />
              </div>
            </div>
          ))}
        </div>
      ) : comments.length === 0 ? (
        <EmptyState
          icon="mail"
          title="还没有评论"
          description={
            canComment
              ? '第一条评论会出现在这里，并同步到项目动态。'
              : '项目成员发表评论后会显示在这里。'
          }
          compact
        />
      ) : (
        <ul className="comment-list" aria-label="评论列表">
          {comments.map((comment) => {
            const canDelete = comment.author?.id === user?.id || canManage;
            return (
              <li key={comment.id} className="comment-item">
                <Avatar name={comment.author?.name ?? '已删除成员'} size={32} />
                <div className="comment-main">
                  <div className="comment-head">
                    <strong>{comment.author?.name ?? '已删除成员'}</strong>
                    <span>{formatDateTime(comment.createdAt)}</span>
                    {!taskId && comment.taskTitle ? (
                      <span className="comment-task">
                        <Icon name="projects" size={12} />
                        {comment.taskTitle}
                      </span>
                    ) : null}
                    {canDelete ? (
                      <button
                        type="button"
                        className="btn btn-icon btn-ghost btn-xs comment-delete"
                        aria-label="删除评论"
                        title="删除评论"
                        onClick={() => setDeleteTarget(comment)}
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    ) : null}
                  </div>
                  <p className="comment-body">{comment.body}</p>
                  {comment.mentions.length > 0 ? (
                    <p className="comment-mentions">
                      {comment.mentions.map((mention) => (
                        <span key={mention.id} className="mention-chip">
                          @{mention.name}
                        </span>
                      ))}
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除评论？"
        message="评论及其提及产生的通知会被移除，项目动态中会保留删除记录。"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void remove()}
        busy={deleting}
      />
    </div>
  );
}

export function TaskCommentsModal({
  projectId,
  task,
  users,
  canComment,
  canManage,
  onClose,
  onChanged,
}: {
  projectId: string;
  task: { id: string; title: string } | null;
  users: UserOption[];
  canComment: boolean;
  canManage: boolean;
  onClose: () => void;
  onChanged?: () => void;
}) {
  return (
    <Modal
      open={task !== null}
      onClose={onClose}
      title={task ? `任务评论 · ${task.title}` : '任务评论'}
      description="评论、@提及与站内通知会实时同步给项目成员。"
      wide
      footer={
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          关闭
        </button>
      }
    >
      {task ? (
        <CommentsPanel
          projectId={projectId}
          taskId={task.id}
          users={users}
          canComment={canComment}
          canManage={canManage}
          compact
          onChanged={onChanged}
        />
      ) : null}
    </Modal>
  );
}
