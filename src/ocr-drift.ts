import type {
  DocumentQuality,
  OcrDriftAlert,
  OcrDriftBucket,
  OcrDriftDimension,
  OcrDriftDimensionReport,
  OcrDriftReport,
} from '../shared/types.ts';
import { documentCategory, textLanguage } from './ocr-feedback.ts';

export const DRIFT_THRESHOLD = 0.2;
export const MIN_BASELINE_SAMPLES = 20;
export const MIN_CURRENT_SAMPLES = 10;

const DIMENSIONS: readonly OcrDriftDimension[] = [
  'resolution',
  'language',
  'file_type',
  'page_size',
  'noise',
  'layout',
];

/** The metadata used for drift checks; document text never leaves this module. */
export type OcrDistributionInput = {
  name: string;
  mime: string;
  text: string;
  pageCount: number;
  pageSizes: { width: number | null; height: number | null }[];
  blocksPerPage: number[];
  hasTable: boolean;
  quality: DocumentQuality | null;
};

export type OcrDistribution = {
  samples: number;
  dimensions: Record<OcrDriftDimension, Record<string, number>>;
};

export function emptyDistribution(): OcrDistribution {
  return {
    samples: 0,
    dimensions: Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, {}])) as Record<
      OcrDriftDimension,
      Record<string, number>
    >,
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function resolutionBucket(sizes: OcrDistributionInput['pageSizes']): string {
  const first = sizes.find((size) => size.width !== null && size.height !== null);
  if (!first || first.width === null || first.height === null) return 'unknown';
  const pixels = first.width * first.height;
  if (pixels <= 0) return 'unknown';
  if (pixels < 500_000) return 'low';
  if (pixels < 1_500_000) return 'standard';
  if (pixels < 4_000_000) return 'high';
  return 'very_high';
}

function pageSizeBucket(sizes: OcrDistributionInput['pageSizes']): string {
  const first = sizes.find((size) => size.width !== null && size.height !== null);
  if (!first?.width || !first.height) return 'unknown';
  const aspect = first.width / first.height;
  if (aspect >= 1.15) return 'landscape';
  if (aspect <= 0.87) return 'portrait';
  return 'square';
}

const NOISE_CODES: [string, string][] = [
  ['image_noise', 'noise'],
  ['image_blurry', 'blur'],
  ['image_exposure', 'exposure'],
  ['image_glare', 'glare'],
  ['image_shadow', 'shadow'],
  ['image_skew', 'skew'],
  ['image_orientation', 'orientation'],
  ['image_low_resolution', 'low_resolution'],
  ['image_retake', 'retake'],
];

function noiseBucket(quality: DocumentQuality | null): string {
  if (!quality) return 'unknown';
  for (const [code, bucket] of NOISE_CODES) {
    if (quality.issues.some((issue) => issue.code === code)) return bucket;
  }
  return 'clean';
}

function layoutBucket(input: OcrDistributionInput): string {
  if (input.hasTable) return 'table';
  if (input.blocksPerPage.length === 0) return 'unknown';
  const average =
    input.blocksPerPage.reduce((sum, count) => sum + count, 0) / input.blocksPerPage.length;
  if (average < 3) return 'sparse';
  if (average > 20) return 'dense';
  return 'text';
}

export function distributionOf(inputs: readonly OcrDistributionInput[]): OcrDistribution {
  const dimensions = Object.fromEntries(
    DIMENSIONS.map((dimension) => [dimension, {} as Record<string, number>]),
  ) as Record<OcrDriftDimension, Record<string, number>>;
  for (const input of inputs) {
    const values: Record<OcrDriftDimension, string> = {
      resolution: resolutionBucket(input.pageSizes),
      language: textLanguage(input.text) ?? 'unknown',
      file_type: documentCategory(input.name, input.mime),
      page_size: pageSizeBucket(input.pageSizes),
      noise: noiseBucket(input.quality),
      layout: layoutBucket(input),
    };
    for (const dimension of DIMENSIONS) {
      const bucket = values[dimension];
      const counts = dimensions[dimension];
      counts[bucket] = (counts[bucket] ?? 0) + 1;
    }
  }
  return { samples: inputs.length, dimensions };
}

function shares(counts: Record<string, number>, total: number): Map<string, number> {
  const result = new Map<string, number>();
  for (const [key, count] of Object.entries(counts)) {
    result.set(key, total > 0 ? count / total : 0);
  }
  return result;
}

function dimensionReport(
  dimension: OcrDriftDimension,
  baseline: OcrDistribution,
  current: OcrDistribution,
  threshold: number,
  minBaseline: number,
  minCurrent: number,
): OcrDriftDimensionReport {
  const base = shares(baseline.dimensions[dimension], baseline.samples);
  const now = shares(current.dimensions[dimension], current.samples);
  const keys = [...new Set([...base.keys(), ...now.keys()])];
  let variation = 0;
  const buckets: OcrDriftBucket[] = [];
  for (const key of keys) {
    const before = base.get(key) ?? 0;
    const after = now.get(key) ?? 0;
    variation += Math.abs(after - before);
    buckets.push({
      key,
      baseline: round3(before),
      current: round3(after),
      delta: round3(after - before),
    });
  }
  variation = round3(variation / 2);
  buckets.sort(
    (left, right) =>
      Math.max(right.baseline, right.current) - Math.max(left.baseline, left.current) ||
      left.key.localeCompare(right.key),
  );
  const insufficient = baseline.samples < minBaseline || current.samples < minCurrent;
  return {
    dimension,
    totalVariation: variation,
    threshold,
    status: insufficient ? 'insufficient' : variation >= threshold ? 'drift' : 'stable',
    buckets,
  };
}

export type DriftCompareOptions = {
  baselineAt?: string | null;
  generatedAt?: string;
  threshold?: number;
  minBaseline?: number;
  minCurrent?: number;
};

/**
 * Compare production metadata against a stored baseline using total variation
 * distance. Any drifting dimension triggers a corpus top-up recommendation
 * instead of waiting for user complaints.
 */
export function compareDistributions(
  baseline: OcrDistribution,
  current: OcrDistribution,
  options: DriftCompareOptions = {},
): OcrDriftReport {
  const threshold = options.threshold ?? DRIFT_THRESHOLD;
  const minBaseline = options.minBaseline ?? MIN_BASELINE_SAMPLES;
  const minCurrent = options.minCurrent ?? MIN_CURRENT_SAMPLES;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const reports = DIMENSIONS.map((dimension) =>
    dimensionReport(dimension, baseline, current, threshold, minBaseline, minCurrent),
  );
  const alerts: OcrDriftAlert[] = reports
    .filter((report) => report.status === 'drift')
    .map((report) => {
      const severity = report.totalVariation >= threshold * 1.75 ? 'critical' : 'warn';
      const shifted = report.buckets
        .filter((bucket) => Math.abs(bucket.delta) >= 0.05)
        .slice(0, 3)
        .map(
          (bucket) =>
            `${bucket.key} ${Math.round(bucket.baseline * 100)}%→${Math.round(bucket.current * 100)}%`,
        )
        .join('，');
      return {
        dimension: report.dimension,
        severity,
        totalVariation: report.totalVariation,
        threshold: report.threshold,
        message: `${report.dimension} 分布漂移 ${Math.round(report.totalVariation * 100)}%（阈值 ${Math.round(threshold * 100)}%）${shifted ? `：${shifted}` : ''}`,
        buckets: report.buckets.filter((bucket) => Math.abs(bucket.delta) >= 0.05),
      } satisfies OcrDriftAlert;
    });

  return {
    baselineSamples: baseline.samples,
    currentSamples: current.samples,
    baselineAt: options.baselineAt ?? null,
    generatedAt,
    dimensions: reports,
    alerts,
    recommendation:
      alerts.length > 0
        ? `检测到 ${alerts.map((alert) => alert.dimension).join('、')} 分布漂移；建议补充对应语料并重新评估基准，确认结果后再调整路由、模型或预处理，不要直接凭 confidence 上线。`
        : null,
  };
}
