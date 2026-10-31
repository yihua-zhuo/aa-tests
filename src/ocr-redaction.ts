import type { OcrRedactionSummary } from '../shared/types.ts';

type RedactionRule = {
  kind: keyof OcrRedactionSummary;
  label: string;
  pattern: RegExp;
};

/**
 * Order matters: MRZ rows and national IDs are replaced before the generic
 * card pattern so a long digit run cannot be mislabelled. Every rule is
 * deliberately boundary-anchored to avoid corrupting adjacent invoice numbers.
 */
const RULES: RedactionRule[] = [
  { kind: 'mrzLines', label: '[MRZ]', pattern: /^[A-Z0-9<]{30,44}[ \t]*\r?$/gm },
  {
    kind: 'idCards',
    label: '[身份证]',
    pattern: /(?<![0-9A-Za-z])\d{17}[\dXx](?![0-9A-Za-z])/g,
  },
  {
    kind: 'emails',
    label: '[邮箱]',
    pattern: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu,
  },
  {
    kind: 'phones',
    label: '[手机号]',
    pattern: /(?<!\d)(?:\+?86[\s-]?)?1[3-9]\d(?:[ -]?\d){8}(?!\d)/g,
  },
  { kind: 'landlines', label: '[电话]', pattern: /(?<!\d)0\d{2,3}[-\s]?\d{7,8}(?!\d)/g },
  {
    kind: 'bankCards',
    label: '[银行卡]',
    pattern: /(?<!\d)(?:\d[ -]?){16,19}(?!\d)/g,
  },
];

export function redactOcrText(text: string): {
  text: string;
  redactions: OcrRedactionSummary;
} {
  const redactions: OcrRedactionSummary = {
    idCards: 0,
    phones: 0,
    landlines: 0,
    emails: 0,
    bankCards: 0,
    mrzLines: 0,
  };
  let redacted = text;
  for (const rule of RULES) {
    redacted = redacted.replace(rule.pattern, () => {
      redactions[rule.kind] += 1;
      return rule.label;
    });
  }
  return { text: redacted, redactions };
}

export function redactionTotal(summary: OcrRedactionSummary): number {
  return (
    summary.idCards +
    summary.phones +
    summary.landlines +
    summary.emails +
    summary.bankCards +
    summary.mrzLines
  );
}
