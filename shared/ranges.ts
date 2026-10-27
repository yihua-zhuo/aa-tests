import type { DateRangeKey, Granularity, RangeInfo } from './types.ts';

export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_CUSTOM_DAYS = 366;
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

export const RANGE_KEYS: readonly DateRangeKey[] = [
  'today',
  '7d',
  '30d',
  'month',
  'last_month',
  'custom',
];

export const RANGE_LABELS: Record<DateRangeKey, string> = {
  today: '今日',
  '7d': '最近 7 天',
  '30d': '最近 30 天',
  month: '本月',
  last_month: '上月',
  custom: '自定义',
};

export function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function isRangeKey(value: unknown): value is DateRangeKey {
  return typeof value === 'string' && (RANGE_KEYS as readonly string[]).includes(value);
}

export function utcDayKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function dayKeyInTimeZone(date: Date, timeZone: string): string {
  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

export function addDays(key: string, days: number): string {
  const date = new Date(`${key}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function diffDays(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

export function monthStart(key: string): string {
  return `${key.slice(0, 7)}-01`;
}

export function granularityFor(days: number): Granularity {
  if (days <= 31) return 'day';
  if (days <= 120) return 'week';
  return 'month';
}

export function previousPeriod(
  from: string,
  to: string,
): { from: string; to: string; days: number } {
  const days = diffDays(from, to) + 1;
  const prevTo = addDays(from, -1);
  return { from: addDays(prevTo, -(days - 1)), to: prevTo, days };
}

export type RangeInput = {
  range?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
};

export type RangeResolution = { ok: true; range: RangeInfo } | { ok: false; message: string };

export function resolveRange(
  input: RangeInput,
  now: Date = new Date(),
  timeZone: string = 'UTC',
): RangeResolution {
  const key = input.range ?? '30d';
  if (!isRangeKey(key)) {
    return { ok: false, message: '未知的时间范围' };
  }

  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const today = dayKeyInTimeZone(now, zone);
  let from: string;
  let to: string;

  switch (key) {
    case 'today':
      from = today;
      to = today;
      break;
    case '7d':
      from = addDays(today, -6);
      to = today;
      break;
    case '30d':
      from = addDays(today, -29);
      to = today;
      break;
    case 'month':
      from = monthStart(today);
      to = today;
      break;
    case 'last_month': {
      const first = monthStart(today);
      const lastMonthEnd = addDays(first, -1);
      from = monthStart(lastMonthEnd);
      to = lastMonthEnd;
      break;
    }
    case 'custom': {
      if (!input.from || !input.to) {
        return { ok: false, message: '自定义范围需要同时提供开始与结束日期' };
      }
      if (!isCalendarDate(input.from) || !isCalendarDate(input.to)) {
        return { ok: false, message: '日期需为 YYYY-MM-DD 格式' };
      }
      if (diffDays(input.from, input.to) < 0) {
        return { ok: false, message: '开始日期不能晚于结束日期' };
      }
      const days = diffDays(input.from, input.to) + 1;
      if (days > MAX_CUSTOM_DAYS) {
        return { ok: false, message: `自定义范围最多 ${MAX_CUSTOM_DAYS} 天` };
      }
      from = input.from;
      to = input.to;
      break;
    }
  }

  const days = diffDays(from, to) + 1;
  return {
    ok: true,
    range: {
      key,
      from,
      to,
      days,
      previous: previousPeriod(from, to),
      granularity: granularityFor(days),
      timezone: zone,
    },
  };
}

export function enumerateDays(from: string, to: string): string[] {
  const days: string[] = [];
  const total = diffDays(from, to);
  for (let index = 0; index <= total; index++) {
    days.push(addDays(from, index));
  }
  return days;
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

export function bucketStart(dateKey: string, granularity: Granularity): string {
  if (granularity === 'month') return monthStart(dateKey);
  if (granularity === 'day') return dateKey;
  const date = new Date(`${dateKey}T00:00:00Z`);
  const offset = (date.getUTCDay() + 6) % 7;
  return addDays(dateKey, -offset);
}

export function bucketLabel(bucket: string, granularity: Granularity): string {
  if (granularity === 'month') return bucket.slice(0, 7);
  if (granularity === 'week') {
    const date = new Date(`${bucket}T00:00:00Z`);
    return `${bucket.slice(5)} · 周${WEEKDAYS[date.getUTCDay()]}`;
  }
  return bucket.slice(5);
}

export function rangeLabel(range: Pick<RangeInfo, 'key' | 'from' | 'to'>): string {
  if (range.key !== 'custom' && range.key !== 'today') return RANGE_LABELS[range.key];
  if (range.from === range.to) return range.from;
  return `${range.from} ~ ${range.to}`;
}
