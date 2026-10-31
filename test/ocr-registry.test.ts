import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { OcrRegistryEntry, OcrRegistryPolicy } from '../shared/types.ts';
import { Database } from '../src/db.ts';
import {
  evaluateRegistry,
  mcnemarExact,
  normalizeRegistryPolicy,
  pairedBenchmarkSignificance,
  registryActiveModel,
  registryGreyConfig,
  registryPairKey,
} from '../src/ocr-registry.ts';
import { OcrRegistryStore } from '../src/stores/ocr-registry.ts';

function entry(overrides: Partial<OcrRegistryEntry> = {}): OcrRegistryEntry {
  const now = '2026-10-20T00:00:00.000Z';
  return {
    id: `reg_${Math.random().toString(36).slice(2)}`,
    engine: 'paddle',
    modelId: 'paddle-v6-medium',
    pipeline: '',
    role: 'control',
    mode: 'canary',
    auto: true,
    percent: 100,
    benchmarkScore: null,
    benchmarkSamples: 0,
    productionScore: null,
    productionSamples: 0,
    note: '',
    decidedBy: null,
    decidedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const POLICY: OcrRegistryPolicy = {
  auto: true,
  minSamples: 20,
  promoteMargin: 0.01,
  rollbackMargin: 0.02,
  significance: 0.05,
};

describe('model registry policy', () => {
  test('promotes a candidate only with enough samples and a clear margin', () => {
    const control = entry({ benchmarkScore: 0.8, benchmarkSamples: 30 });
    const candidate = entry({
      id: 'candidate',
      modelId: 'paddle-v6-server',
      role: 'candidate',
      percent: 20,
      benchmarkScore: 0.82,
      benchmarkSamples: 30,
    });
    const promoted = evaluateRegistry([control, candidate], POLICY);
    assert.equal(promoted.action, 'promote');
    assert.equal(promoted.applied, false);
    assert.ok((promoted.benchmarkDelta ?? 0) > 0.019);

    const small = evaluateRegistry([control, { ...candidate, benchmarkSamples: 5 }], POLICY);
    assert.equal(small.action, 'hold');

    const narrow = evaluateRegistry([control, { ...candidate, benchmarkScore: 0.805 }], POLICY);
    assert.equal(narrow.action, 'hold');
  });

  test('rolls back when production or benchmark drops below the rollback entry', () => {
    const control = entry({
      id: 'control',
      productionScore: 0.7,
      productionSamples: 40,
      benchmarkScore: 0.8,
      benchmarkSamples: 30,
    });
    const rollback = entry({
      id: 'rollback',
      modelId: 'paddle-v6-medium-old',
      role: 'rollback',
      percent: 0,
      productionScore: 0.85,
      productionSamples: 40,
      benchmarkScore: 0.82,
      benchmarkSamples: 30,
    });
    const result = evaluateRegistry([control, rollback], POLICY);
    assert.equal(result.action, 'rollback');
    assert.ok((result.productionDelta ?? 0) < -0.02);

    const benchmarkOnly = evaluateRegistry(
      [
        { ...control, productionScore: null, productionSamples: 0 },
        { ...rollback, productionScore: null, productionSamples: 0 },
      ],
      POLICY,
    );
    assert.equal(benchmarkOnly.action, 'rollback');

    const pinned = evaluateRegistry([{ ...control, auto: false }, rollback], POLICY);
    assert.equal(pinned.action, 'hold');
  });

  test('respects pinned entries, disabled automation and config bounds', () => {
    const control = entry({ benchmarkScore: 0.8, benchmarkSamples: 30, auto: false });
    const candidate = entry({
      role: 'candidate',
      percent: 20,
      benchmarkScore: 0.9,
      benchmarkSamples: 30,
    });
    assert.equal(evaluateRegistry([control, candidate], POLICY).action, 'hold');
    assert.equal(
      evaluateRegistry([control, { ...control, auto: true }, candidate], {
        ...POLICY,
        auto: false,
      }).action,
      'hold',
    );
    assert.equal(registryGreyConfig([control, candidate])?.percent, 20);
    assert.equal(registryActiveModel([control, candidate], 'paddle'), control.modelId);
    assert.equal(registryGreyConfig([control, { ...candidate, percent: 0 }]), null);
    assert.equal(normalizeRegistryPolicy({ minSamples: 0 }, {}).minSamples, 1);
    assert.equal(normalizeRegistryPolicy({ significance: 0.01 }, {}).significance, 0.01);
  });
});

describe('registry promotion significance', () => {
  test('computes exact two-sided McNemar p-values', () => {
    assert.equal(mcnemarExact(0, 0), 1);
    assert.equal(mcnemarExact(5, 5), 1);
    assert.equal(mcnemarExact(8, 7), 1);
    const decisive = mcnemarExact(12, 0);
    assert.ok(decisive > 0.0004 && decisive < 0.0006, `unexpected p=${decisive}`);
  });

  test('pairs per-file CER maps and counts wins, losses and ties', () => {
    const control = new Map([
      ['a', 0.1],
      ['b', 0.2],
      ['c', 0.3],
      ['d', 0.4],
    ]);
    const candidate = new Map([
      ['a', 0.05],
      ['b', 0.25],
      ['c', 0.3],
      ['e', 0.9],
    ]);
    const evidence = pairedBenchmarkSignificance(control, candidate);
    assert.equal(evidence.comparable, 3);
    assert.equal(evidence.wins, 1);
    assert.equal(evidence.losses, 1);
    assert.equal(evidence.ties, 1);
    assert.equal(evidence.significant, false);
    assert.equal(evidence.pValue, 1);
  });

  test('requires enough comparable, significant pairs before promoting', () => {
    const control = entry({ benchmarkScore: 0.8, benchmarkSamples: 30 });
    const candidate = entry({
      id: 'candidate',
      modelId: 'paddle-v6-server',
      role: 'candidate',
      percent: 20,
      benchmarkScore: 0.85,
      benchmarkSamples: 30,
    });
    const key = registryPairKey(candidate.engine, candidate.modelId, candidate.pipeline);

    const legacy = evaluateRegistry([control, candidate], POLICY);
    assert.equal(legacy.action, 'promote');
    assert.equal(legacy.benchmarkSignificance, null);

    const insufficient = evaluateRegistry([control, candidate], POLICY, {
      [key]: { wins: 6, losses: 0, ties: 0, comparable: 6, pValue: 0.03, significant: true },
    });
    assert.equal(insufficient.action, 'hold');
    assert.match(insufficient.reason, /配对可比较文件仅 6 份/);

    const ties = evaluateRegistry([control, candidate], POLICY, {
      [key]: { wins: 8, losses: 7, ties: 5, comparable: 20, pValue: 1, significant: false },
    });
    assert.equal(ties.action, 'hold');
    assert.match(ties.reason, /McNemar p=1/);

    const significant = evaluateRegistry([control, candidate], POLICY, {
      [key]: { wins: 12, losses: 0, ties: 8, comparable: 20, pValue: 0.0005, significant: true },
    });
    assert.equal(significant.action, 'promote');
    assert.equal(significant.benchmarkSignificance?.wins, 12);
    assert.match(significant.reason, /p=0\.0005/);

    const strict = evaluateRegistry(
      [control, candidate],
      { ...POLICY, significance: 0.0001 },
      {
        [key]: { wins: 12, losses: 0, ties: 8, comparable: 20, pValue: 0.0005, significant: true },
      },
    );
    assert.equal(strict.action, 'hold');
  });
});

describe('model registry store', () => {
  test('persists entries, derives grey config and appends decisions', () => {
    const db = new Database(':memory:');
    try {
      const store = new OcrRegistryStore(db);
      const control = store.register({
        engine: 'paddle',
        modelId: 'paddle-v6-medium',
      });
      assert.equal(control.role, 'control');
      const candidate = store.register({
        engine: 'paddle',
        modelId: 'paddle-v6-server',
        role: 'candidate',
        percent: 20,
      });
      const state = store.state();
      assert.equal(state.config?.percent, 20);
      assert.equal(state.config?.controlModelId, 'paddle-v6-medium');
      assert.equal(state.config?.candidateModelId, 'paddle-v6-server');
      assert.equal(store.activeModel('paddle'), 'paddle-v6-medium');

      store.decide({ id: candidate.id, action: 'percent', percent: 35 }, 'human');
      assert.equal(store.state().config?.percent, 35);
      const decisions = store.decisions();
      assert.equal(decisions[0]?.action, 'percent');
      assert.equal(decisions[0]?.actor, 'human');
      assert.equal(decisions[0]?.percent, 35);
      assert.equal(decisions[0]?.toRole, 'candidate');
    } finally {
      db.raw.close();
    }
  });

  test('automatically promotes a measured candidate and keeps the old control for rollback', () => {
    const db = new Database(':memory:');
    try {
      const store = new OcrRegistryStore(db);
      const control = store.register({
        engine: 'paddle',
        modelId: 'paddle-v6-medium',
        benchmarkScore: 0.8,
        benchmarkSamples: 30,
      });
      const candidate = store.register({
        engine: 'paddle',
        modelId: 'paddle-v6-server',
        role: 'candidate',
        percent: 20,
        benchmarkScore: 0.85,
        benchmarkSamples: 30,
      });
      const evaluation = store.evaluate();
      assert.equal(evaluation.action, 'promote');
      assert.equal(evaluation.applied, true);
      const state = store.state();
      assert.equal(state.control?.modelId, 'paddle-v6-server');
      assert.equal(state.rollback?.id, control.id);
      assert.equal(state.rollback?.role, 'rollback');
      assert.equal(state.config, null);
      assert.equal(store.activeModel('paddle'), 'paddle-v6-server');
      const decision = store.decisions()[0];
      assert.equal(decision?.action, 'promote');
      assert.equal(decision?.actor, 'auto');
      assert.equal(decision?.fromRole, 'candidate');
      assert.equal(decision?.toRole, 'control');
      assert.equal(candidate.role, 'candidate');
    } finally {
      db.raw.close();
    }
  });

  test('automatically rolls back to a better previous model and records the override', () => {
    const db = new Database(':memory:');
    try {
      const store = new OcrRegistryStore(db);
      const rollback = store.register({
        engine: 'paddle',
        modelId: 'paddle-v6-medium-old',
        role: 'rollback',
        productionScore: 0.9,
        productionSamples: 40,
        benchmarkScore: 0.84,
        benchmarkSamples: 30,
      });
      store.register({
        engine: 'paddle',
        modelId: 'paddle-v6-server',
        productionScore: 0.7,
        productionSamples: 40,
        benchmarkScore: 0.8,
        benchmarkSamples: 30,
      });
      const evaluation = store.evaluate();
      assert.equal(evaluation.action, 'rollback');
      assert.equal(evaluation.applied, true);
      const state = store.state();
      assert.equal(state.control?.id, rollback.id);
      assert.equal(store.decisions()[0]?.action, 'rollback');
      assert.equal(store.decisions()[0]?.actor, 'auto');
    } finally {
      db.raw.close();
    }
  });

  test('pins and unpins an entry through the decision log', () => {
    const db = new Database(':memory:');
    try {
      const store = new OcrRegistryStore(db);
      const control = store.register({
        engine: 'paddle',
        modelId: 'paddle-v6-medium',
      });
      const candidate = store.register({
        engine: 'paddle',
        modelId: 'paddle-v6-server',
        role: 'candidate',
        percent: 100,
      });
      assert.equal(candidate.percent, 99);
      store.decide({ id: control.id, action: 'pin', pin: true }, 'human');
      assert.equal(store.state().control?.auto, false);
      assert.equal(store.evaluate().action, 'hold');
      store.decide({ id: control.id, action: 'pin', pin: false }, 'human');
      assert.equal(store.state().control?.auto, true);
      const decisions = store.decisions();
      assert.equal(decisions[0]?.action, 'pin');
      assert.equal(decisions[0]?.reason, '恢复自动晋级/回滚');
    } finally {
      db.raw.close();
    }
  });

  test('syncs experiment summaries and allows a human pin to stop automation', () => {
    const db = new Database(':memory:');
    try {
      const store = new OcrRegistryStore(db);
      store.register({
        engine: 'paddle',
        modelId: 'paddle-v6-medium',
        benchmarkScore: 0.8,
        benchmarkSamples: 30,
        auto: false,
      });
      store.register({
        engine: 'paddle',
        modelId: 'paddle-v6-server',
        role: 'candidate',
        percent: 20,
        benchmarkScore: 0.8,
        benchmarkSamples: 30,
      });
      assert.equal(store.evaluate().action, 'hold');
      const updated = store.syncBenchmarks([
        {
          engine: 'paddle',
          modelId: 'paddle-v6-server',
          profile: null,
          score: 0.9,
          files: 30,
          failed: 0,
        },
      ]);
      assert.equal(updated, 1);
      const candidate = store.entries().find((item) => item.modelId === 'paddle-v6-server');
      assert.equal(candidate?.benchmarkScore, 0.9);
      assert.equal(candidate?.benchmarkSamples, 30);
      assert.equal(store.evaluate().action, 'hold');
    } finally {
      db.raw.close();
    }
  });

  test('records paired significance metrics when automation promotes', () => {
    const db = new Database(':memory:');
    try {
      const store = new OcrRegistryStore(db);
      store.register({
        engine: 'paddle',
        modelId: 'paddle-v6-medium',
        benchmarkScore: 0.8,
        benchmarkSamples: 30,
      });
      store.register({
        engine: 'paddle',
        modelId: 'paddle-v6-server',
        role: 'candidate',
        percent: 20,
        benchmarkScore: 0.85,
        benchmarkSamples: 30,
      });
      const key = registryPairKey('paddle', 'paddle-v6-server', '');
      const evaluation = store.evaluate(undefined, {
        [key]: { wins: 12, losses: 0, ties: 8, comparable: 20, pValue: 0.0005, significant: true },
      });
      assert.equal(evaluation.action, 'promote');
      const decision = store.decisions()[0];
      assert.equal(decision?.metrics.benchmarkWins, 12);
      assert.equal(decision?.metrics.benchmarkLosses, 0);
      assert.equal(decision?.metrics.benchmarkTies, 8);
      assert.equal(decision?.metrics.benchmarkPValue, 0.0005);
    } finally {
      db.raw.close();
    }
  });
});
