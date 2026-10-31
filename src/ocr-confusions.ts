import type {
  OcrConfusionKind,
  OcrConfusionPair,
  OcrConfusionReport,
  OcrErrorDiagnosis,
  OcrErrorSpan,
} from '../shared/types.ts';

const FULLWIDTH = /[\uff01-\uff5e\u3000-\u303f]/u;
const PUNCTUATION = /[,.!?;:，。！？；：、'"“”‘’()（）[\]【】-]/u;
const ALIGN_LIMIT = 1_500;
const MAX_ERROR_SPANS = 50;
const SPAN_CONTEXT = 10;

/** Classes where OCR commonly swaps one glyph for another. */
const CONFUSION_CLASSES: readonly (readonly string[])[] = [
  ['0', 'O', 'o', 'D', 'Q'],
  ['1', 'I', 'l', 'i', '|', '!', '7'],
  ['2', 'Z', 'z'],
  ['5', 'S', 's'],
  ['6', 'G', 'b'],
  ['8', 'B'],
  ['9', 'g', 'q'],
  ['u', 'v', 'ü'],
  ['m', 'rn', 'nn'],
  ['c', 'e'],
];

const CLASS_OF = new Map<string, number>();
for (const [index, group] of CONFUSION_CLASSES.entries()) {
  for (const char of group) CLASS_OF.set(char, index);
}

function foldWidth(char: string): string {
  const code = char.codePointAt(0) ?? 0;
  if (code >= 0xff01 && code <= 0xff5e) return String.fromCodePoint(code - 0xfee0);
  if (code === 0x3000) return ' ';
  const map: Record<string, string> = {
    '。': '.',
    '，': ',',
    '；': ';',
    '：': ':',
    '！': '!',
    '？': '?',
    '（': '(',
    '）': ')',
    '【': '[',
    '】': ']',
  };
  return map[char] ?? char;
}

export function normalizeConfusionText(value: string): string {
  // Keep full-width forms; width disagreements are one of the matrices we want.
  return value.normalize('NFC').toLowerCase().replace(/\s+/gu, '');
}

function isDigit(char: string): boolean {
  return /^\p{Nd}$/u.test(char);
}

function isLetter(char: string): boolean {
  return /^\p{L}$/u.test(char);
}

function confusionKind(expected: string, observed: string): OcrConfusionKind {
  if (FULLWIDTH.test(expected) !== FULLWIDTH.test(observed)) return 'width';
  if (foldWidth(expected) === foldWidth(observed)) return 'width';
  if (isDigit(expected) && isDigit(observed)) return 'digit';
  const leftClass = CLASS_OF.get(expected);
  const rightClass = CLASS_OF.get(observed);
  if (leftClass !== undefined && leftClass === rightClass) {
    return isDigit(expected) || isDigit(observed) ? 'digit' : 'letter';
  }
  if (PUNCTUATION.test(expected) && PUNCTUATION.test(observed)) return 'punctuation';
  if (isLetter(expected) && isLetter(observed)) return 'letter';
  if (isDigit(expected) || isDigit(observed)) return 'digit';
  if (PUNCTUATION.test(expected) || PUNCTUATION.test(observed)) return 'punctuation';
  return 'other';
}

type Operation =
  | {
      type: 'match' | 'sub';
      expected: string;
      observed: string;
      expectedOffset: number;
      observedOffset: number;
    }
  | { type: 'insert'; observed: string; observedOffset: number }
  | { type: 'delete'; expected: string; expectedOffset: number };

function align(left: readonly string[], right: readonly string[]): Operation[] {
  const rows = left.length + 1;
  const columns = right.length + 1;
  const distance = new Uint32Array(rows * columns);
  for (let i = 0; i < rows; i += 1) distance[i * columns] = i;
  for (let j = 0; j < columns; j += 1) distance[j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < columns; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      distance[i * columns + j] = Math.min(
        distance[(i - 1) * columns + j] + 1,
        distance[i * columns + (j - 1)] + 1,
        distance[(i - 1) * columns + (j - 1)] + cost,
      );
    }
  }
  const operations: Operation[] = [];
  let i = left.length;
  let j = right.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      if (distance[i * columns + j] === distance[(i - 1) * columns + (j - 1)] + cost) {
        operations.push({
          type: cost === 0 ? 'match' : 'sub',
          expected: left[i - 1] ?? '',
          observed: right[j - 1] ?? '',
          expectedOffset: i - 1,
          observedOffset: j - 1,
        });
        i -= 1;
        j -= 1;
        continue;
      }
    }
    if (i > 0 && distance[i * columns + j] === distance[(i - 1) * columns + j] + 1) {
      operations.push({ type: 'delete', expected: left[i - 1] ?? '', expectedOffset: i - 1 });
      i -= 1;
    } else {
      operations.push({
        type: 'insert',
        observed: right[j - 1] ?? '',
        observedOffset: j - 1,
      });
      j -= 1;
    }
  }
  return operations.reverse();
}

function spanContext(chars: readonly string[], offset: number | null): string {
  if (offset === null) return '';
  const start = Math.max(0, offset - SPAN_CONTEXT);
  const end = Math.min(chars.length, offset + SPAN_CONTEXT + 1);
  return `${start > 0 ? '…' : ''}${chars.slice(start, end).join('')}${end < chars.length ? '…' : ''}`;
}

function errorSpan(
  operation: Operation,
  left: readonly string[],
  right: readonly string[],
): OcrErrorSpan | null {
  if (operation.type === 'match') return null;
  if (operation.type === 'sub') {
    return {
      type: 'sub',
      expectedOffset: operation.expectedOffset,
      observedOffset: operation.observedOffset,
      expected: operation.expected,
      observed: operation.observed,
      expectedContext: spanContext(left, operation.expectedOffset),
      observedContext: spanContext(right, operation.observedOffset),
    };
  }
  if (operation.type === 'insert') {
    return {
      type: 'insert',
      expectedOffset: null,
      observedOffset: operation.observedOffset,
      expected: '',
      observed: operation.observed,
      expectedContext: '',
      observedContext: spanContext(right, operation.observedOffset),
    };
  }
  return {
    type: 'delete',
    expectedOffset: operation.expectedOffset,
    observedOffset: null,
    expected: operation.expected,
    observed: '',
    expectedContext: spanContext(left, operation.expectedOffset),
    observedContext: '',
  };
}

function emptyReport(): OcrConfusionReport {
  return {
    substitutions: 0,
    matrix: [],
    spans: [],
    widthErrors: 0,
    punctuationErrors: 0,
    numeric: {
      expectedDigits: 0,
      matchedDigits: 0,
      substituted: 0,
      inserted: 0,
      deleted: 0,
    },
  };
}

function mergePair(report: OcrConfusionReport, expected: string, observed: string): void {
  const kind = confusionKind(expected, observed);
  const pair = `${expected}→${observed}`;
  const existing = report.matrix.find((item) => item.pair === pair);
  if (existing) existing.count += 1;
  else report.matrix.push({ pair, kind, count: 1 });
}

function digitOnly(value: string): string {
  return [...value].filter((char) => isDigit(char)).join('');
}

/**
 * Confusable-pair matrix. Alignment is performed on whitespace-free text so
 * line wrapping is not mistaken for substitutions; full-width and punctuation
 * disagreements are counted separately for targeted retraining.
 */
export function confusionMatrix(expected: string, actual: string): OcrConfusionReport {
  const report = emptyReport();
  const left = [...normalizeConfusionText(expected)].slice(0, ALIGN_LIMIT);
  const right = [...normalizeConfusionText(actual)].slice(0, ALIGN_LIMIT);
  const operations = align(left, right);
  for (const operation of operations) {
    if (operation.type === 'match') continue;
    if (report.spans && report.spans.length < MAX_ERROR_SPANS) {
      const span = errorSpan(operation, left, right);
      if (span) report.spans.push(span);
    }
    if (operation.type === 'sub') {
      report.substitutions += 1;
      mergePair(report, operation.expected, operation.observed);
      const kind = confusionKind(operation.expected, operation.observed);
      if (kind === 'width') report.widthErrors += 1;
      if (kind === 'punctuation') report.punctuationErrors += 1;
    }
  }
  report.matrix.sort((leftPair, rightPair) => rightPair.count - leftPair.count);

  const expectedDigits = [...digitOnly(normalizeConfusionText(expected))].slice(0, ALIGN_LIMIT);
  const actualDigits = [...digitOnly(normalizeConfusionText(actual))].slice(0, ALIGN_LIMIT);
  report.numeric.expectedDigits = expectedDigits.length;
  for (const operation of align(expectedDigits, actualDigits)) {
    if (operation.type === 'match') report.numeric.matchedDigits += 1;
    else if (operation.type === 'sub') report.numeric.substituted += 1;
    else if (operation.type === 'insert') report.numeric.inserted += 1;
    else report.numeric.deleted += 1;
  }
  return report;
}

/** Merge per-file matrices into one corpus report. */
export function mergeConfusions(
  reports: readonly (OcrConfusionReport | null)[],
): OcrConfusionReport {
  const merged = emptyReport();
  for (const report of reports) {
    if (!report) continue;
    merged.substitutions += report.substitutions;
    merged.widthErrors += report.widthErrors;
    merged.punctuationErrors += report.punctuationErrors;
    merged.numeric.expectedDigits += report.numeric.expectedDigits;
    merged.numeric.matchedDigits += report.numeric.matchedDigits;
    merged.numeric.substituted += report.numeric.substituted;
    merged.numeric.inserted += report.numeric.inserted;
    merged.numeric.deleted += report.numeric.deleted;
    for (const item of report.matrix) {
      const existing = merged.matrix.find((entry) => entry.pair === item.pair);
      if (existing) existing.count += item.count;
      else merged.matrix.push({ ...item });
    }
  }
  merged.matrix.sort((left, right) => right.count - left.count);
  merged.matrix = merged.matrix.slice(0, 40);
  return merged;
}

function compact(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}%]+/gu, '');
}

function internalLevenshtein(left: string, right: string): number {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

export type DiagnosisOptions = {
  tableCellAccuracy?: number | null;
  tableRowsF1?: number | null;
  /** True when the extraction produced no text at all. */
  empty?: boolean;
};

/**
 * Attribute text errors to detection (missing boxes), segmentation (merged or
 * split lines/cells) or recognition (similar-glyph substitution). The result is
 * advisory: it selects which recovery to try, never edits the text.
 */
export function diagnoseErrors(
  expected: string,
  actual: string,
  options: DiagnosisOptions = {},
): OcrErrorDiagnosis {
  const reasons: string[] = [];
  const truth = compact(expected);
  const observed = compact(actual);
  let detectionSuspect = false;
  let segmentationSuspect = false;
  let recognitionSuspect = false;

  if (options.empty || observed.length === 0) {
    detectionSuspect = true;
    reasons.push('没有识别出文本，疑似检测/版面阶段丢失');
    return { detectionSuspect, segmentationSuspect, recognitionSuspect, reasons };
  }

  const distance = internalLevenshtein(truth, observed);
  const errorRate = truth.length > 0 ? distance / truth.length : 0;
  const missing = Math.max(0, truth.length - observed.length);
  const missingRate = truth.length > 0 ? missing / truth.length : 0;

  if (errorRate > 0.02) {
    if (missingRate > 0.12) {
      detectionSuspect = true;
      reasons.push(`文本比真值少 ${Math.round(missingRate * 100)}%，疑似漏检或页/区域遗漏`);
    }
    if (truth.length > 0 && observed.length > 0) {
      const lengthRatio = observed.length / truth.length;
      if (lengthRatio >= 0.85 && lengthRatio <= 1.18 && missingRate <= 0.12) {
        recognitionSuspect = true;
        reasons.push(`长度接近但字符距离 ${Math.round(errorRate * 100)}%，疑似识别替换`);
      }
    }
    const expectedLines = expected.split(/\r?\n/).filter((line) => line.trim() !== '').length;
    const actualLines = actual.split(/\r?\n/).filter((line) => line.trim() !== '').length;
    if (expectedLines >= 3 && actualLines < expectedLines * 0.7) {
      segmentationSuspect = true;
      reasons.push(`行数 ${actualLines}/${expectedLines}，疑似行切分合并`);
    }
    const matrix = confusionMatrix(expected, actual);
    const confusable = matrix.matrix
      .filter((item) => item.kind === 'digit' || item.kind === 'letter')
      .reduce((sum, item) => sum + item.count, 0);
    if (confusable >= Math.max(2, matrix.substitutions * 0.5)) {
      recognitionSuspect = true;
      reasons.push(`${confusable} 处相似字符替换`);
    }
  }

  if (
    options.tableCellAccuracy !== null &&
    options.tableCellAccuracy !== undefined &&
    options.tableCellAccuracy < 0.6 &&
    (options.tableRowsF1 ?? 0) >= 0.8
  ) {
    segmentationSuspect = true;
    reasons.push('表格行列存在但单元格文本错位，疑似单元格切分');
  }
  if (reasons.length === 0) reasons.push('未发现明显检测/切分问题');
  return { detectionSuspect, segmentationSuspect, recognitionSuspect, reasons };
}

/** Ordered confusion classes for targeted test sampling and UI display. */
export function confusionClasses(): readonly (readonly string[])[] {
  return CONFUSION_CLASSES;
}

export function pairIsKnown(pair: OcrConfusionPair): boolean {
  return pair.kind === 'digit' || pair.kind === 'letter' || pair.kind === 'width';
}

export type OcrRuntimeStage = 'detection' | 'segmentation' | 'recognition' | 'none';

export type OcrRuntimeDiagnosis = {
  stage: OcrRuntimeStage;
  /** Recovery actions ordered by expected value for the diagnosed stage. */
  actions: ('rerun_detection' | 'rerun_structure' | 'adjust_crop' | 'switch_recognizer')[];
  reasons: string[];
};

const DETECTION_ISSUES = new Set([
  'empty_page',
  'low_coverage',
  'reading_order',
  'block_validation',
  'page_omission',
  'ink_without_text',
]);
const SEGMENTATION_ISSUES = new Set([
  'table_integrity',
  'table_structure_risk',
  'cell_type_mismatch',
  'field_mismatch',
  'business_constraint',
  'cell_recovery_conflict',
]);
const RECOGNITION_ISSUES = new Set([
  'low_confidence',
  'key_field_low_confidence',
  'small_text',
  'character_substitution',
  'digit_confusion',
]);

/**
 * Runtime counterpart of `diagnoseErrors`: without ground truth, quality
 * signals decide whether to spend a whole-page detection rerun, a structure
 * rerun, or local crop/recognizer retries. Advisory only; the cascade still
 * gates every action by budget and expected value.
 */
export function diagnoseQuality(
  issueCodes: readonly string[],
  options: { empty?: boolean } = {},
): OcrRuntimeDiagnosis {
  const codes = new Set(issueCodes);
  const reasons: string[] = [];
  let detection = 0;
  let segmentation = 0;
  let recognition = 0;
  for (const code of codes) {
    if (DETECTION_ISSUES.has(code)) detection += 1;
    else if (SEGMENTATION_ISSUES.has(code)) segmentation += 1;
    else if (RECOGNITION_ISSUES.has(code)) recognition += 1;
  }
  if (options.empty || codes.has('empty_page')) {
    return {
      stage: 'detection',
      actions: ['rerun_detection', 'rerun_structure'],
      reasons: ['没有识别出文本或页面为空，优先重跑检测'],
    };
  }
  if (detection === 0 && segmentation === 0 && recognition === 0) {
    return { stage: 'none', actions: [], reasons: ['未发现明显检测/切分/识别问题'] };
  }
  if (detection >= Math.max(1, segmentation, recognition)) {
    if (detection > 0) reasons.push(`${detection} 个检测/版面信号，疑似漏检或阅读顺序丢失`);
    return {
      stage: detection > 0 ? 'detection' : 'none',
      actions: detection > 0 ? ['rerun_detection', 'rerun_structure', 'adjust_crop'] : [],
      reasons: detection > 0 ? reasons : ['未发现明显检测/切分问题'],
    };
  }
  if (segmentation >= recognition) {
    reasons.push(`${segmentation} 个表格/字段信号，疑似切分或单元格错位`);
    return {
      stage: 'segmentation',
      actions: ['rerun_structure', 'adjust_crop', 'switch_recognizer'],
      reasons,
    };
  }
  reasons.push(`${recognition} 个置信度/字符信号，疑似识别器误读`);
  return { stage: 'recognition', actions: ['switch_recognizer', 'adjust_crop'], reasons };
}
