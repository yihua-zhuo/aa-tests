import { Hono } from 'hono';
import { canViewUserDirectory } from '../../shared/permissions.ts';
import { SearchQuerySchema } from '../../shared/schemas.ts';
import type { AppEnv } from '../app-env.ts';
import { noStore, readQuery } from '../http.ts';
import { currentUser } from '../middleware/auth.ts';
import type { Store } from '../store.ts';

export function searchRoutes(store: Store): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/search', (c) => {
    const parsed = readQuery(c, SearchQuerySchema);
    if (!parsed.ok) return parsed.response;
    const user = currentUser(c);
    const q = parsed.data.q;

    const projects = store.projects.list(user.role, user.id, {
      q,
      status: 'all',
      owner: 'all',
      sort: 'updated',
      page: 1,
      pageSize: 6,
    });

    const users = canViewUserDirectory(user.role, user.permissions)
      ? store.users.list({ q, role: 'all', status: 'all', page: 1, pageSize: 5 }).users
      : [];

    noStore(c);
    return c.json({
      projects: projects.projects.map((project) => ({
        id: project.id,
        name: project.name,
        status: project.status,
        progress: project.progress,
      })),
      activities: store.activities.search(user.role, user.id, q, 6),
      users,
    });
  });

  return app;
}
