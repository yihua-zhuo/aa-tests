import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSnapshots,
  isSnapshotPath,
  notifySnapshotFallback,
  primeSessionSnapshot,
  readSnapshot,
  setSnapshotUserId,
  snapshotUserId,
  writeSnapshot,
} from './offline.ts';

const projectPath = (index: number) =>
  `/api/projects/00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;

describe('offline snapshots', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('allows only safe read-only endpoints', () => {
    expect(isSnapshotPath('/api/dashboard/summary')).toBe(true);
    expect(isSnapshotPath('/api/notifications?limit=20')).toBe(true);
    expect(isSnapshotPath(projectPath(1))).toBe(true);
    expect(isSnapshotPath('/api/projects/not-a-uuid')).toBe(false);
    expect(isSnapshotPath('/api/audit')).toBe(false);
    expect(isSnapshotPath('/api/projects/00000000-0000-4000-8000-000000000000/tasks')).toBe(false);
  });

  it('requires a signed-in user and scopes entries per user', () => {
    writeSnapshot('/api/dashboard/summary', { total: 3 });
    expect(readSnapshot('/api/dashboard/summary')).toBeNull();

    setSnapshotUserId('user-a');
    writeSnapshot('/api/dashboard/summary', { total: 3 });
    expect(readSnapshot<{ total: number }>('/api/dashboard/summary')).toEqual({ total: 3 });
    expect(snapshotUserId()).toBe('user-a');

    setSnapshotUserId('user-b');
    expect(readSnapshot('/api/dashboard/summary')).toBeNull();
  });

  it('ignores oversized payloads and unsupported paths', () => {
    setSnapshotUserId('user-a');
    writeSnapshot('/api/dashboard/summary', { blob: 'x'.repeat(310_000) });
    expect(readSnapshot('/api/dashboard/summary')).toBeNull();
    writeSnapshot('/api/audit', { entries: [] });
    expect(readSnapshot('/api/audit')).toBeNull();
  });

  it('keeps the newest thirty entries', () => {
    setSnapshotUserId('user-a');
    for (let index = 0; index < 31; index++) {
      writeSnapshot(projectPath(index), { index });
    }
    expect(readSnapshot(projectPath(0))).toBeNull();
    expect(readSnapshot<{ index: number }>(projectPath(30))).toEqual({ index: 30 });
    const cached: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith('pulse:snapshot:user-a:')) cached.push(key);
    }
    expect(cached).toHaveLength(30);
  });

  it('primes the session snapshot and clears everything on sign-out', () => {
    const state = {
      user: { id: 'user-a', name: 'Ada' },
      preferences: {},
      workspace: null,
    };
    primeSessionSnapshot(state);
    expect(snapshotUserId()).toBe('user-a');
    expect(readSnapshot('/api/auth/me')).toEqual(state);

    clearSnapshots();
    expect(snapshotUserId()).toBeNull();
    expect(readSnapshot('/api/auth/me')).toBeNull();
    expect(Object.keys(localStorage)).toHaveLength(0);
  });

  it('announces cached fallbacks to the banner', () => {
    const listener = vi.fn();
    window.addEventListener('pulse:offline-snapshot', listener);
    notifySnapshotFallback();
    window.removeEventListener('pulse:offline-snapshot', listener);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
