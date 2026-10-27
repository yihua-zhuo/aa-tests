import { Hono } from 'hono';
import { ActivityQuerySchema } from '../../shared/schemas.ts';
import type { AppEnv } from '../app-env.ts';
import { noStore, readQuery } from '../http.ts';
import { currentUser } from '../middleware/auth.ts';
import type { Store } from '../store.ts';

export function activityRoutes(store: Store): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/activities', (c) => {
    const parsed = readQuery(c, ActivityQuerySchema);
    if (!parsed.ok) return parsed.response;
    const user = currentUser(c);

    noStore(c);
    return c.json(
      store.activities.page(user.role, user.id, {
        cursor: parsed.data.cursor,
        limit: parsed.data.limit,
        projectId: parsed.data.projectId,
        type: parsed.data.type || undefined,
      }),
    );
  });

  return app;
}
