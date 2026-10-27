import { log } from './logger.ts';
import type { Mailer } from './mailer.ts';
import type { Store } from './store.ts';

export type WorkerTickResult = {
  queuedDigests: number;
  queuedReports: number;
  sent: number;
  failed: number;
};

export class NotificationWorker {
  readonly #store: Store;
  readonly #mailer: Mailer;
  readonly #intervalMs: number;
  readonly #batchSize: number;
  #timer: NodeJS.Timeout | null = null;

  constructor(
    store: Store,
    mailer: Mailer,
    options: { intervalMs?: number; batchSize?: number } = {},
  ) {
    this.#store = store;
    this.#mailer = mailer;
    this.#intervalMs = options.intervalMs ?? 30_000;
    this.#batchSize = options.batchSize ?? 20;
  }

  async tick(now = new Date()): Promise<WorkerTickResult> {
    const queuedDigests = this.#store.notifications.enqueueWeeklyDigests(now);
    const queuedReports = this.#store.reports.enqueueDue(now, this.#store.notifications);
    const rows = this.#store.notifications.pendingMail(now, this.#batchSize);
    let sent = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        await this.#mailer.send({
          to: row.recipient,
          subject: row.subject,
          text: row.body,
        });
        this.#store.notifications.markMailSent(row.id, now);
        sent++;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : '发送失败';
        this.#store.notifications.markMailFailed(row.id, message, now);
        failed++;
        log('warn', 'mail.failed', { outboxId: row.id, attempts: row.attempts + 1, message });
      }
    }
    this.#store.notifications.purge(now);
    return { queuedDigests, queuedReports, sent, failed };
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.tick().catch((cause: unknown) => {
        log('warn', 'mail.tick_failed', {
          message: cause instanceof Error ? cause.message : String(cause),
        });
      });
    }, this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }
}
