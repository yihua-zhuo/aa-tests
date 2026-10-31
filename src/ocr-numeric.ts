import type { DocumentFieldKind } from '../shared/types.ts';

/**
 * Numeric constrained decoding support. PaddleOCR's recognizer does not accept
 * a per-request character set, so this module never rewrites recognized text:
 * it builds a separate constrained candidate for amount/date/account/quantity
 * fields, validates it, and leaves the raw candidate for review. Callers may
 * only compare canonical values; the original string stays authoritative.
 */

export type OcrNumericKind = Exclude<DocumentFieldKind, 'text'>;

const DIGIT_CONFUSABLES: Record<string, string> = {
  O: '0',
  o: '0',
  Q: '0',
  D: '0',
  I: '1',
  l: '1',
  '|': '1',
  '!': '1',
  S: '5',
  s: '5',
  B: '8',
  Z: '2',
  z: '2',
  G: '6',
  b: '6',
  q: '9',
  g: '9',
  T: '7',
};

const AGGRESSIVE: ReadonlySet<OcrNumericKind> = new Set([
  'amount',
  'date',
  'quantity',
  'percentage',
  'number',
  'account',
]);

export function isNumericField(kind: DocumentFieldKind): kind is OcrNumericKind {
  return kind !== 'text';
}

function isDigit(char: string): boolean {
  return /\d/u.test(char);
}

/**
 * Replace OCR-confusable letters with digits. Amounts/dates/accounts allow the
 * full mapping; identifiers stay alphanumeric and only repair letters that sit
 * directly next to a digit (`INV-2O26` → `INV-2026`, never `1NV-2026`).
 */
export function sanitizeNumericText(value: string, kind: OcrNumericKind): string {
  const aggressive = AGGRESSIVE.has(kind);
  const chars = [...value];
  return chars
    .map((char, index) => {
      const replacement = DIGIT_CONFUSABLES[char];
      if (!replacement) return char;
      if (aggressive) return replacement;
      const before = chars[index - 1] ?? '';
      const after = chars[index + 1] ?? '';
      return isDigit(before) || isDigit(after) ? replacement : char;
    })
    .join('');
}

function digitsOnly(value: string): string {
  return value.replace(/\D+/gu, '');
}

const CN_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  壹: 1,
  二: 2,
  贰: 2,
  两: 2,
  三: 3,
  叁: 3,
  四: 4,
  肆: 4,
  五: 5,
  伍: 5,
  六: 6,
  陆: 6,
  七: 7,
  柒: 7,
  八: 8,
  捌: 8,
  九: 9,
  玖: 9,
};
const CN_SMALL_UNITS: Record<string, number> = {
  十: 10,
  拾: 10,
  百: 100,
  佰: 100,
  千: 1000,
  仟: 1000,
};

/**
 * Parse Chinese numerals (including financial forms) up to 亿. Used for
 * uppercase amounts and documents that spell numbers out. Returns null when
 * the text is not a pure Chinese numeral so callers never guess.
 */
export function parseChineseNumber(value: string): number | null {
  const text = value.replace(/[,\s，]/gu, '');
  if (!text) return null;
  const [integerText, fractionText] = text.split(/[点點]/u);
  if (
    !integerText ||
    !/^[零〇一壹二贰两三四叁肆五伍六陆七柒八捌九玖十拾百佰千仟万萬亿億]+$/u.test(integerText)
  ) {
    return null;
  }
  let total = 0;
  let section = 0;
  let digit = 0;
  let seen = false;
  for (const char of integerText) {
    if (char in CN_DIGITS) {
      digit = CN_DIGITS[char] ?? 0;
      seen = true;
      continue;
    }
    if (char in CN_SMALL_UNITS) {
      section += (digit || (seen ? 1 : 0)) * (CN_SMALL_UNITS[char] ?? 1);
      digit = 0;
      seen = true;
      continue;
    }
    const big = char === '亿' || char === '億' ? 100_000_000 : 10_000;
    section += digit;
    if (big === 100_000_000) {
      total = (total + section) * big;
    } else {
      total += section * big;
    }
    section = 0;
    digit = 0;
    seen = true;
  }
  total += section + digit;
  if (!seen) return null;
  if (fractionText === undefined) return total;
  if (!fractionText || !/^[零〇一壹二贰两三四叁肆五伍六陆七柒八捌九玖]+$/u.test(fractionText)) {
    return null;
  }
  const digits = [...fractionText].map((char) => CN_DIGITS[char] ?? 0);
  return total + Number(`0.${digits.join('')}`);
}

function normalizeNumericInput(value: string): string {
  return value
    .replace(FULLWIDTH_DIGITS, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    .replace(
      /[，．％－−]/gu,
      (mark) => ({ '，': ',', '．': '.', '％': '%', '－': '-', '−': '-' })[mark] ?? mark,
    )
    .replace(/[（）]/gu, (mark) => (mark === '（' ? '(' : ')'))
    .replace(/\s+/gu, '');
}

const FULLWIDTH_DIGITS = /[０-９]/g;

/** Canonical number: thousands separators removed, decimal marker kept. */
function canonicalNumber(value: string): string | null {
  let text = normalizeNumericInput(value);
  let negative = false;
  if (/^\(.*\)$/u.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (/-$/u.test(text)) {
    negative = true;
    text = text.slice(0, -1);
  }
  text = text
    .replace(/^(?:DR)/iu, '-')
    .replace(/^(?:CR)/iu, '')
    .replace(/[¥￥$€£%]/gu, '');
  if (/^-/u.test(text)) {
    negative = true;
    text = text.slice(1);
  }
  const match = text.match(/\d[\d,]*(?:\.\d+)?/u);
  if (!match) {
    const chinese = parseChineseNumber(text);
    return chinese === null ? null : String(negative ? -chinese : chinese);
  }
  const token = match[0];
  const [whole, fraction] = token.split('.');
  if (!whole) return null;
  const normalized = `${negative ? '-' : ''}${whole.replace(/,/gu, '')}${
    fraction === undefined ? '' : `.${fraction}`
  }`;
  return normalized.replace(/^-?0+(?=\d)/u, (prefix) => (prefix.startsWith('-') ? '-' : ''));
}

function canonicalDate(value: string): string | null {
  const groups = digitsOnly(value);
  if (groups.length !== 8) return null;
  const year = Number(groups.slice(0, 4));
  const month = Number(groups.slice(4, 6));
  const day = Number(groups.slice(6, 8));
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${groups.slice(0, 4)}-${groups.slice(4, 6)}-${groups.slice(6, 8)}`;
}

/**
 * Constrained candidate for one recognition result. `canonical` is null when
 * the text cannot satisfy the field kind; `invalid` is reported instead of
 * guessing a value.
 */
export type OcrNumericCandidate = {
  raw: string;
  sanitized: string;
  canonical: string | null;
  valid: boolean;
};

export function numericCandidate(raw: string, kind: OcrNumericKind): OcrNumericCandidate {
  const sanitized = sanitizeNumericText(raw.trim(), kind);
  let canonical: string | null;
  let valid: boolean;
  switch (kind) {
    case 'date':
      canonical = canonicalDate(sanitized);
      valid = canonical !== null;
      break;
    case 'account':
      canonical = digitsOnly(sanitized) || null;
      valid = canonical !== null && canonical.length >= 8 && canonical.length <= 32;
      break;
    case 'identifier':
      canonical = sanitized.replace(/\s+/gu, '');
      valid = canonical.length > 0;
      break;
    case 'percentage': {
      canonical = canonicalNumber(sanitized);
      const value = canonical === null ? Number.NaN : Number(canonical);
      valid = Number.isFinite(value) && value >= 0 && value <= 100;
      break;
    }
    default:
      canonical = canonicalNumber(sanitized);
      valid = canonical !== null;
      break;
  }
  return { raw, sanitized, canonical: valid ? canonical : null, valid };
}

/**
 * Compare two values under the field's numeric constraint. Returns false when
 * either side cannot be constrained, so a malformed candidate is never treated
 * as agreement.
 */
export function numericEquivalent(kind: DocumentFieldKind, left: string, right: string): boolean {
  if (!isNumericField(kind)) return false;
  const a = numericCandidate(left, kind);
  const b = numericCandidate(right, kind);
  if (!a.valid || !b.valid) return false;
  return a.canonical === b.canonical;
}

export type OcrNumericSemantics = {
  value: number | null;
  sign: -1 | 0 | 1;
  currency: string | null;
  /** Multiplier from a column/table unit such as 万元. */
  scale: number | null;
  percent: boolean;
};

const UNIT_SCALES: Record<string, number> = {
  元: 1,
  千元: 1_000,
  万元: 10_000,
  百万元: 1_000_000,
  亿元: 100_000_000,
};
const CURRENCY_SYMBOLS: Record<string, string> = {
  '¥': 'CNY',
  '￥': 'CNY',
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
};

/**
 * Interpret an amount together with its unit/currency context. The canonical
 * value is `value × scale`; sign and currency stay separate so downstream
 * validation can compare amounts without losing semantics.
 */
export function numericSemantics(
  value: string,
  options: { unit?: string | null; currency?: string | null } = {},
): OcrNumericSemantics {
  const text = normalizeNumericInput(value);
  const canonical = canonicalNumber(text);
  const numeric = canonical === null ? null : Number(canonical);
  const symbol = /[¥￥$€£]/u.exec(value)?.[0] ?? null;
  const unit = options.unit?.replace(/\s+/gu, '') ?? null;
  const scale = unit ? (UNIT_SCALES[unit] ?? null) : null;
  return {
    value: numeric,
    sign: numeric === null || numeric === 0 ? 0 : numeric < 0 ? -1 : 1,
    currency: options.currency ?? (symbol ? (CURRENCY_SYMBOLS[symbol] ?? null) : null),
    scale,
    percent: /[%％]/u.test(value),
  };
}
