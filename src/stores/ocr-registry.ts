import { randomUUID } from 'node:crypto';
import type {
  OcrEngine,
  OcrGreyMode,
  OcrGreyPlan,
  OcrRegistryAction,
  OcrRegistryDecision,
  OcrRegistryEntry,
  OcrRegistryEvaluation,
  OcrRegistryPolicy,
  OcrRegistryRole,
  OcrRegistrySignificance,
  OcrRegistryState,
} from '../../shared/types.ts';
import type { Database } from '../db.ts';
import { greyPlan } from '../ocr-models.ts';
import {
  evaluateRegistry,
  normalizeRegistryPolicy,
  pipelineMatches,
  registryActiveModel,
  registryGreyConfig,
  registryRoles,
} from '../ocr-registry.ts';

type EntryRow = {
  id: string;
  engine: OcrEngine;
  model_id: string;
  pipeline: string;
  role: OcrRegistryRole;
  mode: OcrGreyMode;
  auto: number;
  percent: number;
  benchmark_score: number | null;
  benchmark_samples: number;
  production_score: number | null;
  production_samples: number;
  note: string;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
};

type DecisionRow = {
  id: string;
  at: string;
  actor: 'auto' | 'human';
  action: OcrRegistryAction;
  engine: OcrEngine;
  model_id: string;
  pipeline: string;
  from_role: OcrRegistryRole | null;
  to_role: OcrRegistryRole | null;
  percent: number | null;
  reason: string;
  metrics_json: string;
};

export type OcrRegistryRegisterInput = {
  engine: OcrEngine;
  modelId: string;
  pipeline?: string | null;
  role?: OcrRegistryRole;
  mode?: OcrGreyMode;
  percent?: number;
  auto?: boolean;
  note?: string | null;
  benchmarkScore?: number | null;
  benchmarkSamples?: number;
  productionScore?: number | null;
  productionSamples?: number;
};

export type OcrRegistryDecisionInput = {
  id?: string;
  engine?: OcrEngine;
  modelId?: string;
  pipeline?: string | null;
  action: Exclude<OcrRegistryAction, 'register'>;
  percent?: number;
  mode?: OcrGreyMode;
  /** Keep the target entry out of automatic decisions. */
  pin?: boolean;
  note?: string | null;
  policy?: Partial<OcrRegistryPolicy>;
  /** Paired McNemar evidence recorded with an automatic promotion. */
  significance?: OcrRegistrySignificance | null;
};

export type OcrRegistryMetricInput = {
  engine: OcrEngine;
  modelId: string;
  pipeline?: string | null;
  benchmarkScore?: number | null;
  benchmarkSamples?: number;
  productionScore?: number | null;
  productionSamples?: number;
};

function numberOrNull(value: number | null): number | null {
  return value === null ? null : Number(value);
}

function toEntry(row: EntryRow): OcrRegistryEntry {
  return {
    id: row.id,
    engine: row.engine,
    modelId: row.model_id,
    pipeline: row.pipeline,
    role: row.role,
    mode: row.mode,
    auto: Number(row.auto) === 1,
    percent: Number(row.percent),
    benchmarkScore: numberOrNull(row.benchmark_score),
    benchmarkSamples: Number(row.benchmark_samples),
    productionScore: numberOrNull(row.production_score),
    productionSamples: Number(row.production_samples),
    note: row.note,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDecision(row: DecisionRow): OcrRegistryDecision {
  return {
    id: row.id,
    at: row.at,
    actor: row.actor,
    action: row.action,
    engine: row.engine,
    modelId: row.model_id,
    pipeline: row.pipeline,
    fromRole: row.from_role,
    toRole: row.to_role,
    percent: row.percent === null ? null : Number(row.percent),
    reason: row.reason,
    metrics: JSON.parse(row.metrics_json || '{}') as Record<string, number | null>,
  };
}

function defaultPercent(role: OcrRegistryRole): number {
  if (role === 'control') return 100;
  if (role === 'candidate') return 10;
  return 0;
}

/**
 * Persisted model/pipeline registry. Automatic promotion and rollback operate on
 * the stored metrics; every role change is appended to an immutable decision
 * log so a human can audit or override it.
 */
export class OcrRegistryStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  entries(): OcrRegistryEntry[] {
    const rows = this.#db
      .stmt('SELECT * FROM ocr_registry_entries ORDER BY updated_at DESC, id')
      .all() as unknown as EntryRow[];
    return rows.map(toEntry);
  }

  decisions(limit = 50): OcrRegistryDecision[] {
    const rows = this.#db
      .stmt('SELECT * FROM ocr_registry_decisions ORDER BY rowid DESC LIMIT ?')
      .all(Math.max(0, limit)) as unknown as DecisionRow[];
    return rows.map(toDecision);
  }

  state(policy?: Partial<OcrRegistryPolicy>): OcrRegistryState {
    const entries = this.entries();
    // Show the same pairing the worker can actually apply.
    const engine = registryRoles(entries).candidate?.engine;
    const roles = registryRoles(entries, engine);
    return {
      config: registryGreyConfig(entries, engine),
      control: roles.control,
      candidate: roles.candidate,
      rollback: roles.rollback,
      entries,
      decisions: this.decisions(),
      policy: normalizeRegistryPolicy(policy),
    };
  }

  activeModel(engine: OcrEngine): string | null {
    return registryActiveModel(this.entries(), engine);
  }

  /**
   * Registry config wins whenever any entry exists; otherwise the environment
   * grey-release configuration is used as a fallback.
   */
  greyPlanFor(key: string, engine?: OcrEngine): OcrGreyPlan | null {
    const entries = this.entries();
    if (entries.length === 0) return greyPlan(key);
    const config = registryGreyConfig(entries, engine);
    return config ? greyPlan(key, config) : null;
  }

  register(input: OcrRegistryRegisterInput, actor: 'auto' | 'human' = 'human'): OcrRegistryEntry {
    const now = new Date().toISOString();
    const pipeline = input.pipeline?.trim() ?? '';
    const existing = this.#find(input.engine, input.modelId, pipeline);
    const role =
      input.role ??
      existing?.role ??
      (this.#hasRole(input.engine, 'control') ? 'candidate' : 'control');
    const mode = input.mode ?? existing?.mode ?? 'canary';
    const auto = input.auto ?? existing?.auto ?? true;
    const percent = Math.min(
      role === 'candidate' ? 99 : 100,
      Math.max(0, Math.floor(input.percent ?? existing?.percent ?? defaultPercent(role))),
    );
    const entry: OcrRegistryEntry = {
      id: existing?.id ?? `reg_${randomUUID()}`,
      engine: input.engine,
      modelId: input.modelId.trim(),
      pipeline,
      role,
      mode,
      auto,
      percent,
      benchmarkScore:
        input.benchmarkScore === undefined
          ? (existing?.benchmarkScore ?? null)
          : input.benchmarkScore,
      benchmarkSamples:
        input.benchmarkSamples === undefined
          ? (existing?.benchmarkSamples ?? 0)
          : Math.max(0, Math.floor(input.benchmarkSamples)),
      productionScore:
        input.productionScore === undefined
          ? (existing?.productionScore ?? null)
          : input.productionScore,
      productionSamples:
        input.productionSamples === undefined
          ? (existing?.productionSamples ?? 0)
          : Math.max(0, Math.floor(input.productionSamples)),
      note: input.note?.trim() ?? existing?.note ?? '',
      decidedBy: actor,
      decidedAt: now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.#db.transaction(() => {
      if (entry.role === 'control') {
        this.#db
          .stmt(
            `UPDATE ocr_registry_entries
                SET role = 'rollback', percent = 0, updated_at = ?
              WHERE engine = ? AND role = 'control' AND id <> ?`,
          )
          .run(now, entry.engine, entry.id);
      }
      if (existing) {
        this.#db
          .stmt(
            `UPDATE ocr_registry_entries
                SET model_id = ?, role = ?, mode = ?, auto = ?, percent = ?,
                    benchmark_score = ?, benchmark_samples = ?,
                    production_score = ?, production_samples = ?,
                    note = ?, decided_by = ?, decided_at = ?, updated_at = ?
              WHERE id = ?`,
          )
          .run(
            entry.modelId,
            entry.role,
            entry.mode,
            entry.auto ? 1 : 0,
            entry.percent,
            entry.benchmarkScore,
            entry.benchmarkSamples,
            entry.productionScore,
            entry.productionSamples,
            entry.note,
            entry.decidedBy,
            entry.decidedAt,
            entry.updatedAt,
            entry.id,
          );
      } else {
        this.#db
          .stmt(
            `INSERT INTO ocr_registry_entries
               (id, engine, model_id, pipeline, role, mode, auto, percent,
                benchmark_score, benchmark_samples, production_score, production_samples,
                note, decided_by, decided_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            entry.id,
            entry.engine,
            entry.modelId,
            entry.pipeline,
            entry.role,
            entry.mode,
            entry.auto ? 1 : 0,
            entry.percent,
            entry.benchmarkScore,
            entry.benchmarkSamples,
            entry.productionScore,
            entry.productionSamples,
            entry.note,
            entry.decidedBy,
            entry.decidedAt,
            entry.createdAt,
            entry.updatedAt,
          );
      }
      this.#record({
        actor,
        action: 'register',
        engine: entry.engine,
        modelId: entry.modelId,
        pipeline: entry.pipeline,
        fromRole: existing?.role ?? null,
        toRole: entry.role,
        percent: entry.percent,
        reason: input.note?.trim() || (existing ? '更新注册信息' : '注册模型/流水线'),
        metrics: {
          benchmarkScore: entry.benchmarkScore,
          benchmarkSamples: entry.benchmarkSamples,
          productionScore: entry.productionScore,
          productionSamples: entry.productionSamples,
        },
      });
    });
    return entry;
  }

  /** Update measured metrics without changing roles or writing a decision. */
  updateMetrics(metrics: readonly OcrRegistryMetricInput[]): number {
    const now = new Date().toISOString();
    let updated = 0;
    this.#db.transaction(() => {
      for (const metric of metrics) {
        const entry = this.#find(metric.engine, metric.modelId, metric.pipeline?.trim() ?? '');
        if (!entry) continue;
        this.#db
          .stmt(
            `UPDATE ocr_registry_entries
                SET benchmark_score = ?, benchmark_samples = ?,
                    production_score = ?, production_samples = ?, updated_at = ?
              WHERE id = ?`,
          )
          .run(
            metric.benchmarkScore === undefined ? entry.benchmarkScore : metric.benchmarkScore,
            metric.benchmarkSamples === undefined
              ? entry.benchmarkSamples
              : Math.max(0, Math.floor(metric.benchmarkSamples)),
            metric.productionScore === undefined ? entry.productionScore : metric.productionScore,
            metric.productionSamples === undefined
              ? entry.productionSamples
              : Math.max(0, Math.floor(metric.productionSamples)),
            now,
            entry.id,
          );
        updated += 1;
      }
    });
    return updated;
  }

  /** Human or automatic role/percent change with an immutable audit entry. */
  decide(
    input: OcrRegistryDecisionInput,
    actor: 'auto' | 'human' = 'human',
  ): { entry: OcrRegistryEntry | null; decision: OcrRegistryDecision } {
    const target = input.id
      ? (this.entries().find((entry) => entry.id === input.id) ?? null)
      : this.#find(input.engine ?? 'paddle', input.modelId ?? '', input.pipeline?.trim() ?? '');
    if (!target) throw new Error('注册项不存在');
    const now = new Date().toISOString();
    let result = target;
    let reason = input.note?.trim() || '';
    const decision = this.#db.transaction(() => {
      if (input.action === 'percent') {
        if (target.role !== 'candidate') throw new Error('只有候选模型可以调整灰度比例');
        const percent = Math.max(0, Math.min(99, Math.floor(input.percent ?? target.percent)));
        result = {
          ...target,
          percent,
          mode: input.mode ?? target.mode,
          auto: input.pin === undefined ? target.auto : !input.pin,
          updatedAt: now,
        };
        this.#writeEntry(result);
        reason ||= `候选灰度比例调整为 ${percent}%`;
      } else if (input.action === 'promote' || input.action === 'rollback') {
        const control = this.#latestRole(target.engine, 'control');
        const rollback = this.#latestRole(target.engine, 'rollback');
        if (control && control.id !== target.id) {
          const demoted: OcrRegistryEntry = {
            ...control,
            role: input.action === 'promote' ? 'rollback' : 'retired',
            percent: 0,
            auto: input.action === 'promote' ? control.auto : false,
            updatedAt: now,
          };
          this.#writeEntry(demoted);
          if (
            input.action === 'promote' &&
            rollback &&
            rollback.id !== target.id &&
            rollback.id !== control.id
          ) {
            this.#writeEntry({ ...rollback, role: 'retired', percent: 0, updatedAt: now });
          }
        }
        result = {
          ...target,
          role: 'control',
          percent: 100,
          auto: input.pin === undefined ? target.auto : !input.pin,
          updatedAt: now,
        };
        this.#writeEntry(result);
        reason ||=
          input.action === 'promote'
            ? `晋级 ${target.modelId} 为控制组`
            : `回滚到 ${target.modelId}`;
      } else if (input.action === 'retire') {
        result = { ...target, role: 'retired', percent: 0, updatedAt: now };
        this.#writeEntry(result);
        reason ||= `退役 ${target.modelId}`;
      } else if (input.action === 'pin') {
        if (input.pin === undefined) throw new Error('pin 动作需要 pin 布尔值');
        result = { ...target, auto: !input.pin, updatedAt: now };
        this.#writeEntry(result);
        reason ||= input.pin ? '人工固定，暂停自动晋级/回滚' : '恢复自动晋级/回滚';
      } else {
        reason ||= input.note?.trim() || '保持当前注册状态';
      }
      result = { ...result, decidedBy: actor, decidedAt: now };
      if (input.action !== 'hold') this.#writeEntry(result);
      return this.#record({
        actor,
        action: input.action,
        engine: target.engine,
        modelId: target.modelId,
        pipeline: target.pipeline,
        fromRole: target.role,
        toRole: result.role,
        percent: result.percent,
        reason,
        metrics: {
          benchmarkScore: target.benchmarkScore,
          productionScore: target.productionScore,
          benchmarkWins: input.significance?.wins ?? null,
          benchmarkLosses: input.significance?.losses ?? null,
          benchmarkTies: input.significance?.ties ?? null,
          benchmarkPValue: input.significance?.pValue ?? null,
        },
        at: now,
      });
    });
    return { entry: result, decision };
  }

  /**
   * Run the automatic promotion/rollback policy against stored metrics. Only a
   * positive evaluation mutates roles; holds are reported without a decision.
   */
  evaluate(
    policy?: Partial<OcrRegistryPolicy>,
    paired?: Readonly<Record<string, OcrRegistrySignificance>>,
  ): OcrRegistryEvaluation {
    const normalized = normalizeRegistryPolicy(policy);
    const entries = this.entries();
    const evaluation = evaluateRegistry(entries, normalized, paired);
    if (evaluation.action === 'hold') return evaluation;
    const id = evaluation.action === 'promote' ? evaluation.candidateId : evaluation.rollbackId;
    if (!id) return { ...evaluation, applied: false, reason: '找不到决策目标' };
    this.decide(
      {
        id,
        action: evaluation.action,
        note: evaluation.reason,
        policy: normalized,
        significance: evaluation.benchmarkSignificance,
      },
      'auto',
    );
    return { ...evaluation, applied: true };
  }

  /** Copy the latest experiment summaries into matching registry metrics. */
  syncBenchmarks(
    summaries: readonly {
      engine: OcrEngine;
      modelId: string | null;
      profile: string | null;
      mode?: string | null;
      preprocess?: string | null;
      score: number | null;
      files: number;
      failed: number;
    }[],
  ): number {
    const metrics = new Map<string, OcrRegistryMetricInput>();
    const entries = this.entries();
    for (const summary of summaries) {
      if (!summary.modelId || summary.score === null) continue;
      for (const entry of entries) {
        if (entry.engine !== summary.engine || entry.modelId !== summary.modelId) continue;
        if (!pipelineMatches(entry.pipeline, summary)) continue;
        // Several variants can share one model id; the best-scoring variant
        // represents it instead of whichever summary happens to come last.
        const existing = metrics.get(entry.id);
        if (existing && (existing.benchmarkScore ?? -1) >= summary.score) continue;
        metrics.set(entry.id, {
          engine: entry.engine,
          modelId: entry.modelId,
          pipeline: entry.pipeline,
          benchmarkScore: summary.score,
          benchmarkSamples: Math.max(0, summary.files - summary.failed),
        });
      }
    }
    return this.updateMetrics([...metrics.values()]);
  }

  #find(engine: OcrEngine, modelId: string, pipeline: string): OcrRegistryEntry | null {
    const row = this.#db
      .stmt(
        `SELECT * FROM ocr_registry_entries
          WHERE engine = ? AND model_id = ? AND pipeline = ?`,
      )
      .get(engine, modelId.trim(), pipeline) as unknown as EntryRow | undefined;
    return row ? toEntry(row) : null;
  }

  #hasRole(engine: OcrEngine, role: OcrRegistryRole): boolean {
    const row = this.#db
      .stmt('SELECT 1 AS present FROM ocr_registry_entries WHERE engine = ? AND role = ? LIMIT 1')
      .get(engine, role) as unknown as { present: number } | undefined;
    return Boolean(row?.present);
  }

  #latestRole(engine: OcrEngine, role: OcrRegistryRole): OcrRegistryEntry | null {
    const row = this.#db
      .stmt(
        `SELECT * FROM ocr_registry_entries
          WHERE engine = ? AND role = ?
          ORDER BY updated_at DESC, id LIMIT 1`,
      )
      .get(engine, role) as unknown as EntryRow | undefined;
    return row ? toEntry(row) : null;
  }

  #writeEntry(entry: OcrRegistryEntry): void {
    this.#db
      .stmt(
        `UPDATE ocr_registry_entries
            SET role = ?, mode = ?, auto = ?, percent = ?, note = ?,
                decided_by = ?, decided_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        entry.role,
        entry.mode,
        entry.auto ? 1 : 0,
        entry.percent,
        entry.note,
        entry.decidedBy,
        entry.decidedAt,
        entry.updatedAt,
        entry.id,
      );
  }

  #record(input: {
    actor: 'auto' | 'human';
    action: OcrRegistryAction;
    engine: OcrEngine;
    modelId: string;
    pipeline: string;
    fromRole: OcrRegistryRole | null;
    toRole: OcrRegistryRole | null;
    percent: number | null;
    reason: string;
    metrics: Record<string, number | null>;
    at?: string;
  }): OcrRegistryDecision {
    const at = input.at ?? new Date().toISOString();
    const decision: OcrRegistryDecision = {
      id: `regd_${randomUUID()}`,
      at,
      actor: input.actor,
      action: input.action,
      engine: input.engine,
      modelId: input.modelId,
      pipeline: input.pipeline,
      fromRole: input.fromRole,
      toRole: input.toRole,
      percent: input.percent,
      reason: input.reason,
      metrics: input.metrics,
    };
    this.#db
      .stmt(
        `INSERT INTO ocr_registry_decisions
           (id, at, actor, action, engine, model_id, pipeline, from_role, to_role,
            percent, reason, metrics_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.id,
        decision.at,
        decision.actor,
        decision.action,
        decision.engine,
        decision.modelId,
        decision.pipeline,
        decision.fromRole,
        decision.toRole,
        decision.percent,
        decision.reason,
        JSON.stringify(decision.metrics),
      );
    return decision;
  }
}
