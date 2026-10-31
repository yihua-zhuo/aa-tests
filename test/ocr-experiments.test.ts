import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { OcrBenchFile, OcrChannel } from '../shared/types.ts';
import { OcrClient } from '../src/ocr.ts';
import { OcrBench, splitOf, templateKeyOf } from '../src/ocr-bench.ts';
import {
  experimentScore,
  normalizeExperimentRequest,
  type OcrExperimentSample,
  type OcrExperimentVariant,
  rankExperimentSummaries,
  selectExperimentFiles,
} from '../src/ocr-experiments.ts';
import { Store } from '../src/store.ts';

function file(name: string, lang: string, kind = 'image'): OcrBenchFile {
  const template = templateKeyOf(name, { kind });
  return {
    name,
    engine: 'paddle',
    kind,
    lang,
    difficulty: null,
    degradations: [],
    provenance: null,
    uncertain: [],
    template,
    split: splitOf(name, { kind }, template),
  };
}

function variant(id: string, overrides: Partial<OcrExperimentVariant> = {}): OcrExperimentVariant {
  return {
    id,
    label: id,
    engine: 'paddle',
    modelId: null,
    profile: id,
    mode: 'auto',
    dpi: null,
    channel: 'rgb',
    preprocess: 'original',
    ...overrides,
  };
}

function sample(
  variantId: string,
  overrides: Partial<OcrExperimentSample> = {},
): OcrExperimentSample {
  return {
    name: 'a.png',
    kind: 'image',
    lang: 'zh',
    variantId,
    status: 'done',
    cer: 0.1,
    rawCer: 0.1,
    numericCer: 0.1,
    wer: null,
    fieldRate: 0.9,
    confidence: 0.9,
    seconds: 1,
    characters: 10,
    error: null,
    ...overrides,
  };
}

describe('model/preprocessing experiments', () => {
  test('normalizes defaults and rejects unusable matrices', () => {
    const normalized = normalizeExperimentRequest({ variants: [{ id: 'a' }] });
    assert.equal(normalized.sample, 3);
    assert.equal(normalized.topK, 1);
    assert.equal(normalized.full, true);
    assert.equal(normalized.variants[0]?.mode, 'auto');
    assert.equal(normalized.variants[0]?.channel, 'rgb');
    assert.equal(normalized.variants[0]?.preprocess, 'original');
    assert.throws(() => normalizeExperimentRequest({ variants: [] }), /至少需要/);
    assert.throws(
      () => normalizeExperimentRequest({ variants: [{ id: 'a' }, { id: 'a' }] }),
      /重复/,
    );
    assert.throws(() => normalizeExperimentRequest({ variants: [{ id: 'a', dpi: 90 }] }), /dpi/);
    assert.throws(
      () =>
        normalizeExperimentRequest({
          variants: [{ id: 'a', channel: 'blue' as OcrChannel }],
        }),
      /通道/,
    );
    assert.throws(
      () =>
        normalizeExperimentRequest({
          variants: [{ id: 'a', engine: 'docling', channel: 'red' }],
        }),
      /PaddleOCR/,
    );
    assert.throws(() => normalizeExperimentRequest({ variants: [{ id: 'a' }], topK: 2 }), /topK/);
  });

  test('marks enhanced mode as preprocessing and keeps explicit overrides', () => {
    const normalized = normalizeExperimentRequest({
      variants: [{ id: 'v', modelId: 'paddle-v6-server', mode: 'enhanced', dpi: 300 }],
    });
    assert.equal(normalized.variants[0]?.preprocess, 'enhanced');
    assert.equal(normalized.variants[0]?.modelId, 'paddle-v6-server');
    assert.equal(normalized.variants[0]?.dpi, 300);
  });

  test('screens a stratified sample instead of the first N files', () => {
    const files = [
      file('a.png', 'zh', 'image'),
      file('b.png', 'zh', 'image'),
      file('c.png', 'en', 'image'),
      file('d.pdf', 'zh-en', 'text-pdf'),
    ];
    const picked = selectExperimentFiles(files, 3);
    assert.deepEqual(
      picked.map((entry) => entry.name),
      ['a.png', 'c.png', 'd.pdf'],
    );
    assert.equal(selectExperimentFiles(files, 10).length, 4);
  });

  test('ranks by accuracy first and penalizes failures and cost', () => {
    const variants = [variant('fast'), variant('accurate'), variant('broken')];
    const results = [
      sample('fast'),
      sample('fast', { name: 'b.png' }),
      sample('accurate', { cer: 0.01, numericCer: 0.01, fieldRate: 1 }),
      sample('accurate', { name: 'b.png', cer: 0.01, numericCer: 0.01, fieldRate: 1 }),
      sample('broken', {
        status: 'failed',
        cer: null,
        rawCer: null,
        numericCer: null,
        fieldRate: null,
      }),
      sample('broken', {
        name: 'b.png',
        status: 'failed',
        cer: null,
        rawCer: null,
        numericCer: null,
        fieldRate: null,
      }),
    ];
    const summaries = rankExperimentSummaries(variants, results, new Map());
    assert.deepEqual(
      summaries.map((entry) => [entry.id, entry.rank]),
      [
        ['accurate', 1],
        ['fast', 2],
        ['broken', null],
      ],
    );
    assert.ok((summaries[0]?.score ?? 0) > (summaries[1]?.score ?? 0));
    const cheaper = experimentScore({
      files: 2,
      failed: 0,
      meanCer: 0.01,
      meanNumericCer: 0.01,
      fieldRate: 1,
      meanSeconds: 1,
      memoryMb: 600,
    });
    const heavier = experimentScore({
      files: 2,
      failed: 0,
      meanCer: 0.01,
      meanNumericCer: 0.01,
      fieldRate: 1,
      meanSeconds: 1,
      memoryMb: 2_600,
    });
    assert.ok((cheaper ?? 0) > (heavier ?? 1));
  });
});

function experimentSidecar(): Promise<{
  url: string;
  requests: { model?: string; mode?: string; dpi?: number; channel?: string; name?: string }[];
  close: () => Promise<void>;
}> {
  const requests: {
    model?: string;
    mode?: string;
    dpi?: number;
    channel?: string;
    name?: string;
  }[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/health') {
        res.end(JSON.stringify({ ok: true, model: 'fake', model_profiles: ['good', 'weak'] }));
        return;
      }
      const body = raw
        ? (JSON.parse(raw) as {
            model?: string;
            mode?: string;
            dpi?: number;
            channel?: string;
            name?: string;
          })
        : {};
      requests.push(body);
      const text =
        body.model === 'good' ? '金额 100' : body.model === 'weak' ? '金额 1OO' : '金额 999';
      res.end(
        JSON.stringify({
          text,
          engine: 'fake',
          model: body.model ?? 'default',
          confidence: 0.9,
          pages: 1,
        }),
      );
    });
  });
  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return {
      url: `http://127.0.0.1:${address.port}`,
      requests,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  });
}

describe('experiment runner', () => {
  test('screens variants, promotes the winner and runs the full corpus', async (t) => {
    const sidecar = await experimentSidecar();
    t.after(sidecar.close);
    const corpus = mkdtempSync(join(tmpdir(), 'clay-exp-corpus-'));
    const uploads = mkdtempSync(join(tmpdir(), 'clay-exp-uploads-'));
    const store = new Store(':memory:', { demo: true, demoAccounts: true, uploadDir: uploads });
    t.after(() => {
      store.close();
      rmSync(corpus, { recursive: true, force: true });
      rmSync(uploads, { recursive: true, force: true });
    });
    writeFileSync(
      join(corpus, 'ground_truth.json'),
      JSON.stringify({
        'a.png': { kind: 'image', lang: 'zh', text: '金额 100', fields: { amount: '100' } },
        'b.png': { kind: 'image', lang: 'zh', text: '金额 100', fields: { amount: '100' } },
      }),
    );
    writeFileSync(join(corpus, 'a.png'), 'a');
    writeFileSync(join(corpus, 'b.png'), 'b');

    const lab = new OcrBench(store, new OcrClient({ paddleUrl: sidecar.url }), corpus);
    await lab.startExperiment({
      variants: [
        { id: 'good', profile: 'good', mode: 'auto', modelId: 'paddle-v6-medium' },
        {
          id: 'weak',
          profile: 'weak',
          mode: 'enhanced',
          dpi: 300,
          channel: 'red',
          modelId: 'paddle-v6-tiny',
        },
      ],
      sample: 2,
      topK: 1,
    });
    const deadline = Date.now() + 5_000;
    while (lab.experimentStatus()?.status === 'running' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const result = lab.experimentStatus();
    assert.ok(result);
    assert.equal(result.status, 'done');
    assert.equal(result.stage, 'full');
    assert.equal(result.screen.results.length, 4);
    assert.deepEqual(result.selected, ['good']);
    assert.equal(result.full?.results.length, 2);
    assert.equal(result.screen.summaries[0]?.id, 'good');
    assert.equal(result.screen.summaries[0]?.meanCer, 0);
    assert.ok((result.screen.summaries[1]?.meanCer ?? 0) > 0);
    assert.equal(result.screen.summaries[0]?.license, 'Apache-2.0');
    assert.equal(result.screen.summaries[0]?.memoryMb, 1_200);
    assert.equal(result.full?.summaries[0]?.id, 'good');
    const weak = sidecar.requests.find((request) => request.model === 'weak');
    assert.equal(weak?.mode, 'enhanced');
    assert.equal(weak?.dpi, 300);
    assert.equal(weak?.channel, 'red');
    const good = sidecar.requests.find((request) => request.model === 'good');
    assert.equal(good?.mode, 'auto');
    assert.equal(good?.channel, 'rgb');
    assert.equal(result.screen.summaries[1]?.channel, 'red');
  });
});
