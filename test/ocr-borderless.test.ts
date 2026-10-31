import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DocumentBlock, DocumentIr, DocumentPage } from '../shared/types.ts';
import { refineDocumentIr, tableChains } from '../src/document-ir.ts';
import { inferBorderlessTables } from '../src/ocr-borderless.ts';

function block(
  id: string,
  text: string,
  x: number,
  y: number,
  width = 120,
  height = 18,
  type: DocumentBlock['type'] = 'paragraph',
): DocumentBlock {
  return {
    id,
    type,
    text,
    bbox: { x, y, width, height },
    confidence: 0.9,
    source: { engine: 'paddle', model: 'pp-structure', stage: 'visual' },
    validation: null,
    order: 0,
  };
}

function page(blocks: DocumentBlock[]): DocumentPage {
  return { number: 1, width: 800, height: 1000, blocks, source: null };
}

function documentIr(pages: DocumentPage[]): DocumentIr {
  return {
    version: 1,
    route: 'visual',
    pages,
    readingOrder: [],
    meta: {},
  };
}

function tableLines(): DocumentBlock[] {
  const rows = [
    ['名称', '金额', '日期'],
    ['服务费', '1280.00', '2026-01-05'],
    ['材料费', '860.50', '2026-01-06'],
    ['差旅费', '320.00', '2026-01-07'],
  ];
  return rows.flatMap((row, rowIndex) =>
    row.map((text, column) =>
      block(`r${rowIndex}c${column}`, text, 40 + column * 200, 100 + rowIndex * 30, 140, 18),
    ),
  );
}

test('infers a borderless table from aligned short cells', () => {
  const blocks = tableLines();
  const tables = inferBorderlessTables(page(blocks));
  assert.equal(tables.length, 1);
  const table = tables[0];
  assert.ok(table);
  assert.equal(table.method, 'text-alignment');
  assert.equal(table.page, 1);
  assert.equal(table.columns.length, 3);
  assert.equal(table.rows.length, 4);
  assert.ok(table.confidence > 0.6);
  assert.deepEqual(
    table.rows[1]?.cells.map((cell) => cell.text),
    ['服务费', '1280.00', '2026-01-05'],
  );
  for (const source of blocks) {
    assert.equal(source.text, source.text.trim());
    assert.equal(source.meta?.borderlessTable, undefined);
  }
});

test('does not treat multi-column prose as a table', () => {
  const long = '这是一段很长的合同正文，用来验证多栏排版不会被误判为无框线表格。'.repeat(2);
  const blocks = Array.from({ length: 4 }, (_, rowIndex) => [
    block(`l${rowIndex}`, long, 40, 100 + rowIndex * 30, 340, 18),
    block(`r${rowIndex}`, long, 420, 100 + rowIndex * 30, 340, 18),
  ]).flat();
  assert.deepEqual(inferBorderlessTables(page(blocks)), []);
});

test('does not duplicate an existing ruled table', () => {
  const blocks = tableLines();
  const ruled = block('table', '名称 金额 日期', 20, 80, 700, 160, 'table');
  assert.deepEqual(inferBorderlessTables(page([...blocks, ruled])), []);
});

test('refinement tags borderless candidates without changing text', () => {
  const blocks = tableLines();
  const document = documentIr([page(blocks)]);
  refineDocumentIr(document);
  const refinement = document.meta.refinement as { borderless: number };
  assert.equal(refinement.borderless, 1);
  const tables = document.meta.borderlessTables as { id: string }[];
  assert.equal(tables.length, 1);
  assert.ok(blocks.every((item) => typeof item.meta?.borderlessTable === 'object'));
  assert.equal(blocks[0]?.text, '名称');
});

function tableBlockWithCells(id: string, y: number, widths: [number, number]): DocumentBlock {
  const table = block(id, '项目 金额', 40, y, 600, 150, 'table');
  table.rows = [
    ['项目', '金额'],
    ['A', '100'],
  ];
  const first = widths[0];
  table.cells = [
    { row: 0, column: 0, text: '项目', bbox: { x: 40, y, width: first, height: 40 } },
    {
      row: 0,
      column: 1,
      text: '金额',
      bbox: { x: 40 + first, y, width: widths[1], height: 40 },
    },
  ];
  return table;
}

test('rejects a continuation with a different column width profile', () => {
  const first = tableBlockWithCells('t1', 820, [510, 90]);
  const second = tableBlockWithCells('t2', 60, [90, 510]);
  const document = documentIr([
    page([first]),
    { number: 2, width: 800, height: 1000, blocks: [second], source: null },
  ]);
  refineDocumentIr(document);
  assert.equal(first.meta?.continuedTo, undefined);
  assert.equal(second.meta?.continuedFrom, undefined);
  assert.deepEqual(tableChains(document), []);
});

test('exposes continuation chains without merging page tables', () => {
  const first = block('t1', '项目 金额', 40, 800, 600, 150, 'table');
  first.rows = [
    ['项目', '金额'],
    ['A', '100'],
  ];
  const second = block('t2', '项目 金额', 40, 60, 600, 150, 'table');
  second.rows = [
    ['项目', '金额'],
    ['B', '200'],
  ];
  const document = documentIr([
    page([block('p1', '正文一', 40, 100, 600, 40), first]),
    { number: 2, width: 800, height: 1000, blocks: [second], source: null },
  ]);
  refineDocumentIr(document);
  const chains = tableChains(document);
  assert.equal(chains.length, 1);
  assert.deepEqual(chains[0]?.blocks, [
    { page: 1, blockId: 't1' },
    { page: 2, blockId: 't2' },
  ]);
  assert.equal(chains[0]?.rows, 3);
  const meta = document.meta.tableContinuations as typeof chains;
  assert.deepEqual(meta, chains);
  assert.equal(first.rows?.length, 2);
  assert.equal(second.rows?.length, 2);
  assert.deepEqual(first.meta?.continuationEvidence, {
    headerSimilarity: 1,
    widthSimilarity: null,
    position: 'bottom-to-top',
  });
});
