import { createHmac } from 'node:crypto';
import { WEBHOOK_MAX_ATTEMPTS, webhookRetryDelay } from '../shared/webhooks.ts';
import { log } from './logger.ts';
import type { Store } from './store.ts';

export function webhookSignature(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export type WebhookWorkerOptions = {
  intervalMs?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

export class WebhookWorker {
  readonly #store: Store;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #intervalMs: number;
  readonly #now: () => Date;
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(store: Store, options: WebhookWorkerOptions = {}) {
    this.#store = store;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#maxAttempts = options.maxAttempts ?? WEBHOOK_MAX_ATTEMPTS;
    this.#intervalMs = options.intervalMs ?? 10_000;
    this.#now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.runOnce(), this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async runOnce(limit = 20): Promise<{ sent: number; retried: number; failed: number }> {
    const result = { sent: 0, retried: 0, failed: 0 };
    if (this.#running) return result;
    this.#running = true;
    try {
      for (const delivery of this.#store.webhooks.due(this.#now(), limit)) {
        result[await this.#deliver(delivery)]++;
      }
    } finally {
      this.#running = false;
    }
    return result;
  }

  async #deliver(delivery: {
    id: string;
    webhookId: string;
    event: string;
    payload: string;
    attempts: number;
    url: string;
    secret: string;
  }): Promise<'sent' | 'retried' | 'failed'> {
    const now = this.#now();
    const attempt = delivery.attempts + 1;
    const timestamp = Math.floor(now.getTime() / 1000);
    const signature = webhookSignature(delivery.secret, timestamp, delivery.payload);
    let statusCode: number | null = null;

    try {
      const response = await this.#fetch(delivery.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Clay-Webhooks/1.0',
          'x-clay-event': delivery.event,
          'x-clay-delivery': delivery.id,
          'x-clay-timestamp': String(timestamp),
          'x-clay-signature': `sha256=${signature}`,
        },
        body: delivery.payload,
        redirect: 'error',
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      statusCode = response.status;
      await response.body?.cancel().catch(() => {});
      if (response.ok) {
        this.#store.webhooks.markSent(delivery.id, statusCode, now);
        return 'sent';
      }
    } catch (error) {
      log('warn', 'webhook.error', {
        webhookId: delivery.webhookId,
        deliveryId: delivery.id,
        attempt,
        error: (error as Error).name,
      });
    }

    if (attempt >= this.#maxAttempts) {
      this.#store.webhooks.markFailed(delivery.id, attempt, statusCode, now);
      log('warn', 'webhook.failed', {
        webhookId: delivery.webhookId,
        deliveryId: delivery.id,
        event: delivery.event,
        attempts: attempt,
        status: statusCode,
      });
      return 'failed';
    }

    const nextAt = new Date(now.getTime() + webhookRetryDelay(attempt)).toISOString();
    this.#store.webhooks.markRetry(delivery.id, attempt, nextAt, statusCode, now);
    return 'retried';
  }
}
