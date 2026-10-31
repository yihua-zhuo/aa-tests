import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type {
  DocumentBBox,
  DocumentBlock,
  DocumentFieldAgreement,
  DocumentFieldCandidate,
  DocumentFieldEvidence,
  DocumentFieldKind,
  DocumentIr,
  DocumentQuality,
  DocumentQualityIssue,
  DocumentSource,
  DocumentSpecializedFinding,
  DocumentSpecializedType,
  OcrEngine,
  OcrInkGap,
  OcrMode,
  OcrRecoveryDecision,
  OcrRecoveryTrigger,
  OcrRegionResult,
  OcrStage,
  OcrStageKind,
  OcrStageParams,
  OcrStageQuality,
  OcrStageReplayTarget,
} from '../shared/types.ts';
import { positiveIntEnv } from './db.ts';
import { refineDocumentIr } from './document-ir.ts';
import { log } from './logger.ts';
import type { OcrClient, OcrExtraction, OcrInput } from './ocr.ts';
import { diagnoseQuality } from './ocr-confusions.ts';
import { languageHintOf, profileScript } from './ocr-models.ts';
import {
  isNumericField,
  numericCandidate,
  numericEquivalent,
  type OcrNumericKind,
  sanitizeNumericText,
} from './ocr-numeric.ts';
import {
  assessQuality,
  keyFieldKindOf,
  keyFieldThreshold,
  lowConfidenceThreshold,
  type QualityOptions,
} from './ocr-quality.ts';
import {
  cellBBox,
  cellNeedsRecovery,
  inferTableSchema,
  isTypedCellColumn,
  numericCandidates,
  parseDateValue,
  type TableColumnKind,
  tableRows,
} from './ocr-tables.ts';

const DEFAULT_REGION_CANDIDATES = 4;
const DEFAULT_REGION_PASSES = 2;
const DEFAULT_CELL_CANDIDATES = 4;
const DEFAULT_VLM_REGIONS = 2;
const DEFAULT_SPECIALIZED_REGIONS = 4;
/** At most one cross-engine second opinion; each runs a full document. */
const MAX_ALTERNATE_ENGINES = 1;
const VLM_PADDING = 0.35;
const MAX_REGION_PASSES = 3;
const REGION_PADDING = 0.35;
const REGION_WIDE_PADDING = 0.6;
const REGION_CONFIRM_CONFIDENCE = 0.6;
const REGION_TARGET_CHAR_HEIGHT = 24;
/** Blended scores inside this band are treated as noise, not improvement. */
const QUALITY_SCORE_TOLERANCE = 0.005;

export type OcrCascadeOptions = QualityOptions & {
  /** Total attempts including the initial extraction. */
  maxStages?: number;
  budgetMs?: number;
  signal?: AbortSignal;
  /** Complementary model profiles for high-risk field/cell candidates. */
  fallbackModels?: string[];
  /** Configured engines that can read the same file as whole-page candidates. */
  candidateEngines?: OcrEngine[];
  /** Historical recovery outcomes; scarce samples fall back to the prior. */
  recoveryYields?: RecoveryYields;
};

export type RecoveryYieldStats = { attempts: number; successes: number };
export type RecoveryYields = Partial<Record<OcrStageKind, RecoveryYieldStats>>;

export type OcrCascadeResult = {
  extraction: OcrExtraction;
  quality: DocumentQuality;
  stages: OcrStage[];
};

type Recovery = {
  kind: OcrStageKind;
  mode: OcrMode;
  dpi: number | null;
  trigger: OcrRecoveryTrigger;
  /** Language profile override, used when the declared language disagrees with the text. */
  lang?: string;
  /** Named model profile override for cross-model candidate passes. */
  model?: string;
  /** Alternate engine for a cross-engine whole-page candidate. */
  engine?: OcrEngine;
};
type RecoveryPlan = Recovery & {
  decision: OcrRecoveryDecision;
};

type RegionTarget = {
  page: number;
  block: DocumentBlock;
  kind: NonNullable<ReturnType<typeof keyFieldKindOf>>;
};

type CellTarget = {
  page: number;
  block: DocumentBlock;
  bbox: DocumentBBox;
  bboxEstimated: boolean;
  row: number;
  column: number;
  header: string;
  kind: DocumentFieldKind;
  columnKind: TableColumnKind;
  initial: string;
  /** True when the initial cell value cannot be parsed at all. */
  invalid: boolean;
};

type RegionOutcome = {
  attempted: number;
  failed: number;
  seconds: number;
  evidence: DocumentFieldEvidence[];
  confirmed: number;
  /** Subset of `confirmed` corroborated by a different engine or recognizer. */
  independent: number;
  conflicts: number;
};

type InkGapTarget = { page: number; gap: OcrInkGap };

type InkGapOutcome = {
  attempted: number;
  /** Gaps that produced text and were appended as their own block. */
  recovered: number;
  failed: number;
  seconds: number;
  evidence: DocumentFieldEvidence[];
  /** First crop, recorded on the stage so a replay can re-run it. */
  first: { page: number; bbox: DocumentBBox; padding: number } | null;
  /**
   * Replacement document holding the appended blocks. The caller's extraction is
   * never mutated: earlier stages fingerprinted it, so writing in place would make
   * those records fail their own replay check.
   */
  document: DocumentIr | null;
  /** Text the caller appends to `text` and `rawText`. */
  appendedText: string;
};

type VlmOutcome = {
  attempted: number;
  failed: number;
  seconds: number;
  candidates: number;
  confirmed: number;
  conflicts: number;
  model: string | null;
  trigger: OcrRecoveryTrigger;
  first: { page: number; bbox: DocumentBBox; padding: number } | null;
};

type SpecializedOutcome = {
  attempted: number;
  failed: number;
  seconds: number;
  findings: DocumentSpecializedFinding[];
  models: string[];
};

type RegionPass = { mode: OcrMode; padding: number; dpi: number | null; model?: string };

function isPdf(name: string): boolean {
  return extname(name).toLowerCase() === '.pdf';
}

function issueCodes(issues: readonly DocumentQualityIssue[]): Set<string> {
  return new Set(issues.map((issue) => issue.code));
}

function textHeightOf(extraction: OcrExtraction): number | null {
  const value = extraction.document?.meta.textHeight;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Choose DPI from measured text height instead of a fixed ladder: a 12px line
 * at 200 DPI needs roughly 400 DPI to reach 24px, while already-large text
 * should not be re-rendered.
 */
function adaptiveDpi(baseDpi: number, textHeight: number | null): number | null {
  if (textHeight === null || textHeight >= REGION_TARGET_CHAR_HEIGHT * 0.85) return null;
  const needed = Math.ceil((baseDpi * REGION_TARGET_CHAR_HEIGHT) / textHeight / 50) * 50;
  return Math.min(400, Math.max(baseDpi + 50, needed));
}

const RECOVERY_TARGET_SCORE = 0.85;
const RECOVERY_COST_PENALTY = 0.02;
const LANGUAGE_COMPATIBLE: Record<string, ReadonlySet<string>> = {
  ch: new Set(['ch', 'en']),
  en: new Set(['en']),
  japan: new Set(['japan', 'ch', 'en']),
  korean: new Set(['korean', 'en']),
  arabic: new Set(['arabic', 'en']),
  ru: new Set(['ru', 'en']),
};

/**
 * Compare the router's declared language with the dominant script of the
 * extracted text. A mismatch triggers a rerun with the observed profile;
 * Latin runs are compatible with every recognizer.
 */
export function detectedLanguageMismatch(
  input: Pick<OcrInput, 'lang'>,
  text: string,
): { expected: string; detected: string } | null {
  const expected = languageHintOf(input.lang);
  if (!expected || text.trim().length < 20) return null;
  const profile = profileScript(text);
  if (profile.letters < 10) return null;
  const detected = profile.language;
  if (detected === expected) return null;
  return LANGUAGE_COMPATIBLE[expected]?.has(detected) ? null : { expected, detected };
}

const RECOVERY_YIELD: Record<OcrStageKind, { probability: number; costSeconds: number }> = {
  native: { probability: 0, costSeconds: 0 },
  visual: { probability: 0, costSeconds: 0 },
  recovery_region: { probability: 0.7, costSeconds: 0.6 },
  recovery_cell: { probability: 0.65, costSeconds: 0.8 },
  candidate: { probability: 0.5, costSeconds: 8 },
  recovery_structure: { probability: 0.55, costSeconds: 5 },
  recovery_dpi: { probability: 0.45, costSeconds: 6 },
  recovery_enhance: { probability: 0.5, costSeconds: 3.5 },
  vlm: { probability: 0.4, costSeconds: 10 },
  camelot: { probability: 0, costSeconds: 1 },
  specialized: { probability: 0.45, costSeconds: 4 },
};

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Pseudo-observations keeping the prior influential until real samples accrue. */
const YIELD_PRIOR_STRENGTH = 4;

export function recoveryPrior(kind: OcrStageKind): number {
  return RECOVERY_YIELD[kind].probability;
}

export function recoveryYieldMinSamples(): number {
  return positiveIntEnv('OCR_RECOVERY_YIELD_MIN_SAMPLES', 5);
}

/**
 * Beta-smoothed recovery success probability. With fewer than `minSamples`
 * attempts the hard-coded prior wins, so a couple of lucky documents cannot
 * reorder cascade decisions.
 */
export function smoothedRecoveryYield(
  kind: OcrStageKind,
  stats?: RecoveryYieldStats,
  minSamples = recoveryYieldMinSamples(),
): number {
  const prior = recoveryPrior(kind);
  if (!stats || stats.attempts < minSamples) return prior;
  const attempts = Math.max(0, Math.trunc(stats.attempts));
  const successes = Math.max(0, Math.min(attempts, Math.trunc(stats.successes)));
  const alpha = prior * YIELD_PRIOR_STRENGTH;
  const beta = (1 - prior) * YIELD_PRIOR_STRENGTH;
  return round4((successes + alpha) / (attempts + alpha + beta));
}

/**
 * Summarize which recovery stages actually improved the candidate score.
 * Base extraction, Camelot tables and advisory specialized passes are excluded;
 * they run unconditionally or never replace text.
 */
export function recoveryYieldOutcomes(
  stages: readonly OcrStage[],
): { kind: OcrStageKind; attempts: number; successes: number }[] {
  const outcomes = new Map<OcrStageKind, { attempts: number; successes: number }>();
  let previous = stages[0]?.score ?? null;
  for (const item of stages.slice(1)) {
    if (
      item.kind === 'native' ||
      item.kind === 'visual' ||
      item.kind === 'camelot' ||
      item.kind === 'specialized'
    ) {
      continue;
    }
    const outcome = outcomes.get(item.kind) ?? { attempts: 0, successes: 0 };
    outcome.attempts += 1;
    if (
      item.status === 'done' &&
      item.score !== null &&
      previous !== null &&
      item.score > previous + QUALITY_SCORE_TOLERANCE
    ) {
      outcome.successes += 1;
    }
    outcomes.set(item.kind, outcome);
    if (item.score !== null) previous = item.score;
  }
  return [...outcomes].map(([kind, value]) => ({ kind, ...value }));
}

/**
 * Expected-value gate for a recovery action: estimated score gain times its
 * success probability, minus a small penalty for wall-clock cost. Only a
 * positive value may consume cascade budget; the estimate is persisted with the
 * stage so decisions stay explainable.
 */
function recoveryDecision(
  kind: OcrStageKind,
  quality: DocumentQuality,
  headroomFloor = 0,
  yields?: RecoveryYields,
): OcrRecoveryDecision {
  const yieldOf = RECOVERY_YIELD[kind];
  const probability = smoothedRecoveryYield(kind, yields?.[kind]);
  const headroom = Math.max(
    headroomFloor,
    quality.hardRisks.length > 0 ? 0.15 : 0,
    RECOVERY_TARGET_SCORE - quality.score,
  );
  const expectedGain = round4(headroom * probability);
  const costSeconds = yieldOf.costSeconds;
  const value = round4(expectedGain - (costSeconds / 60) * RECOVERY_COST_PENALTY);
  return { trigger: 'low_confidence', expectedGain, costSeconds, value };
}

function compareSignal(current: number | null, next: number | null): number {
  if (typeof current !== 'number' || typeof next !== 'number') return 0;
  const delta = next - current;
  if (Math.abs(delta) <= 1e-9) return 0;
  return delta > 0 ? 1 : -1;
}

/**
 * Layered candidate preference: hard risks first, then key-field and page
 * coverage, then field validation, table integrity and reading order, and only
 * then the blended score. A rerun with a marginally higher score must not
 * replace a result that lost a key region, a page, or a table structure;
 * near-equal scores are a tie. `'next'` means the new candidate wins.
 */
export function compareQualityLayers(
  current: DocumentQuality,
  next: DocumentQuality,
): 'next' | 'current' | 'tie' {
  if (next.hardRisks.length !== current.hardRisks.length) {
    return next.hardRisks.length < current.hardRisks.length ? 'next' : 'current';
  }
  const layers = ['keyFieldCoverage', 'coverage', 'validation', 'tableIntegrity', 'readingOrder'];
  for (const layer of layers) {
    const preference = compareSignal(current.signals[layer], next.signals[layer]);
    if (preference !== 0) return preference > 0 ? 'next' : 'current';
  }
  if (next.score > current.score + QUALITY_SCORE_TOLERANCE) return 'next';
  if (next.score < current.score - QUALITY_SCORE_TOLERANCE) return 'current';
  return 'tie';
}

function enhanceTrigger(codes: Set<string>): OcrRecoveryTrigger {
  if (codes.has('image_blurry')) return 'local_blur';
  if (codes.has('image_skew') || codes.has('image_orientation')) return 'orientation_uncertain';
  if (
    codes.has('image_exposure') ||
    codes.has('image_low_resolution') ||
    codes.has('image_glare') ||
    codes.has('image_shadow') ||
    codes.has('image_noise')
  ) {
    return 'image_quality';
  }
  if (codes.has('small_text')) return 'small_text';
  return 'low_confidence';
}

function tableTrigger(codes: Set<string>): OcrRecoveryTrigger {
  if (codes.has('cell_type_mismatch')) return 'numeric_confusion';
  if (
    codes.has('field_mismatch') ||
    codes.has('business_constraint') ||
    codes.has('cell_recovery_conflict')
  ) {
    return 'field_validation';
  }
  return 'table_structure';
}

function planRecoveries(
  extraction: OcrExtraction,
  quality: DocumentQuality,
  input: OcrInput,
  engine: OcrEngine,
  models?: readonly string[],
  engines?: readonly OcrEngine[],
  yields?: RecoveryYields,
): RecoveryPlan[] {
  // Native-only extraction is deterministic and already used every text layer;
  // retrying it with another mode/DPI would return the same result.
  if (engine !== 'paddle' || extraction.truncated || extraction.route === 'native') return [];
  const codes = issueCodes(quality.issues);
  const tableIssue =
    codes.has('table_integrity') ||
    codes.has('field_mismatch') ||
    codes.has('cell_type_mismatch') ||
    codes.has('business_constraint') ||
    codes.has('cell_recovery_conflict') ||
    codes.has('table_structure_risk');
  // Key fields are handled by region re-recognition, not a whole-page rerun.
  const weakText =
    codes.has('low_confidence') || codes.has('low_coverage') || codes.has('empty_page');
  const imageIssue =
    codes.has('image_blurry') ||
    codes.has('image_exposure') ||
    codes.has('image_low_resolution') ||
    codes.has('image_glare') ||
    codes.has('image_shadow') ||
    codes.has('image_noise') ||
    codes.has('image_skew') ||
    codes.has('image_orientation') ||
    quality.hardRisks.some((risk) => risk.code === 'image_retake');
  const smallText = codes.has('small_text');
  const detectionIssue = codes.has('reading_order') || codes.has('block_validation');
  const baseMode = input.mode ?? 'auto';
  const baseDpi = input.dpi ?? 200;
  const adaptive = adaptiveDpi(baseDpi, textHeightOf(extraction));
  const mismatch = detectedLanguageMismatch(input, extraction.text);
  const plans: Recovery[] = [];

  if (mismatch) {
    // The declared profile does not match the observed script: rerun the same
    // mode with the detected language before spending on DPI or structure.
    plans.push({
      kind: 'recovery_enhance',
      mode: baseMode,
      dpi: null,
      trigger: 'language_mismatch',
      lang: mismatch.detected,
    });
  }

  if (isPdf(input.name)) {
    if (tableIssue) {
      plans.push({
        kind: 'recovery_structure',
        mode: 'structure',
        dpi: Math.max(baseDpi, adaptive ?? 300),
        trigger: tableTrigger(codes),
      });
    }
    if (detectionIssue && !tableIssue) {
      plans.push({
        kind: 'recovery_structure',
        mode: 'structure',
        dpi: Math.max(baseDpi, adaptive ?? 300),
        trigger: 'detection_anomaly',
      });
    }
    const targetDpi = adaptive ?? (baseDpi < 300 ? 300 : baseDpi < 400 ? 400 : null);
    if (targetDpi !== null && targetDpi > baseDpi) {
      plans.push({
        kind: 'recovery_dpi',
        mode: baseMode,
        dpi: targetDpi,
        trigger: adaptive ? 'small_text' : weakText ? 'low_confidence' : 'image_quality',
      });
    }
    if (!tableIssue && weakText && baseMode !== 'structure') {
      plans.push({
        kind: 'recovery_structure',
        mode: 'structure',
        dpi: Math.max(baseDpi, targetDpi ?? 300),
        trigger:
          codes.has('low_coverage') || codes.has('empty_page') ? 'low_coverage' : 'low_confidence',
      });
    }
    if ((imageIssue || smallText) && baseMode !== 'enhanced') {
      plans.push({
        kind: 'recovery_enhance',
        mode: 'enhanced',
        dpi: baseDpi,
        trigger: enhanceTrigger(codes),
      });
    }
  } else {
    const structureFirst = tableIssue && diagnoseQuality([...codes]).stage === 'segmentation';
    if (structureFirst && baseMode !== 'structure') {
      plans.push({
        kind: 'recovery_structure',
        mode: 'structure',
        dpi: null,
        trigger: tableTrigger(codes),
      });
    }
    if (baseMode !== 'enhanced') {
      plans.push({
        kind: 'recovery_enhance',
        mode: 'enhanced',
        dpi: null,
        trigger: enhanceTrigger(codes),
      });
    }
    if (tableIssue && !structureFirst && baseMode !== 'structure') {
      plans.push({
        kind: 'recovery_structure',
        mode: 'structure',
        dpi: null,
        trigger: tableTrigger(codes),
      });
    }
  }

  // A second model profile is a whole-page candidate: it costs more than local
  // recovery, so it runs last and only replaces the text when the blended score
  // strictly improves (the same rule as other recovery passes).
  const candidates = (models ?? [])
    .filter((model, index, all) => Boolean(model) && all.indexOf(model) === index)
    .slice(0, MAX_ALTERNATE_MODELS);
  for (const model of candidates) {
    plans.push({
      kind: 'candidate',
      mode: baseMode,
      dpi: null,
      trigger: 'low_confidence',
      model,
    });
  }

  // A configured second engine is the strongest independent check: it shares no
  // model lineage with the primary result, so it runs after model candidates and
  // must still win on the layered score before its text replaces the best one.
  const alternateEngines = (engines ?? [])
    .filter((candidate, index, all) => candidate !== engine && all.indexOf(candidate) === index)
    .slice(0, MAX_ALTERNATE_ENGINES);
  for (const candidate of alternateEngines) {
    plans.push({
      kind: 'candidate',
      // Mode names are engine-specific, so an alternate engine always runs auto.
      mode: 'auto',
      dpi: null,
      trigger: 'low_confidence',
      engine: candidate,
    });
  }

  const seen = new Set<string>();
  const decisions: RecoveryPlan[] = [];
  for (const plan of plans) {
    // Two recovery kinds can converge on the same request (e.g. structure mode
    // with a DPI bump); run the underlying call only once.
    const key = `${plan.engine ?? engine}:${plan.mode}:${plan.dpi ?? ''}:${plan.lang ?? ''}:${plan.model ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sameLanguage = !plan.lang || plan.lang === input.lang;
    const sameModel = (plan.model ?? null) === (input.model ?? null);
    const sameEngine = (plan.engine ?? engine) === engine;
    if (
      plan.mode === baseMode &&
      (plan.dpi === null || plan.dpi === baseDpi) &&
      sameLanguage &&
      sameModel &&
      sameEngine
    ) {
      continue;
    }
    const decision = recoveryDecision(
      plan.kind,
      quality,
      plan.trigger === 'language_mismatch' ? 0.2 : 0,
      yields,
    );
    if (decision.value <= 0) continue;
    decisions.push({ ...plan, decision: { ...decision, trigger: plan.trigger } });
  }
  return decisions;
}

function evidenceKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}%]+/gu, '');
}

function evidenceAgrees(original: string, candidate: string): boolean {
  if (!original || !candidate) return false;
  if (original === candidate) return true;
  if (Math.min(original.length, candidate.length) < 4) return false;
  return original.includes(candidate) || candidate.includes(original);
}

/**
 * Independence of a recheck candidate. The same recognizer re-run at another
 * padding or DPI reproduces its own systematic errors, so corroboration only
 * counts as independent when a different engine, a different model, or a
 * different architecture (VLM / specialized reader) produced it.
 */
function isIndependentEvidence(
  initial: DocumentSource,
  candidate: DocumentFieldCandidate,
): boolean {
  if (candidate.source !== 'region') return true;
  if (candidate.engine && candidate.engine !== initial.engine) return true;
  const model = candidate.model;
  return model !== null && model !== undefined && model !== initial.model;
}

/**
 * Agreement over all successful candidates, labelled by how independent the
 * corroborating evidence is. A confident disagreement is a conflict; a
 * low-confidence disagreement stays unverified so the key-field risk remains.
 */
function agreementOf(
  initial: DocumentSource,
  candidates: DocumentFieldCandidate[],
): DocumentFieldAgreement {
  const allAgree = candidates.every((candidate) => candidate.agreesWithInitial === true);
  if (!allAgree) {
    const confidentConflict = candidates.some(
      (candidate) =>
        candidate.agreesWithInitial === false &&
        (candidate.confidence === null || candidate.confidence >= REGION_CONFIRM_CONFIDENCE),
    );
    return confidentConflict ? 'conflict' : 'unverified';
  }
  return candidates.some((candidate) => isIndependentEvidence(initial, candidate))
    ? 'confirmed_independent'
    : 'confirmed_same_engine';
}

/** Both confirmation levels keep the original text; only independent ones lower risk. */
function isConfirmedAgreement(agreement: DocumentFieldAgreement): boolean {
  return agreement === 'confirmed_independent' || agreement === 'confirmed_same_engine';
}

/** Character-bag overlap reported for whole-page candidate passes. */
function textAgreement(left: string, right: string): number {
  const a = left.toLowerCase().replace(/\s+/g, '');
  const b = right.toLowerCase().replace(/\s+/g, '');
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const counts = new Map<string, number>();
  for (const char of a) counts.set(char, (counts.get(char) ?? 0) + 1);
  let shared = 0;
  for (const char of b) {
    const available = counts.get(char) ?? 0;
    if (available === 0) continue;
    shared += 1;
    counts.set(char, available - 1);
  }
  return shared / Math.max(a.length, b.length);
}

/**
 * Bbox coordinate space for a target. Visual blocks are in render pixels at
 * `input.dpi`; blocks merged into a native PDF page keep PDF points and carry
 * their own DPI in `meta.bboxDpi`.
 */
function blockBboxDpi(block: DocumentBlock | undefined, input: OcrInput): number | undefined {
  const raw = block?.meta?.bboxDpi;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  const stage = block?.source?.stage;
  const engine = block?.source?.engine;
  if (stage === 'native' || engine === 'pdfplumber' || engine === 'docling') return 72;
  return input.dpi ?? undefined;
}

/**
 * A second opinion on disagreement widens the crop and enables enhancement;
 * a third pass also raises render DPI for small text. Passes are capped so a
 * single ambiguous field cannot consume the whole cascade budget.
 */
function regionPasses(input: OcrInput, count: number): RegionPass[] {
  const dpi = input.dpi ?? null;
  const plans: RegionPass[] = [
    { mode: 'auto', padding: REGION_PADDING, dpi },
    { mode: 'enhanced', padding: REGION_WIDE_PADDING, dpi },
    {
      mode: 'enhanced',
      padding: REGION_WIDE_PADDING,
      dpi: dpi === null ? null : Math.min(400, dpi + 100),
    },
  ];
  const seen = new Set<string>();
  return plans.slice(0, Math.max(1, Math.min(MAX_REGION_PASSES, count))).filter((plan) => {
    const key = `${plan.mode}:${plan.padding}:${plan.dpi ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Complementary recognizers for high-risk fields and typed cells only. They
 * run after the normal passes fail to corroborate, so ordinary paragraphs keep
 * the fast path.
 */
const MAX_ALTERNATE_MODELS = 2;
function alternatePasses(input: OcrInput, models: readonly string[] | undefined): RegionPass[] {
  return (models ?? [])
    .filter((model, index, all) => model && all.indexOf(model) === index)
    .slice(0, MAX_ALTERNATE_MODELS)
    .map((model) => ({
      mode: 'auto' as OcrMode,
      padding: REGION_PADDING,
      dpi: input.dpi ?? null,
      model,
    }));
}

function regionTargets(
  extraction: OcrExtraction,
  keyThreshold: number,
  genericThreshold: number,
  limit: number,
): RegionTarget[] {
  const document = extraction.document;
  if (!document) return [];
  const targets: RegionTarget[] = [];
  for (const page of document.pages) {
    for (const block of page.blocks) {
      if (!block.bbox || block.type === 'table' || block.source.stage === 'native') continue;
      // Same-engine corroboration is recorded but not sufficient, so those
      // blocks stay out of the queue too: another local pass cannot make them
      // independent. Only VLM or a cross-engine run can.
      if (
        block.meta?.regionAgreement === 'confirmed_independent' ||
        block.meta?.regionAgreement === 'confirmed_same_engine'
      ) {
        continue;
      }
      const keyKind = keyFieldKindOf(block);
      // Line-level retry for ordinary low-confidence text, not only business fields.
      const generic = !keyKind && block.type === 'paragraph' && block.text.trim().length <= 200;
      if (!keyKind && !generic) continue;
      const confidence = block.confidence;
      if (confidence !== null && confidence >= (keyKind ? keyThreshold : genericThreshold)) {
        continue;
      }
      targets.push({ page: page.number, block, kind: keyKind ?? 'text' });
    }
  }
  targets.sort(
    (left, right) =>
      Number(left.kind === 'text') - Number(right.kind === 'text') ||
      (left.block.confidence ?? 0) - (right.block.confidence ?? 0),
  );
  return targets.slice(0, Math.max(0, limit));
}

function cellFieldKind(kind: TableColumnKind): DocumentFieldKind | null {
  switch (kind) {
    case 'amount':
      return 'amount';
    case 'date':
      return 'date';
    case 'quantity':
      return 'quantity';
    case 'percentage':
      return 'percentage';
    case 'number':
      return 'number';
    default:
      return null;
  }
}

function cellTargets(
  extraction: OcrExtraction,
  limit: number,
  confidenceThreshold: number,
): CellTarget[] {
  const document = extraction.document;
  if (!document) return [];
  const targets: CellTarget[] = [];
  for (const page of document.pages) {
    for (const block of page.blocks) {
      if (block.type !== 'table' || block.source.stage === 'native') continue;
      const schema = inferTableSchema(block);
      if (!schema) continue;
      const lowConfidence = block.confidence !== null && block.confidence < confidenceThreshold;
      const rows = tableRows(block);
      for (let row = schema.headerRows; row < rows.length; row += 1) {
        for (const column of schema.columns) {
          if (!isTypedCellColumn(column)) continue;
          const initial = (rows[row]?.[column.index] ?? '').trim();
          if (!initial) continue;
          const invalid = cellNeedsRecovery(column.kind, initial);
          if (!invalid && !lowConfidence) continue;
          const box = cellBBox(block, rows, row, column.index);
          if (!box) continue;
          const kind = cellFieldKind(column.kind);
          if (!kind) continue;
          targets.push({
            page: page.number,
            block,
            bbox: box.bbox,
            bboxEstimated: box.estimated,
            row,
            column: column.index,
            header: column.label,
            kind,
            columnKind: column.kind,
            initial,
            invalid,
          });
        }
      }
    }
  }
  targets.sort((left, right) => Number(right.invalid) - Number(left.invalid));
  return targets.slice(0, Math.max(0, limit));
}

function cellNumericKind(kind: TableColumnKind): OcrNumericKind | null {
  switch (kind) {
    case 'amount':
    case 'date':
    case 'quantity':
    case 'percentage':
    case 'number':
    case 'identifier':
      return kind;
    default:
      return null;
  }
}

function cellAgrees(kind: TableColumnKind, original: string, candidate: string): boolean {
  if (original === candidate) return true;
  if (kind === 'date') {
    const left = parseDateValue(original);
    const right = parseDateValue(candidate);
    if (left && right) {
      return left.year === right.year && left.month === right.month && left.day === right.day;
    }
  }
  if (kind !== 'text' && kind !== 'currency') {
    const numericKind = cellNumericKind(kind);
    if (numericKind) {
      // Confusable repair happens only inside the comparison; text stays raw.
      const left = numericCandidates(sanitizeNumericText(original, numericKind), kind);
      const right = numericCandidates(sanitizeNumericText(candidate, numericKind), kind);
      if (left.length > 0 && right.length > 0) {
        return left.some((a) => right.some((b) => Math.abs(a.value - b.value) < 1e-9));
      }
      if (numericEquivalent(numericKind, original, candidate)) return true;
    }
  }
  return evidenceAgrees(evidenceKey(original), evidenceKey(candidate));
}

const SPECIALIZED_TYPES = new Set<DocumentSpecializedType>([
  'chart',
  'handwriting',
  'stamp',
  'signature',
]);

function specializedTypeOf(block: DocumentBlock): DocumentSpecializedType | null {
  const metaType = block.meta?.regionType;
  if (typeof metaType === 'string' && SPECIALIZED_TYPES.has(metaType as DocumentSpecializedType)) {
    return metaType as DocumentSpecializedType;
  }
  return SPECIALIZED_TYPES.has(block.type as DocumentSpecializedType)
    ? (block.type as DocumentSpecializedType)
    : null;
}

function findBlock(
  document: NonNullable<OcrExtraction['document']>,
  page: number,
  id: string,
): DocumentBlock | null {
  const target = document.pages.find((item) => item.number === page);
  return target?.blocks.find((block) => block.id === id) ?? null;
}

/** Recompute agreement after an advisory candidate joined the evidence. */
function applyAgreement(
  evidence: DocumentFieldEvidence,
  document: NonNullable<OcrExtraction['document']>,
): void {
  const agreement = agreementOf(evidence.source, evidence.candidates);
  evidence.agreement = agreement;
  evidence.reason =
    agreement === 'confirmed_independent' || agreement === 'confirmed_same_engine'
      ? 'initial_confirmed'
      : agreement === 'conflict'
        ? 'candidate_conflict'
        : 'unverified';
  const block = findBlock(document, evidence.page, evidence.blockId);
  if (block && agreement !== 'unverified') {
    block.meta = { ...(block.meta ?? {}), regionAgreement: agreement };
  }
}

/** Keep advisory specialized findings when a whole-page rerun becomes the best extraction. */
function mergeAdvisoryFindings(target: OcrExtraction, source: OcrExtraction): void {
  const findings = source.document?.meta.specialized;
  if (!Array.isArray(findings) || !target.document) return;
  const existing = Array.isArray(target.document.meta.specialized)
    ? (target.document.meta.specialized as DocumentSpecializedFinding[]).filter(
        (item) => typeof item === 'object' && item !== null,
      )
    : [];
  const seen = new Set(existing.map((item) => `${item.page}:${item.type}:${item.blockId}`));
  const merged = [...existing];
  for (const finding of findings) {
    if (typeof finding !== 'object' || finding === null) continue;
    const item = finding as DocumentSpecializedFinding;
    const key = `${item.page}:${item.type}:${item.blockId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  if (merged.length > existing.length) target.document.meta.specialized = merged;
}

function isFieldEvidence(value: unknown): value is DocumentFieldEvidence {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<DocumentFieldEvidence>;
  return (
    typeof item.blockId === 'string' &&
    typeof item.page === 'number' &&
    typeof item.text === 'string' &&
    Array.isArray(item.candidates)
  );
}

/**
 * Optional chart/handwriting/stamp/signature recognition. Findings are advisory
 * board evidence stored under `meta.specialized`; stored OCR text is untouched.
 */
async function runSpecializedRecognition(
  client: OcrClient,
  input: OcrInput,
  extraction: OcrExtraction,
  options: OcrCascadeOptions,
  startedAll: number,
  budgetMs: number,
): Promise<SpecializedOutcome | null> {
  if (!client.specializedConfigured) return null;
  const document = extraction.document;
  if (!document) return null;
  const limit = positiveIntEnv('OCR_SPECIALIZED_MAX_REGIONS', DEFAULT_SPECIALIZED_REGIONS);
  const existing = Array.isArray(document.meta.specialized)
    ? (document.meta.specialized as DocumentSpecializedFinding[]).filter(
        (item) => typeof item === 'object' && item !== null,
      )
    : [];
  const seen = new Set(existing.map((item) => `${item.page}:${item.type}:${item.blockId}`));
  const targets: Array<{
    page: number;
    block: DocumentBlock;
    bbox: DocumentBBox;
    type: DocumentSpecializedType;
  }> = [];
  for (const page of document.pages) {
    if (targets.length >= limit) break;
    for (const block of page.blocks) {
      if (targets.length >= limit) break;
      if (!block.bbox) continue;
      const type = specializedTypeOf(block);
      if (!type) continue;
      const key = `${page.number}:${type}:${block.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ page: page.number, block, bbox: block.bbox, type });
    }
  }
  if (targets.length === 0) return null;

  const begin = Date.now();
  const found: DocumentSpecializedFinding[] = [];
  const models = new Set<string>();
  let attempted = 0;
  let failed = 0;
  for (const target of targets) {
    if (Date.now() - startedAll >= budgetMs) break;
    if (options.signal?.aborted) throw new Error('OCR 已取消');
    attempted += 1;
    try {
      const result = await client.recognizeSpecial(
        {
          path: input.path,
          name: input.name,
          page: target.page,
          bbox: target.bbox,
          type: target.type,
        },
        options.signal,
      );
      const text = result.text.trim();
      if (!text) {
        failed += 1;
        continue;
      }
      found.push({
        type: target.type,
        page: target.page,
        blockId: target.block.id,
        bbox: target.bbox,
        text: result.text,
        confidence: result.confidence,
        model: result.model,
        seconds: result.seconds,
      });
      if (result.model) models.add(result.model);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      failed += 1;
      const message = error instanceof Error ? error.message.slice(0, 200) : String(error);
      log('warn', 'ocr.specialized_failed', {
        name: input.name,
        page: target.page,
        blockId: target.block.id,
        type: target.type,
        message,
      });
    }
  }
  if (found.length > 0) {
    document.meta.specialized = [...existing, ...found];
  }
  return {
    attempted,
    failed,
    seconds: Math.max(0.1, Math.round((Date.now() - begin) / 100) / 10),
    findings: found,
    models: [...models],
  };
}

/**
 * Optional VLM repair for regions that local recovery could not confirm. The
 * result joins the field evidence as another candidate; the cascade never
 * replaces the stored text with it.
 */
async function runVlmRecovery(
  client: OcrClient,
  input: OcrInput,
  extraction: OcrExtraction,
  options: OcrCascadeOptions,
  startedAll: number,
  budgetMs: number,
): Promise<VlmOutcome | null> {
  if (!client.vlmConfigured) return null;
  const document = extraction.document;
  if (!document) return null;
  const raw = document.meta.fieldEvidence;
  const evidence = Array.isArray(raw) ? raw.filter(isFieldEvidence) : [];
  const limit = positiveIntEnv('OCR_VLM_MAX_REGIONS', DEFAULT_VLM_REGIONS);
  const targets = evidence
    .filter(
      (item) => item.agreement !== 'confirmed_independent' && item.bbox && item.text.trim() !== '',
    )
    .slice(0, limit);
  if (targets.length === 0) return null;

  const begin = Date.now();
  const trigger: OcrRecoveryTrigger = targets.some((item) => item.kind !== 'text')
    ? 'key_field'
    : 'low_confidence';
  let attempted = 0;
  let failed = 0;
  let candidates = 0;
  let confirmed = 0;
  let conflicts = 0;
  let model: string | null = null;
  let first: VlmOutcome['first'] = null;
  for (const target of targets) {
    if (Date.now() - startedAll >= budgetMs) break;
    if (options.signal?.aborted) throw new Error('OCR 已取消');
    if (!target.bbox) continue;
    attempted += 1;
    try {
      const result = await client.repairRegion(
        {
          path: input.path,
          name: input.name,
          page: target.page,
          bbox: target.bbox,
          kind: target.kind,
          context: target.text,
          padding: VLM_PADDING,
        },
        options.signal,
      );
      const text = result.text.trim();
      if (!text) {
        failed += 1;
        continue;
      }
      if (!first) first = { page: target.page, bbox: target.bbox, padding: VLM_PADDING };
      if (result.model) model = result.model;
      const agrees = evidenceAgrees(evidenceKey(target.text), evidenceKey(text));
      const numeric = isNumericField(target.kind) ? numericCandidate(text, target.kind) : null;
      target.candidates.push({
        text: result.text,
        confidence: result.confidence,
        model: result.model,
        source: 'vlm',
        bbox: target.bbox,
        agreesWithInitial: agrees,
        numeric: numeric ? { canonical: numeric.canonical, valid: numeric.valid } : null,
      });
      candidates += 1;
      applyAgreement(target, document);
      if (isConfirmedAgreement(target.agreement)) confirmed += 1;
      if (target.agreement === 'conflict') conflicts += 1;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      failed += 1;
      const message = error instanceof Error ? error.message.slice(0, 200) : String(error);
      log('warn', 'ocr.vlm_failed', {
        name: input.name,
        page: target.page,
        blockId: target.blockId,
        message,
      });
    }
  }
  return {
    attempted,
    failed,
    seconds: Math.max(0.1, Math.round((Date.now() - begin) / 100) / 10),
    candidates,
    confirmed,
    conflicts,
    model,
    trigger,
    first,
  };
}

/** Bounded region re-recognition; candidates are evidence and never rewrite text. */
async function runRegionRecovery(
  client: OcrClient,
  engine: OcrEngine,
  input: OcrInput,
  extraction: OcrExtraction,
  options: OcrCascadeOptions,
  startedAll: number,
  budgetMs: number,
): Promise<RegionOutcome | null> {
  if (typeof client.extractRegion !== 'function') return null;
  const keyThreshold = keyFieldThreshold(options);
  const genericThreshold = lowConfidenceThreshold(options);
  const limit = positiveIntEnv('OCR_REGION_MAX_CANDIDATES', DEFAULT_REGION_CANDIDATES);
  const passCount = positiveIntEnv('OCR_REGION_PASSES', DEFAULT_REGION_PASSES);
  const passes = regionPasses(input, passCount);
  const alternates = alternatePasses(input, options.fallbackModels);
  const targets = regionTargets(extraction, keyThreshold, genericThreshold, limit);
  if (targets.length === 0) return null;

  const document = extraction.document;
  if (!document) return null;
  const evidence: DocumentFieldEvidence[] = [];
  let attempted = 0;
  let failed = 0;
  let confirmed = 0;
  let independent = 0;
  let conflicts = 0;
  const begin = Date.now();
  for (const target of targets) {
    if (Date.now() - startedAll >= budgetMs) break;
    if (options.signal?.aborted) throw new Error('OCR 已取消');
    attempted += 1;
    const original = evidenceKey(target.block.text);
    const candidates: DocumentFieldCandidate[] = [];
    const failures: string[] = [];
    // Ordinary lines only get the cheap passes; business fields may compare a
    // second recognizer when the first passes disagree with the initial OCR.
    const passesForTarget = target.kind === 'text' ? passes : [...passes, ...alternates];
    let passesRun = 0;
    for (const pass of passesForTarget) {
      if (Date.now() - startedAll >= budgetMs) break;
      if (options.signal?.aborted) throw new Error('OCR 已取消');
      passesRun += 1;
      try {
        const result = await client.extractRegion(
          engine,
          {
            path: input.path,
            name: input.name,
            page: target.page,
            bbox: target.block.bbox as NonNullable<DocumentBlock['bbox']>,
            dpi: pass.dpi ?? undefined,
            bboxDpi: blockBboxDpi(target.block, input),
            mode: pass.mode,
            lang: input.lang,
            model: pass.model ?? input.model,
            padding: pass.padding,
          },
          options.signal,
        );
        const text = result.text.trim();
        if (!text) {
          failures.push(`第 ${passesRun} 次未返回文本`);
          continue;
        }
        const agrees =
          evidenceAgrees(original, evidenceKey(text)) ||
          (isNumericField(target.kind) && numericEquivalent(target.kind, target.block.text, text));
        const numeric = isNumericField(target.kind) ? numericCandidate(text, target.kind) : null;
        const candidate: DocumentFieldCandidate = {
          text: result.text,
          confidence: result.confidence,
          model: result.model,
          engine: result.engine,
          source: 'region',
          bbox: target.block.bbox,
          pass: passesRun,
          mode: pass.mode,
          dpi: pass.dpi,
          padding: pass.padding,
          agreesWithInitial: agrees,
          numeric: numeric ? { canonical: numeric.canonical, valid: numeric.valid } : null,
        };
        candidates.push(candidate);
        // A first-pass match is enough corroboration for an ordinary line. A
        // business field keeps going until a different recognizer agrees,
        // because same-model agreement proves only repeatability.
        if (
          agrees &&
          (target.kind === 'text' ||
            alternates.length === 0 ||
            isIndependentEvidence(target.block.source, candidate))
        ) {
          break;
        }
      } catch (error) {
        if (options.signal?.aborted) throw error;
        failed += 1;
        const message = error instanceof Error ? error.message.slice(0, 200) : String(error);
        failures.push(`第 ${passesRun} 次: ${message}`);
        log('warn', 'ocr.region_failed', {
          engine,
          name: input.name,
          page: target.page,
          blockId: target.block.id,
          pass: passesRun,
          message,
        });
      }
    }
    if (candidates.length === 0) {
      continue;
    }
    const agreement = agreementOf(target.block.source, candidates);
    const confirmedNow = isConfirmedAgreement(agreement);
    if (confirmedNow) confirmed += 1;
    if (agreement === 'conflict') conflicts += 1;
    if (agreement === 'confirmed_independent') independent += 1;
    if (agreement !== 'unverified') {
      target.block.meta = { ...(target.block.meta ?? {}), regionAgreement: agreement };
    }
    evidence.push({
      kind: target.kind,
      page: target.page,
      blockId: target.block.id,
      bbox: target.block.bbox,
      text: target.block.text,
      confidence: target.block.confidence,
      source: target.block.source,
      candidates,
      selected: confirmedNow ? 'initial' : null,
      agreement,
      passes: passesRun,
      failed: failures,
    });
  }
  if (evidence.length > 0) {
    const existing = Array.isArray(document.meta.fieldEvidence)
      ? (document.meta.fieldEvidence as DocumentFieldEvidence[])
      : [];
    document.meta.fieldEvidence = [...existing, ...evidence];
  }
  return {
    attempted,
    failed,
    seconds: Math.max(0.1, Math.round((Date.now() - begin) / 100) / 10),
    evidence,
    confirmed,
    independent,
    conflicts,
  };
}

/** Bounded cell re-recognition; the original cell text is always preserved. */
async function runCellRecovery(
  client: OcrClient,
  engine: OcrEngine,
  input: OcrInput,
  extraction: OcrExtraction,
  options: OcrCascadeOptions,
  startedAll: number,
  budgetMs: number,
): Promise<RegionOutcome | null> {
  if (typeof client.extractRegion !== 'function') return null;
  const document = extraction.document;
  if (!document) return null;
  const limit = positiveIntEnv('OCR_CELL_MAX_CANDIDATES', DEFAULT_CELL_CANDIDATES);
  const passCount = positiveIntEnv('OCR_CELL_PASSES', DEFAULT_REGION_PASSES);
  const passes = regionPasses(input, passCount);
  const alternates = alternatePasses(input, options.fallbackModels);
  const threshold = keyFieldThreshold(options);
  const targets = cellTargets(extraction, limit, threshold);
  if (targets.length === 0) return null;

  const evidence: DocumentFieldEvidence[] = [];
  let attempted = 0;
  let failed = 0;
  let confirmed = 0;
  let independent = 0;
  let conflicts = 0;
  const begin = Date.now();
  for (const target of targets) {
    if (Date.now() - startedAll >= budgetMs) break;
    if (options.signal?.aborted) throw new Error('OCR 已取消');
    attempted += 1;
    const candidates: DocumentFieldCandidate[] = [];
    const failures: string[] = [];
    // Typed cells are high-risk by definition, so alternatives participate.
    const passesForTarget = [...passes, ...alternates];
    let passesRun = 0;
    for (const pass of passesForTarget) {
      if (Date.now() - startedAll >= budgetMs) break;
      if (options.signal?.aborted) throw new Error('OCR 已取消');
      passesRun += 1;
      try {
        const result = await client.extractRegion(
          engine,
          {
            path: input.path,
            name: input.name,
            page: target.page,
            bbox: target.bbox,
            dpi: pass.dpi ?? undefined,
            bboxDpi: blockBboxDpi(target.block, input),
            mode: pass.mode,
            lang: input.lang,
            model: pass.model ?? input.model,
            padding: pass.padding,
          },
          options.signal,
        );
        const text = result.text.trim();
        if (!text) {
          failures.push(`第 ${passesRun} 次未返回文本`);
          continue;
        }
        const agrees = cellAgrees(target.columnKind, target.initial, text);
        const numericKind = cellNumericKind(target.columnKind);
        const numeric = numericKind ? numericCandidate(text, numericKind) : null;
        const candidate: DocumentFieldCandidate = {
          text: result.text,
          confidence: result.confidence,
          model: result.model,
          engine: result.engine,
          source: 'region',
          bbox: target.bbox,
          pass: passesRun,
          mode: pass.mode,
          dpi: pass.dpi,
          padding: pass.padding,
          agreesWithInitial: agrees,
          numeric: numeric ? { canonical: numeric.canonical, valid: numeric.valid } : null,
        };
        candidates.push(candidate);
        // Stop once an alternative recognizer has corroborated the cell; a
        // same-model pass only shows the crop is repeatable.
        if (
          agrees &&
          (alternates.length === 0 || isIndependentEvidence(target.block.source, candidate))
        )
          break;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        failed += 1;
        const message = error instanceof Error ? error.message.slice(0, 200) : String(error);
        failures.push(`第 ${passesRun} 次: ${message}`);
        log('warn', 'ocr.cell_failed', {
          engine,
          name: input.name,
          page: target.page,
          blockId: target.block.id,
          row: target.row,
          column: target.column,
          pass: passesRun,
          message,
        });
      }
    }
    if (candidates.length === 0) continue;
    const agreement = agreementOf(target.block.source, candidates);
    if (isConfirmedAgreement(agreement)) confirmed += 1;
    if (agreement === 'conflict') conflicts += 1;
    if (agreement === 'confirmed_independent') independent += 1;
    const firstText = candidates[0]?.text ?? '';
    const consensus = candidates.every((candidate) =>
      cellAgrees(target.columnKind, firstText, candidate.text),
    );
    const confidentCandidate = candidates.some(
      (candidate) =>
        candidate.confidence === null || candidate.confidence >= REGION_CONFIRM_CONFIDENCE,
    );
    const selected = isConfirmedAgreement(agreement)
      ? 'initial'
      : target.invalid && consensus && confidentCandidate
        ? 'candidate'
        : null;
    evidence.push({
      kind: target.kind,
      page: target.page,
      blockId: target.block.id,
      bbox: target.bbox,
      text: target.initial,
      confidence: null,
      source: target.block.source,
      candidates,
      selected,
      agreement,
      passes: passesRun,
      failed: failures,
      cell: {
        row: target.row,
        column: target.column,
        header: target.header,
        bboxEstimated: target.bboxEstimated,
      },
      reason:
        selected === 'initial'
          ? 'initial_confirmed'
          : selected === 'candidate'
            ? 'candidate_selected'
            : agreement === 'conflict'
              ? 'candidate_conflict'
              : 'unverified',
    });
  }
  if (evidence.length > 0) {
    const existing = Array.isArray(document.meta.fieldEvidence)
      ? (document.meta.fieldEvidence as DocumentFieldEvidence[])
      : [];
    document.meta.fieldEvidence = [...existing, ...evidence];
  }
  return {
    attempted,
    failed,
    seconds: Math.max(0.1, Math.round((Date.now() - begin) / 100) / 10),
    evidence,
    confirmed,
    independent,
    conflicts,
  };
}

const DEFAULT_INK_REGIONS = 3;
/** Two characters is the shortest crop worth appending as a block. */
const MIN_INK_GAP_CHARS = 2;

/**
 * Ink no recognition box covers. A confident page can still be missing a whole
 * line, so pending gaps keep the cascade alive even at pass score; this is the
 * one miss signal that does not ask the model to doubt itself.
 */
function pendingInkGaps(extraction: OcrExtraction): boolean {
  return extraction.document?.pages.some((page) => (page.meta?.inkGaps?.length ?? 0) > 0) ?? false;
}

/**
 * Re-recognize the ink no box covered (review #60). Recovered text is appended
 * as its own flagged block and never rewrites existing blocks; a gap that still
 * yields nothing stays in `meta.inkGaps` so the quality issue survives, and so
 * does a recovered table cell because the cell itself is still empty.
 */
async function runInkGapRecovery(
  client: OcrClient,
  engine: OcrEngine,
  input: OcrInput,
  extraction: OcrExtraction,
  options: OcrCascadeOptions,
  startedAll: number,
  budgetMs: number,
): Promise<InkGapOutcome | null> {
  if (typeof client.extractRegion !== 'function') return null;
  const source = extraction.document;
  if (!source) return null;
  const limit = positiveIntEnv('OCR_INK_MAX_REGIONS', DEFAULT_INK_REGIONS);
  const targets: InkGapTarget[] = [];
  for (const page of source.pages) {
    for (const gap of page.meta?.inkGaps ?? []) targets.push({ page: page.number, gap });
  }
  if (targets.length === 0) return null;
  // Biggest unexplained regions first: one missed paragraph is worth more than
  // a stray mark, and the budget is shared with the rest of the cascade.
  const selected = targets
    .sort((left, right) => right.gap.pixels - left.gap.pixels)
    .slice(0, Math.max(0, limit));
  // Work on a copy so the extraction other stages hashed stays untouched.
  const document = structuredClone(source);
  const pages = new Map(document.pages.map((page) => [page.number, page]));

  const passes = regionPasses(input, DEFAULT_REGION_PASSES);
  const firstPass = passes[0];
  const firstTarget = selected[0];
  const first =
    firstPass && firstTarget
      ? {
          page: firstTarget.page,
          bbox: firstTarget.gap.bbox,
          padding: firstPass.padding,
        }
      : null;
  const evidence: DocumentFieldEvidence[] = [];
  const recovered: { page: number; block: DocumentBlock; gap: OcrInkGap }[] = [];
  let attempted = 0;
  let failed = 0;
  const begin = Date.now();
  for (const target of selected) {
    if (Date.now() - startedAll >= budgetMs) break;
    if (options.signal?.aborted) throw new Error('OCR 已取消');
    attempted += 1;
    const candidates: DocumentFieldCandidate[] = [];
    const failures: string[] = [];
    let passesRun = 0;
    for (const pass of passes) {
      if (Date.now() - startedAll >= budgetMs) break;
      if (options.signal?.aborted) throw new Error('OCR 已取消');
      passesRun += 1;
      try {
        const result = await client.extractRegion(
          engine,
          {
            path: input.path,
            name: input.name,
            page: target.page,
            bbox: target.gap.bbox,
            dpi: pass.dpi ?? undefined,
            bboxDpi: input.dpi ?? undefined,
            mode: pass.mode,
            lang: input.lang,
            model: pass.model ?? input.model,
            padding: pass.padding,
          },
          options.signal,
        );
        const text = result.text.trim();
        if (text.length < MIN_INK_GAP_CHARS) {
          failures.push(`第 ${passesRun} 次未返回文本`);
          continue;
        }
        // No `agreesWithInitial`: there was no recognized text here to compare
        // against, so "disagree" would report a conflict that never existed.
        candidates.push({
          text,
          confidence: result.confidence,
          model: result.model,
          engine: result.engine,
          source: 'region',
          bbox: target.gap.bbox,
          pass: passesRun,
          mode: pass.mode,
          dpi: pass.dpi,
          padding: pass.padding,
          numeric: null,
        });
        break;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        failed += 1;
        const message = error instanceof Error ? error.message.slice(0, 200) : String(error);
        failures.push(`第 ${passesRun} 次: ${message}`);
        log('warn', 'ocr.ink_gap_failed', {
          engine,
          name: input.name,
          page: target.page,
          gapId: target.gap.id,
          pass: passesRun,
          message,
        });
      }
    }
    const candidate = candidates[0];
    if (!candidate) continue;
    const page = pages.get(target.page);
    if (!page) continue;
    const source: DocumentSource = {
      engine: candidate.engine || engine,
      model: candidate.model ?? null,
      stage: 'recovery',
    };
    // Gap ids are page-scoped (`p{page}-g{n}` from the sidecar and from the parser's
    // fallback), so they are safe to reuse as block ids.
    const block: DocumentBlock = {
      id: `ink-${target.gap.id}`,
      type: 'paragraph',
      text: candidate.text,
      bbox: target.gap.bbox,
      confidence: candidate.confidence,
      source,
      validation: { status: 'flagged', issues: ['ink_without_text'] },
      order: page.blocks.length,
      meta: {
        inkGap: target.gap.id,
        inkGapKind: target.gap.kind,
        inkGapPixels: target.gap.pixels,
      },
    };
    recovered.push({ page: target.page, block, gap: target.gap });
    evidence.push({
      kind: 'text',
      page: target.page,
      blockId: block.id,
      bbox: target.gap.bbox,
      text: '',
      confidence: null,
      source,
      candidates,
      selected: 'candidate',
      // Nothing was recognized here before, so no second opinion exists yet.
      agreement: 'unverified',
      passes: passesRun,
      failed: failures,
      reason: 'candidate_selected',
      inkGap: { id: target.gap.id, kind: target.gap.kind, pixels: target.gap.pixels },
    });
  }
  const seconds = Math.max(0.1, Math.round((Date.now() - begin) / 100) / 10);
  if (recovered.length === 0) {
    return {
      attempted,
      recovered: 0,
      failed,
      seconds,
      evidence: [],
      first,
      document: null,
      appendedText: '',
    };
  }
  const resolved = new Set(recovered.map((item) => `${item.page}:${item.gap.id}`));
  for (const page of document.pages) {
    const gaps = page.meta?.inkGaps;
    if (!gaps) continue;
    // A gap that yielded text is explained now, cell gaps included: the appended
    // block carries the gap id, so the reviewer still sees where the line came from
    // and the same ink is not reported as unclaimed forever.
    const remaining = gaps.filter((gap) => !resolved.has(`${page.number}:${gap.id}`));
    if (remaining.length !== gaps.length) {
      page.meta = { ...page.meta, inkGaps: remaining };
    }
  }
  for (const item of recovered) {
    pages.get(item.page)?.blocks.push(item.block);
  }
  if (evidence.length > 0) {
    const existing = Array.isArray(document.meta.fieldEvidence)
      ? (document.meta.fieldEvidence as DocumentFieldEvidence[])
      : [];
    document.meta.fieldEvidence = [...existing, ...evidence];
  }
  refineDocumentIr(document);
  // Reading order, not crop order: the flat text has to match the document it came from.
  const appendedText = document.pages
    .flatMap((page) => page.blocks)
    .filter((block) => block.meta?.inkGap)
    .sort((a, b) => a.order - b.order)
    .map((block) => block.text)
    .join('\n\n');
  return {
    attempted,
    recovered: recovered.length,
    failed,
    seconds,
    evidence,
    first,
    document,
    appendedText,
  };
}

/**
 * Ink recovery output applied without touching the caller's extraction: the
 * recovered blocks go into a new document and their text is appended to both the
 * display copy and the raw engine copy.
 */
function applyInkRecovery(extraction: OcrExtraction, ink: InkGapOutcome): OcrExtraction {
  if (!ink.document || !ink.appendedText) return extraction;
  const join = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : value ? `${value}\n\n${ink.appendedText}` : ink.appendedText;
  const rawText = join(extraction.rawText);
  return {
    ...extraction,
    text: join(extraction.text) ?? ink.appendedText,
    ...(rawText === undefined ? {} : { rawText }),
    document: ink.document,
  };
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Source fingerprint so a replay can prove it ran against the same input.
 * URLs are hashed as-is; unreadable paths simply skip the comparison.
 */
async function inputFingerprint(path: string): Promise<string | null> {
  if (/^https?:\/\//i.test(path)) return sha256(`url:${path}`);
  try {
    return sha256(await readFile(path));
  } catch {
    return null;
  }
}

/** Hash of the stage output (text + DIR) used to detect changed results. */
function outputFingerprint(extraction: OcrExtraction): string {
  return sha256(
    JSON.stringify({
      text: extraction.text,
      engine: extraction.engine,
      model: extraction.model,
      confidence: extraction.confidence,
      pages: extraction.pages,
      truncated: extraction.truncated,
      route: extraction.route,
      document: extraction.document,
    }),
  );
}

function qualitySnapshot(quality: DocumentQuality): OcrStageQuality {
  return {
    score: quality.score,
    status: quality.status,
    calibrated: quality.calibrated,
    issues: quality.issues.map((issue) => issue.code),
    hardRisks: quality.hardRisks.map((risk) => risk.code),
    signals: { ...quality.signals },
  };
}

function stageKind(extraction: OcrExtraction): OcrStageKind {
  return extraction.route === 'native' ? 'native' : 'visual';
}

function stage(
  kind: OcrStageKind,
  engine: OcrEngine,
  extraction: OcrExtraction,
  quality: DocumentQuality,
  seconds: number,
  mode: OcrMode,
  dpi: number | null,
  inputSha256: string | null,
): OcrStage {
  return {
    kind,
    status: 'done',
    mode,
    engine,
    model: extraction.engine,
    dpi,
    seconds,
    score: quality.score,
    message: null,
    inputSha256,
    outputSha256: outputFingerprint(extraction),
    params: { mode, dpi, page: null, bbox: null, padding: null },
    quality: qualitySnapshot(quality),
  };
}

/**
 * Budgeted extraction cascade: try the cheap route first, score it, and only
 * spend recovery attempts when the quality signal says the result is weak.
 */
export async function runOcrCascade(
  client: OcrClient,
  engine: OcrEngine,
  input: OcrInput,
  options: OcrCascadeOptions = {},
): Promise<OcrCascadeResult> {
  const maxStages = Math.max(1, options.maxStages ?? positiveIntEnv('OCR_CASCADE_MAX_STAGES', 3));
  const budgetMs = options.budgetMs ?? positiveIntEnv('OCR_CASCADE_BUDGET_SECONDS', 180) * 1_000;
  const startedAll = Date.now();
  const stages: OcrStage[] = [];
  const initialMode = input.mode ?? 'auto';
  const initialDpi = input.dpi ?? null;
  const inputSha256 = await inputFingerprint(input.path);

  const started = Date.now();
  const first = await client.extract(engine, input, options.signal);
  const firstQuality = assessQuality(first, options);
  const firstSeconds = Math.max(0.1, Math.round((Date.now() - started) / 100) / 10);
  stages.push(
    stage(
      stageKind(first),
      engine,
      first,
      firstQuality,
      firstSeconds,
      initialMode,
      initialDpi,
      inputSha256,
    ),
  );
  if (first.camelot) {
    const extra = stage(
      'camelot',
      engine,
      first,
      firstQuality,
      first.camelot.seconds,
      initialMode,
      initialDpi,
      inputSha256,
    );
    extra.model = first.camelot.model ?? 'camelot';
    extra.message = `${first.camelot.tables} 个表格（Camelot）${first.camelot.truncated ? '，已截断' : ''}`;
    stages.push(extra);
  }

  // Chart/handwriting/stamp/signature recognition is advisory and independent of
  // quality recovery, so it runs even when the first pass already looks clean.
  if (!first.truncated && stages.length < maxStages && Date.now() - startedAll < budgetMs) {
    const specialized = await runSpecializedRecognition(
      client,
      input,
      first,
      options,
      startedAll,
      budgetMs,
    );
    if (specialized) {
      const parts: string[] = [
        `${specialized.findings.length}/${specialized.attempted} 个专用区域识别`,
      ];
      if (specialized.failed > 0) parts.push(`${specialized.failed} 次失败`);
      stages.push({
        kind: 'specialized',
        status: specialized.findings.length > 0 ? 'done' : 'failed',
        mode: initialMode,
        engine,
        model: specialized.models[0] ?? 'specialized',
        dpi: initialDpi,
        seconds: specialized.seconds,
        score: firstQuality.score,
        message: parts.join(' · '),
        inputSha256,
        outputSha256: sha256(JSON.stringify(specialized.findings)),
        params: specialized.findings[0]
          ? {
              mode: initialMode,
              dpi: initialDpi,
              page: specialized.findings[0].page,
              bbox: specialized.findings[0].bbox,
              padding: null,
              specializedType: specialized.findings[0].type,
            }
          : {
              mode: initialMode,
              dpi: initialDpi,
              page: null,
              bbox: null,
              padding: null,
            },
        quality: qualitySnapshot(firstQuality),
      });
    }
  }

  let best = { extraction: first, quality: firstQuality };
  if (
    first.truncated ||
    (best.quality.status === 'pass' &&
      !pendingInkGaps(first) &&
      !detectedLanguageMismatch(input, first.text))
  ) {
    return { ...best, stages };
  }

  // Separate missing content (detection/reading order) from wrong characters
  // (recognition) before spending recovery budget. A detection failure cannot
  // be repaired by re-reading a low-confidence box, so skip local passes and
  // let a whole-page rerun try to recover the missing boxes.
  const diagnosis = diagnoseQuality(
    firstQuality.issues.map((issue) => issue.code),
    { empty: first.text.trim() === '' },
  );
  const localRecoveryAllowed = diagnosis.stage !== 'detection';

  // Region and cell re-recognition are cheap and local: corroborate
  // low-confidence key fields and failed table cells before spending a
  // whole-page rerun. Confirmed values keep the original text.
  const regionDecision = recoveryDecision(
    'recovery_region',
    firstQuality,
    0,
    options.recoveryYields,
  );
  const cellDecision = recoveryDecision('recovery_cell', firstQuality, 0, options.recoveryYields);
  if (
    localRecoveryAllowed &&
    (regionDecision.value > 0 || cellDecision.value > 0) &&
    stages.length < maxStages &&
    Date.now() - startedAll < budgetMs
  ) {
    const regions =
      regionDecision.value > 0
        ? await runRegionRecovery(client, engine, input, first, options, startedAll, budgetMs)
        : null;
    const cells =
      cellDecision.value > 0
        ? await runCellRecovery(client, engine, input, first, options, startedAll, budgetMs)
        : null;
    if (regions || cells) {
      const quality = assessQuality(first, options);
      const parts: string[] = [];
      if (regions) {
        parts.push(`${regions.evidence.length}/${regions.attempted} 个区域完成复认`);
      }
      if (cells) {
        parts.push(`${cells.evidence.length}/${cells.attempted} 个表格单元格复认`);
      }
      const confirmed = (regions?.confirmed ?? 0) + (cells?.confirmed ?? 0);
      const independent = (regions?.independent ?? 0) + (cells?.independent ?? 0);
      const conflicts = (regions?.conflicts ?? 0) + (cells?.conflicts ?? 0);
      const failed = (regions?.failed ?? 0) + (cells?.failed ?? 0);
      if (confirmed > 0) {
        parts.push(
          independent < confirmed
            ? `${confirmed} 个一致（仅 ${independent} 个来自不同引擎或模型）`
            : `${confirmed} 个独立一致`,
        );
      }
      if (conflicts > 0) parts.push(`${conflicts} 个冲突`);
      if (failed > 0) parts.push(`${failed} 次失败`);
      parts.push(`诊断 ${diagnosis.stage}`);
      const evidenceCount = (regions?.evidence.length ?? 0) + (cells?.evidence.length ?? 0);
      const attempted = (regions?.attempted ?? 0) + (cells?.attempted ?? 0);
      const keyRegion = regions?.evidence.some((item) => item.kind !== 'text') ?? false;
      const trigger: OcrRecoveryTrigger = regions
        ? keyRegion
          ? 'key_field'
          : 'low_confidence'
        : 'cell_recovery';
      const decision: OcrRecoveryDecision =
        regions && cells
          ? {
              trigger,
              expectedGain: round4(regionDecision.expectedGain + cellDecision.expectedGain),
              costSeconds: round4(regionDecision.costSeconds + cellDecision.costSeconds),
              value: round4(regionDecision.value + cellDecision.value),
            }
          : regions
            ? { ...regionDecision, trigger }
            : { ...cellDecision, trigger };
      stages.push({
        kind: regions ? 'recovery_region' : 'recovery_cell',
        status: evidenceCount === 0 ? 'failed' : 'done',
        mode: initialMode,
        engine,
        model: first.engine,
        dpi: initialDpi,
        seconds: Math.max(0.1, (regions?.seconds ?? 0) + (cells?.seconds ?? 0)),
        score: quality.score,
        message: evidenceCount > 0 ? parts.join(' · ') : `${attempted} 个区域或单元格复认失败`,
        trigger,
        decision,
        inputSha256,
        outputSha256: sha256(
          JSON.stringify([...(regions?.evidence ?? []), ...(cells?.evidence ?? [])]),
        ),
        params: {
          mode: initialMode,
          dpi: initialDpi,
          page: null,
          bbox: null,
          padding: null,
        },
        quality: qualitySnapshot(quality),
      });
      best = { extraction: first, quality };
      if (
        first.truncated ||
        (quality.status === 'pass' &&
          !pendingInkGaps(first) &&
          !detectedLanguageMismatch(input, first.text))
      ) {
        return { ...best, stages };
      }
    }
  }

  // VLM repair is reserved for regions local recovery left unconfirmed. Its
  // output is one more evidence candidate, never a text rewrite.
  const vlmDecision = recoveryDecision('vlm', best.quality, 0, options.recoveryYields);
  if (
    best.quality.status !== 'pass' &&
    vlmDecision.value > 0 &&
    stages.length < maxStages &&
    Date.now() - startedAll < budgetMs
  ) {
    const vlm = await runVlmRecovery(client, input, best.extraction, options, startedAll, budgetMs);
    if (vlm) {
      const quality = assessQuality(best.extraction, options);
      const parts: string[] = [`${vlm.candidates}/${vlm.attempted} 个问题区域经 VLM 复核`];
      if (vlm.confirmed > 0) parts.push(`${vlm.confirmed} 个独立一致`);
      if (vlm.conflicts > 0) parts.push(`${vlm.conflicts} 个冲突`);
      if (vlm.failed > 0) parts.push(`${vlm.failed} 次失败`);
      stages.push({
        kind: 'vlm',
        status: vlm.candidates > 0 ? 'done' : 'failed',
        mode: initialMode,
        engine,
        model: vlm.model ?? 'vlm',
        dpi: initialDpi,
        seconds: vlm.seconds,
        score: quality.score,
        message:
          vlm.candidates > 0 ? parts.join(' · ') : `${vlm.attempted} 个问题区域 VLM 复核失败`,
        trigger: vlm.trigger,
        decision: { ...vlmDecision, trigger: vlm.trigger },
        inputSha256,
        outputSha256: sha256(
          JSON.stringify(
            (best.extraction.document?.meta.fieldEvidence as DocumentFieldEvidence[] | undefined)
              ?.flatMap((item) => item.candidates.filter((candidate) => candidate.source === 'vlm'))
              .map((candidate) => ({
                text: candidate.text,
                confidence: candidate.confidence,
                model: candidate.model,
              })) ?? [],
          ),
        ),
        params: vlm.first
          ? {
              mode: initialMode,
              dpi: initialDpi,
              page: vlm.first.page,
              bbox: vlm.first.bbox,
              padding: vlm.first.padding,
            }
          : {
              mode: initialMode,
              dpi: initialDpi,
              page: null,
              bbox: null,
              padding: null,
            },
        quality: qualitySnapshot(quality),
      });
      if (compareQualityLayers(best.quality, quality) === 'next') {
        best = { extraction: best.extraction, quality };
      }
      if (
        best.extraction.truncated ||
        (quality.status === 'pass' &&
          !pendingInkGaps(best.extraction) &&
          !detectedLanguageMismatch(input, best.extraction.text))
      ) {
        return { ...best, stages };
      }
    }
  }

  const plans = planRecoveries(
    best.extraction,
    best.quality,
    input,
    engine,
    options.fallbackModels,
    options.candidateEngines,
    options.recoveryYields,
  );
  for (const plan of plans) {
    if (stages.length >= maxStages) break;
    if (Date.now() - startedAll >= budgetMs) break;
    if (options.signal?.aborted) {
      throw new Error('OCR 已取消');
    }

    const begin = Date.now();
    const targetEngine = plan.engine ?? engine;
    try {
      // A different engine must not inherit the primary engine's model profile.
      const { model: primaryModel, ...baseInput } = input;
      const requestedModel = plan.model ?? (plan.engine ? undefined : primaryModel);
      const next = await client.extract(
        targetEngine,
        {
          ...baseInput,
          mode: plan.mode,
          dpi: plan.dpi ?? input.dpi,
          ...(plan.lang ? { lang: plan.lang } : {}),
          ...(requestedModel ? { model: requestedModel } : {}),
        },
        options.signal,
      );
      const quality = assessQuality(next, options);
      const seconds = Math.max(0.1, Math.round((Date.now() - begin) / 100) / 10);
      const completed = stage(
        plan.kind,
        targetEngine,
        next,
        quality,
        seconds,
        plan.mode,
        plan.dpi,
        inputSha256,
      );
      completed.trigger = plan.trigger;
      completed.decision = plan.decision;
      if (completed.params) {
        completed.params.model = plan.model ?? (plan.engine ? null : primaryModel) ?? null;
      }
      // A truncated rerun must never replace a complete result, even when its
      // blended score is higher; losing pages is worse than a weak page.
      const truncatedGuard = next.truncated && !best.extraction.truncated;
      const verdict = truncatedGuard ? 'current' : compareQualityLayers(best.quality, quality);
      if (plan.kind === 'candidate') {
        // The candidate identity is what replay and governance need to show;
        // the stage already records the engine separately.
        completed.model = plan.model ?? plan.engine ?? next.engine;
      }
      if (plan.kind === 'candidate' && (plan.model || plan.engine)) {
        const label = plan.engine ? `候选引擎 ${plan.engine}` : `候选模型 ${plan.model}`;
        const agreed = textAgreement(best.extraction.text, next.text);
        const outcome =
          verdict === 'next' ? '采用' : truncatedGuard ? '候选已截断，保留原结果' : '保留原结果';
        completed.message = `${label} · 一致度 ${(agreed * 100).toFixed(1)}% · 质量 ${(best.quality.score * 100).toFixed(1)}% → ${(quality.score * 100).toFixed(1)}%（${outcome}）`;
      }
      stages.push(completed);
      if (verdict === 'next') {
        mergeAdvisoryFindings(next, best.extraction);
        best = { extraction: next, quality };
      }
      if (
        next.truncated ||
        (quality.status === 'pass' &&
          !pendingInkGaps(next) &&
          !detectedLanguageMismatch(input, next.text))
      ) {
        break;
      }
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const message = error instanceof Error ? error.message.slice(0, 300) : String(error);
      stages.push({
        kind: plan.kind,
        status: 'failed',
        mode: plan.mode,
        engine: targetEngine,
        model: plan.model ?? null,
        dpi: plan.dpi,
        seconds: Math.max(0.1, Math.round((Date.now() - begin) / 100) / 10),
        score: null,
        message,
        trigger: plan.trigger,
        decision: plan.decision,
        inputSha256,
        outputSha256: null,
        params: {
          mode: plan.mode,
          dpi: plan.dpi,
          page: null,
          bbox: null,
          padding: null,
          model: plan.model ?? null,
        },
      });
      log('warn', 'ocr.recovery_failed', {
        engine: targetEngine,
        name: input.name,
        kind: plan.kind,
        mode: plan.mode,
        dpi: plan.dpi,
        message,
      });
    }
  }

  // Unexplained ink is a detection miss with a local fix: crop exactly the region
  // no box covered. This runs after the reruns so an adopted whole-page result
  // cannot silently drop the appended blocks, and it is the stage that pays off
  // the pass-score early returns above.
  if (pendingInkGaps(best.extraction) && stages.length < maxStages) {
    const ink = await runInkGapRecovery(
      client,
      engine,
      input,
      best.extraction,
      options,
      startedAll,
      budgetMs,
    );
    if (ink && ink.attempted > 0) {
      const extraction = applyInkRecovery(best.extraction, ink);
      const quality = assessQuality(extraction, options);
      // Pixels, not a score, justify the crop, so reuse the region estimate and
      // keep the floor a hard risk would get instead of waiting for headroom.
      const estimate = recoveryDecision(
        'recovery_region',
        best.quality,
        0.15,
        options.recoveryYields,
      );
      const parts = [`${ink.recovered}/${ink.attempted} 处未覆盖墨迹补回文本`];
      if (ink.failed > 0) parts.push(`${ink.failed} 次失败`);
      stages.push({
        kind: 'recovery_region',
        status: ink.recovered > 0 ? 'done' : 'failed',
        mode: initialMode,
        engine,
        model: first.engine,
        dpi: initialDpi,
        seconds: ink.seconds,
        score: quality.score,
        message: parts.join(' · '),
        trigger: 'ink_gap',
        decision: { ...estimate, trigger: 'ink_gap' },
        inputSha256,
        outputSha256: sha256(JSON.stringify(ink.evidence)),
        params: {
          mode: initialMode,
          dpi: initialDpi,
          page: ink.first?.page ?? null,
          bbox: ink.first?.bbox ?? null,
          padding: ink.first?.padding ?? null,
        },
        quality: qualitySnapshot(quality),
      });
      best = { extraction, quality };
    }
  }

  return { ...best, stages };
}

export type OcrStageReplayResult = {
  kind: OcrStageKind;
  mode: OcrMode;
  dpi: number | null;
  /** Engine that actually replayed the stage (candidate stages may differ). */
  engine: OcrEngine;
  params: OcrStageParams;
  recordedInputSha256: string | null;
  inputSha256: string | null;
  /** `null` when either side has no fingerprint to compare. */
  inputMatches: boolean | null;
  recordedOutputSha256: string | null;
  outputSha256: string | null;
  /** `null` for region replays, which do not reproduce the whole DIR. */
  outputMatches: boolean | null;
  scoreBefore: number | null;
  scoreAfter: number | null;
  scoreDelta: number | null;
  /** Present when replaying one page region instead of the whole document. */
  candidate: OcrRegionResult | null;
  extraction: OcrExtraction | null;
  quality: DocumentQuality | null;
};

export function findReplayStage(
  stages: readonly OcrStage[],
  target: OcrStageReplayTarget,
): OcrStage | null {
  const wanted = Math.max(1, target.occurrence ?? 1);
  let seen = 0;
  for (const stageEntry of stages) {
    if (stageEntry.kind !== target.kind) continue;
    seen += 1;
    if (seen === wanted) return stageEntry;
  }
  return null;
}

/**
 * Re-run one recorded stage with its persisted parameters, either for the
 * whole page or for a single region. Comparing input/output hashes and scores
 * shows whether a change genuinely improved the result.
 */
export async function replayOcrStage(
  client: OcrClient,
  engine: OcrEngine,
  input: OcrInput,
  stages: readonly OcrStage[],
  target: OcrStageReplayTarget,
  options: QualityOptions & { signal?: AbortSignal } = {},
): Promise<OcrStageReplayResult> {
  const recorded = findReplayStage(stages, target);
  if (!recorded) {
    throw new Error(`找不到可重放的阶段: ${target.kind}`);
  }
  const params: OcrStageParams = recorded.params ?? {
    mode: recorded.mode,
    dpi: recorded.dpi,
    page: null,
    bbox: null,
    padding: null,
  };
  const page = target.page ?? params.page;
  const bbox = target.bbox ?? params.bbox;
  const padding = target.padding ?? params.padding;
  // Cross-engine candidates must replay on the engine that produced the stage.
  const replayEngine = recorded.engine ?? engine;
  const inputSha256 = await inputFingerprint(input.path);
  const inputMatches =
    recorded.inputSha256 && inputSha256 ? recorded.inputSha256 === inputSha256 : null;
  const base = {
    kind: recorded.kind,
    mode: params.mode,
    dpi: params.dpi,
    engine: replayEngine,
    params,
    recordedInputSha256: recorded.inputSha256 ?? null,
    inputSha256,
    inputMatches,
    recordedOutputSha256: recorded.outputSha256 ?? null,
    scoreBefore: recorded.score,
  };

  if (recorded.kind === 'vlm' && page !== null && bbox !== null) {
    if (!client.vlmConfigured) throw new Error('当前未配置 VLM 服务，无法重放该阶段');
    const candidate = await client.repairRegion(
      { path: input.path, name: input.name, page, bbox, padding: padding ?? VLM_PADDING },
      options.signal,
    );
    const outputSha256 = sha256(
      JSON.stringify({
        text: candidate.text,
        confidence: candidate.confidence,
        model: candidate.model,
      }),
    );
    return {
      ...base,
      outputSha256,
      outputMatches: null,
      scoreAfter: null,
      scoreDelta: null,
      candidate,
      extraction: null,
      quality: null,
    };
  }

  if (recorded.kind === 'specialized' && page !== null && bbox !== null) {
    const type = params.specializedType;
    if (!type) throw new Error('该专用区域阶段缺少区域类别，无法重放');
    if (!client.specializedConfigured)
      throw new Error('当前未配置专用区域识别服务，无法重放该阶段');
    const candidate = await client.recognizeSpecial(
      { path: input.path, name: input.name, page, bbox, type },
      options.signal,
    );
    const outputSha256 = sha256(
      JSON.stringify({
        text: candidate.text,
        confidence: candidate.confidence,
        model: candidate.model,
      }),
    );
    return {
      ...base,
      outputSha256,
      outputMatches: null,
      scoreAfter: null,
      scoreDelta: null,
      candidate,
      extraction: null,
      quality: null,
    };
  }

  if (page !== null && bbox !== null) {
    if (typeof client.extractRegion !== 'function') {
      throw new Error('当前 OCR 客户端不支持区域重放');
    }
    const candidate = await client.extractRegion(
      replayEngine,
      {
        path: input.path,
        name: input.name,
        page,
        bbox,
        dpi: params.dpi ?? undefined,
        mode: params.mode,
        lang: input.lang,
        model: params.model ?? input.model,
        padding: padding ?? undefined,
      },
      options.signal,
    );
    const outputSha256 = sha256(
      JSON.stringify({
        text: candidate.text,
        confidence: candidate.confidence,
        model: candidate.model,
      }),
    );
    return {
      ...base,
      outputSha256,
      outputMatches: null,
      scoreAfter: null,
      scoreDelta: null,
      candidate,
      extraction: null,
      quality: null,
    };
  }

  const extraction = await client.extract(
    replayEngine,
    {
      ...input,
      mode: params.mode,
      dpi: params.dpi ?? input.dpi,
      ...(params.model ? { model: params.model } : {}),
    },
    options.signal,
  );
  const quality = assessQuality(extraction, options);
  const outputSha256 = outputFingerprint(extraction);
  return {
    ...base,
    outputSha256,
    outputMatches:
      recorded.outputSha256 === undefined || recorded.outputSha256 === null
        ? null
        : outputSha256 === recorded.outputSha256,
    scoreAfter: quality.score,
    scoreDelta: recorded.score === null ? null : round4(quality.score - recorded.score),
    candidate: null,
    extraction,
    quality,
  };
}
