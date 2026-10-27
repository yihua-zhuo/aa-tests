import { useRef, useState } from 'react';
import type { Attachment } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { formatDateTime } from '../format.ts';
import { useApi } from '../hooks/useApi.ts';
import { Icon } from './Icon.tsx';
import { Avatar, ConfirmDialog, cx, EmptyState, ErrorState, Skeleton, Spinner } from './ui.tsx';

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function AttachmentsPanel({
  projectId,
  canUpload,
  canManage,
  currentUserId,
  show,
}: {
  projectId: string;
  canUpload: boolean;
  canManage: boolean;
  currentUserId: string | undefined;
  show: (message: string, tone?: 'success' | 'error' | 'info') => void;
}) {
  const state = useApi((signal) => api.attachments(projectId, signal), [projectId]);
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Attachment | null>(null);
  const [deleting, setDeleting] = useState(false);

  const upload = async (file: File | undefined) => {
    if (!file || uploading) return;
    if (file.size > 10_000_000) {
      show('单个附件不能超过 10MB', 'error');
      return;
    }
    setUploading(true);
    try {
      await api.uploadAttachment(projectId, file);
      show(`已上传「${file.name}」`);
      state.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '上传失败', 'error');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const remove = async () => {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    try {
      await api.deleteAttachment(projectId, pendingDelete.id);
      show(`已删除「${pendingDelete.name}」`);
      setPendingDelete(null);
      state.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '删除失败', 'error');
    } finally {
      setDeleting(false);
    }
  };

  const limits = state.data?.limits;
  const usage = state.data?.usage;

  return (
    <section className="card card-pad">
      <header className="card-head">
        <div>
          <h2>附件</h2>
          <p className="card-sub">
            支持图片、PDF、文本、CSV、JSON 与 Office 文档，单个不超过 10MB，链接 10 分钟内有效。
          </p>
        </div>
        <span className="count-pill">{state.data?.attachments.length ?? 0}</span>
      </header>

      {canUpload ? (
        <div className="attachment-upload">
          <input
            ref={inputRef}
            id="attachment-file"
            className="visually-hidden"
            type="file"
            accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.csv,.json,.zip,.docx,.xlsx,.pptx"
            onChange={(event) => void upload(event.target.files?.[0])}
          />
          <label
            htmlFor="attachment-file"
            className={cx('btn btn-soft btn-sm', uploading && 'is-disabled')}
            aria-disabled={uploading}
          >
            {uploading ? <Spinner size={15} /> : <Icon name="upload" size={15} />}
            {uploading ? '上传中…' : '上传附件'}
          </label>
          {limits && usage ? (
            <span className="attachment-usage">
              {usage.count}/{limits.maxCount} 个 · {formatBytes(usage.totalBytes)} /{' '}
              {formatBytes(limits.maxTotalBytes)}
            </span>
          ) : null}
        </div>
      ) : null}

      {state.loading && !state.data ? (
        <div className="attachment-skeleton">
          <Skeleton height={44} />
          <Skeleton height={44} />
        </div>
      ) : state.error ? (
        <ErrorState message={state.error} onRetry={state.reload} compact />
      ) : state.data && state.data.attachments.length > 0 ? (
        <ul className="attachment-list">
          {state.data.attachments.map((item) => {
            const removable = canManage || (currentUserId && item.uploader?.id === currentUserId);
            return (
              <li key={item.id} className="attachment-item">
                <span className="attachment-icon" aria-hidden="true">
                  <Icon name="file" size={18} />
                </span>
                <div className="attachment-copy">
                  <a
                    className="attachment-name"
                    href={item.downloadUrl}
                    download={item.name}
                    rel="noreferrer"
                  >
                    {item.name}
                  </a>
                  <span className="attachment-meta">
                    {formatBytes(item.size)} · {formatDateTime(item.createdAt)}
                    {item.uploader ? (
                      <>
                        {' · '}
                        <Avatar name={item.uploader.name} size={16} /> {item.uploader.name}
                      </>
                    ) : null}
                  </span>
                </div>
                <a
                  className="btn btn-icon btn-ghost btn-sm"
                  href={item.downloadUrl}
                  download={item.name}
                  aria-label={`下载 ${item.name}`}
                >
                  <Icon name="download" size={16} />
                </a>
                {removable ? (
                  <button
                    type="button"
                    className="btn btn-icon btn-ghost btn-sm"
                    onClick={() => setPendingDelete(item)}
                    aria-label={`删除 ${item.name}`}
                  >
                    <Icon name="trash" size={16} />
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState
          icon="folder"
          title="还没有附件"
          description={
            canUpload
              ? '上传需求文档、设计稿或数据文件与团队共享。'
              : '成员上传的文件会显示在这里。'
          }
          compact
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除附件"
        message={`确定删除「${pendingDelete?.name ?? ''}」吗？此操作不可撤销。`}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void remove()}
        busy={deleting}
      />
    </section>
  );
}
