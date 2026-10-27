import { randomBytes } from 'node:crypto';
import { canAccessProject } from '../../shared/permissions.ts';
import type {
  ActivityItem,
  Role,
  Webhook,
  WebhookDelivery,
  WebhookEvent,
  WebhookStatus,
} from '../../shared/types.ts';
import { WEBHOOK_EVENTS } from '../../shared/types.ts';
import type { Database } from '../db.ts';
import type { ProjectsStore } from './projects.ts';

type WebhookRow = {
  id: string;
  url: string;
  events: string;
  active: number;
  created_at: string;
  last_status: string | null;
  last_delivery_at: string | null;
};

type DeliveryRow = {
  id: string;
  webhook_id: string;
  event: string;
  payload: string;
  attempts: number;
  url: string;
  secret: string;
};

type OwnerRow = {
  id: string;
  user_id: string;
  events: string;
  role: string;
  status: string;
};

function parseEvents(raw: string): WebhookEvent[] {
  try {
    const values = JSON.parse(raw) as unknown;
    if (!Array.isArray(values)) return [];
    return values.filter((value): value is WebhookEvent =>
      (WEBHOOK_EVENTS as readonly string[]).includes(value as string),
    );
  } catch {
    return [];
  }
}

function normalizeEvents(events: readonly WebhookEvent[]): WebhookEvent[] {
  const unique = new Set(events.filter((event) => WEBHOOK_EVENTS.includes(event)));
  return WEBHOOK_EVENTS.filter((event) => unique.has(event));
}

function toWebhook(row: WebhookRow): Webhook {
  return {
    id: row.id,
    url: row.url,
    events: parseEvents(row.events),
    active: row.active === 1,
    createdAt: row.created_at,
    lastStatus:
      row.last_status === 'pending' || row.last_status === 'sent' || row.last_status === 'failed'
        ? (row.last_status as WebhookStatus)
        : null,
    lastDeliveryAt: row.last_delivery_at,
  };
}

export class WebhooksStore {
  readonly #db: Database;
  readonly #projects: ProjectsStore;

  constructor(db: Database, projects: ProjectsStore) {
    this.#db = db;
    this.#projects = projects;
  }

  list(userId: string): Webhook[] {
    const rows = this.#db
      .stmt(
        `SELECT w.id, w.url, w.events, w.active, w.created_at,
                (SELECT d.status FROM webhook_deliveries d
                  WHERE d.webhook_id = w.id ORDER BY d.created_at DESC LIMIT 1) AS last_status,
                (SELECT d.created_at FROM webhook_deliveries d
                  WHERE d.webhook_id = w.id ORDER BY d.created_at DESC LIMIT 1) AS last_delivery_at
         FROM webhooks w WHERE w.user_id = ?
         ORDER BY w.created_at DESC`,
      )
      .all(userId) as unknown as WebhookRow[];
    return rows.map(toWebhook);
  }

  get(userId: string, id: string): Webhook | null {
    const row = this.#db
      .stmt(
        `SELECT w.id, w.url, w.events, w.active, w.created_at,
                (SELECT d.status FROM webhook_deliveries d
                  WHERE d.webhook_id = w.id ORDER BY d.created_at DESC LIMIT 1) AS last_status,
                (SELECT d.created_at FROM webhook_deliveries d
                  WHERE d.webhook_id = w.id ORDER BY d.created_at DESC LIMIT 1) AS last_delivery_at
         FROM webhooks w WHERE w.id = ? AND w.user_id = ?`,
      )
      .get(id, userId) as unknown as WebhookRow | undefined;
    return row ? toWebhook(row) : null;
  }

  create(
    userId: string,
    input: { url: string; events: readonly WebhookEvent[] },
    now = new Date(),
  ): { webhook: Webhook; secret: string } {
    const id = crypto.randomUUID();
    const url = new URL(input.url).href;
    const secret = `whsec_${randomBytes(32).toString('base64url')}`;
    const createdAt = now.toISOString();
    this.#db
      .stmt(
        `INSERT INTO webhooks (id, user_id, url, secret, events, active, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(id, userId, url, secret, JSON.stringify(normalizeEvents(input.events)), createdAt);
    const webhook = this.get(userId, id);
    if (!webhook) throw new Error('webhook creation failed');
    return { webhook, secret };
  }

  update(
    userId: string,
    id: string,
    patch: { url?: string; events?: readonly WebhookEvent[]; active?: boolean },
  ): Webhook | null {
    const sets: string[] = [];
    const params: (string | number)[] = [];
    if (patch.url !== undefined) {
      sets.push('url = ?');
      params.push(new URL(patch.url).href);
    }
    if (patch.events !== undefined) {
      sets.push('events = ?');
      params.push(JSON.stringify(normalizeEvents(patch.events)));
    }
    if (patch.active !== undefined) {
      sets.push('active = ?');
      params.push(patch.active ? 1 : 0);
    }
    if (sets.length === 0) return this.get(userId, id);
    params.push(id, userId);
    const result = this.#db
      .stmt(`UPDATE webhooks SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
      .run(...params);
    if (Number(result.changes) === 0) return null;
    return this.get(userId, id);
  }

  remove(userId: string, id: string): boolean {
    const result = this.#db
      .stmt('DELETE FROM webhooks WHERE id = ? AND user_id = ?')
      .run(id, userId);
    return Number(result.changes) > 0;
  }

  deliveries(userId: string, id: string, limit = 20): WebhookDelivery[] | null {
    const webhook = this.get(userId, id);
    if (!webhook) return null;
    const rows = this.#db
      .stmt(
        `SELECT id, event, status, attempts, response_status, created_at, updated_at
         FROM webhook_deliveries WHERE webhook_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(id, Math.min(Math.max(limit, 1), 50)) as unknown as {
      id: string;
      event: string;
      status: string;
      attempts: number;
      response_status: number | null;
      created_at: string;
      updated_at: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      event: row.event as WebhookEvent,
      status: row.status as WebhookStatus,
      attempts: Number(row.attempts),
      responseStatus: row.response_status === null ? null : Number(row.response_status),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /** Queues one delivery per matching webhook whose owner can see the project. */
  enqueue(activity: ActivityItem, now = new Date()): number {
    if (!activity.project) return 0;
    const access = this.#projects.access(activity.project.id);
    if (!access) return 0;
    const owners = this.#db
      .stmt(
        `SELECT w.id, w.user_id, w.events, u.role, u.status
         FROM webhooks w JOIN users u ON u.id = w.user_id
         WHERE w.active = 1`,
      )
      .all() as unknown as OwnerRow[];
    let queued = 0;
    for (const owner of owners) {
      if (owner.status !== 'active') continue;
      if (!parseEvents(owner.events).includes(activity.type as WebhookEvent)) continue;
      if (!canAccessProject(owner.role as Role, owner.user_id, access)) continue;
      const deliveryId = crypto.randomUUID();
      const payload = JSON.stringify({
        id: deliveryId,
        event: activity.type,
        createdAt: activity.createdAt,
        activity: {
          seq: activity.seq,
          type: activity.type,
          message: activity.message,
          actor: activity.actor,
          project: activity.project,
          meta: activity.meta,
        },
      });
      const at = now.toISOString();
      this.#db
        .stmt(
          `INSERT INTO webhook_deliveries
             (id, webhook_id, event, payload, status, attempts, next_attempt_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
        )
        .run(deliveryId, owner.id, activity.type, payload, at, at, at);
      queued++;
    }
    return queued;
  }

  due(
    now = new Date(),
    limit = 20,
  ): {
    id: string;
    webhookId: string;
    event: WebhookEvent;
    payload: string;
    attempts: number;
    url: string;
    secret: string;
  }[] {
    const rows = this.#db
      .stmt(
        `SELECT d.id, d.webhook_id, d.event, d.payload, d.attempts, w.url, w.secret
         FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
         WHERE d.status = 'pending' AND d.next_attempt_at <= ? AND w.active = 1
         ORDER BY d.next_attempt_at ASC LIMIT ?`,
      )
      .all(now.toISOString(), Math.min(Math.max(limit, 1), 100)) as unknown as DeliveryRow[];
    return rows.map((row) => ({
      id: row.id,
      webhookId: row.webhook_id,
      event: row.event as WebhookEvent,
      payload: row.payload,
      attempts: Number(row.attempts),
      url: row.url,
      secret: row.secret,
    }));
  }

  markSent(id: string, statusCode: number, now = new Date()): void {
    this.#db
      .stmt(
        `UPDATE webhook_deliveries
         SET status = 'sent', attempts = attempts + 1, response_status = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(statusCode, now.toISOString(), id);
  }

  markRetry(
    id: string,
    attempts: number,
    nextAttemptAt: string,
    statusCode: number | null,
    now = new Date(),
  ): void {
    this.#db
      .stmt(
        `UPDATE webhook_deliveries
         SET status = 'pending', attempts = ?, next_attempt_at = ?, response_status = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(attempts, nextAttemptAt, statusCode, now.toISOString(), id);
  }

  markFailed(id: string, attempts: number, statusCode: number | null, now = new Date()): void {
    this.#db
      .stmt(
        `UPDATE webhook_deliveries
         SET status = 'failed', attempts = ?, response_status = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(attempts, statusCode, now.toISOString(), id);
  }
}
