import { createHash, randomUUID } from 'node:crypto';
import type {
  DocumentFieldKind,
  OcrAnnotationReliability,
  OcrCalibrationSample,
  OcrFieldRevision,
  OcrRevisionQcItem,
  OcrRevisionQcStats,
  OcrRevisionReview,
  OcrRevisionReviewVerdict,
  UserOption,
} from '../../shared/types.ts';
import type { Database } from '../db.ts';
import { rateOf, wilsonInterval } from '../stats.ts';

type ReviewRow = {
  id: string;
  revision_id: string;
  verdict: string;
  value: string | null;
  note: string | null;
  reviewed_by: string | null;
  reviewed_by_name: string | null;
  created_at: string;
};

type RevisionRow = {
  revision_id: string;
  attachment_id: string;
  project_id: string;
  field_id: string;
  field_kind: string;
  page: number;
  block_id: string | null;
  original_text: string;
  revised_text: string;
  reason: string;
  revised_by: string | null;
  revised_by_name: string | null;
  created_at: string;
  attachment_name: string;
  project_name: string | null;
  workspace_id: string | null;
  confidence: number | null;
};

const SELECT_REVISIONS = `SELECT r.id AS revision_id, r.attachment_id, r.project_id, r.field_id,
       r.field_kind, r.page, r.block_id, r.original_text, r.revised_text, r.reason,
       r.revised_by, r.revised_by_name, r.created_at,
       a.name AS attachment_name, a.ocr_confidence AS confidence,
       p.name AS project_name, p.workspace_id
  FROM ocr_field_revisions r
  JOIN attachments a ON a.id = r.attachment_id
  LEFT JOIN projects p ON p.id = r.project_id`;

function toReview(row: ReviewRow): OcrRevisionReview {
  return {
    id: row.id,
    revisionId: row.revision_id,
    verdict: row.verdict as OcrRevisionReviewVerdict,
    value: row.value,
    note: row.note,
    reviewedBy:
      row.reviewed_by || row.reviewed_by_name
        ? { id: row.reviewed_by ?? '', name: row.reviewed_by_name ?? '' }
        : null,
    createdAt: row.created_at,
  };
}

function toRevision(row: RevisionRow): OcrFieldRevision {
  return {
    id: row.revision_id,
    attachmentId: row.attachment_id,
    projectId: row.project_id,
    fieldId: row.field_id,
    fieldKind: row.field_kind as DocumentFieldKind,
    page: Number(row.page),
    blockId: row.block_id,
    bbox: null,
    originalText: row.original_text,
    revisedText: row.revised_text,
    reason: row.reason,
    revisedBy:
      row.revised_by || row.revised_by_name
        ? { id: row.revised_by ?? '', name: row.revised_by_name ?? '' }
        : null,
    createdAt: row.created_at,
  };
}

function trim(value: string | null | undefined): string {
  return (value ?? '').trim();
}

function docTypeOf(name: string): string {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(name);
  return match ? match[1].toLowerCase() : 'other';
}

/**
 * Where a revision stands after its second opinions. An arbitration settles a
 * dispute and outranks everything else; a confirmation outranks a dissent. The
 * final value is the label to keep, or null while reviewers disagree.
 */
export function reliabilityOf(
  revision: Pick<OcrFieldRevision, 'revisedText'>,
  reviews: readonly OcrRevisionReview[],
): { reliability: OcrAnnotationReliability; value: string | null } {
  const arbitration = reviews.find(
    (review) => review.verdict === 'arbitrate' && trim(review.value) !== '',
  );
  if (arbitration?.value) return { reliability: 'arbitrated', value: arbitration.value };
  if (reviews.some((review) => review.verdict === 'confirm')) {
    return { reliability: 'double_confirmed', value: revision.revisedText };
  }
  if (reviews.some((review) => review.verdict === 'revise')) {
    return { reliability: 'disputed', value: null };
  }
  return { reliability: 'single_reviewer', value: revision.revisedText };
}

/**
 * Human revisions are labels, and labels are noisy: whoever corrects a field can
 * be wrong, and two reviewers can disagree. This store keeps a second opinion
 * per revision, refuses a self-review, reports the disagreement rate per
 * reviewer, and hands reliability-graded labels to threshold fitting.
 */
export class OcrRevisionReviewStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Stable queue order so a rerun asks about the same revisions. */
  static orderKey(revisionId: string, salt: string): string {
    return createHash('sha256').update(`${salt}|${revisionId}`).digest('hex');
  }

  reviewsFor(revisionIds: readonly string[]): Map<string, OcrRevisionReview[]> {
    const result = new Map<string, OcrRevisionReview[]>();
    const unique = [...new Set(revisionIds)];
    // Stay below SQLite's bound-parameter ceiling for large windows.
    for (let start = 0; start < unique.length; start += 500) {
      const chunk = unique.slice(start, start + 500);
      const rows = this.#db
        .stmt(
          `SELECT id, revision_id, verdict, value, note, reviewed_by, reviewed_by_name, created_at
             FROM ocr_revision_reviews
            WHERE revision_id IN (${chunk.map(() => '?').join(', ')})
            ORDER BY created_at ASC, rowid ASC`,
        )
        .all(...chunk) as unknown as ReviewRow[];
      for (const row of rows) {
        const list = result.get(row.revision_id);
        if (list) list.push(toReview(row));
        else result.set(row.revision_id, [toReview(row)]);
      }
    }
    return result;
  }

  #items(projectId?: string): OcrRevisionQcItem[] {
    const where = projectId ? 'WHERE r.project_id = ?' : '';
    const rows = this.#db
      .stmt(`${SELECT_REVISIONS} ${where} ORDER BY r.created_at DESC, r.rowid DESC`)
      .all(...(projectId ? [projectId] : [])) as unknown as RevisionRow[];
    const reviews = this.reviewsFor(rows.map((row) => row.revision_id));
    return rows.map((row) => {
      const revision = toRevision(row);
      const list = reviews.get(revision.id) ?? [];
      const { reliability } = reliabilityOf(revision, list);
      return {
        revision,
        attachmentName: row.attachment_name,
        projectName: row.project_name,
        reliability,
        reviews: list,
        needsArbitration: reliability === 'disputed',
      };
    });
  }

  list(input: { projectId?: string; limit?: number } = {}): OcrRevisionQcItem[] {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    return this.#items(input.projectId).slice(0, limit);
  }

  /**
   * Revisions worth a second opinion: unresolved disputes first (they block the
   * label from being used at all), then samples nobody has confirmed yet, in a
   * hash order that survives a rerun.
   */
  queue(input: { projectId?: string; limit?: number } = {}): OcrRevisionQcItem[] {
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 200);
    const salt = process.env.OCR_REVISION_QC_SALT?.trim() || 'v1';
    const items = this.#items(input.projectId);
    const disputes = items.filter((item) => item.needsArbitration);
    const unconfirmed = items
      .filter((item) => item.reviews.length === 0)
      .sort((left, right) =>
        OcrRevisionReviewStore.orderKey(left.revision.id, salt).localeCompare(
          OcrRevisionReviewStore.orderKey(right.revision.id, salt),
        ),
      );
    return [...disputes, ...unconfirmed].slice(0, limit);
  }

  find(revisionId: string): OcrRevisionQcItem | null {
    return this.#items().find((item) => item.revision.id === revisionId) ?? null;
  }

  /**
   * Record a second opinion. The reviser cannot vouch for their own label, and
   * one reviewer gets exactly one verdict per revision.
   */
  record(
    revisionId: string,
    verdict: OcrRevisionReviewVerdict,
    actor: UserOption,
    now: string,
    options: { value?: string | null; note?: string | null } = {},
  ): OcrRevisionQcItem | null | 'self' | 'duplicate' | 'missing' | 'needs_value' {
    const row = this.#db.stmt(`${SELECT_REVISIONS} WHERE r.id = ?`).get(revisionId) as unknown as
      | RevisionRow
      | undefined;
    if (!row) return 'missing';
    if (row.revised_by === actor.id) return 'self';
    const existing = this.#db
      .stmt('SELECT id FROM ocr_revision_reviews WHERE revision_id = ? AND reviewed_by = ?')
      .get(revisionId, actor.id) as unknown as { id: string } | undefined;
    if (existing) return 'duplicate';
    const value = verdict === 'confirm' ? null : trim(options.value);
    // Dissenting without saying what the field should read is not a label.
    if (verdict !== 'confirm' && value === '') return 'needs_value';
    this.#db
      .stmt(
        `INSERT INTO ocr_revision_reviews
           (id, revision_id, verdict, value, note, reviewed_by, reviewed_by_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        revisionId,
        verdict,
        value === '' ? null : value,
        trim(options.note) || null,
        actor.id,
        actor.name,
        now,
      );
    return this.find(revisionId);
  }

  stats(input: { projectId?: string } = {}): OcrRevisionQcStats {
    const items = this.#items(input.projectId);
    const byReviewer = new Map<
      string,
      { reviewer: UserOption | null; reviewed: number; confirmed: number; revised: number }
    >();
    const mix = { doubleConfirmed: 0, singleReviewer: 0, disputed: 0 };
    const gradeCount = { reviewed: 0, arbitrated: 0, doubleConfirmed: 0, disputed: 0 };
    let disagreements = 0;
    let judgeable = 0;
    for (const item of items) {
      if (item.reviews.length > 0) gradeCount.reviewed += 1;
      if (item.reliability === 'arbitrated') gradeCount.arbitrated += 1;
      if (item.reliability === 'double_confirmed') gradeCount.doubleConfirmed += 1;
      if (item.needsArbitration) gradeCount.disputed += 1;
      if (item.reliability === 'double_confirmed' || item.reliability === 'arbitrated') {
        mix.doubleConfirmed += 1;
      } else if (item.reliability === 'disputed') mix.disputed += 1;
      else mix.singleReviewer += 1;
      for (const review of item.reviews) {
        // An arbitration settles a dispute; it is not a disagreement score.
        if (review.verdict !== 'arbitrate') judgeable += 1;
        if (review.verdict === 'revise') disagreements += 1;
        if (review.verdict === 'arbitrate') continue;
        const key = review.reviewedBy?.id || review.reviewedBy?.name || '';
        const bucket = byReviewer.get(key) ?? {
          reviewer: review.reviewedBy,
          reviewed: 0,
          confirmed: 0,
          revised: 0,
        };
        bucket.reviewed += 1;
        if (review.verdict === 'confirm') bucket.confirmed += 1;
        else bucket.revised += 1;
        byReviewer.set(key, bucket);
      }
    }
    return {
      revisions: items.length,
      reviewed: gradeCount.reviewed,
      unreviewed: items.length - gradeCount.reviewed,
      doubleConfirmed: gradeCount.doubleConfirmed,
      arbitrated: gradeCount.arbitrated,
      disputed: gradeCount.disputed,
      disagreementRate: rateOf(disagreements, judgeable),
      interval: wilsonInterval(disagreements, judgeable),
      coverage: rateOf(gradeCount.reviewed, items.length),
      byReviewer: [...byReviewer.values()]
        .map((bucket) => ({
          reviewerId: bucket.reviewer?.id ?? null,
          reviewerName: bucket.reviewer?.name || '未知',
          reviewed: bucket.reviewed,
          confirmed: bucket.confirmed,
          revised: bucket.revised,
          agreementRate: rateOf(bucket.confirmed, bucket.confirmed + bucket.revised),
        }))
        .sort(
          (left, right) =>
            right.reviewed - left.reviewed || left.reviewerName.localeCompare(right.reviewerName),
        ),
      annotationMix: mix,
    };
  }

  /**
   * Revision labels as calibration input. A confirmed correction proves the
   * automatic pass was wrong; a correction replaced by the model's own text
   * proves it was right. Disputed labels teach nothing and are dropped here,
   * while unconfirmed ones are down-weighted by the caller.
   */
  calibrationSamples(): OcrCalibrationSample[] {
    const rows = this.#db.stmt(SELECT_REVISIONS).all() as unknown as RevisionRow[];
    const reviews = this.reviewsFor(rows.map((row) => row.revision_id));
    const byAttachment = new Map<
      string,
      { first: RevisionRow; grades: OcrAnnotationReliability[]; wrong: boolean; right: boolean }
    >();
    for (const row of rows) {
      if (row.confidence === null) continue;
      const revision = toRevision(row);
      const grade = reliabilityOf(revision, reviews.get(revision.id) ?? []);
      if (grade.reliability === 'disputed' || grade.value === null) continue;
      const bucket = byAttachment.get(row.attachment_id) ?? {
        first: row,
        grades: [],
        wrong: false,
        right: false,
      };
      bucket.grades.push(grade.reliability);
      // A final value equal to the model output means the revision was the error.
      if (trim(grade.value) === trim(row.original_text)) bucket.right = true;
      else bucket.wrong = true;
      byAttachment.set(row.attachment_id, bucket);
    }
    const samples: OcrCalibrationSample[] = [];
    for (const bucket of byAttachment.values()) {
      const reliability: OcrAnnotationReliability = bucket.grades.includes('single_reviewer')
        ? 'single_reviewer'
        : bucket.grades.includes('double_confirmed')
          ? 'double_confirmed'
          : 'arbitrated';
      samples.push({
        confidence: Number(bucket.first.confidence),
        // A confirmed correction outranks a rejected one: the document did hold
        // an error that the automatic pass missed.
        correct: !bucket.wrong,
        severe: bucket.wrong,
        kind: docTypeOf(bucket.first.attachment_name),
        difficulty: null,
        language: null,
        fileType: docTypeOf(bucket.first.attachment_name),
        workspaceId: bucket.first.workspace_id,
        annotation: reliability,
      });
    }
    return samples;
  }
}
