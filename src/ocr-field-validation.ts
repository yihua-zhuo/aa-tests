import { parseChineseNumber } from './ocr-numeric.ts';

/**
 * Independent evidence for high-risk fields. Checksums and the uppercase
 * amount are not produced by OCR, so a failure is a real conflict rather than
 * another correlated recognition pass. Nothing here rewrites recognized text.
 */

export type IdentifierKind = 'uscc' | 'id_card' | 'bank_card' | 'iban' | 'isbn' | 'vin';

const USCC_CHARSET = '0123456789ABCDEFGHJKLMNPQRTUWXY';
const USCC_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CHECK = '10X98765432';
const VIN_TRANSLITERATION: Record<string, number> = {
  A: 1,
  B: 2,
  C: 3,
  D: 4,
  E: 5,
  F: 6,
  G: 7,
  H: 8,
  J: 1,
  K: 2,
  L: 3,
  M: 4,
  N: 5,
  P: 7,
  R: 9,
  S: 2,
  T: 3,
  U: 4,
  V: 5,
  W: 6,
  X: 7,
  Y: 8,
  Z: 9,
};
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

export function luhnValid(value: string): boolean {
  const digits = value.replace(/\D+/gu, '');
  if (digits.length < 12 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

export function usccValid(value: string): boolean {
  const code = value.trim().toUpperCase();
  if (!/^[0-9A-HJ-NPQRTUWXY]{18}$/u.test(code)) return false;
  let sum = 0;
  for (let index = 0; index < 17; index += 1) {
    const char = USCC_CHARSET.indexOf(code[index] ?? '');
    if (char < 0) return false;
    sum += char * (USCC_WEIGHTS[index] ?? 0);
  }
  const check = USCC_CHARSET[(31 - (sum % 31)) % 31];
  return code[17] === check;
}

export function idCardValid(value: string): boolean {
  const code = value.trim().toUpperCase();
  if (!/^\d{17}[\dX]$/u.test(code)) return false;
  const birth = code.slice(6, 14);
  const year = Number(birth.slice(0, 4));
  const month = Number(birth.slice(4, 6));
  const day = Number(birth.slice(6, 8));
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  let sum = 0;
  for (let index = 0; index < 17; index += 1) {
    sum += Number(code[index]) * (ID_WEIGHTS[index] ?? 0);
  }
  return code[17] === ID_CHECK[sum % 11];
}

export function ibanValid(value: string): boolean {
  const code = value.replace(/\s+/gu, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/u.test(code) || code.length > 34) return false;
  const rearranged = `${code.slice(4)}${code.slice(0, 4)}`;
  let remainder = 0;
  for (const char of rearranged) {
    const chunk = /\d/u.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of chunk) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

export function isbnValid(value: string): boolean {
  const code = value.replace(/[-\s]/gu, '').toUpperCase();
  if (/^\d{9}[\dX]$/u.test(code)) {
    let sum = 0;
    for (let index = 0; index < 10; index += 1) {
      const digit = code[index] === 'X' ? 10 : Number(code[index]);
      sum += digit * (10 - index);
    }
    return sum % 11 === 0;
  }
  if (/^(?:978|979)\d{10}$/u.test(code)) {
    let sum = 0;
    for (let index = 0; index < 13; index += 1) {
      sum += Number(code[index]) * (index % 2 === 0 ? 1 : 3);
    }
    return sum % 10 === 0;
  }
  return false;
}

export function vinValid(value: string): boolean {
  const code = value.trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/u.test(code)) return false;
  let sum = 0;
  for (let index = 0; index < 17; index += 1) {
    if (index === 8) continue;
    const char = code[index] ?? '';
    const numeric = /\d/u.test(char) ? Number(char) : VIN_TRANSLITERATION[char];
    if (numeric === undefined) return false;
    sum += numeric * (VIN_WEIGHTS[index] ?? 0);
  }
  const remainder = sum % 11;
  const check = remainder === 10 ? 'X' : String(remainder);
  return code[8] === check;
}

const CHECKERS: Record<IdentifierKind, (value: string) => boolean> = {
  uscc: usccValid,
  id_card: idCardValid,
  bank_card: luhnValid,
  iban: ibanValid,
  isbn: isbnValid,
  vin: vinValid,
};

export function identifierValid(kind: IdentifierKind, value: string): boolean {
  return CHECKERS[kind](value);
}

const LABELED_IDENTIFIERS: { kind: IdentifierKind; pattern: RegExp }[] = [
  {
    kind: 'uscc',
    pattern: /(?:统一社会信用代码|社会信用代码|uscc)\s*[:：#]?\s*([0-9A-HJ-NPQRTUWXY]{18})/giu,
  },
  {
    kind: 'id_card',
    pattern: /(?:身份证(?:号码|号)?|证件号码|identity\s*(?:card|no))\s*[:：#]?\s*(\d{17}[\dXx])/giu,
  },
  {
    kind: 'bank_card',
    pattern: /(?:银行(?:卡|账号)|卡号|账号|account|card)\s*[:：#]?\s*((?:\d[ -]?){12,23}\d)/giu,
  },
  {
    kind: 'iban',
    pattern: /\b(IBAN)\s*[:：#]?\s*([A-Z]{2}\d{2}[A-Z0-9 ]{11,30})/giu,
  },
  {
    kind: 'isbn',
    pattern: /(?:ISBN(?:-1[03])?)\s*[:：#]?\s*([\dXx -]{10,20})/giu,
  },
  {
    kind: 'vin',
    pattern: /(?:VIN|车架号)\s*[:：#]?\s*([A-HJ-NPR-Z0-9]{17})/giu,
  },
];

export type IdentifierViolation = {
  kind: IdentifierKind;
  value: string;
};

/** Labeled identifiers whose checksum fails; unlabeled numbers are ignored. */
export function invalidIdentifiers(text: string): IdentifierViolation[] {
  const violations: IdentifierViolation[] = [];
  const seen = new Set<string>();
  for (const { kind, pattern } of LABELED_IDENTIFIERS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const value = (match[kind === 'iban' ? 2 : 1] ?? '').trim();
      if (!value) continue;
      const key = `${kind}:${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!identifierValid(kind, value)) violations.push({ kind, value: value.slice(0, 40) });
    }
  }
  return violations;
}

const CHINESE_MONEY =
  /^(.*?)(?:元|圆)零?(?:([零〇壹贰叁肆伍陆柒捌玖])(?:角))?零?(?:([零〇壹贰叁肆伍陆柒捌玖])(?:分))?(?:整|正)?$/u;
const UPPERCASE_AMOUNT =
  /(?:人民币|RMB)?\s*[（(]?\s*大写\s*[)）]?\s*[:：]?\s*([零〇壹贰叁肆伍陆柒捌玖拾佰仟万亿億圆元角分整正]{2,})/giu;
const NUMERIC_AMOUNT = /[¥￥]?\s*[（(]?\s*-?\d[\d,，]*(?:\.\d{1,2})?\s*[)）]?/gu;

/** Parse an uppercase Chinese money phrase such as 壹万贰仟元伍角. */
export function parseChineseMoney(phrase: string): number | null {
  const text = phrase.replace(/[人民币RMB\s]/gu, '');
  const match = text.match(CHINESE_MONEY);
  if (!match) return null;
  const integer = parseChineseNumber(match[1] ?? '');
  if (integer === null) return null;
  const jiao = match[2] ? (parseChineseNumber(match[2]) ?? 0) : 0;
  const fen = match[3] ? (parseChineseNumber(match[3]) ?? 0) : 0;
  return integer + jiao / 10 + fen / 100;
}

export type AmountWordsCheck = {
  /** Parsed uppercase amount, null when the document has none. */
  uppercase: number | null;
  /** null when there is no lowercase amount to compare with. */
  matched: boolean | null;
};

/**
 * Compare the uppercase amount (壹万贰仟元整) with any lowercase amount in the
 * same text. Documents often carry both, which is independent redundancy.
 */
export function amountWordsCheck(text: string): AmountWordsCheck {
  let uppercase: number | null = null;
  UPPERCASE_AMOUNT.lastIndex = 0;
  for (const match of text.matchAll(UPPERCASE_AMOUNT)) {
    const parsed = parseChineseMoney(match[1] ?? '');
    if (parsed !== null) {
      uppercase = parsed;
      break;
    }
  }
  if (uppercase === null) return { uppercase: null, matched: null };
  const amounts: number[] = [];
  NUMERIC_AMOUNT.lastIndex = 0;
  for (const match of text.matchAll(NUMERIC_AMOUNT)) {
    const token = (match[0] ?? '').replace(/[¥￥,，\s（）()]/gu, '');
    if (!token) continue;
    const value = Number(token);
    if (Number.isFinite(value)) amounts.push(value);
  }
  if (amounts.length === 0) return { uppercase, matched: null };
  // Table headers may declare 万元/千元 while the uppercase amount is in yuan.
  const scales = [1, 1_000, 10_000, 1_000_000, 100_000_000];
  return {
    uppercase,
    matched: amounts.some((value) =>
      scales.some((scale) => Math.abs(value * scale - uppercase) < 0.01),
    ),
  };
}
