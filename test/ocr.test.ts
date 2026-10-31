import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { Attachment, AttachmentList, AttachmentOcr, OcrExport } from '../shared/types.ts';
import type { AppOptions } from '../src/app.ts';
import { OcrClient, ocrCandidateEnginesFor, ocrConfigFingerprint } from '../src/ocr.ts';
import { OcrWorker } from '../src/ocr-worker.ts';
import { Store } from '../src/store.ts';
import {
  authHeaders,
  DEMO,
  login,
  multipart,
  sendJson,
  TEST_NOW,
  testApp,
  testStore,
} from './helpers.ts';

const PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lY5P3wAAAABJRU5ErkJggg==',
    'base64',
  ),
);

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const PDF = new Uint8Array(
  Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF', 'latin1'),
);

type ExtractBody = {
  path: string;
  name: string;
  mode?: string;
  dpi?: number;
  model?: string;
  lang?: string;
};
type FakeResponse = { status: number; payload: Record<string, unknown> };

describe('candidate engines', () => {
  test('fingerprints OCR settings that change output but not endpoints or tuning', () => {
    const base = { OCR_PADDLE_MODEL: 'PP-OCRv6', OCR_PDF_TIME_BUDGET_SECONDS: '90' };
    assert.equal(ocrConfigFingerprint(base), ocrConfigFingerprint({ ...base }));
    assert.notEqual(
      ocrConfigFingerprint(base),
      ocrConfigFingerprint({ ...base, OCR_PADDLE_MODEL: 'PP-OCRv5' }),
    );
    assert.equal(
      ocrConfigFingerprint(base),
      ocrConfigFingerprint({ ...base, OCR_PADDLE_URL: 'http://127.0.0.1:8080' }),
    );
    assert.equal(
      ocrConfigFingerprint(base),
      ocrConfigFingerprint({ ...base, OCR_DOCLING_TOKEN: 'secret' }),
    );
    assert.equal(
      ocrConfigFingerprint(base),
      ocrConfigFingerprint({ ...base, OCR_QUALITY_REVIEW_THRESHOLD: '0.8', HOME: '/tmp/x' }),
    );
  });

  test('maps formats to engines that can read the same file', () => {
    assert.deepEqual(ocrCandidateEnginesFor('scan.pdf', 'paddle'), ['docling']);
    assert.deepEqual(ocrCandidateEnginesFor('scan.PNG', 'paddle'), ['docling']);
    assert.deepEqual(ocrCandidateEnginesFor('scan.webp', 'paddle'), ['docling']);
    // Docling does not take GIF, so Paddle has no alternate engine there.
    assert.deepEqual(ocrCandidateEnginesFor('anim.gif', 'paddle'), []);
    assert.deepEqual(ocrCandidateEnginesFor('notes.docx', 'docling'), []);
  });

  test('only returns engines that are configured', () => {
    const paddleOnly = new OcrClient({ paddleUrl: 'http://127.0.0.1:9' });
    assert.deepEqual(paddleOnly.candidatesFor('paddle', 'scan.png'), []);
    const both = new OcrClient({
      paddleUrl: 'http://127.0.0.1:9',
      doclingUrl: 'http://127.0.0.1:9',
    });
    assert.deepEqual(both.candidatesFor('paddle', 'scan.png'), ['docling']);
    assert.deepEqual(both.candidatesFor('docling', 'scan.png'), ['paddle']);
    assert.deepEqual(both.candidatesFor('docling', 'notes.docx'), []);
  });
});

async function fakeOcr(
  initialModel = 'fake-model',
  modelProfiles: string[] = [],
): Promise<{
  url: string;
  calls: ExtractBody[];
  respond: (response: FakeResponse) => void;
  sequence: (responses: FakeResponse[]) => void;
  setModel: (model: string | null) => void;
  setPipeline: (pipeline: string | null) => void;
  setDelay: (ms: number) => void;
  close: () => Promise<void>;
}> {
  const calls: ExtractBody[] = [];
  let response: FakeResponse = {
    status: 200,
    payload: { text: '识别结果', engine: 'fake', model: initialModel, confidence: 0.9 },
  };
  const scripted: FakeResponse[] = [];
  let scriptedIndex = 0;
  let healthModel: string | null = initialModel;
  let healthPipeline: string | null = null;
  let delayMs = 0;

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            ...(healthModel ? { model: healthModel } : {}),
            ...(healthPipeline ? { pipeline: healthPipeline } : {}),
            ...(modelProfiles.length > 0 ? { model_profiles: modelProfiles } : {}),
          }),
        );
        return;
      }
      const body = raw ? (JSON.parse(raw) as ExtractBody) : ({ path: '', name: '' } as ExtractBody);
      calls.push(body);
      const finish = () => {
        if (res.destroyed || res.writableEnded) return;
        const next =
          scripted.length > 0 ? scripted[Math.min(scriptedIndex, scripted.length - 1)] : response;
        scriptedIndex += 1;
        try {
          res.writeHead(next.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(next.payload));
        } catch {
          // The client may abort mid-request during shutdown tests.
        }
      };
      if (delayMs > 0) {
        const timer = setTimeout(finish, delayMs);
        timer.unref();
      } else {
        finish();
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    respond: (next) => {
      response = next;
    },
    sequence: (responses) => {
      scripted.splice(0, scripted.length, ...responses);
      scriptedIndex = 0;
    },
    setModel: (next) => {
      healthModel = next;
    },
    setPipeline: (next) => {
      healthPipeline = next;
    },
    setDelay: (ms) => {
      delayMs = ms;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function fixture(options: AppOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'clay-ocr-'));
  const store = new Store(':memory:', {
    demo: true,
    demoAccounts: true,
    now: TEST_NOW,
    uploadDir: dir,
  });
  const { app } = testApp(store, options);

  async function createProject(name: string, memberIds: string[] = []) {
    const cookie = await login(app);
    const created = await sendJson<{ id: string }>(app, cookie, 'POST', '/api/projects', {
      name,
      memberIds,
    });
    assert.equal(created.status, 201);
    return { cookie, id: created.body.id };
  }

  async function upload(cookie: string, projectId: string, file: File): Promise<Attachment> {
    const res = await app.request(`/api/projects/${projectId}/attachments`, {
      method: 'POST',
      headers: authHeaders(cookie),
      body: multipart(file),
    });
    assert.equal(res.status, 201);
    return ((await res.json()) as { attachment: Attachment }).attachment;
  }

  async function readOcr(cookie: string, projectId: string, attachmentId: string) {
    const res = await app.request(`/api/projects/${projectId}/attachments/${attachmentId}/ocr`, {
      headers: authHeaders(cookie),
    });
    return { status: res.status, body: (await res.json()) as { ocr?: AttachmentOcr } };
  }

  return {
    store,
    app,
    createProject,
    upload,
    readOcr,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('attachment OCR', () => {
  test('parses shadow, glare, noise, skew, orientation and retake signals', async (t) => {
    const sidecar = await fakeOcr();
    t.after(sidecar.close);
    sidecar.respond({
      status: 200,
      payload: {
        text: '识别结果',
        engine: 'fake',
        model: 'fake-model',
        confidence: 0.9,
        preflight: {
          width: 1600,
          height: 2200,
          sharpness: 0.6,
          brightness: 0.55,
          contrast: 0.4,
          dpi: 300,
          shadow: 0.42,
          glare: 0.05,
          noise: 0.12,
          colorfulness: 0.2,
          skew: -4.5,
          issues: ['glare', 'shadow', 'skewed'],
          orientation: { exif: 6, applied: 90, aspect: 0.73, uncertain: false },
          retake: { required: true, reasons: ['glare'] },
        },
      },
    });
    const client = new OcrClient({ paddleUrl: sidecar.url });
    const extraction = await client.extract('paddle', { path: '/tmp/scan.png', name: 'scan.png' });
    assert.deepEqual(extraction.preflight, {
      width: 1600,
      height: 2200,
      sharpness: 0.6,
      brightness: 0.55,
      contrast: 0.4,
      dpi: 300,
      shadow: 0.42,
      glare: 0.05,
      noise: 0.12,
      colorfulness: 0.2,
      skew: -4.5,
      orientation: { exif: 6, applied: 90, aspect: 0.73, uncertain: false },
      issues: ['glare', 'shadow', 'skewed'],
      retake: { required: true, reasons: ['glare'] },
    });
  });

  test('ignores preflight payloads with no measured signal', async (t) => {
    const sidecar = await fakeOcr();
    t.after(sidecar.close);
    sidecar.respond({
      status: 200,
      payload: {
        text: '识别结果',
        engine: 'fake',
        model: 'fake-model',
        confidence: 0.9,
        preflight: { issues: [], retake: { required: false, reasons: [] } },
      },
    });
    const client = new OcrClient({ paddleUrl: sidecar.url });
    const extraction = await client.extract('paddle', { path: '/tmp/scan.png', name: 'scan.png' });
    assert.equal(extraction.preflight, null);
  });

  test('parses per-cell confidence from the document IR', async (t) => {
    const sidecar = await fakeOcr();
    t.after(sidecar.close);
    sidecar.respond({
      status: 200,
      payload: {
        text: '项目 金额\nA 100',
        engine: 'fake',
        model: 'fake-model',
        confidence: 0.9,
        route: 'visual',
        document: {
          version: 1,
          route: 'visual',
          pages: [
            {
              number: 1,
              width: 100,
              height: 100,
              blocks: [
                {
                  id: 't1',
                  type: 'table',
                  text: '项目 金额\nA 100',
                  bbox: { x: 0, y: 0, width: 100, height: 50 },
                  confidence: 0.9,
                  source: { engine: 'fake', model: 'fake-model', stage: 'visual' },
                  validation: null,
                  order: 0,
                  rows: [
                    ['项目', '金额'],
                    ['A', '100'],
                  ],
                  cells: [
                    { row: 0, column: 0, text: '项目', confidence: 0.97 },
                    { row: 0, column: 1, text: '金额', confidence: 0.55 },
                    { row: 1, column: 0, text: 'A', confidence: null },
                    { row: 1, column: 1, text: '100' },
                  ],
                },
              ],
              source: null,
            },
          ],
          readingOrder: ['t1'],
          meta: {},
        },
      },
    });
    const client = new OcrClient({ paddleUrl: sidecar.url });
    const extraction = await client.extract('paddle', {
      path: '/tmp/table.png',
      name: 'table.png',
    });
    const cells = extraction.document?.pages[0]?.blocks[0]?.cells;
    assert.deepEqual(
      cells?.map((cell) => cell.confidence ?? null),
      [0.97, 0.55, null, null],
    );
  });

  test('keeps ink gap page meta and reads an empty list as analyzed clean', async (t) => {
    const sidecar = await fakeOcr();
    t.after(sidecar.close);
    const block = {
      id: 'b1',
      type: 'paragraph',
      text: '季度报告',
      bbox: { x: 0, y: 0, width: 100, height: 20 },
      confidence: 0.9,
      source: { engine: 'fake', model: 'fake-model', stage: 'visual' },
      validation: null,
      order: 0,
    };
    sidecar.respond({
      status: 200,
      payload: {
        text: '季度报告',
        engine: 'fake',
        model: 'fake-model',
        confidence: 0.9,
        route: 'visual',
        document: {
          version: 1,
          route: 'visual',
          pages: [
            {
              number: 1,
              width: 100,
              height: 100,
              blocks: [block],
              source: null,
              meta: {
                inkGaps: [
                  {
                    id: 'p1-g0',
                    kind: 'cell',
                    blockId: 'b1',
                    bbox: { x: 10, y: 40, width: 60, height: 12 },
                    pixels: 120,
                    density: 0.42,
                  },
                  {
                    id: 'p1-g1',
                    kind: 'region',
                    bbox: { x: 0, y: 90, width: 50, height: 8 },
                    pixels: 0,
                    density: 2,
                  },
                  { kind: 'region', bbox: null, pixels: 50 },
                  null,
                ],
              },
            },
            {
              number: 2,
              width: 100,
              height: 100,
              blocks: [{ ...block, id: 'b2', order: 1 }],
              source: null,
              meta: { inkGaps: [] },
            },
            {
              number: 3,
              width: 100,
              height: 100,
              blocks: [{ ...block, id: 'b3', order: 2 }],
              source: null,
            },
          ],
          readingOrder: ['b1', 'b2', 'b3'],
          meta: {},
        },
      },
    });
    const client = new OcrClient({ paddleUrl: sidecar.url });
    const extraction = await client.extract('paddle', {
      path: '/tmp/scan.png',
      name: 'scan.png',
    });
    const pages = extraction.document?.pages ?? [];
    assert.deepEqual(pages[0]?.meta?.inkGaps, [
      {
        id: 'p1-g0',
        kind: 'cell',
        blockId: 'b1',
        bbox: { x: 10, y: 40, width: 60, height: 12 },
        pixels: 120,
        density: 0.42,
      },
    ]);
    assert.deepEqual(pages[1]?.meta?.inkGaps, []);
    assert.equal(pages[2]?.meta, undefined);
    // Every entry the payload could not describe is counted, including ones that
    // are not objects at all: dropping one silently would claim it was covered.
    assert.equal(pages[0]?.meta?.inkGapsDropped, 3);
  });

  test('classifies uploads by engine and enforces project access', async (t) => {
    const app = fixture();
    t.after(app.cleanup);
    const viewer = app.store.users.authByEmail(DEMO.viewer.email);
    assert.ok(viewer);
    const { cookie, id } = await app.createProject('OCR 分类', [viewer.id]);

    const text = await app.upload(
      cookie,
      id,
      new File(['plain'], 'notes.txt', { type: 'text/plain' }),
    );
    assert.equal(text.ocr.status, 'skipped');
    assert.equal(text.ocr.engine, null);

    const image = await app.upload(cookie, id, new File([PNG], 'scan.png', { type: 'image/png' }));
    assert.equal(image.ocr.status, 'pending');
    assert.equal(image.ocr.engine, 'paddle');

    const tiff = await app.upload(
      cookie,
      id,
      new File([new Uint8Array([0x49, 0x49, 0x2a, 0x00, 1, 2, 3, 4])], 'scan.tiff', {
        type: 'image/tiff',
      }),
    );
    assert.equal(tiff.ocr.status, 'pending');
    assert.equal(tiff.ocr.engine, 'paddle');

    const docx = await app.upload(
      cookie,
      id,
      new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])], 'report.docx', {
        type: DOCX_MIME,
      }),
    );
    assert.equal(docx.ocr.status, 'pending');
    assert.equal(docx.ocr.engine, 'docling');

    const pending = await app.readOcr(cookie, id, image.id);
    assert.equal(pending.status, 200);
    assert.equal(pending.body.ocr?.status, 'pending');
    assert.equal(pending.body.ocr?.characters, 0);
    assert.equal(pending.body.ocr?.text, '');

    const viewerCookie = await login(app.app, DEMO.viewer.email);
    assert.equal((await app.readOcr(viewerCookie, id, image.id)).status, 200);
    const denied = await sendJson(
      app.app,
      viewerCookie,
      'POST',
      `/api/projects/${id}/attachments/${image.id}/ocr`,
      {},
    );
    assert.equal(denied.status, 403);

    const outsider = await app.createProject('OCR 外部项目');
    assert.equal((await app.readOcr(viewerCookie, outsider.id, image.id)).status, 404);

    const conflict = await sendJson(
      app.app,
      cookie,
      'POST',
      `/api/projects/${id}/attachments/${image.id}/ocr`,
      {},
    );
    assert.equal(conflict.status, 409);
  });

  test('worker extracts text and exposes it through the API', async (t) => {
    const app = fixture();
    t.after(app.cleanup);
    const sidecar = await fakeOcr();
    t.after(sidecar.close);

    sidecar.respond({
      status: 200,
      payload: {
        text: '第一行\nsecond line',
        engine: 'PP-OCRv5-server',
        confidence: 0.98,
        pages: 3,
      },
    });
    const { cookie, id } = await app.createProject('OCR 成功');
    const image = await app.upload(cookie, id, new File([PNG], 'scan.png', { type: 'image/png' }));

    const worker = new OcrWorker(app.store, new OcrClient({ paddleUrl: sidecar.url }));
    await worker.tick();

    assert.equal(sidecar.calls.length, 1);
    const stored = app.store.attachments.find(image.id);
    assert.ok(stored);
    assert.equal(sidecar.calls[0]?.path, app.store.uploads.resolvePath(stored.storedName));
    assert.equal(sidecar.calls[0]?.name, 'scan.png');

    const result = await app.readOcr(cookie, id, image.id);
    assert.equal(result.body.ocr?.status, 'done');
    assert.equal(result.body.ocr?.text, '第一行\nsecond line');
    assert.equal(result.body.ocr?.confidence, 0.98);
    assert.equal(result.body.ocr?.characters, 15);
    assert.equal(result.body.ocr?.model, 'PP-OCRv5-server');
    assert.equal(result.body.ocr?.pages, 3);
    assert.ok((result.body.ocr?.seconds ?? 0) > 0);
    assert.ok(result.body.ocr?.updatedAt);

    const list = (await (
      await app.app.request(`/api/projects/${id}/attachments`, { headers: authHeaders(cookie) })
    ).json()) as AttachmentList;
    assert.equal(list.attachments[0]?.ocr.status, 'done');
    assert.equal(list.attachments[0]?.ocr.characters, 15);
    assert.equal(list.attachments[0]?.ocr.model, 'PP-OCRv5-server');
    assert.equal(list.attachments[0]?.ocr.pages, 3);

    const audit = app.store.audit.page({ page: 1, pageSize: 10 });
    assert.ok(audit.entries.some((entry) => entry.action === 'project.attachment_added'));
  });

  test('rolls back OCR traffic to the configured model profile', async (t) => {
    const keys = [
      'OCR_GREY_MODE',
      'OCR_GREY_PERCENT',
      'OCR_ROLLBACK_MODEL',
      'OCR_CONTROL_MODEL',
      'OCR_GREY_MODEL',
    ] as const;
    const saved = keys.map((key) => [key, process.env[key]] as const);
    t.after(() => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    delete process.env.OCR_GREY_PERCENT;
    process.env.OCR_GREY_MODE = 'rollback';
    process.env.OCR_ROLLBACK_MODEL = 'candidate';
    process.env.OCR_CONTROL_MODEL = 'control';
    process.env.OCR_GREY_MODEL = 'candidate';

    const app = fixture();
    t.after(app.cleanup);
    const sidecar = await fakeOcr('fake-model', ['control', 'candidate']);
    t.after(sidecar.close);
    const { cookie, id } = await app.createProject('OCR 回滚');
    const image = await app.upload(cookie, id, new File([PNG], 'scan.png', { type: 'image/png' }));

    const worker = new OcrWorker(app.store, new OcrClient({ paddleUrl: sidecar.url }));
    await worker.tick();

    assert.equal(sidecar.calls.length, 1);
    assert.equal(sidecar.calls[0]?.model, 'candidate');
    const result = await app.readOcr(cookie, id, image.id);
    assert.equal(result.body.ocr?.status, 'done');
  });

  test('retries failed extractions and allows a manual requeue', async (t) => {
    const app = fixture();
    t.after(app.cleanup);
    const sidecar = await fakeOcr();
    t.after(sidecar.close);

    sidecar.respond({ status: 500, payload: { error: 'model crashed' } });
    const { cookie, id } = await app.createProject('OCR 重试');
    const image = await app.upload(cookie, id, new File([PNG], 'scan.png', { type: 'image/png' }));

    const worker = new OcrWorker(app.store, new OcrClient({ paddleUrl: sidecar.url }));

    await worker.tick();
    let record = app.store.attachments.find(image.id);
    assert.equal(record?.ocrStatus, 'pending');
    assert.equal(record?.ocrAttempts, 1);
    assert.match(record?.ocrError ?? '', /model crashed/);

    const due = () => {
      app.store.db.raw
        .prepare('UPDATE attachments SET ocr_next_attempt_at = ? WHERE id = ?')
        .run(new Date(0).toISOString(), image.id);
    };
    await worker.tick();
    assert.equal(app.store.attachments.find(image.id)?.ocrAttempts, 1);

    due();
    await worker.tick();
    assert.equal(app.store.attachments.find(image.id)?.ocrAttempts, 2);
    assert.equal(app.store.attachments.find(image.id)?.ocrStatus, 'pending');

    due();
    await worker.tick();
    record = app.store.attachments.find(image.id);
    assert.equal(record?.ocrAttempts, 3);
    assert.equal(record?.ocrStatus, 'failed');
    assert.match(record?.ocrError ?? '', /model crashed/);

    sidecar.respond({
      status: 200,
      payload: { text: '恢复成功', engine: 'PP-OCRv5-server', confidence: 0.91 },
    });
    const requeued = await sendJson(
      app.app,
      cookie,
      'POST',
      `/api/projects/${id}/attachments/${image.id}/ocr`,
      {},
    );
    assert.equal(requeued.status, 200);
    assert.equal((requeued.body as { ocr: AttachmentOcr }).ocr.status, 'pending');

    await worker.tick();
    const result = await app.readOcr(cookie, id, image.id);
    assert.equal(result.body.ocr?.status, 'done');
    assert.equal(result.body.ocr?.text, '恢复成功');

    const audit = app.store.audit.page({ page: 1, pageSize: 10 });
    assert.ok(audit.entries.some((entry) => entry.action === 'project.attachment_ocr_requeued'));
  });

  test('client errors fail immediately without retrying', async (t) => {
    const app = fixture();
    t.after(app.cleanup);
    const sidecar = await fakeOcr();
    t.after(sidecar.close);

    sidecar.respond({ status: 400, payload: { error: 'paddle does not handle this file' } });
    const { cookie, id } = await app.createProject('OCR 永久失败');
    const image = await app.upload(cookie, id, new File([PNG], 'scan.png', { type: 'image/png' }));

    const worker = new OcrWorker(app.store, new OcrClient({ paddleUrl: sidecar.url }));
    await worker.tick();

    const record = app.store.attachments.find(image.id);
    assert.equal(record?.ocrStatus, 'failed');
    assert.equal(record?.ocrAttempts, 1);
    assert.match(record?.ocrError ?? '', /does not handle/);
  });

  test('encrypted PDFs fail once with a readable reason', async (t) => {
    const app = fixture();
    t.after(app.cleanup);
    const sidecar = await fakeOcr();
    t.after(sidecar.close);

    sidecar.respond({ status: 422, payload: { error: 'password_required: PDF is encrypted' } });
    const { cookie, id } = await app.createProject('OCR 加密 PDF');
    const image = await app.upload(cookie, id, new File([PNG], 'scan.png', { type: 'image/png' }));

    const worker = new OcrWorker(app.store, new OcrClient({ paddleUrl: sidecar.url }));
    await worker.tick();

    const record = app.store.attachments.find(image.id);
    assert.equal(record?.ocrStatus, 'failed');
    assert.equal(record?.ocrAttempts, 1);
    assert.match(record?.ocrError ?? '', /已加密/);
  });

  test('missing files fail without consuming retries', async (t) => {
    const app = fixture();
    t.after(app.cleanup);
    const { cookie, id } = await app.createProject('OCR 文件缺失');
    const image = await app.upload(cookie, id, new File([PNG], 'scan.png', { type: 'image/png' }));
    const stored = app.store.attachments.find(image.id);
    assert.ok(stored);
    await app.store.uploads.remove(stored.storedName);

    const worker = new OcrWorker(
      app.store,
      new OcrClient({ paddleUrl: 'http://127.0.0.1:9', timeoutMs: 100 }),
    );
    await worker.tick();

    const record = app.store.attachments.find(image.id);
    assert.equal(record?.ocrStatus, 'failed');
    assert.match(record?.ocrError ?? '', /不存在/);
  });

  test('reuses results for identical bytes and allows rerunning completed jobs', async (t) => {
    const sidecar = await fakeOcr();
    const client = new OcrClient({ paddleUrl: sidecar.url });
    const app = fixture({ ocrModelPeek: (engine) => client.peekModel(engine) });
    t.after(app.cleanup);
    t.after(sidecar.close);

    sidecar.respond({
      status: 200,
      payload: {
        text: '缓存文本',
        engine: 'PP-OCRv6-medium',
        model: 'fake-model',
        confidence: 0.97,
        pages: 1,
      },
    });
    const { cookie, id } = await app.createProject('OCR 复用');
    const first = await app.upload(cookie, id, new File([PNG], 'scan.png', { type: 'image/png' }));
    assert.equal(first.ocr.status, 'pending');

    const worker = new OcrWorker(app.store, client);
    await worker.tick();
    assert.equal(sidecar.calls.length, 1);

    const second = await app.upload(cookie, id, new File([PNG], 'copy.png', { type: 'image/png' }));
    assert.equal(second.ocr.status, 'done');
    assert.equal(second.ocr.characters, 4);
    assert.equal(second.ocr.model, 'PP-OCRv6-medium');
    assert.equal(second.ocr.pages, 1);
    assert.equal(second.ocr.truncated, false);
    assert.equal(sidecar.calls.length, 1);

    const detail = await app.readOcr(cookie, id, second.id);
    assert.equal(detail.body.ocr?.text, '缓存文本');
    assert.equal(detail.body.ocr?.rawText, '缓存文本');

    const requeued = await sendJson(
      app.app,
      cookie,
      'POST',
      `/api/projects/${id}/attachments/${second.id}/ocr`,
      {},
    );
    assert.equal(requeued.status, 200);
    assert.equal((requeued.body as { ocr: AttachmentOcr }).ocr.status, 'pending');

    await worker.tick();
    assert.equal(app.store.attachments.find(second.id)?.ocrStatus, 'done');
    assert.equal(sidecar.calls.length, 2);
  });

  test('keeps the engine text apart from the normalized copy', async (t) => {
    const sidecar = await fakeOcr();
    const client = new OcrClient({ paddleUrl: sidecar.url });
    const app = fixture({ ocrModelPeek: (engine) => client.peekModel(engine) });
    t.after(app.cleanup);
    t.after(sidecar.close);

    sidecar.respond({
      status: 200,
      payload: {
        text: '客户：上海 编号：SH20240101 金额 1，280，500',
        rawText: '客户：上海编号：SH20240101金额1，280，500',
        engine: 'PP-OCRv6-medium',
        model: 'fake-model',
        confidence: 0.96,
        pages: 1,
      },
    });
    const { cookie, id } = await app.createProject('OCR 原文分离');
    const image = await app.upload(cookie, id, new File([PNG], 'scan.png', { type: 'image/png' }));
    await new OcrWorker(app.store, client).tick();

    const detail = await app.readOcr(cookie, id, image.id);
    assert.equal(detail.body.ocr?.text, '客户：上海 编号：SH20240101 金额 1，280，500');
    assert.equal(detail.body.ocr?.rawText, '客户：上海编号：SH20240101金额1，280，500');
    const stored = app.store.db
      .stmt('SELECT ocr_text, ocr_raw_text FROM attachments WHERE id = ?')
      .get(image.id) as unknown as { ocr_text: string; ocr_raw_text: string | null };
    assert.equal(stored.ocr_text, '客户：上海 编号：SH20240101 金额 1，280，500');
    assert.equal(stored.ocr_raw_text, '客户：上海编号：SH20240101金额1，280，500');
  });

  test('does not reuse OCR results across workspaces', (t) => {
    const store = testStore();
    t.after(() => store.close());

    const user = store.users.authByEmail(DEMO.admin.email);
    assert.ok(user);
    const sha256 = 'a'.repeat(64);
    const key = ['PP-OCRv6-medium', 'config-hash', 'auto', 200] as const;
    const seed = (name: string) => {
      const project = store.projects.create({ name }, { id: user.id, name: user.name });
      const id = randomUUID();
      store.attachments.create({
        id,
        projectId: project.id,
        uploaderId: user.id,
        name,
        mime: 'image/png',
        size: 1024,
        storedName: `stored-${id}.bin`,
        sha256,
        createdAt: new Date().toISOString(),
        ocrTarget: 'paddle',
      });
      return { projectId: project.id, attachmentId: id };
    };

    const source = seed('tenant-source.png');
    store.attachments.completeOcr(
      source.attachmentId,
      {
        text: '租户内复用',
        confidence: 0.95,
        model: 'PP-OCRv6-medium',
        engineModel: key[0],
        configHash: key[1],
        seconds: 1,
        pages: 1,
        truncated: false,
        route: 'visual',
        quality: null,
        stages: [],
        document: null,
      },
      new Date().toISOString(),
    );
    assert.ok(store.attachments.findReusableOcr(sha256, 'paddle', ...key, source.projectId));

    const other = seed('tenant-other.png');
    store.db
      .stmt(
        `INSERT INTO workspaces (id, name, slug, created_at, updated_at)
         VALUES ('ws_other', '另一租户', 'other', ?, ?)`,
      )
      .run(new Date().toISOString(), new Date().toISOString());
    store.db
      .stmt("UPDATE projects SET workspace_id = 'ws_other' WHERE id = ?")
      .run(other.projectId);

    assert.equal(
      store.attachments.findReusableOcr(sha256, 'paddle', ...key, other.projectId),
      null,
    );
  });

  test('does not reuse results from a different model', async (t) => {
    const sidecar = await fakeOcr('model-a');
    let client = new OcrClient({ paddleUrl: sidecar.url });
    const app = fixture({ ocrModelPeek: (engine) => client.peekModel(engine) });
    t.after(app.cleanup);
    t.after(sidecar.close);

    sidecar.respond({
      status: 200,
      payload: {
        text: '旧模型结果',
        engine: 'PP-OCRv6-medium',
        model: 'model-a',
        confidence: 0.9,
        pages: 1,
      },
    });
    const { cookie, id } = await app.createProject('OCR 模型校验');
    const first = await app.upload(cookie, id, new File([PNG], 'scan.png', { type: 'image/png' }));
    const worker = new OcrWorker(app.store, client);
    await worker.tick();
    assert.equal(app.store.attachments.find(first.id)?.ocrStatus, 'done');
    assert.equal(sidecar.calls.length, 1);

    sidecar.setModel('model-b');
    client = new OcrClient({ paddleUrl: sidecar.url });
    const second = await app.upload(cookie, id, new File([PNG], 'copy.png', { type: 'image/png' }));
    assert.equal(second.ocr.status, 'pending');

    sidecar.respond({
      status: 200,
      payload: {
        text: '新模型结果',
        engine: 'PP-OCRv6-medium',
        model: 'model-b',
        confidence: 0.95,
        pages: 1,
      },
    });
    const upgraded = new OcrWorker(app.store, client);
    await upgraded.tick();
    assert.equal(app.store.attachments.find(second.id)?.ocrStatus, 'done');
    assert.equal(sidecar.calls.length, 2);
    assert.equal((await app.readOcr(cookie, id, second.id)).body.ocr?.text, '新模型结果');
  });

  test('does not reuse results from a different pipeline version', async (t) => {
    const sidecar = await fakeOcr('model-a');
    sidecar.setPipeline('p1');
    let client = new OcrClient({ paddleUrl: sidecar.url });
    const app = fixture({ ocrModelPeek: (engine) => client.peekModel(engine) });
    t.after(app.cleanup);
    t.after(sidecar.close);

    sidecar.respond({
      status: 200,
      payload: {
        text: '旧后处理结果',
        engine: 'PP-OCRv6-medium',
        model: 'model-a',
        pipeline: 'p1',
        confidence: 0.9,
        pages: 1,
      },
    });
    const { cookie, id } = await app.createProject('OCR 后处理版本');
    const first = await app.upload(cookie, id, new File([PNG], 'scan.png', { type: 'image/png' }));
    const worker = new OcrWorker(app.store, client);
    await worker.tick();
    assert.equal(app.store.attachments.find(first.id)?.ocrStatus, 'done');
    assert.equal(sidecar.calls.length, 1);

    sidecar.setPipeline('p2');
    client = new OcrClient({ paddleUrl: sidecar.url });
    const second = await app.upload(cookie, id, new File([PNG], 'copy.png', { type: 'image/png' }));
    assert.equal(second.ocr.status, 'pending');

    sidecar.respond({
      status: 200,
      payload: {
        text: '新后处理结果',
        engine: 'PP-OCRv6-medium',
        model: 'model-a',
        pipeline: 'p2',
        confidence: 0.9,
        pages: 1,
      },
    });
    const upgraded = new OcrWorker(app.store, client);
    await upgraded.tick();
    assert.equal(app.store.attachments.find(second.id)?.ocrStatus, 'done');
    assert.equal(sidecar.calls.length, 2);
    assert.equal((await app.readOcr(cookie, id, second.id)).body.ocr?.text, '新后处理结果');
  });

  test('does not reuse results after a cache-relevant config change', async (t) => {
    const sidecar = await fakeOcr();
    const client = new OcrClient({ paddleUrl: sidecar.url });
    const app = fixture({ ocrModelPeek: (engine) => client.peekModel(engine) });
    t.after(app.cleanup);
    t.after(sidecar.close);
    const previous = process.env.OCR_LANGS;
    t.after(() => {
      if (previous === undefined) delete process.env.OCR_LANGS;
      else process.env.OCR_LANGS = previous;
    });

    sidecar.respond({
      status: 200,
      payload: {
        text: '旧配置结果',
        engine: 'PP-OCRv6-medium',
        model: 'fake-model',
        confidence: 0.9,
        pages: 1,
      },
    });
    const { cookie, id } = await app.createProject('OCR 配置指纹');
    delete process.env.OCR_LANGS;
    const first = await app.upload(cookie, id, new File([PNG], 'scan.png', { type: 'image/png' }));
    const worker = new OcrWorker(app.store, client);
    await worker.tick();
    assert.equal(app.store.attachments.find(first.id)?.ocrStatus, 'done');
    assert.equal(sidecar.calls.length, 1);

    process.env.OCR_LANGS = 'en';
    const second = await app.upload(cookie, id, new File([PNG], 'copy.png', { type: 'image/png' }));
    assert.equal(second.ocr.status, 'pending', 'a new fingerprint must not reuse cached text');

    sidecar.respond({
      status: 200,
      payload: {
        text: '新配置结果',
        engine: 'PP-OCRv6-medium',
        model: 'fake-model',
        confidence: 0.9,
        pages: 1,
      },
    });
    await worker.tick();
    assert.equal(app.store.attachments.find(second.id)?.ocrStatus, 'done');
    assert.equal(sidecar.calls.length, 2);
    assert.equal((await app.readOcr(cookie, id, second.id)).body.ocr?.text, '新配置结果');
  });

  test('isolates cached OCR by mode and sends the layout options', async (t) => {
    const sidecar = await fakeOcr();
    const client = new OcrClient({ paddleUrl: sidecar.url });
    const app = fixture({ ocrModelPeek: (engine) => client.peekModel(engine) });
    t.after(app.cleanup);
    t.after(sidecar.close);

    sidecar.respond({
      status: 200,
      payload: {
        text: '自动布局结果',
        engine: 'PP-OCRv6-medium',
        model: 'fake-model',
        confidence: 0.9,
        pages: 1,
      },
    });
    const { cookie, id } = await app.createProject('OCR 模式隔离');
    const first = await app.upload(cookie, id, new File([PNG], 'scan.png', { type: 'image/png' }));
    assert.equal(first.ocr.mode, 'auto');
    assert.equal(first.ocr.dpi, 200);

    const worker = new OcrWorker(app.store, client);
    await worker.tick();
    assert.equal(sidecar.calls[0]?.mode, 'auto');
    assert.equal(sidecar.calls[0]?.dpi, 200);

    const copy = await app.upload(cookie, id, new File([PNG], 'copy.png', { type: 'image/png' }));
    assert.equal(copy.ocr.status, 'done');
    assert.equal(copy.ocr.mode, 'auto');

    sidecar.respond({
      status: 200,
      payload: {
        text: '表格结构化结果',
        engine: 'PP-StructureV3-table',
        model: 'PP-StructureV3-table',
        confidence: 0.8,
        pages: 1,
      },
    });
    const rerun = await sendJson(
      app.app,
      cookie,
      'POST',
      `/api/projects/${id}/attachments/${first.id}/ocr`,
      { mode: 'table' },
    );
    assert.equal(rerun.status, 200);
    assert.equal((rerun.body as { ocr: AttachmentOcr }).ocr.status, 'pending');
    assert.equal((rerun.body as { ocr: AttachmentOcr }).ocr.mode, 'table');

    await worker.tick();
    assert.equal(sidecar.calls.length, 2);
    assert.equal(sidecar.calls[1]?.mode, 'table');
    assert.equal(sidecar.calls[1]?.dpi, 200);
    const tableResult = await app.readOcr(cookie, id, first.id);
    assert.equal(tableResult.body.ocr?.text, '表格结构化结果');
    assert.equal(tableResult.body.ocr?.model, 'PP-StructureV3-table');

    const third = await app.upload(cookie, id, new File([PNG], 'third.png', { type: 'image/png' }));
    assert.equal(third.ocr.status, 'done');
    assert.equal(third.ocr.mode, 'auto');
    assert.equal((await app.readOcr(cookie, id, third.id)).body.ocr?.text, '自动布局结果');
    assert.equal(sidecar.calls.length, 2);
  });

  test('cascades weak extractions and persists the DIR and quality', async (t) => {
    const sidecar = await fakeOcr();
    const client = new OcrClient({ paddleUrl: sidecar.url });
    const app = fixture({ ocrModelPeek: (engine) => client.peekModel(engine) });
    t.after(app.cleanup);
    t.after(sidecar.close);

    sidecar.sequence([
      {
        status: 200,
        payload: {
          text: '模糊文本',
          engine: 'PP-OCRv6-medium',
          model: 'fake-model',
          confidence: 0.3,
          pages: 1,
          route: 'visual',
        },
      },
      {
        status: 200,
        payload: {
          text: '清晰文本',
          engine: 'PP-OCRv6-medium',
          model: 'fake-model',
          confidence: 0.96,
          pages: 1,
          route: 'visual',
          document: {
            version: 1,
            route: 'visual',
            pages: [
              {
                number: 1,
                width: 100,
                height: 120,
                blocks: [
                  {
                    id: 'b1',
                    type: 'paragraph',
                    text: '清晰文本',
                    bbox: { x: 0, y: 0, width: 100, height: 20 },
                    confidence: 0.96,
                    source: {
                      engine: 'PP-OCRv6-medium',
                      model: 'fake-model',
                      stage: 'visual',
                    },
                    validation: { status: 'passed', issues: [] },
                    order: 0,
                  },
                ],
                source: null,
              },
            ],
            readingOrder: ['b1'],
            meta: {},
          },
        },
      },
    ]);

    const { cookie, id } = await app.createProject('OCR 级联');
    const image = await app.upload(cookie, id, new File([PNG], 'scan.png', { type: 'image/png' }));
    const worker = new OcrWorker(app.store, client);
    await worker.tick();

    assert.equal(sidecar.calls.length, 2);
    assert.equal(sidecar.calls[0]?.mode, 'auto');
    assert.equal(sidecar.calls[1]?.mode, 'enhanced');

    const detail = await app.readOcr(cookie, id, image.id);
    assert.equal(detail.body.ocr?.text, '清晰文本');
    assert.equal(detail.body.ocr?.route, 'visual');
    assert.equal(detail.body.ocr?.quality?.status, 'pass');
    assert.equal(detail.body.ocr?.reviewRequired, false);
    assert.equal(detail.body.ocr?.stages.length, 2);
    assert.equal(detail.body.ocr?.stages[1]?.kind, 'recovery_enhance');
    assert.equal(detail.body.ocr?.document?.readingOrder[0], 'b1');
    assert.equal(detail.body.ocr?.document?.pages[0]?.blocks[0]?.confidence, 0.96);

    const copy = await app.upload(cookie, id, new File([PNG], 'copy.png', { type: 'image/png' }));
    assert.equal(copy.ocr.status, 'done');
    assert.equal(copy.ocr.quality?.status, 'pass');
    assert.equal(copy.ocr.reviewRequired, false);
    assert.equal(sidecar.calls.length, 2);

    const copyDetail = await app.readOcr(cookie, id, copy.id);
    assert.equal(copyDetail.body.ocr?.stages.length, 2);
    assert.equal(copyDetail.body.ocr?.document?.readingOrder[0], 'b1');
  });

  test('marks low-quality results for review and never reuses them', async (t) => {
    const sidecar = await fakeOcr();
    const client = new OcrClient({ paddleUrl: sidecar.url });
    const app = fixture({ ocrModelPeek: (engine) => client.peekModel(engine) });
    t.after(app.cleanup);
    t.after(sidecar.close);

    sidecar.respond({
      status: 200,
      payload: {
        text: '低质文本',
        engine: 'PP-OCRv6-medium',
        model: 'fake-model',
        confidence: 0,
        pages: 1,
        route: 'visual',
      },
    });

    const { cookie, id } = await app.createProject('OCR 复核');
    const image = await app.upload(cookie, id, new File([PNG], 'scan.png', { type: 'image/png' }));
    const worker = new OcrWorker(app.store, client);
    await worker.tick();

    assert.equal(sidecar.calls.length, 2);
    const stored = app.store.attachments.find(image.id);
    assert.equal(stored?.ocrStatus, 'done');
    assert.equal(stored?.ocrQuality?.status, 'fail');
    assert.equal(stored?.ocrReviewRequired, true);

    const detail = await app.readOcr(cookie, id, image.id);
    assert.equal(detail.body.ocr?.reviewRequired, true);
    assert.equal(detail.body.ocr?.quality?.status, 'fail');
    assert.ok(detail.body.ocr?.quality?.issues.some((issue) => issue.code === 'low_confidence'));

    const copy = await app.upload(cookie, id, new File([PNG], 'copy.png', { type: 'image/png' }));
    assert.equal(copy.ocr.status, 'pending');
    assert.equal(copy.ocr.reviewRequired, false);
    assert.equal(sidecar.calls.length, 2);

    await worker.tick();
    assert.equal(app.store.attachments.find(copy.id)?.ocrStatus, 'done');
    assert.equal(sidecar.calls.length, 4);
  });

  test('clears derived OCR metadata when a job is requeued', async (t) => {
    const sidecar = await fakeOcr();
    const client = new OcrClient({ paddleUrl: sidecar.url });
    const app = fixture({ ocrModelPeek: (engine) => client.peekModel(engine) });
    t.after(app.cleanup);
    t.after(sidecar.close);

    sidecar.respond({
      status: 200,
      payload: {
        text: '低质文本',
        engine: 'PP-OCRv6-medium',
        model: 'fake-model',
        confidence: 0,
        pages: 1,
        route: 'visual',
      },
    });
    const { cookie, id } = await app.createProject('OCR 重跑元数据');
    const image = await app.upload(cookie, id, new File([PNG], 'scan.png', { type: 'image/png' }));
    const worker = new OcrWorker(app.store, client);
    await worker.tick();

    const done = await app.readOcr(cookie, id, image.id);
    assert.equal(done.body.ocr?.quality?.status, 'fail');
    assert.equal(done.body.ocr?.route, 'visual');
    assert.ok((done.body.ocr?.stages.length ?? 0) > 0);

    const rerun = await sendJson(
      app.app,
      cookie,
      'POST',
      `/api/projects/${id}/attachments/${image.id}/ocr`,
      {},
    );
    assert.equal(rerun.status, 200);
    const summary = (rerun.body as { ocr: AttachmentOcr }).ocr;
    assert.equal(summary.status, 'pending');
    assert.equal(summary.quality, null);
    assert.equal(summary.route, null);
    assert.equal(summary.stages.length, 0);
    assert.equal(summary.reviewRequired, false);

    const detail = await app.readOcr(cookie, id, image.id);
    assert.equal(detail.body.ocr?.status, 'pending');
    assert.equal(detail.body.ocr?.quality, null);
    assert.equal(detail.body.ocr?.document, null);
    assert.equal(detail.body.ocr?.stages.length, 0);
  });

  test('accepts structure and enhanced reruns for visual attachments', async (t) => {
    const sidecar = await fakeOcr();
    const client = new OcrClient({ paddleUrl: sidecar.url });
    const app = fixture({ ocrModelPeek: (engine) => client.peekModel(engine) });
    t.after(app.cleanup);
    t.after(sidecar.close);

    const { cookie, id } = await app.createProject('OCR 模式扩展');
    const image = await app.upload(cookie, id, new File([PNG], 'scan.png', { type: 'image/png' }));
    const docx = await app.upload(
      cookie,
      id,
      new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])], 'report.docx', {
        type: DOCX_MIME,
      }),
    );

    const worker = new OcrWorker(app.store, client);
    await worker.tick();

    const structure = await sendJson(
      app.app,
      cookie,
      'POST',
      `/api/projects/${id}/attachments/${image.id}/ocr`,
      { mode: 'structure' },
    );
    assert.equal(structure.status, 200);
    assert.equal((structure.body as { ocr: AttachmentOcr }).ocr.mode, 'structure');
    await worker.tick();
    assert.equal(sidecar.calls[1]?.mode, 'structure');

    const enhanced = await sendJson(
      app.app,
      cookie,
      'POST',
      `/api/projects/${id}/attachments/${image.id}/ocr`,
      { mode: 'enhanced' },
    );
    assert.equal(enhanced.status, 200);
    await worker.tick();
    assert.equal(sidecar.calls[2]?.mode, 'enhanced');
    assert.equal(app.store.attachments.find(image.id)?.ocrStatus, 'done');

    const rejected = await sendJson(
      app.app,
      cookie,
      'POST',
      `/api/projects/${id}/attachments/${docx.id}/ocr`,
      { mode: 'enhanced' },
    );
    assert.equal(rejected.status, 400);
  });

  test('requeues PDFs with a custom render DPI', async (t) => {
    const sidecar = await fakeOcr();
    const client = new OcrClient({ paddleUrl: sidecar.url });
    const app = fixture({ ocrModelPeek: (engine) => client.peekModel(engine) });
    t.after(app.cleanup);
    t.after(sidecar.close);

    sidecar.respond({
      status: 200,
      payload: {
        text: 'PDF 文本',
        engine: 'PP-OCRv6-medium',
        model: 'fake-model',
        confidence: 0.9,
        pages: 1,
      },
    });
    const { cookie, id } = await app.createProject('OCR DPI');
    const pdf = await app.upload(
      cookie,
      id,
      new File([PDF], 'scan.pdf', { type: 'application/pdf' }),
    );
    assert.equal(pdf.ocr.engine, 'paddle');
    assert.equal(pdf.ocr.dpi, 200);

    const worker = new OcrWorker(app.store, client);
    await worker.tick();
    assert.equal(sidecar.calls[0]?.dpi, 200);

    const rerun = await sendJson(
      app.app,
      cookie,
      'POST',
      `/api/projects/${id}/attachments/${pdf.id}/ocr`,
      { dpi: 300 },
    );
    assert.equal(rerun.status, 200);
    assert.equal((rerun.body as { ocr: AttachmentOcr }).ocr.dpi, 300);

    await worker.tick();
    assert.equal(sidecar.calls.length, 2);
    assert.equal(sidecar.calls[1]?.dpi, 300);
    assert.equal(sidecar.calls[1]?.mode, 'auto');
  });

  test('rejects invalid rerun options', async (t) => {
    const app = fixture();
    t.after(app.cleanup);
    const { cookie, id } = await app.createProject('OCR 参数校验');
    const image = await app.upload(cookie, id, new File([PNG], 'scan.png', { type: 'image/png' }));
    const docx = await app.upload(
      cookie,
      id,
      new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])], 'report.docx', {
        type: DOCX_MIME,
      }),
    );
    const plain = await app.upload(
      cookie,
      id,
      new File(['plain'], 'notes.txt', { type: 'text/plain' }),
    );

    const badMode = await sendJson(
      app.app,
      cookie,
      'POST',
      `/api/projects/${id}/attachments/${image.id}/ocr`,
      { mode: 'structured' },
    );
    assert.equal(badMode.status, 400);

    const badDpi = await sendJson(
      app.app,
      cookie,
      'POST',
      `/api/projects/${id}/attachments/${image.id}/ocr`,
      { dpi: 500 },
    );
    assert.equal(badDpi.status, 400);

    const wrongEngine = await sendJson(
      app.app,
      cookie,
      'POST',
      `/api/projects/${id}/attachments/${docx.id}/ocr`,
      { mode: 'table' },
    );
    assert.equal(wrongEngine.status, 400);

    const skipped = await sendJson(
      app.app,
      cookie,
      'POST',
      `/api/projects/${id}/attachments/${plain.id}/ocr`,
      {},
    );
    assert.equal(skipped.status, 400);
  });

  test('marks partial PDFs and never reuses them', async (t) => {
    const sidecar = await fakeOcr();
    const client = new OcrClient({ paddleUrl: sidecar.url });
    const app = fixture({ ocrModelPeek: (engine) => client.peekModel(engine) });
    t.after(app.cleanup);
    t.after(sidecar.close);

    sidecar.respond({
      status: 200,
      payload: {
        text: '第一页\n\n[PDF 共 100 页，已识别前 1 页]',
        engine: 'PP-OCRv6-medium',
        model: 'fake-model',
        confidence: 0.9,
        pages: 1,
        truncated: true,
      },
    });
    const { cookie, id } = await app.createProject('OCR 截断');
    const first = await app.upload(cookie, id, new File([PNG], 'scan.png', { type: 'image/png' }));
    const worker = new OcrWorker(app.store, client);
    await worker.tick();

    const detail = await app.readOcr(cookie, id, first.id);
    assert.equal(detail.body.ocr?.status, 'done');
    assert.equal(detail.body.ocr?.truncated, true);

    const second = await app.upload(cookie, id, new File([PNG], 'copy.png', { type: 'image/png' }));
    assert.equal(second.ocr.status, 'pending');
    assert.equal(sidecar.calls.length, 1);

    await worker.tick();
    assert.equal(app.store.attachments.find(second.id)?.ocrStatus, 'done');
    assert.equal(sidecar.calls.length, 2);

    const metrics = await app.app.request('/metrics');
    assert.match(await metrics.text(), /node_pulse_ocr_queue\{status="done"\} 2/);
  });

  test('recovers stale processing rows and leaves fresh ones alone', async (t) => {
    const app = fixture();
    t.after(app.cleanup);
    const sidecar = await fakeOcr();
    t.after(sidecar.close);

    const { cookie, id } = await app.createProject('OCR 恢复');
    const stale = await app.upload(cookie, id, new File([PNG], 'stale.png', { type: 'image/png' }));
    const fresh = await app.upload(cookie, id, new File([PNG], 'fresh.png', { type: 'image/png' }));

    const setProcessing = (attachmentId: string, updatedAt: string) => {
      app.store.db.raw
        .prepare(
          "UPDATE attachments SET ocr_status = 'processing', ocr_attempts = 1, ocr_updated_at = ? WHERE id = ?",
        )
        .run(updatedAt, attachmentId);
    };
    setProcessing(stale.id, new Date(Date.now() - 60 * 60_000).toISOString());
    setProcessing(fresh.id, new Date().toISOString());

    const worker = new OcrWorker(app.store, new OcrClient({ paddleUrl: sidecar.url }));
    await worker.tick();

    assert.equal(app.store.attachments.find(stale.id)?.ocrStatus, 'done');
    assert.equal(app.store.attachments.find(fresh.id)?.ocrStatus, 'processing');
    assert.equal(sidecar.calls.length, 1);
    assert.equal(sidecar.calls[0]?.name, 'stale.png');
  });

  test('runs one lane per engine so Docling is not blocked by Paddle', async (t) => {
    const app = fixture();
    t.after(app.cleanup);
    const sidecar = await fakeOcr();
    t.after(sidecar.close);

    const { cookie, id } = await app.createProject('OCR 并行');
    const image = await app.upload(cookie, id, new File([PNG], 'scan.png', { type: 'image/png' }));
    const docx = await app.upload(
      cookie,
      id,
      new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])], 'report.docx', {
        type: DOCX_MIME,
      }),
    );

    const client = new OcrClient({ paddleUrl: sidecar.url, doclingUrl: sidecar.url });
    const doclingWorker = new OcrWorker(app.store, client, { engines: ['docling'] });
    await doclingWorker.tick();

    assert.equal(sidecar.calls.length, 1);
    assert.equal(sidecar.calls[0]?.name, 'report.docx');
    assert.equal(app.store.attachments.find(docx.id)?.ocrStatus, 'done');
    assert.equal(app.store.attachments.find(image.id)?.ocrStatus, 'pending');
  });

  test('requeues the in-flight job when the worker stops', async (t) => {
    const app = fixture();
    t.after(app.cleanup);
    const sidecar = await fakeOcr();
    t.after(sidecar.close);
    sidecar.setDelay(250);

    const { cookie, id } = await app.createProject('OCR 关闭');
    const image = await app.upload(cookie, id, new File([PNG], 'scan.png', { type: 'image/png' }));

    const worker = new OcrWorker(app.store, new OcrClient({ paddleUrl: sidecar.url }));
    const ticking = worker.tick();
    while (sidecar.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await worker.stop();
    await ticking;

    const record = app.store.attachments.find(image.id);
    assert.equal(record?.ocrStatus, 'pending');
    assert.match(record?.ocrError ?? '', /服务关闭/);
  });

  test('wakes the worker after uploads and requeues', async (t) => {
    let wakes = 0;
    const app = fixture({ ocrWake: () => (wakes += 1) });
    t.after(app.cleanup);
    const sidecar = await fakeOcr();
    t.after(sidecar.close);

    const { cookie, id } = await app.createProject('OCR 唤醒');
    const image = await app.upload(cookie, id, new File([PNG], 'scan.png', { type: 'image/png' }));
    assert.equal(wakes, 1);

    const worker = new OcrWorker(app.store, new OcrClient({ paddleUrl: sidecar.url }));
    await worker.tick();
    assert.equal(app.store.attachments.find(image.id)?.ocrStatus, 'done');

    const requeued = await sendJson(
      app.app,
      cookie,
      'POST',
      `/api/projects/${id}/attachments/${image.id}/ocr`,
      {},
    );
    assert.equal(requeued.status, 200);
    assert.equal(wakes, 2);
  });

  test('exports redacted OCR text and refuses after retention purge', async (t) => {
    const app = fixture();
    t.after(app.cleanup);
    const { cookie, id } = await app.createProject('脱敏导出');
    const attachment = await app.upload(
      cookie,
      id,
      new File(['客户资料'], '客户资料.txt', { type: 'text/plain' }),
    );
    const text = [
      '客户 张三',
      '手机 13800138000',
      '邮箱 zhang.san@example.com',
      '身份证 11010519491231002X',
      '银行卡 6222020200112233445',
      `P<CHNZSAN${'<'.repeat(35)}`,
    ].join('\n');
    app.store.attachments.completeOcr(
      attachment.id,
      {
        text,
        confidence: 0.93,
        model: 'fake-model',
        engineModel: 'fake-model',
        configHash: 'redaction-test',
        seconds: 1,
        pages: 1,
        truncated: false,
        route: 'visual',
        quality: null,
        stages: [],
        document: null,
      },
      new Date().toISOString(),
    );

    const exported = await app.app.request(
      `/api/projects/${id}/attachments/${attachment.id}/ocr/export`,
      { headers: authHeaders(cookie) },
    );
    assert.equal(exported.status, 200);
    const payload = (await exported.json()) as OcrExport;
    assert.match(payload.filename, /-ocr-redacted\.txt$/);
    for (const secret of [
      '13800138000',
      'zhang.san@example.com',
      '11010519491231002X',
      '6222020200112233445',
      'P<CHNZSAN',
    ]) {
      assert.ok(!payload.text.includes(secret), `${secret} must be redacted`);
    }
    assert.deepEqual(payload.redactions, {
      idCards: 1,
      phones: 1,
      landlines: 0,
      emails: 1,
      bankCards: 1,
      mrzLines: 1,
    });

    const entry = app.store.audit
      .page({ page: 1, pageSize: 20 })
      .entries.find((item) => item.action === 'project.attachment_ocr_exported');
    assert.ok(entry);
    const detail = JSON.stringify(entry.detail);
    assert.ok(!detail.includes('13800138000'));
    assert.ok(!detail.includes('11010519491231002X'));
    assert.match(detail, /"phones":1/);

    const purged = app.store.attachments.purgeOcrText(1, Date.now() + 2 * 86_400_000);
    assert.equal(purged.attachments, 1);
    const record = app.store.attachments.findOcr(attachment.id);
    assert.ok(record?.purgedAt);
    assert.equal(record?.text, '');
    assert.equal(record?.document, null);

    const denied = await app.app.request(
      `/api/projects/${id}/attachments/${attachment.id}/ocr/export`,
      { headers: authHeaders(cookie) },
    );
    assert.equal(denied.status, 410);
  });

  test('deleting an attachment cascades OCR output and field revisions', async (t) => {
    const app = fixture();
    t.after(app.cleanup);
    const { cookie, id } = await app.createProject('删除级联');
    const attachment = await app.upload(
      cookie,
      id,
      new File(['客户资料'], '客户资料.txt', { type: 'text/plain' }),
    );
    app.store.attachments.completeOcr(
      attachment.id,
      {
        text: '金额 1280.00',
        confidence: 0.91,
        model: 'fake-model',
        engineModel: 'fake-model',
        configHash: 'cascade-test',
        seconds: 1,
        pages: 1,
        truncated: false,
        route: 'visual',
        quality: null,
        stages: [],
        document: null,
      },
      new Date().toISOString(),
    );
    app.store.ocrFieldRevisions.create({
      attachmentId: attachment.id,
      projectId: id,
      fieldId: 'amount',
      fieldKind: 'amount',
      page: 1,
      blockId: null,
      bbox: null,
      originalText: '1280.0O',
      revisedText: '1280.00',
      reason: 'test',
      revisedBy: null,
      createdAt: new Date().toISOString(),
    });
    assert.equal(app.store.ocrFieldRevisions.list(attachment.id).length, 1);

    const deleted = await app.app.request(`/api/projects/${id}/attachments/${attachment.id}`, {
      method: 'DELETE',
      headers: authHeaders(cookie),
    });
    assert.equal(deleted.status, 204);
    assert.equal(app.store.attachments.findOcr(attachment.id), null);
    assert.equal(app.store.ocrFieldRevisions.list(attachment.id).length, 0);
  });
});
