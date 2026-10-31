import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import type { OcrEngine } from '../shared/types.ts';
import { DEMO, testStore } from './helpers.ts';

const ENGINES: readonly OcrEngine[] = ['paddle'];

function createAttachment(store: ReturnType<typeof testStore>, name: string): string {
  const user = store.users.authByEmail(DEMO.admin.email);
  assert.ok(user);
  const project = store.projects.create(
    { name: `lease-${name}` },
    { id: user.id, name: user.name },
  );
  const id = randomUUID();
  store.attachments.create({
    id,
    projectId: project.id,
    uploaderId: user.id,
    name,
    mime: 'image/png',
    size: 1024,
    storedName: `stored-${id}.bin`,
    sha256: id.replaceAll('-', '').padEnd(64, '0'),
    createdAt: new Date('2026-06-15T12:00:00.000Z').toISOString(),
    ocrTarget: 'paddle',
  });
  return id;
}

describe('OCR worker lease', () => {
  test('claiming a job sets a lease and blocks a second worker', (t) => {
    const store = testStore();
    t.after(() => store.close());
    const id = createAttachment(store, 'claim.png');
    const now = new Date('2026-06-15T12:00:00.000Z');
    const leaseUntil = new Date(now.getTime() + 120_000).toISOString();
    const claimed = store.attachments.claimNext(now.toISOString(), ENGINES, leaseUntil);
    assert.equal(claimed?.id, id);
    assert.equal(claimed?.ocrStatus, 'processing');
    assert.equal(claimed?.ocrAttempts, 1);
    const row = store.db
      .stmt('SELECT ocr_lease_until FROM attachments WHERE id = ?')
      .get(id) as unknown as { ocr_lease_until: string };
    assert.equal(row.ocr_lease_until, leaseUntil);
    // The same row cannot be claimed again while it is processing.
    assert.equal(
      store.attachments.claimNext(
        new Date(now.getTime() + 1_000).toISOString(),
        ENGINES,
        leaseUntil,
      ),
      null,
    );
  });

  test('heartbeat extends the lease of a running job', (t) => {
    const store = testStore();
    t.after(() => store.close());
    const id = createAttachment(store, 'heartbeat.png');
    const now = new Date('2026-06-15T12:00:00.000Z');
    const claim = store.attachments.claimNext(
      now.toISOString(),
      ENGINES,
      new Date(now.getTime() + 120_000).toISOString(),
    );
    assert.equal(claim?.id, id);
    const renewed = new Date(now.getTime() + 240_000).toISOString();
    store.attachments.renewOcrLease(id, renewed);
    const row = store.db
      .stmt('SELECT ocr_lease_until, ocr_updated_at FROM attachments WHERE id = ?')
      .get(id) as unknown as { ocr_lease_until: string; ocr_updated_at: string };
    assert.equal(row.ocr_lease_until, renewed);
    assert.equal(row.ocr_updated_at, now.toISOString());
    // Recovery leaves live leases alone but requeues expired ones.
    const between = new Date(now.getTime() + 150_000).toISOString();
    assert.equal(store.attachments.recoverProcessing(between, '中断', between), 0);
    const afterExpiry = new Date(now.getTime() + 300_000).toISOString();
    assert.equal(store.attachments.recoverProcessing(afterExpiry, '中断', afterExpiry), 1);
    assert.equal(store.attachments.find(id)?.ocrStatus, 'pending');
  });

  test('a dead worker is replaced once its lease expires', (t) => {
    const store = testStore();
    t.after(() => store.close());
    const id = createAttachment(store, 'dead.png');
    const now = new Date('2026-06-15T12:00:00.000Z');
    store.attachments.claimNext(
      now.toISOString(),
      ENGINES,
      new Date(now.getTime() + 120_000).toISOString(),
    );
    // Second worker starts 3 minutes later: the first lease has expired.
    const later = new Date(now.getTime() + 180_000).toISOString();
    assert.equal(
      store.attachments.recoverProcessing(later, '上次识别被中断，已重新排队', later),
      1,
    );
    const reclaimed = store.attachments.claimNext(
      later,
      ENGINES,
      new Date(Date.parse(later) + 120_000).toISOString(),
    );
    assert.equal(reclaimed?.id, id);
    assert.equal(reclaimed?.ocrAttempts, 2);
  });

  test('completion clears the lease', (t) => {
    const store = testStore();
    t.after(() => store.close());
    const id = createAttachment(store, 'complete.png');
    const now = new Date('2026-06-15T12:00:00.000Z').toISOString();
    store.attachments.claimNext(now, ENGINES, new Date(Date.parse(now) + 120_000).toISOString());
    store.attachments.completeOcr(
      id,
      {
        text: '合计 1280',
        confidence: 0.9,
        model: 'pp-ocr',
        engineModel: 'PP-OCRv5',
        configHash: 'abcdef',
        seconds: 1,
        pages: 1,
        truncated: false,
      },
      now,
    );
    const row = store.db
      .stmt('SELECT ocr_lease_until, ocr_config_hash FROM attachments WHERE id = ?')
      .get(id) as unknown as { ocr_lease_until: string | null; ocr_config_hash: string | null };
    assert.equal(row.ocr_lease_until, null);
    assert.equal(row.ocr_config_hash, 'abcdef');
  });

  test('legacy processing rows without a lease still recover by age', (t) => {
    const store = testStore();
    t.after(() => store.close());
    const id = createAttachment(store, 'legacy.png');
    const now = new Date('2026-06-15T12:00:00.000Z');
    store.attachments.claimNext(now.toISOString(), ENGINES, now.toISOString());
    // Simulate a pre-lease row: drop the lease and backdate the update.
    store.db
      .stmt('UPDATE attachments SET ocr_lease_until = NULL, ocr_updated_at = ? WHERE id = ?')
      .run(new Date(now.getTime() - 10 * 60_000).toISOString(), id);
    const recovered = store.attachments.recoverProcessing(
      new Date(now.getTime() - 60_000).toISOString(),
      '中断',
      now.toISOString(),
    );
    assert.equal(recovered, 1);
    assert.equal(store.attachments.find(id)?.ocrStatus, 'pending');
  });
});
