import { Hono } from 'hono';
import { canManageWorkspace } from '../../shared/permissions.ts';
import type {
  OcrEngine,
  OcrGreyMode,
  OcrRegistryEntry,
  OcrRegistryPolicy,
  OcrRegistryRole,
  OcrRegistrySignificance,
} from '../../shared/types.ts';
import type { AppEnv } from '../app-env.ts';
import { forbidden, noStore, validationError } from '../http.ts';
import { currentUser } from '../middleware/auth.ts';
import type { OcrBench } from '../ocr-bench.ts';
import type { OcrExperimentResult } from '../ocr-experiments.ts';
import {
  pairedBenchmarkSignificance,
  pipelineMatches,
  registryPairKey,
  registryRoles,
} from '../ocr-registry.ts';
import type { Store } from '../store.ts';
import type {
  OcrRegistryDecisionInput,
  OcrRegistryMetricInput,
  OcrRegistryRegisterInput,
} from '../stores/ocr-registry.ts';

const ENGINES = new Set<OcrEngine>(['paddle', 'docling']);
const ROLES = new Set<OcrRegistryRole>(['control', 'candidate', 'rollback', 'retired']);
const MODES = new Set<OcrGreyMode>(['canary', 'shadow', 'rollback']);
const ACTIONS = new Set<OcrRegistryDecisionInput['action']>([
  'promote',
  'rollback',
  'retire',
  'hold',
  'percent',
  'pin',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalScore(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const parsed = finiteNumber(value);
  return parsed === null ? undefined : Math.min(1, Math.max(0, parsed));
}

function optionalCount(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = finiteNumber(value);
  return parsed === null ? undefined : Math.max(0, Math.floor(parsed));
}

function readPolicy(value: unknown): Partial<OcrRegistryPolicy> | null {
  if (value === undefined) return {};
  const raw = asRecord(value);
  if (!raw) return null;
  const policy: Partial<OcrRegistryPolicy> = {};
  if (raw.auto !== undefined) {
    if (typeof raw.auto !== 'boolean') return null;
    policy.auto = raw.auto;
  }
  for (const key of ['minSamples', 'promoteMargin', 'rollbackMargin', 'significance'] as const) {
    if (raw[key] === undefined) continue;
    const parsed = finiteNumber(raw[key]);
    if (parsed === null || parsed < 0) return null;
    policy[key] = key === 'minSamples' ? Math.max(1, Math.floor(parsed)) : Math.min(1, parsed);
  }
  return policy;
}

/**
 * Pair candidate/control variants by file CER from the latest full experiment.
 * When a model has several variants, the best-scoring one represents it.
 */
function pairedEvidence(
  experiment: OcrExperimentResult,
  entries: readonly OcrRegistryEntry[],
): Record<string, OcrRegistrySignificance> {
  const full = experiment.full;
  if (!full) return {};
  const bestVariantFor = (entry: OcrRegistryEntry): string | null => {
    let best: { id: string; score: number } | null = null;
    for (const summary of full.summaries) {
      if (!summary.modelId || summary.score === null) continue;
      if (summary.engine !== entry.engine || summary.modelId !== entry.modelId) continue;
      if (!pipelineMatches(entry.pipeline, summary)) continue;
      if (!best || summary.score > best.score) best = { id: summary.id, score: summary.score };
    }
    return best?.id ?? null;
  };
  const cers = new Map<string, Map<string, number>>();
  for (const sample of full.results) {
    if (sample.status !== 'done' || sample.cer === null) continue;
    const map = cers.get(sample.variantId) ?? new Map<string, number>();
    map.set(sample.name, sample.cer);
    cers.set(sample.variantId, map);
  }
  const { control, candidate } = registryRoles(entries);
  if (!control || !candidate) return {};
  const controlVariant = bestVariantFor(control);
  const candidateVariant = bestVariantFor(candidate);
  if (!controlVariant || !candidateVariant) return {};
  return {
    [registryPairKey(candidate.engine, candidate.modelId, candidate.pipeline)]:
      pairedBenchmarkSignificance(
        cers.get(controlVariant) ?? new Map(),
        cers.get(candidateVariant) ?? new Map(),
      ),
  };
}

function readRegister(value: unknown): OcrRegistryRegisterInput | string {
  const raw = asRecord(value);
  if (!raw) return '请求体必须是对象';
  const engine = raw.engine;
  if (typeof engine !== 'string' || !ENGINES.has(engine as OcrEngine)) {
    return 'engine 必须是 paddle 或 docling';
  }
  const modelId = typeof raw.modelId === 'string' ? raw.modelId.trim() : '';
  if (!modelId || modelId.length > 120) return 'modelId 必填且不超过 120 字符';
  const role = raw.role;
  if (role !== undefined && (typeof role !== 'string' || !ROLES.has(role as OcrRegistryRole))) {
    return 'role 不合法';
  }
  const mode = raw.mode;
  if (mode !== undefined && (typeof mode !== 'string' || !MODES.has(mode as OcrGreyMode))) {
    return 'mode 不合法';
  }
  const percent = raw.percent === undefined ? undefined : finiteNumber(raw.percent);
  if (percent !== null && percent !== undefined && (percent < 0 || percent > 100)) {
    return 'percent 必须在 0-100 之间';
  }
  if (raw.auto !== undefined && typeof raw.auto !== 'boolean') return 'auto 必须是布尔值';
  if (raw.note !== undefined && typeof raw.note !== 'string') return 'note 必须是字符串';
  return {
    engine: engine as OcrEngine,
    modelId,
    pipeline: typeof raw.pipeline === 'string' ? raw.pipeline.slice(0, 60) : null,
    role: role as OcrRegistryRole | undefined,
    mode: mode as OcrGreyMode | undefined,
    percent: percent ?? undefined,
    auto: typeof raw.auto === 'boolean' ? raw.auto : undefined,
    note: typeof raw.note === 'string' ? raw.note : null,
    benchmarkScore: optionalScore(raw.benchmarkScore),
    benchmarkSamples: optionalCount(raw.benchmarkSamples),
    productionScore: optionalScore(raw.productionScore),
    productionSamples: optionalCount(raw.productionSamples),
  };
}

function readDecision(value: unknown): Omit<OcrRegistryDecisionInput, 'policy'> | string {
  const raw = asRecord(value);
  if (!raw) return '请求体必须是对象';
  const action = raw.action;
  if (typeof action !== 'string' || !ACTIONS.has(action as OcrRegistryDecisionInput['action'])) {
    return 'action 不合法';
  }
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : undefined;
  const engine = raw.engine;
  const modelId = typeof raw.modelId === 'string' ? raw.modelId.trim() : undefined;
  if (!id && (!engine || !modelId)) return '需要 id 或 engine + modelId';
  if (engine !== undefined && (typeof engine !== 'string' || !ENGINES.has(engine as OcrEngine))) {
    return 'engine 不合法';
  }
  const percent = raw.percent === undefined ? undefined : finiteNumber(raw.percent);
  if (percent !== null && percent !== undefined && (percent < 0 || percent > 99)) {
    return 'percent 必须在 0-99 之间';
  }
  const mode = raw.mode;
  if (mode !== undefined && (typeof mode !== 'string' || !MODES.has(mode as OcrGreyMode))) {
    return 'mode 不合法';
  }
  if (raw.pin !== undefined && typeof raw.pin !== 'boolean') return 'pin 必须是布尔值';
  if (action === 'pin' && typeof raw.pin !== 'boolean') return 'pin 动作需要 pin 布尔值';
  return {
    id,
    engine: engine as OcrEngine | undefined,
    modelId,
    pipeline: typeof raw.pipeline === 'string' ? raw.pipeline.slice(0, 60) : null,
    action: action as OcrRegistryDecisionInput['action'],
    percent: percent ?? undefined,
    mode: mode as OcrGreyMode | undefined,
    pin: typeof raw.pin === 'boolean' ? raw.pin : undefined,
    note: typeof raw.note === 'string' ? raw.note : null,
  };
}

function readMetrics(value: unknown): OcrRegistryMetricInput[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) return 'metrics 必须是最多 50 项的数组';
  const metrics: OcrRegistryMetricInput[] = [];
  for (const item of value) {
    const raw = asRecord(item);
    if (!raw) return 'metrics 项必须是对象';
    const engine = raw.engine;
    const modelId = typeof raw.modelId === 'string' ? raw.modelId.trim() : '';
    if (!engine || typeof engine !== 'string' || !ENGINES.has(engine as OcrEngine)) {
      return 'metrics.engine 不合法';
    }
    if (!modelId) return 'metrics.modelId 必填';
    metrics.push({
      engine: engine as OcrEngine,
      modelId,
      pipeline: typeof raw.pipeline === 'string' ? raw.pipeline.slice(0, 60) : null,
      benchmarkScore: optionalScore(raw.benchmarkScore),
      benchmarkSamples: optionalCount(raw.benchmarkSamples),
      productionScore: optionalScore(raw.productionScore),
      productionSamples: optionalCount(raw.productionSamples),
    });
  }
  return metrics;
}

export function ocrRegistryRoutes(store: Store, lab: OcrBench | null = null) {
  const app = new Hono<AppEnv>();

  const admin = (c: Parameters<typeof currentUser>[0]) => {
    const user = currentUser(c);
    return user && canManageWorkspace(user.role, user.permissions) ? user : null;
  };

  app.get('/api/ocr/registry', (c) => {
    if (!admin(c)) return forbidden(c, '只有工作区管理员可以查看 OCR 模型注册表');
    noStore(c);
    return c.json(store.ocrRegistry.state());
  });

  app.post('/api/ocr/registry/register', async (c) => {
    if (!admin(c)) return forbidden(c, '只有工作区管理员可以修改 OCR 模型注册表');
    const input = readRegister(await c.req.json().catch(() => null));
    if (typeof input === 'string') return validationError(c, input);
    noStore(c);
    const user = currentUser(c);
    const entry = store.ocrRegistry.register(input, 'human');
    store.audit.record({
      actor: { id: user.id, name: user.name },
      action: 'ocr.registry.register',
      target: `${entry.engine}:${entry.modelId}`,
      detail: {
        pipeline: entry.pipeline,
        role: entry.role,
        mode: entry.mode,
        percent: entry.percent,
      },
    });
    return c.json(store.ocrRegistry.state());
  });

  app.post('/api/ocr/registry/decision', async (c) => {
    if (!admin(c)) return forbidden(c, '只有工作区管理员可以调整 OCR 灰度发布');
    const body = asRecord(await c.req.json().catch(() => null));
    if (!body) return validationError(c, '请求体必须是对象');
    const input = readDecision(body);
    if (typeof input === 'string') return validationError(c, input);
    const policy = readPolicy(body.policy);
    if (policy === null) return validationError(c, 'policy 不合法');
    noStore(c);
    try {
      const user = currentUser(c);
      const result = store.ocrRegistry.decide({ ...input, policy }, 'human');
      store.audit.record({
        actor: { id: user.id, name: user.name },
        action: `ocr.registry.${result.decision.action}`,
        target: `${result.decision.engine}:${result.decision.modelId}`,
        detail: {
          pipeline: result.decision.pipeline,
          fromRole: result.decision.fromRole,
          toRole: result.decision.toRole,
          percent: result.decision.percent,
          reason: result.decision.reason,
        },
      });
      return c.json({ ...store.ocrRegistry.state(policy), decision: result.decision });
    } catch (error) {
      return validationError(c, error instanceof Error ? error.message : '决策失败');
    }
  });

  app.post('/api/ocr/registry/evaluate', async (c) => {
    if (!admin(c)) return forbidden(c, '只有工作区管理员可以运行 OCR 自动晋级');
    const body = asRecord(await c.req.json().catch(() => ({})));
    if (!body) return validationError(c, '请求体必须是对象');
    const policy = readPolicy(body.policy);
    if (policy === null) return validationError(c, 'policy 不合法');
    const metrics = readMetrics(body.metrics);
    if (typeof metrics === 'string') return validationError(c, metrics);
    noStore(c);
    const experiment = lab?.experimentStatus();
    // Only a running experiment blocks evaluation; failed or screening-only
    // runs simply contribute no new evidence and evaluation continues on the
    // metrics already stored (auto-rollback must not be pinned forever).
    if (metrics.length === 0 && body.syncExperiment !== false && experiment?.status === 'running') {
      return c.json(
        {
          error: 'conflict',
          message: '最新对照实验尚未完成，无法自动同步基准证据',
        },
        409,
      );
    }
    let paired: Record<string, OcrRegistrySignificance> | undefined;
    if (metrics.length > 0) store.ocrRegistry.updateMetrics(metrics);
    else if (
      body.syncExperiment !== false &&
      experiment?.status === 'done' &&
      !experiment.error &&
      experiment.full &&
      experiment.full.summaries.length > 0
    ) {
      store.ocrRegistry.syncBenchmarks(experiment.full.summaries);
      paired = pairedEvidence(experiment, store.ocrRegistry.entries());
    }
    const user = currentUser(c);
    const evaluation = store.ocrRegistry.evaluate(policy, paired);
    store.audit.record({
      actor: { id: user.id, name: user.name },
      action: `ocr.registry.evaluate.${evaluation.action}`,
      target: evaluation.candidateId ?? evaluation.controlId ?? 'ocr-registry',
      detail: {
        reason: evaluation.reason,
        benchmarkDelta: evaluation.benchmarkDelta,
        productionDelta: evaluation.productionDelta,
        significance: evaluation.benchmarkSignificance,
      },
    });
    return c.json({ evaluation, ...store.ocrRegistry.state(policy) });
  });

  return app;
}
