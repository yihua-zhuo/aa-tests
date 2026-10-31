import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DocumentIr } from '../shared/types.ts';
import { CamelotClient, mergeCamelotTables } from '../src/ocr-camelot.ts';

function documentWithTable(rows: string[][]): DocumentIr {
  return {
    version: 1,
    route: 'native',
    pages: [
      {
        number: 1,
        width: 595,
        height: 842,
        source: null,
        blocks: [
          {
            id: 'p1-b0',
            type: 'paragraph',
            text: 'Invoice',
            bbox: null,
            confidence: 0.95,
            source: { engine: 'pdfplumber', model: null, stage: 'native' },
            validation: null,
            order: 0,
          },
          {
            id: 'p1-b1',
            type: 'table',
            text: rows.map((row) => row.join('\t')).join('\n'),
            bbox: null,
            confidence: 0.9,
            source: { engine: 'pdfplumber', model: null, stage: 'native' },
            validation: null,
            order: 1,
            rows,
          },
        ],
      },
    ],
    readingOrder: ['p1-b0', 'p1-b1'],
    meta: {},
  };
}

describe('Camelot table merge', () => {
  test('does nothing without tables or matching pages', () => {
    const document = documentWithTable([['A', 'B']]);
    assert.equal(mergeCamelotTables(document, []), document);
    assert.equal(
      mergeCamelotTables(document, [{ page: 9, rows: [['X']], bbox: null, flavor: 'lattice' }]),
      document,
    );
  });

  test('adds a missing table as DIR evidence without duplicating native tables', () => {
    const document = documentWithTable([['A', 'B']]);
    const merged = mergeCamelotTables(document, [
      { page: 1, rows: [['a', ' b ']], bbox: null, flavor: 'lattice' },
      {
        page: 1,
        rows: [
          ['Item', 'Qty'],
          ['Cable', '4'],
        ],
        bbox: { x: 10, y: 20, width: 100, height: 50 },
        flavor: 'lattice',
      },
    ]);
    assert.notEqual(merged, document);
    const blocks = merged.pages[0]?.blocks ?? [];
    assert.equal(blocks.filter((block) => block.type === 'table').length, 2);
    const added = blocks[2];
    assert.ok(added);
    assert.equal(added.type, 'table');
    assert.deepEqual(added.rows, [
      ['Item', 'Qty'],
      ['Cable', '4'],
    ]);
    assert.equal(added.source.stage, 'camelot');
    assert.equal(added.meta?.camelot, true);
    assert.deepEqual(
      merged.readingOrder,
      blocks.map((block) => block.id),
    );
    assert.equal(document.pages[0]?.blocks.length, 2);
  });

  test('the optional client is inert without a URL', async () => {
    const client = new CamelotClient({ url: '' });
    assert.equal(client.configured, false);
    assert.deepEqual(await client.tables('/tmp/a.pdf', 'a.pdf'), {
      tables: [],
      truncated: false,
    });
  });
});
