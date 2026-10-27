#!/usr/bin/env node
// Create a consistent snapshot with VACUUM INTO (safe while the server is running).
// Usage: node scripts/backup.mjs [db-path] [backup-dir]
// Defaults: DB_PATH (or data/pulse.db) and <db dir>/backups.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dbPath = resolve(process.argv[2] ?? process.env.DB_PATH ?? 'data/pulse.db');
const backupDir = resolve(process.argv[3] ?? resolve(dirname(dbPath), 'backups'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = resolve(backupDir, `manual-${stamp}.db`);

mkdirSync(backupDir, { recursive: true });
const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
} finally {
  db.close();
}
console.log(target);
