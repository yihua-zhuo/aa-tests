import { positiveIntEnv } from './db.ts';

/**
 * Upper bound for synchronous CSV export. Reads happen on the single SQLite
 * connection, so exports are refused before streaming when the accessible
 * project count exceeds this budget.
 */
export function exportRowLimit(): number {
  return positiveIntEnv('EXPORT_MAX_ROWS', 10_000);
}
