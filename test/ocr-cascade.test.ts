import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type {
  DocumentFieldEvidence,
  DocumentIr,
  DocumentQuality,
  DocumentSpecializedFinding,
  OcrInkGap,
  OcrRegionInput,
  OcrRegionResult,
  OcrStage,
  OcrStageKind,
} from '../shared/types.ts';
import { Database } from '../src/db.ts';
import type { OcrClient, OcrExtraction, OcrInput } from '../src/ocr.ts';
import type { SpecializedRegionInput, VlmRegionInput } from '../src/ocr-adapters.ts';
import {
  compareQualityLayers,
  findReplayStage,
  recoveryPrior,
  recoveryYieldMinSamples,
  recoveryYieldOutcomes,
  replayOcrStage,
  runOcrCascade,
  smoothedRecoveryYield,
} from '../src/ocr-cascade.ts';
import { OcrYieldStore } from '../src/stores/ocr-yields.ts';

type Responder = (input: OcrInput) => OcrExtraction;
type RegionResponder = (input: OcrRegionInput) => OcrRegionResult;
type AdvisorResponder<T> = (input: T) => OcrRegionResult;

function extraction(overrides: Partial<OcrExtraction> = {}): OcrExtraction {
  return {
    text: '识别文本',
    engine: 'paddle',
    model: 'model-a',
    confidence: 0.96,
    pages: 1,
    truncated: false,
    route: 'visual',
    document: null,
    ...overrides,
  };
}

function stubClient(
  responses: Responder[],
  regions: RegionResponder[] = [],
  advisors: {
    specialized?: AdvisorResponder<SpecializedRegionInput>;
    vlm?: AdvisorResponder<VlmRegionInput>;
  } = {},
) {
  const calls: OcrInput[] = [];
  const engineCalls: string[] = [];
  const regionCalls: OcrRegionInput[] = [];
  const specialCalls: SpecializedRegionInput[] = [];
  const vlmCalls: VlmRegionInput[] = [];
  let index = 0;
  let regionIndex = 0;
  const client = {
    get vlmConfigured(): boolean {
      return Boolean(advisors.vlm);
    },
    get specializedConfigured(): boolean {
      return Boolean(advisors.specialized);
    },
    async extract(engine: string, input: OcrInput): Promise<OcrExtraction> {
      engineCalls.push(engine);
      calls.push({ ...input });
      const responder = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (!responder) throw new Error('未配置响应');
      return responder(input);
    },
    async extractRegion(_engine: string, input: OcrRegionInput): Promise<OcrRegionResult> {
      regionCalls.push({ ...input });
      const responder = regions[Math.min(regionIndex, regions.length - 1)];
      regionIndex += 1;
      if (!responder) throw new Error('未配置区域响应');
      return responder(input);
    },
    async recognizeSpecial(input: SpecializedRegionInput): Promise<OcrRegionResult> {
      specialCalls.push(input);
      if (!advisors.specialized) throw new Error('未配置专用区域响应');
      return advisors.specialized(input);
    },
    async repairRegion(input: VlmRegionInput): Promise<OcrRegionResult> {
      vlmCalls.push(input);
      if (!advisors.vlm) throw new Error('未配置 VLM 响应');
      return advisors.vlm(input);
    },
  } as unknown as OcrClient;
  return { client, calls, engineCalls, regionCalls, specialCalls, vlmCalls };
}

function weakTableDocument(): DocumentIr {
  return {
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
            text: 'a b c',
            bbox: null,
            confidence: 0.3,
            source: { engine: 'paddle', model: 'model-a', stage: 'visual' },
            validation: null,
            order: 0,
            rows: [
              ['a', 'b', 'c'],
              ['1', '2'],
            ],
          },
        ],
        source: null,
      },
    ],
    readingOrder: ['t1'],
    meta: {},
  };
}

function corruptTableDocument(): DocumentIr {
  return {
    version: 1,
    route: 'visual',
    pages: [
      {
        number: 1,
        width: 300,
        height: 200,
        blocks: [
          {
            id: 't1',
            type: 'table',
            text: '项目 金额\n服务费 1,2?0',
            bbox: { x: 0, y: 0, width: 200, height: 100 },
            confidence: 0.4,
            source: { engine: 'paddle', model: 'model-a', stage: 'visual' },
            validation: null,
            order: 0,
            rows: [
              ['项目', '金额'],
              ['服务费', '1,2?0'],
            ],
          },
        ],
        source: null,
      },
    ],
    readingOrder: ['t1'],
    meta: {},
  };
}

function keyFieldDocument(): DocumentIr {
  return {
    version: 1,
    route: 'visual',
    pages: [
      {
        number: 1,
        width: 1000,
        height: 1000,
        blocks: [
          {
            id: 'b1',
            type: 'paragraph',
            text: '季度报告',
            bbox: { x: 0, y: 0, width: 100, height: 20 },
            confidence: 0.98,
            source: { engine: 'paddle', model: 'model-a', stage: 'visual' },
            validation: null,
            order: 0,
          },
          {
            id: 'b2',
            type: 'paragraph',
            text: '合计 1,280 元',
            bbox: { x: 10, y: 40, width: 200, height: 30 },
            confidence: 0.4,
            source: { engine: 'paddle', model: 'model-a', stage: 'visual' },
            validation: null,
            order: 1,
          },
        ],
        source: null,
      },
    ],
    readingOrder: ['b1', 'b2'],
    meta: {},
  };
}

function coverageDocument(pagesWithText: number, confidence: number): DocumentIr {
  return {
    version: 1,
    route: 'visual',
    pages: [1, 2].map((number) => ({
      number,
      width: 600,
      height: 800,
      blocks:
        number <= pagesWithText
          ? [
              {
                id: `p${number}-b1`,
                type: 'paragraph' as const,
                text: `第 ${number} 页正文`,
                bbox: { x: 20, y: 20, width: 400, height: 40 },
                confidence,
                source: { engine: 'paddle' as const, model: 'model-a', stage: 'visual' },
                validation: null,
                order: 0,
              },
            ]
          : [],
      source: null,
    })),
    readingOrder: [1, 2].slice(0, pagesWithText).map((number) => `p${number}-b1`),
    meta: {},
  };
}

function quality(overrides: Partial<DocumentQuality> = {}): DocumentQuality {
  return {
    score: 0.8,
    status: 'review',
    calibrated: false,
    signals: { keyFieldCoverage: 1, coverage: 1 },
    issues: [],
    components: {
      ocrConfidence: null,
      structureConfidence: null,
      fieldValidation: null,
      businessConsistency: null,
    },
    hardRisks: [],
    ...overrides,
  };
}

describe('OCR recovery cascade', () => {
  test('runs one enhanced recovery for a weak image and keeps the best result', async () => {
    const stub = stubClient([
      () => extraction({ text: '模糊文本', confidence: 0.3 }),
      () => extraction({ text: '清晰文本', confidence: 0.96 }),
    ]);
    const result = await runOcrCascade(stub.client, 'paddle', {
      path: '/tmp/scan.png',
      name: 'scan.png',
    });

    assert.deepEqual(
      stub.calls.map((call) => [call.mode ?? 'auto', call.dpi ?? null]),
      [
        ['auto', null],
        ['enhanced', null],
      ],
    );
    assert.equal(result.extraction.text, '清晰文本');
    assert.equal(result.quality.status, 'pass');
    assert.deepEqual(
      result.stages.map((stage) => [stage.kind, stage.status, stage.score]),
      [
        ['visual', 'done', 0.3],
        ['recovery_enhance', 'done', 0.96],
      ],
    );
    assert.equal(result.stages[1]?.trigger, 'low_confidence');
    assert.equal(result.stages[1]?.decision?.trigger, 'low_confidence');
    assert.ok((result.stages[1]?.decision?.expectedGain ?? 0) > 0);
    assert.ok((result.stages[1]?.decision?.value ?? 0) > 0);
  });

  test('layered selection prefers key region coverage over a higher blended score', () => {
    const current = quality({ score: 0.7 });
    const missingKey = quality({
      score: 0.95,
      signals: { keyFieldCoverage: 0.4, coverage: 1 },
    });
    assert.equal(compareQualityLayers(current, missingKey), 'current');
    assert.equal(compareQualityLayers(missingKey, current), 'next');
  });

  test('layered selection prefers page coverage and fewer hard risks first', () => {
    const current = quality({ score: 0.7 });
    const missingPage = quality({
      score: 0.95,
      signals: { keyFieldCoverage: 1, coverage: 0.5 },
    });
    assert.equal(compareQualityLayers(current, missingPage), 'current');

    const risky = quality({
      score: 0.99,
      hardRisks: [
        {
          code: 'key_field_low_confidence',
          severity: 'warning',
          message: '关键字段置信度偏低',
          page: 1,
          blockId: 'b1',
        },
      ],
    });
    assert.equal(compareQualityLayers(risky, current), 'next');
    assert.equal(compareQualityLayers(current, quality({ score: 0.702 })), 'tie');
  });

  test('layered selection protects table structure and reading order', () => {
    const current = quality({
      score: 0.7,
      signals: {
        keyFieldCoverage: 1,
        coverage: 1,
        validation: 1,
        tableIntegrity: 1,
        readingOrder: 1,
      },
    });
    const brokenTable = quality({
      score: 0.95,
      signals: {
        keyFieldCoverage: 1,
        coverage: 1,
        validation: 1,
        tableIntegrity: 0.4,
        readingOrder: 1,
      },
    });
    assert.equal(compareQualityLayers(current, brokenTable), 'current');

    const brokenOrder = quality({
      score: 0.95,
      signals: {
        keyFieldCoverage: 1,
        coverage: 1,
        validation: 1,
        tableIntegrity: 1,
        readingOrder: 0.5,
      },
    });
    assert.equal(compareQualityLayers(current, brokenOrder), 'current');

    const failedValidation = quality({
      score: 0.95,
      signals: {
        keyFieldCoverage: 1,
        coverage: 1,
        validation: 0.6,
        tableIntegrity: 1,
        readingOrder: 1,
      },
    });
    assert.equal(compareQualityLayers(current, failedValidation), 'current');
  });

  test('layered selection keeps the extraction with full page coverage', async () => {
    const stub = stubClient([
      () =>
        extraction({
          text: '模糊文本',
          confidence: 0.3,
          document: coverageDocument(2, 0.3),
        }),
      () =>
        extraction({
          text: '清晰但少一页',
          confidence: 0.99,
          document: coverageDocument(1, 0.99),
        }),
    ]);
    const result = await runOcrCascade(
      stub.client,
      'paddle',
      { path: '/tmp/scan.png', name: 'scan.png' },
      { maxStages: 2 },
    );

    assert.equal(result.stages.length, 2);
    assert.equal(result.extraction.text, '模糊文本');
    assert.equal(result.quality.signals.coverage, 1);
  });

  test('re-runs with the detected profile when the declared language disagrees', async () => {
    const stub = stubClient([
      () =>
        extraction({
          text: '这是一份中文合同，金额为人民币一千二百八十元整。',
          confidence: 0.96,
        }),
      () =>
        extraction({
          text: 'This is the same contract, retried with an English profile.',
          confidence: 0.97,
        }),
    ]);
    const result = await runOcrCascade(
      stub.client,
      'paddle',
      {
        path: '/tmp/contract.png',
        name: 'contract.png',
        lang: 'en',
      },
      // The contract schema now keeps both passes in review, so bound the run
      // to the language rerun this test is about.
      { maxStages: 2 },
    );

    assert.deepEqual(
      stub.calls.map((call) => [call.mode ?? 'auto', call.lang ?? null]),
      [
        ['auto', 'en'],
        ['auto', 'ch'],
      ],
    );
    assert.equal(result.stages[1]?.trigger, 'language_mismatch');
  });

  test('routes glare and skew image issues to targeted enhanced triggers', async () => {
    const glareStub = stubClient([
      () =>
        extraction({
          text: '反光文本',
          confidence: 0.95,
          preflight: {
            width: 1600,
            height: 2200,
            sharpness: 0.6,
            brightness: 0.55,
            contrast: 0.4,
            dpi: 300,
            glare: 0.06,
          },
        }),
      () =>
        extraction({
          text: '清晰文本',
          confidence: 0.96,
          preflight: {
            width: 1600,
            height: 2200,
            sharpness: 0.6,
            brightness: 0.55,
            contrast: 0.4,
            dpi: 300,
            glare: 0,
          },
        }),
    ]);
    const glare = await runOcrCascade(glareStub.client, 'paddle', {
      path: '/tmp/scan.png',
      name: 'scan.png',
    });
    assert.equal(glare.stages[1]?.trigger, 'image_quality');
    assert.ok(glare.stages[0]?.quality?.issues.includes('image_glare'));

    const skewStub = stubClient([
      () =>
        extraction({
          text: '倾斜文本',
          confidence: 0.95,
          preflight: {
            width: 1600,
            height: 2200,
            sharpness: 0.6,
            brightness: 0.55,
            contrast: 0.4,
            dpi: 300,
            skew: 7,
          },
        }),
      () => extraction({ text: '清晰文本', confidence: 0.96 }),
    ]);
    const skew = await runOcrCascade(skewStub.client, 'paddle', {
      path: '/tmp/scan.png',
      name: 'scan.png',
    });
    assert.equal(skew.stages[1]?.trigger, 'orientation_uncertain');
  });

  test('labels native extractions', async () => {
    const stub = stubClient([() => extraction({ route: 'native' })]);
    const result = await runOcrCascade(stub.client, 'paddle', {
      path: '/tmp/report.pdf',
      name: 'report.pdf',
    });
    assert.equal(result.stages[0]?.kind, 'native');
    assert.equal(result.stages.length, 1);
  });

  test('does not recover for non-Paddle engines, native routes or truncated results', async () => {
    const docling = stubClient([() => extraction({ confidence: 0.3 })]);
    const doclingResult = await runOcrCascade(docling.client, 'docling', {
      path: '/tmp/report.docx',
      name: 'report.docx',
    });
    assert.equal(docling.calls.length, 1);
    assert.equal(doclingResult.stages.length, 1);

    const native = stubClient([() => extraction({ route: 'native', confidence: 0.3 })]);
    await runOcrCascade(native.client, 'paddle', {
      path: '/tmp/report.pdf',
      name: 'report.pdf',
    });
    assert.equal(native.calls.length, 1);

    const truncated = stubClient([() => extraction({ confidence: 0.3, truncated: true })]);
    await runOcrCascade(truncated.client, 'paddle', {
      path: '/tmp/long.pdf',
      name: 'long.pdf',
    });
    assert.equal(truncated.calls.length, 1);
  });

  test('never replaces a complete result with a truncated rerun', async () => {
    const stub = stubClient([
      () => extraction({ text: '完整正文', confidence: 0.3 }),
      () => extraction({ text: '截断正文', confidence: 0.99, truncated: true }),
    ]);
    const result = await runOcrCascade(stub.client, 'paddle', {
      path: '/tmp/long.png',
      name: 'long.png',
    });

    assert.equal(result.stages.length, 2);
    assert.equal(result.extraction.text, '完整正文');
    assert.equal(result.extraction.truncated, false);
  });

  test('tries structure before higher DPI for PDF tables', async () => {
    const stub = stubClient([
      () => extraction({ text: '表格', confidence: 0.3, document: weakTableDocument() }),
      () => extraction({ text: '表格重试', confidence: 0.55, document: weakTableDocument() }),
      () => extraction({ text: '表格高清', confidence: 0.96 }),
    ]);
    const result = await runOcrCascade(stub.client, 'paddle', {
      path: '/tmp/table.pdf',
      name: 'table.pdf',
      dpi: 200,
    });

    assert.deepEqual(
      stub.calls.map((call) => [call.mode ?? 'auto', call.dpi ?? null]),
      [
        ['auto', 200],
        ['structure', 300],
        ['auto', 300],
      ],
    );
    assert.deepEqual(
      result.stages.map((stage) => stage.kind),
      ['visual', 'recovery_structure', 'recovery_dpi'],
    );
    assert.equal(result.stages[1]?.trigger, 'table_structure');
    assert.equal(result.stages[2]?.trigger, 'low_confidence');
    assert.equal(result.extraction.text, '表格高清');
    assert.equal(result.quality.status, 'pass');
  });

  test('keeps enhanced mode when raising PDF DPI', async () => {
    const stub = stubClient([
      () => extraction({ confidence: 0.3 }),
      () => extraction({ text: '增强清晰', confidence: 0.96 }),
    ]);
    const result = await runOcrCascade(stub.client, 'paddle', {
      path: '/tmp/scan.pdf',
      name: 'scan.pdf',
      mode: 'enhanced',
      dpi: 200,
    });

    assert.deepEqual(
      stub.calls.map((call) => [call.mode, call.dpi]),
      [
        ['enhanced', 200],
        ['enhanced', 300],
      ],
    );
    assert.equal(result.extraction.text, '增强清晰');
  });

  test('does not run the same structure/DPI recovery twice', async () => {
    const stub = stubClient([
      () => extraction({ text: '表格', confidence: 0.3, document: weakTableDocument() }),
      () => extraction({ text: '表格重试', confidence: 0.3, document: weakTableDocument() }),
    ]);
    const result = await runOcrCascade(stub.client, 'paddle', {
      path: '/tmp/table.pdf',
      name: 'table.pdf',
      mode: 'structure',
      dpi: 200,
    });

    assert.deepEqual(
      stub.calls.map((call) => [call.mode ?? 'auto', call.dpi ?? null]),
      [
        ['structure', 200],
        ['structure', 300],
      ],
    );
    assert.deepEqual(
      result.stages.map((stage) => stage.kind),
      ['visual', 'recovery_structure'],
    );
  });

  test('adopts a whole-page model candidate only when the blended score improves', async () => {
    const stub = stubClient([
      () => extraction({ text: '模糊文本', confidence: 0.3 }),
      () => extraction({ text: '增强文本', confidence: 0.35 }),
      () => extraction({ text: '清晰结果', confidence: 0.97, model: 'model-b' }),
    ]);
    const result = await runOcrCascade(
      stub.client,
      'paddle',
      { path: '/tmp/scan.png', name: 'scan.png' },
      { fallbackModels: ['model-b'] },
    );

    assert.deepEqual(
      stub.calls.map((call) => [call.mode ?? 'auto', call.model ?? null]),
      [
        ['auto', null],
        ['enhanced', null],
        ['auto', 'model-b'],
      ],
    );
    assert.deepEqual(
      result.stages.map((stage) => stage.kind),
      ['visual', 'recovery_enhance', 'candidate'],
    );
    const candidate = result.stages[2];
    assert.equal(candidate?.model, 'model-b');
    assert.equal(candidate?.params?.model, 'model-b');
    assert.equal(candidate?.trigger, 'low_confidence');
    assert.match(candidate?.message ?? '', /候选模型 model-b/);
    assert.match(candidate?.message ?? '', /采用/);
    assert.equal(result.extraction.text, '清晰结果');

    const replayStub = stubClient([
      () => extraction({ text: '清晰结果', confidence: 0.97, model: 'model-b' }),
    ]);
    const replay = await replayOcrStage(
      replayStub.client,
      'paddle',
      { path: '/tmp/scan.png', name: 'scan.png' },
      result.stages,
      { kind: 'candidate' },
    );
    assert.equal(replayStub.calls[0]?.model, 'model-b');
    assert.equal(replay.extraction?.text, '清晰结果');
  });

  test('keeps the current text when a model candidate scores worse', async () => {
    const stub = stubClient([
      () => extraction({ text: '模糊文本', confidence: 0.3 }),
      () => extraction({ text: '增强文本段落', confidence: 0.6 }),
      () => extraction({ text: '错误文本', confidence: 0.2, model: 'model-b' }),
    ]);
    const result = await runOcrCascade(
      stub.client,
      'paddle',
      { path: '/tmp/scan.png', name: 'scan.png' },
      { fallbackModels: ['model-b'] },
    );

    const candidate = result.stages.find((stage) => stage.kind === 'candidate');
    assert.equal(candidate?.status, 'done');
    assert.match(candidate?.message ?? '', /保留原结果/);
    assert.equal(result.extraction.text, '增强文本段落');
  });

  test('runs a cross-engine candidate without inheriting the primary model', async () => {
    const stub = stubClient([
      () => extraction({ text: '模糊文本', confidence: 0.3 }),
      () => extraction({ text: '增强文本', confidence: 0.35 }),
      () => extraction({ text: '清晰结果', engine: 'docling', model: 'docling', confidence: 0.97 }),
    ]);
    const result = await runOcrCascade(
      stub.client,
      'paddle',
      { path: '/tmp/scan.png', name: 'scan.png', model: 'model-a' },
      { candidateEngines: ['docling', 'docling'] },
    );

    assert.deepEqual(stub.engineCalls, ['paddle', 'paddle', 'docling']);
    assert.equal(stub.calls[2]?.model, undefined);
    assert.equal(result.stages.filter((stage) => stage.kind === 'candidate').length, 1);
    const candidate = result.stages[2];
    assert.equal(candidate?.kind, 'candidate');
    assert.equal(candidate?.engine, 'docling');
    assert.equal(candidate?.model, 'docling');
    assert.equal(candidate?.params?.model, null);
    assert.match(candidate?.message ?? '', /候选引擎 docling/);
    assert.match(candidate?.message ?? '', /采用/);
    assert.equal(result.extraction.engine, 'docling');

    const replayStub = stubClient([
      () => extraction({ text: '清晰结果', engine: 'docling', model: 'docling', confidence: 0.97 }),
    ]);
    const replay = await replayOcrStage(
      replayStub.client,
      'paddle',
      { path: '/tmp/scan.png', name: 'scan.png' },
      result.stages,
      { kind: 'candidate' },
    );
    assert.deepEqual(replayStub.engineCalls, ['docling']);
    assert.equal(replay.engine, 'docling');
    assert.equal(replay.extraction?.text, '清晰结果');
  });

  test('keeps the primary result when the candidate engine fails', async () => {
    const stub = stubClient([
      () => extraction({ text: '模糊文本', confidence: 0.3 }),
      () => extraction({ text: '增强文本', confidence: 0.4 }),
      () => {
        throw new Error('Docling 服务不可用');
      },
    ]);
    const result = await runOcrCascade(
      stub.client,
      'paddle',
      { path: '/tmp/scan.png', name: 'scan.png' },
      { candidateEngines: ['docling'] },
    );

    assert.deepEqual(stub.engineCalls, ['paddle', 'paddle', 'docling']);
    const candidate = result.stages.find((stage) => stage.kind === 'candidate');
    assert.equal(candidate?.status, 'failed');
    assert.equal(candidate?.engine, 'docling');
    assert.equal(candidate?.model, null);
    assert.equal(candidate?.params?.model, null);
    assert.match(candidate?.message ?? '', /Docling 服务不可用/);
    assert.equal(result.extraction.text, '增强文本');
    assert.equal(result.extraction.engine, 'paddle');
  });

  test('refuses a truncated cross-engine candidate', async () => {
    const stub = stubClient([
      () => extraction({ text: '模糊文本', confidence: 0.3 }),
      () => extraction({ text: '增强文本', confidence: 0.4 }),
      () =>
        extraction({
          text: '候选截断文本',
          engine: 'docling',
          model: 'docling',
          confidence: 0.99,
          truncated: true,
        }),
    ]);
    const result = await runOcrCascade(
      stub.client,
      'paddle',
      { path: '/tmp/scan.png', name: 'scan.png' },
      { candidateEngines: ['docling'] },
    );

    const candidate = result.stages.find((stage) => stage.kind === 'candidate');
    assert.equal(candidate?.status, 'done');
    assert.match(candidate?.message ?? '', /候选已截断/);
    assert.equal(result.extraction.text, '增强文本');
    assert.equal(result.extraction.engine, 'paddle');
    assert.equal(result.extraction.truncated, false);
  });

  test('records failed recovery attempts without losing the first extraction', async () => {
    const stub = stubClient([
      () => extraction({ text: '原始文本', confidence: 0.3 }),
      () => {
        throw new Error('增强模型崩溃');
      },
    ]);
    const result = await runOcrCascade(stub.client, 'paddle', {
      path: '/tmp/scan.png',
      name: 'scan.png',
    });

    assert.equal(result.extraction.text, '原始文本');
    assert.equal(result.stages.length, 2);
    assert.equal(result.stages[1]?.status, 'failed');
    assert.match(result.stages[1]?.message ?? '', /增强模型崩溃/);
  });

  test('re-reads a corrupt table cell without rewriting the original value', async () => {
    const stub = stubClient(
      [
        () =>
          extraction({
            text: '项目 金额\n服务费 1,2?0',
            confidence: 0.4,
            document: corruptTableDocument(),
          }),
      ],
      [
        () => ({
          text: '1,280',
          confidence: 0.95,
          engine: 'paddle',
          model: 'model-a',
          seconds: 0.3,
        }),
      ],
    );
    const result = await runOcrCascade(
      stub.client,
      'paddle',
      { path: '/tmp/table.png', name: 'table.png' },
      { maxStages: 2 },
    );

    assert.equal(stub.regionCalls.length, 2);
    const bbox = { x: 100, y: 50, width: 100, height: 50 };
    assert.deepEqual(
      stub.regionCalls.map((call) => [call.mode, call.padding, call.bbox]),
      [
        ['auto', 0.35, bbox],
        ['enhanced', 0.6, bbox],
      ],
    );
    assert.deepEqual(
      result.stages.map((stage) => stage.kind),
      ['visual', 'recovery_cell'],
    );
    assert.equal(result.stages[1]?.trigger, 'cell_recovery');
    assert.equal(result.stages[1]?.decision?.trigger, 'cell_recovery');
    assert.equal(result.extraction.text, '项目 金额\n服务费 1,2?0');

    const document = result.extraction.document as DocumentIr;
    const table = document.pages[0]?.blocks.find((block) => block.id === 't1');
    assert.equal(table?.rows?.[1]?.[1], '1,2?0');
    const evidence = document.meta.fieldEvidence as DocumentFieldEvidence[];
    assert.equal(evidence?.length, 1);
    assert.deepEqual(evidence[0]?.cell, {
      row: 1,
      column: 1,
      header: '金额',
      bboxEstimated: true,
    });
    assert.equal(evidence[0]?.text, '1,2?0');
    assert.equal(evidence[0]?.agreement, 'conflict');
    assert.equal(evidence[0]?.selected, 'candidate');
    assert.equal(evidence[0]?.reason, 'candidate_selected');
  });

  function genericLineDocument(): DocumentIr {
    return {
      version: 1,
      route: 'visual',
      pages: [
        {
          number: 1,
          width: 1000,
          height: 1000,
          blocks: [
            {
              id: 'b1',
              type: 'paragraph',
              text: '季度报告',
              bbox: { x: 0, y: 0, width: 100, height: 20 },
              confidence: 0.98,
              source: { engine: 'paddle', model: 'model-a', stage: 'visual' },
              validation: null,
              order: 0,
            },
            {
              id: 'b2',
              type: 'paragraph',
              text: '本季度业务保持稳定增长',
              bbox: { x: 10, y: 40, width: 300, height: 30 },
              confidence: 0.3,
              source: { engine: 'paddle', model: 'model-a', stage: 'visual' },
              validation: null,
              order: 1,
            },
          ],
          source: null,
        },
      ],
      readingOrder: ['b1', 'b2'],
      meta: {},
    };
  }

  test('re-reads an ordinary low-confidence line and labels the trigger', async () => {
    const stub = stubClient(
      [
        () =>
          extraction({
            text: '季度报告\n本季度业务保持稳定增长',
            confidence: 0.3,
            document: genericLineDocument(),
          }),
      ],
      [
        () => ({
          text: '本季度业务保持稳定增长',
          confidence: 0.94,
          engine: 'paddle',
          model: 'model-a',
          seconds: 0.2,
        }),
      ],
    );
    const result = await runOcrCascade(
      stub.client,
      'paddle',
      {
        path: '/tmp/line.png',
        name: 'line.png',
      },
      { maxStages: 2 },
    );

    assert.equal(stub.regionCalls.length, 1);
    assert.equal(stub.regionCalls[0]?.padding, 0.35);
    assert.equal(stub.regionCalls[0]?.mode, 'auto');
    assert.deepEqual(
      result.stages.map((stage) => stage.kind),
      ['visual', 'recovery_region'],
    );
    assert.equal(result.stages[1]?.trigger, 'low_confidence');
    assert.deepEqual(result.stages[1]?.message?.includes('个区域完成复认'), true);
    const document = result.extraction.document as DocumentIr;
    const evidence = document.meta.fieldEvidence as DocumentFieldEvidence[];
    assert.equal(evidence?.length, 1);
    assert.equal(evidence[0]?.kind, 'text');
    assert.equal(evidence[0]?.agreement, 'confirmed_same_engine');
    assert.equal(result.extraction.text, '季度报告\n本季度业务保持稳定增长');
  });

  function inkGapDocument(gaps?: OcrInkGap[]): DocumentIr {
    return {
      version: 1,
      route: 'visual',
      pages: [
        {
          number: 1,
          width: 1000,
          height: 1000,
          blocks: [
            {
              id: 'b1',
              type: 'paragraph',
              text: '季度报告',
              bbox: { x: 0, y: 0, width: 100, height: 20 },
              confidence: 0.98,
              source: { engine: 'paddle', model: 'model-a', stage: 'visual' },
              validation: null,
              order: 0,
            },
          ],
          source: null,
          meta: {
            inkGaps: gaps ?? [
              {
                id: 'p1-g0',
                kind: 'region',
                blockId: null,
                bbox: { x: 0, y: 200, width: 400, height: 24 },
                pixels: 900,
                density: 0.2,
              },
              {
                id: 'p1-g1',
                kind: 'cell',
                blockId: 'b1',
                bbox: { x: 0, y: 400, width: 80, height: 24 },
                pixels: 120,
                density: 0.3,
              },
            ],
          },
        },
      ],
      readingOrder: ['b1'],
      meta: {},
    };
  }

  test('appends recovered ink as its own flagged block', async () => {
    const handed: DocumentIr[] = [];
    const stub = stubClient(
      [
        () => {
          const document = inkGapDocument();
          handed.push(document);
          return extraction({ text: '季度报告', confidence: 0.98, document });
        },
      ],
      [
        (input) => ({
          text: input.bbox.width > 200 ? '漏掉的一整行文字' : '',
          confidence: 0.71,
          engine: 'paddle',
          model: 'model-a',
          seconds: 0.2,
        }),
      ],
    );
    const result = await runOcrCascade(
      stub.client,
      'paddle',
      { path: '/tmp/ink.png', name: 'ink.png', dpi: 200 },
      // Ink recovery runs last, so a whole-page rerun that replaces the document
      // cannot drop the appended block; the stages below cover that ordering.
      { maxStages: 4 },
    );

    const inkStage = result.stages.find((stage) => stage.trigger === 'ink_gap');
    assert.ok(inkStage, '墨迹复认应记录阶段');
    assert.equal(result.stages[result.stages.length - 1], inkStage, '墨迹复认排在最后');
    assert.equal(inkStage?.kind, 'recovery_region');
    assert.equal(inkStage?.status, 'done');
    assert.equal(inkStage?.message?.includes('1/2 处未覆盖墨迹补回文本'), true);
    // The biggest gap first, in the page's own pixel space.
    assert.equal(stub.regionCalls[0]?.bbox?.y, 200);
    assert.equal(stub.regionCalls[0]?.bboxDpi, 200);

    const document = result.extraction.document as DocumentIr;
    const page = document.pages[0] as (typeof document.pages)[number];
    const recovered = page.blocks.find((block) => block.id === 'ink-p1-g0');
    assert.ok(recovered, '补回的文本应成为独立文本块');
    assert.equal(recovered?.text, '漏掉的一整行文字');
    assert.equal(recovered?.validation?.status, 'flagged');
    assert.deepEqual(recovered?.validation?.issues, ['ink_without_text']);
    assert.equal(recovered?.meta?.inkGap, 'p1-g0');
    assert.equal(recovered?.source?.stage, 'recovery');
    assert.equal(page.blocks[0]?.text, '季度报告', '原有文本不被改写');
    assert.deepEqual(document.readingOrder, ['b1', 'ink-p1-g0']);
    assert.equal(result.extraction.text.includes('漏掉的一整行文字'), true);
    // Recovered gap leaves the list; the empty crop keeps its issue.
    assert.deepEqual(
      page.meta?.inkGaps?.map((gap) => gap.id),
      ['p1-g1'],
    );
    const codes = result.quality.issues.map((issue) => issue.code);
    assert.equal(codes.includes('ink_without_text'), true);
    assert.equal(
      result.quality.hardRisks.some((risk) => risk.code === 'ink_without_text'),
      true,
    );
    const evidence = document.meta.fieldEvidence as DocumentFieldEvidence[];
    assert.equal(evidence.length, 1);
    assert.deepEqual(evidence[0]?.inkGap, { id: 'p1-g0', kind: 'region', pixels: 900 });
    assert.equal(evidence[0]?.agreement, 'unverified');

    // Stages fingerprint the extraction they ran on, so recovery must build a new
    // document instead of writing into the one the client returned.
    assert.ok(handed.length >= 1);
    for (const source of handed) {
      assert.equal(source.pages[0]?.blocks.length, 1, '交给阶段的文档不能被改写');
      assert.equal(source.pages[0]?.meta?.inkGaps?.length, 2, '墨迹缺口不能被改写');
      assert.deepEqual(source.readingOrder, ['b1']);
    }
    assert.notEqual(document, handed[0]);
  });

  test('a recovered cell gap stops being reported as unexplained ink', async () => {
    const gap: OcrInkGap = {
      id: 'p1-g1',
      kind: 'cell',
      blockId: 'b1',
      bbox: { x: 0, y: 400, width: 80, height: 24 },
      pixels: 120,
      density: 0.3,
    };
    const stub = stubClient(
      [() => extraction({ text: '季度报告', confidence: 0.98, document: inkGapDocument([gap]) })],
      [
        () => ({
          text: '贰零贰陆年',
          confidence: 0.8,
          engine: 'paddle',
          model: 'model-a',
          seconds: 0.2,
        }),
      ],
    );
    const result = await runOcrCascade(
      stub.client,
      'paddle',
      { path: '/tmp/ink-cell.png', name: 'ink-cell.png' },
      { maxStages: 4 },
    );

    const document = result.extraction.document as DocumentIr;
    const page = document.pages[0] as (typeof document.pages)[number];
    assert.deepEqual(page.meta?.inkGaps, [], '补回的表格空格不能再算作无人覆盖');
    const block = page.blocks.find((item) => item.id === 'ink-p1-g1');
    assert.equal(block?.text, '贰零贰陆年');
    assert.equal(result.quality.signals.inkCoverage, 1);
    assert.equal(
      result.quality.issues.some((issue) => issue.code === 'ink_without_text'),
      false,
      '墨迹已被补回的文本框解释，问题应消失',
    );
    // The reviewer still gets pointed at it: the appended block is flagged.
    assert.equal(
      result.quality.issues.some(
        (issue) => issue.code === 'block_validation' && issue.blockId === 'ink-p1-g1',
      ),
      true,
    );
  });

  test('keeps the ink issue when nothing can be recovered', async () => {
    const stub = stubClient(
      [
        () =>
          extraction({
            text: '季度报告',
            confidence: 0.98,
            document: inkGapDocument(),
          }),
      ],
      [() => ({ text: '  ', confidence: null, engine: 'paddle', model: 'model-a', seconds: 0.1 })],
    );
    const result = await runOcrCascade(
      stub.client,
      'paddle',
      { path: '/tmp/ink.png', name: 'ink.png' },
      { maxStages: 3 },
    );

    const inkStage = result.stages.find((stage) => stage.trigger === 'ink_gap');
    assert.equal(inkStage?.status, 'failed');
    assert.equal(inkStage?.message?.includes('0/2 处未覆盖墨迹补回文本'), true);
    const document = result.extraction.document as DocumentIr;
    assert.equal(document.pages[0]?.meta?.inkGaps?.length, 2);
    assert.equal(document.pages[0]?.blocks.length, 1);
    assert.equal(result.extraction.text, '季度报告');
  });

  test('crops unexplained ink even when the page scores pass', async () => {
    // One region gap lowers coverage without becoming a hard risk, so the only
    // thing that can justify the crop is the pixels themselves.
    const gap: OcrInkGap = {
      id: 'p1-g0',
      kind: 'region',
      blockId: null,
      bbox: { x: 0, y: 200, width: 400, height: 24 },
      pixels: 900,
      density: 0.2,
    };
    const stub = stubClient(
      [
        () =>
          extraction({
            text: '季度报告\n本季度业务保持稳定增长',
            confidence: 0.99,
            document: inkGapDocument([gap]),
          }),
      ],
      [
        () => ({
          text: '漏掉的一整行文字',
          confidence: 0.6,
          engine: 'paddle',
          model: 'model-a',
          seconds: 0.2,
        }),
      ],
    );
    const result = await runOcrCascade(
      stub.client,
      'paddle',
      { path: '/tmp/ink-pass.png', name: 'ink-pass.png' },
      { maxStages: 4 },
    );

    // The page scored pass on its own, yet the unexplained pixels still bought a crop.
    assert.equal(result.stages[0]?.quality?.status, 'pass', '复认前的页面应当已经达标');
    const inkStage = result.stages.find((stage) => stage.trigger === 'ink_gap');
    assert.equal(inkStage?.status, 'done');
    assert.equal(result.extraction.text.includes('漏掉的一整行文字'), true);
    // Recovery text is appended as a flagged block, so the document now asks for a
    // human check on the recovered line instead of silently claiming the page was fine.
    assert.equal(result.quality.status, 'review');
    assert.ok(
      result.quality.issues.some(
        (issue) => issue.code === 'block_validation' && issue.blockId === 'ink-p1-g0',
      ),
      '补回的文本必须带结构校验告警',
    );
    const document = result.extraction.document as DocumentIr;
    assert.deepEqual(document.pages[0]?.meta?.inkGaps, [], '补回后该页应报告已分析且无缺口');
    assert.equal(document.pages[0]?.blocks.length, 2);
  });

  test('confirms a low-confidence key field with region re-recognition', async () => {
    const stub = stubClient(
      [
        () =>
          extraction({
            text: '季度报告\n合计 1,280 元',
            confidence: 0.9,
            document: keyFieldDocument(),
          }),
      ],
      [
        () => ({
          text: '合计 1,280 元',
          confidence: 0.93,
          engine: 'paddle',
          model: 'model-b',
          seconds: 0.4,
        }),
      ],
    );
    const result = await runOcrCascade(stub.client, 'paddle', {
      path: '/tmp/report.png',
      name: 'report.png',
    });

    assert.equal(stub.calls.length, 1);
    assert.equal(stub.regionCalls.length, 1);
    assert.equal(stub.regionCalls[0]?.page, 1);
    assert.deepEqual(
      result.stages.map((stage) => stage.kind),
      ['visual', 'recovery_region'],
    );
    assert.equal(result.stages[1]?.trigger, 'key_field');
    assert.equal(result.stages[1]?.decision?.trigger, 'key_field');
    assert.equal(result.quality.status, 'pass');
    assert.ok(!result.quality.hardRisks.some((risk) => risk.code === 'key_field_low_confidence'));
    assert.equal(result.extraction.text, '季度报告\n合计 1,280 元');

    const document = result.extraction.document as DocumentIr;
    const amount = document.pages[0]?.blocks.find((block) => block.id === 'b2');
    assert.equal(amount?.meta?.regionAgreement, 'confirmed_independent');
    const evidence = document.meta.fieldEvidence as DocumentFieldEvidence[];
    assert.equal(evidence?.length, 1);
    assert.equal(evidence[0]?.selected, 'initial');
    assert.equal(evidence[0]?.agreement, 'confirmed_independent');
    assert.equal(evidence[0]?.passes, 1);
    assert.deepEqual(evidence[0]?.failed, []);
    assert.equal(evidence[0]?.candidates[0]?.pass, 1);
    assert.equal(evidence[0]?.candidates[0]?.mode, 'auto');
    assert.equal(evidence[0]?.candidates[0]?.padding, 0.35);
    assert.equal(evidence[0]?.candidates[0]?.agreesWithInitial, true);
  });

  test('keeps the key-field risk when only the same model agrees', async () => {
    const stub = stubClient(
      [
        () =>
          extraction({
            text: '季度报告\n合计 1,280 元',
            confidence: 0.9,
            document: keyFieldDocument(),
          }),
        () =>
          extraction({
            text: '季度报告\n合计 1,280 元',
            confidence: 0.9,
            document: keyFieldDocument(),
          }),
      ],
      [
        () => ({
          text: '合计 1,280 元',
          confidence: 0.99,
          engine: 'paddle',
          model: 'model-a',
          seconds: 0.4,
        }),
      ],
    );
    const result = await runOcrCascade(stub.client, 'paddle', {
      path: '/tmp/report.png',
      name: 'report.png',
    });

    // A re-read by the recognizer that produced the value only proves the crop
    // is repeatable, so the non-compensating risk stays.
    assert.equal(result.quality.status, 'review');
    assert.ok(result.quality.hardRisks.some((risk) => risk.code === 'key_field_low_confidence'));
    const document = result.extraction.document as DocumentIr;
    const amount = document.pages[0]?.blocks.find((block) => block.id === 'b2');
    assert.equal(amount?.meta?.regionAgreement, 'confirmed_same_engine');
    assert.equal(
      result.quality.issues.some((issue) => issue.code === 'key_field_same_engine_confirmation'),
      true,
    );
  });

  test('runs alternate models for a key field after normal passes disagree', async () => {
    const stub = stubClient(
      [
        () =>
          extraction({
            text: '季度报告\n合计 1,280 元',
            confidence: 0.9,
            document: keyFieldDocument(),
          }),
      ],
      [
        () => ({
          text: '合计 9,999 元',
          confidence: 0.5,
          engine: 'paddle',
          model: 'model-a',
          seconds: 0.3,
        }),
        () => ({
          text: '合计 8,888 元',
          confidence: 0.5,
          engine: 'paddle',
          model: 'model-a',
          seconds: 0.3,
        }),
        () => ({
          text: '合计 1,280 元',
          confidence: 0.93,
          engine: 'paddle',
          model: 'model-alt',
          seconds: 0.4,
        }),
      ],
    );
    const result = await runOcrCascade(
      stub.client,
      'paddle',
      { path: '/tmp/report.png', name: 'report.png' },
      { fallbackModels: ['alt-a', 'alt-b'] },
    );

    assert.deepEqual(
      stub.regionCalls.map((call) => [call.mode, call.model ?? null]),
      [
        ['auto', null],
        ['enhanced', null],
        ['auto', 'alt-a'],
      ],
    );
    const document = result.extraction.document as DocumentIr;
    const amount = document.pages[0]?.blocks.find((block) => block.id === 'b2');
    assert.equal(amount?.meta?.regionAgreement, undefined);
    const evidence = document.meta.fieldEvidence as DocumentFieldEvidence[];
    assert.equal(evidence[0]?.agreement, 'unverified');
    assert.equal(evidence[0]?.candidates[2]?.agreesWithInitial, true);
    assert.equal(evidence[0]?.candidates[2]?.model, 'model-alt');
    assert.equal(evidence[0]?.candidates[2]?.numeric?.valid, true);
    assert.equal(evidence[0]?.candidates[2]?.numeric?.canonical, '1280');
  });

  test('ordinary low-confidence lines never spend alternate models', async () => {
    const stub = stubClient(
      [
        () =>
          extraction({
            text: '普通段落 说明文字',
            confidence: 0.9,
            document: genericLineDocument(),
          }),
      ],
      [
        () => ({
          text: '另一段 说明文字',
          confidence: 0.5,
          engine: 'paddle',
          model: 'model-a',
          seconds: 0.3,
        }),
        () => ({
          text: '又一段 说明文字',
          confidence: 0.5,
          engine: 'paddle',
          model: 'model-a',
          seconds: 0.3,
        }),
      ],
    );
    await runOcrCascade(
      stub.client,
      'paddle',
      { path: '/tmp/report.png', name: 'report.png' },
      { fallbackModels: ['alt-a'] },
    );
    assert.equal(
      stub.regionCalls.some((call) => call.model === 'alt-a'),
      false,
    );
  });

  test('runs a wider second pass and preserves N-best disagreement evidence', async () => {
    const stub = stubClient(
      [
        () =>
          extraction({
            text: '季度报告\n合计 1,280 元',
            confidence: 0.9,
            document: keyFieldDocument(),
          }),
      ],
      [
        () => ({
          text: '合计 9,999 元',
          confidence: 0.95,
          engine: 'paddle',
          model: 'model-a',
          seconds: 0.3,
        }),
        () => ({
          text: '合计 8,888 元',
          confidence: 0.92,
          engine: 'paddle',
          model: 'model-b',
          seconds: 0.3,
        }),
      ],
    );
    const result = await runOcrCascade(
      stub.client,
      'paddle',
      { path: '/tmp/report.png', name: 'report.png', dpi: 200 },
      { maxStages: 2 },
    );

    assert.deepEqual(
      stub.regionCalls.map((call) => [call.mode, call.padding, call.dpi ?? null]),
      [
        ['auto', 0.35, 200],
        ['enhanced', 0.6, 200],
      ],
    );
    const document = result.extraction.document as DocumentIr;
    const amount = document.pages[0]?.blocks.find((block) => block.id === 'b2');
    assert.equal(amount?.meta?.regionAgreement, 'conflict');
    const evidence = document.meta.fieldEvidence as DocumentFieldEvidence[];
    assert.equal(evidence[0]?.agreement, 'conflict');
    assert.equal(evidence[0]?.selected, null);
    assert.equal(evidence[0]?.passes, 2);
    assert.deepEqual(
      evidence[0]?.candidates.map((candidate) => [
        candidate.pass,
        candidate.mode,
        candidate.model,
        candidate.agreesWithInitial,
      ]),
      [
        [1, 'auto', 'model-a', false],
        [2, 'enhanced', 'model-b', false],
      ],
    );
    assert.equal(result.extraction.text, '季度报告\n合计 1,280 元');
  });

  test('keeps low-confidence disagreement unverified and preserves the key-field risk', async () => {
    const stub = stubClient(
      [
        () =>
          extraction({
            text: '季度报告\n合计 1,280 元',
            confidence: 0.9,
            document: keyFieldDocument(),
          }),
      ],
      [
        () => ({
          text: '合计 7,777 元',
          confidence: 0.2,
          engine: 'paddle',
          model: 'model-a',
          seconds: 0.3,
        }),
      ],
    );
    const result = await runOcrCascade(
      stub.client,
      'paddle',
      { path: '/tmp/report.png', name: 'report.png' },
      { maxStages: 2 },
    );

    const document = result.extraction.document as DocumentIr;
    const amount = document.pages[0]?.blocks.find((block) => block.id === 'b2');
    assert.equal(amount?.meta?.regionAgreement, undefined);
    const evidence = document.meta.fieldEvidence as DocumentFieldEvidence[];
    assert.equal(evidence[0]?.agreement, 'unverified');
    assert.equal(evidence[0]?.selected, null);
    assert.ok(result.quality.hardRisks.some((risk) => risk.code === 'key_field_low_confidence'));
  });

  test('keeps conflicting region evidence and the original text', async () => {
    const stub = stubClient(
      [
        () =>
          extraction({
            text: '季度报告\n合计 1,280 元',
            confidence: 0.9,
            document: keyFieldDocument(),
          }),
      ],
      [
        () => ({
          text: '合计 9,999 元',
          confidence: 0.95,
          engine: 'paddle',
          model: 'model-a',
          seconds: 0.3,
        }),
      ],
    );
    const result = await runOcrCascade(
      stub.client,
      'paddle',
      { path: '/tmp/report.png', name: 'report.png' },
      { maxStages: 2 },
    );

    assert.equal(stub.calls.length, 1);
    assert.deepEqual(
      result.stages.map((stage) => stage.kind),
      ['visual', 'recovery_region'],
    );
    assert.equal(result.quality.status, 'review');
    assert.equal(result.extraction.text, '季度报告\n合计 1,280 元');

    const document = result.extraction.document as DocumentIr;
    const amount = document.pages[0]?.blocks.find((block) => block.id === 'b2');
    assert.equal(amount?.meta?.regionAgreement, 'conflict');
    const evidence = document.meta.fieldEvidence as { selected: string | null }[];
    assert.equal(evidence?.[0]?.selected, null);
  });

  test('respects the stage and time budgets', async () => {
    const stageLimited = stubClient([() => extraction({ confidence: 0.3 })]);
    await runOcrCascade(
      stageLimited.client,
      'paddle',
      { path: '/tmp/scan.png', name: 'scan.png' },
      { maxStages: 1 },
    );
    assert.equal(stageLimited.calls.length, 1);

    const timeLimited = stubClient([() => extraction({ confidence: 0.3 })]);
    await runOcrCascade(
      timeLimited.client,
      'paddle',
      { path: '/tmp/scan.png', name: 'scan.png' },
      { budgetMs: 0 },
    );
    assert.equal(timeLimited.calls.length, 1);
  });

  test('records replay metadata and reproduces a stage', async () => {
    const stub = stubClient([
      () => extraction({ text: '原始文本', confidence: 0.3 }),
      () => extraction({ text: '增强文本', confidence: 0.96 }),
    ]);
    const result = await runOcrCascade(stub.client, 'paddle', {
      path: '/tmp/scan.png',
      name: 'scan.png',
    });

    const initial = result.stages[0];
    assert.equal(initial?.kind, 'visual');
    assert.deepEqual(initial?.params, {
      mode: 'auto',
      dpi: null,
      page: null,
      bbox: null,
      padding: null,
    });
    assert.match(initial?.outputSha256 ?? '', /^[a-f0-9]{64}$/);
    assert.equal(initial?.inputSha256, null);
    assert.ok(initial?.quality?.issues.includes('low_confidence'));
    assert.equal(initial?.quality?.score, initial?.score);
    assert.equal(findReplayStage(result.stages, { kind: 'recovery_enhance' }), result.stages[1]);
    assert.equal(findReplayStage(result.stages, { kind: 'vlm' }), null);

    const replayStub = stubClient([() => extraction({ text: '原始文本', confidence: 0.3 })]);
    const replay = await replayOcrStage(
      replayStub.client,
      'paddle',
      { path: '/tmp/scan.png', name: 'scan.png' },
      result.stages,
      { kind: 'visual' },
    );
    assert.equal(replayStub.calls[0]?.mode, 'auto');
    assert.equal(replay.outputMatches, true);
    assert.equal(replay.scoreDelta, 0);
    assert.equal(replay.inputMatches, null);
    assert.equal(replay.extraction?.text, '原始文本');

    const changed = stubClient([() => extraction({ text: '变化文本', confidence: 0.3 })]);
    const replayChanged = await replayOcrStage(
      changed.client,
      'paddle',
      { path: '/tmp/scan.png', name: 'scan.png' },
      result.stages,
      { kind: 'visual' },
    );
    assert.equal(replayChanged.outputMatches, false);

    await assert.rejects(
      replayOcrStage(
        changed.client,
        'paddle',
        { path: '/tmp/scan.png', name: 'scan.png' },
        result.stages,
        {
          kind: 'vlm',
        },
      ),
      /找不到可重放的阶段/,
    );
  });

  test('replays a single region from a recorded stage', async () => {
    const stub = stubClient([() => extraction({ text: '弱文本', confidence: 0.3 })]);
    const result = await runOcrCascade(
      stub.client,
      'paddle',
      { path: '/tmp/scan.png', name: 'scan.png', dpi: 250 },
      { maxStages: 1 },
    );

    const replayStub = stubClient(
      [],
      [
        () => ({
          text: '合计 1,280 元',
          confidence: 0.9,
          engine: 'paddle',
          model: 'model-a',
          seconds: 0.2,
        }),
      ],
    );
    const bbox = { x: 10, y: 40, width: 200, height: 30 };
    const replay = await replayOcrStage(
      replayStub.client,
      'paddle',
      { path: '/tmp/scan.png', name: 'scan.png' },
      result.stages,
      { kind: 'visual', page: 1, bbox, padding: 0.4 },
    );

    assert.equal(replayStub.regionCalls.length, 1);
    assert.deepEqual(
      [
        replayStub.regionCalls[0]?.page,
        replayStub.regionCalls[0]?.bbox,
        replayStub.regionCalls[0]?.padding,
        replayStub.regionCalls[0]?.mode,
        replayStub.regionCalls[0]?.dpi,
      ],
      [1, bbox, 0.4, 'auto', 250],
    );
    assert.equal(replay.candidate?.text, '合计 1,280 元');
    assert.equal(replay.outputMatches, null);
    assert.equal(replay.scoreAfter, null);
    assert.equal(replay.extraction, null);
  });

  test('records specialized chart and stamp findings without rewriting text', async () => {
    const document: DocumentIr = {
      version: 1,
      route: 'visual',
      pages: [
        {
          number: 1,
          width: 1000,
          height: 1400,
          blocks: [
            {
              id: 'p1',
              type: 'paragraph',
              text: '季度报告',
              bbox: { x: 10, y: 10, width: 300, height: 30 },
              confidence: 0.96,
              source: { engine: 'paddle', model: 'model-a', stage: 'visual' },
              validation: null,
              order: 0,
            },
            {
              id: 'c1',
              type: 'chart',
              text: '图表',
              bbox: { x: 20, y: 100, width: 400, height: 300 },
              confidence: 0.7,
              source: { engine: 'paddle', model: 'model-a', stage: 'visual' },
              validation: null,
              order: 1,
            },
            {
              id: 's1',
              type: 'stamp',
              text: '',
              bbox: { x: 700, y: 1100, width: 180, height: 180 },
              confidence: null,
              source: { engine: 'paddle', model: 'model-a', stage: 'visual' },
              validation: null,
              order: 2,
            },
          ],
          source: null,
        },
      ],
      readingOrder: ['p1', 'c1', 's1'],
      meta: {},
    };
    const stub = stubClient(
      [() => extraction({ text: '季度报告', confidence: 0.96, document })],
      [],
      {
        specialized: (input) => ({
          text: input.type === 'stamp' ? '合同专用章' : '季度收入趋势',
          confidence: 0.82,
          engine: 'specialized',
          model: 'special-v1',
          seconds: 0.4,
        }),
      },
    );
    const result = await runOcrCascade(stub.client, 'paddle', {
      path: '/tmp/report.png',
      name: 'report.png',
    });

    assert.deepEqual(
      stub.specialCalls.map((call) => [call.page, call.type, call.bbox]),
      [
        [1, 'chart', { x: 20, y: 100, width: 400, height: 300 }],
        [1, 'stamp', { x: 700, y: 1100, width: 180, height: 180 }],
      ],
    );
    const specialStage = result.stages.find((stage) => stage.kind === 'specialized');
    assert.equal(specialStage?.status, 'done');
    assert.equal(specialStage?.model, 'special-v1');
    assert.equal(specialStage?.params?.specializedType, 'chart');
    assert.equal(specialStage?.params?.page, 1);
    const findings = (result.extraction.document as DocumentIr).meta
      .specialized as DocumentSpecializedFinding[];
    assert.deepEqual(
      findings.map((finding) => [finding.type, finding.blockId, finding.text]),
      [
        ['chart', 'c1', '季度收入趋势'],
        ['stamp', 's1', '合同专用章'],
      ],
    );
    const chart = document.pages[0]?.blocks.find((block) => block.id === 'c1');
    assert.equal(chart?.text, '图表');
  });

  test('keeps specialized findings when a later rerun becomes the best extraction', async () => {
    const firstDocument: DocumentIr = {
      version: 1,
      route: 'visual',
      pages: [
        {
          number: 1,
          width: 1000,
          height: 1400,
          blocks: [
            {
              id: 'c1',
              type: 'chart',
              text: '图表',
              bbox: { x: 20, y: 100, width: 400, height: 300 },
              confidence: 0.3,
              source: { engine: 'paddle', model: 'model-a', stage: 'visual' },
              validation: null,
              order: 0,
            },
          ],
          source: null,
        },
      ],
      readingOrder: ['c1'],
      meta: {},
    };
    const cleanDocument: DocumentIr = {
      version: 1,
      route: 'visual',
      pages: [
        {
          number: 1,
          width: 1000,
          height: 1400,
          blocks: [
            {
              id: 'p1',
              type: 'paragraph',
              text: '季度报告',
              bbox: { x: 10, y: 10, width: 300, height: 30 },
              confidence: 0.96,
              source: { engine: 'paddle', model: 'model-a', stage: 'visual' },
              validation: null,
              order: 0,
            },
          ],
          source: null,
        },
      ],
      readingOrder: ['p1'],
      meta: {},
    };
    const stub = stubClient(
      [
        () => extraction({ text: '季度报告', confidence: 0.3, document: firstDocument }),
        () => extraction({ text: '季度报告', confidence: 0.96, document: cleanDocument }),
      ],
      [],
      {
        specialized: () => ({
          text: '季度收入趋势',
          confidence: 0.8,
          engine: 'specialized',
          model: 'special-v1',
          seconds: 0.2,
        }),
      },
    );
    const result = await runOcrCascade(stub.client, 'paddle', {
      path: '/tmp/report.png',
      name: 'report.png',
    });
    assert.ok(stub.calls.length >= 2);
    assert.equal(Array.isArray(result.extraction.document?.meta.specialized), true);
    const findings = result.extraction.document?.meta.specialized as DocumentSpecializedFinding[];
    assert.equal(findings[0]?.text, '季度收入趋势');
  });

  test('uses VLM only as extra evidence on unconfirmed problem regions', async () => {
    const stub = stubClient(
      [
        () =>
          extraction({
            text: '季度报告\n合计 1,280 元',
            confidence: 0.9,
            document: keyFieldDocument(),
          }),
      ],
      [
        () => ({
          text: '合计 7,777 元',
          confidence: 0.2,
          engine: 'paddle',
          model: 'model-a',
          seconds: 0.3,
        }),
      ],
      {
        vlm: () => ({
          text: '合计 1,280 元',
          confidence: 0.9,
          engine: 'vlm',
          model: 'vlm-v1',
          seconds: 1.2,
        }),
      },
    );
    const result = await runOcrCascade(stub.client, 'paddle', {
      path: '/tmp/report.png',
      name: 'report.png',
    });

    assert.equal(stub.vlmCalls.length, 1);
    assert.equal(stub.vlmCalls[0]?.kind, 'amount');
    assert.equal(stub.vlmCalls[0]?.context, '合计 1,280 元');
    const stage = result.stages.find((entry) => entry.kind === 'vlm');
    assert.equal(stage?.status, 'done');
    assert.equal(stage?.trigger, 'key_field');
    assert.equal(stage?.params?.page, 1);
    assert.equal(stage?.model, 'vlm-v1');
    const document = result.extraction.document as DocumentIr;
    const evidence = document.meta.fieldEvidence as DocumentFieldEvidence[];
    assert.deepEqual(
      evidence[0]?.candidates.map((candidate) => candidate.source),
      ['region', 'region', 'vlm'],
    );
    assert.equal(evidence[0]?.agreement, 'unverified');
    assert.equal(evidence[0]?.selected, null);
    assert.equal(result.extraction.text, '季度报告\n合计 1,280 元');
  });

  test('replays VLM and specialized stages through their own adapters', async () => {
    const bbox = { x: 700, y: 1100, width: 180, height: 180 };
    const stages: OcrStage[] = [
      {
        kind: 'vlm',
        status: 'done',
        mode: 'auto',
        engine: 'paddle',
        model: 'vlm-v1',
        dpi: null,
        seconds: 1,
        score: 0.7,
        message: null,
        params: { mode: 'auto', dpi: null, page: 1, bbox, padding: 0.35 },
      },
      {
        kind: 'specialized',
        status: 'done',
        mode: 'auto',
        engine: 'paddle',
        model: 'special-v1',
        dpi: null,
        seconds: 1,
        score: 0.7,
        message: null,
        params: {
          mode: 'auto',
          dpi: null,
          page: 1,
          bbox,
          padding: null,
          specializedType: 'stamp',
        },
      },
    ];
    const stub = stubClient([], [], {
      vlm: () => ({
        text: '合计 1,280 元',
        confidence: 0.9,
        engine: 'vlm',
        model: 'vlm-v1',
        seconds: 1,
      }),
      specialized: () => ({
        text: '合同专用章',
        confidence: 0.85,
        engine: 'specialized',
        model: 'special-v1',
        seconds: 0.5,
      }),
    });
    const input = { path: '/tmp/report.png', name: 'report.png' };
    const vlm = await replayOcrStage(stub.client, 'paddle', input, stages, { kind: 'vlm' });
    assert.equal(stub.vlmCalls[0]?.bbox, bbox);
    assert.equal(vlm.candidate?.text, '合计 1,280 元');
    const special = await replayOcrStage(stub.client, 'paddle', input, stages, {
      kind: 'specialized',
    });
    assert.equal(stub.specialCalls[0]?.type, 'stamp');
    assert.equal(special.candidate?.text, '合同专用章');
  });
});

function yieldStage(
  kind: OcrStageKind,
  score: number | null,
  status: OcrStage['status'] = 'done',
): OcrStage {
  return {
    kind,
    status,
    mode: 'auto',
    engine: 'paddle',
    model: null,
    dpi: null,
    seconds: 1,
    score,
    message: null,
  };
}

describe('recovery yield statistics', () => {
  test('keeps the prior until enough samples accumulate', () => {
    const minSamples = recoveryYieldMinSamples();
    const prior = recoveryPrior('recovery_dpi');
    assert.equal(smoothedRecoveryYield('recovery_dpi', undefined, minSamples), prior);
    assert.equal(
      smoothedRecoveryYield('recovery_dpi', { attempts: minSamples - 1, successes: 9 }, minSamples),
      prior,
    );
    assert.ok(
      smoothedRecoveryYield('recovery_region', { attempts: 20, successes: 20 }, 5) >
        recoveryPrior('recovery_region'),
    );
    assert.ok(
      smoothedRecoveryYield('recovery_region', { attempts: 20, successes: 0 }, 5) <
        recoveryPrior('recovery_region'),
    );
    assert.ok(smoothedRecoveryYield('recovery_region', { attempts: 20, successes: 999 }, 5) <= 1);
  });

  test('counts only recovery stages and only score improvements', () => {
    const outcomes = recoveryYieldOutcomes([
      yieldStage('visual', 0.5),
      yieldStage('recovery_enhance', 0.7),
      yieldStage('recovery_dpi', 0.69),
      yieldStage('recovery_structure', 0.71),
      yieldStage('specialized', 0.99),
    ]);
    assert.deepEqual(outcomes, [
      { kind: 'recovery_enhance', attempts: 1, successes: 1 },
      { kind: 'recovery_dpi', attempts: 1, successes: 0 },
      { kind: 'recovery_structure', attempts: 1, successes: 1 },
    ]);
  });

  test('persists cumulative outcomes and exposes smoothed probabilities', () => {
    const store = new OcrYieldStore(new Database(':memory:'));
    assert.deepEqual(store.load(), {});
    store.record([{ kind: 'recovery_dpi', attempts: 2, successes: 1 }]);
    store.record([{ kind: 'recovery_dpi', attempts: 2, successes: 2 }], '2026-10-31T00:00:00.000Z');
    assert.deepEqual(store.load().recovery_dpi, { attempts: 4, successes: 3 });
    let listed = store.list().find((item) => item.stage === 'recovery_dpi');
    assert.ok(listed);
    assert.equal(listed.probability, recoveryPrior('recovery_dpi'));
    assert.equal(listed.updatedAt, '2026-10-31T00:00:00.000Z');

    store.record([{ kind: 'recovery_dpi', attempts: 2, successes: 2 }]);
    listed = store.list().find((item) => item.stage === 'recovery_dpi');
    assert.ok(listed);
    assert.equal(listed.attempts, 6);
    assert.ok(listed.probability > recoveryPrior('recovery_dpi'));
  });
});
