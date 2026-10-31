import type { OcrRecoveryYield, OcrStageKind } from '../../shared/types.ts';
import type { Database } from '../db.ts';
import {
  type RecoveryYields,
  recoveryPrior,
  recoveryYieldMinSamples,
  smoothedRecoveryYield,
} from '../ocr-cascade.ts';

type YieldRow = {
  stage: OcrStageKind;
  attempts: number;
  successes: number;
  updated_at: string;
};

/** Persisted recovery stage outcomes feeding the cascade's expected-value gate. */
export class OcrYieldStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  load(): RecoveryYields {
    const rows = this.#db
      .stmt('SELECT stage, attempts, successes FROM ocr_recovery_yields')
      .all() as unknown as Omit<YieldRow, 'updated_at'>[];
    const yields: RecoveryYields = {};
    for (const row of rows) {
      yields[row.stage] = { attempts: Number(row.attempts), successes: Number(row.successes) };
    }
    return yields;
  }

  list(): OcrRecoveryYield[] {
    const minSamples = recoveryYieldMinSamples();
    const rows = this.#db
      .stmt('SELECT stage, attempts, successes, updated_at FROM ocr_recovery_yields')
      .all() as unknown as YieldRow[];
    return rows
      .map((row) => {
        const attempts = Number(row.attempts);
        const successes = Number(row.successes);
        return {
          stage: row.stage,
          attempts,
          successes,
          probability: smoothedRecoveryYield(row.stage, { attempts, successes }, minSamples),
          prior: recoveryPrior(row.stage),
          updatedAt: row.updated_at,
        };
      })
      .sort(
        (left, right) => right.attempts - left.attempts || left.stage.localeCompare(right.stage),
      );
  }

  record(
    outcomes: readonly { kind: OcrStageKind; attempts: number; successes: number }[],
    now = new Date().toISOString(),
  ): void {
    if (outcomes.length === 0) return;
    const upsert = this.#db.stmt(
      `INSERT INTO ocr_recovery_yields (stage, attempts, successes, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(stage) DO UPDATE SET
         attempts = attempts + excluded.attempts,
         successes = successes + excluded.successes,
         updated_at = excluded.updated_at`,
    );
    this.#db.transaction(() => {
      for (const outcome of outcomes) {
        upsert.run(
          outcome.kind,
          Math.max(0, outcome.attempts),
          Math.max(0, outcome.successes),
          now,
        );
      }
    });
  }
}
