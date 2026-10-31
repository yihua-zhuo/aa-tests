import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

type GeneratedTruth = {
  kind?: string;
  lang?: string;
  difficulty?: string;
  degradations?: string[];
  provenance?: { sha256?: string; source?: string };
};

const generated = ['multicolumn.png', 'complex_table.png', 'skewed_photo.png', 'fax.png'];

const v2Packs: Array<[pack: string, source: string]> = [
  ['wide-tables', 'scripts/generate_wide_table_corpus.py'],
  ['degraded-layout', 'scripts/generate_degraded_corpus.py'],
  ['semantic-regions', 'scripts/generate_semantic_corpus.py'],
];

function verifyPack(pack: string, source: string): void {
  const corpus = join(process.cwd(), 'benchmarks', 'corpus-v2', pack);
  const truth = JSON.parse(readFileSync(join(corpus, 'ground_truth.json'), 'utf8')) as Record<
    string,
    GeneratedTruth
  >;
  const files = readdirSync(corpus)
    .filter((name) => name !== 'ground_truth.json')
    .sort();
  assert.deepEqual(Object.keys(truth).sort(), files, `${pack} truth/files mismatch`);
  for (const [name, entry] of Object.entries(truth)) {
    assert.ok(entry.kind, `${pack}/${name} has no kind`);
    assert.ok(entry.lang, `${pack}/${name} has no lang`);
    assert.ok(entry.difficulty, `${pack}/${name} has no difficulty`);
    assert.ok((entry.degradations ?? []).length > 0, `${pack}/${name} has no degradations`);
    assert.equal(entry.provenance?.source, source, `${pack}/${name} source drift`);
    const sha256 = createHash('sha256')
      .update(readFileSync(join(corpus, name)))
      .digest('hex');
    assert.equal(entry.provenance?.sha256, sha256, `${pack}/${name} hash drift`);
  }
}

describe('generated OCR benchmark corpus', () => {
  test('ships reproducible synthetic samples with matching hashes', () => {
    const corpus = join(process.cwd(), 'benchmarks', 'ocr');
    const truth = JSON.parse(readFileSync(join(corpus, 'ground_truth.json'), 'utf8')) as Record<
      string,
      GeneratedTruth
    >;
    for (const name of generated) {
      const entry = truth[name];
      assert.ok(entry, `${name} is missing from ground truth`);
      assert.ok(entry.difficulty, `${name} has no difficulty`);
      assert.ok((entry.degradations ?? []).length > 0, `${name} has no degradations`);
      assert.equal(entry.provenance?.source, 'scripts/generate_ocr_corpus.py');
      const content = readFileSync(join(corpus, name));
      const sha256 = createHash('sha256').update(content).digest('hex');
      assert.equal(entry.provenance?.sha256, sha256, `${name} hash drift`);
    }
  });

  for (const [pack, source] of v2Packs) {
    test(`${pack} pack is complete and reproducible`, () => {
      verifyPack(pack, source);
    });
  }
});
