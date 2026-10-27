import { log } from './logger.ts';
import type { PushSender } from './push.ts';
import type { Store } from './store.ts';

export type PushTickResult = {
  pending: number;
  delivered: number;
  failed: number;
  gone: number;
};

export class PushWorker {
  readonly #store: Store;
  readonly #sender: PushSender;
  readonly #intervalMs: number;
  readonly #batchSize: number;
  #timer: NodeJS.Timeout | null = null;

  constructor(
    store: Store,
    sender: PushSender,
    options: { intervalMs?: number; batchSize?: number } = {},
  ) {
    this.#store = store;
    this.#sender = sender;
    this.#intervalMs = options.intervalMs ?? 15_000;
    this.#batchSize = options.batchSize ?? 20;
  }

  async tick(now = new Date()): Promise<PushTickResult> {
    const rows = this.#store.notifications.pendingPush(now, this.#batchSize);
    const result: PushTickResult = { pending: rows.length, delivered: 0, failed: 0, gone: 0 };
    for (const row of rows) {
      try {
        const sent = await this.#sender.sendToUser(
          row.user_id,
          { title: row.title, body: row.body, link: row.link, tag: row.id },
          now,
        );
        result.delivered += sent.sent;
        result.failed += sent.failed;
        result.gone += sent.gone;
      } catch (cause) {
        result.failed++;
        log('warn', 'push.failed', {
          notificationId: row.id,
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    if (rows.length > 0) {
      this.#store.notifications.markPushed(
        rows.map((row) => row.id),
        now,
      );
    }
    return result;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.tick().catch((cause: unknown) => {
        log('warn', 'push.tick_failed', {
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
