import type {
  OcrCalibrationSample,
  OcrThresholdDimension,
  OcrThresholdFitOptions,
  OcrThresholdProfile,
  OcrThresholdQuery,
} from '../../shared/types.ts';
import type { Database } from '../db.ts';
import { fitThresholdProfiles, selectThresholdProfile } from '../ocr-calibration.ts';

type ProfileRow = {
  id: string;
  dimension: OcrThresholdDimension;
  value: string;
  workspace_id: string;
  samples: number;
  effective_samples: number | null;
  positives: number;
  review_threshold: number;
  fail_threshold: number;
  key_field_confidence: number;
  precision: number | null;
  recall: number | null;
  false_review_rate: number | null;
  ece: number | null;
  calibrated_ece: number | null;
  confidence_map: string | null;
  brier: number | null;
  calibrated: number;
  created_at: string;
  updated_at: string;
};

function parseConfidenceMap(value: string | null): OcrThresholdProfile['confidenceMap'] {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    const points = parsed
      .map((item) => {
        if (typeof item !== 'object' || item === null) return null;
        const { raw, calibrated } = item as { raw?: unknown; calibrated?: unknown };
        return typeof raw === 'number' &&
          Number.isFinite(raw) &&
          typeof calibrated === 'number' &&
          Number.isFinite(calibrated)
          ? { raw, calibrated }
          : null;
      })
      .filter((item): item is { raw: number; calibrated: number } => item !== null);
    return points.length >= 2 ? points : null;
  } catch {
    return null;
  }
}

function optionalNumber(value: number | null): number | null {
  return value === null ? null : Number(value);
}

function toProfile(row: ProfileRow): OcrThresholdProfile {
  return {
    id: row.id,
    dimension: row.dimension,
    value: row.value,
    workspaceId: row.workspace_id === '' ? null : row.workspace_id,
    samples: Number(row.samples),
    effectiveSamples: row.effective_samples === null ? undefined : Number(row.effective_samples),
    positives: Number(row.positives),
    reviewThreshold: Number(row.review_threshold),
    failThreshold: Number(row.fail_threshold),
    keyFieldConfidence: Number(row.key_field_confidence),
    precision: optionalNumber(row.precision),
    recall: optionalNumber(row.recall),
    falseReviewRate: optionalNumber(row.false_review_rate),
    ece: optionalNumber(row.ece),
    calibratedEce: optionalNumber(row.calibrated_ece),
    confidenceMap: parseConfidenceMap(row.confidence_map),
    brier: optionalNumber(row.brier),
    calibrated: Number(row.calibrated) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function keyOf(profile: OcrThresholdProfile): string {
  return `${profile.dimension}:${profile.value}:${profile.workspaceId ?? ''}`;
}

export class OcrCalibrationStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  list(): OcrThresholdProfile[] {
    const rows = this.#db
      .stmt('SELECT * FROM ocr_threshold_profiles ORDER BY dimension, value, workspace_id')
      .all() as unknown as ProfileRow[];
    return rows.map(toProfile);
  }

  replace(profiles: readonly OcrThresholdProfile[]): void {
    const existing = new Map(this.list().map((profile) => [keyOf(profile), profile.createdAt]));
    const insert = this.#db.stmt(
      `INSERT INTO ocr_threshold_profiles
         (id, dimension, value, workspace_id, samples, effective_samples, positives, review_threshold,
          fail_threshold, key_field_confidence, precision, recall, false_review_rate,
          ece, calibrated_ece, confidence_map, brier, calibrated, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#db.transaction(() => {
      this.#db.stmt('DELETE FROM ocr_threshold_profiles').run();
      for (const profile of profiles) {
        insert.run(
          profile.id,
          profile.dimension,
          profile.value,
          profile.workspaceId ?? '',
          profile.samples,
          profile.effectiveSamples ?? null,
          profile.positives,
          profile.reviewThreshold,
          profile.failThreshold,
          profile.keyFieldConfidence,
          profile.precision,
          profile.recall,
          profile.falseReviewRate,
          profile.ece,
          profile.calibratedEce ?? null,
          profile.confidenceMap && profile.confidenceMap.length >= 2
            ? JSON.stringify(profile.confidenceMap)
            : null,
          profile.brier,
          profile.calibrated ? 1 : 0,
          existing.get(keyOf(profile)) ?? profile.createdAt,
          profile.updatedAt,
        );
      }
    });
  }

  fit(
    samples: readonly OcrCalibrationSample[],
    options: OcrThresholdFitOptions = {},
  ): OcrThresholdProfile[] {
    const profiles = fitThresholdProfiles(samples, options);
    if (profiles.length === 0) return [];
    this.replace(profiles);
    return this.list();
  }

  pick(query: OcrThresholdQuery): OcrThresholdProfile | null {
    return selectThresholdProfile(this.list(), query);
  }

  workspaceForProject(projectId: string): string | null {
    const row = this.#db
      .stmt('SELECT workspace_id FROM projects WHERE id = ?')
      .get(projectId) as unknown as { workspace_id: string | null } | undefined;
    return row?.workspace_id ?? null;
  }
}
