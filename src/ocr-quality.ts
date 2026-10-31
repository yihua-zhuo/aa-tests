import type {
  DocumentBlock,
  DocumentFieldEvidence,
  DocumentFieldKind,
  DocumentMachineReadable,
  DocumentOfficeCoverage,
  DocumentQuality,
  DocumentQualityIssue,
  DocumentQualityRisk,
  OcrConfidencePoint,
  OcrInkGap,
  OcrPreprocessSelection,
} from '../shared/types.ts';
import type { OcrExtraction } from './ocr.ts';
import { applyConfidenceMap } from './ocr-calibration.ts';
import { classifyDocument, DOCUMENT_CLASS_LABELS } from './ocr-doc-type.ts';
import { amountWordsCheck, invalidIdentifiers } from './ocr-field-validation.ts';
import {
  inferTableSchema,
  numericCandidates,
  parseBusinessNumber,
  parseDateLike,
  tableBusinessSummary,
  tableRows,
} from './ocr-tables.ts';

export type QualityOptions = {
  reviewThreshold?: number;
  failThreshold?: number;
  lowConfidence?: number;
  /** Key fields (amount/date/account/id) need a stricter confidence bar. */
  keyFieldConfidence?: number;
  /** Monotonic raw -> calibrated confidence map fitted on labeled samples. */
  confidenceMap?: OcrConfidencePoint[];
  minSharpness?: number;
  minBrightness?: number;
  maxBrightness?: number;
  minContrast?: number;
  minPixels?: number;
  minTextHeight?: number;
  /** Maximum share of near-white pixels before glare is flagged. */
  maxGlare?: number;
  /** Maximum low-frequency shading range before a shadow is flagged. */
  maxShadow?: number;
  /** Maximum median-residual noise before denoising is suggested. */
  maxNoise?: number;
  /** Maximum absolute skew angle in degrees. */
  maxSkew?: number;
};

const TOTAL_HEADER = /合计|总计|小计|总额|总价|\b(?:total|sum)\b/i;
const IDENTIFIER_HEADER = /^(?:序号|编号|编码|代码|id|no\.?|#|index)$/i;
const PRICE_HEADER = /单价|价格|\b(?:price|rate)\b/i;
const PLACEHOLDER_CELL = /^(?:[-—–/\\]|n\/?a|无|暂无|待定|未知)$/i;
const RETAKE_REASON_LABELS: Record<string, string> = {
  glare: '镜面反光',
  exposure: '曝光异常',
  blurry: '图像模糊',
  shadow: '阴影遮挡',
  low_resolution: '分辨率不足',
};
/** Keep a small review band even when thresholds are configured upside down. */
const MIN_REVIEW_BAND = 0.01;
const WEIGHTS: Record<string, number> = {
  confidence: 0.25,
  lowConfidence: 0.1,
  coverage: 0.2,
  tableIntegrity: 0.15,
  fieldAccuracy: 0.15,
  columnTypes: 0.1,
  businessConstraints: 0.1,
  readingOrder: 0.1,
  duplicates: 0.05,
  validation: 0.05,
  imageQuality: 0.05,
  cellRecovery: 0.05,
  keyRegionCoverage: 0.05,
  inkCoverage: 0.05,
  schemaCoverage: 0.1,
  machineReadable: 0.1,
  preprocessSelection: 0.05,
  officeCoverage: 0.05,
};

const KEY_FIELD_PATTERNS: { kind: DocumentFieldKind; pattern: RegExp }[] = [
  {
    kind: 'amount',
    pattern:
      /(?:金额|合计|总计|小计|总额|总价|单价|应付|实付|余额|¥|￥|\$|€|£|\b(?:total|amount|sum|price|balance)\b)/i,
  },
  {
    kind: 'date',
    pattern:
      /(?:\b(?:19|20)\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}|\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b|日期|\bdate\b)/i,
  },
  {
    kind: 'identifier',
    pattern:
      /(?:发票号|单号|编号|订单号|税号|证件号|合同号|\b(?:invoice|order|serial|ref|no\.?)\b|#)\s*[:：#]?\s*[A-Za-z0-9-]{3,}/i,
  },
  {
    kind: 'account',
    pattern: /(?:账号|账户|卡号|iban|account|acct)\s*[:：#]?\s*[A-Za-z0-9-]{8,}/i,
  },
  {
    kind: 'quantity',
    pattern: /(?:数量|件数|人数|工时|天数|\b(?:qty|quantity|hours?|days?)\b)\s*[:：]?\s*\d/i,
  },
];
const MOSTLY_NUMERIC = /^(?:[\s¥￥$€£,.:%()-]*\d[\d\s,.:%()-]*)+$/;

function ratioEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function numberEnv(name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function blockConfidence(block: DocumentBlock): number | null {
  return typeof block.confidence === 'number' && Number.isFinite(block.confidence)
    ? clamp(block.confidence)
    : null;
}

/** Case/punctuation-insensitive text key used only to spot duplicated blocks. */
function duplicateKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

type ColumnTypeResult = { checked: number; matched: number; mismatches: number };

function looksLikeCorruptedValue(value: string): boolean {
  return /\d/.test(value) || /[?？□]/.test(value);
}

function columnTypeChecks(block: DocumentBlock): ColumnTypeResult {
  const rows = tableRows(block);
  const schema = inferTableSchema(block);
  // One header plus at least two data rows avoids judging single-row tables
  // where a note or summary line is easily mistaken for a type violation.
  if (!schema || rows.length - schema.headerRows < 2) {
    return { checked: 0, matched: 0, mismatches: 0 };
  }
  let checked = 0;
  let matched = 0;
  let mismatches = 0;
  for (const column of schema.columns) {
    const kind = column.kind;
    if (
      kind !== 'amount' &&
      kind !== 'date' &&
      kind !== 'quantity' &&
      kind !== 'percentage' &&
      kind !== 'number'
    ) {
      continue;
    }
    const values = rows
      .slice(schema.headerRows)
      .map((row) => (row[column.index] ?? '').trim())
      .filter((value) => value !== '' && !PLACEHOLDER_CELL.test(value));
    if (values.length < 2) continue;
    for (const value of values) {
      if (!looksLikeCorruptedValue(value)) continue;
      checked += 1;
      const valid = kind === 'date' ? parseDateLike(value) : parseBusinessNumber(value) !== null;
      if (valid) matched += 1;
      else mismatches += 1;
    }
  }
  return { checked, matched, mismatches };
}

function tableIntegrity(block: DocumentBlock): number | null {
  const rows = tableRows(block);
  if (rows.length === 0) return null;
  const widths = rows.map((row) => row.length);
  const maxWidth = Math.max(...widths);
  if (maxWidth === 0) return 0;
  const consistent = widths.filter((width) => width === maxWidth).length / rows.length;
  const filled = rows.flat().filter((cell) => cell.trim() !== '').length;
  const cells = rows.reduce((sum, row) => sum + row.length, 0);
  const fill = cells > 0 ? filled / cells : 0;
  return clamp(consistent * 0.6 + fill * 0.4);
}

function arithmeticFields(block: DocumentBlock): { checked: number; hit: number } {
  const rows = tableRows(block);
  const schema = inferTableSchema(block);
  if (!schema) return { checked: 0, hit: 0 };
  const totalColumns = schema.columns.filter((column) => TOTAL_HEADER.test(column.label));
  if (totalColumns.length === 0) return { checked: 0, hit: 0 };
  // 序号/编号 columns are often numeric but never part of a sum.
  const identifierColumns = new Set(
    schema.columns
      .filter((column) => column.kind === 'identifier' || IDENTIFIER_HEADER.test(column.label))
      .map((column) => column.index),
  );
  const quantityColumn =
    schema.columns.find(
      (column) => column.kind === 'quantity' && !identifierColumns.has(column.index),
    )?.index ?? -1;
  const priceColumn =
    schema.columns.find(
      (column) => PRICE_HEADER.test(column.label) && !identifierColumns.has(column.index),
    )?.index ?? -1;
  const multiply = quantityColumn >= 0 && priceColumn >= 0;

  let checked = 0;
  let hit = 0;
  for (const row of rows.slice(schema.headerRows)) {
    for (const totalColumn of totalColumns) {
      const totalCell = row[totalColumn.index];
      if (!totalCell) continue;
      const total = parseBusinessNumber(totalCell);
      if (total === null) continue;
      let expected: number;
      if (multiply) {
        const quantity = row[quantityColumn]
          ? parseBusinessNumber(row[quantityColumn] as string)
          : null;
        const price = row[priceColumn] ? parseBusinessNumber(row[priceColumn] as string) : null;
        if (quantity === null || price === null) continue;
        expected = quantity * price;
      } else {
        const components: number[] = [];
        for (let index = 0; index < row.length; index += 1) {
          if (index === totalColumn.index || identifierColumns.has(index)) continue;
          const value = row[index] ? parseBusinessNumber(row[index] as string) : null;
          if (value !== null) components.push(value);
        }
        if (components.length < 2) continue;
        expected = components.reduce((sum, value) => sum + value, 0);
      }
      const tolerance = Math.max(Math.abs(expected) * 0.02, 0.01);
      checked += 1;
      if (Math.abs(expected - total) <= tolerance) hit += 1;
    }
  }
  return { checked, hit };
}

function pageBlockCount(blocks: readonly DocumentBlock[]): number {
  return blocks.filter((block) => block.text.trim() !== '').length;
}

function readingOrderScore(document: OcrExtraction['document']): number | null {
  if (!document) return null;
  const ids = new Set<string>();
  for (const page of document.pages) {
    for (const block of page.blocks) {
      // Layout dedupe intentionally keeps duplicate blocks out of the order.
      if (typeof block.meta?.overlapOf === 'string') continue;
      ids.add(block.id);
    }
  }
  if (document.readingOrder.length === 0) return null;
  const unique = new Set(document.readingOrder);
  const known = document.readingOrder.filter((id) => ids.has(id)).length;
  const coverage = ids.size > 0 ? known / ids.size : 1;
  const uniqueness = unique.size / document.readingOrder.length;
  return clamp(Math.min(coverage, uniqueness));
}

export function keyFieldThreshold(options: QualityOptions = {}): number {
  return options.keyFieldConfidence ?? ratioEnv('OCR_KEY_FIELD_CONFIDENCE', 0.85);
}

export function lowConfidenceThreshold(options: QualityOptions = {}): number {
  return options.lowConfidence ?? ratioEnv('OCR_LOW_CONFIDENCE', 0.75);
}

export function keyFieldKindOf(block: DocumentBlock): DocumentFieldKind | null {
  const text = block.text.trim();
  if (!text) return null;
  for (const candidate of KEY_FIELD_PATTERNS) {
    if (candidate.pattern.test(text)) return candidate.kind;
  }
  const compact = text.replace(/\s/g, '');
  if (compact.length < 4 || !MOSTLY_NUMERIC.test(text)) return null;
  const digits = (compact.match(/\d/g) ?? []).length;
  return digits / compact.length >= 0.6 ? 'number' : null;
}

/** Key regions only count as covered when a usable value survived OCR. */
function keyFieldValuePresent(text: string, kind: DocumentFieldKind): boolean {
  switch (kind) {
    case 'amount':
    case 'number':
    case 'quantity':
    case 'percentage': {
      const token = text.match(/[-+]?[（(]?[¥￥$€£]?\s*\d[\d.,]*(?:\s*[%％])?[)）]?/u);
      return token !== null && numericCandidates(token[0]).length > 0;
    }
    case 'date': {
      const token = text.match(
        /\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*日?|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/u,
      );
      return token !== null && parseDateLike(token[0]);
    }
    case 'identifier':
    case 'account':
      return (text.match(/\d/g) ?? []).length >= 4;
    case 'text':
      return text.trim().length > 0;
    default:
      return false;
  }
}

type ImageAssessment = {
  score: number | null;
  issues: DocumentQualityIssue[];
  risks: DocumentQualityRisk[];
};

function assessImage(
  preflight: NonNullable<OcrExtraction['preflight']>,
  thresholds: {
    minSharpness: number;
    minBrightness: number;
    maxBrightness: number;
    minContrast: number;
    minPixels: number;
    maxGlare: number;
    maxShadow: number;
    maxNoise: number;
    maxSkew: number;
  },
): ImageAssessment {
  const issues: DocumentQualityIssue[] = [];
  const risks: DocumentQualityRisk[] = [];
  const parts: number[] = [];
  const metric = (value: number | null | undefined): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

  if (preflight.sharpness !== null) {
    const value = clamp(preflight.sharpness / Math.max(thresholds.minSharpness * 3, 1e-6));
    parts.push(value);
    if (preflight.sharpness < thresholds.minSharpness) {
      issues.push({
        code: 'image_blurry',
        severity: 'warning',
        message: `图像清晰度 ${(preflight.sharpness * 100).toFixed(0)}% 低于阈值，建议重新拍摄或提高分辨率`,
        page: null,
        blockId: null,
      });
    }
  }
  if (preflight.brightness !== null) {
    const { brightness } = preflight;
    let value = 1;
    if (brightness < thresholds.minBrightness) {
      value = clamp(brightness / Math.max(thresholds.minBrightness, 1e-6));
      issues.push({
        code: 'image_exposure',
        severity: 'warning',
        message: `图像过暗（亮度 ${(brightness * 100).toFixed(0)}%），建议补光后重拍`,
        page: null,
        blockId: null,
      });
    } else if (brightness > thresholds.maxBrightness) {
      value = clamp((1 - brightness) / Math.max(1 - thresholds.maxBrightness, 1e-6));
      issues.push({
        code: 'image_exposure',
        severity: 'warning',
        message: `图像过曝（亮度 ${(brightness * 100).toFixed(0)}%），高光区域可能丢失文字`,
        page: null,
        blockId: null,
      });
    }
    parts.push(value);
  }
  if (preflight.contrast !== null) {
    parts.push(clamp(preflight.contrast / Math.max(thresholds.minContrast, 1e-6)));
    if (preflight.contrast < thresholds.minContrast) {
      issues.push({
        code: 'image_blurry',
        severity: 'warning',
        message: `图像对比度偏低（${(preflight.contrast * 100).toFixed(1)}%），浅色文字可能丢失`,
        page: null,
        blockId: null,
      });
    }
  }
  if (preflight.width !== null && preflight.height !== null) {
    const pixels = preflight.width * preflight.height;
    parts.push(clamp(pixels / Math.max(thresholds.minPixels, 1)));
    if (pixels < thresholds.minPixels) {
      issues.push({
        code: 'image_low_resolution',
        severity: 'warning',
        message: `图像分辨率 ${preflight.width}×${preflight.height} 偏低，小字识别风险高`,
        page: null,
        blockId: null,
      });
    }
  }

  const glare = metric(preflight.glare);
  if (glare !== null) {
    parts.push(clamp(1 - glare / Math.max(thresholds.maxGlare * 3, 1e-6)));
    if (glare >= thresholds.maxGlare) {
      issues.push({
        code: 'image_glare',
        severity: 'warning',
        message: `镜面反光覆盖约 ${(glare * 100).toFixed(1)}% 像素，反光区文字可能丢失，建议避开反光重拍`,
        page: null,
        blockId: null,
      });
    }
  }

  const shadow = metric(preflight.shadow);
  if (shadow !== null) {
    const excess = Math.max(0, shadow - thresholds.maxShadow * 0.5);
    parts.push(clamp(1 - excess / Math.max(thresholds.maxShadow, 1e-6)));
    if (shadow >= thresholds.maxShadow) {
      issues.push({
        code: 'image_shadow',
        severity: 'warning',
        message: `页面明暗差 ${(shadow * 100).toFixed(0)}% 偏大，阴影区文字可能变淡，建议均匀补光`,
        page: null,
        blockId: null,
      });
    }
  }

  const noise = metric(preflight.noise);
  if (noise !== null) {
    parts.push(clamp(1 - noise / Math.max(thresholds.maxNoise * 3, 1e-6)));
    if (noise >= thresholds.maxNoise) {
      issues.push({
        code: 'image_noise',
        severity: 'warning',
        message: `图像噪声 ${(noise * 100).toFixed(1)}% 偏高，细笔画可能被误识，建议降噪或重拍`,
        page: null,
        blockId: null,
      });
    }
  }

  const skew = metric(preflight.skew);
  if (skew !== null) {
    parts.push(clamp(1 - Math.abs(skew) / Math.max(thresholds.maxSkew * 3, 1e-6)));
    if (Math.abs(skew) >= thresholds.maxSkew) {
      issues.push({
        code: 'image_skew',
        severity: 'warning',
        message: `页面倾斜约 ${skew.toFixed(1)}°，行切分可能错位，建议摆正后重拍`,
        page: null,
        blockId: null,
      });
    }
  }

  const applied = preflight.orientation?.applied ?? 0;
  if (applied % 180 !== 0) {
    issues.push({
      code: 'image_orientation',
      severity: 'warning',
      message: `EXIF 方向标记为 ${applied}° 旋转，页面可能横置，需确认文字方向`,
      page: null,
      blockId: null,
    });
  }

  const retakeReasons = preflight.retake?.required ? preflight.retake.reasons : [];
  if (preflight.retake?.required) {
    const labels = retakeReasons.map((reason) => RETAKE_REASON_LABELS[reason] ?? reason);
    const message = `图像质量不建议继续自动识别，请重新采集${labels.length > 0 ? `（${labels.join('、')}）` : ''}`;
    issues.push({
      code: 'image_retake',
      severity: 'error',
      message,
      page: null,
      blockId: null,
    });
    risks.push({
      code: 'image_retake',
      severity: 'error',
      message,
      page: null,
      blockId: null,
    });
  }

  const score = mean(parts);
  if (issues.length > 0) {
    risks.push({
      code: 'image_quality',
      severity: score !== null && score < 0.4 ? 'error' : 'warning',
      message: issues.map((issue) => issue.message).join('；'),
      page: null,
      blockId: null,
    });
  }
  return { score, issues, risks };
}

type TextLayerCrosscheckSample = {
  page: number;
  similarity: number | null;
  matched: boolean;
  numericMismatch: boolean;
};

export type TextLayerCrosscheck = {
  sampled: number;
  planned: number;
  failed: number;
  matched: number;
  mismatched: number;
  /** Pages whose numeric tokens differ even when overall similarity passed. */
  numericMismatched: number;
  threshold: number;
  minSimilarity: number | null;
  pages: TextLayerCrosscheckSample[];
  budgetExceeded: boolean;
  /** Populated when the sidecar could not run the sample at all. */
  skipped: string | null;
};

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Parse the sidecar's sampled text-layer crosscheck; absence is not an error. */
export function textLayerCrosscheckOf(
  document: OcrExtraction['document'],
): TextLayerCrosscheck | null {
  const textLayer = document?.meta?.textLayer;
  if (!textLayer || typeof textLayer !== 'object') return null;
  const raw = (textLayer as Record<string, unknown>).crosscheck;
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const pages: TextLayerCrosscheckSample[] = [];
  if (Array.isArray(record.pages)) {
    for (const item of record.pages) {
      if (!item || typeof item !== 'object') continue;
      const sample = item as Record<string, unknown>;
      const page = finiteNumber(sample.page);
      if (page === null) continue;
      pages.push({
        page: Math.trunc(page),
        similarity: finiteNumber(sample.similarity),
        matched: sample.matched === true,
        numericMismatch: sample.numericMismatch === true,
      });
    }
  }
  const sampled = finiteNumber(record.sampled) ?? pages.length;
  const matched = finiteNumber(record.matched) ?? pages.filter((item) => item.matched).length;
  return {
    sampled: Math.trunc(sampled),
    planned: Math.trunc(finiteNumber(record.planned) ?? sampled),
    failed: Math.trunc(finiteNumber(record.failed) ?? 0),
    matched: Math.trunc(matched),
    mismatched: Math.trunc(
      finiteNumber(record.mismatched) ?? pages.filter((item) => !item.matched).length,
    ),
    numericMismatched: Math.trunc(
      finiteNumber(record.numericMismatched) ?? pages.filter((item) => item.numericMismatch).length,
    ),
    threshold: finiteNumber(record.threshold) ?? 0.85,
    minSimilarity: finiteNumber(record.minSimilarity),
    pages,
    budgetExceeded: record.budgetExceeded === true,
    skipped:
      typeof record.skipped === 'string' && record.skipped.trim() ? record.skipped.trim() : null,
  };
}

/** Case/punctuation-insensitive key used only to compare machine-readable values. */
function compactKey(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

const MACHINE_TOKEN = /[\p{L}\p{N}][\p{L}\p{N}._/-]{3,}/gu;
const MRZ_LINE = /^[A-Z0-9<]{30,44}$/;

/**
 * Tokens from a QR/barcode payload that are distinctive enough to prove the
 * symbol belongs to this document: at least two digits and either letters plus
 * digits or six digits. URLs and generic labels are dropped, so a link-only QR
 * never counts as evidence.
 */
function machineTokens(payload: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const match of payload.matchAll(MACHINE_TOKEN)) {
    const token = match[0];
    const digits = (token.match(/\d/g) ?? []).length;
    if (digits < 2) continue;
    if (/^(?:https?|www|mailto)$/i.test(token)) continue;
    const key = compactKey(token);
    if (key.length < 5) continue;
    if (key.length < 6 && digits < 3) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push(key);
  }
  return tokens;
}

function isMrzLine(line: string): boolean {
  const compact = line.replace(/\s+/g, '');
  return MRZ_LINE.test(compact) && compact.includes('<');
}

function nonMrzText(pages: { blocks: DocumentBlock[] }[]): string {
  return pages
    .flatMap((page) =>
      page.blocks.map((block) =>
        block.text
          .split('\n')
          .filter((line) => !isMrzLine(line))
          .join('\n'),
      ),
    )
    .join('\n');
}

type MachineEvidence = {
  independent: number;
  compared: number;
  matched: number;
  missing: number;
  mrzValid: number;
  mrzFailed: number;
  mrzCrossRegion: number;
};

/** Compare decoded symbols with the recognized text; evidence only, no rewrite. */
function compareMachineReadable(
  pages: { number: number; blocks: DocumentBlock[] }[],
  entries: DocumentMachineReadable[],
  issues: DocumentQualityIssue[],
): { signals: number | null; evidence: MachineEvidence } {
  const evidence: MachineEvidence = {
    independent: 0,
    compared: 0,
    matched: 0,
    missing: 0,
    mrzValid: 0,
    mrzFailed: 0,
    mrzCrossRegion: 0,
  };
  if (entries.length === 0) return { signals: null, evidence };

  const normalizedText = compactKey(
    pages.flatMap((page) => page.blocks.map((block) => block.text)).join('\n'),
  );
  const outsideMrz = compactKey(nonMrzText(pages));
  let firstPartial: DocumentMachineReadable | null = null;

  for (const entry of entries) {
    if (entry.format === 'mrz') {
      const failed = entry.checks?.failed ?? [];
      if (entry.checks?.valid) evidence.mrzValid += 1;
      if (failed.length > 0) {
        evidence.mrzFailed += 1;
        issues.push({
          code: 'machine_readable_mismatch',
          severity: 'warning',
          message: `MRZ 校验位失败（${failed.join('、')}），证号/日期可能识别错误或证件无效`,
          page: entry.page,
          blockId: null,
        });
      }
      // The MRZ itself is recognized text, so only its fields found outside the
      // MRZ band count as cross-region corroboration, and only at same-engine
      // strength.
      for (const key of ['documentNumber', 'birthDate', 'expiryDate', 'surname', 'givenNames']) {
        const raw = entry.fields?.[key];
        if (!raw) continue;
        const value = compactKey(raw);
        if (value.length < 3 || !outsideMrz.includes(value)) continue;
        evidence.mrzCrossRegion += 1;
        for (const page of pages) {
          const block = page.blocks.find(
            (candidate) =>
              !isMrzLine(candidate.text) &&
              candidate.meta?.regionAgreement !== 'conflict' &&
              candidate.meta?.regionAgreement !== 'confirmed_independent' &&
              keyFieldKindOf(candidate) !== null &&
              compactKey(candidate.text).includes(value),
          );
          if (block) {
            block.meta = { ...block.meta, regionAgreement: 'confirmed_same_engine' };
            break;
          }
        }
      }
      continue;
    }

    const tokens = machineTokens(entry.text);
    if (tokens.length === 0) continue;
    const matched = tokens.filter((token) => normalizedText.includes(token));
    if (matched.length === 0) continue;
    evidence.independent += 1;
    evidence.compared += tokens.length;
    evidence.matched += matched.length;
    evidence.missing += tokens.length - matched.length;
    if (tokens.length > matched.length && !firstPartial) firstPartial = entry;
    for (const page of pages) {
      for (const block of page.blocks) {
        if (block.meta?.regionAgreement === 'conflict') continue;
        if (block.meta?.regionAgreement === 'confirmed_independent') continue;
        if (keyFieldKindOf(block) === null) continue;
        const key = compactKey(block.text);
        if (matched.some((token) => key.includes(token))) {
          block.meta = { ...block.meta, regionAgreement: 'confirmed_independent' };
        }
      }
    }
  }

  if (evidence.independent > 0 && evidence.missing === 0) {
    issues.push({
      code: 'machine_readable_confirmed',
      severity: 'info',
      message: `${evidence.independent} 个二维码/条码的 ${evidence.matched} 个字段与识别文本一致`,
      page: null,
      blockId: null,
    });
  }
  if (firstPartial) {
    issues.push({
      code: 'machine_readable_partial',
      severity: 'warning',
      message: `条码/二维码中有 ${evidence.missing} 个业务字段未出现在识别文本中，可能漏识别或与页面无关`,
      page: firstPartial.page,
      blockId: null,
    });
  }
  if (evidence.mrzValid > 0) {
    issues.push({
      code: 'machine_readable_confirmed',
      severity: 'info',
      message: `${evidence.mrzValid} 条 MRZ 通过 ICAO 9303 校验位`,
      page: null,
      blockId: null,
    });
  }

  return {
    signals:
      evidence.compared > 0 ? (evidence.compared - evidence.missing) / evidence.compared : null,
    evidence,
  };
}

function isMachineReadable(value: unknown): value is DocumentMachineReadable {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.format !== 'qr' && record.format !== 'barcode' && record.format !== 'mrz') {
    return false;
  }
  return typeof record.text === 'string' && typeof record.page === 'number';
}

/** Office package coverage reported by the sidecar; absent for PDFs/images. */
export function officeCoverageOf(
  document: OcrExtraction['document'],
): DocumentOfficeCoverage | null {
  const raw = document?.meta.office;
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const coverage: DocumentOfficeCoverage = {};
  for (const key of [
    'deletedText',
    'insertedText',
    'revisions',
    'textBoxes',
    'headers',
    'footers',
    'footnotes',
    'endnotes',
    'comments',
    'charts',
    'images',
    'embeddedObjects',
    'hiddenSlides',
    'groupedShapes',
    'notes',
    'objects',
    'unrendered',
  ] as const) {
    const value = finiteNumber(record[key]);
    if (value !== null) coverage[key] = Math.trunc(value);
  }
  return Object.keys(coverage).length > 0 ? coverage : null;
}

/** Enhanced-preprocessing decisions recorded in `document.meta.preprocess`. */
export function photometricSelectionsOf(
  document: OcrExtraction['document'],
): OcrPreprocessSelection[] {
  const raw = document?.meta.preprocess;
  if (!raw || typeof raw !== 'object') return [];
  const pages = (raw as Record<string, unknown>).pages;
  if (!Array.isArray(pages)) return [];
  const selections: OcrPreprocessSelection[] = [];
  for (const page of pages) {
    if (!page || typeof page !== 'object') continue;
    const record = page as Record<string, unknown>;
    const selection = record.ocrSelection;
    if (!selection || typeof selection !== 'object') continue;
    const item = selection as Record<string, unknown>;
    const selected = item.selected === 'enhanced' ? 'enhanced' : 'original';
    const basis =
      item.basis === 'numeric_conflict' ||
      item.basis === 'corrupt' ||
      item.basis === 'tokens' ||
      item.basis === 'confidence'
        ? item.basis
        : 'no_gain';
    const enhanced =
      item.enhanced && typeof item.enhanced === 'object'
        ? (item.enhanced as Record<string, unknown>)
        : {};
    selections.push({
      page: Math.trunc(finiteNumber(record.page) ?? selections.length + 1),
      selected,
      basis,
      conflict: item.conflict === true,
      agreement: finiteNumber(item.agreement),
      missingTokens: finiteNumber(enhanced.missingTokens),
      addedTokens: finiteNumber(enhanced.addedTokens),
    });
  }
  return selections;
}

/** Heuristic quality score; confidence is calibrated only when a fitted map is supplied. */
export function assessQuality(
  extraction: OcrExtraction,
  options: QualityOptions = {},
): DocumentQuality {
  const reviewThreshold = clamp(
    options.reviewThreshold ?? ratioEnv('OCR_QUALITY_REVIEW_THRESHOLD', 0.7),
  );
  const failThreshold = Math.min(
    clamp(options.failThreshold ?? ratioEnv('OCR_QUALITY_FAIL_THRESHOLD', 0.45)),
    Math.max(0, reviewThreshold - MIN_REVIEW_BAND),
  );
  const lowConfidence = options.lowConfidence ?? ratioEnv('OCR_LOW_CONFIDENCE', 0.75);

  const document = extraction.document;
  const pages = document?.pages ?? [];
  const blocks = pages.flatMap((page) => page.blocks);
  const textBlocks = blocks.filter((block) => block.text.trim() !== '');
  const issues: DocumentQualityIssue[] = [];
  const signals: Record<string, number | null> = {};
  const classification = classifyDocument({
    text: extraction.text || textBlocks.map((block) => block.text).join('\n'),
    blocks,
  });

  const confidenceMap = options.confidenceMap;
  const calibrate = (value: number): number => applyConfidenceMap(value, confidenceMap);
  const confidenceValues = blocks
    .map(blockConfidence)
    .filter((value): value is number => value !== null);
  const rawConfidence = extraction.confidence ?? mean(confidenceValues);
  const confidence = rawConfidence === null ? null : calibrate(rawConfidence);
  signals.confidence = confidence;
  if (confidenceMap && rawConfidence !== null) signals.rawConfidence = rawConfidence;

  const cellConfidenceValues = blocks
    .filter((block) => block.type === 'table')
    .flatMap((block) => (block.cells ?? []).map((cell) => cell.confidence))
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .map((value) => calibrate(clamp(value)));
  const regionConfidenceValues = [
    ...confidenceValues.map((value) => calibrate(value)),
    ...cellConfidenceValues,
  ];

  const lowRatio =
    regionConfidenceValues.length > 0
      ? regionConfidenceValues.filter((value) => value < lowConfidence).length /
        regionConfidenceValues.length
      : null;
  signals.lowConfidence = lowRatio === null ? null : 1 - lowRatio;

  let coverage: number | null = null;
  if (pages.length > 0) {
    const pagesWithText = pages.filter((page) => pageBlockCount(page.blocks) > 0).length;
    coverage = pagesWithText / pages.length;
    if (blocks.length > 0 && textBlocks.length / blocks.length < coverage) {
      coverage = coverage * 0.6 + (textBlocks.length / blocks.length) * 0.4;
    }
  } else if (blocks.length > 0) {
    coverage = textBlocks.length / blocks.length;
  }
  signals.coverage = coverage;

  const tables = blocks.filter((block) => block.type === 'table');
  const tableScores = tables.map(tableIntegrity).filter((value): value is number => value !== null);
  signals.tableIntegrity = mean(tableScores);

  let fieldHit = 0;
  let fieldChecked = 0;
  for (const table of tables) {
    const result = arithmeticFields(table);
    fieldHit += result.hit;
    fieldChecked += result.checked;
  }
  signals.fieldAccuracy = fieldChecked > 0 ? fieldHit / fieldChecked : null;

  let typeChecked = 0;
  let typeMatched = 0;
  let typeMismatches = 0;
  let firstTypeMismatch: { page: number; blockId: string } | null = null;
  for (const page of pages) {
    for (const block of page.blocks) {
      if (block.type !== 'table') continue;
      const result = columnTypeChecks(block);
      typeChecked += result.checked;
      typeMatched += result.matched;
      typeMismatches += result.mismatches;
      if (result.mismatches > 0 && !firstTypeMismatch) {
        firstTypeMismatch = { page: page.number, blockId: block.id };
      }
    }
  }
  signals.columnTypes = typeChecked > 0 ? typeMatched / typeChecked : null;

  let businessChecked = 0;
  let businessPassed = 0;
  let businessFailed = 0;
  let businessWarnings = 0;
  let firstBusiness: {
    page: number;
    blockId: string;
    message: string;
    failed: boolean;
  } | null = null;
  for (const page of pages) {
    for (const block of page.blocks) {
      if (block.type !== 'table') continue;
      const summary = tableBusinessSummary(block);
      businessChecked += summary.checked;
      businessPassed += summary.passed;
      businessFailed += summary.failed;
      businessWarnings += summary.warnings;
      if (summary.failed + summary.warnings > 0 && !firstBusiness) {
        const check =
          summary.checks.find((item) => item.status === 'failed') ??
          summary.checks.find((item) => item.status === 'warning');
        firstBusiness = {
          page: page.number,
          blockId: block.id,
          message: check?.message ?? '表格业务约束校验未通过',
          failed: summary.failed > 0,
        };
      }
    }
  }
  signals.businessConstraints = businessChecked > 0 ? businessPassed / businessChecked : null;

  const rawEvidence = document?.meta.fieldEvidence;
  const fieldEvidence = Array.isArray(rawEvidence)
    ? rawEvidence.filter(
        (item): item is DocumentFieldEvidence =>
          typeof item === 'object' && item !== null && 'cell' in item,
      )
    : [];
  const cellConflicts = fieldEvidence.filter((item) => item.agreement === 'conflict');
  signals.cellRecovery =
    fieldEvidence.length > 0
      ? (fieldEvidence.length - cellConflicts.length) / fieldEvidence.length
      : null;

  signals.readingOrder = readingOrderScore(document);

  let duplicates: number | null = null;
  if (textBlocks.length >= 4) {
    const seen = new Set<string>();
    let repeated = 0;
    let considered = 0;
    for (const block of textBlocks) {
      // Running headers/footers and bbox-level duplicates repeat by design.
      if (block.type === 'header' || block.type === 'footer') continue;
      if (typeof block.meta?.overlapOf === 'string') continue;
      considered += 1;
      const key = duplicateKey(block.text);
      if (key.length < 12) continue;
      if (seen.has(key)) repeated += 1;
      else seen.add(key);
    }
    duplicates = considered > 0 ? repeated / considered : null;
  }
  signals.duplicates = duplicates === null ? null : 1 - duplicates;

  const validations: {
    status: NonNullable<DocumentBlock['validation']>['status'];
    page: number;
    blockId: string;
  }[] = [];
  for (const page of pages) {
    for (const block of page.blocks) {
      if (block.validation) {
        validations.push({ status: block.validation.status, page: page.number, blockId: block.id });
      }
    }
  }
  const invalidBlocks = validations.filter((item) => item.status !== 'passed');
  signals.validation =
    validations.length > 0
      ? (validations.length - invalidBlocks.length) / validations.length
      : null;

  const hardRisks: DocumentQualityRisk[] = [];
  const pageOfBlock = new Map<string, number>();
  for (const page of pages) {
    for (const block of page.blocks) pageOfBlock.set(block.id, page.number);
  }

  const machineEntries = pages
    .flatMap((page) => page.meta?.machineReadable ?? [])
    .filter(isMachineReadable);
  const machine = compareMachineReadable(pages, machineEntries, issues);
  signals.machineReadable = machine.signals;
  if (machine.evidence.missing > 0) {
    hardRisks.push({
      code: 'machine_readable_conflict',
      severity: 'warning',
      message: '条码/二维码部分字段未在识别文本中出现，需要核对是否漏识别',
      page: null,
      blockId: null,
    });
  }
  if (machine.evidence.mrzFailed > 0) {
    hardRisks.push({
      code: 'machine_readable_conflict',
      severity: 'warning',
      message: 'MRZ 校验位失败，证件号或日期可能有识别错误，不能被其他高分信号抵消',
      page: null,
      blockId: null,
    });
  }

  // Independent evidence: checksummed identifiers and the uppercase amount are
  // not produced by the OCR model, so conflicts here are hard risks.
  const validationText = pages
    .flatMap((page) => page.blocks.map((block) => block.text))
    .join('\n')
    .slice(0, 500_000);
  if (validationText) {
    const amountWords = amountWordsCheck(validationText);
    if (amountWords.uppercase !== null && amountWords.matched === false) {
      issues.push({
        code: 'amount_words_mismatch',
        severity: 'warning',
        message: `大写金额（${amountWords.uppercase.toFixed(2)}）与小写金额不一致`,
        page: null,
        blockId: null,
      });
      hardRisks.push({
        code: 'field_validation_failed',
        severity: 'warning',
        message: '大小写金额互校失败，不能被其他高分信号抵消',
        page: null,
        blockId: null,
      });
    }
    const invalid = invalidIdentifiers(validationText);
    if (invalid.length > 0) {
      const first = invalid[0];
      issues.push({
        code: 'identifier_checksum',
        severity: 'warning',
        message: `${invalid.length} 个编号未通过校验位（${first?.kind ?? 'identifier'}）`,
        page: null,
        blockId: null,
      });
      hardRisks.push({
        code: 'field_validation_failed',
        severity: 'warning',
        message: '编号校验位失败，可能是识别错误或录入错误',
        page: null,
        blockId: null,
      });
    }
  }

  const minSharpness = options.minSharpness ?? numberEnv('OCR_MIN_SHARPNESS', 0.2, 0);
  const minBrightness = options.minBrightness ?? ratioEnv('OCR_MIN_BRIGHTNESS', 0.25);
  const maxBrightness = options.maxBrightness ?? ratioEnv('OCR_MAX_BRIGHTNESS', 0.95);
  const minContrast = options.minContrast ?? ratioEnv('OCR_MIN_CONTRAST', 0.08);
  const minPixels = options.minPixels ?? numberEnv('OCR_MIN_PIXELS', 300_000, 0);
  const minTextHeight = options.minTextHeight ?? numberEnv('OCR_MIN_TEXT_HEIGHT', 12, 0);
  const maxGlare = options.maxGlare ?? ratioEnv('OCR_MAX_GLARE', 0.02);
  const maxShadow = options.maxShadow ?? ratioEnv('OCR_MAX_SHADOW', 0.35);
  const maxNoise = options.maxNoise ?? ratioEnv('OCR_MAX_NOISE', 0.09);
  const maxSkew = options.maxSkew ?? numberEnv('OCR_MAX_SKEW', 3, 0);
  const keyFieldConfidence = keyFieldThreshold(options);

  const image = extraction.preflight
    ? assessImage(extraction.preflight, {
        minSharpness,
        minBrightness,
        maxBrightness,
        minContrast,
        minPixels,
        maxGlare,
        maxShadow,
        maxNoise,
        maxSkew,
      })
    : null;
  signals.imageQuality = image?.score ?? null;
  if (image) {
    issues.push(...image.issues);
    hardRisks.push(...image.risks);
  }

  const selections = photometricSelectionsOf(document);
  const selectionConflicts = selections.filter((selection) => selection.conflict);
  signals.preprocessSelection =
    selections.length > 0
      ? (selections.length - selectionConflicts.length) / selections.length
      : null;
  if (selectionConflicts.length > 0) {
    const first = selectionConflicts[0];
    const missing = first.missingTokens;
    issues.push({
      code: 'preprocess_conflict',
      severity: 'warning',
      message: `增强预处理候选丢失了原文 ${missing ?? '若干'} 个数字 token（一致度 ${
        first.agreement === null ? '未知' : `${Math.round(first.agreement * 100)}%`
      }），已保留原图识别结果`,
      page: first.page,
      blockId: null,
    });
    hardRisks.push({
      code: 'preprocess_conflict',
      severity: 'warning',
      message: '增强前后数字不一致，差异可能来自预处理伪影，需人工核对金额与编号',
      page: first.page,
      blockId: null,
    });
  }

  const crosscheck = textLayerCrosscheckOf(document);
  if (
    crosscheck &&
    (crosscheck.failed > 0 ||
      crosscheck.budgetExceeded ||
      crosscheck.skipped !== null ||
      crosscheck.sampled === 0)
  ) {
    const reasons: string[] = [];
    if (crosscheck.failed > 0) reasons.push(`${crosscheck.failed} 页抽样失败`);
    if (crosscheck.budgetExceeded) reasons.push('超出时间预算');
    if (crosscheck.skipped) reasons.push(crosscheck.skipped);
    if (crosscheck.sampled === 0 && crosscheck.planned > 0) reasons.push('没有完成任何抽样');
    issues.push({
      code: 'text_layer_crosscheck_incomplete',
      severity: 'info',
      message: `PDF 文本层交叉验证未完成（${reasons.join('，') || '抽样不足'}），无法确认内嵌文本与版面一致`,
      page: null,
      blockId: null,
    });
  }
  if (crosscheck && crosscheck.mismatched > 0) {
    const firstMismatch = crosscheck.pages.find((sample) => !sample.matched);
    const lowest = crosscheck.minSimilarity;
    const detail = lowest === null ? '' : `，最低相似度 ${Math.round(lowest * 100)}%`;
    issues.push({
      code: 'text_layer_mismatch',
      severity: 'warning',
      message: `PDF 文本层抽样 ${crosscheck.sampled} 页，其中 ${crosscheck.mismatched} 页与渲染 OCR 相似度低于 ${Math.round(crosscheck.threshold * 100)}%${detail}`,
      page: firstMismatch?.page ?? null,
      blockId: null,
    });
    hardRisks.push({
      code: 'text_layer_mismatch',
      severity: 'warning',
      message: '内嵌文本层可能与版面内容不一致，请比对页面原文后复核',
      page: firstMismatch?.page ?? null,
      blockId: null,
    });
  }

  if (crosscheck && crosscheck.numericMismatched > 0) {
    const firstNumeric = crosscheck.pages.find((sample) => sample.numericMismatch);
    issues.push({
      code: 'text_layer_mismatch',
      severity: 'warning',
      message: `PDF 文本层抽样中有 ${crosscheck.numericMismatched} 页数字 token 与渲染 OCR 不一致，整体相似度可能掩盖金额错误`,
      page: firstNumeric?.page ?? null,
      blockId: null,
    });
    hardRisks.push({
      code: 'text_layer_mismatch',
      severity: 'warning',
      message: '文本层与渲染结果的数字不一致，请逐项核对金额与编号',
      page: firstNumeric?.page ?? null,
      blockId: null,
    });
  }

  const rawTextHeight = document?.meta.textHeight;
  const textHeight =
    typeof rawTextHeight === 'number' && Number.isFinite(rawTextHeight) ? rawTextHeight : null;
  if (textHeight !== null && textHeight < minTextHeight) {
    issues.push({
      code: 'small_text',
      severity: 'warning',
      message: `文字高度约 ${textHeight.toFixed(1)}px，低于 ${minTextHeight}px，小字识别风险高`,
      page: null,
      blockId: null,
    });
    if (textHeight < minTextHeight * 0.65) {
      hardRisks.push({
        code: 'small_text',
        severity: 'warning',
        message: `文字高度约 ${textHeight.toFixed(1)}px，建议更高 DPI 或局部放大后复核`,
        page: null,
        blockId: null,
      });
    }
  }

  const keyFieldBlocks = blocks.filter((block) => keyFieldKindOf(block) !== null);
  const lowKeyFields = keyFieldBlocks.filter((block) => {
    const rawValue = blockConfidence(block);
    const value = rawValue === null ? null : calibrate(rawValue);
    return (
      value !== null &&
      value < keyFieldConfidence &&
      // Only a differently-built recognizer can rebut a low confidence: the
      // same model re-reads the same pixels and repeats its own errors.
      block.meta?.regionAgreement !== 'confirmed_independent'
    );
  });
  const sameEngineConfirmed = keyFieldBlocks.filter(
    (block) => block.meta?.regionAgreement === 'confirmed_same_engine',
  );
  signals.keyFieldCoverage =
    keyFieldBlocks.length > 0
      ? (keyFieldBlocks.length - lowKeyFields.length) / keyFieldBlocks.length
      : null;
  if (lowKeyFields.length > 0) {
    const first = lowKeyFields[0];
    issues.push({
      code: 'key_field_low_confidence',
      severity: 'warning',
      message: `${lowKeyFields.length} 个关键字段（金额/日期/编号）置信度低于 ${Math.round(
        keyFieldConfidence * 100,
      )}%`,
      page: first ? (pageOfBlock.get(first.id) ?? null) : null,
      blockId: first?.id ?? null,
    });
    hardRisks.push({
      code: 'key_field_low_confidence',
      severity: 'warning',
      message: '关键字段置信度偏低，不能被其他高分信号抵消',
      page: first ? (pageOfBlock.get(first.id) ?? null) : null,
      blockId: first?.id ?? null,
    });
  }
  if (sameEngineConfirmed.length > 0) {
    const first = sameEngineConfirmed[0];
    issues.push({
      code: 'key_field_same_engine_confirmation',
      severity: 'info',
      message: `${sameEngineConfirmed.length} 个关键字段只由同一模型复认一致，需异构引擎或 VLM 才能降级`,
      page: first ? (pageOfBlock.get(first.id) ?? null) : null,
      blockId: first?.id ?? null,
    });
  }

  let keyValueHit = 0;
  let firstMissingKey: DocumentBlock | null = null;
  for (const block of keyFieldBlocks) {
    const kind = keyFieldKindOf(block);
    if (kind && keyFieldValuePresent(block.text, kind)) {
      keyValueHit += 1;
    } else if (!firstMissingKey) {
      firstMissingKey = block;
    }
  }
  const keyRegionCoverage = keyFieldBlocks.length > 0 ? keyValueHit / keyFieldBlocks.length : null;
  signals.keyRegionCoverage = keyRegionCoverage;
  if (firstMissingKey) {
    const missing = keyFieldBlocks.length - keyValueHit;
    issues.push({
      code: 'key_region_missing',
      severity: 'warning',
      message: `${missing} 个关键字段区域内未找到可解析值（金额/日期/编号）`,
      page: pageOfBlock.get(firstMissingKey.id) ?? null,
      blockId: firstMissingKey.id,
    });
    if (keyRegionCoverage !== null && keyRegionCoverage < 0.5) {
      hardRisks.push({
        code: 'key_region_missing',
        severity: 'warning',
        message: '关键字段区域覆盖不足，可能存在漏检金额、日期或编号',
        page: pageOfBlock.get(firstMissingKey.id) ?? null,
        blockId: firstMissingKey.id,
      });
    }
  }

  // Ink that no recognition box explains (review #60). This is the only miss
  // signal that never asks the model to doubt itself, so it still fires on a
  // page of confidently wrong text; pages whose analysis did not run are kept
  // separate from pages that were analyzed and came back clean.
  const inkGaps: { page: number; gap: OcrInkGap }[] = [];
  let analyzedPages = 0;
  let droppedGaps = 0;
  for (const page of pages) {
    const gaps = page.meta?.inkGaps;
    if (gaps === undefined) continue;
    analyzedPages += 1;
    droppedGaps += page.meta?.inkGapsDropped ?? 0;
    // Recovery appends a block carrying the id of the gap it filled. That ink is
    // inside a box now, so it cannot also be reported as unexplained.
    const recovered = new Set(
      page.blocks
        .map((block) => block.meta?.inkGap)
        .filter((id): id is string => typeof id === 'string'),
    );
    for (const gap of gaps) if (!recovered.has(gap.id)) inkGaps.push({ page: page.number, gap });
  }
  // Four unexplained regions on one analyzed page read as a total loss; the
  // weight stays small so a noisy scan cannot swamp the other signals. A page
  // the sidecar did not analyze is unknown rather than clean, and entries that
  // could not be parsed count against coverage without inventing a gap.
  signals.inkCoverage =
    analyzedPages > 0
      ? Math.max(0, 1 - (inkGaps.length + droppedGaps) / (4 * analyzedPages))
      : null;
  if (inkGaps.length > 0 || droppedGaps > 0) {
    const cellGaps = inkGaps.filter((item) => item.gap.kind === 'cell');
    const first = inkGaps[0] ?? null;
    const counted = inkGaps.length + droppedGaps;
    issues.push({
      code: 'ink_without_text',
      severity: 'warning',
      message: `${counted} 处墨迹没有任何识别框覆盖${
        cellGaps.length > 0 ? `（其中 ${cellGaps.length} 处在表格空白单元格内）` : ''
      }${droppedGaps > 0 ? `（另有 ${droppedGaps} 处墨迹无法解析或超出上报上限，未能核对）` : ''}`,
      page: first?.page ?? null,
      blockId: first?.gap.blockId ?? null,
    });
    // Unparseable entries cannot be cropped either, so they must not quietly
    // downgrade the page to "analyzed and clean".
    if (cellGaps.length > 0 || counted >= 3 || !first) {
      hardRisks.push({
        code: 'ink_without_text',
        severity: 'warning',
        message: first
          ? '存在未被任何识别框覆盖的墨迹，可能漏识别了整行或整格内容'
          : '存在无法解析的墨迹区域，无法确认是否漏识别',
        page: first?.page ?? null,
        blockId: first?.gap.blockId ?? null,
      });
    }
  }

  if (!extraction.text.trim()) {
    issues.push({
      code: 'empty_text',
      severity: 'error',
      message: '未识别到任何文本',
      page: null,
      blockId: null,
    });
  }
  if (extraction.truncated) {
    issues.push({
      code: 'truncated',
      severity: 'warning',
      message: '结果因页数或时间上限被截断',
      page: null,
      blockId: null,
    });
  }
  if (lowRatio !== null && lowRatio >= 0.25) {
    issues.push({
      code: 'low_confidence',
      severity: 'warning',
      message: `${Math.round(lowRatio * 100)}% 的文本块置信度低于 ${Math.round(lowConfidence * 100)}%`,
      page: null,
      blockId: null,
    });
  } else if (confidence !== null && confidence < lowConfidence) {
    issues.push({
      code: 'low_confidence',
      severity: 'warning',
      message: `整体置信度 ${(confidence * 100).toFixed(1)}% 偏低`,
      page: null,
      blockId: null,
    });
  }
  if (coverage !== null && coverage < 0.6) {
    issues.push({
      code: 'low_coverage',
      severity: 'warning',
      message: `只有 ${Math.round(coverage * 100)}% 的页面/区域识别出文本`,
      page: null,
      blockId: null,
    });
  }
  for (const page of pages) {
    if (pageBlockCount(page.blocks) === 0) {
      issues.push({
        code: 'empty_page',
        severity: 'warning',
        message: `第 ${page.number} 页没有识别到文本`,
        page: page.number,
        blockId: null,
      });
      if (issues.length >= 24) break;
    }
  }
  if (signals.tableIntegrity !== null && signals.tableIntegrity !== undefined) {
    if (signals.tableIntegrity < 0.85) {
      issues.push({
        code: 'table_integrity',
        severity: 'warning',
        message: `表格完整度 ${(signals.tableIntegrity * 100).toFixed(1)}% 偏低`,
        page: null,
        blockId: null,
      });
      hardRisks.push({
        code: 'table_structure_risk',
        severity: 'warning',
        message: '表格行列或单元格完整性不足，需要人工复核',
        page: null,
        blockId: null,
      });
    }
  }
  if (fieldChecked >= 2 && fieldHit < fieldChecked) {
    issues.push({
      code: 'field_mismatch',
      severity: 'warning',
      message: `${fieldChecked - fieldHit}/${fieldChecked} 行合计校验不一致`,
      page: null,
      blockId: null,
    });
    hardRisks.push({
      code: 'field_validation_failed',
      severity: 'warning',
      message: '业务字段算术校验失败，不能被其他高分信号抵消',
      page: null,
      blockId: null,
    });
  }
  if (typeMismatches > 0) {
    issues.push({
      code: 'cell_type_mismatch',
      severity: 'warning',
      message: `${typeMismatches} 个金额/日期/数量/比例单元格不符合列类型`,
      page: firstTypeMismatch?.page ?? null,
      blockId: firstTypeMismatch?.blockId ?? null,
    });
    if (typeMismatches >= 2 && !hardRisks.some((risk) => risk.code === 'field_validation_failed')) {
      hardRisks.push({
        code: 'field_validation_failed',
        severity: 'warning',
        message: '列类型校验发现多个数值/日期单元格异常，不能被其他高分信号抵消',
        page: firstTypeMismatch?.page ?? null,
        blockId: firstTypeMismatch?.blockId ?? null,
      });
    }
  }
  if (firstBusiness) {
    const counts: string[] = [];
    if (businessFailed > 0) counts.push(`${businessFailed} 项失败`);
    if (businessWarnings > 0) counts.push(`${businessWarnings} 项警告`);
    issues.push({
      code: 'business_constraint',
      severity: 'warning',
      message:
        counts.length > 0
          ? `${firstBusiness.message}（${counts.join('，')}）`
          : firstBusiness.message,
      page: firstBusiness.page,
      blockId: firstBusiness.blockId,
    });
    if (businessFailed > 0) {
      hardRisks.push({
        code: 'field_validation_failed',
        severity: 'warning',
        message: '表格业务约束校验失败，需要人工复核后才能使用',
        page: firstBusiness.page,
        blockId: firstBusiness.blockId,
      });
    }
  }
  if (cellConflicts.length > 0) {
    const first = cellConflicts[0];
    issues.push({
      code: 'cell_recovery_conflict',
      severity: 'warning',
      message: `${cellConflicts.length} 个表格单元格复认结果与初始值冲突，原文已保留`,
      page: first?.page ?? null,
      blockId: first?.blockId ?? null,
    });
    hardRisks.push({
      code: 'field_validation_failed',
      severity: 'warning',
      message: '单元格复认冲突未被自动采纳，需要人工确认',
      page: first?.page ?? null,
      blockId: first?.blockId ?? null,
    });
  }
  if (invalidBlocks.length > 0) {
    const first = invalidBlocks[0];
    issues.push({
      code: 'block_validation',
      severity: 'warning',
      message: `${invalidBlocks.length} 个文本块未通过结构校验`,
      page: first?.page ?? null,
      blockId: first?.blockId ?? null,
    });
  }
  if (signals.readingOrder !== null && signals.readingOrder !== undefined) {
    if (signals.readingOrder < 0.9) {
      issues.push({
        code: 'reading_order',
        severity: 'warning',
        message: '阅读顺序存在缺失或重复',
        page: null,
        blockId: null,
      });
    }
  }
  if (duplicates !== null && duplicates > 0.3) {
    issues.push({
      code: 'duplicate_content',
      severity: 'info',
      message: `${Math.round(duplicates * 100)}% 的文本块内容重复`,
      page: null,
      blockId: null,
    });
  }

  const schema = classification.schema;
  signals.schemaCoverage = schema.coverage;
  if (classification.type !== 'generic') {
    const typeLabel = DOCUMENT_CLASS_LABELS[classification.type];
    if (schema.missing.length > 0) {
      issues.push({
        code: 'schema_field_missing',
        severity: 'warning',
        message: `${typeLabel} schema 缺少必填字段：${schema.missing.join('、')}`,
        page: null,
        blockId: null,
      });
      if (classification.confidence >= 0.7) {
        hardRisks.push({
          code: 'schema_incomplete',
          severity: 'warning',
          message: `文档类型判定为${typeLabel}（证据 ${Math.round(
            classification.confidence * 100,
          )}%），但必填字段未全部识别，请补齐后复核`,
          page: null,
          blockId: null,
        });
      }
    }
    if (schema.invalid.length > 0) {
      issues.push({
        code: 'schema_field_invalid',
        severity: 'warning',
        message: `${typeLabel} schema 以下必填字段格式不合法：${schema.invalid.join('、')}`,
        page: null,
        blockId: null,
      });
      hardRisks.push({
        code: 'schema_invalid',
        severity: 'warning',
        message: `${typeLabel}必填字段格式校验失败，不能仅凭高分放行`,
        page: null,
        blockId: null,
      });
    }
    if (schema.conflicts.length > 0) {
      issues.push({
        code: 'schema_conflict',
        severity: 'warning',
        message: `${typeLabel}字段互相矛盾：${schema.conflicts.join('；')}`,
        page: null,
        blockId: null,
      });
      hardRisks.push({
        code: 'schema_conflict',
        severity: 'warning',
        message: `${typeLabel}字段交叉约束失败：${schema.conflicts.join('；')}`,
        page: null,
        blockId: null,
      });
    }
  }

  const office = officeCoverageOf(document);
  if (office) {
    const objects = office.objects ?? 0;
    const unrendered = office.unrendered ?? 0;
    signals.officeCoverage = objects > 0 ? (objects - unrendered) / objects : 1;
    if (unrendered > 0) {
      issues.push({
        code: 'embedded_object_unread',
        severity: 'warning',
        message: `Office 文档有 ${unrendered}/${objects} 个嵌入图片或对象未做识别，其中的文字不会进入检索`,
        page: null,
        blockId: null,
      });
    }
    if ((office.deletedText ?? 0) > 0) {
      issues.push({
        code: 'tracked_changes_excluded',
        severity: 'info',
        message: `已忽略 ${office.deletedText} 个修订删除字符，保留 ${
          office.insertedText ?? 0
        } 个插入字符`,
        page: null,
        blockId: null,
      });
    }
    if ((office.hiddenSlides ?? 0) > 0) {
      issues.push({
        code: 'hidden_content',
        severity: 'warning',
        message: `含 ${office.hiddenSlides} 个隐藏幻灯片/工作表，内容已提取，请确认是否属于当前版本`,
        page: null,
        blockId: null,
      });
    }
  }

  let weighted = 0;
  let weightSum = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    const signal = signals[key];
    if (signal === null || signal === undefined) continue;
    weighted += signal * weight;
    weightSum += weight;
  }
  let score =
    weightSum > 0
      ? weighted / weightSum
      : // No DIR and no confidence means no quality evidence at all. Treat it
        // as unknown and keep it below the pass threshold instead of the old
        // 0.75 default, which sat on the passing side of a 0.7 cut-off.
        extraction.text.trim()
        ? Math.max(0, Math.min(reviewThreshold - 0.01, 0.5))
        : 0;
  if (!extraction.text.trim()) score = 0;
  score = round(clamp(score));

  let status: DocumentQuality['status'];
  if (score >= reviewThreshold) status = 'pass';
  else if (score < failThreshold) status = 'fail';
  else status = 'review';
  if (!extraction.text.trim()) status = 'fail';
  if (weightSum === 0 && extraction.text.trim()) {
    issues.push({
      code: 'confidence_unknown',
      severity: 'warning',
      message: '缺少识别置信度与结构信号，无法评分，按未知质量进入复核',
      page: null,
      blockId: null,
    });
  }
  if (extraction.truncated && status === 'pass') status = 'review';
  if (invalidBlocks.length > 0 && status === 'pass') status = 'review';
  // Hard risks are not compensable: key fields, business checks and image
  // quality force review even when the weighted score is high.
  if (hardRisks.length > 0 && status === 'pass') status = 'review';

  const structureParts = [signals.tableIntegrity, signals.readingOrder, signals.validation].filter(
    (value): value is number => value !== null && value !== undefined,
  );
  const structureConfidence = mean(structureParts);
  const fieldValidation = fieldChecked > 0 ? fieldHit / fieldChecked : null;
  const businessParts = [
    signals.tableIntegrity,
    fieldValidation,
    signals.businessConstraints,
    signals.columnTypes,
  ].filter((value): value is number => value !== null && value !== undefined);
  const businessConsistency = tables.length === 0 ? null : clamp(mean(businessParts) ?? 0);

  return {
    score,
    status,
    calibrated: Boolean(confidenceMap && confidenceMap.length > 0),
    signals,
    issues,
    components: {
      ocrConfidence: confidence,
      structureConfidence,
      fieldValidation,
      businessConsistency,
    },
    hardRisks,
    docType: classification,
  };
}
