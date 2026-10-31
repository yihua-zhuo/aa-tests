import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  greyConfig,
  greyPlan,
  MODEL_CAPABILITIES,
  modelById,
  profileScript,
  routeOcr,
} from '../src/ocr-models.ts';

describe('OCR script profiling', () => {
  test('detects mixed Chinese/Latin and keeps the Chinese recognizer', () => {
    const profile = profileScript('中文 Report 2024 Q1');
    assert.equal(profile.dominant, 'latin');
    assert.equal(profile.mixed, true);
    assert.equal(profile.language, 'ch');
    assert.ok(profile.scripts.some((entry) => entry.script === 'han'));
    assert.ok(profile.scripts.some((entry) => entry.script === 'latin'));
    assert.equal(profile.digits, 5);
  });

  test('routes Kana, Hangul, Arabic and Cyrillic to their own hints', () => {
    assert.equal(profileScript('請求書の合計は 1,200 円です').language, 'japan');
    assert.equal(profileScript('영수증 합계 1200원').language, 'korean');
    assert.equal(profileScript('فاتورة المجموع 1200').language, 'arabic');
    assert.equal(profileScript('Счёт итого 1200').language, 'ru');
    assert.equal(profileScript('Invoice total 1200').language, 'en');
  });

  test('numeric density is measured over non-space characters', () => {
    const profile = profileScript('合计 ¥1,280.00 / 3 件');
    assert.ok(profile.numericRatio > 0.4);
    assert.equal(profile.language, 'ch');
  });
});

describe('OCR model routing', () => {
  test('explicit mode wins and table mode selects the structure pipeline', () => {
    const decision = routeOcr({ name: 'report.pdf', lang: 'zh', mode: 'table' });
    assert.equal(decision.mode, 'table');
    assert.equal(decision.explicit, true);
    assert.equal(decision.modelId, 'paddle-structure-v3');
    assert.equal(decision.language, 'ch');
    assert.ok(decision.reasons.some((reason) => reason.code === 'explicit_mode'));
  });

  test('declared language selects a script-specific model with reasons', () => {
    const decision = routeOcr({ name: 'scan.png', lang: 'ja', mode: 'auto' });
    assert.equal(decision.language, 'japan');
    assert.equal(decision.modelId, 'paddle-japan');
    assert.ok(decision.reasons.some((reason) => reason.code === 'declared_language'));
    assert.ok(decision.fallbacks.length > 0);
  });

  test('observed text can drive routing when no language was declared', () => {
    const decision = routeOcr({
      name: 'unknown.png',
      mode: 'auto',
      text: '請求書の合計金額です',
    });
    assert.equal(decision.language, 'japan');
    assert.equal(decision.modelId, 'paddle-japan');
  });

  test('invoice/numeric pages enable the numeric path only for relevant samples', () => {
    const invoice = routeOcr({ name: 'invoice-2026.png', mode: 'auto' });
    assert.equal(invoice.numeric, true);
    assert.ok(invoice.reasons.some((reason) => reason.code === 'numeric_path'));
    const prose = routeOcr({
      name: 'letter.png',
      mode: 'auto',
      text: '尊敬的客户，感谢您的支持。',
    });
    assert.equal(prose.numeric, false);
  });

  test('poor image quality falls back to enhanced preprocessing', () => {
    const decision = routeOcr({
      name: 'photo.jpg',
      mode: 'auto',
      quality: { blurry: true },
    });
    assert.equal(decision.mode, 'enhanced');
    assert.ok(decision.reasons.some((reason) => reason.code === 'image_quality'));
  });

  test('Office documents route to Docling without a language hint', () => {
    const decision = routeOcr({ name: 'contract.docx', engine: 'docling', mode: 'auto' });
    assert.equal(decision.modelId, 'docling-office');
    assert.equal(decision.language, null);
  });
});

describe('model capability matrix', () => {
  test('records engine, scripts, cost and licensing for every entry', () => {
    assert.ok(MODEL_CAPABILITIES.length >= 8);
    for (const model of MODEL_CAPABILITIES) {
      assert.ok(model.id.length > 0);
      assert.ok(model.scripts.length > 0);
      assert.ok(model.speed >= 1 && model.speed <= 5);
      assert.ok(model.memoryMb > 0);
      assert.ok(model.license.length > 0);
    }
    assert.equal(modelById('paddle-v6-medium')?.engine, 'paddle');
    assert.equal(modelById('missing'), null);
  });
});

describe('grey release assignment', () => {
  test('is deterministic for the same attachment id', () => {
    const config = {
      percent: 20,
      mode: 'canary' as const,
      candidateModelId: 'paddle-v6-server',
      controlModelId: 'paddle-v6-medium',
      rollbackModelId: 'paddle-v5-server',
    };
    const first = greyPlan('attachment-123', config);
    const second = greyPlan('attachment-123', config);
    assert.deepEqual(first, second);
    assert.ok(first);
    assert.equal(first.percent, 20);
    assert.ok(first.bucket >= 0 && first.bucket < 100);
    assert.ok(['control', 'candidate'].includes(first.cohort));
    assert.equal(
      first.modelId,
      first.cohort === 'candidate' ? 'paddle-v6-server' : 'paddle-v6-medium',
    );
  });

  test('stays disabled unless a valid percentage is configured', () => {
    assert.equal(greyConfig({} as NodeJS.ProcessEnv), null);
    assert.equal(greyConfig({ OCR_GREY_PERCENT: '0' } as unknown as NodeJS.ProcessEnv), null);
    assert.equal(greyConfig({ OCR_GREY_PERCENT: '100' } as unknown as NodeJS.ProcessEnv), null);
    const config = greyConfig({
      OCR_GREY_PERCENT: '15',
      OCR_ROLLBACK_MODEL: 'paddle-v5-server',
    } as unknown as NodeJS.ProcessEnv);
    assert.equal(config?.percent, 15);
    assert.equal(config?.mode, 'canary');
    assert.equal(config?.rollbackModelId, 'paddle-v5-server');
  });

  test('shadow candidates never replace the control result', () => {
    const plan = greyPlan('attachment-shadow', {
      percent: 100 - 1,
      mode: 'shadow',
      candidateModelId: 'paddle-v6-server',
      controlModelId: 'paddle-v6-medium',
      rollbackModelId: null,
    });
    assert.ok(plan);
    assert.equal(plan.mode, 'shadow');
    assert.equal(plan.modelId, 'paddle-v6-medium');
    assert.equal(plan.candidateModelId, 'paddle-v6-server');
    assert.match(plan.reasons.join(' '), /shadow/);
  });

  test('rollback mode routes all traffic to the previous model', () => {
    const config = greyConfig({
      OCR_GREY_MODE: 'rollback',
      OCR_ROLLBACK_MODEL: 'paddle-v5-server',
    } as unknown as NodeJS.ProcessEnv);
    assert.equal(config?.mode, 'rollback');
    const plan = greyPlan('attachment-rollback', config);
    assert.equal(plan?.mode, 'rollback');
    assert.equal(plan?.modelId, 'paddle-v5-server');
    assert.equal(plan?.percent, 100);
  });
});
