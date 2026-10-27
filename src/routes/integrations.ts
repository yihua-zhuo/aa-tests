import { Hono } from 'hono';
import {
  TokenCreateSchema,
  WebhookCreateSchema,
  WebhookUpdateSchema,
} from '../../shared/schemas.ts';
import { WEBHOOK_EVENTS } from '../../shared/types.ts';
import type { AppEnv } from '../app-env.ts';
import { noStore, notFound, readBody } from '../http.ts';
import { currentUser } from '../middleware/auth.ts';
import { contextIp } from '../net.ts';
import type { Store } from '../store.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}

export function integrationRoutes(
  store: Store,
  trustProxy: boolean,
  quota: { max: number; windowSeconds: number },
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/profile/tokens', (c) => {
    const user = currentUser(c);
    noStore(c);
    return c.json({ tokens: store.tokens.list(user.id), quota });
  });

  app.post('/api/profile/tokens', async (c) => {
    const user = currentUser(c);
    const parsed = await readBody(c, TokenCreateSchema);
    if (!parsed.ok) return parsed.response;
    const created = store.tokens.create(user.id, {
      name: parsed.data.name,
      scopes: parsed.data.scopes,
      expiresInDays: parsed.data.expiresInDays,
    });
    store.audit.record({
      actor: { id: user.id, name: user.name },
      action: 'token.created',
      target: parsed.data.name,
      ip: contextIp(c, trustProxy),
      detail: {
        tokenId: created.item.id,
        scopes: created.item.scopes,
        expiresAt: created.item.expiresAt,
      },
    });
    noStore(c);
    return c.json(created, 201);
  });

  app.delete('/api/profile/tokens/:id', (c) => {
    const user = currentUser(c);
    const id = c.req.param('id');
    if (!UUID.test(id)) return notFound(c, '令牌不存在');
    const token = store.tokens.list(user.id).find((item) => item.id === id);
    if (!token || !store.tokens.revoke(user.id, id)) return notFound(c, '令牌不存在或已吊销');
    store.audit.record({
      actor: { id: user.id, name: user.name },
      action: 'token.revoked',
      target: token.name,
      ip: contextIp(c, trustProxy),
      detail: { tokenId: id },
    });
    noStore(c);
    return c.body(null, 204);
  });

  app.get('/api/profile/webhooks', (c) => {
    const user = currentUser(c);
    noStore(c);
    return c.json({ webhooks: store.webhooks.list(user.id), events: WEBHOOK_EVENTS });
  });

  app.post('/api/profile/webhooks', async (c) => {
    const user = currentUser(c);
    const parsed = await readBody(c, WebhookCreateSchema);
    if (!parsed.ok) return parsed.response;
    const created = store.webhooks.create(user.id, {
      url: parsed.data.url,
      events: parsed.data.events,
    });
    store.audit.record({
      actor: { id: user.id, name: user.name },
      action: 'webhook.created',
      target: hostOf(created.webhook.url),
      ip: contextIp(c, trustProxy),
      detail: { webhookId: created.webhook.id, events: created.webhook.events },
    });
    noStore(c);
    return c.json(created, 201);
  });

  app.patch('/api/profile/webhooks/:id', async (c) => {
    const user = currentUser(c);
    const id = c.req.param('id');
    if (!UUID.test(id)) return notFound(c, 'Webhook 不存在');
    const parsed = await readBody(c, WebhookUpdateSchema);
    if (!parsed.ok) return parsed.response;
    const updated = store.webhooks.update(user.id, id, parsed.data);
    if (!updated) return notFound(c, 'Webhook 不存在');
    store.audit.record({
      actor: { id: user.id, name: user.name },
      action: 'webhook.updated',
      target: hostOf(updated.url),
      ip: contextIp(c, trustProxy),
      detail: { webhookId: id, fields: Object.keys(parsed.data), active: updated.active },
    });
    noStore(c);
    return c.json(updated);
  });

  app.delete('/api/profile/webhooks/:id', (c) => {
    const user = currentUser(c);
    const id = c.req.param('id');
    if (!UUID.test(id)) return notFound(c, 'Webhook 不存在');
    const webhook = store.webhooks.get(user.id, id);
    if (!webhook || !store.webhooks.remove(user.id, id)) return notFound(c, 'Webhook 不存在');
    store.audit.record({
      actor: { id: user.id, name: user.name },
      action: 'webhook.deleted',
      target: hostOf(webhook.url),
      ip: contextIp(c, trustProxy),
      detail: { webhookId: id },
    });
    noStore(c);
    return c.body(null, 204);
  });

  app.get('/api/profile/webhooks/:id/deliveries', (c) => {
    const user = currentUser(c);
    const id = c.req.param('id');
    if (!UUID.test(id)) return notFound(c, 'Webhook 不存在');
    const limit = Number(c.req.query('limit') ?? 20);
    const deliveries = store.webhooks.deliveries(user.id, id, Number.isFinite(limit) ? limit : 20);
    if (!deliveries) return notFound(c, 'Webhook 不存在');
    noStore(c);
    return c.json({ deliveries });
  });

  return app;
}
