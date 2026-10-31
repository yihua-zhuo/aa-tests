# OCR 完整方案与识别率优化

本文是附件 OCR 的端到端方案说明：架构、引擎、路由、数据结构、质量评估、预算级联、
缓存、基准、复核与运维，以及为提升识别率所做的具体优化。V2 架构的取舍与路线图见
[document-intelligence.md](document-intelligence.md)。

## 1. 一句话方案

**原生优先（native-first）、按需识别、结构统一、质量驱动恢复、基准闭环。**
1. 能直接读取文本层的文档不跑 OCR，从源头避免识别错误。
2. 只对扫描页或视觉内容渲染识别；混合 PDF 按页选择原生或 OCR。
3. 所有引擎统一输出 Document IR（DIR），质量、基准与后续修复共享同一结构。
4. 首次结果先评分，不达标才在预算内做定向恢复，并保留质量最高的结果。
5. 低质量结果只标记人工复核，**系统永远不自动改写识别文本**。
6. 用固定语料与多项指标量化每次改动的收益，而不是凭感觉调参。

## 2. 总体架构

```text
浏览器（附件面板 / 复核弹窗 / Ops 基准）
        │
        ▼
Hono API ── 上传校验、附件元数据、OCR 查询与重跑、基准触发
        │
        ▼
SQLite attachments 队列（pending → processing → done / failed / skipped）
        │
        ▼
OcrWorker（Node 进程内）
  ├─ 缓存复用（sha256 + 模型 + 模式 + DPI）
  ├─ 预算级联（首次抽取 → 质量评估 → 定向恢复）
  └─ 持久化文本、DIR、质量、阶段与复核标记
        │  HTTP + X-OCR-Token
        ▼
┌───────────────────────┬───────────────────────┐
│ Paddle sidecar :8765  │ Docling sidecar :8766 │
│ 图片 / PDF / 表格      │ Office 文档 / 兜底     │
└───────────────────────┴───────────────────────┘
```

| 模块       | 位置                        | 职责                                        |
| ---------- | --------------------------- | ------------------------------------------- |
| 附件路由   | `src/routes/attachments.ts` | 上传、类型校验、复用、OCR 查询与重跑        |
| OCR 客户端 | `src/ocr.ts`                | sidecar 调用、结果解析、模型探测、缓存键    |
| 任务队列   | `src/stores/attachments.ts` | 原子领取、重试、恢复中断任务                |
| Worker     | `src/ocr-worker.ts`         | 轮询、缓存复用、级联、持久化                |
| 质量引擎   | `src/ocr-quality.ts`        | 多信号评分与问题清单                        |
| 级联       | `src/ocr-cascade.ts`        | 恢复规划、预算控制、保留最佳结果            |
| 基准       | `src/ocr-bench.ts`          | 语料执行、CER/字段/关键词指标、历史记录     |
| 基准存储   | `src/stores/ocr-bench.ts`   | 运行状态、逐文件结果与历史                  |
| 基准 API   | `src/routes/ocr-lab.ts`     | 管理员查看状态与触发运行                    |
| 侧车       | `scripts/ocr_sidecar.py`    | 原生抽取、PaddleOCR、结构分析、PDF 逐页路由 |

## 3. 处理流程与状态机

```text
上传附件
  └─ 按扩展名决定是否需要 OCR（无引擎 → skipped）
       └─ 入库 pending，唤醒 worker
            └─ claimNext 原子改为 processing，attempts+1，写入 2 分钟租约
                 ├─ 命中可复用缓存 → 用当前阈值重新评分 → done
                 └─ 调用级联
                      ├─ 首次抽取（native / visual）
                      ├─ 质量评估
                      ├─ 未通过 → 预算内恢复 → 取最高分
                      └─ 持久化 → done
                           └─ review / fail → reviewRequired = 1
```

- `pending`：已排队或等待重试。
- `processing`：已被某个 worker 原子领取，同时写入 `ocr_lease_until`（120 秒）。
  识别期间每 30 秒心跳续租；进程崩溃后续租停止，租约过期即重新排队。没有租约的
  历史行仍按 `OCR_TIMEOUT_SECONDS + 60s` 的旧规则回收。
- `done`：拿到结果；质量状态单独记录为 pass / review / fail。
- `failed`：永久错误（4xx）或达到最大尝试次数（3 次，退避 60s × 已尝试次数）。
- `skipped`：纯文本等无需 OCR 的附件。

领取使用单条条件 `UPDATE ... RETURNING`，多 worker 并发时不会重复处理同一行。

## 4. 引擎与部署

### 4.1 Paddle sidecar（默认端口 8765）

- 默认模型：`PP-OCRv6_medium_det` + `PP-OCRv6_medium_rec`。
- 初始化失败时依次回退：`PP-OCRv5_server_det/rec` → Paddle 默认模型（带方向分类）
  → 默认模型（不带方向分类）。
- 基础 OCR 保留页面方向分类，但关闭文档去畸变与文本行方向，保证 `auto` 路径速度；
  `enhanced` 模式额外开启这两项预处理。
- `table` / `structure` 使用 `TableRecognitionPipelineV2`，优先固定
  `PP-DocLayout_plus-L`、`PP-LCNet_x1_0_table_cls`、`SLANeXt_wired` /
  `SLANet_plus` 与对应的单元格检测模型；固定组合不可用时退回默认组合。
- 单进程内用锁串行执行抽取，避免多个请求同时占用同一模型实例。

### 4.2 Docling sidecar（默认端口 8766）

- 负责 `.docx` / `.xlsx` / `.pptx`。
- 优先使用 `python-docx` / `openpyxl` / `python-pptx` 原生读取段落、工作表和表格；
  依赖缺失或结果为空时回退 Docling。
- Docling 输出 markdown 后统一归一化，并包装为单页 DIR。

### 4.3 启动方式

两个引擎放在独立虚拟环境，避免依赖冲突：

```bash
~/.venvs/pulse-paddle/bin/python scripts/ocr_sidecar.py \
  --engine paddle --port 8765 --upload-root data/uploads

~/.venvs/pulse-docling/bin/python scripts/ocr_sidecar.py \
  --engine docling --port 8766 --upload-root data/uploads
```

原生抽取的可选依赖见
[`scripts/requirements-native.txt`](../scripts/requirements-native.txt)：
`pdfplumber`、`python-docx`、`openpyxl`、`python-pptx`、`Pillow`。所有依赖都是可选的，
缺失时自动回退到 Paddle 或 Docling。

### 4.4 Sidecar 接口与安全边界

| 接口                   | 说明                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `GET /health`          | 返回引擎、是否就绪、流水线版本、当前模型与运行时版本                                     |
| `POST /extract`        | 入参 `path` / `name` / `mode` / `dpi`，返回文本、置信度、路由、DIR、图像预检与运行时版本 |
| `POST /extract-region` | 入参 `path` / `name` / `page` / `bbox` / `dpi` / `mode` / `padding`，只识别局部区域      |
- 只接受 `--upload-root` 下的绝对路径，解析后校验父目录，阻止路径穿越。
- 可选 `X-OCR-Token`，使用常量时间比较；未配置 token 时不做鉴权。
- 请求体上限 64 KB；缺失 `Content-Length` 返回 411，超限返回 413。
- `mode` 仅允许 `auto` / `table` / `structure` / `enhanced`；非 Paddle 引擎只允许
  `auto`；`table` / `structure` 仅支持图片与 PDF。
- DPI 仅允许 100–400。

解析器侧的加固（评审 #07）：
- 图片像素预算 `MAX_IMAGE_PIXELS = 80_000_000`（同时写入 `Image.MAX_IMAGE_PIXELS`），
  渲染后的 PDF 页超过同一预算时按 422 拒绝，避免解压炸弹式大图耗尽内存。
- Office（OOXML）压缩包预算：解压总量 200 MB、条目数 10 000、压缩比 500
  （`MAX_OFFICE_UNCOMPRESSED_BYTES` / `MAX_OFFICE_ENTRIES` / `MAX_OFFICE_RATIO`）。
- OOXML 条目在解析前只读取头部，出现 `<!DOCTYPE` 或 `<!ENTITY` 即 422 拒绝，
  阻断 XML 外部实体与「billion laughs」类膨胀攻击。
- 加密 PDF 返回 `422 password_required: PDF is encrypted`。Node 侧把该错误映射为
  永久失败（不重试），附件详情显示「PDF 已加密，需要密码后才能读取（不会重复重试）」。
- 容器以 uid/gid `10001` 运行，`cap_drop: ALL`、`no-new-privileges:true`，并设置
  `mem_limit` / `cpus`（见 `docker-compose.yml`）。

## 5. 路由策略

| 输入                                 | 首选路径                                    | 回退 / 说明                                  |
| ------------------------------------ | ------------------------------------------- | -------------------------------------------- |
| XLSX                                 | openpyxl 原生单元格与工作表                 | 缺依赖时 Docling                             |
| DOCX                                 | python-docx 段落与表格                      | 缺依赖时 Docling                             |
| PPTX                                 | python-pptx 幻灯片文本与表格                | 缺依赖时 Docling                             |
| 带文本层 PDF                         | pdfplumber 文本、行框与原生表格             | 混合 PDF 中无文本页渲染后 OCR                |
| 扫描 PDF                             | pypdfium2 渲染 + PaddleOCR                  | PDF 打不开或无文本时直接交给 Paddle PDF 管线 |
| 图片                                 | PP-OCRv6_medium                             | `table` / `structure` 使用 PP-StructureV3    |
| 表格图片                             | PP-StructureV3 + TableRecognitionPipelineV2 | 输出单元格、行、bbox                         |
| 纯文本 / CSV / Markdown / JSON / ZIP | 不 OCR                                      | 标记 `skipped`                               |
| 图表 / 手写 / 复杂版式               | 暂未覆盖                                    | 预留 `vlm` stage 接口                        |

Office 原生抽取（评审 #05）：DOCX 额外读取页眉页脚、文本框、脚注尾注、批注、图表、
媒体与 OLE 嵌入对象；修订痕迹按「保留插入、忽略删除」处理，并统计删除/插入字符数。
XLSX 标记隐藏工作表，读取图表、批注与嵌入对象；PPTX 标记隐藏幻灯片、组合形状与备注页，
并读取图表、图片与 OLE。所有非正文条目写入 DIR，`meta.office` 记录各类计数与
`objects` / `unrendered`。图片与 OLE 内容本身不做原生 OCR，而是计入
`unrendered`，质量层据 `officeCoverage = (objects - unrendered) / objects` 提示
「嵌入对象未识别」，避免把「抽取完成」误当成「内容已全部进入检索」。修订被忽略的
删除文字会以 `info` 说明，而不是静默丢弃。

模式语义：
- `auto`：常规文本与表格混排的快速路径。
- `table`：表格结构化，仅 Paddle，输入为图片或 PDF。
- `structure`：整页版面 + 表格分析，用于弱文本恢复或表格文档。
- `enhanced`：方向矫正、去畸变、文本行方向分类，适合倾斜照片与低质量扫描。

### 5.1 PDF 的逐页决策

1. 先用 pdfplumber 读取每页文本、行框与原生表格。
2. 每页文本层计算 0–1 可信度：综合去空白长度、替换符/控制字符/私用区字符比例与
   可读字符占比（`OCR_PDF_TEXT_TRUST_MIN`，默认 0.6）。可信度达标且不是强制结构
   模式时直接使用原生文本，低可信页交给视觉 OCR。DIR `meta.textLayer` 记录达标页数、
   最低/平均可信度与扣分原因，附件详情显示「PDF 文本层 X/Y 页可信」，未达标时高亮。
3. 可信页按确定性等距抽样交叉验证（`OCR_PDF_TEXT_CROSSCHECK_RATE`，默认 0.1，
   `OCR_PDF_TEXT_CROSSCHECK_MAX_PAGES` 默认 2）：抽样页渲染后重新 OCR，与原生文本
   比较去空白相似度（`OCR_PDF_TEXT_CROSSCHECK_MIN_SIMILARITY`，默认 0.85）。含数字
   最多的可信页优先进入样本（风险页配额至少占 `max_pages` 的一半），整体相似度达标
   但数字 token 不一致时仍单独记 `numericMismatch`。结果写入
   `meta.textLayer.crosscheck`；原生文本不被改写，不一致（含数字 token 不一致）只生成
   `text_layer_mismatch` 质量问题与硬风险，附件详情显示「文本层交叉验证 M/N 页一致」。
4. 否则渲染该页并 OCR；数字页不计入 OCR 页数上限。
5. 原生页与 OCR 页混合时路由记为 `hybrid`，模型标签增加 `+pdf-text` 后缀。
6. 原生页内的嵌入位图区域（图表、截图、扫描插图）也按区域路由：面积占比
   0.04–0.8、尺寸 ≥ 40pt 且原生行文本少于 3 行的图片会被裁剪后单独 OCR，识别块
   坐标映射回 PDF point 并标记 `meta.hybrid = "embedded_image"`；整页位图视为
   OCR 文本层，不重复识别。
7. 单页失败不会丢弃整份文档：记录空页后继续，质量引擎会通过覆盖率发现缺页。
8. 页数上限、总页数上限与时间预算触发时标记 `truncated`，已处理页数只写入
   `meta.truncated / meta.processedPages / meta.totalPages`，不再在正文里追加说明
   文字，避免搜索、字段匹配与 CER 把提示语当成文档内容。

### 5.2 图片与多帧

- TIFF / GIF 按帧拆分，最多 `OCR_MAX_IMAGE_FRAMES`（默认 20）帧。
- 单帧失败或超出上限时标记截断。
- 单选图片按 EXIF 方向自动转正；多帧图片逐帧转为 PNG 后再识别。

## 6. 统一文档中间表示（DIR）

```ts
type DocumentIr = {
  version: 1;
  route: 'native' | 'visual' | 'hybrid';
  pages: DocumentPage[];
  readingOrder: string[];
  meta: Record<string, unknown>;
};
```

- Block 类型：`paragraph` / `heading` / `table` / `formula` / `chart` /
  `handwriting` / `stamp` / `signature` / `header` / `footer` / `image`。
- 每个 block 携带 `bbox`、`confidence`、`source`（引擎、模型、阶段）与
  `validation`（passed / flagged / failed + 问题列表）。
- 表格 block 同时携带 `rows` 与 `cells`（行列、跨行跨列、bbox、文本、引擎给出的单元格置信度）。
- 空页保留 page 记录，便于质量引擎发现「有页无内容」。
- 解析侧上限：200 页、每页 3000 块、单表 5000 单元格、20000 个阅读序条目、
  100k 字符；超出即截断。
- 解析后运行 `src/document-ir.ts` 的确定性整理（不删除、不改写文本）：
  - 跨页重复的顶部/底部文本标记为 `header` / `footer`（数字归一后比较，页码
    `第 1 页` 与 `第 2 页` 视为同一模板），写入 `meta.template` 与
    `meta.templatePages`；
  - 同页 bbox IoU ≥ 0.6 且文本相似度 ≥ 0.85 的重复块，保留来源/置信度更高者，
    另一个写入 `meta.overlapOf`，仅从阅读序中排除；
  - 阅读顺序先按横向跨栏块分带，再按列聚合（列内自上而下），块上记录
    `meta.orderReason` / `meta.orderColumn`；无 bbox 时回退原始顺序；
  - 相邻页底部表格与下一页顶部表格在列数一致、表头相似且列宽分布一致时建立
    `meta.continuedTo` / `meta.continuedFrom`，同时写入 `meta.continuationEvidence`
    （表头相似度、列宽相似度、位置关系）；表头重复时标记 `meta.repeatedHeader`，
    但绝不合并行，`tableChains()` 与 `meta.tableContinuations` 提供只读拼接视图；
  - 无框线表格：`src/ocr-borderless.ts` 对同页短文本行按垂直重叠分组成行、按水平
    中心聚类成列，结合数值/日期占比、列填充率与行间距推断候选表格，写入
    `meta.borderlessTables` 并在参与块上标记 `meta.borderlessTable`；不改动文本或坐标；
  - 统计写入 `meta.refinement`，供质量、UI 与基准使用。

DIR 的价值不只是展示：质量评分、表格校验、基准字段比对与未来的区域级修复都依赖它。

## 7. 质量评估

`src/ocr-quality.ts` 对每次抽取输出 0–1 分、状态、信号与问题清单。

| 信号         | 权重 | 触发问题                                                                                |
| ------------ | ---- | --------------------------------------------------------------------------------------- |
| 平均置信度   | 0.25 | `low_confidence`                                                                        |
| 低置信行占比 | 0.10 | `low_confidence`（低于 `OCR_LOW_CONFIDENCE` 的 block 与表格单元格占比 ≥ 25%）           |
| 文本覆盖率   | 0.20 | `low_coverage` / `empty_page` / `empty_text`                                            |
| 表格完整性   | 0.15 | `table_integrity`（空表、行列不一致、缺单元格）                                         |
| 字段算术校验 | 0.15 | `field_mismatch`（合计/总计与明细不符）                                                 |
| 列类型校验   | 0.10 | `cell_type_mismatch`（金额/日期/数量/比例列出现含数字但无法解析的值）                   |
| 业务约束     | 0.10 | `business_constraint`（借贷不平衡、税额不符、必填列缺失、币种/日期/编号异常）           |
| 单元格复认   | 0.05 | `cell_recovery_conflict`（复认候选与原值冲突）                                          |
| 阅读顺序     | 0.10 | `reading_order`（重复或缺失）                                                           |
| 重复内容     | 0.05 | `duplicate_content`                                                                     |
| 结构校验     | 0.05 | `block_validation`                                                                      |
| 图像质量     | 0.05 | `image_blurry` / `image_exposure` / `image_low_resolution`                              |
| 业务 schema  | 0.10 | `schema_field_missing` / `schema_field_invalid` / `schema_conflict`                     |
| 机读证据     | 0.10 | `machine_readable_confirmed` / `machine_readable_partial` / `machine_readable_mismatch` |
| 预处理选择   | 0.05 | `preprocess_conflict`（增强候选丢失数字 token）                                         |
| Office 覆盖  | 0.05 | `embedded_object_unread` / `tracked_changes_excluded`                                   |

图像质量来自 sidecar 预检（清晰度、亮度、对比度、像素数）。小字通过 DIR 的
`meta.textHeight` 检测并触发 `small_text`。列类型校验从表头推断金额、日期、数量、
比例与数值列，只检查至少有两个数据值的列，并跳过 `-`、`N/A`、`待定` 等占位值；
含数字但无法解析的单元格（如 `1O0`、`2024-1O-02`）才会被标记，≥2 个异常时升级为
不可补偿的 `field_validation_failed`。列类型仅用于校验与恢复触发，不改写单元格文本。

表格会从多级表头推断列结构（`block.meta.columnSchema`），并保留金额的多种可能
解析（`block.meta.numberCandidates`，如 `1,280.00` / `1.280,00` / 歧义的 `1,280`），
原始单元格文本始终不变。业务约束按列标签自动触发：借贷平衡、`税额 ≈ 基数 × 税率`、
币种一致性、日期范围、编号形态与必填列；校验失败只产生问题与硬性风险，不修正数值。
单元格复认结果写入 `document.meta.fieldEvidence` 的 `cell` 记录（行列、表头、是否为
估算 bbox），冲突同样只强制复核。

**独立字段校验**（`src/ocr-field-validation.ts`）不依赖任何识别模型，只用文档自身
的冗余信息交叉验证：`amount_words_mismatch` 比较大写金额（支持 `零` 前缀的角/分，如
`壹佰元零伍分`）与同文内任意小写金额（容忍 `元/千元/万元/百万元/亿元` 表头量纲）；
`identifier_checksum` 只在带标签（统一社会信用代码/身份证/银行卡/账号/IBAN/ISBN/VIN）
时触发，用 Luhn、GB 32100、ISO 7064 MOD 11-2、mod 97、ISBN-10/13 与 VIN 校验位判断，
无标签的一串数字不会被猜测为编号。两者失败都追加不可补偿的 `field_validation_failed`
硬风险，文本仍保持原样。`src/ocr-numeric.ts` 同步支持中文数字与财务大写、全角、
括号负数、尾缀 `-`、`CR/DR` 与量纲归一（`numericSemantics`）。

**机读证据**（评审 #15，`scripts/ocr_sidecar.py` + `src/ocr-quality.ts`）与识别模型
相互独立：sidecar 从页面像素解码二维码（OpenCV，可选 pyzbar 补充一维条码），并从
识别文本中解析 TD1/TD2/TD3 MRZ，按 ICAO 9303 逐字段计算校验位。解码出的业务 token
只用于比对，不写回正文；二维码/条码 token 与文本一致的关键字段块标记为
`confirmed_independent`，条码字段未在正文出现记 `machine_readable_partial` 并升级为
`machine_readable_conflict` 硬风险，MRZ 校验位失败同样不可被高分抵消。MRZ 字段若在 MRZ 带以外被识别到，只按
`confirmed_same_engine` 处理，因为两者都来自同一次 OCR。可用
`OCR_MACHINE_READABLE=0` 关闭符号解码；缺少解码库时仍保留 MRZ 证据。

**文档类型与 schema**（评审 #21，`src/ocr-doc-type.ts`）取代文件名推断：按加权词法
证据与表格线索把文档判为发票、收据、合同、证件、银行回单、采购订单、送货单、对账单
或 `generic`，要求最高分 ≥ 2 且领先第二名 ≥ 1 才给出类型。每种类型定义必填/可选字段、
格式校验与跨字段约束（如合计不得低于税额、甲方与乙方不得同名），输出
`missing` / `invalid` / `conflicts` / `coverage`。类型证据不足时保持 `generic` 且
schema 为空，不改变评分；已判定类型的必填字段缺失只在分类置信度 ≥ 0.7 时升级为硬风险，
格式非法与字段矛盾则始终不可补偿。分类结果写入 `quality.docType` 并展示在附件面板。

**置信度校准**（评审 #31，`src/ocr-calibration.ts`）在标注样本上拟合加权 PAV 等渗
回归，把原始置信度映射为校准置信度；阈值拟合与质量打分都使用校准后的值，避免在
乐观的原始分数上再切一刀。profile 需同时满足最少样本数与正例数才生效，输出 ECE/Brier
与校准前后 ECE，`quality.calibrated` 表示本次是否实际应用了映射。映射只调整分数与
复核阈值，不改写识别文本。
- `score >= OCR_QUALITY_REVIEW_THRESHOLD`（默认 0.7）→ `pass`。
- `score < OCR_QUALITY_FAIL_THRESHOLD`（默认 0.45）→ `fail`。
- 其余 → `review`。
- 阈值配置反转时，强制保留至少 1% 的 `review` 区间。
- 空文本直接 `fail`；结果截断或存在未通过结构校验的 block 时最多只能到 `review`。
- **硬性风险不可被高分抵消**：关键字段（金额/日期/编号/账号/数量）置信度低于
  `OCR_KEY_FIELD_CONFIDENCE`、表格算术校验失败、业务约束校验失败、单元格复认冲突、
  表格结构不完整、图像质量过低或文字高度低于阈值、**独立字段校验失败**（大小写金额
  不一致、带标签的统一社会信用代码/身份证/银行卡/IBAN/ISBN/VIN 校验位不通过）、
  PDF 文本层数字 token 不一致、**页面存在未被任何识别框覆盖的墨迹（墨迹漏检）**时，
  即使加权分很高也强制 `review`。区域复认一致的关键字段是例外：它只提供证据，
  不改写原文。
- **墨迹漏检**（评审 #60）：sidecar 把页面二值化后遮掉已有识别框，再看剩余墨迹是否
  成片。空单元格/占位符（`-`、`N/A`、`暂无`）只遮边框带，内部墨迹会作为 `cell`
  类型的空隙上报，避免「识别为空 = 真的空」。未解析或超出上报上限的空隙单独计数，
  与「分析完成且干净」区分：`meta.inkGaps` 缺失表示分析未运行，空数组才表示已核对无
  遗漏。质量层把仍有空隙的页面记为 `ink_without_text` 硬风险；被补回的空隙会从
  清单里移除，不会重复告警。
- 没有 DIR 的旧引擎走宽松路径：缺失置信度但有文本时不再默认 0.75，而是记入
  `confidence_unknown` 问题、按 `min(复核阈值 - 0.01, 0.5)` 打分并强制 `review`，
  让「无法评分」显式暴露为待复核，而不是伪装成通过。
- 若该文档维度（整体/类型/难度/语言/文件类型/组织）存在已拟合阈值 profile 且已校准，
  运行时使用 profile 的复核/失败/关键字段阈值，否则回退到环境变量默认值；输出的
  `calibrated` 反映本次是否用了已校准 profile。基准同时输出 ECE/Brier，Ops 治理页
  可查看 profile 并用最近基准样本重新拟合。

质量分只用于**路由与复核**，不会修改任何识别文本。输出同时保留四个可解释分量：
`ocrConfidence`、`structureConfidence`、`fieldValidation`、`businessConsistency`。

## 8. 预算级联与恢复

`src/ocr-cascade.ts` 在首次抽取后决定是否追加恢复：

| 场景                                           | 恢复顺序                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| 关键字段置信度低                               | 先做区域复认（最多 4 个区域），候选一致即结束                         |
| 表格单元格无法解析或整表置信度低               | 单元格复认（最多 4 个单元格，复用区域复认通道）                       |
| PDF 有表格问题                                 | `structure`（按文字高度自适应 DPI）→ 更高 DPI                         |
| PDF 弱文本                                     | 自适应 DPI → `structure`                                              |
| PDF 图像模糊/曝光/低分辨率或文字过小           | 自适应 DPI → `enhanced` → `structure`                                 |
| 图片弱文本                                     | `enhanced` → 必要时 `structure`                                       |
| 图片有表格问题                                 | `structure`（在 `enhanced` 之后）                                     |
| 局部恢复后仍不达标且配置了互补模型             | 整页候选复认：互补模型 → 第二引擎（最后一步；评分严格提升才采用）     |
| 配置了可读同格式的第二引擎                     | 整页候选复认（`candidate`，自动模式，最多 1 个引擎）                  |
| 页面有墨迹但没有任何识别框，或空单元格内有墨迹 | 墨迹空隙逐区域复认（`ink_gap`，最后执行；补回文本作为 flagged block） |
| 文案语言与声明语言明显不符                     | 用检测到的语言重跑 `enhanced`（中文/英文兼容）                        |
| 非 Paddle / native 路由 / 已截断               | 不恢复                                                                |

**光度候选自证防护**（评审 #13）：增强预处理由同一识别器生成候选，单看置信度提升
等于「自己证明自己」。sidecar 用原图与增强结果的数字 token 做配对比较：原图有数字
而增强结果丢失且一致度 < 0.8 时判为 `numeric_conflict`，保留原图并标记 `conflict`；
只有减少损坏标记（`corrupt`）、在不丢失 ≥ 90% 原数字的前提下补出 token（`tokens`），
或在 ≥ 95% token 一致、字符数 ≥ 98% 的前提下置信度显著提升（`confidence`）时才采用
增强结果，否则 `no_gain` 保留原图。选择写入 `meta.preprocess.pages[].ocrSelection`，
质量层对冲突报 `preprocess_conflict` 硬风险，附件面板显示「预处理冲突 X/Y 页」。
- 首次结果 `pass` 或截断即结束；声明语言与实测文字脚本明显不符时即使 `pass` 也追加一次
  语言纠正恢复（如声明 `en` 却识别出中文），不会静默采用错误语言的模型。
- 否则先尝试局部区域复认。
- **区域复认**：只裁剪关键字段区域（bbox + 上下文边距）重新识别，候选文本只作为
  证据写入 `document.meta.fieldEvidence`，并标记 `regionAgreement`。第一遍为
  `auto` + 35% 边距；不一致时自动追加第二遍 `enhanced` + 60% 边距，必要时可用
  `OCR_REGION_PASSES=3` 再提高 100 DPI（上限 400）。首遍一致即停止，避免浪费预算。
- **N-best 与一致性**：每个候选保留 pass、mode、DPI、边距、置信度、模型与
  `agreesWithInitial`。所有成功候选都与原文一致时，还要看复认是否**独立**：只有
  另一引擎/另一模型（`confirmed_independent`）才能降低关键字段风险；同模型重读
  （`confirmed_same_engine`）只能证明可重复性，仍保留低置信风险。出现高置信度
  不一致标记 `conflict`；只有低置信度分歧则标记 `unverified`。冲突与未确认都保留
  原文；**任何情况下都不自动替换文本**。旧版文档里单一的 `confirmed` 在读取时按
  `confirmed_same_engine` 处理，不冒充独立证据。
- **单元格复认**：金额/日期/数量/比例/数值列中无法解析的单元格优先，其次是低置信度
  整表中的类型化单元格；使用单元格 bbox，缺坐标时按表 bbox 与行列数估算并标记
  `bboxEstimated`。候选命中已有数字或日期语义即视为一致；多遍一致且高置信度时，
  无法解析的原值可被标记为 `candidate_selected`，但单元格文本仍保持原样，选择只
  存在于 `fieldEvidence`。上限由 `OCR_CELL_MAX_CANDIDATES`（默认 4）与
  `OCR_CELL_PASSES`（默认 2）控制。
- **整页候选复认**：局部复认与 VLM 之后仍有预算时，依次尝试互补模型和可读同格式的第
  二引擎，用其重跑整页（阶段 `candidate`，触发 `low_confidence`）。模型候选来自注册表/
  路由给出的 `fallbackModels`；引擎候选来自 `OcrClient.candidatesFor`——只有该格式被
  两个已配置引擎同时支持时才会出现（当前 Docling 额外支持 PDF 与页面图片，因此
  Paddle 的 PDF/图片存在 Docling 候选；Office 仍只有 Docling）。引擎候选固定使用
  `auto` 模式且不继承主引擎的模型 profile。阶段消息记录与原结果的字符一致度、质量分
  变化与是否采用；只有分层评分严格提升才替换最佳结果，否则保留原文本；截断的候选
  即使分数更高也不会替换完整结果。`OcrStage.engine`
  记录实际执行引擎，重放时按该引擎执行，保证跨引擎阶段可复现。附件详情按阶段显示
  引擎、模型、状态与判定文案；Ops 阶段重放按「阶段 + 引擎 + 第几次」选择，并在结果
  中回显实际重放引擎。Docling 候选的 DIR 简化为整页 Markdown，在表格/版面权重高的
  页面上通常只作为交叉证据，不会仅凭文本相似替换 Paddle 结果。
- **墨迹空隙复认**：当 sidecar 上报的墨迹空隙仍有剩余（页面空隙或空单元格内的
  墨迹），且预算允许时，按空隙 bbox 重读并作为独立阶段 `ink_gap` 执行。补回的文本
  以 `source.stage = recovery` 的 block 追加，带 `validation.status = flagged` 与
  `ink_without_text` 问题，按阅读顺序并入正文，并进入人工复核；它不会静默改写
  原 block，也不会被当成一次普通的识别成功。已解决的空隙从 `meta.inkGaps` 中移除，
  质量层据此停止告警。单次最多复认 `OCR_INK_MAX_REGIONS`（默认 3）处。
- **自适应 DPI**：根据 DIR 实测文字高度计算目标 DPI（目标约 24px 字高，50 为步长，
  上限 400），不再固定 200 → 300 → 400 阶梯。
- 每步最多 `OCR_CASCADE_MAX_STAGES`（默认 3，含首次），总时长不超过
  `OCR_CASCADE_BUDGET_SECONDS`（默认 180 秒）；区域复认同样计入阶段与预算。
- 恢复成功概率并非固定：worker 统计每次恢复是否把质量分提升超过 0.005，累计到
  `ocr_recovery_yields`；达到 `OCR_RECOVERY_YIELD_MIN_SAMPLES`（默认 5）后以 Beta
  平滑替换硬编码先验，样本不足仍用先验。治理面板「恢复收益」可查看。
- 恢复请求按 `引擎 + mode + DPI + 语言 + 模型` 去重，避免结构恢复与 DPI 恢复收敛成
  同一次调用。
- 单步失败只记录 `failed` stage，不影响已有最佳结果。
- 结果按层选择：硬性风险更少 → 关键字段覆盖率更高 → 页面/区域覆盖率更高 →
  字段校验通过率更高 → 表格完整性更好 → 阅读顺序更合理 → 融合分更高。融合分差在
  0.005 以内视为平手并保留已有结果，避免更高分候选掩盖漏页、漏字段或结构缺失。
- 每个阶段的 `kind / status / mode / DPI / 耗时 / 分数 / 错误` 都会持久化，可在
  附件详情与基准结果中查看。
- **可重放**：每个阶段同时保存输入文件 SHA256、输出 DIR 指纹（`outputSha256`）、
  完整请求参数（`params`：mode/DPI/页/bbox/边距/模型 profile）、实际执行引擎
  （`engine`）与评分快照（`quality`：分数、状态、
  问题码、硬性风险与信号）。`replayOcrStage` 按记录中的引擎重放整页，或指定
  `page + bbox + padding` 只重放单个区域；返回输入/输出哈希是否一致、分数变化与
  重放质量，用于判断一次改动是否真正改善结果。基准运行可通过
  `POST /api/ocr/lab/replay` 触发（仅工作区管理员）。

## 9. 缓存、复用与重跑

缓存键由五部分组成：

```text
sha256 + engine + engineModel（模型@pipeline@运行时版本）+ configHash + mode + dpi
```

- 内容相同的附件直接复用已有结果，避免重复识别。
- `pipeline` 版本（当前 `dir2`）或 Paddle/PaddleOCR 运行时版本变化会使旧缓存失效，
  后处理或底层库升级后不会复用旧文本。
- `configHash` 是 `ocrConfigFingerprint()` 对所有会影响识别结果的 OCR 环境变量
  （`OCR_LANGS/OCR_MODES/OCR_MODEL/OCR_PADDLE_*/OCR_PDF_*/OCR_PREPROCESS_*/`
  `OCR_CASCADE_*/OCR_REGION_*/OCR_CELL_*/OCR_VLM_*/OCR_SPECIALIZED_*/OCR_HYBRID_*/`
  `OCR_MAX_*/OCR_CHANNELS/OCR_CONTROL_MODEL/OCR_GREY_*`）计算的 16 位摘要；
  端点 URL、Token 以及只影响复核/门禁的阈值不参与哈希。调阈值不会作废缓存，
  改 DPI 阶梯、语言、模型或预处理参数则必须重识别。
- 质量 `fail` 的结果不参与复用，避免坏结果扩散。
- 复用范围限定在**同一客户/组织**内：`findReusableOcr()` 比较候选与所有者的
  `workspace_id`（两侧都用 `COALESCE(...,'')` 归一，未归属组织的附件只与同样未归属的
  结果互相复用）。此前仅按内容哈希复用，两个客户上传同一份模板文件时可能读到对方的
  识别结果，属于跨租户数据泄露（评审 #12 / #49）。
- 复用查询同时排除 `fail`、已删除项目与正在处理的附件，命中后仍按当前阈值重新评分。
- 引入指纹之前完成的附件 `ocr_config_hash` 为 `NULL`，不会被新写入的结果复用；
  这类附件在下次上传相同字节时会重新识别并补上指纹。
- `review` 结果可以复用，但会按当前阈值重新评分并保留复核标记。
- 复用与重跑都不信任历史质量分，始终用当前配置重新评估。
- 手动重跑只允许 `done` / `failed` 的附件，且会在排队时清空路由、DIR、质量、
  阶段与复核标记，防止展示过期元数据。
- 无需 OCR 的附件（如纯文本）调用重跑会返回 400。

## 10. 基准与持续优化

语料目录默认 `benchmarks/ocr/`，可通过 `OCR_BENCH_DIR` 修改。目录内放样本与
`ground_truth.json`：

```json
{
  "table.png": {
    "kind": "table",
    "lang": "zh",
    "difficulty": "moderate",
    "degradations": ["skew", "low_dpi"],
    "keywords": ["产品", "数量", "单价", "金额"],
    "fields": { "total": "12,800.00" },
    "uncertain": ["tax"],
    "provenance": {
      "annotator": "alice",
      "reviewer": "bob",
      "annotatedAt": "2026-01-01",
      "sha256": "…",
      "source": "scan"
    },
    "tables": [
      {
        "rows": [["产品", "金额"], ["A", "12,800.00"]],
        "cells": [{ "row": 0, "column": 0, "text": "产品", "rowSpan": 1, "columnSpan": 1 }]
      }
    ],
    "conditions": { "mode": "structure", "dpi": 300 }
  }
}
```

- 每个样本可配置 `text`、`keywords`、`fields`、`tables`、`conditions`，以及分层的
  `lang`、`difficulty`（clean/mild/moderate/severe）、`degradations`。
- `provenance` 记录标注人、复核人、时间、原始文件 SHA256 与来源；运行时会重新计算
  文件哈希并给出 `hashVerified`（未声明哈希时为 null），不一致不会阻止运行但会显式
  标记，避免样本被替换后仍沿用旧指标。
- `uncertain` 中的字段真值仍有争议，不计入字段、业务损失与全对率，避免用错标注
  优化模型。
- `tables` 提供表格结构真值（行、可选单元格跨度与 bbox）；没有表格真值的样本不参与
  表格结构指标与门禁。
- 扩展语料位于 `benchmarks/corpus-v2/{wide-tables,degraded-layout,semantic-regions}/`
  （6 / 8 / 7 个样本），每个包附带生成脚本 `scripts/generate_*_corpus.py` 与
  `--check` 校验（SHA256、文件/真值双射、JSON 规范化）。`test/ocr-corpus.test.ts`
  在不依赖 Python 的情况下复核三个包的完整性与哈希；基准运行用 `OCR_BENCH_DIR`
  指向单个包，因为加载器只读取目录顶层文件。
- 语料切分（评审 #45）：在同一份 `ground_truth.json` 上按**模板族**划分
  `dev`（调参）/ `calibration`（拟合阈值）/ `blind`（发布门禁）三个角色。模板族键为
  `kind + 去掉变体后缀的文件名`（`_clean`、`_skew`、`_blur`、`_v2` 等后缀会被折叠），
  因此同一份文档的退化变体一定落在同一角色里，不会「用同一页的清晰版调参、再用倾斜版
  验证」。角色由 `fnv1a(OCR_BENCH_SPLIT_SALT|模板族)` 的确定性哈希按
  `OCR_BENCH_DEV_SHARE`（默认 0.6）/ `OCR_BENCH_CALIBRATION_SHARE`（默认 0.2）
  的累计比例分配，同一盐值下结果稳定可复现；真值条目里也可以显式写 `split` 固定角色。
- 门禁只在 `blind` 子集上判定：聚合指标（CER、字段准确率、全对率、最差分组等）
  仍按全量计算并展示，但 `gate.checks` 的数值来自盲测子集，避免「在同一份数据上调参
  又在这份数据上宣布达标」。`blind_evidence` 检查要求盲测子集至少有
  `OCR_GATE_MIN_BLIND_FILES`（默认 3）个文件；语料完全没有 `split` 标签时该检查为
  「未评估」，门禁回退到全量判定并在 UI 上显示退位说明。阈值拟合
  （`POST /api/ocr/calibration/fit`）只使用 `calibration` 子集，同样不允许用调参样本拟合。
- Ops 页面的基准区新增「语料切分」一行，展示三个角色的文件数/评估数与门禁所用子集，
  逐文件结果上标注所属角色。
- `benchmarks/corpus-v2/` 的三个合成包（宽表、退化版面、语义区域）作为**独立的回归层**：
  它们与 `benchmarks/ocr/` 分开运行，用于覆盖真实语料里没有的失败模式，
  不计入同一份门禁结论。
- 默认包含 PDF；Ops 页面可取消勾选（耗时更长）。发布门禁默认要求语料至少有一个
  PDF 样本（`OCR_GATE_REQUIRE_PDF=1`、`OCR_GATE_MIN_PDF_FILES`），没有 PDF 证据时
  `pdf_evidence` 检查不通过——native-first 的核心路径不能被静默排除在发布验证之外。
- 运行方式：Ops 页面「运行基准」或 `POST /api/ocr/lab/run`，仅工作区管理员可用。
- 结果持久化，支持查看当前运行、逐文件结果、聚合指标与历史运行摘要。

| 指标           | 定义                                                                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原始 CER       | 保留大小写与标点，仅折叠空白（CJK 之间的换行空白不计错）                                                                                                       |
| CER            | 小写并只保留字母、数字与 `%` 后的字符错误率                                                                                                                    |
| 数值 CER       | 只比较数字 token；全角数字/小数点/百分号归一，千分位去除，逗号列表保留                                                                                         |
| 关键符号 CER   | 只保留金额关键符号骨架（小数点、千分位、正负号、括号、货币符、百分号）后比较；数字本身错误归数值 CER，丢失 `-`、`.`、`,`、`()` 归此项；真值无关键符号时为 null |
| WER            | 空格分词语言（拉丁字母/数字）的词级错误率；CJK 以 CER 为准                                                                                                     |
| 关键词召回     | 归一化后按关键词是否出现计算命中率，适合无法逐字比对的表格/PDF                                                                                                 |
| 字段弱命中     | 归一化后逐字段判断是否出现在全文，输出命中数、比例与 95% Wilson 区间；用于召回观察，不单独作为发布证据                                                         |
| 字段强命中     | 命中必须能定位：标注页/bbox、真值上下文，或同一 block 内长度 ≥2 的标签旁的值；无法定位的字段记为 `unverifiable` 并排除在分母外                                 |
| 字段精确率     | 仅折叠空白后逐字段精确匹配，保留千分位、百分号等格式差异                                                                                                       |
| 文档全对率     | 所有（非 uncertain）字段命中且 CER 为 0 的文档比例，附 95% Wilson 区间                                                                                         |
| 业务损失       | 按字段风险加权的误差：金额/账号权重 8、日期 4、币种/编号 3、数量 2，文本 1；数值字段按最接近数字串的编辑距离计分                                               |
| 表格结构       | 行/列签名 F1、同位置单元格准确率、bbox IoU（真值提供坐标时）、合并单元格跨度准确率与简化 TEDS                                                                  |
| 错误分类       | 字符替换/插入/删除、缺失字段，以及表格结构、阅读顺序、重复文本等类型；输出 Top 分类、计数与前 3 个样本                                                         |
| 置信度校准     | 置信度与全对结果的分箱对比，输出 ECE 与 Brier 分数                                                                                                             |
| 分组校准       | 按文档类型与语言分别输出 ECE/Brier；样本不足时只报告样本数                                                                                                     |
| 字段类别可靠性 | 将字段按金额/日期/账号/编号/数量/比例/币种归类，输出命中率、95% Wilson 区间、可定位样本数与口径（强/混合/弱）及类别内 ECE/Brier                                |
| 分层结果       | 按文档类型、语言、难度与退化类型分别统计 CER、字段准确率及其样本数、全对率与页数                                                                               |
| 样本规模       | 文档数、评估数、总页数与总字符数，避免小样本波动被误读                                                                                                         |
| 质量分/状态    | 观察启发式分数与真实错误的相关性                                                                                                                               |
| 路由/阶段/耗时 | 评估 native 占比、恢复次数与成本                                                                                                                               |

**发布门禁**：聚合结果会按环境变量检查 CER 上限、数值 CER 上限、关键符号 CER 上限
（`OCR_GATE_MAX_SYMBOL_CER`，默认 0.01）、**字段强命中率下限**
（`OCR_GATE_MIN_FIELD_STRONG_ACCURACY`，默认 0.9）、全对率下限、失败率上限、
加权业务损失上限与表格 TEDS 下限；任一项不满足即 `gate.passed = false`。
字段门禁只看能定位的命中：值出现在全文任意位置不再算数，找不到定位证据的字段被
记入 `fieldStrong.unverifiable`，既不进分子也不进分母；如果整份语料没有任何字段
可以定位，该项为「未评估」而不是默认通过。旧运行没有该计数字段时以 null 保存，
UI 不会把它显示成 0。点估计在小语料上靠运气就能通过，因此门禁额外检查**Wilson 95%
下界**：字段强命中下界（`OCR_GATE_MIN_FIELD_ACCURACY_LOWER`，默认 0.9）与全对率下界
（`OCR_GATE_MIN_FULLY_CORRECT_LOWER`，默认 0.7）。高风险字段类别单独设门槛：
金额/账号默认 0.99（`OCR_GATE_MIN_AMOUNT_ACCURACY` / `OCR_GATE_MIN_ACCOUNT_ACCURACY`），
日期/编号默认 0.95（`OCR_GATE_MIN_DATE_ACCURACY` / `OCR_GATE_MIN_IDENTIFIER_ACCURACY`），
且该类样本数必须 ≥ `OCR_GATE_MIN_CATEGORY_SAMPLES`（默认 30）——样本不足时检查
直接判为未通过，而不是放行。类别按口径标注：全部可定位为「强」，部分可定位为
「混合」，完全无法定位为「弱」；弱/混合口径的类别检查会带 `note`，提醒该数字仍含
全文包含成分。文档类型（`kind`）还会按 `OCR_GATE_MAX_CER_<KIND>` 单独检查，
未配置时回退到 `OCR_GATE_MAX_CER`，避免总体 CER 合格但某一类文档严重退化。
最差分组门禁在文档类型、语言、难度与退化类型维度上查找文件数 ≥
`OCR_GATE_WORST_GROUP_MIN_FILES`（默认 3）且字段比较数 ≥
`OCR_GATE_WORST_GROUP_MIN_FIELDS`（默认 3）的桶，优先用强命中率比较；某桶没有可
定位字段时才退回全文包含并附 `note`。检查最差 CER
（`OCR_GATE_MAX_WORST_GROUP_CER`，默认 0.15）与最差字段准确率
（`OCR_GATE_MIN_WORST_GROUP_FIELD_ACCURACY`，默认 0.85），防止总体平均掩盖单一
严重退化分组，或让单文件/单字段桶误触发门禁。两项检查会把命中的分组写入 `group`，
Ops 页面据此显示「最差分组 CER（语言：ja）」等归因，并在分层表列出字段样本数。
没有表格真值时该项为「未评估」，不会阻塞门禁。`pdf_evidence` 检查在语料没有任何 PDF
样本时判为未通过（`OCR_GATE_REQUIRE_PDF=0` 可关闭，`OCR_GATE_MIN_PDF_FILES` 可调下限）。
**样本量诚实**：每个比率检查都会按阈值反推所需观测数并写入 `requiredSamples`；观测数
不足而点估计恰好通过的检查仍记为通过，但会在 `evidence_sufficiency` 检查里汇总为
「证据不足」，门禁整体判为未达标——除非显式设置 `OCR_GATE_ALLOW_THIN_EVIDENCE=1`。
Ops 页把「低于阈值」与「样本不足」分开显示：前者叫「未达标」，后者叫「证据不足」，
并列出还差哪些指标、各需多少观测。门禁只用于发布决策，不修改逐文件结果。Ops 页面展示聚合指标、分层表、错误分类与
样本链接、校准、业务损失、表格结构及门禁明细；未通过项在门禁明细顶部以高亮提示
汇总，逐项显示中文名称、实际值、阈值与「通过/未通过/未评估」状态。

基准的用途是**回归与相对比较**：同一语料上比较模型、模式、DPI 或后处理改动前后的
变化。当前语料规模较小，指标不代表生产总体准确率。

推荐的验证流程：
1. 固定语料与 `conditions`，先跑一次基线并保留历史。
2. 一次只改一个变量（模型、模式、DPI 或后处理），避免收益无法归因。
3. 业务关键场景优先看**数值 CER** 与**字段准确率**，再结合整体 CER。
4. 同时观察路由、阶段数与耗时，确认准确率提升没有带来不可接受的成本。
5. 出现回退时对比历史结果定位是哪类样本变差，再决定是否保留改动。

### 10.1 生产错误自动回流与主动学习

OCR 完成后由 worker（含缓存复用）、附件上传复用、字段人工修订和用户投诉四个入口
调用 `OcrGovernanceStore.completeOcrFeedback` / `reportComplaint`，把问题样本写入
`ocr_feedback_samples`。回流逻辑只记录附件、字段、page/block/bbox 和信号，不复制或
改写识别原文。
- 错误类型：`low_confidence`、`model_disagreement`、`field_validation`、
  `human_revision`、`user_complaint`；同一文档每类最多一条草案。
- 去重键：`sha256 ?? attachmentId` + 错误类型；重复回流不会产生新行。
- 信号：`uncertainty`（由 confidence 线性映射，缺少 confidence 时按质量状态估计）、
  `disagreement`（字段冲突/未确认/多模型文本差异，字段校验失败时下限 0.5）、
  `fieldFailure`（失败/标记字段比例、`signals.fieldAccuracy`、硬风险）、
  `novelty`（按池内文档类别计数，新类别更高）、`revision`（存在人工修订）。
- 优先级：`0.3×uncertainty + 0.3×disagreement + 0.25×fieldFailure + 0.1×novelty +
  0.05×revision`，保证困难样本优先但不被单一信号完全支配。
- 抽样：按「错误类型 × 文档类别」分层，每组按优先级降序轮询取样，受
  `perStratum` 与 `total` 双重预算限制；抽样后状态变为 `sampled`，可流转为
  `labeled` / `dismissed`，标注时间单独记录。

| 接口                                      | 权限         | 说明                                        |
| ----------------------------------------- | ------------ | ------------------------------------------- |
| `GET /api/ocr/feedback`                   | 工作区管理员 | 样本池汇总与样本列表，可按状态/错误类型过滤 |
| `POST /api/ocr/feedback/sync`             | 工作区管理员 | 回填最近 N 天已完成 OCR，返回新增数量       |
| `POST /api/ocr/feedback/sample`           | 工作区管理员 | 分层主动学习抽样并标记 `sampled`            |
| `POST /api/ocr/feedback/:id/status`       | 工作区管理员 | 标记 `pool` / `labeled` / `dismissed`       |
| `POST .../attachments/:id/ocr/complaints` | 项目成员     | 用户投诉，写入样本池，不修改 OCR 原文       |

### 10.2 生产质量看板与数据漂移

`GET /api/ocr/quality/dashboard?days=N` 聚合最近 N 天（1–365）的 OCR 元数据，默认
30 天。看板不返回文档正文，只返回统计值：
- 总量与比率：文档数、完成/失败/排队/处理中、失败率、复核率、截断率、修订观察率
  （有修订文档数 / 完成数，`revisionObservedRate`）、修订总数。
- 代理指标：`confidenceRiskProxy = 1 − 平均 confidence`；生产流量没有真值，因此该值
  只用于趋势监控，不能替代基准 CER。`revisionObservedRate` 同样只是人工修订的观察值，
  不等于真实字段错误率。Ops 看板的表头与指标卡显式标注「（代理）」，避免被读成真实
  CER/字段错误率。
- 延迟与吞吐：平均耗时、p95 耗时、总页数、总字符数与字符/秒。
- 分组：模型（`engine:model`）、语言、文件类型、业务类型（按文件名推断发票/收据/
  合同/报告/证件/表格等，不读取正文）、页数区间（1、2-3、4-10、11-20、21+）
  与处理阶段（运行/失败/跳过次数、累计耗时）。

漂移检测对生产输入的分辨率、语言、文件类型、页面尺寸、噪声和版面六类元数据建立
分布，使用 total variation distance 与基准比较；阈值默认 0.2，基线少于 20 个样本或
当前窗口少于 10 个样本时状态为 `insufficient`，不会误报。超过阈值即生成
`warn`（≥1.75× 阈值为 `critical`）告警，列出偏移最大的 3 个桶并给出补充语料、
重新评估的建议。基准是显式快照（`ocr_drift_baseline`），告警按
「维度 + 日期」去重持久化到 `ocr_drift_alerts`，避免每天重复刷屏。

| 接口                             | 权限         | 说明                               |
| -------------------------------- | ------------ | ---------------------------------- |
| `GET /api/ocr/quality/dashboard` | 工作区管理员 | 生产看板、反馈池摘要与最近告警     |
| `GET /api/ocr/drift`             | 工作区管理员 | 当前分布、六维报告与告警历史       |
| `POST /api/ocr/drift/baseline`   | 工作区管理员 | 保存基线；少于 20 个样本返回 422   |
| `POST /api/ocr/drift/check`      | 工作区管理员 | 计算漂移并持久化新告警（按天去重） |

### 10.3 版本链与优化台账

`GET .../ocr/versions` 把一次识别的完整血缘组装为不可变节点链：
1. `original`：原始 OCR 文本摘要、引擎/模型、路由、模式、DPI、质量状态。
2. `stage`：级联各阶段的输入/输出 SHA-256、触发原因、决策、参数、质量和耗时。
3. `selection`：字段候选选择，保留原始文本、选中候选、候选模型、轮次与失败摘要。
4. `revision`：人工修订文本、原始值、原因、修改人和证据区域。

每个节点带 `parents` 指向前一步（修订优先挂在对应字段选择上），因此任何最终值都能
回溯到原图、模型、配置和操作者；版本链只读，不覆盖原始文本。用户投诉通过
`POST .../ocr/complaints` 进入反馈池并记录审计事件。

### 10.4 通过文档随机审计与静默错误率

自动判定为 `pass` 的文档不会进入任何标注队列，因此错误样本池统计出来的「错误率」
带有选择偏差：它只描述被系统怀疑的那部分文档（评审 #38）。`src/stores/ocr-audits.ts`
- `ocr_pass_audits` 表补上无偏的一路：

* **抽样总体**：`ocr_status = done`、有文本、未截断、`ocr_quality_status = pass`
  且 `ocr_review_required = 0` 的附件。
* **分层与顺序**：按文件类型（扩展名）分层；层内顺序由
  `sha256(period|attachmentId|OCR_AUDIT_SALT)` 决定，同一周期同一盐值可复现，
  换盐值即换一批样本。数量取 `min(perType, ceil(层内总数 × fraction))`，
  已被抽过的附件不再重复入池（`UNIQUE (attachment_id)`）。
* **接口**：`GET /api/ocr/pass-audits`（队列 + 统计 + 当前周期）、
  `POST /api/ocr/pass-audits/sample`（`fraction` 0.001–0.2、`perType` 1–50、
  `period` `YYYY-Www`）、`POST /api/ocr/pass-audits/:id/verdict`，均仅工作区管理员可用，
  并写入 `ocr.pass_audit_sampled` / `ocr.pass_audited` 审计事件。
* **双人独立复核**：结论只接受 `clean` / `error`，同一人重复提交覆盖自己那一栏；
  第一栏空闲记为一审，否则记二审，两栏都已由他人填写时返回 400
  「该样本已有两名复核人，需要第三人重新抽样」。
* **共识口径**：只有一审 → `pending`（不算审结）；两审一致 → 该结论；两审不同 →
  `disputed`。**静默错误率 = (error + disputed) / audited**，附 95% Wilson 区间
  （`src/stats.ts`），另输出分歧率、抽样覆盖率与按文件类型的同口径明细。
* **反哺阈值拟合**：审结样本以 `correct = (status === 'clean')`、
  `severe = (status !== 'clean')` 进入 `OcrCalibrationSample` 集合，与基准样本合并后
  参与 `POST /api/ocr/calibration/fit`，使阈值不再只由「系统主动怀疑」的样本决定。
* **UI**：Ops →「OCR 生产治理」→「通过文档随机审计」，展示静默错误率与区间、
  覆盖率、分歧率、抽样比例/每类上限输入、队列筛选（待复核/已审结/全部）、
  逐条一审二审与结论、干净/有错按钮与说明输入，以及按文件类型的明细表。

`ocr_optimizations` 是持续优化台账：每条记录目标错误类型、预期收益（0–1）、实现
成本（人日）、推理成本（相对值）、风险、基准结果、生产观察、状态
（`proposed` / `implemented` / `measured` / `rolled_back`）和创建人。排序分
`expectedGain / max(0.1, implementationCost + inferenceCost)`，用同一把尺子比较
不同优化项，避免同时引入多个改动后无法归因。接口：
`GET/POST /api/ocr/optimizations`、`PATCH /api/ocr/optimizations/:id`，仅工作区
管理员可维护。

## 11. 为提升识别率做的优化

### 11.1 减少需要识别的内容

| 优化                        | 解决的问题                                         |
| --------------------------- | -------------------------------------------------- |
| 原生 Office / 数字 PDF 抽取 | OCR 对清晰文本反而可能引入错字；原生文本零识别误差 |
| 混合 PDF 逐页路由           | 一份 PDF 里数字页与扫描页共存时，不再整篇 OCR      |
| 纯文本格式跳过              | 避免无意义调用与错误覆盖                           |
| 内容哈希复用                | 同一文件重复上传不再产生不同结果                   |

### 11.2 输入质量与预处理

| 优化                                                                | 解决的问题                                                            |
| ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 图像预检（清晰度/亮度/对比度/像素数/反光/阴影/噪声/倾斜/EXIF 方向） | 模糊、欠曝/过曝、低分辨率、反光、阴影、噪声、倾斜图片在识别前就被标记 |
| 重拍建议（`retake`）                                                | 反光严重或分辨率过低时直接建议重新采集，而不是硬做后处理              |
| 按实测文字高度自适应 DPI                                            | 小字直接升到足够 DPI，大字不做无谓渲染                                |
| `enhanced` 模式启用方向分类、去畸变、文本行方向                     | 倾斜照片、倒置扫描、弯曲页面                                          |
| 有界光度候选（阴影校正/对比度/降噪/锐化/Otsu/自适应/红通道）        | 提升低对比、阴影、手机照片的可识别性，候选评分必须超过原图才采用      |
| 可选透视矫正/去倾斜并反算 bbox                                      | 拍摄畸变下仍保持区域复认与 DIR 坐标对齐                               |
| 多帧 TIFF / GIF 逐帧识别                                            | 只读第一帧导致漏页                                                    |
| 表格网格检测（`has_table_grid`）                                    | 普通 `auto` 路径也能识别出表格块                                      |
| 单页失败继续处理其余页                                              | 一页损坏不再导致整份文档无结果                                        |

### 11.3 模型与流水线选择

| 优化                              | 解决的问题                       |
| --------------------------------- | -------------------------------- |
| 默认 PP-OCRv6_medium              | 使用较新模型，兼顾中英混排与速度 |
| v6 不可用时回退 PP-OCRv5_server   | 新模型下载失败时仍可服务         |
| PP-StructureV3 + 固定表格模型组合 | 复杂表格的行列与合并单元格更稳定 |
| 表格流水线失败时回退行级 OCR      | 结构模型不可用时不至于整页失败   |
| Docling 作为 Office 兜底          | 原生库缺失时仍能抽取             |

### 11.4 结构感知与阅读顺序

| 优化                                        | 解决的问题                               |
| ------------------------------------------- | ---------------------------------------- |
| 行级 bbox 分组与按位置排序                  | 多栏、表格混排时文本顺序错乱             |
| 原生 PDF 表格区域内的行文本去重             | 表格文本同时出现在行块与表格块，导致重复 |
| structure 模式过滤表格区域内的整体 OCR 块   | 表格内容被识别两遍，污染全文与置信度     |
| 跨栏标题分带 + 列感知阅读顺序（含排序依据） | 多栏页只按 y/x 排序会串栏                |
| 原生页内嵌入位图独立 OCR 并反算坐标         | 扫描插图、截图文字藏在文本层之外被漏掉   |
| structure 模式解析版面标签并写入 `meta`     | 标题、公式、页眉页脚、印章混入正文       |
| 启发式标题/公式/脚注提示                    | 无版面模型时也能隔离大字号行与公式行     |
| 只对表格网格区域走表格分组                  | 整页判定为表格会把标题和表后说明并入表格 |
| 颜色区域提示印章与蓝色签名                  | 彩色印章/签名文字污染正文与字段匹配      |
| 同位置重复块按来源优先级标记而非删除        | 整页 OCR、行 OCR、表格 OCR 输出重叠内容  |
| 重复页眉页脚模板标记与跨页表格关联          | 页码/水印污染关键词，续表被误认为新表    |

### 11.5 文本后处理

| 优化                                              | 解决的问题                                    |
| ------------------------------------------------- | --------------------------------------------- |
| 全角数字分隔符归一（`1，280，500` → `1,280,500`） | 中文识别器输出的全角逗号/句点导致数值解析失败 |
| HTML 实体反转义、NBSP 归一                        | Docling markdown 转义与 OCR 回显实体          |
| CJK 与拉丁/数字边界补空格                         | 混排文本粘连，影响关键词与字段匹配            |
| 冒号、句末标点后补空格                            | 中英混排可读性与分词                          |
| 控制字符清理与换行统一                            | 不可见字符干扰比对与展示                      |

归一化不覆盖引擎原文（评审 #19）：上述规则会在 CJK 与拉丁/数字边界补空格、把全角
分隔符转成半角，直接改写原文会让 `SH20240101` 这类编号被拆开、也让「识别是否忠实于原图」
无法回答。因此 sidecar 同时返回两份文本：
- `text`：归一化后的展示文本，写入 `attachments.ocr_text`，用于预览、关键词匹配与字段抽取。
- `rawText`：引擎原文，写入 `attachments.ocr_raw_text`（旧数据为 `NULL` 时回退到 `ocr_text`），
  知识图谱与实体对齐只读这一份，空格差异不会把同一编号拆成两个实体。
- 附件详情在两份文本不一致时提供「查看引擎原文 / 查看归一文本」切换，默认展示归一文本。
- 归一只影响空白与全角符号，不参与金额、日期、编号的字符替换；数值与标识符的解析
  仍由 `src/ocr-numeric.ts` 与字段校验负责。

### 11.6 质量驱动的定向恢复

| 优化                       | 解决的问题                                 |
| -------------------------- | ------------------------------------------ |
| 多信号加权而不是只看置信度 | 置信度高但漏页、表格错行、合计不符的情况   |
| 按问题类型选择恢复方式     | 表格问题优先结构分析，模糊文本优先增强/DPI |
| 关键字段区域复认           | 整页重跑成本高，局部复认即可确认或暴露冲突 |
| 不一致时追加宽边距增强复认 | 单次裁剪偏差导致误判，二次视角提高可比性   |
| 保留 N-best 候选与来源     | 出现分歧时复核人员能比较 pass/mode/置信度  |
| 复认候选只作证据           | 避免用另一次识别结果静默覆盖原文           |
| 保留最高分结果             | 恢复失败不会覆盖原本可用的文本             |
| 阶段与时间预算             | 避免低质量文档无限重试、拖垮队列           |
| native / 截断结果不恢复    | 确定性结果重复调用没有收益                 |
| `mode + DPI` 去重          | 结构恢复与 DPI 恢复收敛时避免重复调用      |

### 11.7 结果校验

| 优化                    | 解决的问题                                     |
| ----------------------- | ---------------------------------------------- |
| 表格行列一致性与填充率  | 错行、缺列、空表                               |
| 表格结构 TEDS 与行列 F1 | 行/列/合并单元格/定位 IoU 的结构级回归         |
| 无框线表格候选          | 无网格合同与报表利用文本对齐推断行列           |
| 跨页续表与拼接视图      | 列数、表头、列宽一致才关联，保留每页原表       |
| 合计/总计/小计算术校验  | 数字识别错误但置信度高                         |
| 序号/编号列排除求和     | 编号被误当成金额参与校验                       |
| 数量 × 单价优先校验     | 明细金额比直接求和更可靠                       |
| 关键字段置信度门槛      | 金额/日期/编号低置信不能被其他高分抵消         |
| 表头列类型推断          | 金额/日期/数量列中的错误格式可被发现           |
| 占位值与千分位兼容      | 避免 `-`、`N/A`、`1.280,00` 造成误报           |
| 硬性风险不可补偿        | 结构、算术、列类型、图像或小字问题强制人工复核 |
| 阅读顺序完整性          | 重复或缺失的 block id                          |
| 重复内容检测            | 同一段文本被识别多次                           |
| block 结构校验降级      | 校验失败的结果不允许直接 pass                  |

### 11.8 缓存与版本治理

| 优化                           | 解决的问题                   |
| ------------------------------ | ---------------------------- |
| 缓存键包含模型与 pipeline 版本 | 换模型或改后处理后误用旧结果 |
| 复用按客户/组织隔离            | 跨租户命中同名文档结果       |
| `fail` 结果不复用              | 坏结果扩散到其他附件         |
| 复用与重跑重新评分             | 阈值调整后沿用旧状态         |
| 重跑清空派生字段               | UI 展示过期路由/质量/阶段    |

### 11.9 基准闭环

| 优化                                  | 解决的问题                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------- |
| 原始 CER + 归一 CER + 数值 CER + WER  | 单一指标掩盖关键数字或英文单词错误                                          |
| 关键词召回 + 归一字段 + 精确字段      | 表格/PDF 难以逐字比对时的可观测性                                           |
| 文档全对率 + Wilson 区间              | 平均分掩盖「部分文档完全正确」的真实比例                                    |
| 错误分类                              | 替换/插入/删除/缺字段、关键字段风险、列类型、图像质量、小字与结构问题可归因 |
| 置信度校准（ECE/Brier）               | 判断高置信是否真的更可靠                                                    |
| 按语言、难度、退化类型分层            | 避免简单样本拉高整体、掩盖难样本退化                                        |
| 模板族切分 dev/校准/盲测              | 在同一份数据上调参又宣布达标，指标虚高                                      |
| 门禁只看盲测子集 + 盲测证据检查       | 小样本、单侧优化导致的假合格                                                |
| 通过文档随机审计（双人复核 + Wilson） | 「错误样本池」只包含系统怀疑过的文档，静默错误率无法估计                    |
| 发布门禁                              | 用固定阈值阻止 CER/字段/失败率回退                                          |
| 记录路由、阶段、耗时                  | 准确率提升是否以成本为代价                                                  |
| 历史运行对比                          | 改动前后可回归，而不是凭感觉调参                                            |

### 11.10 人工复核而非自动改写

- `review` / `fail` 结果标记 `reviewRequired`，附件列表显示「待复核」。
- 详情展示质量分、结构化统计、问题清单、级联阶段与关键字段证据（原文、N-best
  候选、一致/冲突/未确认、pass/mode/DPI/置信度）。
- 字段来源追踪：`GET /api/projects/:id/attachments/:attachmentId/ocr/fields`
  返回关键字段（含表格类型化单元格）的 page / block / bbox、模型与阶段、原始置信度、
  校验规则与数字规范值、复认候选和修订历史；业务系统可直接用该区域重新裁剪或复核，
  无需重跑整份文档。
- 人工修订通过 `POST .../ocr/fields/:fieldId/revisions` 记录原始 OCR 值、修订值、
  修订原因、修改人、时间与证据区域。修订写入独立的 `ocr_field_revisions` 表，
  不覆盖 `ocr_text`，可安全作为标注数据回流。
- 不自动替换、润色或补全文本：错误一旦被静默改写，后续无法追溯。
- 复核数据是未来阈值校准与主动学习的输入。

## 12. 配置

| 变量                                      | 默认值                | 说明                                           |
| ----------------------------------------- | --------------------- | ---------------------------------------------- |
| `OCR_PADDLE_URL`                          | 空（禁用）            | Paddle sidecar 地址                            |
| `OCR_DOCLING_URL`                         | 空（禁用）            | Docling sidecar 地址                           |
| `OCR_TOKEN`                               | 空                    | sidecar 共享密钥                               |
| `OCR_PADDLE_DET_MODEL`                    | `PP-OCRv6_medium_det` | 检测模型                                       |
| `OCR_PADDLE_REC_MODEL`                    | `PP-OCRv6_medium_rec` | 识别模型                                       |
| `OCR_PDF_DPI`                             | 200                   | 扫描页默认渲染 DPI                             |
| `OCR_MAX_PDF_PAGES`                       | 100                   | 单份 PDF 最多 OCR 的扫描页数                   |
| `OCR_MAX_PDF_TOTAL_PAGES`                 | 1000                  | 单份 PDF 最多检查的总页数                      |
| `OCR_PDF_TIME_BUDGET_SECONDS`             | 240                   | 单份 PDF 的识别时间预算                        |
| `OCR_PDF_TEXT_TRUST_MIN`                  | 0.6                   | 使用原生文本层的最低可信度                     |
| `OCR_PDF_TEXT_CROSSCHECK_RATE`            | 0.1                   | 文本层抽样交叉验证比例（0 关闭）               |
| `OCR_PDF_TEXT_CROSSCHECK_MAX_PAGES`       | 2                     | 单份 PDF 最多抽样验证页数                      |
| `OCR_PDF_TEXT_CROSSCHECK_MIN_SIMILARITY`  | 0.85                  | 抽样页视为一致的最低相似度                     |
| `OCR_MAX_IMAGE_FRAMES`                    | 20                    | 多帧图片最多处理帧数                           |
| `OCR_INTERVAL_SECONDS`                    | 5                     | worker 轮询间隔                                |
| `OCR_TIMEOUT_SECONDS`                     | 300                   | 单附件请求超时                                 |
| `OCR_MAX_CHARACTERS`                      | 500000                | 返回文本上限                                   |
| `OCR_CASCADE_MAX_STAGES`                  | 3                     | 含首次抽取的最大阶段数                         |
| `OCR_CASCADE_BUDGET_SECONDS`              | 180                   | 单附件级联总时长上限                           |
| `OCR_RECOVERY_YIELD_MIN_SAMPLES`          | 5                     | 启用实测恢复成功率的最少尝试次数               |
| `OCR_REGISTRY_AUTO`                       | 1                     | 是否允许自动晋级/回滚                          |
| `OCR_REGISTRY_MIN_SAMPLES`                | 20                    | 自动决策所需最少基准/生产样本                  |
| `OCR_REGISTRY_PROMOTE_MARGIN`             | 0.01                  | 候选领先对照多少分可晋级                       |
| `OCR_REGISTRY_ROLLBACK_MARGIN`            | 0.02                  | 对照落后回滚组多少分触发回滚                   |
| `OCR_REGISTRY_SIGNIFICANCE`               | 0.05                  | 配对 McNemar 检验允许的最大 p 值               |
| `OCR_QUALITY_REVIEW_THRESHOLD`            | 0.7                   | 低于该分数标记复核                             |
| `OCR_QUALITY_FAIL_THRESHOLD`              | 0.45                  | 低于该分数标记失败                             |
| `OCR_LOW_CONFIDENCE`                      | 0.75                  | 低置信 block 阈值                              |
| `OCR_KEY_FIELD_CONFIDENCE`                | 0.85                  | 关键字段置信度门槛                             |
| `OCR_MIN_SHARPNESS`                       | 0.2                   | 图像清晰度下限（0–1）                          |
| `OCR_MIN_BRIGHTNESS`                      | 0.25                  | 图像亮度下限                                   |
| `OCR_MAX_BRIGHTNESS`                      | 0.95                  | 图像亮度上限                                   |
| `OCR_MIN_CONTRAST`                        | 0.08                  | 图像对比度下限                                 |
| `OCR_MIN_PIXELS`                          | 300000                | 图像像素总数下限                               |
| `OCR_MIN_TEXT_HEIGHT`                     | 12                    | 文字高度下限（px）                             |
| `OCR_MAX_GLARE`                           | 0.02                  | 反光像素比例上限（0–1）                        |
| `OCR_MAX_SHADOW`                          | 0.35                  | 阴影亮度差上限（0–1）                          |
| `OCR_MAX_NOISE`                           | 0.09                  | 噪声估计上限（0–1）                            |
| `OCR_MAX_SKEW`                            | 3                     | 倾斜角上限（度）                               |
| `OCR_PREPROCESS_MAX_CANDIDATES`           | 4                     | 增强模式最多生成候选数                         |
| `OCR_PREPROCESS_GEOMETRY`                 | 0                     | 是否启用透视/去倾斜矫正                        |
| `OCR_HYBRID_IMAGE_MIN_RATIO`              | 0.04                  | 原生页嵌入图最小面积占比                       |
| `OCR_HYBRID_IMAGE_MAX_REGIONS`            | 2                     | 单页最多 OCR 的嵌入图区域数                    |
| `OCR_REGION_MAX_CANDIDATES`               | 4                     | 单次级联最多复认区域数                         |
| `OCR_REGION_PASSES`                       | 2                     | 每个区域最多复认遍数（1–3）                    |
| `OCR_CELL_MAX_CANDIDATES`                 | 4                     | 单次级联最多复认单元格数                       |
| `OCR_CELL_PASSES`                         | 2                     | 每个单元格最多复认遍数（1–3）                  |
| `OCR_GATE_MAX_CER`                        | 0.05                  | 发布门禁 CER 上限                              |
| `OCR_GATE_MAX_NUMERIC_CER`                | 0.02                  | 发布门禁数值 CER 上限                          |
| `OCR_GATE_MAX_SYMBOL_CER`                 | 0.01                  | 发布门禁关键符号 CER 上限                      |
| `OCR_GATE_MAX_CER_<KIND>`                 | 回退到 CER 上限       | 按文档类型覆盖 CER 上限                        |
| `OCR_GATE_MIN_FIELD_STRONG_ACCURACY`      | 0.9                   | 发布门禁字段强命中率下限                       |
| `OCR_GATE_MIN_FIELD_ACCURACY_LOWER`       | 0.9                   | 字段强命中率 Wilson 95% 下界下限               |
| `OCR_GATE_MIN_FULLY_CORRECT_LOWER`        | 0.7                   | 全对率 Wilson 95% 下界下限                     |
| `OCR_GATE_MIN_AMOUNT_ACCURACY`            | 0.99                  | 金额类字段准确率下界                           |
| `OCR_GATE_MIN_ACCOUNT_ACCURACY`           | 0.99                  | 账号类字段准确率下界                           |
| `OCR_GATE_MIN_DATE_ACCURACY`              | 0.95                  | 日期类字段准确率下界                           |
| `OCR_GATE_MIN_IDENTIFIER_ACCURACY`        | 0.95                  | 编号类字段准确率下界                           |
| `OCR_GATE_MIN_CATEGORY_SAMPLES`           | 30                    | 类别门禁所需最少样本数                         |
| `OCR_GATE_REQUIRE_PDF`                    | 1                     | 是否要求语料含 PDF 样本                        |
| `OCR_GATE_MIN_PDF_FILES`                  | 1                     | 门禁所需最少 PDF 文件数                        |
| `OCR_GATE_MIN_FULLY_CORRECT`              | 0.8                   | 发布门禁文档全对率下限                         |
| `OCR_GATE_MAX_FAILED_RATE`                | 0.1                   | 发布门禁失败率上限                             |
| `OCR_GATE_MAX_BUSINESS_LOSS`              | 0.05                  | 发布门禁加权业务损失上限                       |
| `OCR_GATE_MIN_TABLE_TEDS`                 | 0.9                   | 发布门禁表格 TEDS 下限                         |
| `OCR_GATE_MIN_TABLE_STRUCTURE_SAMPLES`    | 5                     | 表格 TEDS 门禁所需最少表格数                   |
| `OCR_GATE_ECE_MIN_SAMPLES`                | 20                    | 校准 ECE 门禁所需最少置信样本数                |
| `OCR_GATE_ALLOW_THIN_EVIDENCE`            | 0                     | 设为 1 时不再因样本不足判门禁未达标            |
| `OCR_GATE_WORST_GROUP_MIN_FILES`          | 3                     | 最差分组门禁的最少文件数                       |
| `OCR_GATE_WORST_GROUP_MIN_FIELDS`         | 3                     | 最差分组字段门禁的最少字段比较数               |
| `OCR_GATE_MAX_WORST_GROUP_CER`            | 0.15                  | 最差分组 CER 上限                              |
| `OCR_GATE_MIN_WORST_GROUP_FIELD_ACCURACY` | 0.85                  | 最差分组字段准确率下限                         |
| `OCR_BENCH_DIR`                           | `benchmarks/ocr`      | 基准语料目录                                   |
| `OCR_BENCH_SPLIT_SALT`                    | `v1`                  | 语料切分哈希盐值（换盐值即换批角色划分）       |
| `OCR_BENCH_DEV_SHARE`                     | 0.6                   | 调参集所占的模板族比例                         |
| `OCR_BENCH_CALIBRATION_SHARE`             | 0.2                   | 校准集所占的模板族比例（余量为盲测集）         |
| `OCR_GATE_MIN_BLIND_FILES`                | 3                     | 门禁所需的盲测文件数下限                       |
| `OCR_AUDIT_SALT`                          | `v1`                  | 通过文档随机抽样的排序盐值                     |
| `OCR_REVISION_QC_SALT`                    | `v1`                  | 人工修订质检抽样的排序盐值                     |
| `OCR_ANNOTATION_SINGLE_WEIGHT`            | 0.4                   | 单人标注相对双人一致的可靠性权重（≤1）         |
| `OCR_INK_MAX_REGIONS`                     | 3                     | 单次级联最多复认的墨迹空隙数                   |
| `OCR_INK_MAX_GAPS`                        | 12                    | sidecar 单页最多上报的墨迹空隙数（0 关闭检测） |
| `OCR_INK_MIN_PIXELS`                      | 45                    | 墨迹空隙的最小像素数（实际下限 8）             |
| `OCR_INK_MAX_SIDE`                        | 900                   | 墨迹检测栅格的单边上限                         |
| `OCR_MACHINE_READABLE`                    | 1                     | 是否从像素解码二维码/条码（0 关闭）            |
| `OCR_MACHINE_READABLE_MAX_SYMBOLS`        | 8                     | 单页最多解码的二维码/条码数量                  |
| `OCR_UPLOAD_ROOT`                         | 无                    | sidecar 允许读取的上传根目录                   |
| `OCR_CAMELOT_MAX_PAGES`                   | 200                   | Camelot 单次最多分析页数                       |
| `OCR_CAMELOT_TIME_BUDGET_SECONDS`         | 120                   | Camelot 单次分析时间预算                       |
| `OCR_DOCLING_MAX_PAGES`                   | 500                   | Docling 单次最多转换页数                       |
| `OCR_MAX_OFFICE_PAGES`                    | 200                   | Office 文档单次最多转换页数                    |
| `OCR_RETENTION_DAYS`                      | 0                     | OCR 文本/结构化结果/字段修订保留天数（0 永久） |

`OCR_CAMELOT_MAX_PAGES` / `OCR_CAMELOT_TIME_BUDGET_SECONDS` / `OCR_DOCLING_MAX_PAGES` /
`OCR_MAX_OFFICE_PAGES` 由 `scripts/ocr_sidecar.py` 读取。Camelot 超出任一限制时返回
已完成表格并标记 `truncated=true`，应用会把它传播到提取结果与阶段消息，UI 显示
「已截断」，避免把部分表格当成完整结果。

## 13. API 与 UI

| 接口                                                   | 权限          | 说明                                                          |
| ------------------------------------------------------ | ------------- | ------------------------------------------------------------- |
| `GET /api/projects/:id/attachments/:attachmentId/ocr`  | 项目可见      | 文本、DIR、质量、阶段与摘要                                   |
| `GET .../ocr/export`                                   | 项目可见      | 脱敏后的 OCR 文本与替换计数；已清理或未完成时拒绝             |
| `POST /api/projects/:id/attachments/:attachmentId/ocr` | 项目可写      | 重跑，可选 `mode` / `dpi`                                     |
| `GET .../ocr/fields`                                   | 项目可见      | 关键字段定位、校验与修订历史                                  |
| `POST .../ocr/fields/:fieldId/revisions`               | 上传者/管理者 | 记录字段级人工修订                                            |
| `GET .../ocr/versions`                                 | 项目可见      | 原始/阶段/选择/修订版本链                                     |
| `POST .../ocr/complaints`                              | 项目成员      | 用户投诉回流，不修改原文                                      |
| `GET /api/ocr/feedback`                                | 工作区管理员  | 错误样本池与过滤                                              |
| `POST /api/ocr/feedback/sync`                          | 工作区管理员  | 回填近期 OCR 样本                                             |
| `POST /api/ocr/feedback/sample`                        | 工作区管理员  | 分层主动学习抽样                                              |
| `POST /api/ocr/feedback/:id/status`                    | 工作区管理员  | 样本标注/忽略状态                                             |
| `GET /api/ocr/quality/dashboard`                       | 工作区管理员  | 生产质量看板与告警                                            |
| `GET /api/ocr/drift`                                   | 工作区管理员  | 数据漂移报告                                                  |
| `POST /api/ocr/drift/baseline`                         | 工作区管理员  | 保存漂移基线                                                  |
| `POST /api/ocr/drift/check`                            | 工作区管理员  | 检查并持久化漂移告警                                          |
| `GET /api/ocr/recovery-yields`                         | 工作区管理员  | 恢复阶段历史成功率与平滑先验                                  |
| `GET /api/ocr/pass-audits`                             | 工作区管理员  | 通过文档审计队列、静默错误率与按类型明细                      |
| `POST /api/ocr/pass-audits/sample`                     | 工作区管理员  | 按文件类型分层随机抽样（`fraction` / `perType` / `period`）   |
| `POST /api/ocr/pass-audits/:id/verdict`                | 工作区管理员  | 登记第一/第二复核结论（`clean` / `error` + 可选说明）         |
| `GET/POST /api/ocr/optimizations`                      | 工作区管理员  | 优化台账查询与新增                                            |
| `PATCH /api/ocr/optimizations/:id`                     | 工作区管理员  | 更新状态与生产观察                                            |
| `GET /api/ocr/lab`                                     | 工作区管理员  | 语料、模型、最近运行与历史                                    |
| `POST /api/ocr/lab/run`                                | 工作区管理员  | 运行基准，可选 `includePdf`                                   |
| `POST /api/ocr/lab/replay`                             | 工作区管理员  | 重放基准样本的指定阶段/区域                                   |
| `GET /api/ocr/lab/experiment`                          | 工作区管理员  | 最近一次模型/预处理对照实验；变体含 `channel`（rgb/gray/red） |
| `POST /api/ocr/lab/experiment`                         | 工作区管理员  | 运行模型 × 预处理（mode/DPI/通道）实验并综合排序              |

`POST /api/ocr/lab/replay` 请求体：`{ name, kind, occurrence?, page?, bbox?, padding? }`。
`occurrence` 选择同类阶段中的第几个（默认 1）；提供 `page` 与 `bbox` 时只重放该区域，
否则重放整页并返回新的质量分。响应包含 `inputMatches`、`outputMatches`、`scoreDelta`
与重放结果，哈希为 `null` 表示缺少可比对的指纹。

附件面板展示 OCR 状态、模型、路由、质量标签与复核提示；详情弹窗展示全文、结构化
统计、问题清单、级联阶段、关键字段候选证据、版本链与 DIR，并允许提交识别投诉。
统计区同时显示机读符号（含 MRZ 与校验失败数）、预处理冲突页数和 Office 覆盖
（页眉页脚、脚注、批注、图表、图片、嵌入对象、修订过滤、隐藏页）；业务类型 chip
显示类型、分类证据、必填字段覆盖率、缺失/格式无效字段与字段矛盾。已清理文本的附件
显示清理时间与提示，完成且未清理时可下载脱敏文本；导出与删除都会给出明确结果提示。
读取、轮询、字段证据与版本链失败会就地提示，关闭弹窗会作废旧请求，避免过期响应
覆盖新附件；投诉输入使用显式 `<label>`，处理中/失败状态分别使用 `role="status"`
与 `role="alert"`。

Ops 页面用于运行基准，并展示聚合指标、分层结果、分组校准、字段类别可靠性、错误分类、
置信度校准、发布门禁、历史运行，以及「模型与预处理对照实验」「阶段重放」：
- 对照实验选择引擎、模式、DPI 与 RGB/灰度/红通道，配置抽样数/晋级数/是否跑全量，
  排名表展示 CER、数值 CER、字段准确率、耗时与综合得分。
- 阶段重放选择样本、阶段与 occurrence，显示输入/输出指纹一致性、质量分变化与候选文本。
- 门禁失败的最大值检查显示 `>`，通过显示 `≤`；最小值检查失败显示 `<`，通过显示 `≥`。

「生产治理」页签包含质量看板、错误样本池与主动学习抽样（显示筛选命中/已加载数并支持
分页）、漂移告警、文档知识图谱、优化台账、模型注册表，以及阈值配置表：显示各维度
校准状态、样本/正例数、复核/失败/关键字段阈值、ECE 与更新时间，并可用最近基准样本
重新拟合。

## 14. 运维与排障

- 启动时 sidecar 会预加载模型；`GET /health` 的 `ready` 为 false 表示仍在加载。
- 关键日志事件：`ocr.completed`、`ocr.reused`、`ocr.retry`、`ocr.failed`、
  `ocr.recovered`、`ocr.deferred`、`ocr.benchmark_started/finished/failed`。
- 常见问题：
  - `未配置 paddle/docling OCR 服务`：检查 URL 与 sidecar 是否启动。
  - `path escapes the upload root`：sidecar 的 `--upload-root` 与应用 `UPLOAD_DIR` 不一致。
  - `OCR 服务未返回文本`：样本确实为空或模型不可用；查看 sidecar stderr。
  - 任务长期 `processing`：worker 每 30 秒续租（租约 120 秒），只要还在跑就不会被
    误判为中断；进程异常退出后续租停止，租约过期即自动重新排队（`ocr.recovered`）。
    排查时可查 `attachments.ocr_lease_until`：仍是未来时间说明有 worker 正在处理。
  - 质量分数普遍偏低：先用基准确认是模型问题还是阈值过严，再调整环境变量。

### 14.1 数据生命周期与导出（评审 #49）

- **保留策略**：`OCR_RETENTION_DAYS`（也可在 Ops 保留设置中修改）为 0 时永久保留；
  大于 0 时，每日保留任务清除超过期限的识别文本、引擎原文、结构化 DIR、质量与阶段
  数据以及字段修订，并写入 `attachments.ocr_purged_at`。附件本身、文件名与识别元数据
  保留，用于审计与统计；被清理的附件在列表中标记「OCR 文本已清理」，重新识别可恢复。
- **删除级联**：删除附件会一并删除 OCR 结果、字段修订与识别记录；所有引用附件的表
  使用 `ON DELETE CASCADE` 或 `ON DELETE SET NULL`，不会留下孤立文本。
- **脱敏导出**：`GET .../ocr/export` 只在识别完成且未清理时可用，返回替换后的文本与
  各类替换计数（身份证、手机、座机、邮箱、银行卡、MRZ 行）。正则带边界，先替换 MRZ
  与身份证，再匹配通用卡号，避免把相邻发票号或日期误改；导出审计只记录项目、附件、
  字符数与计数，不记录正文或 PII。
- **隔离**：结果复用限定在同一工作区，跨租户/跨组织的同名文件不会互相暴露内容；
  导出不进入离线快照缓存。

## 15. 已知边界与路线图

**当前边界**
- 图表、手写、印章、签名已能做区域检测与隔离（版面标签、启发式、颜色提示）；
  配置 `OCR_SPECIALIZED_URL` 后才有专用识别结果，否则印章/签名块通常为空文本，
  图表只保留区域标记。VLM 区域修复同样依赖外部服务。
- 质量分是启发式信号；置信度可按标注样本拟合等渗映射，阈值与打分使用校准值，样本
  不足的分组回退默认值。`review` 不等于错误，`pass` 也不排除个别错误。
- 文档类型是规则 + 版面证据的分类器，不是训练模型；证据不足时保持 `generic`并跳过
  schema 检查。机读证据中二维码/一维条码依赖 sidecar 安装 OpenCV/pyzbar，缺库时
  只保留 MRZ；MRZ 来自识别文本，与正文交叉只能算同引擎一致。
- Office 原生抽取会枚举嵌入图片与 OLE、图表和批注，但图片/OLE 内的文字不做原生
  OCR；`officeCoverage` 与「未识别对象」提示这一缺口，完整识别仍依赖 Docling 或后续
  专用适配器。
- 三个合成扩展包（宽表、降质版面、语义区域）共 21 个样本，仍用于回归与相对比较；
  真实扫描/客户分层语料与生产门禁阈值需要后续补充，指标不代表总体准确率。
- Camelot、Docling 与 Office 转换有页数/时间上限；超限时结果标记 `truncated`，
  UI 显示「已截断」，不会把部分结果当作完整文档。
- 默认全本地处理；接入外部 VLM/专用识别前需要单独确认数据合规。
- 系统不自动改写文本，区域复认、VLM 与专用识别也只记录证据，复核仍需人工完成。
- 注册表自动晋级/回滚依赖样本门槛与配对 McNemar 显著性；指标不足时保持 `hold`。
- 知识图谱只归一编号、账号、金额、日期四类结构化字段，正文引用基于字符串包含，
  不做语义消歧；图谱只读且不回写 OCR 文本。
- 墨迹检测依赖 sidecar 版本：升级前写入的缓存结果没有 `meta.inkGaps`，会被当作
  「未分析」而不是「已核对且干净」；本轮没有提升 `PIPELINE_VERSION`，需要立即覆盖
  存量缓存时请清空对应缓存或手动重跑。旧文档的单一 `confirmed` 复认结果读取时按
  `confirmed_same_engine` 处理。
- `gate.passed` 目前只作为发布结论展示与历史对比，没有自动阻断注册表晋级或流量切换；
  晋级仍需人工在 Ops/治理页确认，后续再把门禁接入自动策略。

**下一步**
- 继续消化 `docs/ocr-方案评审与50条改进点.md`：已实现 #02/#05/#12/#13/#15/#19/#21/#23/
  #24/#25/#31/#33/#38/#41/#42/#43/#45/#49/#51/#53/#60/#64/#66/#67/#69；剩余优先项是
  #30（用标注真值替代权重启发式）、#32/#35/#36/#48（恢复收益与灰度的真实标签），
  以及把 `gate.passed` 接入注册表自动晋级/回滚。
- 扩大语料：真实扫描件、倾斜照片、多栏、复杂表格、低质量传真，并按客户/组织分层。
- 跨引擎整页候选已接入：格式重叠时自动使用第二引擎（目前 Docling 读 PDF/图片），
  与模型候选共用 `candidate` 阶段和分层采用规则；下一步用真实服务量化净收益，并把
  级联成功概率从启发式升级为更可靠的估计。
- 为图表、手写、印章、签名接入专用识别能力，并沿用现有的区域隔离与人工复核流程。
- 表格模式覆盖更多输入，评估 Camelot 在更多数字 PDF 表格上的净收益。
- 注册表接入滚动窗口评估、按组织/文档类型分流，并联动标注预算与优化台账。
- 知识图谱扩展到合同方、项目、条款等语义实体，并加入消歧与置信度传播。
- 弯曲页面展平、运动模糊/反光修复、公式/竖排语义仍需真实样本或专用模型验证。
