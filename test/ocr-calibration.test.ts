import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { OcrCalibrationSample } from '../shared/types.ts';
import { Database } from '../src/db.ts';
import {
  applyConfidenceMap,
  fitConfidenceMap,
  fitThresholdProfiles,
  selectThresholdProfile,
  thresholdsFromProfile,
} from '../src/ocr-calibration.ts';
import { OcrCalibrationStore } from '../src/stores/ocr-calibration.ts';

function sample(
  confidence: number,
  correct: boolean,
  extra: Partial<OcrCalibrationSample> = {},
): OcrCalibrationSample {
  return { confidence, correct, severe: !correct, ...extra };
}

function separatingSamples(extra: Partial<OcrCalibrationSample> = {}): OcrCalibrationSample[] {
  const wrong = Array.from({ length: 30 }, (_, index) =>
    sample(0.55 + index * 0.005, false, extra),
  );
  const right = Array.from({ length: 30 }, (_, index) => sample(0.8 + index * 0.005, true, extra));
  return [...wrong, ...right];
}

describe('threshold calibration', () => {
  test('fits a separating review threshold and a lower fail threshold', () => {
    const profiles = fitThresholdProfiles(separatingSamples());
    const overall = profiles.find((profile) => profile.dimension === 'overall');
    assert.ok(overall);
    assert.equal(overall.value, 'all');
    assert.equal(overall.calibrated, true);
    assert.equal(overall.samples, 60);
    assert.equal(overall.positives, 30);
    // The fitted map separates the two raw bands, so the calibrated cut-off is
    // near the bottom instead of the raw 0.6-0.8 gap.
    assert.ok(overall.reviewThreshold >= 0.05 && overall.reviewThreshold < 0.8);
    assert.ok(overall.failThreshold < overall.reviewThreshold);
    assert.ok((overall.recall ?? 0) > 0.95);
    assert.ok((overall.precision ?? 0) > 0.95);
    assert.ok((overall.ece ?? 0) > 0.2);
    assert.ok((overall.brier ?? 1) < 0.4);
  });

  test('fits per-dimension buckets that are large enough', () => {
    const samples = [
      ...separatingSamples({
        kind: 'invoice',
        language: 'zh',
        fileType: '.PDF',
        difficulty: 'easy',
      }),
      ...separatingSamples({ kind: 'image', language: 'en', fileType: 'png', difficulty: 'hard' }),
    ];
    const profiles = fitThresholdProfiles(samples);
    const dimensions = new Set(profiles.map((profile) => profile.dimension));
    assert.deepEqual([...dimensions].sort(), [
      'difficulty',
      'file_type',
      'kind',
      'language',
      'overall',
    ]);
    const invoice = profiles.find(
      (profile) => profile.dimension === 'kind' && profile.value === 'invoice',
    );
    assert.ok(invoice?.calibrated);
    assert.equal(profiles.find((profile) => profile.value === 'pdf')?.dimension, 'file_type');
  });

  test('marks small buckets as uncalibrated and skips them when selecting', () => {
    const samples = [...separatingSamples(), ...separatingSamples({ kind: 'receipt' }).slice(0, 2)];
    const profiles = fitThresholdProfiles(samples);
    const receipt = profiles.find(
      (profile) => profile.dimension === 'kind' && profile.value === 'receipt',
    );
    assert.ok(receipt);
    assert.equal(receipt.calibrated, false);
    assert.equal(selectThresholdProfile(profiles, { kind: 'invoice' })?.dimension, 'overall');
    assert.equal(selectThresholdProfile(profiles, { kind: 'receipt' })?.dimension, 'overall');
  });

  test('prefers the most specific calibrated dimension', () => {
    const samples = [
      ...separatingSamples({ kind: 'invoice' }),
      ...separatingSamples({ kind: 'image', fileType: 'png' }),
    ];
    const profiles = fitThresholdProfiles(samples);
    assert.equal(selectThresholdProfile(profiles, { kind: 'invoice' })?.dimension, 'kind');
    assert.equal(
      selectThresholdProfile(profiles, { kind: 'invoice', fileType: 'png' })?.dimension,
      'kind',
    );
    assert.equal(selectThresholdProfile(profiles, { fileType: 'png' })?.dimension, 'file_type');
  });

  test('keeps workspace buckets apart', () => {
    const samples = [
      ...separatingSamples({ workspaceId: 'ws_a' }),
      ...separatingSamples({ workspaceId: 'ws_b' }),
    ];
    const profiles = fitThresholdProfiles(samples);
    const workspaces = profiles.filter((profile) => profile.dimension === 'workspace');
    assert.equal(workspaces.length, 2);
    assert.ok(workspaces.every((profile) => profile.workspaceId === profile.value));
    assert.equal(selectThresholdProfile(profiles, { workspaceId: 'ws_b' })?.dimension, 'workspace');
  });

  test('returns no profiles for empty or invalid input', () => {
    assert.deepEqual(fitThresholdProfiles([]), []);
    assert.deepEqual(fitThresholdProfiles([sample(Number.NaN, true)]), []);
  });

  test('converts a profile into quality options', () => {
    const profile = fitThresholdProfiles(separatingSamples()).find(
      (entry) => entry.dimension === 'overall',
    );
    assert.ok(profile);
    assert.deepEqual(thresholdsFromProfile(profile), {
      reviewThreshold: profile.reviewThreshold,
      failThreshold: profile.failThreshold,
      keyFieldConfidence: profile.keyFieldConfidence,
      confidenceMap: profile.confidenceMap,
    });
    assert.deepEqual(thresholdsFromProfile(null), {});
  });

  test('fits a monotonic map that discounts optimistic confidence', () => {
    const samples = [
      ...Array.from({ length: 20 }, (_, index) => sample(0.6, index < 6)),
      ...Array.from({ length: 20 }, (_, index) => sample(0.95, index < 16)),
    ];
    const map = fitConfidenceMap(samples);
    assert.ok(map);
    assert.ok(map.length >= 2);
    for (let index = 1; index < map.length; index += 1) {
      assert.ok(map[index].calibrated + 1e-9 >= map[index - 1].calibrated);
      assert.ok(map[index].raw + 1e-9 >= map[index - 1].raw);
    }
    assert.ok((applyConfidenceMap(0.95, map) ?? 1) < 0.9);
    assert.ok((applyConfidenceMap(0.6, map) ?? 1) < 0.5);
    // Endpoints clamp instead of extrapolating.
    assert.equal(applyConfidenceMap(0, map), map[0].calibrated);
    assert.equal(applyConfidenceMap(1, map), map[map.length - 1].calibrated);
  });

  test('reports calibration before and after the map', () => {
    const samples = [
      ...Array.from({ length: 30 }, (_, index) => sample(0.6, index < 9)),
      ...Array.from({ length: 30 }, (_, index) => sample(0.95, index < 24)),
    ];
    const profile = fitThresholdProfiles(samples).find((entry) => entry.dimension === 'overall');
    assert.ok(profile);
    assert.ok(profile.confidenceMap && profile.confidenceMap.length >= 2);
    assert.ok((profile.ece ?? 0) > (profile.calibratedEce ?? 1));
    assert.ok((profile.calibratedEce ?? 1) < 0.05);
  });

  test('persists profiles and refreshes them on refit', () => {
    const db = new Database(':memory:');
    try {
      const store = new OcrCalibrationStore(db);
      const first = store.fit(separatingSamples({ fileType: 'pdf' }), {
        minSamples: 5,
        minPositives: 1,
      });
      assert.ok(first.length >= 2);
      assert.ok(first.some((profile) => profile.dimension === 'file_type'));
      const createdAt = first.find((profile) => profile.dimension === 'overall')?.createdAt;
      const picked = store.pick({ fileType: 'pdf' });
      assert.equal(picked?.dimension, 'file_type');
      assert.ok(picked?.confidenceMap && picked.confidenceMap.length >= 2);
      assert.ok((picked.calibratedEce ?? 1) >= 0);

      const second = store.fit(separatingSamples(), { minSamples: 5, minPositives: 1 });
      assert.ok(second.every((profile) => profile.dimension !== 'file_type'));
      assert.equal(second.find((profile) => profile.dimension === 'overall')?.createdAt, createdAt);
    } finally {
      db.raw.close();
    }
  });
});
