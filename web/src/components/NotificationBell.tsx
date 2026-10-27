import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AppNotification } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { Icon, type IconName } from '../components/Icon.tsx';
import { cx, EmptyState, Spinner } from '../components/ui.tsx';
import { formatDateTime } from '../format.ts';
import { useApi } from '../hooks/useApi.ts';

const TYPE_ICONS: Record<AppNotification['type'], IconName> = {
  mention: 'mail',
  comment: 'mail',
  task_assigned: 'userPlus',
  weekly_digest: 'calendar',
};

export function NotificationBell() {
  const navigate = useNavigate();
  const state = useApi((signal) => api.notifications(20, signal), []);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const unread = state.data?.unread ?? 0;
  const notifications = state.data?.notifications ?? [];

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const markAll = async () => {
    if (busy || unread === 0) return;
    setBusy(true);
    setError(null);
    try {
      await api.markNotificationsRead({ all: true });
      state.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };

  const openNotification = async (notification: AppNotification) => {
    setError(null);
    setOpen(false);
    if (!notification.readAt) {
      try {
        await api.markNotificationsRead({ ids: [notification.id] });
        state.reload();
      } catch {
        // Navigation should still work when the read marker fails.
      }
    }
    if (notification.link) navigate(notification.link);
  };

  return (
    <div className="notification-center" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className={cx('btn btn-icon btn-ghost notification-button', open && 'is-open')}
        aria-label={unread > 0 ? `通知中心，${unread} 条未读` : '通知中心'}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="bell" size={19} />
        {unread > 0 ? (
          <span className="notification-badge" aria-hidden="true">
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="notification-panel" id={panelId} role="dialog" aria-label="通知中心">
          <header className="notification-head">
            <div>
              <strong>通知中心</strong>
              <span>{unread > 0 ? `${unread} 条未读` : '全部已读'}</span>
            </div>
            {unread > 0 ? (
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                onClick={() => void markAll()}
                disabled={busy}
              >
                {busy ? <Spinner size={13} /> : <Icon name="check" size={13} />}
                全部已读
              </button>
            ) : null}
          </header>

          {error ? (
            <p className="notification-error" role="alert">
              {error}
            </p>
          ) : null}

          {state.loading && !state.data ? (
            <div className="notification-empty">
              <Spinner size={18} />
            </div>
          ) : notifications.length === 0 ? (
            <EmptyState
              icon="bell"
              title="暂无通知"
              description="被 @ 提及或负责的任务有新评论时，会出现在这里。"
              compact
            />
          ) : (
            <ul className="notification-list">
              {notifications.map((notification) => (
                <li key={notification.id}>
                  <button
                    type="button"
                    className={cx('notification-item', !notification.readAt && 'is-unread')}
                    onClick={() => void openNotification(notification)}
                  >
                    <span className="notification-icon" aria-hidden="true">
                      <Icon name={TYPE_ICONS[notification.type]} size={16} />
                    </span>
                    <span className="notification-copy">
                      <strong>{notification.title}</strong>
                      {notification.body ? <small>{notification.body}</small> : null}
                      <time>{formatDateTime(notification.createdAt)}</time>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
