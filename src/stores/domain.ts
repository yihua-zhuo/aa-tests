import { randomUUID } from 'node:crypto';
import type { DomainRecord } from '../../shared/types.ts';
import type { Database } from '../db.ts';

export type DomainTableOptions = {
  /** DB columns that store JSON text (e.g. required_materials_json). */
  json?: string[];
  /** DB columns that store 0/1. */
  bool?: string[];
  /** Allowed DB column base names (snake_case, without the _json suffix). */
  columns?: string[];
  versioned?: boolean;
  /** Whether the table has created_at / updated_at columns. */
  created?: boolean;
  updated?: boolean;
  order?: string;
  search?: string[];
};

export function toCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}

export function toSnake(key: string): string {
  return key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

export function parseJsonValue<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw !== 'string') return raw as T;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

type SqlValue = null | number | bigint | string | NodeJS.ArrayBufferView;

const SCOPED_COLUMNS = new Set([
  'workspace_id',
  'project_id',
  'task_id',
  'document_id',
  'deliverable_id',
  'blocker_id',
  'meeting_id',
  'channel_id',
  'portal_id',
  'workflow_id',
  'run_id',
  'gate_id',
  'closure_id',
  'budget_id',
  'request_id',
  'subscription_id',
  'metric_id',
  'rule_id',
  'event_id',
  'org_id',
  'created_by',
]);

export type DomainUpdateResult =
  | { status: 'ok'; record: DomainRecord }
  | { status: 'missing' }
  | { status: 'invalid'; message: string }
  | { status: 'conflict'; current: DomainRecord };

export class DomainTable {
  readonly #db: Database;
  readonly table: string;
  readonly #json: Set<string>;
  readonly #bool: Set<string>;
  readonly #columns: Set<string> | null;
  readonly #versioned: boolean;
  readonly #created: boolean;
  readonly #updated: boolean;
  readonly #order: string;
  readonly #search: string[];

  constructor(db: Database, table: string, options: DomainTableOptions = {}) {
    this.#db = db;
    this.table = table;
    this.#json = new Set(options.json ?? []);
    this.#bool = new Set(options.bool ?? []);
    this.#columns = options.columns ? new Set(options.columns) : null;
    this.#versioned = options.versioned ?? false;
    this.#created = options.created ?? true;
    this.#updated = options.updated ?? true;
    this.#order = options.order ?? 'created_at DESC';
    this.#search = options.search ?? [];
  }

  /** Map a camelCase input key to the real DB column. */
  #columnFor(key: string): string {
    const base = toSnake(key);
    if (this.#json.has(base)) return base;
    if (this.#json.has(`${base}_json`)) return `${base}_json`;
    return base;
  }

  #allowed(column: string): boolean {
    if (SCOPED_COLUMNS.has(column)) return true;
    if (this.#json.has(column)) return true;
    if (!this.#columns) return true;
    if (this.#columns.has(column)) return true;
    return this.#columns.has(column.replace(/_json$/, ''));
  }

  #encode(column: string, value: unknown): unknown {
    if (this.#bool.has(column)) return value ? 1 : 0;
    if (this.#json.has(column)) {
      return typeof value === 'string' ? value : JSON.stringify(value ?? null);
    }
    if (value !== null && typeof value === 'object') return JSON.stringify(value);
    return value;
  }

  #decode(row: Record<string, unknown>): DomainRecord {
    const record: DomainRecord = { id: String(row.id) };
    for (const [key, value] of Object.entries(row)) {
      if (key === 'id') continue;
      const field = toCamel(key);
      if (this.#json.has(key)) record[field] = parseJsonValue(value, null);
      else if (this.#bool.has(key)) record[field] = Boolean(value);
      else record[field] = value;
    }
    if ('version' in record) record.version = Number(record.version);
    return record;
  }

  get(id: string): DomainRecord | undefined {
    const row = this.#db.stmt(`SELECT * FROM ${this.table} WHERE id = ?`).get(id) as unknown as
      | Record<string, unknown>
      | undefined;
    return row ? this.#decode(row) : undefined;
  }

  find(where: string, params: unknown[] = []): DomainRecord | undefined {
    const row = this.#db
      .stmt(`SELECT * FROM ${this.table} WHERE ${where} LIMIT 1`)
      .get(...(params as SqlValue[])) as unknown as Record<string, unknown> | undefined;
    return row ? this.#decode(row) : undefined;
  }

  list(
    where = '1 = 1',
    params: unknown[] = [],
    options: { limit?: number; offset?: number; order?: string; q?: string } = {},
  ): { items: DomainRecord[]; total: number } {
    const clauses = [where];
    const values = [...params];
    const q = options.q?.trim();
    if (q && this.#search.length) {
      const likes = this.#search.map((column) => `COALESCE(${column}, '') LIKE ?`);
      clauses.push(`(${likes.join(' OR ')})`);
      for (const _column of this.#search) values.push(`%${q}%`);
    }
    const filter = clauses.join(' AND ');
    const total = Number(
      (
        this.#db
          .stmt(`SELECT COUNT(*) AS count FROM ${this.table} WHERE ${filter}`)
          .get(...(values as SqlValue[])) as unknown as { count: number }
      ).count,
    );
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);
    const rows = this.#db
      .stmt(
        `SELECT * FROM ${this.table} WHERE ${filter} ORDER BY ${options.order ?? this.#order} LIMIT ? OFFSET ?`,
      )
      .all(...(values as SqlValue[]), limit, offset) as unknown as Record<string, unknown>[];
    return { items: rows.map((row) => this.#decode(row)), total };
  }

  create(input: Record<string, unknown>, now: string): DomainRecord {
    const usable: { column: string; value: unknown }[] = [];
    for (const [key, value] of Object.entries(input)) {
      if (['resource', 'version', 'id', 'createdAt', 'updatedAt'].includes(key)) continue;
      if (value === undefined) continue;
      const column = this.#columnFor(key);
      if (!this.#allowed(column)) continue;
      usable.push({ column, value: this.#encode(column, value) });
    }
    const columns = ['id', ...usable.map((item) => item.column)];
    const values: unknown[] = [randomUUID(), ...usable.map((item) => item.value)];
    if (this.#created) {
      columns.push('created_at');
      values.push(now);
    }
    if (this.#updated) {
      columns.push('updated_at');
      values.push(now);
    }
    if (this.#versioned) {
      columns.push('version');
      values.push(1);
    }
    const placeholders = columns.map(() => '?').join(', ');
    this.#db
      .stmt(`INSERT INTO ${this.table} (${columns.join(', ')}) VALUES (${placeholders})`)
      .run(...(values as SqlValue[]));
    return this.get(values[0] as string) as DomainRecord;
  }

  update(id: string, input: Record<string, unknown>, now: string): DomainUpdateResult {
    const exists = this.get(id);
    if (!exists) return { status: 'missing' };
    const currentVersion = Number(exists.version ?? 0);
    const requestedVersion = input.version === undefined ? currentVersion : Number(input.version);
    if (this.#versioned && requestedVersion !== currentVersion) {
      return { status: 'conflict', current: exists };
    }
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(input)) {
      if (['resource', 'id', 'version', 'createdAt', 'updatedAt'].includes(key)) continue;
      if (value === undefined) continue;
      const column = this.#columnFor(key);
      if (!this.#allowed(column)) continue;
      assignments.push(`${column} = ?`);
      values.push(this.#encode(column, value));
    }
    if (assignments.length === 0) return { status: 'invalid', message: '没有可更新的字段' };
    if (this.#updated) {
      assignments.push('updated_at = ?');
      values.push(now);
    }
    if (this.#versioned) assignments.push('version = version + 1');
    values.push(id);
    if (this.#versioned) values.push(currentVersion);
    const where = this.#versioned ? 'id = ? AND version = ?' : 'id = ?';
    const row = this.#db
      .stmt(`UPDATE ${this.table} SET ${assignments.join(', ')} WHERE ${where} RETURNING *`)
      .get(...(values as SqlValue[])) as unknown as Record<string, unknown> | undefined;
    if (!row) return { status: 'conflict', current: this.get(id) ?? exists };
    return { status: 'ok', record: this.#decode(row) };
  }

  remove(id: string): boolean {
    const result = this.#db.stmt(`DELETE FROM ${this.table} WHERE id = ?`).run(id as SqlValue);
    return Number(result.changes) > 0;
  }

  raw(): Database {
    return this.#db;
  }
}
