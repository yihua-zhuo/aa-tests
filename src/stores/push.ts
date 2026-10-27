import type { Database } from '../db.ts';

type SubscriptionRow = {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: string;
  last_used_at: string | null;
};

export type PushSubscriptionRecord = {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: string;
  lastUsedAt: string | null;
};

export type VapidConfig = { publicKey: string; privateKey: string };

function toSubscription(row: SubscriptionRow): PushSubscriptionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export class PushStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  config(): VapidConfig | null {
    const row = this.#db
      .stmt('SELECT public_key, private_key FROM push_config WHERE id = 1')
      .get() as unknown as { public_key: string; private_key: string } | undefined;
    return row ? { publicKey: row.public_key, privateKey: row.private_key } : null;
  }

  /** Idempotent so two instances starting together agree on one key pair. */
  ensureConfig(publicKey: string, privateKey: string, now = new Date()): VapidConfig {
    this.#db
      .stmt(
        `INSERT OR IGNORE INTO push_config (id, public_key, private_key, created_at)
         VALUES (1, ?, ?, ?)`,
      )
      .run(publicKey, privateKey, now.toISOString());
    return this.config() ?? { publicKey, privateKey };
  }

  subscribe(
    userId: string,
    input: { endpoint: string; p256dh: string; auth: string },
    userAgent: string | null,
    now = new Date(),
  ): PushSubscriptionRecord {
    const id = crypto.randomUUID();
    const stamp = now.toISOString();
    this.#db
      .stmt(
        `INSERT INTO push_subscriptions
           (id, user_id, endpoint, p256dh, auth, user_agent, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           user_id = excluded.user_id,
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           user_agent = excluded.user_agent`,
      )
      .run(id, userId, input.endpoint, input.p256dh, input.auth, userAgent, stamp);
    const row = this.#db
      .stmt(
        `SELECT id, user_id, endpoint, p256dh, auth, created_at, last_used_at
         FROM push_subscriptions WHERE endpoint = ?`,
      )
      .get(input.endpoint) as unknown as SubscriptionRow;
    return toSubscription(row);
  }

  unsubscribe(userId: string, endpoint: string): boolean {
    const result = this.#db
      .stmt('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
      .run(userId, endpoint);
    return Number(result.changes) > 0;
  }

  list(userId: string): PushSubscriptionRecord[] {
    const rows = this.#db
      .stmt(
        `SELECT id, user_id, endpoint, p256dh, auth, created_at, last_used_at
         FROM push_subscriptions WHERE user_id = ? ORDER BY created_at ASC`,
      )
      .all(userId) as unknown as SubscriptionRow[];
    return rows.map(toSubscription);
  }

  count(userId: string): number {
    const row = this.#db
      .stmt('SELECT COUNT(*) AS total FROM push_subscriptions WHERE user_id = ?')
      .get(userId) as unknown as { total: number };
    return Number(row.total);
  }

  remove(id: string): void {
    this.#db.stmt('DELETE FROM push_subscriptions WHERE id = ?').run(id);
  }

  markUsed(id: string, now = new Date()): void {
    this.#db
      .stmt('UPDATE push_subscriptions SET last_used_at = ? WHERE id = ?')
      .run(now.toISOString(), id);
  }
}
