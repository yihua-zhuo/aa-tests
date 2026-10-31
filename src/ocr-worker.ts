import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import type { DocumentIr, DocumentQuality, OcrEngine, OcrRouteDecision } from '../shared/types.ts';
import { log } from './logger.ts';
import { type OcrClient, OcrClientError, type OcrExtraction, ocrConfigFingerprint } from './ocr.ts';
import { levenshtein, normalizeBenchText } from './ocr-bench.ts';
import { type ResolvedQualityThresholds, thresholdsFromProfile } from './ocr-calibration.ts';
import { recoveryYieldOutcomes, runOcrCascade } from './ocr-cascade.ts';
import { profileForModel, routeOcr } from './ocr-models.ts';
import { assessQuality } from './ocr-quality.ts';
import type { Store } from './store.ts';
import type { AttachmentRecord } from './stores/attachments.ts';

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 60_000;
const RECOVERY_GRACE_MS = 60_000;
const LEASE_MS = 120_000;
const HEARTBEAT_MS = 30_000;
const INTERRUPTED_MESSAGE = '上次识别被中断，已重新排队';
const DEFERRED_MESSAGE = '服务关闭，识别已暂停';
const SHADOW_COMPARE_CHARS = 20_000;

/** Bounded, whitespace-insensitive similarity used only to compare shadow traffic. */
function textSimilarity(left: string, right: string): number {
  const a = normalizeBenchText(left).slice(0, SHADOW_COMPARE_CHARS);
  const b = normalizeBenchText(right).slice(0, SHADOW_COMPARE_CHARS);
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  return Math.max(0, 1 - levenshtein(a, b) / Math.max(a.length, b.length));
}

export type OcrWorkerOptions = {
  intervalMs?: number;
  /** Restrict this worker to a subset of engines so they can run concurrently. */
  engines?: readonly OcrEngine[];
};

export class OcrWorker {
  readonly #store: Store;
  readonly #client: OcrClient;
  readonly #intervalMs: number;
  readonly #engines: OcrEngine[];
  readonly #abort = new AbortController();
  #timer: NodeJS.Timeout | null = null;
  #busy = false;
  #stopping = false;
  #recovered = false;
  #current: Promise<void> | null = null;
  #shadowBusy = false;
  readonly #shadows = new Set<Promise<void>>();

  constructor(store: Store, client: OcrClient, options: OcrWorkerOptions = {}) {
    this.#store = store;
    this.#client = client;
    this.#intervalMs = Math.max(options.intervalMs ?? 5_000, 1_000);
    this.#engines = (options.engines ?? client.engines).filter((engine) => client.supports(engine));
  }

  get engines(): readonly OcrEngine[] {
    return this.#engines;
  }

  start(): void {
    if (this.#timer || this.#stopping) return;
    this.#timer = setInterval(() => void this.tick(), this.#intervalMs);
    this.#timer.unref();
    void this.tick();
  }

  #logTickFailure(error: unknown): void {
    log('warn', 'ocr.tick_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  /** Stop polling, abort the in-flight request and wait for its requeue. */
  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#abort.abort();
    try {
      await this.#current;
    } catch (error) {
      log('warn', 'ocr.stop_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    await Promise.allSettled([...this.#shadows]);
  }

  async tick(): Promise<void> {
    if (this.#busy || this.#stopping) return;
    try {
      this.#recover();
    } catch (error) {
      this.#logTickFailure(error);
      return;
    }
    this.#busy = true;
    const run = (async () => {
      try {
        for (;;) {
          if (this.#stopping) return;
          const now = new Date();
          const record = this.#store.attachments.claimNext(
            now.toISOString(),
            this.#engines,
            new Date(now.getTime() + LEASE_MS).toISOString(),
          );
          if (!record) return;
          const heartbeat = setInterval(() => {
            try {
              this.#store.attachments.renewOcrLease(
                record.id,
                new Date(Date.now() + LEASE_MS).toISOString(),
              );
            } catch (error) {
              this.#logTickFailure(error);
            }
          }, HEARTBEAT_MS);
          heartbeat.unref();
          try {
            await this.#process(record);
          } finally {
            clearInterval(heartbeat);
          }
        }
      } catch (error) {
        this.#logTickFailure(error);
      } finally {
        this.#busy = false;
        this.#current = null;
      }
    })();
    this.#current = run;
    await run;
  }

  #recover(): void {
    if (this.#recovered) return;
    this.#recovered = true;
    const now = new Date();
    const cutoff = new Date(
      now.getTime() - this.#client.timeoutMs - RECOVERY_GRACE_MS,
    ).toISOString();
    const count = this.#store.attachments.recoverProcessing(
      cutoff,
      INTERRUPTED_MESSAGE,
      now.toISOString(),
    );
    if (count > 0) log('warn', 'ocr.recovered', { count, cutoff, engines: this.#engines });
  }

  /** Fitted review/fail cut-offs for this document, when a trusted profile exists. */
  #thresholds(record: AttachmentRecord): ResolvedQualityThresholds {
    try {
      const routing = routeOcr({
        name: record.name,
        engine: record.ocrEngine ?? 'paddle',
        mode: record.ocrMode,
      });
      return thresholdsFromProfile(
        this.#store.ocrCalibration.pick({
          fileType: extname(record.name),
          language: routing.language,
          workspaceId: this.#store.ocrCalibration.workspaceForProject(record.projectId),
        }),
      );
    } catch (error) {
      log('warn', 'ocr.threshold_lookup_failed', {
        attachmentId: record.id,
        message: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  }

  async #process(record: AttachmentRecord): Promise<void> {
    const engine = record.ocrEngine;
    if (!engine) {
      this.#store.attachments.failOcr(record.id, '附件缺少 OCR 引擎标识', new Date().toISOString());
      return;
    }

    const path = this.#store.uploads.resolvePath(record.storedName);
    if (!existsSync(path)) {
      this.#store.attachments.failOcr(record.id, '附件文件不存在', new Date().toISOString());
      log('warn', 'ocr.missing_file', { attachmentId: record.id, projectId: record.projectId });
      return;
    }

    const started = Date.now();
    const thresholds = this.#thresholds(record);
    const configHash = ocrConfigFingerprint();
    try {
      const engineModel = await this.#client.modelFor(engine);
      if (this.#stopping) {
        this.#defer(record);
        return;
      }

      if (!record.ocrForce && engineModel && record.sha256) {
        const reused = this.#store.attachments.findReusableOcr(
          record.sha256,
          engine,
          engineModel,
          configHash,
          record.ocrMode,
          record.ocrDpi,
          record.projectId,
        );
        if (reused) {
          // Re-score with the current thresholds instead of trusting a score
          // persisted before the config or quality heuristics changed.
          const quality = assessQuality(
            {
              text: reused.text,
              rawText: reused.rawText,
              engine: reused.model ?? engine,
              model: engineModel,
              confidence: reused.confidence,
              pages: reused.pages,
              truncated: false,
              route: reused.route,
              document: reused.document,
            },
            thresholds,
          );
          this.#store.attachments.completeOcr(
            record.id,
            {
              text: reused.text,
              rawText: reused.rawText,
              confidence: reused.confidence,
              model: reused.model,
              engineModel,
              configHash,
              seconds: reused.seconds,
              pages: reused.pages,
              truncated: false,
              route: reused.route,
              quality,
              stages: reused.stages,
              document: reused.document,
            },
            new Date().toISOString(),
          );
          this.#feedback(record, {
            text: reused.text,
            confidence: reused.confidence,
            quality,
            document: reused.document,
          });
          log('info', 'ocr.reused', {
            attachmentId: record.id,
            projectId: record.projectId,
            sourceId: reused.id,
            engine,
            engineModel,
          });
          return;
        }
      }

      const routing = routeOcr({
        name: record.name,
        engine,
        mode: record.ocrMode,
      });
      const grey = this.#store.ocrRegistry.greyPlanFor(record.id, engine);
      const profiles = engine === 'paddle' ? await this.#client.profilesFor(engine) : [];
      const fallbackModels = routing.fallbacks
        .map((id) => profileForModel(profiles, id))
        .filter((id): id is string => Boolean(id));
      const registeredModel =
        engine === 'paddle' ? this.#store.ocrRegistry.activeModel(engine) : null;
      let modelProfile: string | null = registeredModel
        ? profileForModel(profiles, registeredModel)
        : null;
      let shadowProfile: string | null = null;
      if (grey && engine === 'paddle') {
        if (grey.mode === 'rollback') {
          modelProfile = profileForModel(profiles, grey.modelId);
        } else if (grey.cohort === 'candidate') {
          const candidate = profileForModel(profiles, grey.candidateModelId);
          if (grey.mode === 'shadow') shadowProfile = candidate;
          else modelProfile = candidate;
        } else {
          modelProfile = profileForModel(profiles, grey.controlModelId);
        }
        if (
          (grey.mode === 'rollback' && !modelProfile) ||
          (grey.mode === 'canary' && grey.cohort === 'candidate' && !modelProfile) ||
          (grey.mode === 'shadow' && grey.cohort === 'candidate' && !shadowProfile)
        ) {
          log('warn', 'ocr.grey_profile_missing', {
            attachmentId: record.id,
            mode: grey.mode,
            cohort: grey.cohort,
            profiles,
            candidate: grey.candidateModelId,
            rollback: grey.rollbackModelId,
          });
        }
      }
      const cascade = await runOcrCascade(
        this.#client,
        engine,
        {
          path,
          name: record.name,
          mode: routing.mode,
          dpi: record.ocrDpi,
          lang: routing.language ?? undefined,
          model: modelProfile ?? undefined,
        },
        {
          signal: this.#abort.signal,
          fallbackModels: modelProfile
            ? fallbackModels.filter((id) => id !== modelProfile)
            : fallbackModels,
          candidateEngines: this.#client.candidatesFor(engine, record.name),
          recoveryYields: this.#store.ocrYields.load(),
          ...thresholds,
        },
      );
      this.#store.ocrYields.record(recoveryYieldOutcomes(cascade.stages));
      const extraction = cascade.extraction;
      const seconds = Math.max(0.1, Math.round((Date.now() - started) / 100) / 10);
      this.#store.attachments.completeOcr(
        record.id,
        {
          text: extraction.text,
          rawText: extraction.rawText ?? extraction.text,
          confidence: extraction.confidence,
          model: extraction.engine,
          engineModel: extraction.model,
          configHash,
          seconds,
          pages: extraction.pages,
          truncated: extraction.truncated,
          route: extraction.route,
          quality: cascade.quality,
          stages: cascade.stages,
          document: extraction.document,
        },
        new Date().toISOString(),
      );
      this.#feedback(record, {
        text: extraction.text,
        confidence: extraction.confidence,
        quality: cascade.quality,
        document: extraction.document,
      });
      log('info', 'ocr.completed', {
        attachmentId: record.id,
        projectId: record.projectId,
        engine: extraction.engine,
        engineModel: extraction.model,
        characters: extraction.text.length,
        confidence: extraction.confidence,
        pages: extraction.pages,
        truncated: extraction.truncated,
        mode: record.ocrMode,
        dpi: record.ocrDpi,
        route: extraction.route,
        routedMode: routing.mode,
        routedModel: routing.modelId,
        routedLang: routing.language,
        routingReasons: routing.reasons.map((reason) => reason.code),
        quality: cascade.quality.score,
        qualityStatus: cascade.quality.status,
        stages: cascade.stages.length,
        seconds,
        greyMode: grey?.mode ?? null,
        greyCohort: grey?.cohort ?? null,
        greyModel: modelProfile,
        registeredModel,
      });
      if (shadowProfile) {
        this.#shadow(record, engine, path, routing, shadowProfile, extraction, seconds);
      }
    } catch (error) {
      if (this.#stopping) {
        this.#defer(record);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const now = new Date();
      const permanent = error instanceof OcrClientError && error.permanent;
      if (permanent || record.ocrAttempts >= MAX_ATTEMPTS) {
        this.#store.attachments.failOcr(record.id, message.slice(0, 500), now.toISOString());
        log('warn', 'ocr.failed', {
          attachmentId: record.id,
          projectId: record.projectId,
          attempts: record.ocrAttempts,
          message,
        });
        return;
      }
      const nextAttemptAt = new Date(
        now.getTime() + RETRY_BASE_MS * record.ocrAttempts,
      ).toISOString();
      this.#store.attachments.retryOcr(
        record.id,
        message.slice(0, 500),
        nextAttemptAt,
        now.toISOString(),
      );
      log('warn', 'ocr.retry', {
        attachmentId: record.id,
        projectId: record.projectId,
        attempts: record.ocrAttempts,
        nextAttemptAt,
        message,
      });
    }
  }

  /**
   * Error-sample auto-return. Feedback ingestion must never break the OCR
   * pipeline, so failures are logged and swallowed.
   */
  #feedback(
    record: AttachmentRecord,
    result: {
      text: string;
      confidence: number | null;
      quality: DocumentQuality | null;
      document: DocumentIr | null;
    },
  ): void {
    try {
      const inserted = this.#store.ocrGovernance.completeOcrFeedback({
        attachmentId: record.id,
        projectId: record.projectId,
        sha256: record.sha256,
        name: record.name,
        mime: record.mime,
        text: result.text,
        confidence: result.confidence,
        quality: result.quality,
        document: result.document,
        now: new Date().toISOString(),
      });
      if (inserted > 0) {
        log('info', 'ocr.feedback_returned', { attachmentId: record.id, inserted });
      }
    } catch (error) {
      log('warn', 'ocr.feedback_failed', {
        attachmentId: record.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Shadow traffic: run the candidate model after the control result is saved.
   * It never changes the stored text; only a similarity/cost record is logged.
   */
  #shadow(
    record: AttachmentRecord,
    engine: OcrEngine,
    path: string,
    routing: OcrRouteDecision,
    profile: string,
    control: OcrExtraction,
    controlSeconds: number,
  ): void {
    if (this.#shadowBusy) {
      log('info', 'ocr.grey_shadow_skipped', {
        attachmentId: record.id,
        profile,
        reason: '已有影子任务在运行',
      });
      return;
    }
    this.#shadowBusy = true;
    const run = (async () => {
      const started = Date.now();
      try {
        const result = await this.#client.extract(
          engine,
          {
            path,
            name: record.name,
            mode: routing.mode,
            dpi: record.ocrDpi,
            lang: routing.language ?? undefined,
            model: profile,
          },
          this.#abort.signal,
        );
        const seconds = Math.max(0.1, Math.round((Date.now() - started) / 100) / 10);
        log('info', 'ocr.grey_shadow', {
          attachmentId: record.id,
          profile,
          model: result.model,
          similarity: Math.round(textSimilarity(control.text, result.text) * 10_000) / 10_000,
          controlCharacters: control.text.length,
          candidateCharacters: result.text.length,
          controlSeconds,
          candidateSeconds: seconds,
        });
      } catch (error) {
        if (this.#abort.signal.aborted) return;
        log('warn', 'ocr.grey_shadow_failed', {
          attachmentId: record.id,
          profile,
          message: error instanceof Error ? error.message.slice(0, 200) : String(error),
        });
      }
    })();
    this.#shadows.add(run);
    void run
      .finally(() => {
        this.#shadowBusy = false;
        this.#shadows.delete(run);
      })
      .catch(() => undefined);
  }

  #defer(record: AttachmentRecord): void {
    const now = new Date().toISOString();
    this.#store.attachments.deferOcr(record.id, DEFERRED_MESSAGE, now);
    log('info', 'ocr.deferred', {
      attachmentId: record.id,
      projectId: record.projectId,
      engine: record.ocrEngine,
    });
  }
}
