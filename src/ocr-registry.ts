import type {
  OcrGreyConfig,
  OcrRegistryEntry,
  OcrRegistryEvaluation,
  OcrRegistryPolicy,
  OcrRegistryRole,
  OcrRegistrySignificance,
} from '../shared/types.ts';

export const DEFAULT_REGISTRY_POLICY: OcrRegistryPolicy = {
  auto: true,
  minSamples: 20,
  promoteMargin: 0.01,
  rollbackMargin: 0.02,
  significance: 0.05,
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function latest(
  entries: readonly OcrRegistryEntry[],
  role: OcrRegistryRole,
): OcrRegistryEntry | null {
  let best: OcrRegistryEntry | null = null;
  for (const entry of entries) {
    if (entry.role !== role) continue;
    if (!best || entry.updatedAt > best.updatedAt) best = entry;
  }
  return best;
}

/** Latest control/candidate/rollback entries used for grey release. */
export function registryRoles(
  entries: readonly OcrRegistryEntry[],
  engine?: string,
): {
  control: OcrRegistryEntry | null;
  candidate: OcrRegistryEntry | null;
  rollback: OcrRegistryEntry | null;
} {
  const scoped = engine ? entries.filter((entry) => entry.engine === engine) : entries;
  return {
    control: latest(scoped, 'control'),
    candidate: latest(scoped, 'candidate'),
    rollback: latest(scoped, 'rollback'),
  };
}

/**
 * Translate the registry into the existing grey-release config. A candidate
 * with 0% or 100% share is not a canary, so no plan is emitted; the worker then
 * selects the registered control model directly.
 */
export function registryGreyConfig(
  entries: readonly OcrRegistryEntry[],
  engine?: string,
): OcrGreyConfig | null {
  const { control, candidate, rollback } = registryRoles(entries, engine);
  if (!control || !candidate || control.engine !== candidate.engine) return null;
  const percent = Math.floor(candidate.percent);
  if (percent <= 0 || percent >= 100) return null;
  return {
    percent,
    mode: candidate.mode === 'rollback' ? 'canary' : candidate.mode,
    candidateModelId: candidate.modelId,
    controlModelId: control.modelId,
    rollbackModelId: rollback?.modelId ?? null,
  };
}

/** Registered control model for an engine; used when no grey plan is active. */
export function registryActiveModel(
  entries: readonly OcrRegistryEntry[],
  engine: string,
): string | null {
  const control = latest(
    entries.filter((entry) => entry.engine === engine),
    'control',
  );
  return control?.modelId ?? null;
}

function delta(left: number | null, right: number | null): number | null {
  if (left === null || right === null) return null;
  return Math.round((clamp01(left) - clamp01(right)) * 10_000) / 10_000;
}

function measured(entry: OcrRegistryEntry, minSamples: number): boolean {
  return entry.benchmarkScore !== null && entry.benchmarkSamples >= minSamples;
}

function productionMeasured(entry: OcrRegistryEntry, minSamples: number): boolean {
  return entry.productionScore !== null && entry.productionSamples >= minSamples;
}

/** Stable lookup key for paired benchmark evidence. */
export function registryPairKey(engine: string, modelId: string, pipeline = ''): string {
  return `${engine}\u0000${modelId}\u0000${pipeline}`;
}

function logAdd(left: number, right: number): number {
  const max = Math.max(left, right);
  return max + Math.log1p(Math.exp(-Math.abs(left - right)));
}

/**
 * Exact two-sided McNemar test over discordant pairs (wins vs losses).
 * With no discordant files the test is uninformative and p = 1.
 * Computed in log space so corpora larger than ~1000 files cannot overflow.
 */
export function mcnemarExact(wins: number, losses: number): number {
  const discordant = wins + losses;
  if (discordant === 0) return 1;
  const tail = Math.min(wins, losses);
  let logTerm = 0;
  let logSum = 0;
  for (let index = 1; index <= tail; index += 1) {
    logTerm += Math.log((discordant - index + 1) / index);
    logSum = logAdd(logSum, logTerm);
  }
  const logP = Math.log(2) + logSum - discordant * Math.log(2);
  return Math.min(1, Math.exp(logP));
}

/**
 * A registry entry's pipeline label matches an experiment variant when the
 * entry is generic or names the variant's mode, preprocess stage or profile.
 */
export function pipelineMatches(
  pipeline: string,
  description: { profile?: string | null; mode?: string | null; preprocess?: string | null },
): boolean {
  const wanted = pipeline.trim().toLowerCase();
  if (!wanted) return true;
  return [description.profile, description.mode, description.preprocess].some(
    (value) => typeof value === 'string' && value.trim().toLowerCase() === wanted,
  );
}

/** Compare per-file CER for candidate vs control; lower CER is better. */
export function pairedBenchmarkSignificance(
  controlCer: ReadonlyMap<string, number>,
  candidateCer: ReadonlyMap<string, number>,
  threshold = DEFAULT_REGISTRY_POLICY.significance,
): OcrRegistrySignificance {
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let comparable = 0;
  for (const [name, candidate] of candidateCer) {
    const control = controlCer.get(name);
    if (control === undefined) continue;
    comparable += 1;
    if (candidate < control - 1e-9) wins += 1;
    else if (candidate > control + 1e-9) losses += 1;
    else ties += 1;
  }
  const pValue = mcnemarExact(wins, losses);
  return {
    wins,
    losses,
    ties,
    comparable,
    pValue,
    significant: wins > losses && pValue <= threshold,
  };
}

/**
 * Evaluate whether the candidate should replace control, or whether control has
 * degraded enough to restore the rollback entry. Every decision needs the
 * configured sample count, so a single lucky run cannot flip production.
 */
export function evaluateRegistry(
  entries: readonly OcrRegistryEntry[],
  policy: OcrRegistryPolicy = DEFAULT_REGISTRY_POLICY,
  paired?: Readonly<Record<string, OcrRegistrySignificance>>,
): OcrRegistryEvaluation {
  // Roles are scoped to the latest candidate's engine: with both engines
  // registered, an unscoped lookup could pair a Docling candidate with a
  // Paddle control and silently hold every promotion.
  const { control, candidate, rollback } = registryRoles(
    entries,
    latest(entries, 'candidate')?.engine,
  );
  const base = {
    controlId: control?.id ?? null,
    candidateId: candidate?.id ?? null,
    rollbackId: rollback?.id ?? null,
    benchmarkDelta: null as number | null,
    productionDelta: null as number | null,
    benchmarkSignificance: null as OcrRegistrySignificance | null,
    applied: false,
  };
  if (!policy.auto) {
    return { ...base, action: 'hold', reason: '自动晋级已关闭' };
  }
  if (candidate && control && candidate.engine !== control.engine) {
    return { ...base, action: 'hold', reason: '候选与控制模型引擎不一致' };
  }

  let blocked: string | null = null;
  if (candidate && control && candidate.auto && control.auto) {
    const benchmarkDelta = delta(candidate.benchmarkScore, control.benchmarkScore);
    base.benchmarkDelta = benchmarkDelta;
    const evidence =
      paired?.[registryPairKey(candidate.engine, candidate.modelId, candidate.pipeline)] ?? null;
    const significance = evidence
      ? {
          ...evidence,
          significant: evidence.wins > evidence.losses && evidence.pValue <= policy.significance,
        }
      : null;
    base.benchmarkSignificance = significance;
    const productionAcceptable =
      !productionMeasured(candidate, policy.minSamples) ||
      !productionMeasured(control, policy.minSamples) ||
      (candidate.productionScore ?? 0) >= (control.productionScore ?? 0) - policy.rollbackMargin;
    const marginMet =
      measured(candidate, policy.minSamples) &&
      measured(control, policy.minSamples) &&
      benchmarkDelta !== null &&
      benchmarkDelta >= policy.promoteMargin;
    if (marginMet && productionAcceptable) {
      if (!significance) {
        return {
          ...base,
          action: 'promote',
          reason: `候选基准领先 ${benchmarkDelta.toFixed(4)}（样本 ${candidate.benchmarkSamples}），达到晋级阈值 ${policy.promoteMargin}；未提供配对样本`,
        };
      }
      if (significance.comparable < policy.minSamples) {
        blocked = `候选基准领先 ${benchmarkDelta.toFixed(4)}，但配对可比较文件仅 ${significance.comparable} 份，低于最少 ${policy.minSamples} 份`;
      } else if (!significance.significant) {
        blocked = `候选基准领先 ${benchmarkDelta.toFixed(4)}，但配对检验不显著（胜/负/平 ${significance.wins}/${significance.losses}/${significance.ties}，McNemar p=${significance.pValue} > ${policy.significance}）`;
      } else {
        return {
          ...base,
          action: 'promote',
          reason: `候选基准领先 ${benchmarkDelta.toFixed(4)}（样本 ${candidate.benchmarkSamples}），配对胜/负 ${significance.wins}/${significance.losses}，McNemar p=${significance.pValue} ≤ ${policy.significance}`,
        };
      }
    }
  }

  if (rollback && control && rollback.auto && control.auto) {
    if (
      productionMeasured(control, policy.minSamples) &&
      productionMeasured(rollback, policy.minSamples)
    ) {
      const productionDelta = delta(control.productionScore, rollback.productionScore);
      base.productionDelta = productionDelta;
      if (productionDelta !== null && productionDelta <= -policy.rollbackMargin) {
        return {
          ...base,
          action: 'rollback',
          reason: `控制组生产评分低于回滚组 ${(-productionDelta).toFixed(4)}，超过回滚阈值 ${policy.rollbackMargin}`,
        };
      }
    }
    const benchmarkDelta = delta(control.benchmarkScore, rollback.benchmarkScore);
    if (
      measured(control, policy.minSamples) &&
      measured(rollback, policy.minSamples) &&
      benchmarkDelta !== null &&
      benchmarkDelta <= -policy.rollbackMargin
    ) {
      return {
        ...base,
        action: 'rollback',
        reason: `控制组基准低于回滚组 ${(-benchmarkDelta).toFixed(4)}，超过回滚阈值 ${policy.rollbackMargin}`,
      };
    }
  }

  return { ...base, action: 'hold', reason: blocked ?? '未达到自动晋级或回滚条件' };
}

export function normalizeRegistryPolicy(
  input: Partial<OcrRegistryPolicy> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): OcrRegistryPolicy {
  const envAuto = env.OCR_REGISTRY_AUTO?.trim().toLowerCase();
  const envNumber = (name: string, fallback: number): number => {
    const raw = Number(env[name]);
    return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
  };
  const minSamples = Math.max(
    1,
    Math.floor(
      input?.minSamples ??
        envNumber('OCR_REGISTRY_MIN_SAMPLES', DEFAULT_REGISTRY_POLICY.minSamples),
    ),
  );
  return {
    auto:
      input?.auto ??
      (envAuto === undefined
        ? DEFAULT_REGISTRY_POLICY.auto
        : envAuto !== '0' && envAuto !== 'false'),
    minSamples,
    promoteMargin: clamp01(
      input?.promoteMargin ??
        envNumber('OCR_REGISTRY_PROMOTE_MARGIN', DEFAULT_REGISTRY_POLICY.promoteMargin),
    ),
    rollbackMargin: clamp01(
      input?.rollbackMargin ??
        envNumber('OCR_REGISTRY_ROLLBACK_MARGIN', DEFAULT_REGISTRY_POLICY.rollbackMargin),
    ),
    significance: clamp01(
      input?.significance ??
        envNumber('OCR_REGISTRY_SIGNIFICANCE', DEFAULT_REGISTRY_POLICY.significance),
    ),
  };
}
