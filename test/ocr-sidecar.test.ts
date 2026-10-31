import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const python = process.env.OCR_PYTHON ?? 'python3';
const probe = spawnSync(python, ['--version'], { encoding: 'utf8' });

test('sidecar DIR routing helpers pass their self-test', {
  skip: probe.status !== 0 ? 'python3 is not available' : false,
}, () => {
  const result = spawnSync(python, ['scripts/ocr_sidecar_selftest.py'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /ocr_sidecar selftest: ok/);
});
