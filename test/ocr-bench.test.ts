import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { DocumentBlock, DocumentIr, OcrBenchFileResult } from '../shared/types.ts';
import { OcrClient } from '../src/ocr.ts';
import {
  aggregateBenchResults,
  benchmarkBusinessLoss,
  benchmarkCer,
  benchmarkNumericCer,
  benchmarkRawCer,
  benchmarkSymbolCer,
  benchmarkTableMetrics,
  benchmarkWer,
  calibrateConfidence,
  classifyErrors,
  fieldAccuracy,
  fieldCategoryOf,
  fieldExactAccuracy,
  fieldOutcomes,
  fieldStrongAccuracy,
  keywordRecall,
  levenshtein,
  normalizeBenchText,
  OcrBench,
  splitOf,
  templateKeyOf,
  wilsonInterval,
} from '../src/ocr-bench.ts';
import { requiredSamples } from '../src/stats.ts';
import { Store } from '../src/store.ts';

async function fakeSidecar(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/health') {
        res.end(JSON.stringify({ ok: true, model: 'PP-OCRv6-medium' }));
        return;
      }
      const body = raw ? (JSON.parse(raw) as { name: string }) : { name: '' };
      if (body.name === 'broken.png') {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'bad file' }));
        return;
      }
      res.end(
        JSON.stringify({
          text: '季度营收 18.5%',
          engine: 'PP-OCRv6-medium',
          model: 'PP-OCRv6-medium',
          confidence: 0.9,
          pages: 1,
        }),
      );
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待基准测试超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function benchFixture(t: { after: (fn: () => void) => void }, files: Record<string, string>) {
  const corpus = mkdtempSync(join(tmpdir(), 'clay-bench-corpus-'));
  const uploads = mkdtempSync(join(tmpdir(), 'clay-bench-uploads-'));
  const store = new Store(':memory:', { demo: true, demoAccounts: true, uploadDir: uploads });
  t.after(() => {
    store.close();
    rmSync(corpus, { recursive: true, force: true });
    rmSync(uploads, { recursive: true, force: true });
  });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(corpus, name), content);
  }
  return { corpus, store };
}

describe('OCR benchmark metrics', () => {
  test('normalizes case, punctuation and whitespace', () => {
    assert.equal(normalizeBenchText(' Hello, World! 1,280 '), 'helloworld1280');
    assert.equal(normalizeBenchText('增长率 18.5%'), '增长率185%');
  });

  test('computes CER against normalized ground truth', () => {
    assert.equal(benchmarkCer('Hello, World!', 'hello world'), 0);
    assert.ok(Math.abs(benchmarkCer('abcd', 'abxd') - 0.25) < 1e-9);
    assert.equal(benchmarkCer('', 'anything'), 0);
    assert.equal(benchmarkCer('中文', ''), 1);
  });

  test('raw CER keeps case, punctuation and word boundaries', () => {
    assert.equal(benchmarkRawCer('新增客户 42 家', '新增客户 42 家'), 0);
    assert.equal(benchmarkRawCer('新增客户 42 家', '新增客户\n42 家'), 0);
    assert.equal(benchmarkRawCer('季度营收报告 本季度', '季度营收报告\n本季度'), 0);
    assert.equal(benchmarkCer('新增客户 42 家', '新增客户42家'), 0);
    assert.ok(benchmarkRawCer('新增客户 42 家', '新增客户42家') > 0);
    assert.ok(benchmarkRawCer('Hello world', 'hello world') > 0);
    assert.equal(benchmarkRawCer('\r\n季度营收\r\n', '季度营收'), 0);
  });

  test('levenshtein handles empty inputs', () => {
    assert.equal(levenshtein('', ''), 0);
    assert.equal(levenshtein('abc', ''), 3);
    assert.equal(levenshtein('', 'abc'), 3);
    assert.equal(levenshtein('kitten', 'sitting'), 3);
  });

  test('counts normalized keyword hits', () => {
    assert.deepEqual(keywordRecall(['季度营收', 'P95', '缺失'], '季度营收报告 P95 40ms'), {
      hit: 2,
      total: 3,
    });
    assert.deepEqual(keywordRecall([], 'x'), { hit: 0, total: 0 });
  });

  test('compares only numeric tokens for numeric CER', () => {
    assert.equal(benchmarkNumericCer('Total: 1,280 CNY', '合计 1280 元'), 0);
    const wrong = benchmarkNumericCer('Unit price 1,280.50', 'Unit price 1,280.60');
    assert.ok(wrong !== null && Math.abs(wrong - 1 / 7) < 1e-9);
    const list = benchmarkNumericCer('编号 1,2,3', '编号 123');
    assert.ok(list !== null && Math.abs(list - 2 / 5) < 1e-9);
    assert.equal(benchmarkNumericCer('没有数字', '仍然没有'), null);
  });

  test('critical symbol CER catches lost separators, signs and brackets', () => {
    assert.equal(benchmarkSymbolCer('¥1,280.50', '¥1,280.50'), 0);
    assert.ok(Math.abs((benchmarkSymbolCer('¥1,200.00', '¥1200.00') ?? 0) - 1 / 3) < 1e-9);
    assert.ok(Math.abs((benchmarkSymbolCer('(1,200.00)', '1,200.00') ?? 0) - 0.5) < 1e-9);
    assert.ok(Math.abs((benchmarkSymbolCer('-1,200.00', '1,200.00') ?? 0) - 1 / 3) < 1e-9);
    // Digit-only mistakes stay in numeric CER, not here.
    assert.equal(benchmarkSymbolCer('1,280.50', '1,280.60'), 0);
    assert.equal(benchmarkSymbolCer('没有数字', '仍然没有'), null);
  });

  test('scores structured fields by exact normalized match', () => {
    assert.deepEqual(
      fieldAccuracy({ total: '1,280', status: 'Paid' }, 'Total 1280 CNY, Status: Paid.'),
      { hit: 2, total: 2, rate: 1 },
    );
    assert.deepEqual(fieldAccuracy({ total: '1,280', status: 'Paid' }, 'Total 1280'), {
      hit: 1,
      total: 2,
      rate: 0.5,
    });
    assert.equal(fieldAccuracy(undefined, 'anything'), null);
    assert.equal(fieldAccuracy({}, 'anything'), null);
  });

  test('keeps formatting in exact field matching', () => {
    assert.deepEqual(fieldExactAccuracy({ total: '1,280' }, 'Total 1,280 CNY'), {
      hit: 1,
      total: 1,
      rate: 1,
    });
    assert.deepEqual(fieldExactAccuracy({ total: '1,280' }, 'Total 1280'), {
      hit: 0,
      total: 1,
      rate: 0,
    });
    assert.equal(fieldExactAccuracy(undefined, 'anything'), null);
  });

  test('localizes field hits so a value in the wrong role does not count', () => {
    const fields = { total: '1,280' };
    const truth = '季度报告\n合计 1,280 元';

    // The number was read, but only as a different subtotal label.
    const wrongRole = strongDocument([['小计 1,280 元']]);
    assert.deepEqual(fieldAccuracy(fields, '小计 1,280 元'), { hit: 1, total: 1, rate: 1 });
    assert.deepEqual(fieldStrongAccuracy(fields, '小计 1,280 元', truth, wrongRole), {
      hit: 0,
      total: 1,
      rate: 0,
      unverifiable: 0,
    });

    // In the labeled block it counts, and an explicit label hint is honored.
    const rightRole = strongDocument([['合计 1,280 元']]);
    assert.deepEqual(fieldStrongAccuracy(fields, '合计 1,280 元', truth, rightRole), {
      hit: 1,
      total: 1,
      rate: 1,
      unverifiable: 0,
    });
    assert.deepEqual(
      fieldStrongAccuracy(fields, '小计 1,280 元', truth, wrongRole, {
        total: { label: '小计' },
      }),
      { hit: 1, total: 1, rate: 1, unverifiable: 0 },
    );

    // A page hint refuses a value that landed on another page.
    const twoPages = strongDocument([['抬头'], ['小计 1,280 元', '合计 1,280 元']]);
    assert.deepEqual(
      fieldStrongAccuracy(fields, '抬头\n小计 1,280 元\n合计 1,280 元', truth, twoPages, {
        total: { page: 1 },
      }),
      { hit: 0, total: 1, rate: 0, unverifiable: 0 },
    );
    assert.deepEqual(
      fieldStrongAccuracy(fields, '抬头\n小计 1,280 元\n合计 1,280 元', truth, twoPages, {
        total: { page: 2 },
      }),
      { hit: 1, total: 1, rate: 1, unverifiable: 0 },
    );

    // Without a document there is nothing to localize on. Reporting containment
    // here would hand the gate a strong-looking number built on no evidence.
    assert.equal(fieldStrongAccuracy(fields, '小计 1,280 元', truth, null), null);
    assert.equal(fieldStrongAccuracy(undefined, 'x', truth, rightRole), null);
    assert.equal(fieldStrongAccuracy({}, 'x', truth, rightRole), null);
  });

  test('does not call a value strong when the corpus cannot locate it', () => {
    const fields = { 备注: '详见附件', 合计: '1,280' };
    const blocks = strongDocument([['小计 1,280 元']]);

    // The truth text never shows the remark, and nothing hints where it lives: the
    // field is unverifiable, not a miss, and it leaves the denominator while the
    // hinted field is still measured.
    const mixed = fieldStrongAccuracy(fields, '详见附件\n小计 1,280 元', undefined, blocks, {
      合计: { label: '小计' },
    });
    assert.deepEqual(mixed, { hit: 1, total: 1, rate: 1, unverifiable: 1 });
    assert.equal(
      fieldStrongAccuracy(fields, '详见附件\n小计 1,280 元', undefined, blocks),
      null,
      '没有一处能定位时，指标应为未测量而不是 0',
    );

    // A one-character label proves nothing either: with no measurable field left,
    // the metric is absent rather than a zero that looks like an engine failure.
    const shortLabel = fieldStrongAccuracy(fields, '详见附件', undefined, blocks, {
      备注: { label: '注' },
    });
    assert.equal(shortLabel, null);

    // With a real label in the block the same field becomes measurable.
    const hinted = strongDocument([['备注 详见附件']]);
    assert.deepEqual(
      fieldStrongAccuracy({ 备注: '详见附件' }, '', undefined, hinted, {
        备注: { label: '备注' },
      }),
      { hit: 1, total: 1, rate: 1, unverifiable: 0 },
    );
  });

  test('computes word error rate for whitespace-tokenized text', () => {
    assert.equal(benchmarkWer('Hello world', 'hello world'), 0);
    const missing = benchmarkWer('one two three', 'one three');
    assert.ok(missing !== null && Math.abs(missing - 1 / 3) < 1e-9);
    assert.equal(benchmarkWer('中文', '中文'), null);
  });

  test('handles mixed CJK/Latin abbreviations, currency and punctuation', () => {
    // Identifiers and abbreviations stay contiguous after normalization.
    assert.equal(normalizeBenchText('Invoice #INV-2026-0042 (CNY)'), 'invoiceinv20260042cny');
    assert.deepEqual(
      fieldAccuracy(
        { invoice: 'INV-2026-0042', total: '128,500.00' },
        '发票号 INV-2026-0042，合计 128,500.00 CNY',
      ),
      { hit: 2, total: 2, rate: 1 },
    );
    // Fullwidth vs halfwidth parentheses are punctuation, not content.
    assert.equal(benchmarkCer('合计（含税）12,800.00元', '合计(含税)12,800.00元'), 0);
    assert.ok(benchmarkRawCer('合计（含税）12,800.00元', '合计(含税)12,800.00元') > 0);
    // A line wrap keeps the CJK/Latin separator; deleting it is an error.
    assert.equal(benchmarkRawCer('客户 Customer 2026', '客户\nCustomer\n2026'), 0);
    assert.ok(benchmarkRawCer('客户 Customer 2026', '客户Customer2026') > 0);
    // Numeric metrics ignore currency/units but compare thousands groups.
    assert.equal(benchmarkNumericCer('Total: ¥1,280.50 CNY', 'Total: ¥1280.50 CNY'), 0);
    assert.ok((benchmarkNumericCer('Total: ¥1,280.50 CNY', 'Total: ¥1,280.60 CNY') ?? 0) > 0);
    // WER tokenizes Latin words and numbers inside mixed text.
    const wer = benchmarkWer('Quarterly Review 2026 Q3', 'Quarterly 2026 Q3');
    assert.ok(wer !== null && Math.abs(wer - 0.25) < 1e-9);
    assert.deepEqual(
      keywordRecall(['上海 Acme', 'P95', '1,280.50'], '上海Acme 延迟 P95 1,280.50ms'),
      { hit: 3, total: 3 },
    );
  });

  test('classifies substitutions, insertions and deletions', () => {
    const substitution = classifyErrors('abcd', 'abxd');
    assert.deepEqual(
      [substitution.substitutions, substitution.insertions, substitution.deletions],
      [1, 0, 0],
    );
    assert.ok(substitution.types.includes('character_substitution'));

    const insertion = classifyErrors('abcd', 'abxcd');
    assert.deepEqual(
      [insertion.substitutions, insertion.insertions, insertion.deletions],
      [0, 1, 0],
    );
    assert.ok(insertion.types.includes('character_insertion'));

    const deletion = classifyErrors('abcd', 'abd');
    assert.deepEqual([deletion.substitutions, deletion.insertions, deletion.deletions], [0, 0, 1]);
    assert.ok(deletion.types.includes('character_deletion'));
  });

  test('computes Wilson intervals and confidence calibration', () => {
    const [low, high] = wilsonInterval(9, 10);
    assert.ok(low < 0.9 && high > 0.9);
    assert.deepEqual(wilsonInterval(0, 0), [0, 0]);

    // A perfect run needs 35 observations before its 95% lower bound reaches 0.9.
    assert.equal(requiredSamples(1, 0.9, 'min'), 35);
    assert.ok(wilsonInterval(35, 35)[0] >= 0.9);
    assert.ok(wilsonInterval(34, 34)[0] < 0.9);
    // 127 observations at a 0.95 rate, and no sample size at or below the bar.
    assert.equal(requiredSamples(0.95, 0.9, 'min'), 127);
    assert.equal(requiredSamples(0.9, 0.9, 'min'), null);
    assert.equal(requiredSamples(0.8, 0.9, 'min'), null);
    assert.equal(requiredSamples(0, 0.05, 'max'), 73);
    assert.equal(requiredSamples(0.1, 0.05, 'max'), null);
    assert.equal(requiredSamples(Number.NaN, 0.9, 'min'), null);

    const calibration = calibrateConfidence([
      { confidence: 0.95, correct: true },
      { confidence: 0.85, correct: true },
      { confidence: 0.55, correct: false },
    ]);
    assert.equal(calibration.samples, 3);
    assert.equal(calibration.bins.length, 10);
    assert.equal(calibration.bins[9]?.count, 1);
    assert.equal(calibration.bins[8]?.count, 1);
    assert.equal(calibration.bins[5]?.count, 1);
    assert.ok((calibration.ece ?? 1) >= 0);
    assert.ok((calibration.brier ?? 1) >= 0);
    assert.deepEqual(calibrateConfidence([]), { samples: 0, ece: null, brier: null, bins: [] });
  });

  test('categorizes benchmark fields for reliability and calibration', () => {
    assert.equal(fieldCategoryOf('合计金额'), 'amount');
    assert.equal(fieldCategoryOf('业务日期'), 'date');
    assert.equal(fieldCategoryOf('银行账号'), 'account');
    assert.equal(fieldCategoryOf('Invoice No'), 'identifier');
    assert.equal(fieldCategoryOf('数量'), 'quantity');
    assert.equal(fieldCategoryOf('税率'), 'percentage');
    assert.equal(fieldCategoryOf('币种'), 'currency');
    assert.equal(fieldCategoryOf('备注'), 'other');

    assert.deepEqual(
      fieldOutcomes({ 合计金额: '1,280', 备注: '未知值', 空字段: '  ' }, '合计 1280 元'),
      [
        { field: '合计金额', category: 'amount', correct: true, localized: false },
        { field: '备注', category: 'other', correct: false, localized: false },
      ],
    );
    assert.deepEqual(fieldOutcomes(undefined, 'x'), []);
  });

  test('aggregates strata, error types and the release gate', () => {
    const clean = benchResult({
      name: 'clean.png',
      lang: 'zh',
      difficulty: 'clean',
      cer: 0,
      fieldAccuracy: { hit: 2, total: 2, rate: 1 },
      fieldStrong: { hit: 2, total: 2, rate: 1, unverifiable: 0 },
      fieldExact: { hit: 2, total: 2, rate: 1 },
      fullyCorrect: true,
      fieldOutcomes: [{ field: '合计金额', category: 'amount', correct: true, localized: true }],
    });
    const degraded = benchResult({
      name: 'blur.png',
      lang: 'en',
      difficulty: 'severe',
      degradations: ['blur'],
      cer: 0.2,
      numericCer: 0.1,
      symbolCer: 0.2,
      fieldAccuracy: { hit: 1, total: 2, rate: 0.5 },
      fieldStrong: { hit: 1, total: 2, rate: 0.5, unverifiable: 0 },
      fieldExact: { hit: 0, total: 2, rate: 0 },
      fullyCorrect: false,
      fieldOutcomes: [
        { field: '合计金额', category: 'amount', correct: false, localized: false },
        { field: '业务日期', category: 'date', correct: true, localized: true },
      ],
      errors: {
        substitutions: 2,
        insertions: 0,
        deletions: 0,
        missingFields: 1,
        types: ['character_substitution', 'missing_field'],
        top: [],
      },
    });
    const failed = benchResult({ name: 'broken.png', status: 'failed', cer: null });

    const aggregate = aggregateBenchResults([clean, degraded, failed]);
    assert.equal(aggregate.files, 3);
    assert.equal(aggregate.evaluated, 2);
    assert.equal(aggregate.failed, 1);
    assert.ok(aggregate.cer !== null && Math.abs(aggregate.cer - 0.1) < 1e-9);
    assert.ok(aggregate.numericCer !== null && Math.abs(aggregate.numericCer - 0.05) < 1e-9);
    assert.ok(aggregate.symbolCer !== null && Math.abs(aggregate.symbolCer - 0.1) < 1e-9);
    assert.equal(aggregate.documents, 2);
    assert.equal(aggregate.pages, 2);
    assert.equal(aggregate.characters, 20);
    assert.equal(aggregate.fieldAccuracy?.rate, 0.75);
    assert.equal(aggregate.fieldAccuracy?.hit, 3);
    assert.equal(aggregate.fieldAccuracy?.total, 4);
    assert.ok((aggregate.fieldAccuracy?.interval[0] ?? 1) < 0.75);
    assert.ok((aggregate.fieldAccuracy?.interval[1] ?? 0) > 0.75);
    assert.equal(aggregate.fieldStrong?.rate, 0.75);
    assert.equal(aggregate.fieldStrong?.total, 4);
    assert.equal(aggregate.fieldExact?.rate, 0.5);
    assert.equal(aggregate.fieldExact?.hit, 2);
    assert.equal(aggregate.fieldExact?.total, 4);
    assert.equal(aggregate.fullyCorrect?.hit, 1);
    assert.equal(aggregate.fullyCorrect?.total, 2);
    assert.equal(aggregate.fullyCorrect?.rate, 0.5);
    assert.deepEqual(aggregate.errors.types, ['character_substitution', 'missing_field']);
    assert.equal(aggregate.errors.top[0]?.type, 'character_substitution');
    assert.ok(aggregate.errors.top[0]?.samples.includes('blur.png'));
    assert.deepEqual(
      aggregate.groups
        .filter((group) => group.dimension === 'language')
        .map((group) => [group.value, group.files]),
      [
        ['en', 1],
        ['zh', 1],
      ],
    );
    assert.equal(
      aggregate.groups.find((group) => group.dimension === 'degradation' && group.value === 'blur')
        ?.fieldAccuracy,
      0.5,
    );
    assert.equal(aggregate.calibration.samples, 2);
    assert.deepEqual(
      aggregate.calibrationGroups.map((group) => [group.dimension, group.value]),
      [
        ['kind', 'image'],
        ['language', 'en'],
        ['language', 'zh'],
      ],
    );
    assert.equal(aggregate.calibrationGroups[0]?.calibration.samples, 2);
    const amount = aggregate.fieldReliability.find((entry) => entry.category === 'amount');
    assert.equal(amount?.samples, 2);
    assert.equal(amount?.hit, 1);
    assert.equal(amount?.accuracy, 0.5);
    assert.ok((amount?.interval?.[0] ?? 1) < 0.5);
    assert.equal(amount?.calibration.samples, 2);
    const date = aggregate.fieldReliability.find((entry) => entry.category === 'date');
    assert.equal(date?.samples, 1);
    assert.equal(date?.hit, 1);
    assert.equal(date?.calibration.samples, 1);
    assert.ok(aggregate.gate);
    assert.equal(aggregate.gate?.checks.length, 20);
    const names = aggregate.gate?.checks.map((check) => check.name) ?? [];
    assert.ok(names.includes('blind_evidence'), names.join(','));
    assert.ok(names.includes('evidence_sufficiency'), names.join(','));
    // An unlabeled corpus cannot claim blind evidence, so the check is skipped
    // rather than failing a legacy run.
    assert.equal(
      aggregate.gate?.checks.find((check) => check.name === 'blind_evidence')?.passed,
      null,
    );
    assert.deepEqual(
      aggregate.splits.map((entry) => entry.files),
      [0, 0, 0],
    );
    assert.ok(names.includes('numeric_cer'), names.join(','));
    assert.ok(names.includes('symbol_cer'), names.join(','));
    assert.ok(names.includes('field_accuracy_lower'), names.join(','));
    assert.ok(names.includes('fully_correct_lower'), names.join(','));
    assert.ok(names.includes('field_accuracy_lower:amount'), names.join(','));
    assert.ok(names.includes('field_accuracy_lower:date'), names.join(','));
    assert.ok(names.includes('pdf_evidence'), names.join(','));
    assert.ok(names.includes('cer:image'), names.join(','));
    assert.ok(names.includes('ece:image'), names.join(','));
    assert.ok(names.includes('worst_group_cer'), names.join(','));
    assert.ok(names.includes('worst_group_field_accuracy'), names.join(','));
    assert.equal(
      aggregate.gate?.checks.find((check) => check.name === 'numeric_cer')?.passed,
      false,
    );
    assert.equal(
      aggregate.gate?.checks.find((check) => check.name === 'symbol_cer')?.passed,
      false,
    );
    assert.equal(
      aggregate.gate?.checks.find((check) => check.name === 'pdf_evidence')?.passed,
      false,
    );
    assert.equal(aggregate.gate?.checks.find((check) => check.name === 'cer:image')?.passed, false);
    // Two amount comparisons cannot certify a high-risk category gate.
    assert.equal(
      aggregate.gate?.checks.find((check) => check.name === 'field_accuracy_lower:amount')?.passed,
      false,
    );
    // The rates in this fixture are measured on a handful of observations, so
    // the run cannot certify a release even where every point estimate passes.
    const sufficiency = aggregate.gate?.checks.find(
      (check) => check.name === 'evidence_sufficiency',
    );
    assert.equal(sufficiency?.passed, false);
    assert.match(sufficiency?.note ?? '', /需/);
    const strong = aggregate.gate?.checks.find((check) => check.name === 'field_accuracy_strong');
    assert.equal(strong?.samples, 4);
    // A rate already below its threshold cannot be rescued by more samples.
    assert.equal(strong?.requiredSamples, null);
    const calibration = aggregate.gate?.checks.find((check) => check.name === 'ece:image');
    assert.equal(calibration?.samples, 2);
    assert.equal(calibration?.requiredSamples, 20);
  });

  test('reports thin gate evidence and accepts an explicit override', () => {
    const results = [
      benchResult({
        name: 'one.png',
        cer: 0,
        fieldAccuracy: { hit: 4, total: 4, rate: 1 },
        fullyCorrect: true,
      }),
    ];
    const powered = aggregateBenchResults(results);
    const sufficiency = powered.gate?.checks.find((check) => check.name === 'evidence_sufficiency');
    assert.equal(sufficiency?.passed, false);

    process.env.OCR_GATE_ALLOW_THIN_EVIDENCE = '1';
    try {
      const relaxed = aggregateBenchResults(results);
      assert.equal(
        relaxed.gate?.checks.some((check) => check.name === 'evidence_sufficiency'),
        false,
      );
    } finally {
      delete process.env.OCR_GATE_ALLOW_THIN_EVIDENCE;
    }
  });

  test('judges the release gate on the blind split and reports split sizes', () => {
    const good = (name: string, split: OcrBenchFileResult['split'], kind = 'image') =>
      benchResult({
        name,
        kind,
        split,
        cer: 0,
        fieldAccuracy: { hit: 4, total: 4, rate: 1 },
        fullyCorrect: true,
      });
    const bad = benchResult({
      name: 'blind-bad.png',
      kind: 'image',
      split: 'blind',
      cer: 0.4,
      fieldAccuracy: { hit: 0, total: 4, rate: 0 },
      fullyCorrect: false,
    });
    const aggregate = aggregateBenchResults([
      good('dev-a.png', 'dev'),
      good('dev-b.png', 'dev'),
      good('dev-c.png', 'dev'),
      good('dev-d.png', 'dev'),
      good('cal-a.png', 'calibration'),
      good('cal-b.png', 'calibration'),
      good('blind-a.png', 'blind'),
      good('blind-b.png', 'blind'),
      bad,
    ]);
    const counts = Object.fromEntries(aggregate.splits.map((entry) => [entry.split, entry.files]));
    assert.deepEqual(counts, { dev: 4, calibration: 2, blind: 3 });
    assert.equal(aggregate.splits.find((entry) => entry.split === 'blind')?.gateSplit, true);
    assert.equal(aggregate.splits.find((entry) => entry.split === 'dev')?.gateSplit, false);
    // The overall CER is diluted by the clean dev/calibration work and stays
    // under the limit; the blind split alone shows the regression.
    assert.equal(aggregate.cer, 0.0444);
    assert.equal(aggregate.splits.find((entry) => entry.split === 'blind')?.cer, 0.1333);
    const cerCheck = aggregate.gate?.checks.find((check) => check.name === 'cer');
    assert.equal(cerCheck?.value, 0.1333);
    assert.equal(cerCheck?.passed, false);
    assert.equal(
      aggregate.gate?.checks.find((check) => check.name === 'blind_evidence')?.passed,
      true,
    );
    assert.equal(aggregate.gate?.passed, false);

    const thin = aggregateBenchResults([good('dev-a.png', 'dev'), good('blind-a.png', 'blind')]);
    assert.equal(thin.gate?.checks.find((check) => check.name === 'blind_evidence')?.passed, false);
    assert.equal(thin.gate?.passed, false);

    const devOnly = aggregateBenchResults([good('dev-a.png', 'dev'), good('dev-b.png', 'dev')]);
    const fallback = devOnly.gate?.checks.find((check) => check.name === 'blind_evidence');
    assert.equal(fallback?.passed, false);
    assert.match(fallback?.note ?? '', /退位/);
  });

  test('keeps one template family in one split and pins explicit labels', () => {
    const first = splitOf('wide_inventory_clean.png', { kind: 'table' });
    const variant = splitOf('wide_inventory_skew.png', { kind: 'table' });
    assert.equal(variant, first);
    assert.equal(
      templateKeyOf('wide_inventory_skew.png', { kind: 'table' }),
      'table:wide_inventory',
    );
    assert.equal(splitOf('anything.png', { split: 'blind' }), 'blind');
    assert.equal(
      splitOf('anything.png', { split: 'nope' }, 'known:family'),
      splitOf('x', undefined, 'known:family'),
    );
  });

  test('release gate requires PDF evidence unless explicitly disabled', () => {
    const imageOnly = aggregateBenchResults([benchResult({ name: 'scan.png' })]);
    assert.equal(
      imageOnly.gate?.checks.find((check) => check.name === 'pdf_evidence')?.passed,
      false,
    );
    const withPdf = aggregateBenchResults([
      benchResult({ name: 'scan.pdf', kind: 'pdf', route: 'native' }),
    ]);
    assert.equal(withPdf.gate?.checks.find((check) => check.name === 'pdf_evidence')?.passed, true);
  });

  test('release gate catches a regressed worst group hidden by the overall average', () => {
    const results = [
      ...Array.from({ length: 30 }, (_, index) =>
        benchResult({
          name: `clean-${index}.png`,
          lang: 'zh',
          cer: 0,
          fieldAccuracy: { hit: 2, total: 2, rate: 1 },
          fullyCorrect: true,
        }),
      ),
      ...Array.from({ length: 3 }, (_, index) =>
        benchResult({
          name: `ja-${index}.png`,
          lang: 'ja',
          difficulty: 'severe',
          degradations: ['low_resolution'],
          cer: 0.3,
          numericCer: 0.1,
          fieldAccuracy: { hit: 1, total: 2, rate: 0.5 },
          fullyCorrect: false,
        }),
      ),
    ];
    const aggregate = aggregateBenchResults(results);
    assert.ok(aggregate.cer !== null && aggregate.cer < 0.05);
    const gate = aggregate.gate;
    assert.ok(gate);
    assert.equal(gate.passed, false);
    const worstCer = gate.checks.find((check) => check.name === 'worst_group_cer');
    assert.equal(worstCer?.value, 0.3);
    assert.equal(worstCer?.passed, false);
    assert.deepEqual(worstCer?.group, { dimension: 'language', value: 'ja' });
    const worstField = gate.checks.find((check) => check.name === 'worst_group_field_accuracy');
    assert.equal(worstField?.value, 0.5);
    assert.equal(worstField?.passed, false);
    assert.deepEqual(worstField?.group, { dimension: 'language', value: 'ja' });
  });

  test('worst-group field gate ignores buckets with too few field comparisons', () => {
    const results = [
      ...Array.from({ length: 30 }, (_, index) =>
        benchResult({
          name: `clean-${index}.png`,
          lang: 'zh',
          cer: 0,
          fieldAccuracy: { hit: 2, total: 2, rate: 1 },
          fullyCorrect: true,
        }),
      ),
      benchResult({
        name: 'ja-0.png',
        lang: 'ja',
        cer: 0.01,
        fieldAccuracy: { hit: 0, total: 1, rate: 0 },
        fullyCorrect: false,
      }),
      benchResult({ name: 'ja-1.png', lang: 'ja', cer: 0.01 }),
      benchResult({ name: 'ja-2.png', lang: 'ja', cer: 0.01 }),
    ];
    const aggregate = aggregateBenchResults(results);
    const worstField = aggregate.gate?.checks.find(
      (check) => check.name === 'worst_group_field_accuracy',
    );
    assert.equal(worstField?.group?.value, 'image');
    assert.ok((worstField?.value ?? 0) > 0.98);
    assert.equal(worstField?.passed, true);
  });
});

/** One-page-per-array DIR with paragraph blocks, for localized field matching. */
function strongDocument(pages: string[][]): DocumentIr {
  return {
    version: 1,
    route: 'visual',
    readingOrder: [],
    meta: {},
    pages: pages.map((blocks, pageIndex) => ({
      number: pageIndex + 1,
      width: 1000,
      height: 1000,
      blocks: blocks.map((text, order) => ({
        id: `p${pageIndex + 1}b${order + 1}`,
        type: 'paragraph' as const,
        text,
        bbox: { x: 0, y: order * 40, width: 400, height: 30 },
        confidence: 0.9,
        source: { engine: 'paddle', model: 'model-a', stage: 'visual' as const },
        validation: null,
        order,
      })),
      source: { engine: 'paddle', model: 'model-a', stage: 'visual' as const },
    })),
  };
}

function benchResult(overrides: Partial<OcrBenchFileResult> = {}): OcrBenchFileResult {
  const result: OcrBenchFileResult = {
    name: 'a.png',
    engine: 'paddle',
    kind: 'image',
    lang: 'zh',
    difficulty: 'clean',
    degradations: [],
    provenance: null,
    uncertain: [],
    sha256: null,
    hashVerified: null,
    status: 'done',
    model: null,
    route: 'visual',
    qualityScore: 0.9,
    qualityStatus: 'pass',
    reviewRequired: false,
    stages: [],
    seconds: 1,
    characters: 10,
    confidence: 0.9,
    pages: 1,
    truncated: false,
    cer: 0,
    rawCer: 0,
    numericCer: 0,
    symbolCer: 0,
    wer: null,
    keywordRecall: null,
    fieldAccuracy: null,
    fieldStrong: null,
    fieldExact: null,
    fullyCorrect: true,
    errors: null,
    businessLoss: null,
    tableMetrics: null,
    fieldOutcomes: [],
    confusions: null,
    diagnosis: null,
    routing: null,
    modelSha256: null,
    runtime: null,
    error: null,
    ...overrides,
  };
  // No stand-in for the localized metric: a test that wants it measured has to say
  // so, otherwise the gate would silently be judged on containment in every test.
  return result;
}

describe('OCR benchmark corpus', () => {
  test('lists supported files with their engine and kind', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clay-bench-'));
    const store = new Store(':memory:', { demo: true, demoAccounts: true });
    t.after(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
    writeFileSync(
      join(dir, 'ground_truth.json'),
      JSON.stringify({ 'scan.png': { kind: 'image', keywords: ['x'] } }),
    );
    writeFileSync(join(dir, 'scan.png'), 'x');
    writeFileSync(join(dir, 'doc.docx'), 'x');
    writeFileSync(join(dir, 'notes.txt'), 'x');

    const bench = new OcrBench(store, new OcrClient({ paddleUrl: 'http://127.0.0.1:9' }), dir);
    const status = await bench.status();
    assert.equal(status.available, true);
    assert.equal(status.run, null);
    assert.deepEqual(status.history, []);
    assert.deepEqual(
      status.files.map((file) => [file.name, file.engine, file.kind]),
      [
        ['doc.docx', 'docling', 'docx'],
        ['scan.png', 'paddle', 'image'],
      ],
    );
  });

  test('keeps mixed CJK/Latin corpus entries with language and business fields', async () => {
    const raw = await readFile(
      new URL('../benchmarks/ocr/ground_truth.json', import.meta.url),
      'utf8',
    );
    const corpus = JSON.parse(raw) as Record<
      string,
      { lang?: string; text?: string; fields?: Record<string, string> }
    >;
    for (const name of ['mixed.png', 'digital.pdf']) {
      const entry = corpus[name];
      assert.ok(entry, `${name} 缺少标注`);
      assert.equal(entry.lang, 'zh-en');
      assert.match(entry.text ?? '', /[\u4e00-\u9fff]/u, `${name} 缺少中文字符`);
      assert.match(entry.text ?? '', /[A-Za-z]/u, `${name} 缺少拉丁字符`);
      assert.ok(Object.keys(entry.fields ?? {}).length >= 3, `${name} 缺少业务字段`);
    }
  });

  test('weights business loss by field risk', () => {
    const fields = { 合计金额: '1,280', 备注: '合同签署完成' };
    const perfect = benchmarkBusinessLoss(fields, '合计金额 1,280 元 合同签署完成');
    assert.equal(perfect?.rate, 0);
    const textTypo = benchmarkBusinessLoss(fields, '合计金额 1,280 元 合同签暑完成');
    const amountWrong = benchmarkBusinessLoss(fields, '合计金额 1,281 元 合同签署完成');
    assert.ok(textTypo && amountWrong);
    assert.ok((amountWrong?.rate ?? 0) > (textTypo?.rate ?? 1));
    assert.ok((amountWrong?.rate ?? 0) > 0);

    const accountMissing = benchmarkBusinessLoss(
      { 银行账号: '6222 0000 1111 2222', 备注: '备查' },
      '备查',
    );
    assert.ok(accountMissing && accountMissing.rate > 0.8);
  });

  test('scores table rows, columns, cells, merges and structure', () => {
    const expectedRows = [
      ['项目', '金额'],
      ['A', '100'],
    ];
    const tableBlock = (
      rows: string[][],
      cells: DocumentBlock['cells'] = undefined,
    ): DocumentBlock => ({
      id: 't1',
      type: 'table',
      text: '',
      bbox: null,
      confidence: null,
      source: { engine: 'test', model: null, stage: 'native' },
      validation: null,
      order: 0,
      rows,
      cells,
    });

    const exact = benchmarkTableMetrics(
      [{ rows: expectedRows, cells: [] }],
      [tableBlock(expectedRows)],
    );
    assert.equal(exact?.tables, 1);
    assert.equal(exact?.rowsF1, 1);
    assert.equal(exact?.columnsF1, 1);
    assert.equal(exact?.cellAccuracy, 1);
    assert.equal(exact?.cellIoU, null);
    assert.equal(exact?.mergedCellAccuracy, null);
    assert.equal(exact?.teds, 1);

    const wrong = benchmarkTableMetrics(
      [{ rows: expectedRows, cells: [] }],
      [
        tableBlock([
          ['项目', '金额'],
          ['A', '200'],
        ]),
      ],
    );
    assert.equal(wrong?.cellAccuracy, 0.75);
    assert.ok((wrong?.teds ?? 1) < 1);

    const merged: DocumentBlock['cells'] = [
      {
        row: 0,
        column: 0,
        text: '项目',
        rowSpan: 2,
        columnSpan: 1,
        bbox: { x: 0, y: 0, width: 100, height: 50 },
      },
      {
        row: 0,
        column: 1,
        text: '金额',
        rowSpan: 1,
        columnSpan: 1,
        bbox: { x: 100, y: 0, width: 100, height: 25 },
      },
      {
        row: 1,
        column: 1,
        text: '100',
        rowSpan: 1,
        columnSpan: 1,
        bbox: { x: 100, y: 25, width: 100, height: 25 },
      },
    ];
    const mergedMetrics = benchmarkTableMetrics(
      [
        {
          rows: [],
          cells: merged.map((cell) => ({
            row: cell.row,
            column: cell.column,
            text: cell.text,
            rowSpan: cell.rowSpan ?? 1,
            columnSpan: cell.columnSpan ?? 1,
            bbox: cell.bbox ?? null,
          })),
        },
      ],
      [tableBlock([], merged)],
    );
    assert.equal(mergedMetrics?.cellIoU, 1);
    assert.equal(mergedMetrics?.mergedCellAccuracy, 1);
    assert.equal(mergedMetrics?.teds, 1);

    const ragged = benchmarkTableMetrics(
      [{ rows: expectedRows, cells: [] }],
      [
        tableBlock([
          ['项目', '金额', '备注'],
          ['A', '100', '无'],
        ]),
      ],
    );
    assert.ok((ragged?.columnsF1 ?? 1) < 1);
    assert.ok((ragged?.teds ?? 1) < 1);
  });
});

describe('OCR benchmark persistence', () => {
  test('stores every run and result and reloads them for a new process', async (t) => {
    const sidecar = await fakeSidecar();
    t.after(sidecar.close);
    const { corpus, store } = benchFixture(t, {
      'ground_truth.json': JSON.stringify({
        'good.png': {
          kind: 'image',
          lang: 'zh',
          difficulty: 'clean',
          degradations: ['screenshot'],
          text: '季度营收 18.5%',
          keywords: ['季度营收', '18.5%'],
          fields: { 合计金额: '18.5%', disputed: '未知值' },
          uncertain: ['disputed'],
          provenance: {
            annotator: 'alice',
            reviewer: 'bob',
            annotatedAt: '2026-01-01',
            sha256: createHash('sha256').update('png').digest('hex'),
            source: 'scan',
          },
        },
        'broken.png': { kind: 'image' },
      }),
      'good.png': 'png',
      'broken.png': 'png',
    });
    const client = new OcrClient({ paddleUrl: sidecar.url });
    const bench = new OcrBench(store, client, corpus);

    const started = await bench.start(false);
    assert.ok(started.run);
    assert.equal(started.run.total, 2);
    assert.ok(['running', 'done'].includes(started.run.status));
    await waitFor(() => store.ocrBench.latest()?.status === 'done');

    const stored = store.ocrBench.latest();
    assert.ok(stored);
    assert.equal(stored.completed, 2);
    assert.deepEqual(
      stored.results.map((result) => [result.name, result.status]),
      [
        ['broken.png', 'failed'],
        ['good.png', 'done'],
      ],
    );
    assert.match(stored.results[0]?.error ?? '', /bad file/);
    assert.equal(stored.results[1]?.cer, 0);
    assert.equal(stored.results[1]?.rawCer, 0);
    assert.equal(stored.results[1]?.numericCer, 0);
    assert.deepEqual(stored.results[1]?.keywordRecall, { hit: 2, total: 2 });
    assert.deepEqual(stored.results[1]?.fieldAccuracy, { hit: 1, total: 1, rate: 1 });
    assert.deepEqual(stored.results[1]?.fieldExact, { hit: 1, total: 1, rate: 1 });
    assert.deepEqual(stored.results[1]?.fieldOutcomes, [
      { field: '合计金额', category: 'amount', correct: true, localized: false },
    ]);
    assert.equal(stored.results[1]?.fullyCorrect, true);
    assert.equal(stored.results[1]?.lang, 'zh');
    assert.equal(stored.results[1]?.difficulty, 'clean');
    assert.deepEqual(stored.results[1]?.degradations, ['screenshot']);
    assert.equal(stored.results[1]?.provenance?.annotator, 'alice');
    assert.deepEqual(stored.results[1]?.uncertain, ['disputed']);
    assert.equal(stored.results[1]?.hashVerified, true);
    assert.equal(stored.results[1]?.sha256, createHash('sha256').update('png').digest('hex'));
    assert.equal(stored.results[1]?.wer, 0);
    assert.deepEqual(stored.results[1]?.errors?.types, []);
    assert.equal(stored.results[0]?.fullyCorrect, null);
    assert.equal(stored.results[0]?.lang, null);
    assert.deepEqual(stored.results[0]?.degradations, []);
    assert.equal(stored.results[1]?.qualityStatus, 'pass');
    assert.ok((stored.results[1]?.qualityScore ?? 0) > 0.8);
    assert.equal(stored.results[1]?.reviewRequired, false);
    assert.equal(stored.results[1]?.stages.length, 1);
    assert.equal(stored.results[1]?.route, null);

    const reloaded = new OcrBench(store, client, corpus);
    const status = await reloaded.status();
    assert.ok(status.aggregate);
    assert.equal(status.aggregate?.evaluated, 1);
    assert.equal(status.aggregate?.fullyCorrect?.hit, 1);
    assert.deepEqual(
      status.aggregate?.calibrationGroups.map((group) => [group.dimension, group.value]),
      [
        ['kind', 'image'],
        ['language', 'zh'],
      ],
    );
    assert.equal(status.aggregate?.calibrationGroups[0]?.calibration.samples, 1);
    const amount = status.aggregate?.fieldReliability.find((entry) => entry.category === 'amount');
    assert.equal(amount?.samples, 1);
    assert.equal(amount?.hit, 1);
    assert.equal(amount?.accuracy, 1);
    assert.equal(amount?.calibration.samples, 1);
    assert.deepEqual(
      status.aggregate?.groups.find((group) => group.dimension === 'language'),
      {
        dimension: 'language',
        value: 'zh',
        files: 1,
        pages: 1,
        failed: 0,
        cer: 0,
        fieldAccuracy: 1,
        fieldTotal: 1,
        fieldStrong: null,
        fieldStrongTotal: 0,
        fullyCorrectRate: 1,
      },
    );
    assert.equal(status.history.length, 1);
    assert.equal(status.history[0]?.id, stored.id);
    assert.equal(status.history[0]?.status, 'done');
    assert.equal(status.history[0]?.completed, 2);
    assert.equal(status.history[0]?.failed, 1);
    assert.equal(status.history[0]?.includePdf, false);
    assert.ok(status.history[0]?.finishedAt);
    assert.deepEqual(
      status.run?.results.map((result) => result.name),
      ['broken.png', 'good.png'],
    );

    const replay = await bench.replay('good.png', { kind: 'visual' });
    assert.equal(replay.inputMatches, true);
    assert.equal(replay.outputMatches, true);
    assert.equal(replay.scoreDelta, 0);
    assert.deepEqual(replay.params, {
      mode: 'auto',
      dpi: null,
      page: null,
      bbox: null,
      padding: null,
    });
    await assert.rejects(bench.replay('good.png', { kind: 'vlm' }), /找不到可重放的阶段/);
    await assert.rejects(bench.replay('missing.png', { kind: 'visual' }), /没有 missing\.png/);
  });

  test('marks interrupted runs as failed on startup', async (t) => {
    const { corpus, store } = benchFixture(t, {});
    const client = new OcrClient({ paddleUrl: 'http://127.0.0.1:9' });
    store.ocrBench.start({
      id: 'interrupted-run',
      startedAt: new Date().toISOString(),
      includePdf: true,
      total: 3,
    });
    store.ocrBench.progress('interrupted-run', 'scan.png', 1);

    const bench = new OcrBench(store, client, corpus);
    const status = await bench.status();
    assert.equal(status.run?.id, 'interrupted-run');
    assert.equal(status.run?.status, 'failed');
    assert.equal(status.run?.finishedAt !== null, true);
    assert.match(status.run?.error ?? '', /服务重启/);
    assert.equal(status.history[0]?.status, 'failed');
    assert.equal(status.history[0]?.includePdf, true);
    assert.equal(status.history[0]?.failed, 0);
  });

  test('keeps a bounded history for recent runs', (t) => {
    const { store } = benchFixture(t, {});
    for (let index = 0; index < 12; index += 1) {
      store.ocrBench.start({
        id: `run-${index}`,
        startedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
        includePdf: index % 2 === 1,
        total: 1,
      });
      store.ocrBench.finish(`run-${index}`, 'done', new Date().toISOString(), null);
    }
    const history = store.ocrBench.history();
    assert.equal(history.length, 10);
    assert.equal(history[0]?.id, 'run-11');
    assert.equal(history[9]?.id, 'run-2');
  });
});
