import { expect, type Page, request as playwrightRequest, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'Demo1234!';
const ADMIN = { email: 'admin@pulse.demo', name: '林晓' };
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABBUlEQVR4nO3QAUYgAABE0Q77D5IkSZIkSZIkSVaSJEmSfEmSJGslWUmSJEnSdI6Yd4Q3MIgZwgxjRjCjmDHMOGYCM4mZwkxjZjCzmDnMPGYBs4hZwixjVjCrmDXMOuYPZgOzidnCbGN2MLuYPcw+5gBziDnCHGPEnGBOMWeYc8wF5hJzhbnG/MX8w9xgbjF3mP+Ye8wD5hHzhHnGvGBeMW+Yd8wH5hPzhfnGDDSgAQ1oQAMa0IAGNKABDWhAAxrQgAY0oAENaEADGtCABjSgAQ1oQAMa0IAGNKABDWhAAxrQgAY0oAENaEADGtCABjSgAQ1oQAMa0IAGNKABDWhAAxrw+wN+AD5IorNHRjWnAAAAAElFTkSuQmCC';

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('邮箱', { exact: true }).fill(ADMIN.email);
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
}

async function adminApi(page: Page) {
  const api = await playwrightRequest.newContext({ baseURL: new URL(page.url()).origin });
  const response = await api.post('/api/auth/login', {
    data: { email: ADMIN.email, password: PASSWORD },
  });
  expect(response.ok()).toBeTruthy();
  return api;
}

test('attachments upload, signed download and delete; avatars crop and remove', async ({
  page,
}) => {
  await login(page);
  const api = await adminApi(page);
  const created = await api.post('/api/projects', {
    data: { name: `E2E 附件项目 ${Date.now().toString(36)}` },
  });
  expect(created.ok()).toBeTruthy();
  const project = (await created.json()) as { id: string };
  const fileName = `e2e-notes-${Date.now().toString(36)}.md`;

  try {
    await page.goto(`/projects/${project.id}`);
    await expect(page.getByRole('heading', { name: '附件', exact: true })).toBeVisible();

    await page.locator('#attachment-file').setInputFiles({
      name: fileName,
      mimeType: 'text/markdown',
      buffer: Buffer.from('# E2E notes\n\nAttachment body.'),
    });
    await expect(page.getByRole('status')).toContainText(`已上传「${fileName}」`);

    const link = page.getByRole('link', { name: fileName, exact: true });
    await expect(link).toBeVisible();
    const href = await link.getAttribute('href');
    expect(href).toMatch(/^\/files\/attachments\/.+\?expires=\d+&sig=[0-9a-f]+$/);
    const download = await page.request.get(href!);
    expect(download.status()).toBe(200);
    expect(await download.text()).toContain('Attachment body.');
    await expect(page.locator('.attachment-usage')).toContainText('1/50');

    await page.getByRole('button', { name: `删除 ${fileName}` }).click();
    const dialog = page.getByRole('dialog', { name: '删除附件' });
    await dialog.getByRole('button', { name: '确认删除' }).click();
    await expect(page.getByRole('status')).toContainText(`已删除「${fileName}」`);
    await expect(page.getByRole('link', { name: fileName, exact: true })).toHaveCount(0);
    expect((await page.request.get(href!)).status()).toBe(404);

    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: '头像', exact: true })).toBeVisible();
    await page.locator('#avatar-file').setInputFiles({
      name: 'e2e-avatar.png',
      mimeType: 'image/png',
      buffer: Buffer.from(PNG_BASE64, 'base64'),
    });
    await expect(page.getByRole('status')).toContainText('头像已更新');
    await expect(page.locator('.avatar-editor img.avatar-image')).toBeVisible();

    const editor = page.locator('.avatar-editor');
    await editor.getByRole('button', { name: '移除', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('头像已移除');
    await expect(editor.locator('img.avatar-image')).toHaveCount(0);
    await expect(editor.getByRole('button', { name: '上传头像' })).toBeVisible();
  } finally {
    await api.delete(`/api/projects/${project.id}`);
    await api.dispose();
  }
});

test('attachment OCR panel explains ink no recognition box covers and what recovery returned', async ({
  page,
}) => {
  await login(page);
  const api = await adminApi(page);
  const created = await api.post('/api/projects', {
    data: { name: `E2E 墨迹项目 ${Date.now().toString(36)}` },
  });
  expect(created.ok()).toBeTruthy();
  const project = (await created.json()) as { id: string };

  const quality = {
    score: 0.61,
    status: 'review',
    calibrated: false,
    signals: { confidence: 0.7, inkCoverage: 0.75 },
    components: {
      ocrConfidence: 0.7,
      structureConfidence: null,
      fieldValidation: null,
      businessConsistency: null,
    },
    docType: {
      type: 'invoice',
      confidence: 0.82,
      evidence: ['标题含“发票”', '含价税合计'],
      schema: {
        fields: [
          {
            key: 'number',
            label: '发票号码',
            kind: 'identifier',
            required: true,
            found: true,
            value: '12345678',
            valid: true,
          },
          {
            key: 'total',
            label: '价税合计',
            kind: 'amount',
            required: true,
            found: true,
            value: '1280.00',
            valid: true,
          },
          {
            key: 'date',
            label: '开票日期',
            kind: 'date',
            required: true,
            found: false,
            value: null,
            valid: false,
          },
        ],
        missing: ['开票日期'],
        invalid: [],
        conflicts: [],
        coverage: 0.67,
      },
    },
    hardRisks: [
      {
        code: 'ink_without_text',
        severity: 'warning',
        message: '存在未被任何识别框覆盖的墨迹，可能漏识别了整行或整格内容',
        page: 1,
        blockId: 't1',
      },
    ],
    issues: [
      {
        code: 'ink_without_text',
        severity: 'warning',
        message: '2 处墨迹没有任何识别框覆盖（其中 1 处在表格空白单元格内）',
        page: 1,
        blockId: null,
      },
    ],
  };
  const source = { engine: 'paddle', model: 'ppocr-v4', stage: 'visual' };
  const ocr = {
    status: 'done',
    engine: 'paddle',
    model: 'ppocr-v4',
    confidence: 0.7,
    characters: 16,
    pages: 1,
    seconds: 2.4,
    truncated: false,
    mode: 'auto',
    dpi: 200,
    route: 'visual',
    reviewRequired: true,
    error: null,
    updatedAt: new Date().toISOString(),
    text: '季度报告\n本季度业务保持稳定增长\n贰零贰陆年',
    rawText: '季度报告\n本季度业务保持稳定增长\n贰零贰陆年',
    quality,
    stages: [
      {
        kind: 'visual',
        status: 'done',
        mode: 'auto',
        engine: 'paddle',
        model: 'ppocr-v4',
        dpi: 200,
        seconds: 2.1,
        score: 0.6,
        message: null,
      },
      {
        kind: 'recovery_region',
        status: 'done',
        mode: 'auto',
        engine: 'paddle',
        model: 'ppocr-v4',
        dpi: 300,
        seconds: 0.9,
        score: 0.61,
        message: '1/2 处未覆盖墨迹补回文本',
        trigger: 'ink_gap',
        decision: { trigger: 'ink_gap', expectedGain: 0.12, costSeconds: 1.2, value: 0.05 },
      },
    ],
    document: {
      version: 1,
      route: 'visual',
      pages: [
        {
          number: 1,
          width: 600,
          height: 800,
          source: null,
          blocks: [
            {
              id: 'b1',
              type: 'paragraph',
              text: '季度报告\n本季度业务保持稳定增长',
              bbox: { x: 40, y: 40, width: 500, height: 60 },
              confidence: 0.9,
              source,
              validation: null,
              order: 0,
            },
            {
              id: 'ink-p1-g0',
              type: 'paragraph',
              text: '贰零贰陆年',
              bbox: { x: 40, y: 700, width: 200, height: 24 },
              confidence: 0.55,
              source: { engine: 'paddle', model: 'ppocr-v4', stage: 'recovery' },
              validation: { status: 'flagged', issues: ['ink_without_text'] },
              order: 1,
              meta: { inkGap: 'p1-g0', inkGapKind: 'region', inkGapPixels: 900 },
            },
          ],
          meta: {
            inkGaps: [
              {
                id: 'p1-g1',
                kind: 'cell',
                blockId: 't1',
                bbox: { x: 120, y: 400, width: 90, height: 20 },
                pixels: 140,
                density: 0.3,
              },
            ],
            machineReadable: [
              {
                format: 'barcode',
                text: 'INV-2026-001',
                page: 1,
                bbox: { x: 40, y: 20, width: 160, height: 40 },
              },
              {
                format: 'mrz',
                text: 'P<CHN1234567890<<<<<<<<<<<<<<<<<<',
                page: 1,
                fields: { documentNumber: '123456789' },
                checks: { valid: false, failed: ['passportNumber'] },
              },
            ],
          },
        },
      ],
      readingOrder: ['b1', 'ink-p1-g0'],
      meta: {
        fieldEvidence: [
          {
            kind: 'text',
            page: 1,
            blockId: 'ink-p1-g0',
            bbox: { x: 40, y: 700, width: 200, height: 24 },
            text: '',
            confidence: null,
            source,
            candidates: [
              {
                text: '贰零贰陆年',
                confidence: 0.55,
                model: 'ppocr-v4',
                engine: 'paddle',
                source: 'region',
                bbox: { x: 40, y: 700, width: 200, height: 24 },
                pass: 1,
                mode: 'auto',
                dpi: 300,
                padding: 0.04,
                numeric: null,
              },
            ],
            selected: 'candidate',
            agreement: 'unverified',
            passes: 1,
            failed: [],
            inkGap: { id: 'p1-g0', kind: 'region', pixels: 900 },
            reason: 'candidate_selected',
          },
        ],
        preprocess: {
          pages: [
            {
              page: 1,
              ocrSelection: {
                page: 1,
                selected: 'original',
                basis: 'numeric_conflict',
                conflict: true,
                agreement: 0.62,
                missingTokens: 2,
                addedTokens: 0,
              },
            },
          ],
        },
        office: {
          headers: 1,
          footers: 1,
          textBoxes: 1,
          footnotes: 0,
          endnotes: 0,
          comments: 2,
          notes: 0,
          charts: 1,
          images: 3,
          embeddedObjects: 0,
          groupedShapes: 0,
          revisions: 2,
          deletedText: 8,
          insertedText: 4,
          hiddenSlides: 0,
          objects: 8,
          unrendered: 3,
        },
      },
    },
  };

  const attachment = {
    id: 'e2e-ink-attachment',
    projectId: project.id,
    name: 'e2e-scan.png',
    mime: 'image/png',
    size: 4096,
    uploader: null,
    createdAt: new Date().toISOString(),
    downloadUrl: '/files/attachments/e2e-scan.png',
    downloadExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    ocr,
  };

  const json = (data: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(data),
  });
  const base = `/api/projects/${project.id}/attachments`;
  await page.route(`${base}**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/ocr/fields')) return route.fulfill(json({ fields: [] }));
    if (path.endsWith('/ocr/versions')) {
      return route.fulfill(
        json({
          chain: {
            attachmentId: attachment.id,
            projectId: project.id,
            status: 'done',
            nodes: [],
            revisions: [],
          },
        }),
      );
    }
    if (path.endsWith('/ocr/export')) {
      return route.fulfill(
        json({
          filename: 'e2e-scan.txt',
          text: '季度报告\n联系电话 [手机号]',
          redactions: { phone: 1 },
        }),
      );
    }
    if (path.endsWith('/ocr')) return route.fulfill(json({ attachment, ocr }));
    return route.fulfill(
      json({
        attachments: [attachment],
        limits: { maxBytes: 10_485_760, maxCount: 50, maxTotalBytes: 52_428_800 },
        usage: { count: 1, totalBytes: 4096 },
      }),
    );
  });

  try {
    await page.goto(`/projects/${project.id}`);
    await expect(page.getByRole('heading', { name: '附件', exact: true })).toBeVisible();
    await page.locator('.ocr-chip').first().click();
    await expect(page.getByRole('dialog', { name: '附件识别文本' })).toBeVisible();

    await expect(page.locator('.ocr-quality')).toContainText('未覆盖墨迹 1 · 核查 1 页');
    await expect(page.locator('.ocr-quality')).toContainText('墨迹补回 1');
    await expect(page.locator('.ocr-issues li.is-warning')).toContainText(
      '2 处墨迹没有任何识别框覆盖（其中 1 处在表格空白单元格内）',
    );
    await expect(page.locator('.field-hint[role="alert"]')).toContainText(
      '1 项硬性风险：无论分数高低都按需要复核处理——存在未被任何识别框覆盖的墨迹',
    );
    await expect(page.locator('.ocr-stages li').last()).toContainText('触发 未覆盖墨迹');
    await expect(page.locator('.ocr-stages li').last()).toContainText('1/2 处未覆盖墨迹补回文本');
    const evidence = page.locator('.ocr-evidence-list li').first();
    await expect(evidence).toContainText('墨迹无识别框 · 900 像素');
    await expect(evidence.locator('.ocr-evidence-row.is-original code')).toHaveText(
      '（此处原本没有任何识别框）',
    );
    // Nothing was recognized here, so no second opinion can agree or disagree.
    await expect(evidence.locator('.ocr-evidence-flag')).toHaveCount(0);

    const qualityRow = page.locator('.ocr-quality');
    await expect(qualityRow).toContainText('类型 发票 · 82% · 必填 67% · 缺 开票日期');
    await expect(qualityRow.locator('span.ocr-review', { hasText: '类型 发票' })).toHaveAttribute(
      'title',
      '判定依据：标题含“发票”、含价税合计',
    );
    await expect(qualityRow).toContainText('条码/QR/MRZ 2 条 · MRZ 1 · 校验失败 1');
    await expect(qualityRow).toContainText('预处理冲突 1/1 页');
    await expect(qualityRow).toContainText('Office 覆盖 · 图表 1 · 图片 3 · 批注 2 · 修订已过滤');

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出脱敏文本' }).click();
    expect((await download).suggestedFilename()).toBe('e2e-scan.txt');
    await expect(page.getByRole('status')).toContainText('已导出脱敏文本，替换 1 处敏感信息');
  } finally {
    await api.delete(`/api/projects/${project.id}`);
    await api.dispose();
  }
});

test('purged attachment OCR keeps the retention notice but drops transcript and export', async ({
  page,
}) => {
  await login(page);
  const api = await adminApi(page);
  const created = await api.post('/api/projects', {
    data: { name: `E2E 清理项目 ${Date.now().toString(36)}` },
  });
  expect(created.ok()).toBeTruthy();
  const project = (await created.json()) as { id: string };

  const purgedAt = new Date().toISOString();
  const ocr = {
    status: 'done',
    engine: 'paddle',
    model: 'ppocr-v4',
    confidence: 0.9,
    characters: 0,
    pages: 1,
    seconds: 1.2,
    truncated: false,
    mode: 'auto',
    dpi: 200,
    route: 'visual',
    reviewRequired: false,
    error: null,
    updatedAt: purgedAt,
    text: '',
    rawText: '',
    quality: null,
    stages: [],
    document: null,
    purgedAt,
  };
  const attachment = {
    id: 'e2e-purged-attachment',
    projectId: project.id,
    name: 'e2e-purged.png',
    mime: 'image/png',
    size: 2048,
    uploader: null,
    createdAt: purgedAt,
    downloadUrl: '/files/attachments/e2e-purged.png',
    downloadExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    ocr,
  };

  const json = (data: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(data),
  });
  const base = `/api/projects/${project.id}/attachments`;
  await page.route(`${base}**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/ocr/fields')) return route.fulfill(json({ fields: [] }));
    if (path.endsWith('/ocr/versions')) {
      return route.fulfill(
        json({
          chain: {
            attachmentId: attachment.id,
            projectId: project.id,
            status: 'done',
            nodes: [],
            revisions: [],
          },
        }),
      );
    }
    if (path.endsWith('/ocr')) return route.fulfill(json({ attachment, ocr }));
    return route.fulfill(
      json({
        attachments: [attachment],
        limits: { maxBytes: 10_485_760, maxCount: 50, maxTotalBytes: 52_428_800 },
        usage: { count: 1, totalBytes: 2048 },
      }),
    );
  });

  try {
    await page.goto(`/projects/${project.id}`);
    const chip = page.locator('.ocr-chip').first();
    await expect(chip).toContainText('OCR 文本已清理');
    await chip.click();
    await expect(page.getByRole('dialog', { name: '附件识别文本' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: '附件识别文本' })).toContainText(
      '识别文本已按保留策略清理',
    );
    await expect(page.locator('.ocr-text')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '导出脱敏文本' })).toHaveCount(0);
  } finally {
    await api.delete(`/api/projects/${project.id}`);
    await api.dispose();
  }
});
