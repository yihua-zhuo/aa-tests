import { expect, type Page, test } from '@playwright/test';

const PASSWORD = 'Demo1234!';
const ADMIN = { email: 'admin@pulse.demo' };

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('邮箱', { exact: true }).fill(ADMIN.email);
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

test('admin ops panel runs integrity checks, backups and feature flags', async ({ page }) => {
  await login(page);

  await page.getByRole('link', { name: 'Ops' }).click();
  await expect(page.getByRole('heading', { name: '运维面板' })).toBeVisible();

  await page.getByRole('button', { name: '检查完整性' }).click();
  await expect(page.locator('.ops-integrity.is-ok')).toBeVisible();

  await expect(page.getByRole('heading', { name: 'OCR 准确率基准' })).toBeVisible();
  await expect(page.locator('.ops-lab')).toContainText(
    '设置 OCR_PADDLE_URL 或 OCR_DOCLING_URL 后可用',
  );

  await expect(page.getByRole('heading', { name: 'OCR 生产治理' })).toBeVisible();
  await expect(page.locator('summary', { hasText: '模型注册表与灰度' })).toBeVisible();
  await expect(page.locator('summary', { hasText: '文档知识图谱' })).toBeVisible();
  await page.locator('summary', { hasText: '通过文档随机审计' }).click();
  await expect(page.getByText('自动判定为通过不等于文档正确', { exact: false })).toBeVisible();
  await expect(page.getByLabel('通过文档抽样比例（百分比）')).toBeVisible();
  await expect(page.getByLabel('每个文件类型的抽样上限')).toBeVisible();
  await expect(page.getByRole('button', { name: /抽取本周审计样本/ })).toBeVisible();
  await expect(page.getByLabel('审计队列筛选')).toBeVisible();
  await expect(page.getByLabel('每层抽样数')).toBeVisible();
  await expect(page.getByLabel('标注预算')).toBeVisible();
  await page.locator('summary', { hasText: '模型注册表与灰度' }).click();
  await expect(page.getByLabel('模型 ID')).toBeVisible();
  await expect(page.getByLabel('候选流量（%）')).toBeVisible();
  await expect(page.getByRole('button', { name: '登记模型变体' })).toBeVisible();

  await page.getByRole('button', { name: '立即备份' }).click();
  await expect(page.locator('.toast').filter({ hasText: '已创建备份' })).toBeVisible();
  await expect(page.locator('.ops-backups tbody tr').first()).toBeVisible();

  const analyticsNav = page.getByRole('link', { name: 'Analytics' });
  await expect(analyticsNav).toBeVisible();
  const analyticsFlag = () =>
    page.locator('.ops-flag', { hasText: '分析报表' }).getByRole('checkbox');

  await analyticsFlag().click();
  await expect(page.locator('.toast').filter({ hasText: '分析报表已停用' })).toBeVisible();
  await expect(analyticsFlag()).not.toBeChecked();
  await expect(analyticsNav).toHaveCount(0);

  await analyticsFlag().click();
  await expect(page.locator('.toast').filter({ hasText: '分析报表已启用' })).toBeVisible();
  await expect(analyticsFlag()).toBeChecked();
  await expect(analyticsNav).toBeVisible();

  await expect(page.getByRole('heading', { name: 'GDPR 数据操作' })).toBeVisible();
  await expect(page.getByLabel('选择成员')).not.toHaveValue('');
});

test('benchmark gate UI shows localized labels, worst-group attribution and field samples', async ({
  page,
}) => {
  await login(page);

  const aggregate = {
    files: 4,
    evaluated: 4,
    failed: 0,
    documents: 4,
    pages: 4,
    characters: 800,
    cer: 0.02,
    rawCer: 0.02,
    numericCer: 0.01,
    symbolCer: 0.005,
    wer: 0.03,
    keywordRecall: null,
    fieldAccuracy: { hit: 7, total: 10, rate: 0.7, interval: [0.4, 0.9] },
    fieldStrong: { hit: 5, total: 10, rate: 0.5, interval: [0.3, 0.7] },
    fieldExact: null,
    fullyCorrect: null,
    errors: { substitutions: 1, insertions: 0, deletions: 0, missingFields: 0, top: [] },
    businessLoss: null,
    tableStructure: null,
    groups: [
      {
        dimension: 'language',
        value: 'ja',
        files: 3,
        pages: 3,
        failed: 0,
        cer: 0.12,
        fieldAccuracy: 0.8,
        fieldTotal: 4,
        fullyCorrectRate: null,
      },
    ],
    calibration: { samples: 0, ece: null, brier: null, bins: [] },
    calibrationGroups: [],
    fieldReliability: [],
    confusions: {},
    splits: [
      {
        split: 'dev',
        files: 2,
        evaluated: 2,
        failed: 0,
        cer: 0.01,
        fieldAccuracy: { hit: 4, total: 5, rate: 0.8, interval: [0.4, 1] },
        fullyCorrect: null,
        gateSplit: false,
      },
      {
        split: 'calibration',
        files: 0,
        evaluated: 0,
        failed: 0,
        cer: null,
        fieldAccuracy: null,
        fullyCorrect: null,
        gateSplit: false,
      },
      {
        split: 'blind',
        files: 2,
        evaluated: 2,
        failed: 0,
        cer: 0.02,
        fieldAccuracy: { hit: 3, total: 5, rate: 0.6, interval: [0.3, 0.9] },
        fullyCorrect: null,
        gateSplit: true,
      },
    ],
    gate: {
      passed: false,
      checks: [
        { name: 'cer', value: 0.02, threshold: 0.05, comparison: 'max', passed: true },
        {
          name: 'field_accuracy_strong',
          value: 0.5,
          threshold: 0.9,
          comparison: 'min',
          passed: false,
          samples: 10,
          requiredSamples: null,
        },
        {
          name: 'fully_correct',
          value: 1,
          threshold: 0.8,
          comparison: 'min',
          passed: true,
          samples: 4,
          requiredSamples: 35,
        },
        {
          name: 'evidence_sufficiency',
          value: 1,
          threshold: 0,
          comparison: 'max',
          passed: false,
          note: 'fully_correct 需 35 个观测，当前 4',
        },
        {
          name: 'worst_group_cer',
          value: 0.12,
          threshold: 0.08,
          comparison: 'max',
          passed: false,
          group: { dimension: 'language', value: 'ja' },
        },
        {
          name: 'worst_group_field_accuracy',
          value: 0.8,
          threshold: 0.95,
          comparison: 'min',
          passed: false,
          group: { dimension: 'language', value: 'ja' },
        },
      ],
    },
  };

  await page.route('**/api/ocr/lab', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        available: true,
        corpusDir: '/tmp/e2e-corpus',
        models: { paddle: 'ppocr-v4' },
        matrix: [],
        runtime: {},
        grey: null,
        files: [],
        run: {
          id: 'e2e-run',
          status: 'done',
          startedAt: '2026-01-01T00:00:00.000Z',
          finishedAt: '2026-01-01T00:01:00.000Z',
          includePdf: false,
          total: 4,
          completed: 4,
          current: null,
          results: [],
          error: null,
        },
        aggregate,
        thresholds: [],
        history: [],
      }),
    }),
  );

  await page.getByRole('link', { name: 'Ops' }).click();
  const lab = page.locator('.ops-lab-aggregate');
  await expect(lab.locator('.ops-lab-status')).toContainText('未达标');

  await page.locator('summary', { hasText: '门禁检查' }).click();
  const gateAlert = lab.getByRole('alert');
  await expect(gateAlert).toContainText('最差分组 CER（语言：ja）');
  await expect(gateAlert).toContainText('最差分组字段准确率（语言：ja）');
  await expect(gateAlert).toContainText('字段强命中率（位置/标签）');
  await expect(lab.locator('.ops-gate-list li.is-failed')).toHaveCount(4);
  await expect(lab.locator('.ops-gate-list')).toContainText('12.00% > 8.00%');
  await expect(lab.locator('.ops-gate-list')).toContainText('80.00% < 95.00%');
  // Count-style evidence checks are counts, not percentages.
  await expect(lab.locator('.ops-gate-list li', { hasText: '门禁证据充分性' })).toContainText(
    '1 项 > 0 项',
  );
  // A rate that passes on four documents is labelled as thin evidence instead of a
  // clean pass, and says how many observations its threshold would need.
  const thinRow = lab.locator('.ops-gate-list li.is-thin');
  await expect(thinRow).toHaveCount(1);
  await expect(thinRow).toContainText('文档全对率');
  await expect(thinRow).toContainText('通过但证据不足');
  await expect(thinRow).toContainText('样本 4，需 35');
  await expect(page.locator('summary', { hasText: '门禁检查' })).toContainText('1 项需补样本');

  await page.locator('summary', { hasText: '分层结果' }).click();
  const groupRow = lab.locator('table tbody tr', { hasText: 'ja' });
  await expect(groupRow.locator('td').nth(7)).toHaveText('4');
});

test('passed-document audit queue reports the silent error rate with its interval', async ({
  page,
}) => {
  await login(page);

  const stats = {
    sampled: 4,
    pending: 1,
    audited: 3,
    clean: 1,
    error: 1,
    disputed: 1,
    silentErrorRate: 2 / 3,
    interval: [0.2077, 0.9388],
    disagreementRate: 1 / 3,
    passDocuments: 120,
    coverage: 4 / 120,
    byDocType: [
      {
        docType: 'png',
        sampled: 4,
        audited: 3,
        clean: 1,
        error: 1,
        disputed: 1,
        silentErrorRate: 2 / 3,
        interval: [0.2077, 0.9388],
      },
    ],
  };
  const audits = [
    {
      id: 'audit-1',
      attachmentId: 'att-1',
      attachmentName: 'invoice-2026-05.png',
      projectId: 'p1',
      projectName: '交付项目',
      workspaceId: null,
      docType: 'png',
      engine: 'paddle',
      model: 'ppocr-v4',
      qualityScore: 0.93,
      confidence: 0.97,
      period: '2026-W44',
      sampledAt: '2026-10-26T00:00:00.000Z',
      status: 'pending',
      firstVerdict: 'clean',
      firstBy: '李明',
      firstAt: '2026-10-27T00:00:00.000Z',
      secondVerdict: null,
      secondBy: null,
      secondAt: null,
      note: null,
    },
    {
      id: 'audit-2',
      attachmentId: 'att-2',
      attachmentName: 'ledger-2026-05.pdf',
      projectId: 'p1',
      projectName: '交付项目',
      workspaceId: null,
      docType: 'pdf',
      engine: 'paddle',
      model: 'ppocr-v4',
      qualityScore: 0.88,
      confidence: 0.91,
      period: '2026-W44',
      sampledAt: '2026-10-26T00:00:00.000Z',
      status: 'disputed',
      firstVerdict: 'clean',
      firstBy: '李明',
      firstAt: '2026-10-27T00:00:00.000Z',
      secondVerdict: 'error',
      secondBy: '王芳',
      secondAt: '2026-10-28T00:00:00.000Z',
      note: '金额小数点丢失',
    },
  ];

  await page.route('**/api/ocr/pass-audits**', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          audit: { ...audits[0], status: 'error', secondVerdict: 'error' },
          stats: { ...stats, pending: 0, audited: 4, error: 2, silentErrorRate: 0.5 },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ audits, stats, period: '2026-W44' }),
    });
  });

  await page.getByRole('link', { name: 'Ops' }).click();
  const panel = page.locator('details', { hasText: '通过文档随机审计' });
  await expect(panel.getByRole('button', { name: /抽取本周审计样本/ })).toBeVisible();
  await expect(panel.locator('.ops-lab-meta')).toContainText('通过文档 120 个');
  await expect(panel.locator('.ops-lab-meta')).toContainText('抽样 4 个 · 覆盖 3.3%');
  await expect(panel.locator('.ops-lab-meta')).toContainText('95% 区间 20.8%–93.9%');
  await expect(panel.getByRole('alert')).toHaveCount(0);

  const invoiceRow = panel.locator('table tbody tr', { hasText: 'invoice-2026-05.png' });
  await expect(invoiceRow.locator('td').nth(5)).toHaveText('干净 / —');
  await expect(invoiceRow).toContainText('待复核');
  await expect(panel.locator('table tbody tr', { hasText: 'ledger-2026-05.pdf' })).toContainText(
    '分歧',
  );

  await invoiceRow.getByLabel('invoice-2026-05.png 的审计说明').fill('复核备注');
  await invoiceRow.getByRole('button', { name: '有错' }).click();
  await expect(panel.getByRole('button', { name: /抽取本周审计样本/ })).toBeVisible();
});

test('revision quality control queue grades annotations before they train thresholds', async ({
  page,
}) => {
  await login(page);

  const stats = {
    revisions: 6,
    reviewed: 4,
    unreviewed: 2,
    doubleConfirmed: 2,
    arbitrated: 1,
    disputed: 1,
    disagreementRate: 0.25,
    interval: [0.0449, 0.6951],
    coverage: 4 / 6,
    byReviewer: [
      {
        reviewerId: 'u2',
        reviewerName: '李明',
        reviewed: 3,
        confirmed: 2,
        revised: 1,
        agreementRate: 2 / 3,
      },
      {
        reviewerId: 'u3',
        reviewerName: '王芳',
        reviewed: 1,
        confirmed: 1,
        revised: 0,
        agreementRate: 1,
      },
    ],
    annotationMix: { doubleConfirmed: 2, singleReviewer: 2, disputed: 1 },
  };
  const revision = (id: string, fieldId: string) => ({
    id,
    attachmentId: `att-${id}`,
    projectId: 'p1',
    fieldId,
    fieldKind: 'amount',
    page: 1,
    blockId: 'b1',
    bbox: null,
    originalText: '1,280.00',
    revisedText: '1,286.00',
    reason: 'ocr_error',
    revisedBy: { id: 'u9', name: '赵倩' },
    createdAt: '2026-10-29T00:00:00.000Z',
  });
  const items = [
    {
      revision: revision('rev-1', 'tax'),
      attachmentName: 'ledger-2026-05.pdf',
      projectName: '交付项目',
      reliability: 'disputed',
      needsArbitration: true,
      reviews: [
        {
          id: 'rv-1',
          revisionId: 'rev-1',
          verdict: 'revise',
          value: '1,288.00',
          note: '小数位仍错',
          reviewedBy: { id: 'u3', name: '王芳' },
          createdAt: '2026-10-30T00:00:00.000Z',
        },
      ],
    },
    {
      revision: revision('rev-2', 'amount'),
      attachmentName: 'invoice-2026-05.png',
      projectName: '交付项目',
      reliability: 'single_reviewer',
      needsArbitration: false,
      reviews: [],
    },
  ];

  await page.route('**/api/ocr/revision-qc**', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          item: { ...items[1], reliability: 'double_confirmed' },
          stats: { ...stats, doubleConfirmed: 3, unreviewed: 1 },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items, stats }),
    });
  });

  await page.getByRole('link', { name: 'Ops' }).click();
  const panel = page.locator('details', { hasText: '人工修订质检' });
  await expect(panel.locator('.ops-lab-meta')).toContainText('修订 6 条');
  await expect(panel.locator('.ops-lab-meta')).toContainText('分歧率 25.0%');
  await expect(panel.locator('.ops-lab-meta')).toContainText('95% 区间 4.5%–69.5%');
  await expect(panel.locator('.ops-lab-meta')).toContainText('双人 2 / 单人 2 / 分歧 1');
  await expect(panel.getByRole('alert')).toHaveCount(0);

  const disputedRow = panel.locator('table tbody tr', { hasText: 'ledger-2026-05.pdf' });
  await expect(disputedRow).toContainText('改判·王芳');
  await expect(disputedRow.locator('td').nth(6)).toHaveText('待仲裁');
  const openRow = panel.locator('table tbody tr', { hasText: 'invoice-2026-05.png' });
  await expect(openRow).toContainText('无人复核');
  await expect(openRow).toContainText('金额·amount');

  // Dissent and arbitration need a value first; confirmation does not.
  const valueInput = openRow.getByLabel(/invoice-2026-05\.png amount 的复核值/);
  await expect(openRow.getByRole('button', { name: '改判' })).toBeDisabled();
  await expect(openRow.getByRole('button', { name: '确认' })).toBeEnabled();
  await valueInput.fill('1,290.00');
  await expect(openRow.getByRole('button', { name: '改判' })).toBeEnabled();
  await openRow.getByRole('button', { name: '确认' }).click();
  await expect(panel.locator('table tbody tr', { hasText: 'invoice-2026-05.png' })).toHaveCount(1);

  await expect(panel.locator('table tbody tr', { hasText: '李明' })).toContainText('66.7%');
});

test('OCR lab surfaces variant experiments, stage replay and fitted thresholds', async ({
  page,
}) => {
  await login(page);

  const startedAt = '2026-01-01T00:00:00.000Z';
  await page.route('**/api/ocr/lab', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        available: true,
        corpusDir: '/tmp/e2e-corpus',
        models: { paddle: 'ppocr-v4' },
        matrix: [],
        runtime: {},
        grey: null,
        files: [],
        run: {
          id: 'e2e-run',
          status: 'done',
          startedAt,
          finishedAt: '2026-01-01T00:01:00.000Z',
          includePdf: false,
          total: 1,
          completed: 1,
          current: null,
          results: [
            {
              name: 'invoice.png',
              engine: 'paddle',
              status: 'done',
              degradations: [],
              uncertain: [],
              stages: [
                {
                  kind: 'visual',
                  status: 'done',
                  mode: 'auto',
                  engine: 'paddle',
                  model: 'ppocr-v4',
                  dpi: null,
                  seconds: 1.2,
                  score: 0.8,
                  message: null,
                },
                {
                  kind: 'candidate',
                  status: 'done',
                  mode: 'auto',
                  engine: 'docling',
                  model: 'docling',
                  dpi: null,
                  seconds: 2.4,
                  score: 0.9,
                  message: '候选引擎 docling · 一致度 95.0% · 质量 80.0% → 90.0%（采用）',
                },
              ],
            },
          ],
          error: null,
        },
        aggregate: null,
        thresholds: [],
        history: [],
      }),
    }),
  );
  await page.route('**/api/ocr/lab/experiment', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'e2e-experiment',
        status: 'done',
        startedAt,
        finishedAt: '2026-01-01T00:02:00.000Z',
        includePdf: false,
        sampleSize: 6,
        topK: 2,
        variants: [
          {
            id: 'paddle:rgb',
            label: 'paddle rgb 自动布局',
            engine: 'paddle',
            modelId: null,
            profile: null,
            mode: 'auto',
            dpi: null,
            channel: 'rgb',
            preprocess: 'original',
          },
        ],
        stage: 'screen',
        screen: {
          files: ['invoice.png'],
          results: [],
          summaries: [
            {
              id: 'paddle:rgb',
              label: 'paddle rgb 自动布局',
              engine: 'paddle',
              modelId: null,
              profile: null,
              mode: 'auto',
              dpi: null,
              channel: 'rgb',
              preprocess: 'original',
              license: null,
              memoryMb: null,
              files: 6,
              failed: 0,
              meanCer: 0.03,
              meanRawCer: 0.03,
              meanNumericCer: 0.02,
              meanWer: 0.04,
              fieldRate: 0.9,
              meanConfidence: 0.88,
              meanSeconds: 1.5,
              score: 0.91,
              rank: 1,
            },
          ],
        },
        full: null,
        selected: ['paddle:rgb'],
        error: null,
      }),
    }),
  );
  await page.route('**/api/ocr/lab/replay', (route) => {
    const request = route.request().postDataJSON() as { kind?: string };
    const kind = request.kind ?? 'visual';
    const engine = kind === 'candidate' ? 'docling' : 'paddle';
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        kind,
        mode: 'auto',
        dpi: null,
        engine,
        params: { mode: 'auto', dpi: null, page: null, bbox: null, padding: null },
        recordedInputSha256: 'aaa',
        inputSha256: 'aaa',
        inputMatches: true,
        recordedOutputSha256: 'bbb',
        outputSha256: 'bbb',
        outputMatches: true,
        scoreBefore: 0.8,
        scoreAfter: 0.9,
        scoreDelta: 0.1,
        candidate: null,
        extraction: null,
        quality: null,
      }),
    });
  });
  await page.route('**/api/ocr/calibration', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        profiles: [
          {
            id: 'overall:all',
            dimension: 'overall',
            value: 'all',
            workspaceId: null,
            samples: 12,
            positives: 4,
            reviewThreshold: 0.62,
            failThreshold: 0.35,
            keyFieldConfidence: 0.8,
            precision: 0.88,
            recall: 0.75,
            falseReviewRate: 0.06,
            ece: 0.04,
            brier: 0.15,
            calibrated: true,
            createdAt: startedAt,
            updatedAt: startedAt,
          },
        ],
      }),
    }),
  );

  await page.getByRole('link', { name: 'Ops' }).click();
  await expect(page.getByRole('heading', { name: 'OCR 准确率基准' })).toBeVisible();

  await page.locator('summary', { hasText: '模型与预处理对照实验' }).click();
  await expect(page.getByRole('status').filter({ hasText: '筛选 6 个文件' })).toContainText(
    '晋级 paddle:rgb',
  );
  await expect(
    page.getByRole('table', { name: 'OCR 对照实验变体排名' }).locator('tbody tr'),
  ).toContainText('paddle rgb 自动布局');

  await page.locator('summary', { hasText: '阶段重放（最近一次基准运行）' }).click();
  const stagePicker = page.getByLabel('阶段');
  await expect(stagePicker).toContainText('候选复认 · Docling · 第 1 次');
  await page.getByRole('button', { name: '重放阶段' }).click();
  const replay = page.locator('.ops-lab-aggregate').filter({ hasText: '输入指纹' }).last();
  await expect(replay.getByRole('status')).toContainText('PaddleOCR');
  await expect(replay.getByRole('status')).toContainText('输入指纹 一致');
  await expect(replay.getByRole('status')).toContainText('输出 一致');
  await expect(replay.getByRole('status')).toContainText('质量 80.0% → 90.0%（+10.0%）');

  await stagePicker.selectOption('1');
  await page.getByRole('button', { name: '重放阶段' }).click();
  const candidateReplay = page.locator('.ops-lab-aggregate').filter({ hasText: '输入指纹' }).last();
  await expect(candidateReplay.getByRole('status')).toContainText('候选复认');
  await expect(candidateReplay.getByRole('status')).toContainText('Docling');

  await page.locator('summary', { hasText: '质量阈值配置（1 项）' }).click();
  const profile = page.getByRole('table', { name: 'OCR 质量阈值配置' }).locator('tbody tr');
  await expect(profile).toContainText('整体');
  await expect(profile).toContainText('已校准');
  await expect(profile).toContainText('62.0%');
});
