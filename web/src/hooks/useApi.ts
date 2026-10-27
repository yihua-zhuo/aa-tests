import { useCallback, useEffect, useRef, useState } from 'react';

export type ApiState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  lastUpdated: Date | null;
  reload: () => void;
  mutate: (updater: (current: T) => T) => void;
};

// A burst of activity events should result in a single reload wave. Subscribers
// share one timer so every mounted hook refreshes together after the burst.
const REFRESH_COALESCE_MS = 250;
let refreshTimer: number | null = null;
const refreshListeners = new Set<() => void>();

function scheduleLiveRefresh(): void {
  if (refreshTimer !== null) return;
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    for (const listener of refreshListeners) listener();
  }, REFRESH_COALESCE_MS);
}

function subscribeLiveRefresh(listener: () => void): () => void {
  refreshListeners.add(listener);
  if (refreshListeners.size === 1) {
    window.addEventListener('live:refresh', scheduleLiveRefresh);
  }
  return () => {
    refreshListeners.delete(listener);
    if (refreshListeners.size > 0) return;
    window.removeEventListener('live:refresh', scheduleLiveRefresh);
    if (refreshTimer !== null) {
      window.clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  };
}

export function useApi<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  options: { live?: boolean; skip?: boolean } = {},
): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!options.skip);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [version, setVersion] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const skip = options.skip === true;
  const live = options.live !== false;

  useEffect(() => {
    if (skip) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let active = true;
    setLoading(true);

    loadRef
      .current(controller.signal)
      .then((result) => {
        if (!active) return;
        setData(result);
        setError(null);
        setLastUpdated(new Date());
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : '加载失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [...deps, version, skip]);

  useEffect(() => {
    if (!live) return;
    return subscribeLiveRefresh(() => setVersion((current) => current + 1));
  }, [live]);

  useEffect(() => {
    const handleOnline = () => setVersion((current) => current + 1);
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, []);

  const reload = useCallback(() => setVersion((current) => current + 1), []);
  const mutate = useCallback((updater: (current: T) => T) => {
    setData((current) => (current === null ? current : updater(current)));
  }, []);

  return { data, error, loading, lastUpdated, reload, mutate };
}

export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

export type ToastTone = 'success' | 'error' | 'info';

export type ToastAction = {
  label: string;
  onClick: () => void | Promise<void>;
};

export type ToastItem = {
  id: number;
  message: string;
  tone: ToastTone;
  duration: number;
  action?: ToastAction;
};

const MAX_TOASTS = 4;

// Toasts live outside React so an undo prompt survives navigation (for example
// deleting a project and landing back on the list).
let toastSeq = 1;
let toastItems: ToastItem[] = [];
const toastListeners = new Set<(items: ToastItem[]) => void>();

function emitToasts(): void {
  for (const listener of toastListeners) listener(toastItems);
}

export function dismissToast(id: number): void {
  const next = toastItems.filter((item) => item.id !== id);
  if (next.length === toastItems.length) return;
  toastItems = next;
  emitToasts();
}

function pushToast(
  message: string,
  tone: ToastTone = 'success',
  options: { duration?: number; action?: ToastAction } = {},
): number {
  const id = toastSeq++;
  const item: ToastItem = {
    id,
    message,
    tone,
    duration: options.duration ?? (options.action ? 8_000 : 3_600),
    action: options.action,
  };
  toastItems = [...toastItems.slice(-(MAX_TOASTS - 1)), item];
  emitToasts();
  return id;
}

export function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>(toastItems);

  useEffect(() => {
    setToasts(toastItems);
    toastListeners.add(setToasts);
    return () => {
      toastListeners.delete(setToasts);
    };
  }, []);

  return { toasts, show: pushToast, dismiss: dismissToast };
}
