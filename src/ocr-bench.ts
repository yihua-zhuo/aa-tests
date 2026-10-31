import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import type {
  DocumentBBox,
  DocumentBlock,
  DocumentIr,
  OcrBenchAggregate,
  OcrBenchBusinessLoss,
  OcrBenchCalibration,
  OcrBenchCalibrationBin,
  OcrBenchCalibrationGroup,
  OcrBenchDifficulty,
  OcrBenchFieldCategory,
  OcrBenchFieldOutcome,
  OcrBenchFieldReliability,
  OcrBenchFile,
  OcrBenchFileResult,
  OcrBenchGate,
  OcrBenchGateCheck,
  OcrBenchGroup,
  OcrBenchProvenance,
  OcrBenchRun,
  OcrBenchSplit,
  OcrBenchSplitSummary,
  OcrBenchStatus,
  OcrBenchTableMetrics,
  OcrCalibrationSample,
  OcrEngine,
  OcrErrorBreakdown,
  OcrMode,
  OcrModelRuntime,
  OcrStageReplayTarget,
  OcrThresholdFitOptions,
  OcrThresholdProfile,
} from '../shared/types.ts';
import { isOcrBenchSplit } from '../shared/types.ts';
import { log } from './logger.ts';
import { displayModelName, type OcrClient, ocrEngineFor } from './ocr.ts';
import { type OcrStageReplayResult, replayOcrStage, runOcrCascade } from './ocr-cascade.ts';
import { confusionMatrix, diagnoseErrors, mergeConfusions } from './ocr-confusions.ts';
import {
  normalizeExperimentRequest,
  type OcrExperimentRequest,
  type OcrExperimentResult,
  type OcrExperimentSample,
  type OcrExperimentStage,
  type OcrExperimentVariant,
  rankExperimentSummaries,
  selectExperimentFiles,
} from './ocr-experiments.ts';
import {
  greyConfig,
  MODEL_CAPABILITIES,
  profileForModel,
  routeOcr,
  withMeasuredAccuracy,
} from './ocr-models.ts';
import { rateOf, requiredSamples, wilsonInterval } from './stats.ts';
import type { Store } from './store.ts';

type TruthTable = {
  rows: string[][];
  cells: {
    row: number;
    column: number;
    text: string;
    rowSpan: number;
    columnSpan: number;
    bbox: DocumentBBox | null;
  }[];
};

/** Where a truth field is expected to live, used for the localized field metric. */
type FieldHint = {
  /** 1-based page number. */
  page?: number;
  /** Key/label text that must appear next to the value. */
  label?: string;
  /** Expected region in the coordinate space of the rendered page. */
  bbox?: DocumentBBox;
};

type TruthEntry = {
  kind?: string;
  lang?: string;
  difficulty?: OcrBenchDifficulty;
  degradations?: string[];
  provenance?: OcrBenchProvenance;
  /** Template family for split assignment; derived from the name when absent. */
  template?: string;
  /** Explicit corpus role; overrides the deterministic hash assignment. */
  split?: string;
  /** Field names whose truth is disputed and must not influence metrics. */
  uncertain?: string[];
  text?: string;
  keywords?: string[];
  fields?: Record<string, string>;
  /** Optional localization per field; absent hints fall back to the page of the only match. */
  fieldHints?: Record<string, FieldHint>;
  tables?: TruthTable[];
  conditions?: { mode?: OcrMode; dpi?: number };
};
type Truth = Record<string, TruthEntry>;

const DIFFICULTIES = new Set<OcrBenchDifficulty>(['clean', 'mild', 'moderate', 'severe']);
const ERROR_ALIGNMENT_LIMIT = 2_000;
const CALIBRATION_BINS = 10;
const SPLIT_NAMES: readonly OcrBenchSplit[] = ['dev', 'calibration', 'blind'];
/** Variant suffixes that must not move a document into another corpus role. */
const TEMPLATE_SUFFIX = /(?:[_\-\s]+(?:clean|skew|blur|warp|copy|dark|light|v\d+|\d+))+$/;

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01935cd9) >>> 0;
  }
  return hash >>> 0;
}

/** Template family key: explicit annotation, else the name stem without variant suffixes. */
export function templateKeyOf(name: string, entry: TruthEntry | undefined): string {
  const explicit = entry?.template?.trim().toLowerCase();
  if (explicit) return explicit;
  const stem = name
    .replace(/\.[^./\\]+$/, '')
    .toLowerCase()
    .replace(/[_\-\s]+/g, '_')
    .replace(TEMPLATE_SUFFIX, '');
  return `${(entry?.kind ?? '').trim().toLowerCase()}:${stem || name.toLowerCase()}`;
}

/**
 * Corpus role for a template family. Hashing the family key rather than the file
 * name keeps every variant of one template in the same split, and keeps the
 * assignment stable when unrelated files are added to the corpus.
 */
export function splitOf(
  name: string,
  entry: TruthEntry | undefined,
  template = templateKeyOf(name, entry),
): OcrBenchSplit {
  if (isOcrBenchSplit(entry?.split)) return entry.split;
  const salt = process.env.OCR_BENCH_SPLIT_SALT?.trim() || 'v1';
  const devShare = Math.min(Math.max(numberEnv('OCR_BENCH_DEV_SHARE', 0.6), 0), 1);
  const calibrationShare = Math.min(
    Math.max(numberEnv('OCR_BENCH_CALIBRATION_SHARE', 0.2), 0),
    Math.max(0, 1 - devShare),
  );
  const bucket = (fnv1a(`${salt}|${template}`) % 10_000) / 10_000;
  if (bucket < devShare) return 'dev';
  if (bucket < devShare + calibrationShare) return 'calibration';
  return 'blind';
}

export function normalizeBenchText(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}%]+/gu, '');
}

export function levenshtein(left: string, right: string): number {
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

export function benchmarkCer(expected: string, actual: string): number {
  const truth = normalizeBenchText(expected);
  if (!truth) return 0;
  return levenshtein(truth, normalizeBenchText(actual)) / truth.length;
}

/**
 * Character error rate that keeps case, punctuation and word boundaries but
 * ignores whitespace between CJK characters, so paragraph line wrapping is not
 * counted as an OCR error while missing CJK/Latin separators still are.
 */
export function benchmarkRawCer(expected: string, actual: string): number {
  const truth = rawBenchText(expected);
  if (!truth) return 0;
  return levenshtein(truth, rawBenchText(actual)) / truth.length;
}

const CJK_CLASS = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u3040-\\u30ff\\uac00-\\ud7af';
const CJK_PUNCTUATION = '。！？；：、，（）《》“”‘’';
const CJK_GAP = new RegExp(
  `(?<=[${CJK_CLASS}${CJK_PUNCTUATION}]) (?=[${CJK_CLASS}${CJK_PUNCTUATION}])`,
  'g',
);

function rawBenchText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').replace(CJK_GAP, '').trim();
}

export function keywordRecall(
  keywords: readonly string[],
  actual: string,
): { hit: number; total: number } {
  const haystack = normalizeBenchText(actual);
  let hit = 0;
  for (const keyword of keywords) {
    const needle = normalizeBenchText(keyword);
    if (needle && haystack.includes(needle)) hit += 1;
  }
  return { hit, total: keywords.length };
}

const FULLWIDTH_DIGITS = /[０-９]/g;
const FULLWIDTH_NUMERIC = /[．，％]/g;
const FULLWIDTH_MAP: Record<string, string> = { '．': '.', '，': ',', '％': '%' };
const THOUSANDS_GROUP = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;

/** Digits and decimal points only, with thousands separators removed. */
function numericBenchText(value: string): string {
  const normalized = value
    .replace(FULLWIDTH_DIGITS, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    .replace(FULLWIDTH_NUMERIC, (mark) => FULLWIDTH_MAP[mark] ?? mark);
  const tokens = normalized.match(/\d+(?:[.,]\d+)*/g) ?? [];
  // Keep commas that separate list items; only drop thousands separators.
  return tokens
    .map((token) => (THOUSANDS_GROUP.test(token) ? token.replace(/,/g, '') : token))
    .join('|');
}

/** Character error rate over numeric tokens only; punctuation/units ignored. */
export function benchmarkNumericCer(expected: string, actual: string): number | null {
  const truth = numericBenchText(expected);
  if (!truth) return null;
  return levenshtein(truth, numericBenchText(actual)) / truth.length;
}

const CRITICAL_NUMBER_TOKEN =
  /[¥￥$€£]?\s*[（(]?\s*[-−－]?\s*[\d０-９](?:[\d０-９,，．.\s]*[\d０-９])?\s*[-−－]?\s*[)）]?\s*[%％]?/gu;
const CRITICAL_SYMBOL = /[.,¥￥$€£%()\-−－]/u;

/**
 * Amount-critical symbol skeleton: decimal point, thousands separator, sign,
 * parentheses, currency and percent. Digits are dropped so a pure digit error
 * stays in `numericCer`, while a lost minus or decimal point is visible here.
 */
function criticalSymbolText(value: string): string {
  const tokens = value.match(CRITICAL_NUMBER_TOKEN) ?? [];
  return tokens
    .map((token) =>
      token
        .replace(FULLWIDTH_DIGITS, '')
        .replace(/[．，％]/g, (mark) => FULLWIDTH_MAP[mark] ?? mark)
        .replace(/[－−]/gu, '-')
        .replace(/[（）]/gu, (mark) => (mark === '（' ? '(' : ')'))
        .replace(/[\d\s]/gu, ''),
    )
    .filter((skeleton) => CRITICAL_SYMBOL.test(skeleton))
    .join('|');
}

/** Error rate over critical numeric symbols; null when truth carries none. */
export function benchmarkSymbolCer(expected: string, actual: string): number | null {
  const truth = criticalSymbolText(expected);
  if (!truth) return null;
  return levenshtein(truth, criticalSymbolText(actual)) / truth.length;
}

export function fieldAccuracy(
  fields: Record<string, string> | undefined,
  actual: string,
): { hit: number; total: number; rate: number } | null {
  if (!fields) return null;
  const entries = Object.entries(fields).filter(([, value]) => value.trim() !== '');
  if (entries.length === 0) return null;
  const haystack = normalizeBenchText(actual);
  let hit = 0;
  for (const [, value] of entries) {
    const needle = normalizeBenchText(value);
    if (needle && haystack.includes(needle)) hit += 1;
  }
  return { hit, total: entries.length, rate: hit / entries.length };
}

const FIELD_CATEGORY_PATTERNS: {
  category: OcrBenchFieldCategory;
  pattern: RegExp;
}[] = [
  {
    category: 'amount',
    pattern: /金额|合计|总计|小计|总额|单价|应付|实付|余额|amount|total|price|balance|tax/i,
  },
  { category: 'date', pattern: /日期|时间|\bdate\b/i },
  { category: 'account', pattern: /账号|账户|卡号|\baccount\b/i },
  {
    category: 'identifier',
    pattern: /编号|单号|发票|订单|合同|税号|证件|\b(?:id|no\.?|invoice|order|serial|ref)\b/i,
  },
  { category: 'quantity', pattern: /数量|件数|人数|\b(?:qty|quantity|count)\b/i },
  { category: 'percentage', pattern: /税率|比例|百分比|\b(?:rate|percent)\b/i },
  { category: 'currency', pattern: /币种|货币|币别|\bcurrency\b/i },
];

export function fieldCategoryOf(field: string): OcrBenchFieldCategory {
  for (const { category, pattern } of FIELD_CATEGORY_PATTERNS) {
    if (pattern.test(field)) return category;
  }
  return 'other';
}

/**
 * Per-field outcome used for category reliability and confidence calibration.
 * `localized` records which rule produced `correct`: the strong, block-pinned one
 * when the run can locate the value, containment otherwise. Category gates read
 * this so a bucket computed from weak evidence cannot be sold as a strong one.
 */
export function fieldOutcomes(
  fields: Record<string, string> | undefined,
  actual: string,
  document: DocumentIr | null = null,
  truthText?: string,
  hints?: Record<string, FieldHint>,
): OcrBenchFieldOutcome[] {
  return fieldVerdicts(fields, actual, truthText, document, hints).map((verdict) => ({
    field: verdict.field,
    category: fieldCategoryOf(verdict.field),
    correct: verdict.localized === null ? verdict.weak : verdict.localized,
    localized: verdict.localized !== null,
  }));
}

function truthFields(entry: TruthEntry | undefined): {
  fields: Record<string, string>;
  total: number;
} {
  const uncertain = new Set(entry?.uncertain ?? []);
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(entry?.fields ?? {})) {
    if (uncertain.has(key) || value.trim() === '') continue;
    fields[key] = value;
  }
  return { fields, total: Object.keys(fields).length };
}

function provenanceOf(entry: TruthEntry | undefined): OcrBenchProvenance | null {
  const raw = entry?.provenance;
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const provenance: OcrBenchProvenance = {};
  for (const key of ['annotator', 'reviewer', 'annotatedAt', 'sha256', 'source'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) provenance[key] = value.trim();
  }
  return Object.keys(provenance).length > 0 ? provenance : null;
}

function uncertainOf(entry: TruthEntry | undefined): string[] {
  return (entry?.uncertain ?? [])
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .map((value) => value.trim())
    .slice(0, 50);
}

function truthTablesOf(entry: TruthEntry | undefined): TruthTable[] {
  const raw = entry?.tables;
  if (!Array.isArray(raw)) return [];
  const tables: TruthTable[] = [];
  for (const item of raw.slice(0, 20)) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const rows: string[][] = [];
    if (Array.isArray(record.rows)) {
      for (const row of record.rows.slice(0, 1_000)) {
        if (!Array.isArray(row)) continue;
        rows.push(
          row.slice(0, 200).map((cell) => (typeof cell === 'string' ? cell : String(cell ?? ''))),
        );
      }
    }
    const cells: TruthTable['cells'] = [];
    if (Array.isArray(record.cells)) {
      for (const cell of record.cells.slice(0, 5_000)) {
        if (!cell || typeof cell !== 'object') continue;
        const value = cell as Record<string, unknown>;
        const row = Number(value.row);
        const column = Number(value.column);
        if (!Number.isInteger(row) || !Number.isInteger(column) || row < 0 || column < 0) continue;
        const bbox = value.bbox as DocumentBBox | undefined;
        cells.push({
          row,
          column,
          text: typeof value.text === 'string' ? value.text : '',
          rowSpan: positiveSpan(value.rowSpan),
          columnSpan: positiveSpan(value.columnSpan),
          bbox:
            bbox &&
            [bbox.x, bbox.y, bbox.width, bbox.height].every(
              (number) => typeof number === 'number' && Number.isFinite(number),
            )
              ? { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height }
              : null,
        });
      }
    }
    if (rows.length > 0 || cells.length > 0) tables.push({ rows, cells });
  }
  return tables;
}

function positiveSpan(value: unknown): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 1;
}

const FIELD_CONTEXT_WIDTH = 12;
const FIELD_CONTEXT_LIMIT = 8;
const FIELD_CONTEXT_MIN_OVERLAP = 2;
/** Below this a value or a label matches almost any block, so it proves nothing. */
const STRONG_MATCH_MIN_LENGTH = 2;

/** Text around one occurrence of a value in the truth, used to localize it. */
type FieldContext = { before: string; after: string };

function truthContexts(haystack: string, needle: string): FieldContext[] {
  const contexts: FieldContext[] = [];
  if (!haystack || !needle) return contexts;
  let from = 0;
  while (contexts.length < FIELD_CONTEXT_LIMIT) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) break;
    from = index + needle.length;
    contexts.push({
      before: haystack.slice(Math.max(0, index - FIELD_CONTEXT_WIDTH), index),
      after: haystack.slice(index + needle.length, index + needle.length + FIELD_CONTEXT_WIDTH),
    });
  }
  return contexts;
}

function sharedSuffixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length, FIELD_CONTEXT_WIDTH);
  let count = 0;
  while (count < limit && left[left.length - 1 - count] === right[right.length - 1 - count]) {
    count += 1;
  }
  return count;
}

function sharedPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length, FIELD_CONTEXT_WIDTH);
  let count = 0;
  while (count < limit && left[count] === right[count]) count += 1;
  return count;
}

/**
 * Whether one occurrence of the value sits in the context the truth declares.
 * Only a suffix of the label (or a prefix of what follows) has to agree, since
 * a block usually starts at the label rather than reproducing the page text.
 */
function contextMatches(text: string, needle: string, contexts: FieldContext[]): boolean {
  if (contexts.length === 0) return false;
  const annotated = contexts.some((context) => context.before !== '' || context.after !== '');
  if (!annotated) return true;
  let from = 0;
  for (;;) {
    const index = text.indexOf(needle, from);
    if (index < 0) return false;
    from = index + needle.length;
    const before = text.slice(Math.max(0, index - FIELD_CONTEXT_WIDTH), index);
    const after = text.slice(index + needle.length, index + needle.length + FIELD_CONTEXT_WIDTH);
    const matched = contexts.some(
      (context) =>
        sharedSuffixLength(context.before, before) >= FIELD_CONTEXT_MIN_OVERLAP ||
        sharedPrefixLength(context.after, after) >= FIELD_CONTEXT_MIN_OVERLAP,
    );
    if (matched) return true;
  }
}

function bboxIntersects(left: DocumentBBox | null, right: DocumentBBox): boolean {
  if (!left) return false;
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);
  return x2 > x && y2 > y;
}

/**
 * Per-field verdict under both definitions. `localized` is the strong answer, or
 * null when nothing in the run can locate the value: no document IR, no truth text
 * around the value, no annotated page/region, and no label long enough to mean
 * anything. A null verdict is not a miss — counting one would blame the engine for
 * an annotation the corpus never provided — and it is not a hit either, which is
 * exactly the hole this closes.
 */
type FieldVerdict = { field: string; weak: boolean; localized: boolean | null };

function fieldVerdicts(
  fields: Record<string, string> | undefined,
  actual: string,
  truthText: string | undefined,
  document: DocumentIr | null,
  hints?: Record<string, FieldHint>,
): FieldVerdict[] {
  if (!fields) return [];
  const haystack = normalizeBenchText(actual);
  const truthHaystack = normalizeBenchText(truthText ?? '');
  const scopes = document
    ? document.pages.flatMap((page) =>
        page.blocks
          .map((block) => ({
            page: page.number,
            text: normalizeBenchText(block.text),
            bbox: block.bbox ?? null,
          }))
          .filter((scope) => scope.text !== ''),
      )
    : null;
  const verdicts: FieldVerdict[] = [];
  for (const [field, value] of Object.entries(fields)) {
    if (value.trim() === '') continue;
    const needle = normalizeBenchText(value);
    const weak = needle !== '' && haystack.includes(needle);
    if (!scopes || needle === '') {
      verdicts.push({ field, weak, localized: null });
      continue;
    }
    const hint = hints?.[field];
    const pageHint = hint?.page !== undefined;
    const bboxHint = hint?.bbox !== undefined;
    const label = hint?.label ? normalizeBenchText(hint.label) : '';
    const contexts = truthHaystack ? truthContexts(truthHaystack, needle) : [];
    const labelled =
      label.length >= STRONG_MATCH_MIN_LENGTH && needle.length >= STRONG_MATCH_MIN_LENGTH;
    if (!pageHint && !bboxHint && contexts.length === 0 && !labelled) {
      verdicts.push({ field, weak, localized: null });
      continue;
    }
    const localized = scopes.some((scope) => {
      if (!scope.text.includes(needle)) return false;
      if (pageHint && scope.page !== hint?.page) return false;
      if (bboxHint && (!scope.bbox || !hint?.bbox || !bboxIntersects(scope.bbox, hint.bbox))) {
        return false;
      }
      // An annotated page or region is the corpus's own proof of where the value is.
      if (pageHint || bboxHint) return true;
      if (contexts.length > 0 && contextMatches(scope.text, needle, contexts)) return true;
      return labelled && scope.text.includes(label);
    });
    verdicts.push({ field, weak, localized });
  }
  return verdicts;
}

/**
 * Localized field accuracy. `fieldAccuracy` credits a value found anywhere in the
 * document, so a wrong role or a duplicate subtotal still scores. Here the value
 * must sit in a block the annotation pins down: an annotated page or region, the
 * truth's surrounding text, or a label in the same block. With no document IR, or a
 * corpus that pins nothing down, the metric is not measured (null) rather than
 * degrading to containment — the release gate must not be fed weak evidence
 * wearing a strong name.
 */
export function fieldStrongAccuracy(
  fields: Record<string, string> | undefined,
  actual: string,
  truthText: string | undefined,
  document: DocumentIr | null,
  hints?: Record<string, FieldHint>,
): { hit: number; total: number; rate: number; unverifiable: number } | null {
  const verdicts = fieldVerdicts(fields, actual, truthText, document, hints);
  if (verdicts.length === 0) return null;
  const measured = verdicts.filter((verdict) => verdict.localized !== null);
  if (measured.length === 0) return null;
  const hit = measured.filter((verdict) => verdict.localized === true).length;
  return {
    hit,
    total: measured.length,
    rate: hit / measured.length,
    unverifiable: verdicts.length - measured.length,
  };
}

/** Exact field match after collapsing whitespace only; formatting still matters. */
export function fieldExactAccuracy(
  fields: Record<string, string> | undefined,
  actual: string,
): { hit: number; total: number; rate: number } | null {
  if (!fields) return null;
  const entries = Object.entries(fields).filter(([, value]) => value.trim() !== '');
  if (entries.length === 0) return null;
  const haystack = actual.replace(/\s+/g, ' ');
  let hit = 0;
  for (const [, value] of entries) {
    const needle = value.replace(/\s+/g, ' ').trim();
    if (needle && haystack.includes(needle)) hit += 1;
  }
  return { hit, total: entries.length, rate: hit / entries.length };
}

const BUSINESS_FIELD_WEIGHTS: { pattern: RegExp; weight: number; numeric: boolean }[] = [
  {
    pattern:
      /金额|合计|总计|小计|总额|总价|单价|应付|实付|余额|税额|\b(?:amount|total|sum|price|balance|tax)\b/i,
    weight: 8,
    numeric: true,
  },
  { pattern: /账号|账户|卡号|\b(?:account|acct|iban)\b/i, weight: 8, numeric: false },
  { pattern: /日期|\bdate\b/i, weight: 4, numeric: true },
  { pattern: /币种|货币|\bcurrency\b/i, weight: 3, numeric: false },
  {
    pattern: /编号|单号|订单号|发票号|税号|证件号|合同号|\b(?:invoice|order|serial|ref|no)\b/i,
    weight: 3,
    numeric: false,
  },
  { pattern: /数量|件数|人数|工时|天数|\b(?:qty|quantity|count)\b/i, weight: 2, numeric: true },
];

function fieldLossSpec(name: string): { weight: number; numeric: boolean } {
  for (const spec of BUSINESS_FIELD_WEIGHTS) {
    if (spec.pattern.test(name)) return { weight: spec.weight, numeric: spec.numeric };
  }
  return { weight: 1, numeric: false };
}

function numericTokens(value: string): string[] {
  return (value.match(/\d[\d,.]*/g) ?? []).map((token) => token.replace(/,/g, ''));
}

/**
 * Compare the whole numeric field, including multi-token dates, rather than
 * accepting a single matching year/token as a zero-loss match.
 */
function numericLoss(expected: string, observed: readonly string[]): number {
  const truth = expected.replace(/\D+/g, '');
  if (!truth) return 1;
  let best = 1;
  for (let start = 0; start < observed.length; start += 1) {
    let joined = '';
    for (let end = start; end < observed.length && end < start + 6; end += 1) {
      joined += observed[end]?.replace(/\D+/g, '') ?? '';
      if (!joined) continue;
      if (joined.length > truth.length + 2) break;
      const distance = levenshtein(truth, joined) / Math.max(truth.length, joined.length);
      if (distance < best) best = distance;
      if (best === 0) return 0;
    }
  }
  return best;
}

/**
 * Weighted business loss: a missing amount/account/date costs more than a
 * typo in descriptive text. Numeric fields use the closest digit string so a
 * single wrong digit scores below a completely different value.
 */
export function benchmarkBusinessLoss(
  fields: Record<string, string> | undefined,
  actual: string,
): OcrBenchBusinessLoss | null {
  const entries = Object.entries(fields ?? {}).filter(([, value]) => value.trim() !== '');
  if (entries.length === 0) return null;
  let loss = 0;
  let weight = 0;
  const haystack = normalizeBenchText(actual);
  const actualNumbers = numericTokens(actual);
  for (const [name, expected] of entries) {
    const spec = fieldLossSpec(name);
    weight += spec.weight;
    const needle = normalizeBenchText(expected);
    if (needle && haystack.includes(needle)) continue;
    if (spec.numeric) {
      loss += spec.weight * Math.min(1, numericLoss(expected, actualNumbers));
    } else {
      loss += spec.weight;
    }
  }
  return weight > 0 ? { loss, weight, rate: loss / weight } : null;
}

function rowSignatures(rows: readonly (readonly string[])[]): string[] {
  return rows
    .map((row) => row.map((cell) => normalizeBenchText(cell)).join('|'))
    .filter((signature) => signature.replace(/\|/g, '') !== '');
}

function columnSignatures(rows: readonly (readonly string[])[]): string[] {
  const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const signatures: string[] = [];
  for (let column = 0; column < columns; column += 1) {
    const signature = rows
      .map((row) => normalizeBenchText(row[column] ?? ''))
      .filter(Boolean)
      .join('|');
    if (signature) signatures.push(signature);
  }
  return signatures;
}

function multisetF1(expected: readonly string[], actual: readonly string[]): number | null {
  if (expected.length === 0) return null;
  const counts = new Map<string, number>();
  for (const value of expected) counts.set(value, (counts.get(value) ?? 0) + 1);
  let matched = 0;
  for (const value of actual) {
    const count = counts.get(value) ?? 0;
    if (count <= 0) continue;
    matched += 1;
    counts.set(value, count - 1);
  }
  if (actual.length === 0) return 0;
  const precision = matched / actual.length;
  const recall = matched / expected.length;
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

type GridCell = {
  text: string;
  rowSpan: number;
  columnSpan: number;
  bbox: DocumentBBox | null;
};

function cellGrid(table: TruthTable): Map<string, GridCell> {
  const grid = new Map<string, GridCell>();
  table.rows.forEach((row, rowIndex) => {
    row.forEach((text, columnIndex) => {
      grid.set(`${rowIndex}:${columnIndex}`, {
        text,
        rowSpan: 1,
        columnSpan: 1,
        bbox: null,
      });
    });
  });
  for (const cell of table.cells) {
    grid.set(`${cell.row}:${cell.column}`, {
      text: cell.text || grid.get(`${cell.row}:${cell.column}`)?.text || '',
      rowSpan: cell.rowSpan,
      columnSpan: cell.columnSpan,
      bbox: cell.bbox,
    });
  }
  return grid;
}

function blockTable(block: DocumentBlock | undefined): TruthTable | null {
  if (block?.type !== 'table') return null;
  const cells = (block.cells ?? []).map((cell) => ({
    row: cell.row,
    column: cell.column,
    text: cell.text,
    rowSpan: cell.rowSpan ?? 1,
    columnSpan: cell.columnSpan ?? 1,
    bbox: cell.bbox ?? null,
  }));
  if ((block.rows?.length ?? 0) === 0 && cells.length === 0) return null;
  return { rows: block.rows ?? [], cells };
}

function structureSignature(table: TruthTable): string {
  const grid = cellGrid(table);
  const rows = new Map<number, { column: number; token: string }[]>();
  for (const [key, cell] of grid) {
    const [row, column] = key.split(':').map(Number) as [number, number];
    const span =
      cell.rowSpan > 1 || cell.columnSpan > 1 ? `${cell.rowSpan}x${cell.columnSpan}` : '';
    const tokens = rows.get(row) ?? [];
    tokens.push({ column, token: `${span}[${normalizeBenchText(cell.text)}]` });
    rows.set(row, tokens);
  }
  return [...rows.entries()]
    .sort(([left], [right]) => left - right)
    .map(
      ([row, tokens]) =>
        `r${row}(${tokens
          .sort((left, right) => left.column - right.column)
          .map((item) => item.token)
          .join(',')})`,
    )
    .join('');
}

function bboxOverlap(left: DocumentBBox, right: DocumentBBox): number {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);
  if (x2 <= x1 || y2 <= y1) return 0;
  const intersection = (x2 - x1) * (y2 - y1);
  const union = left.width * left.height + right.width * right.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function tableMetricsFor(
  expected: TruthTable,
  actual: DocumentBlock | undefined,
): OcrBenchTableMetrics {
  const observed = blockTable(actual);
  const expectedGrid = cellGrid(expected);
  const observedGrid = observed ? cellGrid(observed) : new Map<string, GridCell>();
  const expectedRows = expected.rows.length > 0 ? rowSignatures(expected.rows) : [];
  const observedRows = observed?.rows.length ? rowSignatures(observed.rows) : [];
  const expectedColumns = expected.rows.length > 0 ? columnSignatures(expected.rows) : [];
  const observedColumns = observed?.rows.length ? columnSignatures(observed.rows) : [];

  const expectedCells = [...expectedGrid.values()].filter((cell) => cell.text.trim() !== '');
  let cellHits = 0;
  let iouSum = 0;
  let iouCount = 0;
  let mergedTotal = 0;
  let mergedHit = 0;
  for (const [key, cell] of expectedGrid) {
    const match = observedGrid.get(key);
    if (cell.text.trim()) {
      if (match && normalizeBenchText(match.text) === normalizeBenchText(cell.text)) cellHits += 1;
    }
    if (cell.bbox && match?.bbox) {
      iouSum += bboxOverlap(cell.bbox, match.bbox);
      iouCount += 1;
    }
    if (cell.rowSpan > 1 || cell.columnSpan > 1) {
      mergedTotal += 1;
      if (match && match.rowSpan === cell.rowSpan && match.columnSpan === cell.columnSpan) {
        mergedHit += 1;
      }
    }
  }

  const expectedStructure = structureSignature(expected);
  const observedStructure = observed ? structureSignature(observed) : '';
  const teds =
    expectedStructure.length > 0
      ? 1 -
        levenshtein(expectedStructure, observedStructure) /
          Math.max(expectedStructure.length, observedStructure.length)
      : null;

  const metrics: OcrBenchTableMetrics = {
    tables: 1,
    rowsF1: multisetF1(expectedRows, observedRows),
    columnsF1: multisetF1(expectedColumns, observedColumns),
    cellAccuracy: expectedCells.length > 0 ? cellHits / expectedCells.length : null,
    cellIoU: iouCount > 0 ? iouSum / iouCount : null,
    mergedCellAccuracy: mergedTotal > 0 ? mergedHit / mergedTotal : null,
    teds: teds === null ? null : Math.max(0, teds),
  };
  return metrics;
}

export function benchmarkTableMetrics(
  expected: readonly TruthTable[],
  blocks: readonly DocumentBlock[],
  document: DocumentIr | null = null,
): OcrBenchTableMetrics | null {
  if (expected.length === 0) return null;
  const tables = document
    ? document.pages.flatMap((page) => page.blocks.filter((block) => block.type === 'table'))
    : blocks.filter((block) => block.type === 'table');
  const metrics = expected.map((table, index) => tableMetricsFor(table, tables[index]));
  const keys: (keyof OcrBenchTableMetrics)[] = [
    'rowsF1',
    'columnsF1',
    'cellAccuracy',
    'cellIoU',
    'mergedCellAccuracy',
    'teds',
  ];
  const result = { tables: expected.length } as OcrBenchTableMetrics;
  const mutable = result as unknown as Record<string, number | null>;
  for (const key of keys) {
    if (key === 'tables') continue;
    const values = metrics
      .map((metric) => metric[key])
      .filter((value): value is number => typeof value === 'number');
    mutable[key] = average(values);
  }
  return result;
}

// WER only makes sense for whitespace-tokenized scripts; CJK accuracy is
// measured by CER because there are no word boundaries.
function wordTokens(value: string): string[] {
  return value.toLowerCase().match(/[\p{Script=Latin}\p{N}%]+/gu) ?? [];
}

/** Word error rate for whitespace-tokenized languages (English, mixed text). */
export function benchmarkWer(expected: string, actual: string): number | null {
  const truth = wordTokens(expected);
  if (truth.length === 0) return null;
  const observed = wordTokens(actual);
  let previous = Array.from({ length: observed.length + 1 }, (_, index) => index);
  for (let i = 1; i <= truth.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= observed.length; j += 1) {
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (truth[i - 1] === observed[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return (previous[observed.length] ?? 0) / truth.length;
}

/** Levenshtein alignment split into substitution/insertion/deletion counts. */
export function classifyErrors(expected: string, actual: string): OcrErrorBreakdown {
  const truth = normalizeBenchText(expected).slice(0, ERROR_ALIGNMENT_LIMIT);
  const observed = normalizeBenchText(actual).slice(0, ERROR_ALIGNMENT_LIMIT);
  const width = observed.length + 1;
  const table = new Uint16Array((truth.length + 1) * width);
  for (let i = 0; i <= truth.length; i += 1) table[i * width] = i;
  for (let j = 0; j <= observed.length; j += 1) table[j] = j;
  for (let i = 1; i <= truth.length; i += 1) {
    for (let j = 1; j <= observed.length; j += 1) {
      const diagonal =
        (table[(i - 1) * width + (j - 1)] ?? 0) + (truth[i - 1] === observed[j - 1] ? 0 : 1);
      const up = (table[(i - 1) * width + j] ?? 0) + 1;
      const left = (table[i * width + (j - 1)] ?? 0) + 1;
      table[i * width + j] = Math.min(diagonal, up, left);
    }
  }
  let substitutions = 0;
  let insertions = 0;
  let deletions = 0;
  let i = truth.length;
  let j = observed.length;
  while (i > 0 || j > 0) {
    if (
      i > 0 &&
      j > 0 &&
      truth[i - 1] === observed[j - 1] &&
      table[i * width + j] === table[(i - 1) * width + (j - 1)]
    ) {
      i -= 1;
      j -= 1;
    } else if (
      i > 0 &&
      j > 0 &&
      table[i * width + j] === (table[(i - 1) * width + (j - 1)] ?? 0) + 1
    ) {
      substitutions += 1;
      i -= 1;
      j -= 1;
    } else if (i > 0 && table[i * width + j] === (table[(i - 1) * width + j] ?? 0) + 1) {
      deletions += 1;
      i -= 1;
    } else {
      insertions += 1;
      j -= 1;
    }
  }
  return {
    substitutions,
    insertions,
    deletions,
    missingFields: 0,
    types: errorTypes({ substitutions, insertions, deletions, missingFields: 0 }, []),
    top: [],
  };
}

function errorTypes(
  counts: Pick<OcrErrorBreakdown, 'substitutions' | 'insertions' | 'deletions' | 'missingFields'>,
  qualityIssues: readonly string[],
): string[] {
  const types: string[] = [];
  if (counts.substitutions > 0) types.push('character_substitution');
  if (counts.insertions > 0) types.push('character_insertion');
  if (counts.deletions > 0) types.push('character_deletion');
  if (counts.missingFields > 0) types.push('missing_field');
  if (qualityIssues.includes('empty_page')) types.push('page_omission');
  if (qualityIssues.includes('duplicate_content')) types.push('duplicate_text');
  if (qualityIssues.includes('reading_order')) types.push('reading_order');
  if (qualityIssues.includes('table_integrity')) types.push('table_structure');
  if (qualityIssues.includes('field_mismatch')) types.push('field_validation');
  if (qualityIssues.includes('cell_type_mismatch')) types.push('column_type_mismatch');
  if (qualityIssues.includes('key_field_low_confidence')) types.push('key_field_risk');
  if (
    qualityIssues.includes('image_blurry') ||
    qualityIssues.includes('image_exposure') ||
    qualityIssues.includes('image_low_resolution')
  ) {
    types.push('image_quality');
  }
  if (qualityIssues.includes('small_text')) types.push('small_text');
  return types;
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number | null, digits = 4): number | null {
  if (value === null) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export { requiredSamples, wilsonInterval } from './stats.ts';

function averageTableMetrics(items: readonly OcrBenchTableMetrics[]): OcrBenchTableMetrics | null {
  if (items.length === 0) return null;
  const result = {
    tables: items.reduce((sum, item) => sum + item.tables, 0),
  } as OcrBenchTableMetrics;
  const mutable = result as unknown as Record<string, number | null>;
  for (const key of [
    'rowsF1',
    'columnsF1',
    'cellAccuracy',
    'cellIoU',
    'mergedCellAccuracy',
    'teds',
  ] as const) {
    mutable[key] = average(
      items.map((item) => item[key]).filter((value): value is number => value !== null),
    );
  }
  return result;
}

export function calibrateConfidence(
  samples: readonly { confidence: number; correct: boolean }[],
): OcrBenchCalibration {
  if (samples.length === 0) {
    return { samples: 0, ece: null, brier: null, bins: [] };
  }
  const bins: OcrBenchCalibrationBin[] = [];
  let ece = 0;
  let brier = 0;
  const size = 1 / CALIBRATION_BINS;
  for (let index = 0; index < CALIBRATION_BINS; index += 1) {
    const lower = index * size;
    const upper = index === CALIBRATION_BINS - 1 ? 1.000001 : (index + 1) * size;
    const bucket = samples.filter(
      (sample) => sample.confidence >= lower && sample.confidence < upper,
    );
    const confidence = average(bucket.map((sample) => sample.confidence));
    const accuracy = average(bucket.map((sample) => (sample.correct ? 1 : 0)));
    bins.push({
      lower,
      upper: Math.min(1, upper),
      count: bucket.length,
      confidence: round(confidence),
      accuracy: round(accuracy),
    });
    if (bucket.length > 0 && confidence !== null && accuracy !== null) {
      ece += (bucket.length / samples.length) * Math.abs(accuracy - confidence);
    }
  }
  for (const sample of samples) {
    brier += (sample.confidence - (sample.correct ? 1 : 0)) ** 2;
  }
  return {
    samples: samples.length,
    ece: round(ece),
    brier: round(brier / samples.length),
    bins,
  };
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Binomial evidence behind a rate check, so a pass can be read either as
 * "clears the threshold" or as "the corpus was too small to say".
 */
function checkEvidence(
  observed: number | null,
  samples: number,
  threshold: number,
  comparison: 'min' | 'max',
): Pick<OcrBenchGateCheck, 'samples' | 'requiredSamples'> | Record<string, never> {
  if (observed === null || samples <= 0) return {};
  return { samples, requiredSamples: requiredSamples(observed, threshold, comparison) };
}

/** Non-binomial metrics use a fixed floor instead of a Wilson bound. */
function sampleFloor(
  samples: number,
  floor: number,
): Pick<OcrBenchGateCheck, 'samples' | 'requiredSamples'> | Record<string, never> {
  if (samples <= 0) return {};
  return { samples, requiredSamples: floor };
}

function evaluateGate(
  aggregate: Omit<OcrBenchAggregate, 'gate' | 'splits'>,
  context: { labeled: boolean; blindFiles: number; gateSplit: OcrBenchSplit | null },
): OcrBenchGate | null {
  if (aggregate.evaluated === 0) return null;
  const defaultMaxCer = numberEnv('OCR_GATE_MAX_CER', 0.05);
  const fieldStrongThreshold = numberEnv('OCR_GATE_MIN_FIELD_STRONG_ACCURACY', 0.9);
  const fullyCorrectThreshold = numberEnv('OCR_GATE_MIN_FULLY_CORRECT', 0.8);
  const maxFailedRate = numberEnv('OCR_GATE_MAX_FAILED_RATE', 0.1);
  const eceMinSamples = Math.max(1, Math.floor(numberEnv('OCR_GATE_ECE_MIN_SAMPLES', 20)));
  const minTables = Math.max(1, Math.floor(numberEnv('OCR_GATE_MIN_TABLE_STRUCTURE_SAMPLES', 5)));
  const checks: OcrBenchGateCheck[] = [
    {
      name: 'cer',
      value: aggregate.cer,
      threshold: defaultMaxCer,
      comparison: 'max',
      passed: aggregate.cer === null ? null : aggregate.cer <= defaultMaxCer,
    },
    {
      name: 'numeric_cer',
      value: aggregate.numericCer,
      threshold: numberEnv('OCR_GATE_MAX_NUMERIC_CER', 0.02),
      comparison: 'max',
      passed:
        aggregate.numericCer === null
          ? null
          : aggregate.numericCer <= numberEnv('OCR_GATE_MAX_NUMERIC_CER', 0.02),
    },
    {
      name: 'symbol_cer',
      value: aggregate.symbolCer,
      threshold: numberEnv('OCR_GATE_MAX_SYMBOL_CER', 0.01),
      comparison: 'max',
      passed:
        aggregate.symbolCer === null
          ? null
          : aggregate.symbolCer <= numberEnv('OCR_GATE_MAX_SYMBOL_CER', 0.01),
    },
    {
      name: 'field_accuracy_strong',
      value: aggregate.fieldStrong?.rate ?? null,
      threshold: fieldStrongThreshold,
      comparison: 'min',
      passed:
        aggregate.fieldStrong === null ? null : aggregate.fieldStrong.rate >= fieldStrongThreshold,
      ...checkEvidence(
        aggregate.fieldStrong?.rate ?? null,
        aggregate.fieldStrong?.total ?? 0,
        fieldStrongThreshold,
        'min',
      ),
    },
    {
      name: 'fully_correct',
      value: aggregate.fullyCorrect?.rate ?? null,
      threshold: fullyCorrectThreshold,
      comparison: 'min',
      passed:
        aggregate.fullyCorrect === null
          ? null
          : aggregate.fullyCorrect.rate >= fullyCorrectThreshold,
      ...checkEvidence(
        aggregate.fullyCorrect?.rate ?? null,
        aggregate.fullyCorrect?.total ?? 0,
        fullyCorrectThreshold,
        'min',
      ),
    },
    {
      name: 'failed_rate',
      value: aggregate.files > 0 ? aggregate.failed / aggregate.files : null,
      threshold: maxFailedRate,
      comparison: 'max',
      passed: aggregate.files === 0 ? null : aggregate.failed / aggregate.files <= maxFailedRate,
      ...checkEvidence(
        aggregate.files > 0 ? aggregate.failed / aggregate.files : null,
        aggregate.files,
        maxFailedRate,
        'max',
      ),
    },
    {
      name: 'business_loss',
      value: aggregate.businessLoss?.rate ?? null,
      threshold: numberEnv('OCR_GATE_MAX_BUSINESS_LOSS', 0.05),
      comparison: 'max',
      passed:
        aggregate.businessLoss === null
          ? null
          : aggregate.businessLoss.rate <= numberEnv('OCR_GATE_MAX_BUSINESS_LOSS', 0.05),
    },
    {
      name: 'table_structure',
      value: aggregate.tableStructure?.teds ?? null,
      threshold: numberEnv('OCR_GATE_MIN_TABLE_TEDS', 0.9),
      comparison: 'min',
      passed:
        aggregate.tableStructure?.teds === null || aggregate.tableStructure === null
          ? null
          : aggregate.tableStructure.teds >= numberEnv('OCR_GATE_MIN_TABLE_TEDS', 0.9),
      ...sampleFloor(aggregate.tableStructure?.tables ?? 0, minTables),
    },
    {
      name: 'calibration_ece',
      value: aggregate.calibration.ece,
      threshold: numberEnv('OCR_GATE_MAX_ECE', 0.15),
      comparison: 'max',
      passed:
        aggregate.calibration.ece === null || aggregate.calibration.samples < eceMinSamples
          ? null
          : aggregate.calibration.ece <= numberEnv('OCR_GATE_MAX_ECE', 0.15),
      ...sampleFloor(aggregate.calibration.samples, eceMinSamples),
    },
  ];
  // Point estimates on small corpora pass by luck. Gate on the Wilson lower
  // bound of the localized metric, so a value found in the wrong role cannot
  // lift the result.
  const fieldLowerThreshold = numberEnv('OCR_GATE_MIN_FIELD_ACCURACY_LOWER', 0.9);
  checks.push({
    name: 'field_accuracy_lower',
    value: aggregate.fieldStrong?.interval[0] ?? null,
    threshold: fieldLowerThreshold,
    comparison: 'min',
    passed:
      aggregate.fieldStrong === null
        ? null
        : aggregate.fieldStrong.interval[0] >= fieldLowerThreshold,
    ...checkEvidence(
      aggregate.fieldStrong?.rate ?? null,
      aggregate.fieldStrong?.total ?? 0,
      fieldLowerThreshold,
      'min',
    ),
  });
  const fullyLowerThreshold = numberEnv('OCR_GATE_MIN_FULLY_CORRECT_LOWER', 0.7);
  checks.push({
    name: 'fully_correct_lower',
    value: aggregate.fullyCorrect?.interval[0] ?? null,
    threshold: fullyLowerThreshold,
    comparison: 'min',
    passed:
      aggregate.fullyCorrect === null
        ? null
        : aggregate.fullyCorrect.interval[0] >= fullyLowerThreshold,
    ...checkEvidence(
      aggregate.fullyCorrect?.rate ?? null,
      aggregate.fullyCorrect?.total ?? 0,
      fullyLowerThreshold,
      'min',
    ),
  });
  const categoryMinSamples = Math.max(
    1,
    Math.floor(numberEnv('OCR_GATE_MIN_CATEGORY_SAMPLES', 30)),
  );
  const categoryGates: { category: OcrBenchFieldCategory; env: string; fallback: number }[] = [
    { category: 'amount', env: 'OCR_GATE_MIN_AMOUNT_ACCURACY', fallback: 0.99 },
    { category: 'account', env: 'OCR_GATE_MIN_ACCOUNT_ACCURACY', fallback: 0.99 },
    { category: 'date', env: 'OCR_GATE_MIN_DATE_ACCURACY', fallback: 0.95 },
    { category: 'identifier', env: 'OCR_GATE_MIN_IDENTIFIER_ACCURACY', fallback: 0.95 },
  ];
  for (const gate of categoryGates) {
    const reliability = aggregate.fieldReliability.find(
      (entry) => entry.category === gate.category,
    );
    if (!reliability || reliability.interval === null) continue;
    const threshold = numberEnv(gate.env, gate.fallback);
    const lower = reliability.interval[0];
    checks.push({
      name: `field_accuracy_lower:${gate.category}`,
      value: lower,
      threshold,
      comparison: 'min',
      // Too few samples cannot certify a category: report a failing check
      // instead of letting a lucky small batch through.
      passed: reliability.samples >= categoryMinSamples && lower >= threshold,
      ...checkEvidence(reliability.accuracy, reliability.samples, threshold, 'min'),
      ...(reliability.basis === 'strong'
        ? {}
        : {
            note:
              reliability.basis === 'mixed'
                ? '此项混合了定位口径与全文包含口径，未定位的字段按弱口径计入'
                : '该类别没有可定位的字段证据，此项按全文包含（弱口径）判定',
          }),
    });
  }
  for (const group of aggregate.calibrationGroups) {
    if (group.dimension !== 'kind') continue;
    const envKey = `OCR_GATE_MAX_ECE_${group.value.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
    const threshold = numberEnv(envKey, numberEnv('OCR_GATE_MAX_ECE', 0.15));
    checks.push({
      name: `ece:${group.value}`,
      value: group.calibration.ece,
      threshold,
      comparison: 'max',
      passed:
        group.calibration.ece === null || group.calibration.samples < eceMinSamples
          ? null
          : group.calibration.ece <= threshold,
      ...sampleFloor(group.calibration.samples, eceMinSamples),
    });
  }
  for (const group of aggregate.groups) {
    if (group.dimension !== 'kind') continue;
    const envKey = `OCR_GATE_MAX_CER_${group.value.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
    const threshold = numberEnv(envKey, defaultMaxCer);
    checks.push({
      name: `cer:${group.value}`,
      value: group.cer,
      threshold,
      comparison: 'max',
      passed: group.cer === null ? null : group.cer <= threshold,
      // CER is per character, but the sample unit a run can plan around is the
      // document, so required evidence is expressed in files.
      ...checkEvidence(group.cer === null ? null : 1 - group.cer, group.files, threshold, 'max'),
    });
  }
  // A good overall average can hide one failing document type. Only groups with
  // enough files participate so a single-file bucket cannot flip the release gate.
  // The native-first PDF path is the core of the product, so a gate run that
  // silently excludes PDFs cannot certify a release. Opt out only for corpora
  // that genuinely contain no PDF samples.
  if (numberEnv('OCR_GATE_REQUIRE_PDF', 1) > 0) {
    const pdfGroup = aggregate.groups.find(
      (group) => group.dimension === 'kind' && group.value === 'pdf',
    );
    const minPdf = Math.max(1, Math.floor(numberEnv('OCR_GATE_MIN_PDF_FILES', 1)));
    checks.push({
      name: 'pdf_evidence',
      value: pdfGroup?.files ?? 0,
      threshold: minPdf,
      comparison: 'min',
      passed: (pdfGroup?.files ?? 0) >= minPdf,
      ...sampleFloor(pdfGroup?.files ?? 0, minPdf),
    });
  }
  const worstMinFiles = Math.max(1, Math.floor(numberEnv('OCR_GATE_WORST_GROUP_MIN_FILES', 3)));
  const worstMinFields = Math.max(1, Math.floor(numberEnv('OCR_GATE_WORST_GROUP_MIN_FIELDS', 3)));
  let worstCerGroup: OcrBenchGroup | null = null;
  let worstFieldGroup: OcrBenchGroup | null = null;
  // The gate ranks groups on the localized metric; a corpus that cannot localize
  // anywhere falls back to containment, and says so on the check.
  const groupFieldRate = (group: OcrBenchGroup): { rate: number | null; total: number } =>
    group.fieldStrong !== null && group.fieldStrongTotal >= worstMinFields
      ? { rate: group.fieldStrong, total: group.fieldStrongTotal }
      : { rate: group.fieldAccuracy, total: group.fieldTotal };
  let worstFieldBasis: 'strong' | 'weak' = 'strong';
  for (const group of aggregate.groups) {
    if (group.files < worstMinFiles) continue;
    if (
      group.cer !== null &&
      (worstCerGroup === null || worstCerGroup.cer === null || group.cer > worstCerGroup.cer)
    ) {
      worstCerGroup = group;
    }
    const candidate = groupFieldRate(group);
    if (candidate.rate === null || candidate.total < worstMinFields) continue;
    if (worstFieldGroup === null) {
      worstFieldGroup = group;
      worstFieldBasis = candidate.rate === group.fieldStrong ? 'strong' : 'weak';
      continue;
    }
    const current = groupFieldRate(worstFieldGroup);
    if (current.rate === null || candidate.rate < current.rate) {
      worstFieldGroup = group;
      worstFieldBasis = candidate.rate === group.fieldStrong ? 'strong' : 'weak';
    }
  }
  // Tuning on the same data as the gate inflates reliability. Blind-split
  // evidence is mandatory once the corpus carries split labels.
  const minBlind = Math.max(1, Math.floor(numberEnv('OCR_GATE_MIN_BLIND_FILES', 3)));
  checks.push({
    name: 'blind_evidence',
    value: context.blindFiles,
    threshold: minBlind,
    comparison: 'min',
    passed: context.labeled ? context.blindFiles >= minBlind : null,
    ...sampleFloor(context.blindFiles, minBlind),
    ...(context.labeled && context.gateSplit === null
      ? { note: '语料没有盲测样本，门禁退位在全部样本上判定' }
      : {}),
  });
  const worstCer = worstCerGroup?.cer ?? null;
  const worstCerThreshold = numberEnv('OCR_GATE_MAX_WORST_GROUP_CER', 0.15);
  checks.push({
    name: 'worst_group_cer',
    value: worstCer,
    threshold: worstCerThreshold,
    comparison: 'max',
    passed: worstCer === null ? null : worstCer <= worstCerThreshold,
    ...checkEvidence(
      worstCer === null ? null : 1 - worstCer,
      worstCerGroup?.files ?? 0,
      worstCerThreshold,
      'max',
    ),
    ...(worstCerGroup
      ? { group: { dimension: worstCerGroup.dimension, value: worstCerGroup.value } }
      : {}),
  });
  const worstFieldRate = worstFieldGroup ? groupFieldRate(worstFieldGroup) : null;
  const worstFieldAccuracy = worstFieldRate?.rate ?? null;
  const worstFieldThreshold = numberEnv('OCR_GATE_MIN_WORST_GROUP_FIELD_ACCURACY', 0.85);
  checks.push({
    name: 'worst_group_field_accuracy',
    value: worstFieldAccuracy,
    threshold: worstFieldThreshold,
    comparison: 'min',
    passed: worstFieldAccuracy === null ? null : worstFieldAccuracy >= worstFieldThreshold,
    ...checkEvidence(worstFieldAccuracy, worstFieldRate?.total ?? 0, worstFieldThreshold, 'min'),
    ...(worstFieldGroup
      ? { group: { dimension: worstFieldGroup.dimension, value: worstFieldGroup.value } }
      : {}),
    ...(worstFieldGroup && worstFieldBasis === 'weak'
      ? { note: '该分组没有可定位的字段证据，此项按全文包含（弱口径）判定' }
      : {}),
  });
  // A passing rate check on a thin corpus is not a release signal: report the
  // run as under-powered, naming the metrics that need more samples.
  if (numberEnv('OCR_GATE_ALLOW_THIN_EVIDENCE', 0) <= 0) {
    const thin = checks.filter(isThinEvidence);
    checks.push({
      name: 'evidence_sufficiency',
      value: thin.length,
      threshold: 0,
      comparison: 'max',
      passed: thin.length === 0,
      ...(thin.length > 0
        ? {
            note: `${thin
              .slice(0, 4)
              .map(
                (check) =>
                  `${check.name} 需 ${check.requiredSamples} 个观测，当前 ${check.samples}`,
              )
              .join('；')}${thin.length > 4 ? '；另有更多' : ''}`,
          }
        : {}),
    });
  }
  return { passed: checks.every((check) => check.passed !== false), checks };
}

/** A check that passed (or was skipped) on fewer observations than it needs. */
function isThinEvidence(check: OcrBenchGateCheck): boolean {
  if (check.passed === false) return false;
  if (check.samples === undefined || check.requiredSamples == null) return false;
  return check.samples < check.requiredSamples;
}

function coreAggregate(
  results: readonly OcrBenchFileResult[],
): Omit<OcrBenchAggregate, 'gate' | 'splits'> {
  const done = results.filter((result) => result.status === 'done');
  const evaluated = done.filter(
    (result) =>
      result.cer !== null || result.fieldAccuracy !== null || result.keywordRecall !== null,
  );
  const fieldHit = evaluated.reduce((sum, result) => sum + (result.fieldAccuracy?.hit ?? 0), 0);
  const fieldTotal = evaluated.reduce((sum, result) => sum + (result.fieldAccuracy?.total ?? 0), 0);
  const strongHit = evaluated.reduce((sum, result) => sum + (result.fieldStrong?.hit ?? 0), 0);
  const strongTotal = evaluated.reduce((sum, result) => sum + (result.fieldStrong?.total ?? 0), 0);
  const strongUnverifiable = evaluated.some(
    (result) => result.fieldStrong !== null && result.fieldStrong.unverifiable === null,
  )
    ? null
    : evaluated.reduce((sum, result) => sum + (result.fieldStrong?.unverifiable ?? 0), 0);
  const exactHit = evaluated.reduce((sum, result) => sum + (result.fieldExact?.hit ?? 0), 0);
  const exactTotal = evaluated.reduce((sum, result) => sum + (result.fieldExact?.total ?? 0), 0);
  const keywordHit = evaluated.reduce((sum, result) => sum + (result.keywordRecall?.hit ?? 0), 0);
  const keywordTotal = evaluated.reduce(
    (sum, result) => sum + (result.keywordRecall?.total ?? 0),
    0,
  );
  const correct = evaluated.filter((result) => result.fullyCorrect !== null);
  const fullyHit = correct.filter((result) => result.fullyCorrect === true).length;
  const errors: OcrErrorBreakdown = {
    substitutions: 0,
    insertions: 0,
    deletions: 0,
    missingFields: 0,
    types: [],
    top: [],
  };
  const typeCounts = new Map<string, { count: number; samples: string[] }>();
  for (const result of evaluated) {
    if (!result.errors) continue;
    errors.substitutions += result.errors.substitutions;
    errors.insertions += result.errors.insertions;
    errors.deletions += result.errors.deletions;
    errors.missingFields += result.errors.missingFields;
    for (const type of result.errors.types) {
      const entry = typeCounts.get(type) ?? { count: 0, samples: [] };
      entry.count += 1;
      if (entry.samples.length < 3 && !entry.samples.includes(result.name)) {
        entry.samples.push(result.name);
      }
      typeCounts.set(type, entry);
    }
  }
  const orderedTypes = [...typeCounts.entries()].sort(
    (left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0]),
  );
  errors.types = orderedTypes.map(([type]) => type);
  errors.top = orderedTypes
    .slice(0, 8)
    .map(([type, entry]) => ({ type, count: entry.count, samples: entry.samples }));

  const businessTotal = evaluated.reduce(
    (total, result) => {
      if (!result.businessLoss) return total;
      total.loss += result.businessLoss.loss;
      total.weight += result.businessLoss.weight;
      return total;
    },
    { loss: 0, weight: 0 },
  );
  const businessLoss: OcrBenchBusinessLoss | null =
    businessTotal.weight > 0
      ? {
          loss: round(businessTotal.loss) ?? 0,
          weight: round(businessTotal.weight) ?? 0,
          rate: round(businessTotal.loss / businessTotal.weight) ?? 0,
        }
      : null;

  const tableStructure = averageTableMetrics(
    evaluated
      .map((result) => result.tableMetrics)
      .filter((value): value is OcrBenchTableMetrics => value !== null),
  );

  const groups: OcrBenchGroup[] = [];
  const dimensions: {
    dimension: OcrBenchGroup['dimension'];
    values: (result: OcrBenchFileResult) => string[];
  }[] = [
    { dimension: 'kind', values: (result) => [result.kind] },
    { dimension: 'language', values: (result) => (result.lang ? [result.lang] : []) },
    { dimension: 'difficulty', values: (result) => (result.difficulty ? [result.difficulty] : []) },
    { dimension: 'degradation', values: (result) => result.degradations },
  ];
  for (const { dimension, values } of dimensions) {
    const buckets = new Map<string, OcrBenchFileResult[]>();
    for (const result of evaluated) {
      for (const value of values(result)) {
        const bucket = buckets.get(value) ?? [];
        bucket.push(result);
        buckets.set(value, bucket);
      }
    }
    for (const [value, bucket] of [...buckets.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const cer = average(
        bucket.map((result) => result.cer).filter((value): value is number => value !== null),
      );
      const hit = bucket.reduce((sum, result) => sum + (result.fieldAccuracy?.hit ?? 0), 0);
      const total = bucket.reduce((sum, result) => sum + (result.fieldAccuracy?.total ?? 0), 0);
      const strongHit = bucket.reduce((sum, result) => sum + (result.fieldStrong?.hit ?? 0), 0);
      const strongTotal = bucket.reduce((sum, result) => sum + (result.fieldStrong?.total ?? 0), 0);
      const bucketCorrect = bucket.filter((result) => result.fullyCorrect !== null);
      const bucketHit = bucketCorrect.filter((result) => result.fullyCorrect === true).length;
      groups.push({
        dimension,
        value,
        files: bucket.length,
        pages: bucket.reduce((sum, result) => sum + result.pages, 0),
        failed: bucket.filter((result) => result.status === 'failed').length,
        cer: round(cer),
        fieldAccuracy: round(rateOf(hit, total)),
        fieldTotal: total,
        fieldStrong: round(rateOf(strongHit, strongTotal)),
        fieldStrongTotal: strongTotal,
        fullyCorrectRate: round(rateOf(bucketHit, bucketCorrect.length)),
      });
    }
  }

  const calibration = calibrateConfidence(
    evaluated.flatMap((result) => {
      if (result.fullyCorrect === null) return [];
      const confidence = result.confidence ?? result.qualityScore;
      return confidence === null ? [] : [{ confidence, correct: result.fullyCorrect }];
    }),
  );

  const confidenceOf = (result: OcrBenchFileResult): number | null =>
    result.confidence ?? result.qualityScore;
  const calibrationGroups: OcrBenchCalibrationGroup[] = [];
  for (const dimension of ['kind', 'language'] as const) {
    const buckets = new Map<string, OcrBenchFileResult[]>();
    for (const result of evaluated) {
      const value = dimension === 'kind' ? result.kind : result.lang;
      if (!value) continue;
      const bucket = buckets.get(value) ?? [];
      bucket.push(result);
      buckets.set(value, bucket);
    }
    for (const [value, bucket] of [...buckets.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      calibrationGroups.push({
        dimension,
        value,
        calibration: calibrateConfidence(
          bucket.flatMap((result) => {
            if (result.fullyCorrect === null) return [];
            const confidence = confidenceOf(result);
            return confidence === null ? [] : [{ confidence, correct: result.fullyCorrect }];
          }),
        ),
      });
    }
  }

  const fieldBuckets = new Map<
    OcrBenchFieldCategory,
    { outcomes: OcrBenchFieldOutcome[]; samples: { confidence: number; correct: boolean }[] }
  >();
  for (const result of evaluated) {
    const confidence = confidenceOf(result);
    for (const outcome of result.fieldOutcomes) {
      const bucket = fieldBuckets.get(outcome.category) ?? { outcomes: [], samples: [] };
      bucket.outcomes.push(outcome);
      if (confidence !== null) bucket.samples.push({ confidence, correct: outcome.correct });
      fieldBuckets.set(outcome.category, bucket);
    }
  }
  const fieldReliability: OcrBenchFieldReliability[] = [...fieldBuckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, bucket]) => {
      const hit = bucket.outcomes.filter((outcome) => outcome.correct).length;
      const localized = bucket.outcomes.filter((outcome) => outcome.localized).length;
      return {
        category,
        samples: bucket.outcomes.length,
        hit,
        localized,
        // Which rule produced `correct`: a category judged on containment is a
        // weaker claim than one judged inside the annotated block.
        basis: localized === 0 ? 'weak' : localized === bucket.outcomes.length ? 'strong' : 'mixed',
        accuracy: round(rateOf(hit, bucket.outcomes.length)),
        interval: bucket.outcomes.length > 0 ? wilsonInterval(hit, bucket.outcomes.length) : null,
        calibration: calibrateConfidence(bucket.samples),
      };
    });

  const base = {
    files: results.length,
    evaluated: evaluated.length,
    failed: results.filter((result) => result.status === 'failed').length,
    documents: evaluated.length,
    pages: evaluated.reduce((sum, result) => sum + result.pages, 0),
    characters: evaluated.reduce((sum, result) => sum + result.characters, 0),
    cer: round(
      average(
        evaluated.map((result) => result.cer).filter((value): value is number => value !== null),
      ),
    ),
    rawCer: round(
      average(
        evaluated.map((result) => result.rawCer).filter((value): value is number => value !== null),
      ),
    ),
    numericCer: round(
      average(
        evaluated
          .map((result) => result.numericCer)
          .filter((value): value is number => value !== null),
      ),
    ),
    symbolCer: round(
      average(
        evaluated
          .map((result) => result.symbolCer)
          .filter((value): value is number => value !== null),
      ),
    ),
    wer: round(
      average(
        evaluated.map((result) => result.wer).filter((value): value is number => value !== null),
      ),
    ),
    keywordRecall:
      keywordTotal > 0
        ? { hit: keywordHit, total: keywordTotal, rate: keywordHit / keywordTotal }
        : null,
    fieldAccuracy:
      fieldTotal > 0
        ? {
            hit: fieldHit,
            total: fieldTotal,
            rate: fieldHit / fieldTotal,
            interval: wilsonInterval(fieldHit, fieldTotal),
          }
        : null,
    fieldStrong:
      strongTotal > 0
        ? {
            hit: strongHit,
            total: strongTotal,
            rate: strongHit / strongTotal,
            interval: wilsonInterval(strongHit, strongTotal),
            unverifiable: strongUnverifiable,
          }
        : null,
    fieldExact:
      exactTotal > 0
        ? {
            hit: exactHit,
            total: exactTotal,
            rate: exactHit / exactTotal,
            interval: wilsonInterval(exactHit, exactTotal),
          }
        : null,
    fullyCorrect:
      correct.length > 0
        ? {
            hit: fullyHit,
            total: correct.length,
            rate: fullyHit / correct.length,
            interval: wilsonInterval(fullyHit, correct.length),
          }
        : null,
    errors,
    businessLoss,
    tableStructure,
    confusions: mergeConfusions(evaluated.map((result) => result.confusions)),
    groups,
    calibration,
    calibrationGroups,
    fieldReliability,
  };
  return base;
}

/**
 * Corpus roles are reported separately and the release gate is judged on the
 * blind split only, so thresholds tuned on `dev` cannot certify themselves.
 */
export function aggregateBenchResults(results: readonly OcrBenchFileResult[]): OcrBenchAggregate {
  const all = coreAggregate(results);
  const labeled = results.some((result) => Boolean(result.split));
  const blind = labeled ? results.filter((result) => result.split === 'blind') : [];
  const gateBase = labeled && blind.length > 0 ? coreAggregate(blind) : all;
  const gateSplit = labeled && blind.length > 0 ? 'blind' : null;
  const splits: OcrBenchSplitSummary[] = SPLIT_NAMES.map((split) => {
    const members = labeled ? results.filter((result) => result.split === split) : [];
    const subset = coreAggregate(members);
    return {
      split,
      files: members.length,
      evaluated: subset.evaluated,
      failed: subset.failed,
      cer: subset.cer,
      fieldAccuracy: subset.fieldAccuracy,
      fullyCorrect: subset.fullyCorrect,
      gateSplit: gateSplit === split,
    };
  });
  return {
    ...all,
    splits,
    gate: evaluateGate(gateBase, {
      labeled,
      blindFiles: blind.length,
      gateSplit,
    }),
  };
}

function kindOf(name: string, truth: TruthEntry | undefined): string {
  if (truth?.kind) return truth.kind;
  const extension = extname(name).toLowerCase();
  return extension === '.pdf' ? 'pdf' : extension ? extension.slice(1) : 'file';
}

function languageOf(truth: TruthEntry | undefined): string | null {
  const value = truth?.lang?.trim();
  return value ? value : null;
}

function difficultyOf(truth: TruthEntry | undefined): OcrBenchDifficulty | null {
  const value = truth?.difficulty;
  return value && DIFFICULTIES.has(value) ? value : null;
}

function degradationsOf(truth: TruthEntry | undefined): string[] {
  return (truth?.degradations ?? [])
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .map((value) => value.trim())
    .slice(0, 20);
}

export class OcrBench {
  readonly #store: Store;
  readonly #client: OcrClient;
  readonly #corpusDir: string;
  #active: OcrBenchRun | null = null;
  #starting = false;
  #startingExperiment = false;
  #activeExperiment: OcrExperimentResult | null = null;
  #lastExperiment: OcrExperimentResult | null = null;

  constructor(
    store: Store,
    client: OcrClient,
    corpusDir = process.env.OCR_BENCH_DIR ?? 'benchmarks/ocr',
  ) {
    this.#store = store;
    this.#client = client;
    this.#corpusDir = resolve(corpusDir);
    const recovered = store.ocrBench.interruptRunning(
      '服务重启，OCR 基准测试已中断',
      new Date().toISOString(),
    );
    if (recovered > 0) log('warn', 'ocr.benchmark_recovered', { count: recovered });
  }

  experimentStatus(): OcrExperimentResult | null {
    return this.#lastExperiment;
  }

  /**
   * Run a model/preprocessing comparison: a stratified screening stage first,
   * then the best variants over the full corpus. Variants pin one profile and
   * one mode/DPI combination so results stay attributable.
   */
  async startExperiment(request: OcrExperimentRequest): Promise<OcrExperimentResult> {
    if (!this.#client.configured) throw new Error('未配置本地 OCR 服务');
    if (this.#active || this.#starting || this.#activeExperiment || this.#startingExperiment) {
      throw new Error('OCR 任务正在运行');
    }
    // Reserve the slot before the first await so two concurrent requests
    // cannot both pass the guard and overwrite each other's experiment.
    this.#startingExperiment = true;
    let prepared: {
      normalized: ReturnType<typeof normalizeExperimentRequest>;
      files: OcrBenchFile[];
      truth: Truth;
    };
    try {
      const normalized = normalizeExperimentRequest(request);
      const { files, truth } = await this.#corpus();
      prepared = { normalized, files, truth };
    } catch (error) {
      this.#startingExperiment = false;
      throw error;
    }
    const { normalized, files, truth } = prepared;
    const pool = files.filter(
      (file) => normalized.includePdf || extname(file.name).toLowerCase() !== '.pdf',
    );
    if (pool.length === 0) {
      this.#startingExperiment = false;
      throw new Error('基准目录没有可用样本');
    }
    const samples = selectExperimentFiles(pool, Math.min(normalized.sample, pool.length));
    const result: OcrExperimentResult = {
      id: randomUUID(),
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      includePdf: normalized.includePdf,
      sampleSize: normalized.sample,
      topK: normalized.full ? normalized.topK : null,
      variants: normalized.variants,
      stage: 'screen',
      screen: { files: samples.map((file) => file.name), results: [], summaries: [] },
      full: normalized.full
        ? { files: pool.map((file) => file.name), results: [], summaries: [] }
        : null,
      selected: [],
      error: null,
    };
    this.#activeExperiment = result;
    this.#lastExperiment = result;
    this.#startingExperiment = false;
    void (async () => {
      try {
        await this.#executeExperiment(result, normalized, pool, samples, truth);
        result.status = 'done';
        result.finishedAt = new Date().toISOString();
        log('info', 'ocr.experiment_finished', {
          runId: result.id,
          variants: result.variants.length,
          selected: result.selected,
          full: result.full?.results.length ?? 0,
        });
      } catch (error) {
        result.status = 'failed';
        result.finishedAt = new Date().toISOString();
        result.error = error instanceof Error ? error.message : String(error);
        log('warn', 'ocr.experiment_failed', { runId: result.id, message: result.error });
      } finally {
        if (this.#activeExperiment === result) this.#activeExperiment = null;
      }
    })();
    return result;
  }

  async #executeExperiment(
    result: OcrExperimentResult,
    request: ReturnType<typeof normalizeExperimentRequest>,
    pool: OcrBenchFile[],
    samples: OcrBenchFile[],
    truth: Truth,
  ): Promise<void> {
    const capabilities = new Map<string, { license: string; memoryMb: number }>(
      MODEL_CAPABILITIES.map((model) => [
        model.id,
        { license: model.license, memoryMb: model.memoryMb },
      ]),
    );
    const screenProfiles = new Map<string, string | null>();
    await this.#runExperimentStage(result.variants, result.screen, samples, truth, screenProfiles);
    result.screen.summaries = rankExperimentSummaries(
      result.variants,
      result.screen.results,
      capabilities,
    );
    result.selected = result.screen.summaries
      .filter((summary) => summary.rank !== null)
      .slice(0, request.topK)
      .map((summary) => summary.id);
    if (!result.full || result.selected.length === 0) return;
    result.stage = 'full';
    const selected = result.variants.filter((variant) => result.selected.includes(variant.id));
    const fullProfiles = new Map(screenProfiles);
    await this.#runExperimentStage(selected, result.full, pool, truth, fullProfiles);
    result.full.summaries = rankExperimentSummaries(selected, result.full.results, capabilities);
  }

  async #experimentProfile(
    variant: OcrExperimentVariant,
    cache: Map<string, string | null>,
  ): Promise<{ profile: string | null; error: string | null }> {
    if (variant.profile) return { profile: variant.profile, error: null };
    if (!variant.modelId || variant.engine !== 'paddle') {
      return { profile: null, error: null };
    }
    if (!cache.has(variant.id)) {
      const profiles = await this.#client.profilesFor(variant.engine);
      const resolved = profileForModel(profiles, variant.modelId);
      if (!resolved && profiles.length > 0) {
        return { profile: null, error: `sidecar 未配置模型 ${variant.modelId}` };
      }
      cache.set(variant.id, resolved);
    }
    return { profile: cache.get(variant.id) ?? null, error: null };
  }

  async #runExperimentStage(
    variants: OcrExperimentVariant[],
    stage: OcrExperimentStage,
    files: OcrBenchFile[],
    truth: Truth,
    profileCache: Map<string, string | null>,
  ): Promise<void> {
    for (const file of files) {
      if (!this.#client.supports(file.engine)) {
        for (const variant of variants.filter((item) => item.engine === file.engine)) {
          stage.results.push(this.#failedExperimentSample(file, variant, '未配置对应 OCR 服务'));
        }
        continue;
      }
      let stored: string | null = null;
      try {
        const data = await readFile(join(this.#corpusDir, file.name));
        stored = `benchmark/${randomUUID()}${extname(file.name)}`;
        await this.#store.uploads.write(stored, new Uint8Array(data));
        const expected = truth[file.name];
        const expectedText = expected?.text?.trim() ? expected.text : null;
        const fields = truthFields(expected).fields;
        const routing = routeOcr({
          name: file.name,
          engine: file.engine,
          kind: file.kind,
          lang: file.lang,
          mode: expected?.conditions?.mode,
        });
        const path = this.#store.uploads.resolvePath(stored);
        for (const variant of variants.filter((item) => item.engine === file.engine)) {
          const resolved = await this.#experimentProfile(variant, profileCache);
          if (resolved.error) {
            stage.results.push(this.#failedExperimentSample(file, variant, resolved.error));
            continue;
          }
          const started = Date.now();
          try {
            const extraction = await this.#client.extract(variant.engine, {
              path,
              name: file.name,
              mode: variant.mode,
              dpi: variant.dpi ?? undefined,
              channel: variant.channel,
              lang: routing.language ?? undefined,
              model: resolved.profile ?? undefined,
            });
            const seconds = Math.max(0.1, Math.round((Date.now() - started) / 100) / 10);
            const fieldScore = fieldAccuracy(fields, extraction.text);
            stage.results.push({
              name: file.name,
              kind: file.kind,
              lang: file.lang,
              variantId: variant.id,
              status: 'done',
              cer: expectedText ? benchmarkCer(expectedText, extraction.text) : null,
              rawCer: expectedText ? benchmarkRawCer(expectedText, extraction.text) : null,
              numericCer: expectedText ? benchmarkNumericCer(expectedText, extraction.text) : null,
              wer: expectedText ? benchmarkWer(expectedText, extraction.text) : null,
              fieldRate: fieldScore?.rate ?? null,
              confidence: extraction.confidence,
              seconds,
              characters: extraction.text.length,
              error: null,
            });
          } catch (error) {
            stage.results.push({
              ...this.#failedExperimentSample(file, variant, ''),
              seconds: Math.max(0.1, Math.round((Date.now() - started) / 100) / 10),
              error:
                error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
            });
          }
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
        for (const variant of variants.filter((item) => item.engine === file.engine)) {
          stage.results.push(this.#failedExperimentSample(file, variant, message));
        }
      } finally {
        if (stored) await this.#store.uploads.remove(stored).catch(() => undefined);
      }
    }
  }

  #failedExperimentSample(
    file: OcrBenchFile,
    variant: OcrExperimentVariant,
    error: string,
  ): OcrExperimentSample {
    return {
      name: file.name,
      kind: file.kind,
      lang: file.lang,
      variantId: variant.id,
      status: 'failed',
      cer: null,
      rawCer: null,
      numericCer: null,
      wer: null,
      fieldRate: null,
      confidence: null,
      seconds: 0,
      characters: 0,
      error: error || '识别失败',
    };
  }

  async #corpus(): Promise<{ files: OcrBenchFile[]; truth: Truth }> {
    let truth: Truth = {};
    try {
      truth = JSON.parse(
        await readFile(join(this.#corpusDir, 'ground_truth.json'), 'utf8'),
      ) as Truth;
    } catch {
      truth = {};
    }
    let entries: string[] = [];
    try {
      entries = await readdir(this.#corpusDir);
    } catch {
      entries = [];
    }
    const files: OcrBenchFile[] = [];
    for (const name of entries.sort()) {
      if (name.startsWith('.') || name === 'ground_truth.json') continue;
      const engine = ocrEngineFor(name);
      if (!engine) continue;
      const template = templateKeyOf(name, truth[name]);
      files.push({
        name,
        engine,
        kind: kindOf(name, truth[name]),
        lang: languageOf(truth[name]),
        difficulty: difficultyOf(truth[name]),
        degradations: degradationsOf(truth[name]),
        provenance: provenanceOf(truth[name]),
        uncertain: uncertainOf(truth[name]),
        template,
        split: splitOf(name, truth[name], template),
      });
    }
    return { files, truth };
  }

  /** Labeled documents used to fit review thresholds: the calibration split. */
  calibrationSamples(): OcrCalibrationSample[] {
    // Randomly audited `pass` documents are the only calibration input that is
    // not conditioned on being flagged, so they always join the benchmark split.
    const audits = this.#store.ocrPassAudits.calibrationSamples();
    // Field revisions are labels as well, but a revision only one person vouched
    // for is weaker evidence, and the fitter already drops disputed ones.
    const singleWeight = Math.min(1, numberEnv('OCR_ANNOTATION_SINGLE_WEIGHT', 0.4));
    const revisions = this.#store.ocrRevisionReviews
      .calibrationSamples()
      .map((sample) =>
        sample.annotation === 'single_reviewer' ? { ...sample, weight: singleWeight } : sample,
      );
    const run = this.#store.ocrBench.latest();
    if (!run) return [...audits, ...revisions];
    const labeled = run.results.some((result) => Boolean(result.split));
    const samples: OcrCalibrationSample[] = [...audits, ...revisions];
    for (const result of run.results) {
      if (result.status !== 'done') continue;
      if (labeled && result.split !== 'calibration') continue;
      if (result.confidence === null || result.fullyCorrect === null) continue;
      samples.push({
        confidence: result.confidence,
        correct: result.fullyCorrect,
        severe: !result.fullyCorrect,
        kind: result.kind,
        difficulty: result.difficulty,
        language: result.lang,
        fileType: extname(result.name).replace(/^\./, '').toLowerCase() || null,
        workspaceId: null,
      });
    }
    return samples;
  }

  thresholds(): OcrThresholdProfile[] {
    return this.#store.ocrCalibration.list();
  }

  fitThresholds(
    options: OcrThresholdFitOptions = {},
    samples: readonly OcrCalibrationSample[] = this.calibrationSamples(),
    actor?: { id: string; name: string },
  ): OcrThresholdProfile[] {
    if (samples.length === 0) throw new Error('最近一次基准运行没有可校准的样本');
    const profiles = this.#store.ocrCalibration.fit(samples, options);
    if (actor) {
      this.#store.audit.record({
        actor,
        action: 'ocr.calibration_fit',
        target: 'ocr-thresholds',
        detail: {
          samples: samples.length,
          profiles: profiles.length,
          options,
        },
      });
    }
    return profiles;
  }

  async status(): Promise<OcrBenchStatus> {
    const { files } = await this.#corpus();
    const models: Partial<Record<OcrEngine, string>> = {};
    const runtime: Partial<Record<OcrEngine, OcrModelRuntime>> = {};
    await Promise.all(
      this.#client.engines.map(async (engine) => {
        const model = this.#client.peekModel(engine) ?? (await this.#client.modelFor(engine));
        models[engine] = displayModelName(model) ?? '';
        const info = await this.#client.runtimeFor(engine);
        if (info) runtime[engine] = info;
      }),
    );
    const run = this.#store.ocrBench.latest();
    const aggregate = run ? aggregateBenchResults(run.results) : null;
    const measured: Record<string, number> = {};
    if (run) {
      const buckets = new Map<string, number[]>();
      for (const result of run.results) {
        const id = result.routing?.modelId;
        if (!id || result.cer === null || result.status !== 'done') continue;
        const scores = buckets.get(id) ?? [];
        scores.push(1 - result.cer);
        buckets.set(id, scores);
      }
      for (const [id, scores] of buckets) {
        measured[id] = scores.reduce((sum, value) => sum + value, 0) / scores.length;
      }
    }
    return {
      available: this.#client.configured,
      corpusDir: this.#corpusDir,
      models,
      matrix: withMeasuredAccuracy(MODEL_CAPABILITIES, measured),
      runtime,
      grey: greyConfig(),
      files,
      run,
      aggregate,
      thresholds: this.#store.ocrCalibration.list(),
      history: this.#store.ocrBench.history(),
    };
  }

  /**
   * Re-run one recorded stage of the latest benchmark result, optionally for a
   * single region, and report whether input/output hashes and scores match.
   */
  async replay(name: string, target: OcrStageReplayTarget): Promise<OcrStageReplayResult> {
    if (!name || name.includes('/') || name.includes('\\') || name === 'ground_truth.json') {
      throw new Error('无效的基准文件名');
    }
    const run = this.#store.ocrBench.latest();
    const result = run?.results.find((entry) => entry.name === name);
    if (!result) throw new Error(`最近一次基准运行中没有 ${name}`);
    if (result.stages.length === 0) throw new Error(`${name} 没有可重放的阶段`);
    return replayOcrStage(
      this.#client,
      result.engine,
      { path: join(this.#corpusDir, name), name },
      result.stages,
      target,
    );
  }

  async start(includePdf: boolean): Promise<OcrBenchStatus> {
    if (!this.#client.configured) throw new Error('未配置本地 OCR 服务');
    if (this.#active || this.#starting || this.#activeExperiment) {
      throw new Error('OCR 任务正在运行');
    }
    this.#starting = true;
    try {
      const { files, truth } = await this.#corpus();
      const selected = files.filter(
        (file) => includePdf || extname(file.name).toLowerCase() !== '.pdf',
      );
      if (selected.length === 0) throw new Error('基准目录没有可用样本');

      const run: OcrBenchRun = {
        id: randomUUID(),
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        includePdf,
        total: selected.length,
        completed: 0,
        current: null,
        results: [],
        error: null,
      };
      this.#store.ocrBench.start({
        id: run.id,
        startedAt: run.startedAt,
        includePdf,
        total: selected.length,
      });
      this.#active = run;
      log('info', 'ocr.benchmark_started', {
        runId: run.id,
        files: selected.length,
        includePdf,
        corpusDir: this.#corpusDir,
      });
      void (async () => {
        try {
          await this.#execute(run, selected, truth);
        } catch (error) {
          run.status = 'failed';
          run.finishedAt = new Date().toISOString();
          run.current = null;
          run.error = error instanceof Error ? error.message : String(error);
          this.#store.ocrBench.finish(run.id, 'failed', run.finishedAt, run.error);
          log('warn', 'ocr.benchmark_failed', { runId: run.id, message: run.error });
        } finally {
          if (this.#active === run) this.#active = null;
        }
      })();
      return await this.status();
    } finally {
      this.#starting = false;
    }
  }

  async #execute(run: OcrBenchRun, files: OcrBenchFile[], truth: Truth): Promise<void> {
    for (const file of files) {
      run.current = file.name;
      this.#store.ocrBench.progress(run.id, file.name, run.completed);
      let stored: string | null = null;
      let result: OcrBenchFileResult;
      try {
        if (!this.#client.supports(file.engine)) {
          throw new Error(`未配置 ${file.engine} OCR 服务`);
        }
        const data = await readFile(join(this.#corpusDir, file.name));
        stored = `benchmark/${randomUUID()}${extname(file.name)}`;
        await this.#store.uploads.write(stored, new Uint8Array(data));
        const expected = truth[file.name];
        const provenance = provenanceOf(expected);
        const uncertain = uncertainOf(expected);
        const tables = truthTablesOf(expected);
        const sha256 = createHash('sha256').update(data).digest('hex');
        const declaredHash = provenance?.sha256?.trim().toLowerCase();
        const hashVerified = declaredHash ? sha256 === declaredHash : null;
        const routing = routeOcr({
          name: file.name,
          engine: file.engine,
          kind: file.kind,
          lang: file.lang,
          mode: expected?.conditions?.mode,
        });
        const profiles =
          file.engine === 'paddle' ? await this.#client.profilesFor(file.engine) : [];
        const modelProfile = profileForModel(profiles, routing.modelId);
        const fallbackModels = routing.fallbacks
          .map((id) => profileForModel(profiles, id))
          .filter((id): id is string => Boolean(id));
        routing.profile = modelProfile;
        const started = Date.now();
        const cascade = await runOcrCascade(
          this.#client,
          file.engine,
          {
            path: this.#store.uploads.resolvePath(stored),
            name: file.name,
            mode: expected?.conditions?.mode ?? routing.mode,
            dpi: expected?.conditions?.dpi,
            lang: routing.language ?? undefined,
            model: modelProfile ?? undefined,
          },
          {
            fallbackModels,
            candidateEngines: this.#client.candidatesFor(file.engine, file.name),
          },
        );
        const seconds = Math.max(0.1, Math.round((Date.now() - started) / 100) / 10);
        const extraction = cascade.extraction;
        const expectedText = expected?.text?.trim() ? expected.text : null;
        const fields = truthFields(expected).fields;
        const normalizedFields = fieldAccuracy(fields, extraction.text);
        const cer = expectedText ? benchmarkCer(expectedText, extraction.text) : null;
        const breakdown = expectedText
          ? classifyErrors(expectedText, extraction.text)
          : { substitutions: 0, insertions: 0, deletions: 0, missingFields: 0, types: [], top: [] };
        breakdown.missingFields = normalizedFields
          ? normalizedFields.total - normalizedFields.hit
          : 0;
        breakdown.types = errorTypes(
          breakdown,
          cascade.quality.issues.map((issue) => issue.code),
        );
        const tableMetrics = benchmarkTableMetrics(tables, [], extraction.document);
        result = {
          name: file.name,
          engine: file.engine,
          kind: file.kind,
          lang: file.lang,
          difficulty: file.difficulty,
          degradations: file.degradations,
          split: file.split,
          provenance,
          uncertain,
          sha256,
          hashVerified,
          status: 'done',
          model: extraction.engine,
          route: extraction.route,
          qualityScore: cascade.quality.score,
          qualityStatus: cascade.quality.status,
          reviewRequired: cascade.quality.status !== 'pass',
          stages: cascade.stages,
          seconds,
          characters: extraction.text.length,
          confidence: extraction.confidence,
          pages: extraction.pages,
          truncated: extraction.truncated,
          cer,
          rawCer: expectedText ? benchmarkRawCer(expectedText, extraction.text) : null,
          numericCer: expectedText ? benchmarkNumericCer(expectedText, extraction.text) : null,
          symbolCer: expectedText ? benchmarkSymbolCer(expectedText, extraction.text) : null,
          wer: expectedText ? benchmarkWer(expectedText, extraction.text) : null,
          keywordRecall:
            expected?.keywords && expected.keywords.length > 0
              ? keywordRecall(expected.keywords, extraction.text)
              : null,
          fieldAccuracy: normalizedFields,
          fieldStrong: fieldStrongAccuracy(
            fields,
            extraction.text,
            expectedText ?? undefined,
            extraction.document,
            expected?.fieldHints,
          ),
          fieldExact: fieldExactAccuracy(fields, extraction.text),
          fieldOutcomes: fieldOutcomes(
            fields,
            extraction.text,
            extraction.document,
            expectedText ?? undefined,
            expected?.fieldHints,
          ),
          fullyCorrect:
            normalizedFields === null && expectedText === null
              ? null
              : (normalizedFields === null || normalizedFields.rate === 1) &&
                (cer === null || cer === 0),
          errors: normalizedFields === null && expectedText === null ? null : breakdown,
          businessLoss:
            normalizedFields === null ? null : benchmarkBusinessLoss(fields, extraction.text),
          tableMetrics,
          confusions: expectedText ? confusionMatrix(expectedText, extraction.text) : null,
          diagnosis: expectedText
            ? diagnoseErrors(expectedText, extraction.text, {
                tableCellAccuracy: tableMetrics?.cellAccuracy,
                tableRowsF1: tableMetrics?.rowsF1,
                empty: extraction.text.trim() === '',
              })
            : null,
          routing,
          modelSha256: extraction.modelSha256 ?? null,
          runtime: extraction.runtime ?? null,
          error: null,
        };
      } catch (error) {
        result = {
          name: file.name,
          engine: file.engine,
          kind: file.kind,
          lang: file.lang,
          difficulty: file.difficulty,
          degradations: file.degradations,
          split: file.split,
          provenance: file.provenance,
          uncertain: file.uncertain,
          sha256: null,
          hashVerified: null,
          status: 'failed',
          model: null,
          route: null,
          qualityScore: null,
          qualityStatus: null,
          reviewRequired: false,
          stages: [],
          seconds: 0,
          characters: 0,
          confidence: null,
          pages: 0,
          truncated: false,
          cer: null,
          rawCer: null,
          numericCer: null,
          symbolCer: null,
          wer: null,
          keywordRecall: null,
          fieldAccuracy: null,
          fieldStrong: null,
          fieldExact: null,
          fieldOutcomes: [],
          fullyCorrect: null,
          errors: null,
          businessLoss: null,
          tableMetrics: null,
          confusions: null,
          diagnosis: null,
          routing: null,
          modelSha256: null,
          runtime: null,
          error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
        };
      } finally {
        if (stored) await this.#store.uploads.remove(stored).catch(() => undefined);
      }
      run.results.push(result);
      run.completed += 1;
      this.#store.ocrBench.addResult(run.id, result);
      this.#store.ocrBench.progress(run.id, null, run.completed);
    }
    run.status = 'done';
    run.finishedAt = new Date().toISOString();
    run.current = null;
    this.#store.ocrBench.finish(run.id, 'done', run.finishedAt, null);
    log('info', 'ocr.benchmark_finished', {
      runId: run.id,
      files: run.results.length,
      failed: run.results.filter((result) => result.status === 'failed').length,
      seconds: run.results.reduce((sum, result) => sum + result.seconds, 0),
    });
  }
}
