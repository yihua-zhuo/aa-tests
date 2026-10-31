import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  DocumentBBox,
  DocumentBlock,
  DocumentBlockType,
  DocumentIr,
  DocumentPage,
  DocumentSource,
} from '../shared/types.ts';
import { normalizeDocumentIr, refineDocumentIr } from '../src/document-ir.ts';

function bbox(x: number, y: number, width: number, height: number): DocumentBBox {
  return { x, y, width, height };
}

function source(stage: DocumentSource['stage']): DocumentSource {
  return { engine: 'test', model: null, stage };
}

function block(
  id: string,
  text: string,
  box: DocumentBBox | null,
  overrides: Partial<DocumentBlock> = {},
): DocumentBlock {
  return {
    id,
    type: 'paragraph',
    text,
    bbox: box,
    confidence: 0.9,
    source: source('visual'),
    validation: null,
    order: 0,
    ...overrides,
  };
}

function page(number: number, blocks: DocumentBlock[], width = 1000, height = 1000): DocumentPage {
  return { number, width, height, blocks, source: null };
}

function documentIr(pages: DocumentPage[]): DocumentIr {
  return {
    version: 1,
    route: 'visual',
    pages,
    readingOrder: pages.flatMap((page) => page.blocks.map((block) => block.id)),
    meta: {},
  };
}

function refinementOf(document: DocumentIr) {
  return document.meta.refinement as {
    headers: number;
    footers: number;
    overlaps: number;
    continuations: number;
    readingOrder: 'graph' | 'source';
  };
}

test('maps the pre-split confirmed agreement to same-engine provenance', () => {
  const document = documentIr([
    page(1, [
      block('b1', '合计 1280', bbox(10, 10, 100, 20), {
        meta: { regionAgreement: 'confirmed' },
      }),
    ]),
  ]);
  document.meta.fieldEvidence = [
    { agreement: 'confirmed' },
    { agreement: 'confirmed_independent' },
    { agreement: 'conflict' },
    'not-an-object',
  ];

  normalizeDocumentIr(document);

  // Same-engine re-reads cannot prove independence, so the old single
  // `confirmed` value must not become `confirmed_independent`.
  assert.equal(document.pages[0]?.blocks[0]?.meta?.regionAgreement, 'confirmed_same_engine');
  assert.deepEqual(
    (document.meta.fieldEvidence as { agreement: unknown }[]).map((item) =>
      typeof item === 'object' ? item.agreement : item,
    ),
    ['confirmed_same_engine', 'confirmed_independent', 'conflict', 'not-an-object'],
  );
  assert.equal(normalizeDocumentIr(null), null);
});

test('orders a two-column page around a spanning title', () => {
  const document = documentIr([
    page(1, [
      block('l2', '左栏第二段', bbox(60, 180, 300, 40)),
      block('r2', '右栏第二段', bbox(600, 185, 300, 40)),
      block('title', '季度经营报告', bbox(100, 50, 800, 40), {
        type: 'heading' as DocumentBlockType,
        source: source('native'),
      }),
      block('r1', '右栏第一段', bbox(600, 125, 300, 40)),
      block('l1', '左栏第一段', bbox(60, 120, 300, 40)),
    ]),
  ]);

  refineDocumentIr(document);
  assert.deepEqual(document.readingOrder, ['title', 'l1', 'l2', 'r1', 'r2']);
  assert.equal(refinementOf(document).readingOrder, 'graph');
  const title = document.pages[0]?.blocks.find((item) => item.id === 'title');
  assert.equal(title?.meta?.orderReason, 'spanning');
  const right = document.pages[0]?.blocks.find((item) => item.id === 'r1');
  assert.equal(right?.meta?.orderReason, 'column');
  assert.equal(right?.meta?.orderColumn, 1);
});

test('keeps source order when blocks lack coordinates', () => {
  const document = documentIr([
    page(1, [
      block('b1', '第一段', null, { order: 2 }),
      block('b2', '第二段', null, { order: 0 }),
      block('b3', '第三段', null, { order: 1 }),
    ]),
  ]);

  refineDocumentIr(document);
  assert.deepEqual(document.readingOrder, ['b2', 'b3', 'b1']);
  assert.equal(refinementOf(document).readingOrder, 'source');
});

test('marks repeated headers and page-number footers without deleting them', () => {
  const document = documentIr([
    page(1, [
      block('h1', 'ACME 机密', bbox(40, 20, 300, 20)),
      block('b1', '正文一', bbox(40, 200, 600, 40)),
      block('f1', '第 1 页', bbox(440, 960, 120, 20)),
    ]),
    page(2, [
      block('h2', 'ACME 机密', bbox(40, 20, 300, 20)),
      block('b2', '正文二', bbox(40, 200, 600, 40)),
      block('f2', '第 2 页', bbox(440, 960, 120, 20)),
    ]),
    page(3, [
      block('h3', 'ACME 机密', bbox(40, 20, 300, 20)),
      block('b3', '正文三', bbox(40, 200, 600, 40)),
      block('f3', '第 3 页', bbox(440, 960, 120, 20)),
    ]),
  ]);

  refineDocumentIr(document);
  const stats = refinementOf(document);
  assert.equal(stats.headers, 3);
  assert.equal(stats.footers, 3);
  const blocks = document.pages.flatMap((item) => item.blocks);
  for (const header of blocks.filter((item) => item.id.startsWith('h'))) {
    assert.equal(header.type, 'header');
    assert.equal(header.meta?.template, 'header');
    assert.equal(header.meta?.templatePages, 3);
  }
  for (const footer of blocks.filter((item) => item.id.startsWith('f'))) {
    assert.equal(footer.type, 'footer');
    assert.equal(footer.meta?.template, 'footer');
  }
  // Reading order keeps headers before the body and footers after it on each page.
  assert.deepEqual(document.readingOrder, ['h1', 'b1', 'f1', 'h2', 'b2', 'f2', 'h3', 'b3', 'f3']);
  assert.equal(blocks.length, 9);
});

test('links same-position duplicates and keeps both blocks', () => {
  const position = bbox(100, 300, 400, 40);
  const document = documentIr([
    page(1, [
      block('native', '合同金额 1,280 元', position, {
        source: source('native'),
        confidence: 0.8,
      }),
      block('visual', '合同金额 1,280 元', position, { confidence: 0.99 }),
      block('other', '签订地点 北京市', position),
    ]),
  ]);

  refineDocumentIr(document);
  const stats = refinementOf(document);
  assert.equal(stats.overlaps, 1);
  const blocks = document.pages[0]?.blocks ?? [];
  assert.equal(blocks.length, 3);
  const duplicate = blocks.find((item) => item.id === 'visual');
  assert.equal(duplicate?.meta?.overlapOf, 'native');
  assert.equal(blocks.find((item) => item.id === 'other')?.meta?.overlapOf, undefined);
  assert.deepEqual(document.readingOrder, ['native', 'other']);
});

test('links a continued table without merging rows', () => {
  const first = block('t1', '项目 金额', bbox(40, 800, 600, 150), {
    type: 'table',
    rows: [
      ['项目', '金额'],
      ['A', '100'],
    ],
  });
  const second = block('t2', '项目 金额', bbox(40, 60, 600, 150), {
    type: 'table',
    rows: [
      ['项目', '金额'],
      ['B', '200'],
    ],
  });
  const document = documentIr([
    page(1, [block('p1', '正文一', bbox(40, 100, 600, 40)), first]),
    page(2, [second]),
  ]);

  refineDocumentIr(document);
  assert.equal(refinementOf(document).continuations, 1);
  assert.deepEqual(first.meta?.continuedTo, { page: 2, blockId: 't2' });
  assert.deepEqual(second.meta?.continuedFrom, { page: 1, blockId: 't1' });
  assert.equal(second.meta?.repeatedHeader, true);
  assert.equal(first.rows?.length, 2);
  assert.equal(second.rows?.length, 2);
});

test('does not link tables with different column counts', () => {
  const first = block('t1', '项目 金额', bbox(40, 800, 600, 150), {
    type: 'table',
    rows: [
      ['项目', '金额'],
      ['A', '100'],
    ],
  });
  const second = block('t2', '项目 金额 备注', bbox(40, 60, 600, 150), {
    type: 'table',
    rows: [
      ['项目', '金额', '备注'],
      ['B', '200', '无'],
    ],
  });
  const document = documentIr([page(1, [first]), page(2, [second])]);

  refineDocumentIr(document);
  assert.equal(refinementOf(document).continuations, 0);
  assert.equal(first.meta?.continuedTo, undefined);
  assert.equal(second.meta?.continuedFrom, undefined);
});
