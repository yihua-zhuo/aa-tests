import { DatabaseSync } from 'node:sqlite';
import { addDays, bucketLabel, bucketStart, enumerateDays } from '../../shared/ranges.ts';
import type {
  AnalyticsSourceSummary,
  AudienceReport,
  ChannelReport,
  ChannelSlice,
  CurrencyCode,
  Granularity,
  KpiValue,
  MetricDay,
  MetricImportResult,
  MetricRecord,
  RangeInfo,
  ReportKind,
  RevenuePoint,
  RevenueReport,
  RevenueSeriesPoint,
  SparkPoint,
} from '../../shared/types.ts';
import { csvCell } from '../csv.ts';
import type { Database } from '../db.ts';
import type { WorkspaceStore } from './workspace.ts';

type DailyRow = {
  date: string;
  revenue_cents: number;
  customers: number;
  conversions: number;
  visitors: number;
};

type ChannelRow = {
  date: string;
  channel: string;
  sessions: number;
};

export const CHANNELS = ['Organic Search', 'Direct', 'Social Media', 'Email'] as const;

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function conversionRate(conversions: number, visitors: number): number {
  return visitors > 0 ? round((conversions / visitors) * 100, 2) : 0;
}

function relativeDelta(current: number, previous: number, hasPrevious: boolean): number | null {
  if (!hasPrevious || previous === 0) return null;
  return round(((current - previous) / previous) * 100, 1);
}

function nextBucket(bucket: string, granularity: Granularity): string {
  if (granularity === 'month') {
    const date = new Date(`${bucket}T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + 1);
    return date.toISOString().slice(0, 10);
  }
  return addDays(bucket, granularity === 'week' ? 7 : 1);
}

export class AnalyticsStore {
  readonly #db: Database;
  readonly #read: DatabaseSync | null;
  readonly #workspace: WorkspaceStore;

  constructor(db: Database, workspace: WorkspaceStore) {
    this.#db = db;
    this.#workspace = workspace;
    // Read-only handle keeps reporting queries off the writer connection.
    // In-memory databases cannot be shared across handles.
    this.#read = db.path === ':memory:' ? null : new DatabaseSync(db.path, { readOnly: true });
  }

  #stmt(sql: string) {
    return (this.#read ?? this.#db.raw).prepare(sql);
  }

  #currency(): CurrencyCode {
    return this.#workspace.get().currency;
  }

  #rate(): number {
    return this.#workspace.rate();
  }

  #money(cents: number): number {
    return round((cents / 100) * this.#rate(), 2);
  }

  close(): void {
    this.#read?.close();
  }

  #rows(from: string, to: string): DailyRow[] {
    return this.#stmt(
      `SELECT date, revenue_cents, customers, conversions, visitors
       FROM daily_metrics WHERE date BETWEEN ? AND ? ORDER BY date ASC`,
    ).all(from, to) as unknown as DailyRow[];
  }

  #channels(from: string, to: string): ChannelRow[] {
    return this.#stmt(
      'SELECT date, channel, sessions FROM channel_daily WHERE date BETWEEN ? AND ?',
    ).all(from, to) as unknown as ChannelRow[];
  }

  #totals(rows: DailyRow[]): {
    revenueCents: number;
    customers: number;
    conversions: number;
    visitors: number;
  } {
    return rows.reduce(
      (totals, row) => ({
        revenueCents: totals.revenueCents + Number(row.revenue_cents),
        customers: totals.customers + Number(row.customers),
        conversions: totals.conversions + Number(row.conversions),
        visitors: totals.visitors + Number(row.visitors),
      }),
      { revenueCents: 0, customers: 0, conversions: 0, visitors: 0 },
    );
  }

  #sparkline(
    rows: DailyRow[],
    from: string,
    to: string,
    metric: 'revenue' | 'customers' | 'conversion',
  ): SparkPoint[] {
    const byDate = new Map(rows.map((row) => [row.date, row]));
    return enumerateDays(from, to).map((date) => {
      const row = byDate.get(date);
      let value = 0;
      if (row) {
        if (metric === 'revenue') value = this.#money(Number(row.revenue_cents));
        else if (metric === 'customers') value = Number(row.customers);
        else value = conversionRate(Number(row.conversions), Number(row.visitors));
      }
      return { date, value };
    });
  }

  #channelSlices(rows: ChannelRow[]): ChannelSlice[] {
    const totals = new Map<string, number>();
    for (const channel of CHANNELS) totals.set(channel, 0);
    for (const row of rows) {
      totals.set(row.channel, (totals.get(row.channel) ?? 0) + Number(row.sessions));
    }
    const grand = [...totals.values()].reduce((sum, value) => sum + value, 0);
    return [...totals.entries()]
      .map(([channel, sessions]) => ({
        channel,
        sessions,
        share: grand > 0 ? round((sessions / grand) * 100, 1) : 0,
      }))
      .filter(
        (slice) =>
          slice.sessions > 0 || CHANNELS.includes(slice.channel as (typeof CHANNELS)[number]),
      );
  }

  dashboard(range: RangeInfo): {
    currency: CurrencyCode;
    kpis: { revenue: KpiValue; customers: KpiValue; conversion: KpiValue };
    revenue: RevenuePoint[];
    channels: ChannelSlice[];
  } {
    const current = this.#rows(range.from, range.to);
    const previous = this.#rows(range.previous.from, range.previous.to);
    const now = this.#totals(current);
    const before = this.#totals(previous);
    const hasPrevious = previous.length > 0;

    const revenueValue = this.#money(now.revenueCents);
    const previousRevenue = this.#money(before.revenueCents);
    const customerValue = now.customers;
    const previousCustomers = before.customers;
    const conversionValue = conversionRate(now.conversions, now.visitors);
    const previousConversion = conversionRate(before.conversions, before.visitors);

    const byDate = new Map(current.map((row) => [row.date, row]));
    const revenue: RevenuePoint[] = enumerateDays(range.from, range.to).map((date) => ({
      date,
      revenue: byDate.has(date) ? this.#money(Number(byDate.get(date)?.revenue_cents ?? 0)) : 0,
    }));

    return {
      currency: this.#currency(),
      kpis: {
        revenue: {
          value: revenueValue,
          previous: hasPrevious ? previousRevenue : null,
          delta: relativeDelta(revenueValue, previousRevenue, hasPrevious),
          format: 'currency',
          sparkline: this.#sparkline(current, range.from, range.to, 'revenue'),
        },
        customers: {
          value: customerValue,
          previous: hasPrevious ? previousCustomers : null,
          delta: relativeDelta(customerValue, previousCustomers, hasPrevious),
          format: 'number',
          sparkline: this.#sparkline(current, range.from, range.to, 'customers'),
        },
        conversion: {
          value: conversionValue,
          previous: hasPrevious ? previousConversion : null,
          delta:
            hasPrevious && before.visitors > 0
              ? round(conversionValue - previousConversion, 2)
              : null,
          format: 'percent',
          sparkline: this.#sparkline(current, range.from, range.to, 'conversion'),
        },
      },
      revenue,
      channels: this.#channelSlices(this.#channels(range.from, range.to)),
    };
  }

  revenueReport(range: RangeInfo, granularity: Granularity, comparison: boolean): RevenueReport {
    const current = this.#rows(range.from, range.to);
    const previous = comparison ? this.#rows(range.previous.from, range.previous.to) : [];

    const currentMap = new Map<string, number>();
    for (const row of current) {
      const bucket = bucketStart(row.date, granularity);
      currentMap.set(bucket, (currentMap.get(bucket) ?? 0) + Number(row.revenue_cents));
    }
    const previousMap = new Map<string, number>();
    for (const row of previous) {
      const bucket = bucketStart(addDays(row.date, range.days), granularity);
      previousMap.set(bucket, (previousMap.get(bucket) ?? 0) + Number(row.revenue_cents));
    }

    const buckets: string[] = [];
    const end = bucketStart(range.to, granularity);
    let cursor = bucketStart(range.from, granularity);
    while (cursor <= end && buckets.length < 400) {
      buckets.push(cursor);
      cursor = nextBucket(cursor, granularity);
    }

    const points: RevenueSeriesPoint[] = buckets.map((bucket) => ({
      bucket,
      label: bucketLabel(bucket, granularity),
      revenue: this.#money(currentMap.get(bucket) ?? 0),
      previous:
        comparison && previous.length > 0 ? this.#money(previousMap.get(bucket) ?? 0) : null,
    }));

    const total = this.#money([...currentMap.values()].reduce((sum, value) => sum + value, 0));
    const previousTotal = comparison
      ? this.#money([...previousMap.values()].reduce((sum, value) => sum + value, 0))
      : null;

    return {
      range,
      currency: this.#currency(),
      granularity,
      points,
      total,
      previousTotal,
      delta:
        previousTotal === null ? null : relativeDelta(total, previousTotal, previous.length > 0),
      comparison,
    };
  }

  channelReport(range: RangeInfo): ChannelReport {
    const current = this.#channelSlices(this.#channels(range.from, range.to));
    const previousRows = this.#channels(range.previous.from, range.previous.to);
    const previousTotals = new Map<string, number>();
    for (const row of previousRows) {
      previousTotals.set(
        row.channel,
        (previousTotals.get(row.channel) ?? 0) + Number(row.sessions),
      );
    }
    const hasPrevious = previousRows.length > 0;

    return {
      range,
      channels: current.map((slice) => {
        const previousSessions = previousTotals.get(slice.channel) ?? 0;
        return {
          ...slice,
          previousSessions: hasPrevious ? previousSessions : null,
          delta: relativeDelta(slice.sessions, previousSessions, hasPrevious),
        };
      }),
      total: current.reduce((sum, slice) => sum + slice.sessions, 0),
    };
  }

  audienceReport(range: RangeInfo): AudienceReport {
    const current = this.#rows(range.from, range.to);
    const previous = this.#rows(range.previous.from, range.previous.to);
    const now = this.#totals(current);
    const before = this.#totals(previous);
    const hasPrevious = previous.length > 0;
    const byDate = new Map(current.map((row) => [row.date, row]));

    return {
      range,
      customers: now.customers,
      previousCustomers: hasPrevious ? before.customers : null,
      customerDelta: relativeDelta(now.customers, before.customers, hasPrevious),
      visitors: now.visitors,
      conversion: conversionRate(now.conversions, now.visitors),
      previousConversion: hasPrevious ? conversionRate(before.conversions, before.visitors) : null,
      conversionDelta:
        hasPrevious && before.visitors > 0
          ? round(
              conversionRate(now.conversions, now.visitors) -
                conversionRate(before.conversions, before.visitors),
              2,
            )
          : null,
      daily: enumerateDays(range.from, range.to).map((date) => {
        const row = byDate.get(date);
        return { date, value: row ? Number(row.customers) : 0 };
      }),
    };
  }

  /** Upserts imported daily metrics, converting each row from its source currency to USD. */
  importMetrics(records: MetricRecord[], source: string): MetricImportResult {
    const insert = this.#db.stmt(
      `INSERT INTO daily_metrics
         (date, revenue_cents, customers, conversions, visitors, currency, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         revenue_cents = excluded.revenue_cents,
         customers = excluded.customers,
         conversions = excluded.conversions,
         visitors = excluded.visitors,
         currency = excluded.currency,
         source = excluded.source`,
    );
    let imported = 0;
    this.#db.transaction(() => {
      for (const record of records) {
        const cents = Math.round(this.#workspace.toUsd(record.revenue, record.currency) * 100);
        const result = insert.run(
          record.date,
          cents,
          record.customers,
          record.conversions,
          record.visitors,
          record.currency,
          source,
        );
        imported += Number(result.changes);
      }
    });
    return { imported, skipped: 0, errors: [] };
  }

  metricDays(from: string, to: string): MetricDay[] {
    const currency = this.#currency();
    const rows = this.#stmt(
      `SELECT date, revenue_cents, customers, conversions, visitors, currency, source
       FROM daily_metrics WHERE date BETWEEN ? AND ? ORDER BY date ASC`,
    ).all(from, to) as unknown as (DailyRow & { currency: CurrencyCode; source: string })[];

    return rows.map((row) => ({
      date: row.date,
      revenue: this.#money(Number(row.revenue_cents)),
      customers: Number(row.customers),
      conversions: Number(row.conversions),
      visitors: Number(row.visitors),
      currency,
      source: row.source,
    }));
  }

  sources(): AnalyticsSourceSummary[] {
    const rows = this.#stmt(
      `SELECT source, COUNT(*) AS days, MIN(date) AS from_date, MAX(date) AS to_date,
              SUM(revenue_cents) AS revenue_cents
       FROM daily_metrics GROUP BY source ORDER BY days DESC, source ASC`,
    ).all() as unknown as {
      source: string;
      days: number;
      from_date: string;
      to_date: string;
      revenue_cents: number;
    }[];

    return rows.map((row) => ({
      source: row.source,
      days: Number(row.days),
      from: row.from_date,
      to: row.to_date,
      revenue: this.#money(Number(row.revenue_cents)),
    }));
  }

  exportCsv(input: {
    kind: ReportKind;
    range: RangeInfo;
    granularity?: Granularity;
    comparison?: boolean;
  }): { filename: string; content: string } {
    const comparison = input.comparison ?? true;
    if (input.kind === 'channels') {
      const report = this.channelReport(input.range);
      const lines = [
        'channel,sessions,share,previousSessions,delta',
        ...report.channels.map((item) =>
          [
            csvCell(item.channel),
            String(item.sessions),
            String(item.share),
            item.previousSessions === null ? '' : String(item.previousSessions),
            item.delta === null ? '' : String(item.delta),
          ].join(','),
        ),
      ];
      return { filename: 'analytics-channels.csv', content: `\uFEFF${lines.join('\n')}\n` };
    }

    if (input.kind === 'audience') {
      const report = this.audienceReport(input.range);
      const lines = [
        `date,customers,currency`,
        ...report.daily.map(
          (item) => `${csvCell(item.date)},${String(item.value)},${this.#currency()}`,
        ),
      ];
      return { filename: 'analytics-audience.csv', content: `\uFEFF${lines.join('\n')}\n` };
    }

    const report = this.revenueReport(
      input.range,
      input.granularity ?? input.range.granularity,
      comparison,
    );
    const lines = [
      'bucket,label,revenue,previous,currency',
      ...report.points.map((point) =>
        [
          csvCell(point.bucket),
          csvCell(point.label),
          String(point.revenue),
          point.previous === null ? '' : String(point.previous),
          report.currency,
        ].join(','),
      ),
    ];
    return { filename: 'analytics-revenue.csv', content: `\uFEFF${lines.join('\n')}\n` };
  }
}
