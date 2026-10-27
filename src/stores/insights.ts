import { CURRENCIES } from '../../shared/currencies.ts';
import type {
  BudgetEntry,
  BudgetSummary,
  CurrencyCode,
  MetricDefinition,
  MetricEvaluation,
  MetricPoint,
  ProjectBudget,
  UserOption,
} from '../../shared/types.ts';
import type { Database } from '../db.ts';

type MetricRow = {
  id: string;
  workspace_id: string;
  name: string;
  unit: string;
  formula: string;
  dimensions_json: string;
  aggregation: string;
  source: string;
  refresh_minutes: number;
  owner_id: string | null;
  owner_name: string | null;
  status: string;
  version: number;
  created_at: string;
  updated_at: string;
};

type BudgetRow = {
  id: string;
  project_id: string;
  project_name: string;
  cost_center: string;
  currency: string;
  budget_cents: number;
  committed_cents: number;
  actual_cents: number;
  forecast_cents: number;
  fx_rate: number;
  fx_date: string | null;
  threshold_pct: number;
  version: number;
  created_at: string;
  updated_at: string;
};

type EntryRow = {
  id: string;
  budget_id: string;
  kind: string;
  amount_cents: number;
  currency: string;
  fx_rate: number;
  fx_date: string | null;
  note: string;
  created_at: string;
};

export type MetricInput = {
  name: string;
  unit?: string;
  formula: string;
  dimensions?: string[];
  aggregation?: 'sum' | 'avg' | 'min' | 'max' | 'count';
  refreshMinutes?: number;
  ownerId?: string | null;
};

export type MetricUpdateInput = Partial<MetricInput> & {
  status?: 'draft' | 'published' | 'archived';
  version: number;
  changeSummary?: string;
};

export type BudgetInput = {
  costCenter?: string;
  currency?: CurrencyCode;
  budgetCents?: number;
  forecastCents?: number;
  fxRate?: number;
  fxDate?: string | null;
  thresholdPct?: number;
  version?: number;
};

export type BudgetEntryInput = {
  kind: 'committed' | 'actual' | 'forecast';
  amountCents: number;
  currency?: CurrencyCode;
  fxRate?: number;
  fxDate?: string | null;
  note?: string;
  idempotencyKey?: string;
};

type MetricResult =
  | { status: 'ok'; metric: MetricDefinition; recalculationRequired?: boolean }
  | { status: 'missing' }
  | { status: 'invalid'; message: string }
  | { status: 'conflict'; current: MetricDefinition };

type BudgetResult =
  | { status: 'ok'; summary: BudgetSummary }
  | { status: 'missing' }
  | { status: 'invalid'; message: string }
  | { status: 'conflict'; current: ProjectBudget };

type EntryResult =
  | { status: 'ok'; summary: BudgetSummary; replayed: boolean }
  | { status: 'missing' }
  | { status: 'invalid'; message: string };

const AGGREGATIONS = new Set(['sum', 'avg', 'min', 'max', 'count']);
const RAW_FIELDS = new Set([
  'revenue',
  'revenue_cents',
  'customers',
  'conversions',
  'visitors',
  'sessions',
]);

type GroupBy = 'day' | 'week' | 'month';

type BucketTotals = {
  revenue_cents: number;
  customers: number;
  conversions: number;
  visitors: number;
  sessions: number;
};

type Node =
  | { kind: 'number'; value: number }
  | { kind: 'variable'; name: string }
  | { kind: 'metric'; name: string }
  | { kind: 'unary'; operand: Node }
  | { kind: 'binary'; op: '+' | '-' | '*' | '/'; left: Node; right: Node };

class FormulaError extends Error {}

function parseJsonStrings(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index] as string;
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (/[0-9.]/.test(char)) {
      const match = /^[0-9]+(?:\.[0-9]+)?/.exec(input.slice(index));
      if (!match) throw new FormulaError('数字格式无效');
      tokens.push(match[0]);
      index += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(input.slice(index));
      if (!match) throw new FormulaError('标识符格式无效');
      tokens.push(match[0]);
      index += match[0].length;
      continue;
    }
    if (char === '"') {
      const end = input.indexOf('"', index + 1);
      if (end === -1) throw new FormulaError('字符串缺少结束引号');
      tokens.push(`"${input.slice(index + 1, end)}"`);
      index = end + 1;
      continue;
    }
    if ('+-*/(),'.includes(char)) {
      tokens.push(char);
      index++;
      continue;
    }
    throw new FormulaError(`不支持的字符：${char}`);
  }
  return tokens;
}

class FormulaParser {
  readonly #tokens: string[];
  #index = 0;
  readonly variables = new Set<string>();
  readonly metrics = new Set<string>();

  constructor(tokens: string[]) {
    this.#tokens = tokens;
  }

  parse(): Node {
    const node = this.#expr();
    if (this.#index !== this.#tokens.length) throw new FormulaError('公式存在多余内容');
    return node;
  }

  #peek(): string | undefined {
    return this.#tokens[this.#index];
  }

  #next(): string | undefined {
    const token = this.#tokens[this.#index];
    this.#index++;
    return token;
  }

  #expr(): Node {
    let left = this.#term();
    while (this.#peek() === '+' || this.#peek() === '-') {
      const op = this.#next() as '+' | '-';
      left = { kind: 'binary', op, left, right: this.#term() };
    }
    return left;
  }

  #term(): Node {
    let left = this.#unary();
    while (this.#peek() === '*' || this.#peek() === '/') {
      const op = this.#next() as '*' | '/';
      left = { kind: 'binary', op, left, right: this.#unary() };
    }
    return left;
  }

  #unary(): Node {
    if (this.#peek() === '-') {
      this.#next();
      return { kind: 'unary', operand: this.#unary() };
    }
    if (this.#peek() === '+') {
      this.#next();
      return this.#unary();
    }
    return this.#primary();
  }

  #primary(): Node {
    const token = this.#next();
    if (token === undefined) throw new FormulaError('公式不完整');
    if (token === '(') {
      const node = this.#expr();
      if (this.#next() !== ')') throw new FormulaError('缺少右括号');
      return node;
    }
    if (/^[0-9]/.test(token)) return { kind: 'number', value: Number(token) };
    if (token.startsWith('"')) return { kind: 'number', value: Number.NaN };
    if (/^[A-Za-z_]/.test(token)) {
      if (token === 'metric') {
        if (this.#next() !== '(') throw new FormulaError('metric 缺少参数');
        const name = this.#next();
        if (!name?.startsWith('"')) throw new FormulaError('metric 参数必须是字符串');
        if (this.#next() !== ')') throw new FormulaError('metric 缺少右括号');
        const metricName = name.slice(1, -1);
        this.metrics.add(metricName);
        return { kind: 'metric', name: metricName };
      }
      if (!RAW_FIELDS.has(token)) throw new FormulaError(`未知指标字段：${token}`);
      this.variables.add(token);
      return { kind: 'variable', name: token };
    }
    throw new FormulaError(`无法解析的符号：${token}`);
  }
}

export function parseFormula(formula: string): {
  node: Node;
  variables: string[];
  metrics: string[];
} {
  const parser = new FormulaParser(tokenize(formula));
  const node = parser.parse();
  return { node, variables: [...parser.variables], metrics: [...parser.metrics] };
}

function evaluateNode(
  node: Node,
  values: Map<string, number>,
  resolveMetric: (name: string) => number | null,
): number | null {
  if (node.kind === 'number') return node.value;
  if (node.kind === 'variable') return values.get(node.name) ?? null;
  if (node.kind === 'metric') return resolveMetric(node.name);
  if (node.kind === 'unary') {
    const value = evaluateNode(node.operand, values, resolveMetric);
    return value === null ? null : -value;
  }
  const left = evaluateNode(node.left, values, resolveMetric);
  const right = evaluateNode(node.right, values, resolveMetric);
  if (left === null || right === null) return null;
  if (node.op === '+') return left + right;
  if (node.op === '-') return left - right;
  if (node.op === '*') return left * right;
  return right === 0 ? null : left / right;
}

function bucketOf(date: string, groupBy: GroupBy): string {
  if (groupBy === 'day') return date;
  if (groupBy === 'month') return date.slice(0, 7);
  const value = new Date(`${date}T00:00:00.000Z`);
  const day = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - day);
  return value.toISOString().slice(0, 10);
}

function emptyTotals(): BucketTotals {
  return { revenue_cents: 0, customers: 0, conversions: 0, visitors: 0, sessions: 0 };
}

function toMetric(row: MetricRow): MetricDefinition {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    unit: row.unit,
    formula: row.formula,
    dimensions: parseJsonStrings(row.dimensions_json),
    aggregation: row.aggregation,
    source: row.source,
    refreshMinutes: Number(row.refresh_minutes ?? 60),
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    status: row.status as MetricDefinition['status'],
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toBudget(row: BudgetRow): ProjectBudget {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    costCenter: row.cost_center,
    currency: row.currency as CurrencyCode,
    budgetCents: Number(row.budget_cents),
    committedCents: Number(row.committed_cents),
    actualCents: Number(row.actual_cents),
    forecastCents: Number(row.forecast_cents),
    fxRate: Number(row.fx_rate),
    fxDate: row.fx_date,
    thresholdPct: Number(row.threshold_pct),
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toEntry(row: EntryRow): BudgetEntry {
  return {
    id: row.id,
    budgetId: row.budget_id,
    kind: row.kind as BudgetEntry['kind'],
    amountCents: Number(row.amount_cents),
    currency: row.currency as CurrencyCode,
    fxRate: Number(row.fx_rate),
    fxDate: row.fx_date,
    note: row.note,
    createdAt: row.created_at,
  };
}

function budgetSummary(row: BudgetRow, entries: EntryRow[]): BudgetSummary {
  const budget = toBudget(row);
  const burnPct =
    budget.budgetCents === 0
      ? 0
      : Number(((budget.actualCents / budget.budgetCents) * 100).toFixed(1));
  return {
    budget,
    entries: entries.map(toEntry),
    remainingCents: budget.budgetCents - budget.actualCents,
    burnPct,
    forecastRemainingCents: budget.budgetCents - budget.actualCents - budget.forecastCents,
    thresholdReached: burnPct >= budget.thresholdPct,
  };
}

export class InsightsStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  #metricRow(id: string, workspaceId: string): MetricRow | null {
    const row = this.#db
      .stmt(
        `SELECT m.id, m.workspace_id, m.name, m.unit, m.formula, m.dimensions_json,
                m.aggregation, m.source, m.refresh_minutes, m.owner_id,
                u.name AS owner_name, m.status, m.version,
                m.created_at, m.updated_at
         FROM metric_definitions m LEFT JOIN users u ON u.id = m.owner_id
         WHERE m.id = ? AND m.workspace_id = ?`,
      )
      .get(id, workspaceId) as unknown as MetricRow | undefined;
    return row ?? null;
  }

  #metricByName(workspaceId: string, name: string): MetricRow | null {
    const row = this.#db
      .stmt(
        `SELECT m.id, m.workspace_id, m.name, m.unit, m.formula, m.dimensions_json,
                m.aggregation, m.source, m.refresh_minutes, m.owner_id,
                u.name AS owner_name, m.status, m.version,
                m.created_at, m.updated_at
         FROM metric_definitions m LEFT JOIN users u ON u.id = m.owner_id
         WHERE m.name = ? AND m.workspace_id = ?`,
      )
      .get(name, workspaceId) as unknown as MetricRow | undefined;
    return row ?? null;
  }

  listMetrics(workspaceId: string, status: string = 'all'): MetricDefinition[] {
    const where = ['m.workspace_id = ?'];
    const params: string[] = [workspaceId];
    if (status !== 'all') {
      where.push('m.status = ?');
      params.push(status);
    }
    const rows = this.#db
      .stmt(
        `SELECT m.id, m.workspace_id, m.name, m.unit, m.formula, m.dimensions_json,
                m.aggregation, m.source, m.refresh_minutes, m.owner_id,
                u.name AS owner_name, m.status, m.version,
                m.created_at, m.updated_at
         FROM metric_definitions m LEFT JOIN users u ON u.id = m.owner_id
         WHERE ${where.join(' AND ')}
         ORDER BY m.updated_at DESC LIMIT 200`,
      )
      .all(...params) as unknown as MetricRow[];
    return rows.map(toMetric);
  }

  getMetric(id: string, workspaceId: string): MetricDefinition | null {
    const row = this.#metricRow(id, workspaceId);
    return row ? toMetric(row) : null;
  }

  #validateFormula(workspaceId: string, metricId: string | null, formula: string): string | null {
    let parsed: ReturnType<typeof parseFormula>;
    try {
      parsed = parseFormula(formula);
    } catch (error) {
      return error instanceof FormulaError ? error.message : '公式格式无效';
    }
    for (const name of parsed.metrics) {
      if (!this.#metricByName(workspaceId, name)) return `引用的指标不存在：${name}`;
    }
    const rows = this.#db
      .stmt('SELECT id, name, formula FROM metric_definitions WHERE workspace_id = ?')
      .all(workspaceId) as unknown as { id: string; name: string; formula: string }[];
    const edges = new Map<string, string[]>();
    for (const row of rows) {
      try {
        edges.set(row.name, parseFormula(row.formula).metrics);
      } catch {
        edges.set(row.name, []);
      }
    }
    let candidateName = '';
    if (metricId) {
      const current = rows.find((row) => row.id === metricId);
      candidateName = current?.name ?? '';
    }
    if (candidateName) edges.set(candidateName, parsed.metrics);
    const root = candidateName || parsed.metrics[0];
    if (!root) return null;
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const dfs = (name: string): boolean => {
      if (visiting.has(name)) return true;
      if (visited.has(name)) return false;
      visiting.add(name);
      for (const next of edges.get(name) ?? []) {
        if (dfs(next)) return true;
      }
      visiting.delete(name);
      visited.add(name);
      return false;
    };
    for (const name of parsed.metrics) {
      if (dfs(name)) return '指标公式存在循环引用';
    }
    if (candidateName && dfs(candidateName)) return '指标公式存在循环引用';
    return null;
  }

  #insertVersion(metric: MetricDefinition, actorId: string | null, summary: string): void {
    this.#db
      .stmt(
        `INSERT INTO metric_versions
           (id, metric_id, version, definition_json, change_summary, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        metric.id,
        metric.version,
        JSON.stringify({
          name: metric.name,
          unit: metric.unit,
          formula: metric.formula,
          dimensions: metric.dimensions,
          aggregation: metric.aggregation,
          status: metric.status,
        }),
        summary,
        actorId,
        new Date().toISOString(),
      );
  }

  createMetric(workspaceId: string, input: MetricInput, actor: UserOption): MetricResult {
    const workspace = this.#db
      .stmt('SELECT 1 AS present FROM workspaces WHERE id = ?')
      .get(workspaceId) as unknown as { present: number } | undefined;
    if (!workspace) return { status: 'invalid', message: '工作区不存在' };
    if (this.#metricByName(workspaceId, input.name)) {
      return { status: 'invalid', message: '已存在同名指标' };
    }
    const formulaError = this.#validateFormula(workspaceId, null, input.formula);
    if (formulaError) return { status: 'invalid', message: formulaError };
    if (input.ownerId) {
      const owner = this.#db
        .stmt("SELECT 1 AS present FROM users WHERE id = ? AND status = 'active'")
        .get(input.ownerId) as unknown as { present: number } | undefined;
      if (!owner) return { status: 'invalid', message: '负责人不存在或已停用' };
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.#db
      .stmt(
        `INSERT INTO metric_definitions
           (id, workspace_id, name, unit, formula, dimensions_json, aggregation, source,
            refresh_minutes, owner_id, status, version, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'daily_metrics', ?, ?, 'draft', 1, ?, ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        input.name.trim(),
        input.unit?.trim() ?? '',
        input.formula.trim(),
        JSON.stringify(input.dimensions ?? []),
        input.aggregation ?? 'sum',
        input.refreshMinutes ?? 60,
        input.ownerId ?? actor.id,
        actor.id,
        now,
        now,
      );
    const metric = this.getMetric(id, workspaceId);
    if (!metric) throw new Error('metric creation failed');
    this.#insertVersion(metric, actor.id, '创建指标');
    return { status: 'ok', metric };
  }

  updateMetric(
    id: string,
    workspaceId: string,
    input: MetricUpdateInput,
    actor: UserOption,
  ): MetricResult {
    const row = this.#metricRow(id, workspaceId);
    if (!row) return { status: 'missing' };
    if (input.name && input.name !== row.name && this.#metricByName(workspaceId, input.name)) {
      return { status: 'invalid', message: '已存在同名指标' };
    }
    if (input.formula) {
      const formulaError = this.#validateFormula(workspaceId, id, input.formula);
      if (formulaError) return { status: 'invalid', message: formulaError };
    }
    if (input.ownerId) {
      const owner = this.#db
        .stmt("SELECT 1 AS present FROM users WHERE id = ? AND status = 'active'")
        .get(input.ownerId) as unknown as { present: number } | undefined;
      if (!owner) return { status: 'invalid', message: '负责人不存在或已停用' };
    }
    if (input.aggregation && !AGGREGATIONS.has(input.aggregation)) {
      return { status: 'invalid', message: '聚合方式无效' };
    }
    const sets = ['updated_at = ?', 'version = version + 1'];
    const params: (string | number | null)[] = [new Date().toISOString()];
    const fields: [keyof MetricInput | 'status', string, (value: unknown) => unknown][] = [
      ['name', 'name', (value) => String(value).trim()],
      ['unit', 'unit', (value) => String(value).trim()],
      ['formula', 'formula', (value) => String(value).trim()],
      ['dimensions', 'dimensions_json', (value) => JSON.stringify(value ?? [])],
      ['aggregation', 'aggregation', (value) => value],
      ['refreshMinutes', 'refresh_minutes', (value) => Number(value)],
      ['ownerId', 'owner_id', (value) => value ?? null],
      ['status', 'status', (value) => value],
    ];
    for (const [key, column, cast] of fields) {
      if (input[key] !== undefined) {
        sets.push(`${column} = ?`);
        params.push(cast(input[key]) as string | number | null);
      }
    }
    params.push(id, input.version);
    const updated = this.#db
      .stmt(
        `UPDATE metric_definitions SET ${sets.join(', ')}
         WHERE id = ? AND version = ? RETURNING id`,
      )
      .get(...params) as unknown as { id: string } | undefined;
    if (!updated) {
      const current = this.getMetric(id, workspaceId);
      return current ? { status: 'conflict', current } : { status: 'missing' };
    }
    const metric = this.getMetric(id, workspaceId);
    if (!metric) throw new Error('metric update failed');
    this.#insertVersion(metric, actor.id, input.changeSummary?.trim() || '更新指标');
    return {
      status: 'ok',
      metric,
      recalculationRequired:
        input.formula !== undefined ||
        input.aggregation !== undefined ||
        input.dimensions !== undefined,
    };
  }

  listMetricVersions(id: string, workspaceId: string): Record<string, unknown>[] | null {
    if (!this.#metricRow(id, workspaceId)) return null;
    const rows = this.#db
      .stmt(
        `SELECT v.id, v.version, v.definition_json, v.change_summary, u.name AS created_by_name,
                v.created_at
         FROM metric_versions v LEFT JOIN users u ON u.id = v.created_by
         WHERE v.metric_id = ? ORDER BY v.version DESC LIMIT 100`,
      )
      .all(id) as unknown as {
      id: string;
      version: number;
      definition_json: string;
      change_summary: string;
      created_by_name: string | null;
      created_at: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      version: Number(row.version),
      definition: JSON.parse(row.definition_json) as unknown,
      changeSummary: row.change_summary,
      createdByName: row.created_by_name,
      createdAt: row.created_at,
    }));
  }

  #rawBuckets(from: string, to: string, groupBy: GroupBy): Map<string, BucketTotals> {
    const buckets = new Map<string, BucketTotals>();
    const ensure = (bucket: string): BucketTotals => {
      const existing = buckets.get(bucket);
      if (existing) return existing;
      const created = emptyTotals();
      buckets.set(bucket, created);
      return created;
    };
    const rows = this.#db
      .stmt(
        `SELECT date, revenue_cents, customers, conversions, visitors
         FROM daily_metrics WHERE date >= ? AND date <= ? ORDER BY date ASC`,
      )
      .all(from, to) as unknown as {
      date: string;
      revenue_cents: number;
      customers: number;
      conversions: number;
      visitors: number;
    }[];
    for (const row of rows) {
      const totals = ensure(bucketOf(row.date, groupBy));
      totals.revenue_cents += Number(row.revenue_cents);
      totals.customers += Number(row.customers);
      totals.conversions += Number(row.conversions);
      totals.visitors += Number(row.visitors);
    }
    const sessions = this.#db
      .stmt(
        `SELECT date, SUM(sessions) AS sessions FROM channel_daily
         WHERE date >= ? AND date <= ? GROUP BY date ORDER BY date ASC`,
      )
      .all(from, to) as unknown as { date: string; sessions: number }[];
    for (const row of sessions) {
      ensure(bucketOf(row.date, groupBy)).sessions += Number(row.sessions);
    }
    return buckets;
  }

  #seriesFor(
    metric: MetricRow,
    from: string,
    to: string,
    groupBy: GroupBy,
    path: Set<string>,
    warnings: Set<string>,
  ): Map<string, number | null> {
    if (path.has(metric.name)) {
      warnings.add(`指标循环引用：${metric.name}`);
      return new Map();
    }
    const nextPath = new Set(path).add(metric.name);
    const raw = this.#rawBuckets(from, to, groupBy);
    const referenced = new Map<string, Map<string, number | null>>();
    let parsed: ReturnType<typeof parseFormula>;
    try {
      parsed = parseFormula(metric.formula);
    } catch (error) {
      warnings.add(error instanceof Error ? error.message : '公式无效');
      return new Map();
    }
    for (const name of parsed.metrics) {
      const dependency = this.#metricByName(metric.workspace_id, name);
      if (!dependency) {
        warnings.add(`引用的指标不存在：${name}`);
        continue;
      }
      referenced.set(name, this.#seriesFor(dependency, from, to, groupBy, nextPath, warnings));
    }
    const buckets = new Set<string>(raw.keys());
    for (const series of referenced.values()) {
      for (const bucket of series.keys()) buckets.add(bucket);
    }
    const result = new Map<string, number | null>();
    for (const bucket of [...buckets].sort()) {
      const totals = raw.get(bucket) ?? emptyTotals();
      const values = new Map<string, number>([
        ['revenue_cents', totals.revenue_cents],
        ['revenue', totals.revenue_cents / 100],
        ['customers', totals.customers],
        ['conversions', totals.conversions],
        ['visitors', totals.visitors],
        ['sessions', totals.sessions],
      ]);
      const resolveMetric = (name: string): number | null => {
        const series = referenced.get(name);
        if (!series) return null;
        return series.get(bucket) ?? null;
      };
      const value = evaluateNode(parsed.node, values, resolveMetric);
      result.set(
        bucket,
        value === null || !Number.isFinite(value) ? null : Number(value.toFixed(4)),
      );
    }
    return result;
  }

  evaluateMetric(
    id: string,
    workspaceId: string,
    input: { from: string; to: string; groupBy?: GroupBy },
  ): MetricEvaluation | null {
    const metric = this.#metricRow(id, workspaceId);
    if (!metric) return null;
    const groupBy = input.groupBy ?? 'day';
    const warnings = new Set<string>();
    if (input.from > input.to) {
      warnings.add('开始日期不能晚于结束日期');
      return {
        metricId: metric.id,
        name: metric.name,
        unit: metric.unit,
        from: input.from,
        to: input.to,
        value: null,
        series: [],
        dependencies: [],
        warnings: [...warnings],
        refreshMinutes: Number(metric.refresh_minutes ?? 60),
        source: metric.source,
      };
    }
    const seriesMap = this.#seriesFor(metric, input.from, input.to, groupBy, new Set(), warnings);
    const series: MetricPoint[] = [...seriesMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([bucket, value]) => ({ bucket, value }));
    const values = series
      .map((point) => point.value)
      .filter((value): value is number => value !== null);
    const aggregation = AGGREGATIONS.has(metric.aggregation) ? metric.aggregation : 'sum';
    let value: number | null = null;
    if (aggregation === 'count') value = values.length;
    else if (values.length > 0) {
      if (aggregation === 'sum') value = values.reduce((sum, item) => sum + item, 0);
      else if (aggregation === 'avg') {
        value = values.reduce((sum, item) => sum + item, 0) / values.length;
      } else if (aggregation === 'min') value = Math.min(...values);
      else value = Math.max(...values);
      value = Number(value.toFixed(2));
    }
    let dependencies: string[] = [];
    try {
      dependencies = parseFormula(metric.formula).metrics;
    } catch {
      dependencies = [];
    }
    return {
      metricId: metric.id,
      name: metric.name,
      unit: metric.unit,
      from: input.from,
      to: input.to,
      value,
      series,
      dependencies,
      warnings: [...warnings],
      refreshMinutes: Number(metric.refresh_minutes ?? 60),
      source: metric.source,
    };
  }

  #budgetRow(projectId: string, workspaceId: string): BudgetRow | null {
    const row = this.#db
      .stmt(
        `SELECT b.id, b.project_id, p.name AS project_name, b.cost_center, b.currency,
                b.budget_cents, b.committed_cents, b.actual_cents, b.forecast_cents, b.fx_rate,
                b.fx_date, b.threshold_pct, b.version, b.created_at, b.updated_at
         FROM project_budgets b JOIN projects p ON p.id = b.project_id
         WHERE b.project_id = ? AND p.workspace_id = ? AND p.deleted_at IS NULL`,
      )
      .get(projectId, workspaceId) as unknown as BudgetRow | undefined;
    return row ?? null;
  }

  #entries(budgetId: string): EntryRow[] {
    return this.#db
      .stmt(
        `SELECT id, budget_id, kind, amount_cents, currency, fx_rate, fx_date, note, created_at
         FROM budget_entries WHERE budget_id = ? ORDER BY created_at DESC LIMIT 500`,
      )
      .all(budgetId) as unknown as EntryRow[];
  }

  listBudgets(workspaceId: string, visible: Set<string> | null): BudgetSummary[] {
    const rows = this.#db
      .stmt(
        `SELECT b.id, b.project_id, p.name AS project_name, b.cost_center, b.currency,
                b.budget_cents, b.committed_cents, b.actual_cents, b.forecast_cents, b.fx_rate,
                b.fx_date, b.threshold_pct, b.version, b.created_at, b.updated_at
         FROM project_budgets b JOIN projects p ON p.id = b.project_id
         WHERE p.workspace_id = ? AND p.deleted_at IS NULL
         ORDER BY p.name ASC`,
      )
      .all(workspaceId) as unknown as BudgetRow[];
    return rows
      .filter((row) => !visible || visible.has(row.project_id))
      .map((row) => budgetSummary(row, this.#entries(row.id)));
  }

  budgetSummary(projectId: string, workspaceId: string): BudgetSummary | null {
    const row = this.#budgetRow(projectId, workspaceId);
    return row ? budgetSummary(row, this.#entries(row.id)) : null;
  }

  upsertBudget(
    projectId: string,
    workspaceId: string,
    input: BudgetInput,
    actor: UserOption,
  ): BudgetResult {
    const project = this.#db
      .stmt(
        'SELECT 1 AS present FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL',
      )
      .get(projectId, workspaceId) as unknown as { present: number } | undefined;
    if (!project) return { status: 'missing' };
    if (input.currency && !CURRENCIES.includes(input.currency)) {
      return { status: 'invalid', message: '币种无效' };
    }
    const current = this.#budgetRow(projectId, workspaceId);
    const now = new Date().toISOString();
    if (current) {
      if (input.version === undefined) {
        return { status: 'invalid', message: '更新预算时必须提供版本号' };
      }
      const sets = ['updated_at = ?', 'version = version + 1'];
      const params: (string | number | null)[] = [now];
      const fields: [keyof BudgetInput, string, (value: unknown) => unknown][] = [
        ['costCenter', 'cost_center', (value) => String(value).trim()],
        ['currency', 'currency', (value) => value],
        ['budgetCents', 'budget_cents', (value) => value],
        ['forecastCents', 'forecast_cents', (value) => value],
        ['fxRate', 'fx_rate', (value) => value],
        ['fxDate', 'fx_date', (value) => value ?? null],
        ['thresholdPct', 'threshold_pct', (value) => value],
      ];
      for (const [key, column, cast] of fields) {
        if (input[key] !== undefined) {
          sets.push(`${column} = ?`);
          params.push(cast(input[key]) as string | number | null);
        }
      }
      params.push(current.id, input.version);
      const updated = this.#db
        .stmt(
          `UPDATE project_budgets SET ${sets.join(', ')}
           WHERE id = ? AND version = ? RETURNING id`,
        )
        .get(...params) as unknown as { id: string } | undefined;
      if (!updated) {
        return { status: 'conflict', current: toBudget(current) };
      }
    } else {
      this.#db
        .stmt(
          `INSERT INTO project_budgets
             (id, project_id, cost_center, currency, budget_cents, committed_cents, actual_cents,
              forecast_cents, fx_rate, fx_date, threshold_pct, version, created_by, created_at,
              updated_at)
           VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .run(
          crypto.randomUUID(),
          projectId,
          input.costCenter?.trim() ?? '',
          input.currency ?? 'USD',
          input.budgetCents ?? 0,
          input.forecastCents ?? 0,
          input.fxRate ?? 1,
          input.fxDate ?? null,
          input.thresholdPct ?? 80,
          actor.id,
          now,
          now,
        );
    }
    const summary = this.budgetSummary(projectId, workspaceId);
    if (!summary) throw new Error('budget write failed');
    return { status: 'ok', summary };
  }

  addBudgetEntry(
    projectId: string,
    workspaceId: string,
    input: BudgetEntryInput,
    actor: UserOption,
  ): EntryResult {
    const budget = this.#budgetRow(projectId, workspaceId);
    if (!budget) return { status: 'missing' };
    if (input.currency && !CURRENCIES.includes(input.currency)) {
      return { status: 'invalid', message: '币种无效' };
    }
    if (input.idempotencyKey) {
      const existing = this.#db
        .stmt('SELECT budget_id FROM budget_entries WHERE idempotency_key = ?')
        .get(input.idempotencyKey) as unknown as { budget_id: string } | undefined;
      if (existing) {
        if (existing.budget_id !== budget.id) {
          return { status: 'invalid', message: '幂等键已被其他预算使用' };
        }
        const summary = this.budgetSummary(projectId, workspaceId);
        return summary ? { status: 'ok', summary, replayed: true } : { status: 'missing' };
      }
    }
    const currency = input.currency ?? (budget.currency as CurrencyCode);
    const fxRate = input.fxRate ?? Number(budget.fx_rate);
    if (!(fxRate > 0) || !Number.isFinite(fxRate)) {
      return { status: 'invalid', message: '汇率必须大于 0' };
    }
    const converted = Math.round(input.amountCents * fxRate);
    const now = new Date().toISOString();
    this.#db.transaction(() => {
      this.#db
        .stmt(
          `INSERT INTO budget_entries
             (id, budget_id, kind, amount_cents, currency, fx_rate, fx_date, note,
              idempotency_key, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          crypto.randomUUID(),
          budget.id,
          input.kind,
          input.amountCents,
          currency,
          fxRate,
          input.fxDate ?? null,
          input.note?.trim() ?? '',
          input.idempotencyKey ?? null,
          actor.id,
          now,
        );
      const column =
        input.kind === 'committed'
          ? 'committed_cents'
          : input.kind === 'actual'
            ? 'actual_cents'
            : 'forecast_cents';
      this.#db
        .stmt(
          `UPDATE project_budgets
           SET ${column} = ${column} + ?, updated_at = ?, version = version + 1
           WHERE id = ?`,
        )
        .run(converted, now, budget.id);
    });
    const summary = this.budgetSummary(projectId, workspaceId);
    if (!summary) throw new Error('budget entry write failed');
    return { status: 'ok', summary, replayed: false };
  }
}
