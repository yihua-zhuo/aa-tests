/** Read-only snapshots of safe GET responses, scoped to the signed-in user. */
const USER_KEY = 'pulse:snapshot-user';
const INDEX_KEY = 'pulse:snapshot-index';
const SNAPSHOT_PREFIX = 'pulse:snapshot:';
const MAX_ENTRIES = 30;
const MAX_BYTES = 300_000;

type SnapshotEntry = { url: string; at: number };

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function snapshotUserId(): string | null {
  return storage()?.getItem(USER_KEY) ?? null;
}

export function setSnapshotUserId(userId: string | null): void {
  const store = storage();
  if (!store) return;
  if (userId) store.setItem(USER_KEY, userId);
  else store.removeItem(USER_KEY);
}

function readIndex(store: Storage): SnapshotEntry[] {
  try {
    const parsed = JSON.parse(store.getItem(INDEX_KEY) ?? '[]') as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is SnapshotEntry =>
            Boolean(entry) &&
            typeof entry === 'object' &&
            typeof (entry as SnapshotEntry).url === 'string',
        )
      : [];
  } catch {
    return [];
  }
}

function keyFor(userId: string, url: string): string {
  return `${SNAPSHOT_PREFIX}${userId}:${url}`;
}

export function isSnapshotPath(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  if (path === '/api/auth/me') return true;
  if (
    path === '/api/dashboard/summary' ||
    path === '/api/projects' ||
    path === '/api/notifications' ||
    path === '/api/workspace' ||
    path === '/api/profile' ||
    path === '/api/saved-views' ||
    path === '/api/users/options' ||
    path === '/api/activities' ||
    path === '/api/analytics/sources' ||
    path === '/api/analytics/revenue' ||
    path === '/api/analytics/channels' ||
    path === '/api/analytics/audience'
  ) {
    return true;
  }
  return /^\/api\/projects\/[0-9a-f-]{36}$/i.test(path);
}

export function writeSnapshot(url: string, data: unknown): void {
  if (!isSnapshotPath(url)) return;
  const userId = snapshotUserId();
  const store = storage();
  if (!userId || !store) return;
  let text: string;
  try {
    text = JSON.stringify(data);
  } catch {
    return;
  }
  if (text.length > MAX_BYTES) return;
  try {
    store.setItem(keyFor(userId, url), text);
    const index = readIndex(store).filter((entry) => entry.url !== url);
    index.push({ url, at: Date.now() });
    while (index.length > MAX_ENTRIES) {
      const dropped = index.shift();
      if (dropped) store.removeItem(keyFor(userId, dropped.url));
    }
    store.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // Quota errors must never break the live request.
  }
}

export function readSnapshot<T>(url: string): T | null {
  const userId = snapshotUserId();
  const store = storage();
  if (!userId || !store) return null;
  const text = store.getItem(keyFor(userId, url));
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function clearSnapshots(): void {
  const store = storage();
  if (!store) return;
  const keys: string[] = [];
  for (let index = 0; index < store.length; index++) {
    const key = store.key(index);
    if (key?.startsWith(SNAPSHOT_PREFIX)) keys.push(key);
  }
  for (const key of keys) store.removeItem(key);
  store.removeItem(INDEX_KEY);
  store.removeItem(USER_KEY);
}

export function primeSessionSnapshot(data: unknown): void {
  if (!data || typeof data !== 'object') return;
  const user = (data as { user?: { id?: unknown } }).user;
  if (!user || typeof user.id !== 'string') return;
  setSnapshotUserId(user.id);
  writeSnapshot('/api/auth/me', data);
}

let snapshotFallback = false;

export function snapshotFallbackActive(): boolean {
  return snapshotFallback;
}

export function notifySnapshotFallback(): void {
  snapshotFallback = true;
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('pulse:offline-snapshot'));
}
