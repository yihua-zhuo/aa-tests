import type { AppNotification, NotificationList, NotificationType } from '../../shared/types.ts';
import type { Database } from '../db.ts';

type NotificationRow = {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  read_at: string | null;
  created_at: string;
};

export type OutboxRow = {
  id: string;
  user_id: string;
  recipient: string;
  subject: string;
  body: string;
  attempts: number;
};

export type PushRow = {
  id: string;
  user_id: string;
  title: string;
  body: string;
  link: string | null;
};

export type NotificationInput = {
  userId: string;
  type: NotificationType;
  title: string;
  body?: string;
  link?: string | null;
  actorId?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  commentId?: string | null;
  createdAt?: string;
};

export type MailInput = {
  userId: string;
  subject: string;
  body: string;
  dedupeKey?: string;
  createdAt?: string;
};

const MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000];
const NOTIFICATION_RETENTION_DAYS = 180;

function toNotification(row: NotificationRow): AppNotification {
  return {
    id: row.id,
    type: row.type as NotificationType,
    title: row.title,
    body: row.body,
    link: row.link,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

function weekKey(date: Date): string {
  const monday = new Date(date);
  const day = (monday.getUTCDay() + 6) % 7;
  monday.setUTCDate(monday.getUTCDate() - day);
  return monday.toISOString().slice(0, 10);
}

function excerpt(value: string, size = 160): string {
  return value.length > size ? `${value.slice(0, size)}…` : value;
}

export class NotificationsStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  unreadCount(userId: string): number {
    const row = this.#db
      .stmt('SELECT COUNT(*) AS total FROM notifications WHERE user_id = ? AND read_at IS NULL')
      .get(userId) as unknown as { total: number };
    return Number(row.total);
  }

  create(input: NotificationInput): string {
    const id = crypto.randomUUID();
    this.#db
      .stmt(
        `INSERT INTO notifications
           (id, user_id, type, actor_id, project_id, task_id, comment_id, title, body, link, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.userId,
        input.type,
        input.actorId ?? null,
        input.projectId ?? null,
        input.taskId ?? null,
        input.commentId ?? null,
        input.title,
        input.body ?? '',
        input.link ?? null,
        input.createdAt ?? new Date().toISOString(),
      );
    return id;
  }

  list(userId: string, limit = 20): NotificationList {
    const rows = this.#db
      .stmt(
        `SELECT id, type, title, body, link, read_at, created_at
         FROM notifications WHERE user_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(userId, limit) as unknown as NotificationRow[];
    return {
      notifications: rows.map(toNotification),
      unread: this.unreadCount(userId),
    };
  }

  markRead(userId: string, options: { ids?: string[]; all?: boolean }): number {
    const now = new Date().toISOString();
    if (options.all) {
      this.#db
        .stmt('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL')
        .run(now, userId);
    } else if (options.ids && options.ids.length > 0) {
      const placeholders = options.ids.map(() => '?').join(', ');
      this.#db
        .stmt(
          `UPDATE notifications SET read_at = ?
           WHERE user_id = ? AND read_at IS NULL AND id IN (${placeholders})`,
        )
        .run(now, userId, ...options.ids);
    }
    return this.unreadCount(userId);
  }

  /** Queues an email only when the recipient enables notifications. */
  enqueueMail(input: MailInput): boolean {
    const user = this.#db
      .stmt(
        `SELECT u.email, u.status, COALESCE(p.email_notifications, 1) AS email_notifications
         FROM users u LEFT JOIN user_preferences p ON p.user_id = u.id
         WHERE u.id = ?`,
      )
      .get(input.userId) as unknown as
      | { email: string; status: string; email_notifications: number }
      | undefined;
    if (!user) return false;
    if (user.status !== 'active' || user.email_notifications !== 1) return false;
    const now = input.createdAt ?? new Date().toISOString();
    const result = this.#db
      .stmt(
        `INSERT OR IGNORE INTO mail_outbox
           (id, user_id, recipient, subject, body, dedupe_key, status, attempts,
            next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        input.userId,
        user.email,
        input.subject,
        input.body,
        input.dedupeKey ?? null,
        now,
        now,
      );
    return Number(result.changes) > 0;
  }

  /** Points mail that has not been delivered yet at the user's new address. */
  redirectPendingMail(userId: string, email: string): void {
    this.#db
      .stmt("UPDATE mail_outbox SET recipient = ? WHERE user_id = ? AND status = 'pending'")
      .run(email, userId);
  }

  /**
   * Queues one digest per user per ISO week. Deduplication lives in the
   * outbox's unique key so restarts and overlapping workers stay idempotent.
   */
  enqueueWeeklyDigests(now: Date): number {
    const users = this.#db
      .stmt(
        `SELECT u.id, u.email, COUNT(n.id) AS unread
         FROM users u
         JOIN user_preferences p ON p.user_id = u.id
         LEFT JOIN notifications n ON n.user_id = u.id AND n.read_at IS NULL
         WHERE u.status = 'active' AND p.weekly_digest = 1 AND p.email_notifications = 1
         GROUP BY u.id`,
      )
      .all() as unknown as { id: string; email: string; unread: number }[];
    const key = weekKey(now);
    const createdAt = now.toISOString();
    let queued = 0;
    for (const user of users) {
      const unread = Number(user.unread);
      if (unread === 0) continue;
      const recent = this.#db
        .stmt(
          `SELECT title FROM notifications
           WHERE user_id = ? AND read_at IS NULL
           ORDER BY created_at DESC LIMIT 5`,
        )
        .all(user.id) as unknown as { title: string }[];
      const lines = recent.map((row) => `- ${row.title}`).join('\n');
      const result = this.#db
        .stmt(
          `INSERT OR IGNORE INTO mail_outbox
             (id, user_id, recipient, subject, body, dedupe_key, status, attempts,
              next_attempt_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
        )
        .run(
          crypto.randomUUID(),
          user.id,
          user.email,
          `每周摘要：你有 ${unread} 条未读通知`,
          `本周还有 ${unread} 条未读通知：\n\n${lines}\n\n登录后可在通知中心一键标为已读。`,
          `digest:${user.id}:${key}`,
          createdAt,
          createdAt,
        );
      queued += Number(result.changes);
    }
    return queued;
  }

  pendingMail(now: Date, limit = 20): OutboxRow[] {
    return this.#db
      .stmt(
        `SELECT id, user_id, recipient, subject, body, attempts
         FROM mail_outbox
         WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC LIMIT ?`,
      )
      .all(now.toISOString(), limit) as unknown as OutboxRow[];
  }

  markMailSent(id: string, now: Date): void {
    this.#db
      .stmt("UPDATE mail_outbox SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?")
      .run(now.toISOString(), id);
  }

  markMailFailed(id: string, error: string, now: Date): void {
    const row = this.#db.stmt('SELECT attempts FROM mail_outbox WHERE id = ?').get(id) as unknown as
      | { attempts: number }
      | undefined;
    if (!row) return;
    const attempts = Number(row.attempts) + 1;
    const failed = attempts >= MAX_ATTEMPTS;
    const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)] ?? 0;
    this.#db
      .stmt(
        `UPDATE mail_outbox
         SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?
         WHERE id = ?`,
      )
      .run(
        failed ? 'failed' : 'pending',
        attempts,
        new Date(now.getTime() + delay).toISOString(),
        error.slice(0, 500),
        id,
      );
  }

  /** Only recent notifications are pushed; older rows are historical. */
  pendingPush(now: Date, limit = 20): PushRow[] {
    const cutoff = new Date(now.getTime() - 2 * 3_600_000).toISOString();
    return this.#db
      .stmt(
        `SELECT n.id, n.user_id, n.title, n.body, n.link
         FROM notifications n JOIN users u ON u.id = n.user_id
         WHERE n.pushed_at IS NULL AND n.created_at >= ? AND u.status = 'active'
         ORDER BY n.created_at ASC LIMIT ?`,
      )
      .all(cutoff, limit) as unknown as PushRow[];
  }

  markPushed(ids: string[], now: Date): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(', ');
    this.#db
      .stmt(`UPDATE notifications SET pushed_at = ? WHERE id IN (${placeholders})`)
      .run(now.toISOString(), ...ids);
  }

  purge(now: Date): void {
    const cutoff = new Date(now.getTime() - NOTIFICATION_RETENTION_DAYS * 86_400_000).toISOString();
    this.#db.stmt('DELETE FROM notifications WHERE created_at < ?').run(cutoff);
    const sentCutoff = new Date(now.getTime() - 30 * 86_400_000).toISOString();
    this.#db.stmt("DELETE FROM mail_outbox WHERE status = 'sent' AND sent_at < ?").run(sentCutoff);
  }
}

export { excerpt };
