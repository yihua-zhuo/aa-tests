import { resolveRange } from '../../shared/ranges.ts';
import type {
  RangeInfo,
  ReportFrequency,
  SavedReport,
  SavedReportQuery,
} from '../../shared/types.ts';
import type { Database } from '../db.ts';
import { workspaceTimeZone } from '../timezone.ts';
import type { AnalyticsStore } from './analytics.ts';
import type { NotificationsStore } from './notifications.ts';

type ReportRow = {
  id: string;
  name: string;
  query: string;
  frequency: string;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
};

function isFrequency(value: unknown): value is ReportFrequency {
  return value === 'none' || value === 'weekly' || value === 'monthly';
}

function parseQuery(value: string): SavedReportQuery {
  const parsed = JSON.parse(value) as Partial<SavedReportQuery>;
  return {
    kind: parsed.kind === 'channels' || parsed.kind === 'audience' ? parsed.kind : 'revenue',
    range: parsed.range ?? '30d',
    ...(parsed.from ? { from: parsed.from } : {}),
    ...(parsed.to ? { to: parsed.to } : {}),
    ...(parsed.granularity ? { granularity: parsed.granularity } : {}),
    ...(parsed.compare !== undefined ? { compare: parsed.compare } : {}),
  };
}

function nextRun(frequency: ReportFrequency, from: Date): string | null {
  if (frequency === 'none') return null;
  const next = new Date(from);
  if (frequency === 'weekly') next.setUTCDate(next.getUTCDate() + 7);
  else next.setUTCMonth(next.getUTCMonth() + 1);
  return next.toISOString();
}

function mapRow(row: ReportRow): SavedReport {
  return {
    id: row.id,
    name: row.name,
    query: parseQuery(row.query),
    frequency: isFrequency(row.frequency) ? row.frequency : 'none',
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type ReportInput = {
  name: string;
  query: SavedReportQuery;
  frequency: ReportFrequency;
};

export class ReportsStore {
  readonly #db: Database;
  readonly #analytics: AnalyticsStore;

  constructor(db: Database, analytics: AnalyticsStore) {
    this.#db = db;
    this.#analytics = analytics;
  }

  #find(userId: string, id: string): ReportRow | undefined {
    return this.#db
      .stmt(
        `SELECT id, name, query, frequency, last_run_at, next_run_at, created_at, updated_at
         FROM saved_reports WHERE id = ? AND user_id = ?`,
      )
      .get(id, userId) as unknown as ReportRow | undefined;
  }

  list(userId: string): SavedReport[] {
    const rows = this.#db
      .stmt(
        `SELECT id, name, query, frequency, last_run_at, next_run_at, created_at, updated_at
         FROM saved_reports WHERE user_id = ? ORDER BY created_at DESC`,
      )
      .all(userId) as unknown as ReportRow[];
    return rows.map(mapRow);
  }

  create(userId: string, input: ReportInput, now = new Date()): SavedReport {
    const id = crypto.randomUUID();
    const timestamp = now.toISOString();
    this.#db
      .stmt(
        `INSERT INTO saved_reports
           (id, user_id, name, query, frequency, last_run_at, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        userId,
        input.name,
        JSON.stringify(input.query),
        input.frequency,
        nextRun(input.frequency, now),
        timestamp,
        timestamp,
      );
    return mapRow(this.#find(userId, id) as ReportRow);
  }

  update(
    userId: string,
    id: string,
    patch: Partial<ReportInput>,
    now = new Date(),
  ): SavedReport | null {
    const current = this.#find(userId, id);
    if (!current) return null;
    const frequency = patch.frequency ?? mapRow(current).frequency;
    const query = patch.query ?? mapRow(current).query;
    const name = patch.name ?? current.name;
    const next = patch.frequency === undefined ? current.next_run_at : nextRun(frequency, now);
    this.#db
      .stmt(
        `UPDATE saved_reports
         SET name = ?, query = ?, frequency = ?, next_run_at = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`,
      )
      .run(name, JSON.stringify(query), frequency, next, now.toISOString(), id, userId);
    return mapRow(this.#find(userId, id) as ReportRow);
  }

  delete(userId: string, id: string): boolean {
    const result = this.#db
      .stmt('DELETE FROM saved_reports WHERE id = ? AND user_id = ?')
      .run(id, userId);
    return Number(result.changes) > 0;
  }

  #resolve(report: SavedReport, now: Date): RangeInfo | null {
    const resolved = resolveRange(
      {
        range: report.query.range,
        from: report.query.from,
        to: report.query.to,
      },
      now,
      workspaceTimeZone(),
    );
    return resolved.ok ? resolved.range : null;
  }

  export(
    userId: string,
    id: string,
    now = new Date(),
  ): { report: SavedReport; filename: string; content: string } | null {
    const row = this.#find(userId, id);
    if (!row) return null;
    const report = mapRow(row);
    const range = this.#resolve(report, now);
    if (!range) return null;
    const csv = this.#analytics.exportCsv({
      kind: report.query.kind,
      range,
      granularity: report.query.granularity,
      comparison: report.query.compare ?? true,
    });
    return { report, ...csv };
  }

  #markRun(id: string, frequency: ReportFrequency, now: Date): void {
    this.#db
      .stmt(
        'UPDATE saved_reports SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?',
      )
      .run(now.toISOString(), nextRun(frequency, now), now.toISOString(), id);
  }

  /** Queues due scheduled reports into the mail outbox. Logs only report ids. */
  enqueueDue(now: Date, notifications: NotificationsStore): number {
    const rows = this.#db
      .stmt(
        `SELECT id, user_id, name, query, frequency, last_run_at, next_run_at, created_at, updated_at
         FROM saved_reports
         WHERE frequency != 'none' AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at ASC LIMIT 50`,
      )
      .all(now.toISOString()) as unknown as (ReportRow & { user_id: string })[];

    let queued = 0;
    for (const row of rows) {
      const report = mapRow(row);
      const range = this.#resolve(report, now);
      if (range) {
        const csv = this.#analytics.exportCsv({
          kind: report.query.kind,
          range,
          granularity: report.query.granularity,
          comparison: report.query.compare ?? true,
        });
        if (
          notifications.enqueueMail({
            userId: row.user_id,
            subject: `定时报表：${report.name}`,
            body: `报表范围 ${range.from} ~ ${range.to}（${range.timezone}）\n\n${csv.content}`,
            dedupeKey: `report:${report.id}:${row.next_run_at}`,
            createdAt: now.toISOString(),
          })
        ) {
          queued++;
        }
      }
      this.#markRun(report.id, report.frequency, now);
    }
    return queued;
  }
}
