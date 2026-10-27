import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..');

function runServer(
  env: Record<string, string>,
  waitFor?: RegExp,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/server.ts'], {
      cwd: root,
      env: { ...process.env, LOG_LEVEL: 'info', PORT: '0', ...env },
    });
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`server did not exit or start in time:\n${output}`));
    }, 30_000);

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output });
    };

    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (waitFor?.test(output)) child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => finish(code));
  });
}

test('non-demo startup fails without bootstrap admin credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clay-startup-'));
  try {
    const { code, output } = await runServer({
      DEMO_MODE: '0',
      DB_PATH: join(dir, 'db.sqlite'),
    });
    assert.equal(code, 1);
    assert.match(output, /ADMIN_EMAIL/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('non-demo startup succeeds with bootstrap admin credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clay-startup-'));
  try {
    const { code, output } = await runServer(
      {
        DEMO_MODE: '0',
        ADMIN_EMAIL: 'owner@clay.test',
        ADMIN_PASSWORD: 'Owner1234!',
        DB_PATH: join(dir, 'db.sqlite'),
      },
      /server\.start/,
    );
    assert.equal(code, 0);
    assert.match(output, /server\.start/);
    assert.doesNotMatch(output, /server\.bootstrap/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
