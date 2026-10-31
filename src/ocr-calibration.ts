import { createHash } from 'node:crypto';
import type {
  OcrCalibrationSample,
  OcrConfidencePoint,
  OcrThresholdDimension,
  OcrThresholdFitOptions,
  OcrThresholdProfile,
  OcrThresholdQuery,
} from '../shared/types.ts';

const DIMENSIONS: readonly OcrThresholdDimension[] = [
  'overall',
  'kind',
  'difficulty',
  'language',
  'file_type',
  'workspace',
];

const LOOKUP_ORDER: readonly OcrThresholdDimension[] = [
  'kind',
  'file_type',
  'language',
  'difficulty',
  'workspace',
  'overall',
];

const DEFAULT_MIN_SAMPLES = 20;
const DEFAULT_MIN_POSITIVES = 3;
const DEFAULT_KEY_FIELD_TARGET = 0.95;
const DEFAULT_FAIL_TARGET = 0.9;
const DEFAULT_REVIEW_THRESHOLD = 0.7;
const DEFAULT_KEY_FIELD_CONFIDENCE = 0.85;
const MIN_REVIEW_BAND = 0.05;
const CALIBRATION_BINS = 10;

export type ResolvedQualityThresholds = {
  reviewThreshold?: number;
  failThreshold?: number;
  keyFieldConfidence?: number;
  confidenceMap?: OcrConfidencePoint[];
};

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function round3(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 1000) / 1000;
}

function normalize(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

function fileTypeOf(value: string | null | undefined): string | null {
  const normalized = normalize(value);
  return normalized?.replace(/^\./, '') || null;
}

/**
 * How much a label is allowed to move a threshold. Disputed annotations are
 * dropped entirely; a sample can override the grade with an explicit weight.
 */
function weightOf(sample: OcrCalibrationSample): number {
  if (typeof sample.weight === 'number' && Number.isFinite(sample.weight)) {
    return Math.max(0, Math.min(1, sample.weight));
  }
  return sample.annotation === 'disputed' ? 0 : 1;
}

function weighted(
  samples: readonly OcrCalibrationSample[],
  predicate?: (sample: OcrCalibrationSample) => boolean,
): number {
  let total = 0;
  for (const sample of samples) {
    if (predicate && !predicate(sample)) continue;
    total += weightOf(sample);
  }
  return total;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function bucketValue(
  sample: OcrCalibrationSample,
  dimension: OcrThresholdDimension,
): string | null {
  switch (dimension) {
    case 'overall':
      return 'all';
    case 'kind':
      return normalize(sample.kind);
    case 'difficulty':
      return normalize(sample.difficulty);
    case 'language':
      return normalize(sample.language);
    case 'file_type':
      return fileTypeOf(sample.fileType);
    case 'workspace':
      return normalize(sample.workspaceId);
    default:
      return null;
  }
}

function queryValue(query: OcrThresholdQuery, dimension: OcrThresholdDimension): string | null {
  switch (dimension) {
    case 'overall':
      return 'all';
    case 'kind':
      return normalize(query.kind);
    case 'difficulty':
      return normalize(query.difficulty);
    case 'language':
      return normalize(query.language);
    case 'file_type':
      return fileTypeOf(query.fileType);
    case 'workspace':
      return normalize(query.workspaceId);
    default:
      return null;
  }
}

function profileId(
  dimension: OcrThresholdDimension,
  value: string,
  workspaceId: string | null,
): string {
  const digest = createHash('sha256')
    .update(`${dimension}:${value}:${workspaceId ?? ''}`)
    .digest('hex');
  return `thr_${digest.slice(0, 16)}`;
}

function calibrationOf(samples: readonly OcrCalibrationSample[]): {
  ece: number | null;
  brier: number | null;
} {
  const total = weighted(samples);
  if (samples.length === 0 || total <= 0) return { ece: null, brier: null };
  let ece = 0;
  let brier = 0;
  const size = 1 / CALIBRATION_BINS;
  for (let index = 0; index < CALIBRATION_BINS; index += 1) {
    const lower = index * size;
    const upper = index === CALIBRATION_BINS - 1 ? 1.000001 : (index + 1) * size;
    const bucket = samples.filter(
      (sample) => sample.confidence >= lower && sample.confidence < upper,
    );
    const mass = weighted(bucket);
    if (bucket.length === 0 || mass <= 0) continue;
    const confidence =
      bucket.reduce((sum, sample) => sum + sample.confidence * weightOf(sample), 0) / mass;
    const accuracy = weighted(bucket, (sample) => sample.correct) / mass;
    ece += (mass / total) * Math.abs(accuracy - confidence);
  }
  for (const sample of samples) {
    brier += weightOf(sample) * (sample.confidence - (sample.correct ? 1 : 0)) ** 2;
  }
  return { ece: round3(ece), brier: round3(brier / total) };
}

type CalibrationBlock = {
  raw: number;
  calibrated: number;
  weight: number;
};

/**
 * Fit a monotonic raw-confidence -> observed-accuracy curve with weighted
 * pool-adjacent-violators. Engine confidence is usually optimistic, and a
 * single high-confidence bin that is wrong 30% of the time should not keep
 * voting for "pass" just because it is confident. Nothing is fitted when fewer
 * than two confidence bins carry label mass.
 */
export function fitConfidenceMap(
  samples: readonly OcrCalibrationSample[],
): OcrConfidencePoint[] | null {
  const size = 1 / CALIBRATION_BINS;
  const blocks: CalibrationBlock[] = [];
  for (let index = 0; index < CALIBRATION_BINS; index += 1) {
    const lower = index * size;
    const upper = index === CALIBRATION_BINS - 1 ? 1.000001 : (index + 1) * size;
    const bucket = samples.filter(
      (sample) => sample.confidence >= lower && sample.confidence < upper,
    );
    const weight = weighted(bucket);
    if (weight <= 0) continue;
    const raw =
      bucket.reduce((sum, sample) => sum + sample.confidence * weightOf(sample), 0) / weight;
    const calibrated = weighted(bucket, (sample) => sample.correct) / weight;
    blocks.push({ raw: clamp(raw), calibrated: clamp(calibrated), weight });
  }
  if (blocks.length < 2) return null;

  // Isotonic regression: merge adjacent bins until the curve never decreases.
  for (let index = 1; index < blocks.length; index += 1) {
    let current = blocks[index];
    let previous = blocks[index - 1];
    while (previous && current.calibrated < previous.calibrated - 1e-9) {
      const weight = previous.weight + current.weight;
      const merged: CalibrationBlock = {
        raw: (previous.raw * previous.weight + current.raw * current.weight) / weight,
        calibrated:
          (previous.calibrated * previous.weight + current.calibrated * current.weight) / weight,
        weight,
      };
      blocks.splice(index - 1, 2, merged);
      index -= 1;
      if (index === 0) break;
      current = blocks[index];
      previous = blocks[index - 1];
    }
  }

  const points = blocks.map((block) => ({
    // Kept to three decimals: the map is persisted as JSON and replayed.
    raw: Math.round(block.raw * 1000) / 1000,
    calibrated: Math.round(block.calibrated * 1000) / 1000,
  }));
  return points.length >= 2 ? points : null;
}

/** Piecewise-linear lookup of a fitted map; endpoints clamp, never extrapolate. */
export function applyConfidenceMap(
  confidence: number,
  map: readonly OcrConfidencePoint[] | null | undefined,
): number {
  const value = clamp(confidence);
  if (!map || map.length === 0) return value;
  const points = [...map].sort((left, right) => left.raw - right.raw);
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return value;
  if (value <= first.raw) return clamp(first.calibrated);
  if (value >= last.raw) return clamp(last.calibrated);
  for (let index = 1; index < points.length; index += 1) {
    const right = points[index];
    const left = points[index - 1];
    if (!right || !left || value > right.raw) continue;
    const span = right.raw - left.raw;
    if (span <= 1e-9) return clamp(right.calibrated);
    const ratio = (value - left.raw) / span;
    return clamp(left.calibrated + (right.calibrated - left.calibrated) * ratio);
  }
  return clamp(last.calibrated);
}

/**
 * Review is triggered when confidence falls at or below the threshold, so the
 * threshold is chosen by maximising Youden's J on the severe-error ROC. Ties
 * prefer fewer false reviews and then higher precision.
 */
function chooseReviewThreshold(samples: readonly OcrCalibrationSample[], fallback: number): number {
  const positives = weighted(samples, (sample) => sample.severe);
  const negatives = weighted(samples, (sample) => !sample.severe);
  if (positives <= 0 || negatives <= 0) return fallback;
  const candidates = [0, ...new Set(samples.map((sample) => sample.confidence))].sort(
    (left, right) => left - right,
  );
  let best = { threshold: fallback, j: Number.NEGATIVE_INFINITY, falseRate: 1, precision: 0 };
  for (const threshold of candidates) {
    let truePositives = 0;
    let falsePositives = 0;
    for (const sample of samples) {
      if (sample.confidence > threshold) continue;
      if (sample.severe) truePositives += weightOf(sample);
      else falsePositives += weightOf(sample);
    }
    const recall = truePositives / positives;
    const specificity = (negatives - falsePositives) / negatives;
    const j = recall + specificity - 1;
    const falseRate = falsePositives / negatives;
    const precision =
      truePositives + falsePositives > 0 ? truePositives / (truePositives + falsePositives) : 0;
    const better =
      j > best.j + 1e-9 ||
      (Math.abs(j - best.j) <= 1e-9 &&
        (falseRate < best.falseRate - 1e-9 ||
          (Math.abs(falseRate - best.falseRate) <= 1e-9 && precision > best.precision)));
    if (better) best = { threshold, j, falseRate, precision };
  }
  return round3(clamp(best.threshold, 0.05, 0.99)) ?? fallback;
}

/**
 * The fail threshold flags catastrophic extractions. It stays a band below
 * review and picks the highest recall whose precision still reaches the target.
 */
function chooseFailThreshold(
  samples: readonly OcrCalibrationSample[],
  review: number,
  target: number,
): number {
  const positives = weighted(samples, (sample) => sample.severe);
  const ceiling = Math.max(0, review - MIN_REVIEW_BAND);
  if (positives <= 0) return round3(ceiling) ?? 0;
  const candidates = [
    0,
    ...new Set(
      samples.map((sample) => sample.confidence).filter((confidence) => confidence <= ceiling),
    ),
  ].sort((left, right) => left - right);
  let best: { threshold: number; recall: number } | null = null;
  for (const threshold of candidates) {
    let truePositives = 0;
    let falsePositives = 0;
    for (const sample of samples) {
      if (sample.confidence > threshold) continue;
      if (sample.severe) truePositives += weightOf(sample);
      else falsePositives += weightOf(sample);
    }
    if (truePositives <= 0) continue;
    const precision = truePositives / (truePositives + falsePositives);
    if (precision + 1e-9 < target) continue;
    const recall = truePositives / positives;
    if (
      !best ||
      recall > best.recall + 1e-9 ||
      (Math.abs(recall - best.recall) <= 1e-9 && threshold > best.threshold)
    ) {
      best = { threshold, recall };
    }
  }
  return round3(best?.threshold ?? ceiling) ?? ceiling;
}

/** Smallest confidence whose surviving samples still meet the precision target. */
function chooseKeyFieldConfidence(
  samples: readonly OcrCalibrationSample[],
  target: number,
): number {
  for (let step = 50; step <= 99; step += 1) {
    const threshold = step / 100;
    const selected = samples.filter((sample) => sample.confidence >= threshold);
    const mass = weighted(selected);
    if (mass <= 0) continue;
    const precision = weighted(selected, (sample) => sample.correct) / mass;
    if (precision + 1e-9 >= target) return round3(threshold) ?? threshold;
  }
  return DEFAULT_KEY_FIELD_CONFIDENCE;
}

function fitBucket(
  dimension: OcrThresholdDimension,
  value: string,
  workspaceId: string | null,
  samples: readonly OcrCalibrationSample[],
  options: Required<OcrThresholdFitOptions>,
  now: string,
): OcrThresholdProfile {
  const mass = weighted(samples);
  const positives = weighted(samples, (sample) => sample.severe);
  const calibrated = mass >= options.minSamples && positives >= options.minPositives;
  const rawCalibration = calibrationOf(samples);
  // Calibrated confidence is what the thresholds see: fitting a cut-off on an
  // optimistic raw engine score would preserve exactly the bias being fixed.
  const confidenceMap = calibrated ? fitConfidenceMap(samples) : null;
  const scoredSamples = confidenceMap
    ? samples.map((sample) => ({
        ...sample,
        confidence: applyConfidenceMap(sample.confidence, confidenceMap),
      }))
    : samples;
  const reviewThreshold = chooseReviewThreshold(scoredSamples, DEFAULT_REVIEW_THRESHOLD);
  const failThreshold = chooseFailThreshold(scoredSamples, reviewThreshold, options.failTarget);
  const keyFieldConfidence = chooseKeyFieldConfidence(scoredSamples, options.keyFieldTarget);
  const flagged = scoredSamples.filter((sample) => sample.confidence <= reviewThreshold);
  const truePositives = weighted(flagged, (sample) => sample.severe);
  const falsePositives = weighted(flagged, (sample) => !sample.severe);
  const negatives = mass - positives;
  const calibratedCalibration = confidenceMap ? calibrationOf(scoredSamples) : rawCalibration;
  return {
    id: profileId(dimension, value, workspaceId),
    dimension,
    value,
    workspaceId,
    samples: samples.length,
    /** Label mass actually used: disputed annotations weigh nothing. */
    effectiveSamples: round2(mass),
    positives: round2(positives),
    reviewThreshold,
    failThreshold,
    keyFieldConfidence,
    precision: round3(flagged.length > 0 ? truePositives / (truePositives + falsePositives) : null),
    recall: round3(positives > 0 ? truePositives / positives : null),
    falseReviewRate: round3(negatives > 0 ? falsePositives / negatives : null),
    ece: rawCalibration.ece,
    calibratedEce: confidenceMap ? calibratedCalibration.ece : null,
    brier: rawCalibration.brier,
    confidenceMap,
    calibrated,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Fits one threshold profile per dimension bucket. Profiles never rewrite OCR
 * text; they only decide review, fail and key-field warning cut-offs.
 */
export function fitThresholdProfiles(
  samples: readonly OcrCalibrationSample[],
  options: OcrThresholdFitOptions = {},
  now = new Date().toISOString(),
): OcrThresholdProfile[] {
  const resolved: Required<OcrThresholdFitOptions> = {
    minSamples: Math.max(1, options.minSamples ?? DEFAULT_MIN_SAMPLES),
    minPositives: Math.max(1, options.minPositives ?? DEFAULT_MIN_POSITIVES),
    keyFieldTarget: clamp(options.keyFieldTarget ?? DEFAULT_KEY_FIELD_TARGET, 0.5, 1),
    failTarget: clamp(options.failTarget ?? DEFAULT_FAIL_TARGET, 0.5, 1),
  };
  const usable = samples.filter(
    (sample) =>
      Number.isFinite(sample.confidence) &&
      sample.confidence >= 0 &&
      sample.confidence <= 1 &&
      weightOf(sample) > 0,
  );
  if (usable.length === 0) return [];

  const profiles: OcrThresholdProfile[] = [];
  for (const dimension of DIMENSIONS) {
    const buckets = new Map<string, OcrCalibrationSample[]>();
    for (const sample of usable) {
      const value = bucketValue(sample, dimension);
      if (!value) continue;
      const bucket = buckets.get(value) ?? [];
      bucket.push(sample);
      buckets.set(value, bucket);
    }
    for (const [value, bucket] of buckets) {
      const workspaceId = dimension === 'workspace' ? value : null;
      profiles.push(fitBucket(dimension, value, workspaceId, bucket, resolved, now));
    }
  }
  return profiles.sort(
    (left, right) =>
      DIMENSIONS.indexOf(left.dimension) - DIMENSIONS.indexOf(right.dimension) ||
      left.value.localeCompare(right.value),
  );
}

/** Picks the most specific calibrated profile; uncalibrated buckets are ignored. */
export function selectThresholdProfile(
  profiles: readonly OcrThresholdProfile[],
  query: OcrThresholdQuery,
): OcrThresholdProfile | null {
  for (const dimension of LOOKUP_ORDER) {
    const value = queryValue(query, dimension);
    if (!value) continue;
    const match = profiles.find(
      (profile) =>
        profile.calibrated &&
        profile.dimension === dimension &&
        profile.value === value &&
        profile.workspaceId === (dimension === 'workspace' ? value : null),
    );
    if (match) return match;
  }
  return null;
}

export function thresholdsFromProfile(
  profile: OcrThresholdProfile | null,
): ResolvedQualityThresholds {
  if (!profile) return {};
  return {
    reviewThreshold: profile.reviewThreshold,
    failThreshold: profile.failThreshold,
    keyFieldConfidence: profile.keyFieldConfidence,
    ...(profile.confidenceMap ? { confidenceMap: profile.confidenceMap } : {}),
  };
}
