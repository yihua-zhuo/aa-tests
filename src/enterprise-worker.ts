import type { SessionUser } from '../shared/types.ts';
import { log } from './logger.ts';
import type { Store } from './store.ts';

type AdminRow = {
  id: string;
  email: string;
  name: string;
  timezone: string;
  workspace_id: string;
};

type TickResult = { ok: boolean; message?: string };

export class EnterpriseWorker {
  readonly #store: Store;
  readonly #intervalMs: number;
  #timer: NodeJS.Timeout | null = null;
  #busy = false;

  constructor(store: Store, options: { intervalMs?: number } = {}) {
    this.#store = store;
    this.#intervalMs = Math.max(options.intervalMs ?? 60_000, 5_000);
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.tick(), this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  #systemUsers(): SessionUser[] {
    const rows = this.#store.db
      .stmt(
        `SELECT id, email, name, timezone, workspace_id FROM users
         WHERE status = 'active' AND workspace_id IS NOT NULL AND role = 'admin'
         ORDER BY created_at ASC`,
      )
      .all() as unknown as AdminRow[];
    const seen = new Set<string>();
    const users: SessionUser[] = [];
    for (const row of rows) {
      if (seen.has(row.workspace_id)) continue;
      seen.add(row.workspace_id);
      users.push({
        id: row.id,
        email: row.email,
        name: row.name,
        role: 'admin',
        timezone: row.timezone,
        workspaceId: row.workspace_id,
      });
    }
    return users;
  }

  tick(): void {
    if (this.#busy) return;
    this.#busy = true;
    try {
      for (const user of this.#systemUsers()) {
        this.#run(user, 'sla', () => this.#store.actions.tickSla(user, { limit: 200 }));
        this.#run(user, 'benefit-reminders', () => this.#store.actions.tickBenefitReviews(user));
        this.#run(user, 'document-reminders', () =>
          this.#store.actions.tickDocumentReminders(user),
        );
        this.#run(user, 'triggers', () => this.#store.actions.tickTriggers(user));
        this.#run(user, 'report-subscriptions', () =>
          this.#store.actions.runReportSubscriptions(user),
        );
        void this.#store.actions
          .tickEventDeliveries(user)
          .then((result) => {
            if (!result.ok) {
              log('warn', 'enterprise.tick', {
                task: 'events',
                workspaceId: user.workspaceId,
                message: result.message ?? 'skipped',
              });
            }
          })
          .catch((error: unknown) => {
            log('error', 'enterprise.tick', {
              task: 'events',
              workspaceId: user.workspaceId,
              message: error instanceof Error ? error.message : String(error),
            });
          });
      }
    } finally {
      this.#busy = false;
    }
  }

  #run(user: SessionUser, task: string, fn: () => TickResult): void {
    try {
      const result = fn();
      if (!result.ok) {
        log('warn', 'enterprise.tick', {
          task,
          workspaceId: user.workspaceId,
          message: result.message ?? 'skipped',
        });
      }
    } catch (error) {
      log('error', 'enterprise.tick', {
        task,
        workspaceId: user.workspaceId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
