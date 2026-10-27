import { Hono } from 'hono';
import { PushSubscribeSchema, PushUnsubscribeSchema } from '../../shared/schemas.ts';
import type { PushStatus } from '../../shared/types.ts';
import type { AppEnv } from '../app-env.ts';
import { noStore, notFound, readBody } from '../http.ts';
import { currentUser } from '../middleware/auth.ts';
import type { PushSender } from '../push.ts';
import type { Store } from '../store.ts';

export function pushRoutes(store: Store, sender: PushSender): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/push', async (c) => {
    const session = currentUser(c);
    await sender.init();
    noStore(c);
    const status: PushStatus = {
      enabled: sender.enabled,
      publicKey: sender.publicKey,
      subscriptions: store.push.count(session.id),
    };
    return c.json(status);
  });

  app.post('/api/push/subscribe', async (c) => {
    const session = currentUser(c);
    const parsed = await readBody(c, PushSubscribeSchema);
    if (!parsed.ok) return parsed.response;
    await sender.init();
    if (!sender.enabled) return notFound(c, '当前部署未启用浏览器推送');
    const subscription = store.push.subscribe(
      session.id,
      {
        endpoint: parsed.data.endpoint,
        p256dh: parsed.data.keys.p256dh,
        auth: parsed.data.keys.auth,
      },
      c.req.header('user-agent') ?? null,
      store.now(),
    );
    noStore(c);
    return c.json({ id: subscription.id, endpoint: subscription.endpoint }, 201);
  });

  app.delete('/api/push/subscribe', async (c) => {
    const session = currentUser(c);
    const parsed = await readBody(c, PushUnsubscribeSchema);
    if (!parsed.ok) return parsed.response;
    store.push.unsubscribe(session.id, parsed.data.endpoint);
    noStore(c);
    return c.body(null, 204);
  });

  return app;
}
