#!/usr/bin/env node
// Compares SQLite LIKE scans against the FTS5 trigram index on the project table.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.ts';

process.env.LOG_LEVEL = 'silent';

const ROWS = Number(process.env.ROWS ?? 20_000);
const ROUNDS = Number(process.env.ROUNDS ?? 300);
const QUERIES = ['project-1234', 'project-4321', 'project-2500', 'project-4999'];
const dir = mkdtempSync(join(tmpdir(), 'clay-bench-'));
const path = join(dir, 'bench.db');

const store = new Store(path, { demo: false });
const admin = store.db.stmt("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
const insert = store.db.stmt(
  `INSERT INTO projects (id, name, description, status, progress, owner_id, created_at, updated_at)
   VALUES (?, ?, '', 'active', 0, ?, ?, ?)`,
);
const now = new Date().toISOString();
const names = [
  'release',
  'deploy',
  'roadmap',
  'incident',
  'meeting',
  'review',
  'design',
  'research',
];

store.db.transaction(() => {
  for (let index = 0; index < ROWS; index++) {
    const name = `${names[index % names.length]} project ${index} code project-${index}`;
    insert.run(`bench-${index}`, name, admin.id, now, now);
  }
});
store.close();

const raw = new DatabaseSync(path);
const like = raw.prepare(
  "SELECT count(*) AS n FROM projects WHERE name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\'",
);
const match = raw.prepare(
  'SELECT count(*) AS n FROM projects WHERE rowid IN (SELECT rowid FROM projects_fts WHERE projects_fts MATCH ?)',
);

function time(label, statement, build) {
  const started = performance.now();
  let hits = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const query = build(QUERIES[round % QUERIES.length]);
    const row = statement.get(...query);
    hits += Number(row.n);
  }
  const total = performance.now() - started;
  console.log(
    `${label.padEnd(4)} ${(total / ROUNDS).toFixed(3)} ms/query  (${hits} rows matched across ${ROUNDS} queries)`,
  );
  return total / ROUNDS;
}

console.log(`rows: ${ROWS}  rounds: ${ROUNDS}  queries: ${QUERIES.join(', ')}`);
const likeMs = time('LIKE', like, (q) => [`%${q}%`, `%${q}%`]);
const ftsMs = time('FTS', match, (q) => [`"${q}"`]);
console.log(`speedup: ${(likeMs / ftsMs).toFixed(2)}x`);

raw.close();
rmSync(dir, { recursive: true, force: true });
