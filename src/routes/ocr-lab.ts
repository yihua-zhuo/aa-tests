import { Hono } from 'hono';
import { canManageWorkspace } from '../../shared/permissions.ts';
import type {
  DocumentBBox,
  OcrCalibrationSample,
  OcrStageKind,
  OcrStageReplayTarget,
  OcrThresholdFitOptions,
} from '../../shared/types.ts';
import type { AppEnv } from '../app-env.ts';
import { forbidden, noStore, validationError } from '../http.ts';
import { currentUser } from '../middleware/auth.ts';
import type { OcrBench } from '../ocr-bench.ts';
import type { OcrExperimentRequest } from '../ocr-experiments.ts';

const REPLAYABLE_STAGES = new Set<OcrStageKind>([
  'native',
  'visual',
  'recovery_dpi',
  'recovery_structure',
  'recovery_enhance',
  'recovery_region',
  'recovery_cell',
  'candidate',
  'vlm',
  'specialized',
]);

function isBBox(value: unknown): value is DocumentBBox {
  if (!value || typeof value !== 'object') return false;
  const box = value as Record<string, unknown>;
  return (
    typeof box.x === 'number' &&
    Number.isFinite(box.x) &&
    typeof box.y === 'number' &&
    Number.isFinite(box.y) &&
    typeof box.width === 'number' &&
    Number.isFinite(box.width) &&
    box.width > 0 &&
    typeof box.height === 'number' &&
    Number.isFinite(box.height) &&
    box.height > 0
  );
}

function isCalibrationSample(value: unknown): value is OcrCalibrationSample {
  if (!value || typeof value !== 'object') return false;
  const sample = value as Record<string, unknown>;
  const optionalString = (key: string) =>
    sample[key] === undefined || sample[key] === null || typeof sample[key] === 'string';
  return (
    typeof sample.confidence === 'number' &&
    Number.isFinite(sample.confidence) &&
    sample.confidence >= 0 &&
    sample.confidence <= 1 &&
    typeof sample.correct === 'boolean' &&
    typeof sample.severe === 'boolean' &&
    optionalString('kind') &&
    optionalString('difficulty') &&
    optionalString('language') &&
    optionalString('fileType') &&
    optionalString('workspaceId')
  );
}

/** Calibration replaces global thresholds, so a single sample must not fit it. */
const MIN_CALIBRATION_SAMPLES = 5;
const MIN_CALIBRATION_POSITIVES = 2;

function fitOptions(value: unknown): OcrThresholdFitOptions | string {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object') return 'options 必须是对象';
  const input = value as Record<string, unknown>;
  const result: OcrThresholdFitOptions = {};
  if (input.minSamples !== undefined) {
    if (!Number.isInteger(input.minSamples) || Number(input.minSamples) < MIN_CALIBRATION_SAMPLES) {
      return `options.minSamples 必须是不小于 ${MIN_CALIBRATION_SAMPLES} 的整数`;
    }
    result.minSamples = Number(input.minSamples);
  }
  if (input.minPositives !== undefined) {
    if (
      !Number.isInteger(input.minPositives) ||
      Number(input.minPositives) < MIN_CALIBRATION_POSITIVES
    ) {
      return `options.minPositives 必须是不小于 ${MIN_CALIBRATION_POSITIVES} 的整数`;
    }
    result.minPositives = Number(input.minPositives);
  }
  for (const key of ['keyFieldTarget', 'failTarget'] as const) {
    const raw = input[key];
    if (raw === undefined) continue;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0.5 || raw > 1) {
      return `options.${key} 必须是 0.5 到 1 之间的数字`;
    }
    result[key] = raw;
  }
  return result;
}

export function ocrLabRoutes(lab: OcrBench | undefined): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const unavailable = {
    available: false,
    corpusDir: '',
    models: {},
    files: [],
    run: null,
    aggregate: null,
    thresholds: [],
    history: [],
  };

  app.get('/api/ocr/lab', async (c) => {
    const user = currentUser(c);
    if (!canManageWorkspace(user.role, user.permissions)) {
      return forbidden(c, '只有工作区管理员可以运行 OCR 基准');
    }
    noStore(c);
    return c.json(lab ? await lab.status() : unavailable);
  });

  app.post('/api/ocr/lab/run', async (c) => {
    const user = currentUser(c);
    if (!canManageWorkspace(user.role, user.permissions)) {
      return forbidden(c, '只有工作区管理员可以运行 OCR 基准');
    }
    if (!lab) return c.json(unavailable);

    const body = (await c.req.json().catch(() => ({}))) as { includePdf?: unknown };
    if (body.includePdf !== undefined && typeof body.includePdf !== 'boolean') {
      return validationError(c, 'includePdf 必须是布尔值');
    }
    try {
      noStore(c);
      return c.json(await lab.start(body.includePdf !== false));
    } catch (error) {
      return c.json(
        { error: 'conflict', message: error instanceof Error ? error.message : '无法启动基准测试' },
        409,
      );
    }
  });

  app.post('/api/ocr/lab/replay', async (c) => {
    const user = currentUser(c);
    if (!canManageWorkspace(user.role, user.permissions)) {
      return forbidden(c, '只有工作区管理员可以重放 OCR 阶段');
    }
    if (!lab) return c.json(unavailable);

    const body = (await c.req.json().catch(() => ({}))) as {
      name?: unknown;
      kind?: unknown;
      occurrence?: unknown;
      page?: unknown;
      bbox?: unknown;
      padding?: unknown;
    };
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      return validationError(c, 'name 必须是非空字符串');
    }
    if (typeof body.kind !== 'string' || !REPLAYABLE_STAGES.has(body.kind as OcrStageKind)) {
      return validationError(c, 'kind 不是可重放的 OCR 阶段');
    }
    if (
      body.occurrence !== undefined &&
      (!Number.isInteger(body.occurrence) || Number(body.occurrence) < 1)
    ) {
      return validationError(c, 'occurrence 必须是正整数');
    }
    if (
      body.page !== undefined &&
      body.page !== null &&
      (!Number.isInteger(body.page) || Number(body.page) < 1)
    ) {
      return validationError(c, 'page 必须是正整数');
    }
    if (body.bbox !== undefined && body.bbox !== null && !isBBox(body.bbox)) {
      return validationError(c, 'bbox 必须包含有限的 x/y/width/height 且宽高大于 0');
    }
    if (
      body.padding !== undefined &&
      (typeof body.padding !== 'number' ||
        !Number.isFinite(body.padding) ||
        body.padding < 0 ||
        body.padding > 5)
    ) {
      return validationError(c, 'padding 必须是 0 到 5 之间的数字');
    }

    const target: OcrStageReplayTarget = {
      kind: body.kind as OcrStageKind,
      occurrence: body.occurrence as number | undefined,
      page: body.page as number | null | undefined,
      bbox: body.bbox as DocumentBBox | null | undefined,
      padding: body.padding as number | undefined,
    };
    try {
      noStore(c);
      return c.json(await lab.replay(body.name.trim(), target));
    } catch (error) {
      return c.json(
        {
          error: 'unprocessable',
          message: error instanceof Error ? error.message : '无法重放该阶段',
        },
        422,
      );
    }
  });

  app.get('/api/ocr/lab/experiment', async (c) => {
    const user = currentUser(c);
    if (!canManageWorkspace(user.role, user.permissions)) {
      return forbidden(c, '只有工作区管理员可以查看 OCR 实验');
    }
    noStore(c);
    return c.json(lab ? lab.experimentStatus() : null);
  });

  app.post('/api/ocr/lab/experiment', async (c) => {
    const user = currentUser(c);
    if (!canManageWorkspace(user.role, user.permissions)) {
      return forbidden(c, '只有工作区管理员可以运行 OCR 实验');
    }
    if (!lab) return c.json({ error: 'unavailable', message: '未配置 OCR 基准' }, 409);

    const body = (await c.req.json().catch(() => ({}))) as Partial<OcrExperimentRequest>;
    try {
      noStore(c);
      return c.json(await lab.startExperiment(body as OcrExperimentRequest));
    } catch (error) {
      return c.json(
        { error: 'conflict', message: error instanceof Error ? error.message : '无法启动实验' },
        409,
      );
    }
  });

  app.get('/api/ocr/calibration', async (c) => {
    const user = currentUser(c);
    if (!canManageWorkspace(user.role, user.permissions)) {
      return forbidden(c, '只有工作区管理员可以查看 OCR 阈值');
    }
    noStore(c);
    return c.json({ profiles: lab ? lab.thresholds() : [] });
  });

  app.post('/api/ocr/calibration/fit', async (c) => {
    const user = currentUser(c);
    if (!canManageWorkspace(user.role, user.permissions)) {
      return forbidden(c, '只有工作区管理员可以拟合 OCR 阈值');
    }
    if (!lab) return c.json({ error: 'unavailable', message: '未配置 OCR 基准' }, 409);

    const body = (await c.req.json().catch(() => ({}))) as {
      options?: unknown;
      samples?: unknown;
    };
    const options = fitOptions(body.options);
    if (typeof options === 'string') return validationError(c, options);
    let samples: OcrCalibrationSample[] | undefined;
    if (body.samples !== undefined) {
      if (!Array.isArray(body.samples) || body.samples.length === 0) {
        return validationError(c, 'samples 必须是非空数组');
      }
      if (body.samples.length > 10_000) {
        return validationError(c, 'samples 不能超过 10000 条');
      }
      if (!body.samples.every(isCalibrationSample)) {
        return validationError(c, 'samples 包含无效的校准样本');
      }
      if (body.samples.length < MIN_CALIBRATION_SAMPLES) {
        return validationError(c, `samples 至少需要 ${MIN_CALIBRATION_SAMPLES} 条才能拟合阈值`);
      }
      const foreign = body.samples.find(
        (sample) => sample.workspaceId && sample.workspaceId !== user.workspaceId,
      );
      if (foreign) {
        return forbidden(c, '只能为当前工作区拟合 OCR 阈值');
      }
      samples = body.samples;
    }
    try {
      noStore(c);
      const profiles = lab.fitThresholds(options, samples, { id: user.id, name: user.name });
      return c.json({ profiles });
    } catch (error) {
      return c.json(
        {
          error: 'unprocessable',
          message: error instanceof Error ? error.message : '无法拟合 OCR 阈值',
        },
        422,
      );
    }
  });

  return app;
}
