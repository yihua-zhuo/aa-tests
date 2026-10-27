import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { PROJECT_STATUS_LABELS, ROLE_LABELS } from '../../../shared/permissions.ts';
import type { ProjectStatus, Role } from '../../../shared/types.ts';
import { initials } from '../format.ts';
import type { ToastItem } from '../hooks/useApi.ts';
import { Icon, type IconName } from './Icon.tsx';

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

export function Spinner({ size = 18 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />;
}

export function StatusBadge({ status }: { status: ProjectStatus }) {
  return (
    <span className="badge" data-tone={`status-${status}`}>
      <span className="badge-dot" aria-hidden="true" />
      {PROJECT_STATUS_LABELS[status]}
    </span>
  );
}

export function RoleBadge({ role }: { role: Role }) {
  return (
    <span className="badge" data-tone={`role-${role}`}>
      {ROLE_LABELS[role]}
    </span>
  );
}

export function DemoBadge({ label = 'Demo 数据' }: { label?: string }) {
  return (
    <span className="badge" data-tone="demo" title="此指标来自内置演示数据集，并非真实的业务收入">
      <span className="badge-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

const AVATAR_TONES = ['#6B4FE0', '#1F7058', '#B05230', '#3563BD', '#8A5C0E', '#7E4FB8'];

export function Avatar({
  name,
  src,
  size = 36,
  muted = false,
}: {
  name: string;
  src?: string | null;
  size?: number;
  muted?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const seed = [...name].reduce((sum, char) => sum + char.codePointAt(0)!, 0);
  const color = muted ? '#62627A' : AVATAR_TONES[seed % AVATAR_TONES.length];
  if (src && !failed) {
    return (
      <img
        className="avatar avatar-image"
        src={src}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      className="avatar"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(11, Math.round(size * 0.34)),
        background: color,
      }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

export function ProgressBar({
  value,
  tone = 'lilac',
  label,
}: {
  value: number;
  tone?: 'lilac' | 'mint' | 'peach' | 'sky';
  label?: string;
}) {
  const clamped = Math.min(100, Math.max(0, Math.round(value)));
  return (
    <div
      className="progress"
      data-tone={tone}
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ?? `进度 ${clamped}%`}
    >
      <span className="progress-fill" style={{ width: `${clamped}%` }} />
    </div>
  );
}

export function EmptyState({
  icon = 'spark',
  title,
  description,
  action,
  compact = false,
}: {
  icon?: IconName;
  title: string;
  description?: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={cx('empty-state', compact && 'is-compact')}>
      <span className="empty-icon" aria-hidden="true">
        <Icon name={icon} size={compact ? 22 : 28} />
      </span>
      <p className="empty-title">{title}</p>
      {description ? <p className="empty-copy">{description}</p> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
  compact = false,
}: {
  message: string;
  onRetry?: () => void;
  compact?: boolean;
}) {
  return (
    <div className={cx('error-state', compact && 'is-compact')} role="alert">
      <span className="error-icon" aria-hidden="true">
        <Icon name="alert" size={22} />
      </span>
      <div>
        <p className="error-title">加载失败</p>
        <p className="error-copy">{message}</p>
      </div>
      {onRetry ? (
        <button type="button" className="btn btn-soft btn-sm" onClick={onRetry}>
          <Icon name="refresh" size={15} />
          重试
        </button>
      ) : null}
    </div>
  );
}

export function Skeleton({
  height = 16,
  width = '100%',
  radius = 10,
}: {
  height?: number | string;
  width?: number | string;
  radius?: number;
}) {
  return <span className="skeleton" style={{ height, width, borderRadius: radius }} />;
}

export function CardSkeleton({ rows = 3, height = 210 }: { rows?: number; height?: number }) {
  return (
    <div className="card card-pad skeleton-card" style={{ minHeight: height }} aria-hidden="true">
      <Skeleton height={14} width="34%" />
      <Skeleton height={30} width="56%" />
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={12} width={`${90 - index * 12}%`} />
      ))}
    </div>
  );
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.offsetParent !== null || element === document.activeElement,
  );
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const items = focusableWithin(dialog);
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const outside = !dialog.contains(active);
      if (event.shiftKey && (active === first || outside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || outside)) {
        event.preventDefault();
        first.focus();
      }
    };

    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKeyDown);

    if (dialog) {
      const body = dialog.querySelector<HTMLElement>('.modal-body');
      const initial =
        (body ? focusableWithin(body)[0] : null) ?? focusableWithin(dialog)[0] ?? dialog;
      initial.focus();
    }

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previous;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={cx('modal', wide && 'is-wide')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="modal-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p className="modal-description">{description}</p> : null}
          </div>
          <button
            type="button"
            className="btn btn-icon btn-ghost"
            onClick={onClose}
            aria-label="关闭"
          >
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-foot">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '确认删除',
  onCancel,
  onConfirm,
  busy = false,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
  busy?: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn-danger" onClick={onConfirm} disabled={busy}>
            {busy ? <Spinner size={16} /> : <Icon name="trash" size={16} />}
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="confirm-copy">{message}</p>
    </Modal>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;

  const windowSize = 5;
  let start = Math.max(1, page - Math.floor(windowSize / 2));
  const end = Math.min(pages, start + windowSize - 1);
  start = Math.max(1, end - windowSize + 1);
  const numbers: number[] = [];
  for (let current = start; current <= end; current++) numbers.push(current);

  return (
    <nav className="pagination" aria-label="分页">
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => onChange(page - 1)}
        disabled={page <= 1}
      >
        <Icon name="chevronLeft" size={15} />
        上一页
      </button>
      <div className="pagination-pages">
        {start > 1 ? <span className="pagination-gap">…</span> : null}
        {numbers.map((number) => (
          <button
            key={number}
            type="button"
            className={cx('pagination-page', number === page && 'is-active')}
            onClick={() => onChange(number)}
            aria-current={number === page ? 'page' : undefined}
          >
            {number}
          </button>
        ))}
        {end < pages ? <span className="pagination-gap">…</span> : null}
      </div>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => onChange(page + 1)}
        disabled={page >= pages}
      >
        下一页
        <Icon name="chevronRight" size={15} />
      </button>
    </nav>
  );
}

export function Toaster({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return createPortal(
    <div className="toast-stack" role="region" aria-label="通知">
      {toasts.map((toast, index) => (
        <ToastCard
          key={toast.id}
          toast={toast}
          live={index === toasts.length - 1}
          onDismiss={onDismiss}
        />
      ))}
    </div>,
    document.body,
  );
}

function ToastCard({
  toast,
  live,
  onDismiss,
}: {
  toast: ToastItem;
  live: boolean;
  onDismiss: (id: number) => void;
}) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), toast.duration);
    return () => window.clearTimeout(timer);
  }, [toast.id, toast.duration, onDismiss]);

  return (
    <div
      className={cx(
        'toast',
        toast.tone === 'error' && 'is-error',
        toast.tone === 'info' && 'is-info',
      )}
      role={live ? (toast.tone === 'error' ? 'alert' : 'status') : undefined}
    >
      <span className="toast-icon" aria-hidden="true">
        <Icon name={toast.tone === 'error' ? 'alert' : 'check'} size={17} />
      </span>
      <span>{toast.message}</span>
      {toast.action ? (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            onDismiss(toast.id);
            void toast.action?.onClick();
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
      <button
        type="button"
        className="toast-close"
        onClick={() => onDismiss(toast.id)}
        aria-label="关闭提示"
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const [glider, setGlider] = useState({ x: 0, y: 0, width: 0, height: 0, ready: false });

  const measure = useCallback(() => {
    const item = itemRefs.current[activeIndex];
    if (!item) return;
    setGlider((current) => {
      const next = {
        x: item.offsetLeft,
        y: item.offsetTop,
        width: item.offsetWidth,
        height: item.offsetHeight,
        ready: true,
      };
      if (
        current.ready &&
        current.x === next.x &&
        current.y === next.y &&
        current.width === next.width &&
        current.height === next.height
      ) {
        return current;
      }
      return next;
    });
  }, [activeIndex]);

  useLayoutEffect(() => {
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    if (containerRef.current) observer.observe(containerRef.current);
    for (const item of itemRefs.current) {
      if (item) observer.observe(item);
    }
    return () => observer.disconnect();
  }, [measure]);

  return (
    <div ref={containerRef} className="segmented" role="group" aria-label={label}>
      <span
        className="segmented-glider"
        aria-hidden="true"
        style={{
          transform: `translate(${glider.x}px, ${glider.y}px)`,
          width: glider.width,
          height: glider.height,
          opacity: glider.ready ? 1 : 0,
          transition: glider.ready ? undefined : 'none',
        }}
      />
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(node) => {
            itemRefs.current[index] = node;
          }}
          type="button"
          className={cx('segmented-item', option.value === value && 'is-active')}
          onClick={() => onChange(option.value)}
          aria-pressed={option.value === value}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? (
        <p className="field-error">{error}</p>
      ) : hint ? (
        <p className="field-hint">{hint}</p>
      ) : null}
    </div>
  );
}

export function UpgradeCard() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <section className="upgrade-card">
        <span className="upgrade-glow" aria-hidden="true" />
        <span className="upgrade-icon" aria-hidden="true">
          <Icon name="rocket" size={22} />
        </span>
        <div className="upgrade-copy">
          <p className="upgrade-eyebrow">Clay Pro</p>
          <h3>解锁更多工作区</h3>
          <p>无限项目模板、自动化周报与团队级洞察。当前为本地演示版本，升级仅为概念展示。</p>
        </div>
        <button type="button" className="btn btn-white btn-sm" onClick={() => setOpen(true)}>
          了解详情
        </button>
      </section>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Clay Pro（概念展示）"
        footer={
          <button type="button" className="btn btn-primary" onClick={() => setOpen(false)}>
            我知道了
          </button>
        }
      >
        <p className="confirm-copy">
          这是一个本地演示应用，不包含真实支付流程。Clay Pro 仅用于展示升级卡片的设计形态：
          更多工作区、自动化报告与高级权限治理。所有数据仍保存在本机 SQLite 中。
        </p>
      </Modal>
    </>
  );
}

export function ClayDecor() {
  return (
    <div className="clay-decor" aria-hidden="true">
      <span className="clay-orb clay-orb-a" />
      <span className="clay-orb clay-orb-b" />
      <span className="clay-orb clay-orb-c" />
      <span className="clay-ring" />
      <span className="clay-dot" />
    </div>
  );
}
