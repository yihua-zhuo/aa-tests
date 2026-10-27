import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const script = join(import.meta.dirname, '..', 'scripts', 'check-runtime.mjs');

function run(root: string) {
  return spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
}

function fixture(files: {
  nvmrc?: string;
  pkg?: Record<string, unknown>;
  lock?: Record<string, unknown>;
}): string {
  const dir = mkdtempSync(join(tmpdir(), 'clay-runtime-'));
  const pkg = {
    name: 'fixture',
    version: '1.0.0',
    engines: { node: '>=24.0.0 <27' },
    ...files.pkg,
  };
  const lock = {
    name: 'fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'fixture', version: '1.0.0' } },
    ...files.lock,
  };
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lock));
  writeFileSync(join(dir, '.nvmrc'), files.nvmrc ?? '26.12.1\n');
  return dir;
}

test('the repository satisfies its own runtime and lockfile policy', () => {
  const result = run(join(import.meta.dirname, '..'));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /runtime: Node \d+\.\d+\.\d+ satisfies >=24\.0\.0 <27/);
  assert.match(result.stdout, /lockfile: v3, \d+ registry packages carry sha512 integrity hashes/);
});

test('runtime check rejects a Node version outside the supported range', () => {
  const dir = fixture({ nvmrc: '23.9.0\n' });
  try {
    const result = run(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\.nvmrc 23\.9\.0 does not satisfy engines\.node/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime check rejects a stale lockfile version', () => {
  const dir = fixture({ lock: { lockfileVersion: 2 } });
  try {
    const result = run(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /lockfileVersion is 2, expected 3/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime check catches dependency drift between package.json and the lockfile', () => {
  const dir = fixture({ pkg: { dependencies: { hono: '^4.13.13' } } });
  try {
    const result = run(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /dependencies\.hono is missing from the lockfile root/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime check rejects registry packages without integrity hashes', () => {
  const dir = fixture({
    lock: {
      packages: {
        '': { name: 'fixture', version: '1.0.0' },
        'node_modules/foo': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/foo/-/foo-1.0.0.tgz',
        },
      },
    },
  });
  try {
    const result = run(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /node_modules\/foo is missing a sha512 integrity hash/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
