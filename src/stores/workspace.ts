import { CURRENCIES, DEFAULT_RATES } from '../../shared/currencies.ts';
import type { CurrencyCode, WorkspaceSettings } from '../../shared/types.ts';
import type { Database } from '../db.ts';

type WorkspaceRow = {
  currency: string;
  rates: string;
  time_log_visibility: string;
  updated_at: string;
};

type TimeLogVisibility = WorkspaceSettings['timeLogVisibility'];

function isTimeLogVisibility(value: unknown): value is TimeLogVisibility {
  return value === 'all' || value === 'managers' || value === 'self';
}

function isCurrency(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value);
}

function parseRates(value: string): Record<CurrencyCode, number> {
  const rates = { ...DEFAULT_RATES };
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [code, rate] of Object.entries(parsed)) {
        if (!isCurrency(code)) continue;
        const number = Number(rate);
        if (Number.isFinite(number) && number > 0) rates[code] = number;
      }
    }
  } catch {
    // Corrupt rate JSON falls back to the built-in table.
  }
  return rates;
}

export class WorkspaceStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  get(): WorkspaceSettings {
    const row = this.#db
      .stmt(
        'SELECT currency, rates, time_log_visibility, updated_at FROM workspace_settings WHERE id = 1',
      )
      .get() as unknown as WorkspaceRow | undefined;
    return {
      currency: isCurrency(row?.currency) ? row.currency : 'USD',
      rates: parseRates(row?.rates ?? '{}'),
      timeLogVisibility: isTimeLogVisibility(row?.time_log_visibility)
        ? row.time_log_visibility
        : 'all',
      updatedAt: row?.updated_at ?? new Date(0).toISOString(),
    };
  }

  rate(currency?: CurrencyCode): number {
    const settings = this.get();
    return settings.rates[currency ?? settings.currency] ?? 1;
  }

  /** Converts an amount in `currency` to the USD base used by daily_metrics. */
  toUsd(amount: number, currency: CurrencyCode): number {
    return amount / this.rate(currency);
  }

  update(input: {
    currency?: CurrencyCode;
    rate?: number;
    timeLogVisibility?: TimeLogVisibility;
  }): WorkspaceSettings {
    const current = this.get();
    const currency = input.currency ?? current.currency;
    const rate = Math.round((input.rate ?? current.rates[currency] ?? 1) * 1_000_000) / 1_000_000;
    const rates = { ...current.rates, [currency]: rate };
    this.#db
      .stmt(
        `UPDATE workspace_settings SET currency = ?, rates = ?, time_log_visibility = ?,
           updated_at = ? WHERE id = 1`,
      )
      .run(
        currency,
        JSON.stringify(rates),
        input.timeLogVisibility ?? current.timeLogVisibility,
        new Date().toISOString(),
      );
    return this.get();
  }
}
