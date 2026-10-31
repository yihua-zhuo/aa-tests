import type {
  OcrBenchFile,
  OcrExperimentRequest,
  OcrExperimentResult,
  OcrExperimentSample,
  OcrExperimentStage,
  OcrExperimentVariant,
  OcrExperimentVariantInput,
  OcrExperimentVariantSummary,
} from '../shared/types.ts';

export type {
  OcrExperimentRequest,
  OcrExperimentResult,
  OcrExperimentSample,
  OcrExperimentStage,
  OcrExperimentVariant,
  OcrExperimentVariantInput,
  OcrExperimentVariantSummary,
};

/**
 * Model x preprocessing experiments. A variant pins one recognizer profile and
 * one preprocessing configuration (mode + render DPI + channel); the runner
 * executes the same files under every variant and ranks the measured results.
 * Screening uses a stratified sample first, then only the best variants run the
 * full corpus.
 */

const MAX_VARIANTS = 12;

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function average(values: number[]): number | null {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Stratified sample: round-robin across language+kind buckets so a screening run
 * always includes every document family instead of the first N filenames.
 */
export function selectExperimentFiles(
  files: readonly OcrBenchFile[],
  limit: number,
): OcrBenchFile[] {
  const buckets = new Map<string, OcrBenchFile[]>();
  for (const file of files) {
    const key = `${file.lang ?? 'unknown'}|${file.kind}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(file);
    buckets.set(key, bucket);
  }
  const queues = [...buckets.values()];
  const selected: OcrBenchFile[] = [];
  let index = 0;
  while (selected.length < limit) {
    let picked = false;
    for (const queue of queues) {
      const file = queue[index];
      if (!file) continue;
      selected.push(file);
      picked = true;
      if (selected.length >= limit) break;
    }
    if (!picked) break;
    index += 1;
  }
  return selected;
}

/**
 * Composite score for selection, not for reporting accuracy: recognition and
 * field accuracy dominate, then numeric accuracy; failures and wall-clock/
 * memory cost subtract. License is reported separately because it is a policy
 * constraint, not a numeric one.
 */
export function experimentScore(summary: {
  files: number;
  failed: number;
  meanCer: number | null;
  meanNumericCer: number | null;
  fieldRate: number | null;
  meanSeconds: number;
  memoryMb: number | null;
}): number | null {
  if (summary.files === 0 || summary.failed >= summary.files) return null;
  if (summary.meanCer === null && summary.fieldRate === null) return null;
  const accuracy = summary.meanCer === null ? 0 : 1 - clamp(summary.meanCer);
  const fields = summary.fieldRate ?? accuracy;
  const numeric = summary.meanNumericCer === null ? accuracy : 1 - clamp(summary.meanNumericCer);
  const failurePenalty = (summary.failed / summary.files) * 0.5;
  const latencyPenalty = Math.min(0.15, summary.meanSeconds / 100);
  const memoryPenalty = Math.min(0.05, (summary.memoryMb ?? 0) / 50_000);
  return round4(
    Math.max(
      0,
      0.5 * accuracy +
        0.3 * fields +
        0.2 * numeric -
        failurePenalty -
        latencyPenalty -
        memoryPenalty,
    ),
  );
}

export function summarizeExperimentVariant(
  variant: OcrExperimentVariant,
  results: readonly OcrExperimentSample[],
  capability?: { license: string; memoryMb: number } | null,
): OcrExperimentVariantSummary {
  const samples = results.filter((sample) => sample.variantId === variant.id);
  const done = samples.filter((sample) => sample.status === 'done');
  const meanCer = average(
    done.map((sample) => sample.cer).filter((value): value is number => value !== null),
  );
  const meanRawCer = average(
    done.map((sample) => sample.rawCer).filter((value): value is number => value !== null),
  );
  const meanNumericCer = average(
    done.map((sample) => sample.numericCer).filter((value): value is number => value !== null),
  );
  const meanWer = average(
    done.map((sample) => sample.wer).filter((value): value is number => value !== null),
  );
  const fieldRate = average(
    done.map((sample) => sample.fieldRate).filter((value): value is number => value !== null),
  );
  const meanConfidence = average(
    done.map((sample) => sample.confidence).filter((value): value is number => value !== null),
  );
  const meanSeconds = round4(
    done.length > 0 ? done.reduce((sum, sample) => sum + sample.seconds, 0) / done.length : 0,
  );
  const summary: OcrExperimentVariantSummary = {
    id: variant.id,
    label: variant.label,
    engine: variant.engine,
    modelId: variant.modelId,
    profile: variant.profile,
    mode: variant.mode,
    dpi: variant.dpi,
    channel: variant.channel,
    preprocess: variant.preprocess,
    license: capability?.license ?? null,
    memoryMb: capability?.memoryMb ?? null,
    files: samples.length,
    failed: samples.length - done.length,
    meanCer,
    meanRawCer,
    meanNumericCer,
    meanWer,
    fieldRate,
    meanConfidence,
    meanSeconds,
    score: null,
    rank: null,
  };
  summary.score = experimentScore(summary);
  return summary;
}

export function rankExperimentSummaries(
  variants: readonly OcrExperimentVariant[],
  results: readonly OcrExperimentSample[],
  capabilities: ReadonlyMap<string, { license: string; memoryMb: number }>,
): OcrExperimentVariantSummary[] {
  const summaries = variants.map((variant) =>
    summarizeExperimentVariant(
      variant,
      results,
      variant.modelId ? capabilities.get(variant.modelId) : null,
    ),
  );
  summaries.sort((left, right) => {
    if (left.score === null && right.score === null) return left.id.localeCompare(right.id);
    if (left.score === null) return 1;
    if (right.score === null) return -1;
    return right.score - left.score || left.id.localeCompare(right.id);
  });
  let rank = 0;
  for (const summary of summaries) {
    if (summary.score !== null) {
      rank += 1;
      summary.rank = rank;
    }
  }
  return summaries;
}

/** Validate the request before any OCR work; throws on an unusable matrix. */
export function normalizeExperimentRequest(
  request: OcrExperimentRequest,
): Required<Omit<OcrExperimentRequest, 'variants'>> & { variants: OcrExperimentVariant[] } {
  const raw = request.variants ?? [];
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('至少需要一个实验变体');
  if (raw.length > MAX_VARIANTS) throw new Error(`实验变体不能超过 ${MAX_VARIANTS} 个`);
  const seen = new Set<string>();
  const variants = raw.map((input, index): OcrExperimentVariant => {
    const id = (input.id?.trim() || `variant-${index + 1}`).slice(0, 64);
    if (seen.has(id)) throw new Error(`实验变体 id 重复: ${id}`);
    seen.add(id);
    const engine = input.engine ?? 'paddle';
    if (engine !== 'paddle' && engine !== 'docling') throw new Error(`未知 OCR 引擎: ${engine}`);
    const mode = input.mode ?? 'auto';
    if (!['auto', 'table', 'structure', 'enhanced'].includes(mode)) {
      throw new Error(`未知 OCR 模式: ${mode}`);
    }
    if (input.dpi !== undefined && input.dpi !== null) {
      if (!Number.isInteger(input.dpi) || input.dpi < 100 || input.dpi > 400) {
        throw new Error('dpi 必须是 100 到 400 之间的整数');
      }
    }
    const channel = input.channel ?? 'rgb';
    if (!['rgb', 'gray', 'red'].includes(channel)) {
      throw new Error(`未知 OCR 通道: ${channel}`);
    }
    if (channel !== 'rgb' && engine !== 'paddle') {
      throw new Error('通道实验仅支持 PaddleOCR');
    }
    return {
      id,
      label: input.label?.trim() || id,
      engine,
      modelId: input.modelId?.trim() || null,
      profile: input.profile?.trim() || null,
      mode,
      dpi: input.dpi ?? null,
      channel,
      preprocess: mode === 'enhanced' ? 'enhanced' : 'original',
    };
  });
  const sampleSize = request.sample ?? 3;
  if (!Number.isInteger(sampleSize) || sampleSize < 1 || sampleSize > 50) {
    throw new Error('sample 必须是 1 到 50 之间的整数');
  }
  const topK = request.topK ?? Math.min(3, variants.length);
  if (!Number.isInteger(topK) || topK < 1 || topK > variants.length) {
    throw new Error('topK 必须在 1 到变体数量之间');
  }
  return {
    variants,
    includePdf: request.includePdf === true,
    sample: sampleSize,
    topK,
    full: request.full !== false,
  };
}
