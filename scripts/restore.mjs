#!/usr/bin/env node
// Restore a consistent snapshot produced by VACUUM INTO.
// Usage: node scripts/restore.mjs <backup.db> [target.db] [--force]
// The server must be stopped before the target database is replaced.
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2).filter((arg) => arg !== '--force');
const force = process.argv.includes('--force');
const root = resolve(import.meta.dirname, '..');
const backup = args[0] ? resolve(args[0]) : '';
const target = resolve(args[1] ?? process.env.DB_PATH ?? `${root}/data/pulse.db`);

function fail(message) {
  console.error(`restore: ${message}`);
  process.exit(1);
}

function verify(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare('PRAGMA quick_check').all();
    const value = rows[0]?.quick_check;
    if (value !== 'ok') throw new Error(`quick_check returned ${value}`);
  } finally {
    db.close();
  }
}

if (!args[0]) fail('usage: node scripts/restore.mjs <backup.db> [target.db] [--force]');
if (!existsSync(backup)) fail(`backup not found: ${backup}`);
verify(backup);

mkdirSync(dirname(target), { recursive: true });
if (existsSync(target) && !force) {
  fail(`${target} already exists; pass --force to replace it (a pre-restore copy is kept)`);
}

if (existsSync(target)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
  const aside = `${target}.pre-restore-${stamp}`;
  renameSync(target, aside);
  rmSync(`${target}-wal`, { force: true });
  rmSync(`${target}-shm`, { force: true });
  console.log(`previous database kept at ${aside}`);
}

copyFileSync(backup, target);
rmSync(`${target}-wal`, { force: true });
rmSync(`${target}-shm`, { force: true });
verify(target);
console.log(`restored ${backup} -> ${target}`);
