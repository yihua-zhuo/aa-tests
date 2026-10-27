import type { CurrencyCode } from './types.ts';

export const CURRENCIES: readonly CurrencyCode[] = [
  'USD',
  'CNY',
  'EUR',
  'GBP',
  'JPY',
  'HKD',
  'SGD',
];

export const CURRENCY_LABELS: Record<CurrencyCode, string> = {
  USD: '美元 USD',
  CNY: '人民币 CNY',
  EUR: '欧元 EUR',
  GBP: '英镑 GBP',
  JPY: '日元 JPY',
  HKD: '港币 HKD',
  SGD: '新加坡元 SGD',
};

/** Units of each currency per one US dollar. Metrics are stored in USD cents. */
export const DEFAULT_RATES: Record<CurrencyCode, number> = {
  USD: 1,
  CNY: 7.2,
  EUR: 0.92,
  GBP: 0.79,
  JPY: 145,
  HKD: 7.8,
  SGD: 1.34,
};
