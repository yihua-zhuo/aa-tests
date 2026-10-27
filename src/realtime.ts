import { canAccessProject, canViewAllProjects } from '../shared/permissions.ts';
import type { ActivityItem, Role } from '../shared/types.ts';
import type { EventHub } from './sse.ts';
import type { Store } from './store.ts';

export function canSeeActivity(
  store: Store,
  activity: ActivityItem,
  role: Role,
  userId: string,
): boolean {
  if (activity.project) {
    const access = store.projects.access(activity.project.id);
    if (!access) return canViewAllProjects(role);
    return canAccessProject(role, userId, access);
  }
  return canViewAllProjects(role);
}

export function publishActivity(hub: EventHub, store: Store, activity: ActivityItem): void {
  store.webhooks.enqueue(activity);
  const projectId = activity.project?.id ?? null;
  if (!projectId) {
    hub.broadcast('activity', { activity }, activity.seq, {
      canSee: (role) => canViewAllProjects(role),
    });
    return;
  }

  const access = store.projects.access(projectId);
  if (!access) {
    hub.broadcast('activity', { activity }, activity.seq, {
      canSee: (role) => canViewAllProjects(role),
    });
    return;
  }

  hub.broadcast('activity', { activity }, activity.seq, {
    canSee: (role, userId) => canAccessProject(role, userId, access),
  });
}

export function publishVisibility(hub: EventHub): void {
  hub.broadcast('visibility.changed', { at: new Date().toISOString() });
}
