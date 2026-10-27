import type { Context } from 'hono';
import { canManageWorkspace, canViewAllProjects } from '../../shared/permissions.ts';
import type { SessionUser, UserOption } from '../../shared/types.ts';
import type { AppEnv } from '../app-env.ts';
import { publishActivity } from '../realtime.ts';
import type { EventHub } from '../sse.ts';
import type { Store } from '../store.ts';

export function actorOf(user: SessionUser): UserOption {
  return { id: user.id, name: user.name };
}

export function workspaceOf(user: SessionUser): string {
  return user.workspaceId ?? 'ws_default';
}

export function visibleProjectIds(store: Store, user: SessionUser): Set<string> | null {
  if (canViewAllProjects(user.role, user.permissions)) return null;
  return store.projects.visibleProjectIds(user.role, user.id);
}

export function canWriteWorkspace(user: SessionUser): boolean {
  return (
    canViewAllProjects(user.role, user.permissions) ||
    canManageWorkspace(user.role, user.permissions)
  );
}

export function publishLatest(store: Store, hub: EventHub): void {
  const activity = store.activities.latest();
  if (activity) publishActivity(hub, store, activity);
}

export function conflict(c: Context<AppEnv>, message: string, current: unknown): Response {
  c.header('Cache-Control', 'no-store');
  return c.json({ error: 'conflict', message, current }, 409);
}
