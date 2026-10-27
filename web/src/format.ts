import { isValidTimeZone } from '../../shared/ranges.ts';
import type { CurrencyCode } from '../../shared/types.ts';
import { getLocale, t } from './i18n.ts';

let cachedLocale: string | null = null;
let cachedCurrency: CurrencyCode = 'USD';
let displayCurrency: CurrencyCode = 'USD';
let currency = new Intl.NumberFormat('zh-CN', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});
let compactCurrency = new Intl.NumberFormat('zh-CN', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});
let compactNumber = new Intl.NumberFormat('zh-CN', {
  notation: 'compact',
  maximumFractionDigits: 1,
});
let plainNumber = new Intl.NumberFormat('zh-CN');

function formatters(): {
  currency: Intl.NumberFormat;
  compactCurrency: Intl.NumberFormat;
  compact: Intl.NumberFormat;
  plain: Intl.NumberFormat;
} {
  const locale = getLocale();
  if (cachedLocale !== locale || cachedCurrency !== displayCurrency) {
    cachedLocale = locale;
    cachedCurrency = displayCurrency;
    currency = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: displayCurrency,
      maximumFractionDigits: 0,
    });
    compactCurrency = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: displayCurrency,
      notation: 'compact',
      maximumFractionDigits: 1,
    });
    compactNumber = new Intl.NumberFormat(locale, {
      notation: 'compact',
      maximumFractionDigits: 1,
    });
    plainNumber = new Intl.NumberFormat(locale);
  }
  return { currency, compactCurrency, compact: compactNumber, plain: plainNumber };
}

export function setDisplayCurrency(code: CurrencyCode): void {
  displayCurrency = code;
}

let displayTimeZone: string | undefined;

export function setDisplayTimeZone(timeZone: string | undefined): void {
  displayTimeZone = timeZone && isValidTimeZone(timeZone) ? timeZone : undefined;
}

export function formatCurrency(value: number): string {
  return formatters().currency.format(value);
}

export function formatCompactCurrency(value: number): string {
  const f = formatters();
  if (Math.abs(value) >= 10_000) return f.compactCurrency.format(value);
  return f.currency.format(value);
}

export function formatNumber(value: number): string {
  return formatters().plain.format(value);
}

export function formatPercent(value: number): string {
  return `${value.toFixed(Math.abs(value) >= 10 ? 1 : 2)}%`;
}

export function formatDelta(value: number | null, unit: 'percent' | 'point' = 'percent'): string {
  if (value === null || Number.isNaN(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return unit === 'point' ? `${sign}${value.toFixed(2)} pt` : `${sign}${value.toFixed(1)}%`;
}

export function formatDate(value: string): string {
  if (!value) return '—';
  // Date-only fields are calendar dates and must not shift across time zones.
  const dateOnly = !value.includes('T');
  const date = new Date(dateOnly ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(getLocale(), {
    month: 'short',
    day: 'numeric',
    timeZone: dateOnly ? 'UTC' : displayTimeZone,
  }).format(date);
}

export function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(getLocale(), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: displayTimeZone,
  }).format(date);
}

export function timeAgo(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 45) return t('time.justNow');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t('time.minutes', { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('time.hours', { count: hours });
  const days = Math.round(hours / 24);
  if (days < 7) return t('time.days', { count: days });
  return formatDate(value);
}

export function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/);
  if (parts.length > 1) {
    return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

export function greeting(): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      hourCycle: 'h23',
      timeZone: displayTimeZone,
    }).format(new Date()),
  );
  if (getLocale() === 'en') {
    if (hour < 6) return 'Working late';
    if (hour < 12) return 'Good morning';
    if (hour < 14) return 'Good afternoon';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  }
  if (hour < 6) return '夜深了';
  if (hour < 12) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}
