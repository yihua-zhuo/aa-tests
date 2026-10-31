import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DocumentBlock, DocumentIr, OcrFieldRevision } from '../shared/types.ts';
import {
  buildKnowledgeGraph,
  knowledgeKey,
  type OcrKnowledgeDocument,
} from '../src/ocr-knowledge.ts';

const SOURCE = { engine: 'native', model: null, stage: 'native' as const };

function block(id: string, text: string, confidence = 0.9): DocumentBlock {
  return {
    id,
    type: 'paragraph',
    text,
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    confidence,
    source: SOURCE,
    validation: null,
    order: 0,
  };
}

function document(...blocks: DocumentBlock[]): DocumentIr {
  return {
    version: 1,
    route: 'native',
    pages: [
      {
        number: 1,
        width: null,
        height: null,
        blocks,
        source: SOURCE,
      },
    ],
    readingOrder: blocks.map((item) => item.id),
    meta: {},
  };
}

function revision(fieldId: string, original: string, revised: string): OcrFieldRevision {
  return {
    id: `rev-${fieldId}`,
    attachmentId: 'a1',
    projectId: 'p1',
    fieldId,
    fieldKind: 'amount',
    page: 1,
    blockId: 'b1',
    bbox: null,
    originalText: original,
    revisedText: revised,
    reason: '人工核对',
    revisedBy: null,
    createdAt: '2026-09-02T00:00:00.000Z',
  };
}

function knowledgeDocument(
  id: string,
  name: string,
  ir: DocumentIr,
  text: string,
  revisions: OcrFieldRevision[] = [],
): OcrKnowledgeDocument {
  return {
    attachmentId: id,
    projectId: 'p1',
    projectName: '示例项目',
    name,
    createdAt: '2026-09-02T08:00:00.000Z',
    text,
    document: ir,
    revisions,
  };
}

describe('knowledge key normalization', () => {
  test('normalizes identifiers, accounts, amounts and dates', () => {
    assert.deepEqual(knowledgeKey('INV 2026-001', 'identifier'), {
      id: 'identifier:INV2026-001',
      type: 'identifier',
      canonical: 'INV2026-001',
    });
    assert.equal(
      knowledgeKey('账号: 6222 0202 0011 2233', 'account')?.canonical,
      '6222020200112233',
    );
    assert.equal(knowledgeKey('¥1,200.00', 'amount')?.id, 'amount:CNY:1200.00');
    assert.equal(knowledgeKey('2026年9月1日', 'date')?.canonical, '2026-09-01');
    assert.equal(knowledgeKey('abc', 'identifier'), null);
  });
});

describe('knowledge graph', () => {
  test('links shared entities across documents and aggregates amount metrics', () => {
    const first = knowledgeDocument(
      'a1',
      'invoice.pdf',
      document(
        block('b1', '发票号: INV-2026-001'),
        block('b2', '金额: ¥1,000.00'),
        block('b3', '日期: 2026-09-01'),
      ),
      '发票号 INV-2026-001 金额 ¥1,000.00',
    );
    const second = knowledgeDocument(
      'a2',
      'contract.pdf',
      document(block('b1', '合同号: INV-2026-001'), block('b2', '金额: ¥500.00')),
      '本合同的附件发票 INV-2026-001 已归档',
    );
    const graph = buildKnowledgeGraph([first, second], {
      generatedAt: '2026-10-01T00:00:00.000Z',
    });
    assert.equal(graph.documents, 2);
    assert.equal(graph.byType.identifier, 1);
    assert.equal(graph.byType.amount, 2);
    assert.equal(graph.byType.date, 1);

    const invoice = graph.entities.find((entity) => entity.type === 'identifier');
    assert.ok(invoice);
    assert.equal(invoice.canonical, 'INV-2026-001');
    assert.equal(invoice.documents, 2);
    assert.equal(graph.relations.filter((relation) => relation.kind === 'shared').length, 1);

    const total = graph.metrics.find((metric) => metric.key === 'amount:CNY:2026-09');
    assert.ok(total);
    assert.equal(total.value, 1500);
    assert.equal(total.samples, 2);
    assert.equal(
      graph.metrics.find((metric) => metric.key === 'entities:cross_document')?.value,
      1,
    );
  });

  test('uses the latest human revision and detects text mentions', () => {
    const first = knowledgeDocument(
      'a1',
      'invoice.pdf',
      document(block('b1', '金额: ¥1,000.00'), block('b2', '发票号: INV-2026-777')),
      '发票号 INV-2026-777',
      [revision('p1:b1', '金额: ¥1,000.00', '金额: ¥1,200.00')],
    );
    const second = knowledgeDocument(
      'a2',
      'notes.pdf',
      document(block('b1', '金额: ¥200.00')),
      '参见发票 INV-2026-777 的备注',
    );
    const graph = buildKnowledgeGraph([first, second]);
    const amount = graph.entities.find((entity) => entity.id === 'amount:CNY:1200.00');
    assert.ok(amount);
    assert.equal(amount.revised, true);
    assert.ok(graph.entities.every((entity) => entity.id !== 'amount:CNY:1000.00'));

    const mention = graph.relations.find(
      (relation) => relation.kind === 'mentions' && relation.entityType === 'identifier',
    );
    assert.ok(mention);
    assert.deepEqual([mention.from, mention.to].sort(), ['a1', 'a2']);
    assert.equal(graph.metrics.find((metric) => metric.key === 'amount:CNY:2026-09')?.value, 1400);
  });

  test('reports empty graphs and skips unparseable fields', () => {
    const empty = buildKnowledgeGraph([]);
    assert.equal(empty.documents, 0);
    assert.deepEqual(empty.entities, []);
    assert.ok(empty.warnings.some((warning) => warning.includes('没有已完成')));
    assert.equal(empty.metrics.find((metric) => metric.key === 'entities')?.value, 0);

    const invalid = knowledgeDocument(
      'a1',
      'scan.pdf',
      document(block('b1', '金额: 待定'), block('b2', '日期: 2026-09-01')),
      '',
    );
    const graph = buildKnowledgeGraph([invalid]);
    assert.equal(graph.byType.date, 1);
    assert.ok(graph.warnings.some((warning) => warning.includes('无法归一化')));
  });
});
