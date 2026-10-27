import type {
  PortfolioConfig,
  PortfolioFactor,
  PortfolioFactorValue,
  PortfolioScore,
  ProjectStatus,
} from '../../shared/types.ts';
import type { Database } from '../db.ts';

type ConfigRow = {
  id: string;
  workspace_id: string;
  name: string;
  weights_json: string;
  version: number;
  active: number;
  created_at: string;
  updated_at: string;
};

type ScoreRow = {
  id: string;
  project_id: string;
  project_name: string;
  project_status: string;
  config_id: string;
  factors_json: string;
  missing_json: string;
  score: number | null;
  override_score: number | null;
  override_reason: string | null;
  scored_at: string;
  version: number;
};

export type PortfolioConfigInput = {
  name: string;
  weights: PortfolioFactor[];
  active?: boolean;
};

export type PortfolioScoreInput = {
  projectId: string;
  configId: string;
  factors: PortfolioFactorValue[];
  overrideScore?: number | null;
  overrideReason?: string | null;
};

export type ConfigResult =
  | { status: 'ok'; config: PortfolioConfig }
  | { status: 'missing' }
  | { status: 'conflict'; current: PortfolioConfig }
  | { status: 'invalid'; message: string };

type NormalizedFactor = { key: string; value: number | null };

function parseFactors(raw: string): NormalizedFactor[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        key: String(item.key ?? ''),
        value: typeof item.value === 'number' && Number.isFinite(item.value) ? item.value : null,
      }))
      .filter((item) => item.key.length > 0);
  } catch {
    return [];
  }
}

function parseWeights(raw: string): PortfolioFactor[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        key: String(item.key ?? ''),
        label: String(item.label ?? item.key ?? ''),
        weight: Number(item.weight ?? 0),
        direction: item.direction === 'negative' ? ('negative' as const) : ('positive' as const),
      }))
      .filter((factor) => factor.key.length > 0);
  } catch {
    return [];
  }
}

function toConfig(row: ConfigRow): PortfolioConfig {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    weights: parseWeights(row.weights_json),
    version: Number(row.version),
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toScore(row: ScoreRow): PortfolioScore {
  const factors = parseFactors(row.factors_json);
  const missing = JSON.parse(row.missing_json) as string[];
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    projectStatus: row.project_status as ProjectStatus,
    configId: row.config_id,
    factors,
    missing,
    score: row.score === null ? null : Number(row.score),
    overrideScore: row.override_score === null ? null : Number(row.override_score),
    overrideReason: row.override_reason,
    effectiveScore:
      row.override_score !== null
        ? Number(row.override_score)
        : row.score === null
          ? null
          : Number(row.score),
    scoredAt: row.scored_at,
    version: Number(row.version),
  };
}

function normalizeWeights(weights: PortfolioFactor[]): PortfolioFactor[] {
  const total = weights.reduce((sum, factor) => sum + factor.weight, 0);
  if (total <= 0) return weights;
  return weights.map((factor) => ({
    ...factor,
    label: factor.label || factor.key,
    weight: Number((factor.weight / total).toFixed(6)),
  }));
}

export function computeWeightedScore(
  weights: PortfolioFactor[],
  values: NormalizedFactor[],
): { score: number | null; missing: string[] } {
  const byKey = new Map(values.map((value) => [value.key, value.value]));
  const missing = weights
    .filter((factor) => byKey.get(factor.key) == null)
    .map((factor) => factor.key);
  if (missing.length > 0) return { score: null, missing };
  const total = weights.reduce((sum, factor) => sum + factor.weight, 0) || 1;
  const weighted = weights.reduce((sum, factor) => {
    const raw = Math.max(0, Math.min(5, byKey.get(factor.key) as number));
    const direction = factor.direction === 'negative' ? 5 - raw : raw;
    return sum + direction * factor.weight;
  }, 0);
  return { score: Number((weighted / total).toFixed(2)), missing };
}

export class PortfolioStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  #configRow(id: string, workspaceId: string): ConfigRow | null {
    const row = this.#db
      .stmt('SELECT * FROM portfolio_factor_configs WHERE id = ? AND workspace_id = ?')
      .get(id, workspaceId) as unknown as ConfigRow | undefined;
    return row ?? null;
  }

  listConfigs(workspaceId: string, includeInactive = false): PortfolioConfig[] {
    const rows = this.#db
      .stmt(
        `SELECT * FROM portfolio_factor_configs
         WHERE workspace_id = ?${includeInactive ? '' : ' AND active = 1'}
         ORDER BY created_at ASC`,
      )
      .all(workspaceId) as unknown as ConfigRow[];
    return rows.map(toConfig);
  }

  getConfig(id: string, workspaceId: string): PortfolioConfig | null {
    const row = this.#configRow(id, workspaceId);
    return row ? toConfig(row) : null;
  }

  createConfig(
    workspaceId: string,
    input: PortfolioConfigInput,
    actorId: string | null,
    now = new Date().toISOString(),
  ): ConfigResult {
    const existing = this.#db
      .stmt('SELECT 1 AS present FROM portfolio_factor_configs WHERE workspace_id = ? AND name = ?')
      .get(workspaceId, input.name) as unknown as { present: number } | undefined;
    if (existing) return { status: 'invalid', message: '已存在同名评分模板' };
    const workspace = this.#db
      .stmt('SELECT 1 AS present FROM workspaces WHERE id = ?')
      .get(workspaceId) as unknown as { present: number } | undefined;
    if (!workspace) return { status: 'invalid', message: '工作区不存在' };
    const id = crypto.randomUUID();
    this.#db
      .stmt(
        `INSERT INTO portfolio_factor_configs
           (id, workspace_id, name, weights_json, version, active, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        input.name.trim(),
        JSON.stringify(normalizeWeights(input.weights)),
        input.active === false ? 0 : 1,
        actorId,
        now,
        now,
      );
    const config = this.getConfig(id, workspaceId);
    if (!config) throw new Error('portfolio config creation failed');
    return { status: 'ok', config };
  }

  updateConfig(
    id: string,
    workspaceId: string,
    input: Partial<PortfolioConfigInput> & { version: number },
    now = new Date().toISOString(),
  ): ConfigResult {
    const row = this.#configRow(id, workspaceId);
    if (!row) return { status: 'missing' };
    if (input.name && input.name !== row.name) {
      const duplicate = this.#db
        .stmt(
          'SELECT 1 AS present FROM portfolio_factor_configs WHERE workspace_id = ? AND name = ? AND id != ?',
        )
        .get(workspaceId, input.name, id) as unknown as { present: number } | undefined;
      if (duplicate) return { status: 'invalid', message: '已存在同名评分模板' };
    }
    const sets = ['updated_at = ?', 'version = version + 1'];
    const params: (string | number | null)[] = [now];
    if (input.name !== undefined) {
      sets.push('name = ?');
      params.push(input.name.trim());
    }
    if (input.weights !== undefined) {
      sets.push('weights_json = ?');
      params.push(JSON.stringify(normalizeWeights(input.weights)));
    }
    if (input.active !== undefined) {
      sets.push('active = ?');
      params.push(input.active ? 1 : 0);
    }
    params.push(id, workspaceId, input.version);
    const updated = this.#db
      .stmt(
        `UPDATE portfolio_factor_configs SET ${sets.join(', ')}
         WHERE id = ? AND workspace_id = ? AND version = ? RETURNING id`,
      )
      .get(...params) as unknown as { id: string } | undefined;
    if (!updated) {
      const current = this.getConfig(id, workspaceId);
      return current ? { status: 'conflict', current } : { status: 'missing' };
    }
    const config = this.getConfig(id, workspaceId);
    if (!config) throw new Error('portfolio config update failed');
    return { status: 'ok', config };
  }

  removeConfig(id: string, workspaceId: string): boolean {
    const row = this.#configRow(id, workspaceId);
    if (!row) return false;
    return this.#db.transaction(() => {
      this.#db.stmt('DELETE FROM portfolio_scores WHERE config_id = ?').run(id);
      this.#db.stmt('DELETE FROM portfolio_factor_configs WHERE id = ?').run(id);
      return true;
    });
  }

  #project(
    projectId: string,
    workspaceId: string,
  ): {
    name: string;
    status: string;
    owner_id: string;
  } | null {
    const row = this.#db
      .stmt(
        `SELECT name, status, owner_id FROM projects
         WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      )
      .get(projectId, workspaceId) as unknown as
      | { name: string; status: string; owner_id: string }
      | undefined;
    return row ?? null;
  }

  score(
    projectId: string,
    configId: string,
    workspaceId: string,
    input: PortfolioScoreInput,
    actorId: string | null,
    now = new Date().toISOString(),
  ):
    | { status: 'ok'; score: PortfolioScore }
    | { status: 'invalid'; message: string }
    | { status: 'missing' } {
    const project = this.#project(projectId, workspaceId);
    if (!project) return { status: 'missing' };
    const configRow = this.#configRow(configId, workspaceId);
    if (!configRow) return { status: 'missing' };
    if (!configRow.active) return { status: 'invalid', message: '评分模板已停用' };
    const config = toConfig(configRow);
    const keys = new Set(config.weights.map((factor) => factor.key));
    const unknown = input.factors.filter((factor) => !keys.has(factor.key));
    if (unknown.length > 0) {
      return {
        status: 'invalid',
        message: `未知评分因子：${unknown.map((f) => f.key).join('、')}`,
      };
    }
    if (input.overrideScore != null && !input.overrideReason?.trim()) {
      return { status: 'invalid', message: '人工覆盖评分必须填写理由' };
    }
    const values = input.factors.map((factor) => ({
      key: factor.key,
      value: factor.value === null ? null : Number(Math.max(0, Math.min(5, factor.value))),
    }));
    const computed = computeWeightedScore(config.weights, values);
    const existing = this.#db
      .stmt('SELECT id, version FROM portfolio_scores WHERE project_id = ? AND config_id = ?')
      .get(projectId, configId) as unknown as { id: string; version: number } | undefined;

    if (existing) {
      this.#db
        .stmt(
          `UPDATE portfolio_scores
           SET factors_json = ?, missing_json = ?, score = ?, override_score = ?, override_reason = ?,
               scored_by = ?, scored_at = ?, version = version + 1
           WHERE id = ?`,
        )
        .run(
          JSON.stringify(values),
          JSON.stringify(computed.missing),
          computed.score,
          input.overrideScore ?? null,
          input.overrideReason?.trim() ?? null,
          actorId,
          now,
          existing.id,
        );
    } else {
      this.#db
        .stmt(
          `INSERT INTO portfolio_scores
             (id, project_id, config_id, factors_json, missing_json, score, override_score,
              override_reason, scored_by, scored_at, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(
          crypto.randomUUID(),
          projectId,
          configId,
          JSON.stringify(values),
          JSON.stringify(computed.missing),
          computed.score,
          input.overrideScore ?? null,
          input.overrideReason?.trim() ?? null,
          actorId,
          now,
        );
    }

    const score = this.getScore(projectId, configId, workspaceId);
    if (!score) throw new Error('portfolio score write failed');
    return { status: 'ok', score };
  }

  getScore(projectId: string, configId: string, workspaceId: string): PortfolioScore | null {
    const row = this.#db
      .stmt(
        `SELECT s.id, s.project_id, p.name AS project_name, p.status AS project_status, s.config_id,
                s.factors_json, s.missing_json, s.score, s.override_score, s.override_reason,
                s.scored_at, s.version
         FROM portfolio_scores s
         JOIN projects p ON p.id = s.project_id
         JOIN portfolio_factor_configs c ON c.id = s.config_id
         WHERE s.project_id = ? AND s.config_id = ? AND c.workspace_id = ? AND p.deleted_at IS NULL`,
      )
      .get(projectId, configId, workspaceId) as unknown as ScoreRow | undefined;
    return row ? toScore(row) : null;
  }

  listScores(workspaceId: string, configId: string, visible: Set<string> | null): PortfolioScore[] {
    const rows = this.#db
      .stmt(
        `SELECT s.id, s.project_id, p.name AS project_name, p.status AS project_status, s.config_id,
                s.factors_json, s.missing_json, s.score, s.override_score, s.override_reason,
                s.scored_at, s.version
         FROM portfolio_scores s
         JOIN projects p ON p.id = s.project_id
         JOIN portfolio_factor_configs c ON c.id = s.config_id
         WHERE c.workspace_id = ? AND s.config_id = ? AND p.deleted_at IS NULL
         ORDER BY (COALESCE(s.override_score, s.score) IS NULL),
                  COALESCE(s.override_score, s.score) DESC, p.name ASC`,
      )
      .all(workspaceId, configId) as unknown as ScoreRow[];
    const filtered = visible ? rows.filter((row) => visible.has(row.project_id)) : rows;
    return filtered.map(toScore);
  }
}
