import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DocumentBlock, DocumentIr } from '../shared/types.ts';
import {
  annotateTableMetadata,
  inferTableSchema,
  numericCandidates,
  parseDateValue,
  tableBusinessChecks,
  tableBusinessSummary,
} from '../src/ocr-tables.ts';

function table(rows: string[][], overrides: Partial<DocumentBlock> = {}): DocumentBlock {
  return {
    id: 't1',
    type: 'table',
    text: rows.map((row) => row.join(' | ')).join('\n'),
    bbox: { x: 0, y: 0, width: 300, height: 200 },
    confidence: 0.95,
    source: { engine: 'paddle', model: 'model-a', stage: 'visual' },
    validation: null,
    order: 0,
    rows,
    ...overrides,
  };
}

function documentWith(block: DocumentBlock): DocumentIr {
  return {
    version: 1,
    route: 'visual',
    pages: [{ number: 1, width: 300, height: 200, blocks: [block], source: null }],
    readingOrder: [block.id],
    meta: {},
  };
}

describe('table schema inference', () => {
  test('combines multi-level headers and keeps units', () => {
    const schema = inferTableSchema(
      table([
        ['', '销售', '销售'],
        ['项目', '数量', '金额（元）'],
        ['A', '2', '¥1,280.00'],
        ['B', '3', '1.280,00'],
      ]),
    );
    assert.ok(schema);
    assert.equal(schema.headerRows, 2);
    assert.deepEqual(
      schema.columns.map((column) => [column.label, column.kind, column.unit]),
      [
        ['项目', 'text', null],
        ['销售 / 数量', 'quantity', null],
        ['销售 / 金额（元）', 'amount', '元'],
      ],
    );
  });

  test('keeps a single header row when the first row is data-like', () => {
    const schema = inferTableSchema(
      table([
        ['2024', '2025'],
        ['100', '200'],
        ['300', '400'],
      ]),
    );
    assert.ok(schema);
    assert.equal(schema.headerRows, 1);
  });
});

describe('numeric candidates', () => {
  test('preserves US and European amount formats', () => {
    const us = numericCandidates('¥1,280.00', 'amount');
    assert.equal(us.length, 1);
    assert.equal(us[0]?.value, 1280);
    assert.equal(us[0]?.format, 'mixed-dot-decimal');
    assert.equal(us[0]?.ambiguous, false);
    assert.equal(us[0]?.preferred, true);

    const eu = numericCandidates('1.280,00', 'amount');
    assert.equal(eu.length, 1);
    assert.equal(eu[0]?.value, 1280);
    assert.equal(eu[0]?.format, 'mixed-comma-decimal');
  });

  test('exposes ambiguous thousands vs decimal readings', () => {
    const amount = numericCandidates('1,280', 'amount');
    assert.deepEqual(
      amount.map((candidate) => [candidate.value, candidate.format, candidate.ambiguous]),
      [
        [1280, 'thousands-comma', true],
        [1.28, 'decimal-comma', true],
      ],
    );
    assert.equal(amount.find((candidate) => candidate.preferred)?.value, 1280);

    const percentage = numericCandidates('1.280', 'percentage');
    assert.equal(percentage.find((candidate) => candidate.preferred)?.value, 1.28);
    assert.equal(
      percentage.some((candidate) => candidate.value === 1280),
      true,
    );
  });

  test('handles signs, percentages and corruption', () => {
    assert.equal(numericCandidates('(1,280.00)', 'amount')[0]?.value, -1280);
    assert.equal(numericCandidates('13%', 'percentage')[0]?.percent, true);
    assert.equal(numericCandidates('12,5', 'quantity')[0]?.value, 12.5);
    assert.deepEqual(numericCandidates('1O0', 'amount'), []);
    assert.deepEqual(numericCandidates('1,2800', 'amount'), []);
    assert.deepEqual(parseDateValue('2024年2月29日'), { year: 2024, month: 2, day: 29 });
    assert.equal(parseDateValue('2023年2月29日'), null);
  });
});

describe('table metadata annotation', () => {
  test('stores schema and ambiguous candidates without changing cell text', () => {
    const block = table([
      ['', '销售', '销售'],
      ['项目', '数量', '金额（元）'],
      ['A', '2', '¥1,280.00'],
      ['B', '3', '1.280,00'],
      ['C', '4', '1,280'],
      ['D', '5', '300'],
    ]);
    annotateTableMetadata(documentWith(block));
    const schema = block.meta?.columnSchema as { headerRows: number };
    assert.equal(schema.headerRows, 2);
    const candidates = block.meta?.numberCandidates as {
      row: number;
      column: number;
      raw: string;
      candidates: { value: number; preferred: boolean }[];
      selected: number | null;
      ambiguous: boolean;
    }[];
    assert.deepEqual(
      candidates.map((item) => [item.row, item.column, item.raw, item.candidates[0]?.value]),
      [
        [2, 2, '¥1,280.00', 1280],
        [3, 2, '1.280,00', 1280],
        [4, 2, '1,280', 1280],
      ],
    );
    assert.equal(candidates[2]?.ambiguous, true);
    assert.equal(candidates[2]?.selected, 0);
    assert.deepEqual(block.rows?.[2], ['A', '2', '¥1,280.00']);
  });
});

describe('table business constraints', () => {
  test('checks debit-credit balance without rewriting values', () => {
    const balanced = table([
      ['摘要', '借方', '贷方'],
      ['收入', '100.00', '100.00'],
    ]);
    const passed = tableBusinessChecks(balanced);
    assert.equal(passed[0]?.code, 'debit_credit_balance');
    assert.equal(passed[0]?.status, 'passed');

    const unbalanced = table([
      ['摘要', '借方', '贷方'],
      ['收入', '100.00', '90.00'],
    ]);
    const failed = tableBusinessChecks(unbalanced);
    assert.equal(failed[0]?.status, 'failed');
    assert.match(failed[0]?.message ?? '', /不平衡/);
    assert.deepEqual(unbalanced.rows?.[1], ['收入', '100.00', '90.00']);
  });

  test('checks tax and flags mixed currencies', () => {
    const tax = table([
      ['不含税金额', '税率', '税额'],
      ['1,000.00', '13%', '130.00'],
    ]);
    assert.equal(tableBusinessChecks(tax)[0]?.status, 'passed');
    const badTax = table([
      ['不含税金额', '税率', '税额'],
      ['1,000.00', '13%', '120.00'],
    ]);
    assert.equal(tableBusinessChecks(badTax)[0]?.status, 'failed');

    const mixed = table([['金额'], ['¥100.00'], ['$200.00']]);
    assert.equal(tableBusinessChecks(mixed)[0]?.code, 'currency_consistency');
    assert.equal(tableBusinessChecks(mixed)[0]?.status, 'warning');
  });

  test('checks date range, identifier shape and required columns', () => {
    const dates = table([
      ['日期', '备注'],
      ['1899-01-01', 'A'],
      ['2024-01-02', 'B'],
    ]);
    assert.equal(tableBusinessChecks(dates)[0]?.status, 'warning');

    const identifiers = table([
      ['编号', '金额'],
      ['12345', '10'],
      ['A12345', '20'],
      ['67890', '30'],
    ]);
    assert.equal(tableBusinessChecks(identifiers)[0]?.code, 'identifier_format');
    assert.equal(tableBusinessChecks(identifiers)[0]?.status, 'warning');

    const missing = table(
      [
        ['日期', '金额'],
        ['2024-01-02', '10'],
      ],
      { meta: { requiredColumns: ['订单号', '金额'] } },
    );
    const summary = tableBusinessSummary(missing);
    assert.equal(summary.failed, 1);
    assert.match(summary.checks[0]?.message ?? '', /订单号/);
  });
});
