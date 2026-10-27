import { Hono } from 'hono';
import { NotificationQuerySchema, NotificationReadSchema } from '../../shared/schemas.ts';
import type { AppEnv } from '../app-env.ts';
import { noStore, readBody, readQuery } from '../http.ts';
import { currentUser } from '../middleware/auth.ts';
import type { Store } from '../store.ts';

export function notificationRoutes(store: Store): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/notifications', (c) => {
    const user = currentUser(c);
    const parsed = readQuery(c, NotificationQuerySchema);
    if (!parsed.ok) return parsed.response;
    noStore(c);
    return c.json(store.notifications.list(user.id, parsed.data.limit ?? 20));
  });

  app.post('/api/notifications/read', async (c) => {
    const user = currentUser(c);
    const parsed = await readBody(c, NotificationReadSchema);
    if (!parsed.ok) return parsed.response;
    const unread = store.notifications.markRead(user.id, parsed.data);
    noStore(c);
    return c.json({ unread });
  });

  return app;
}
