# 文档智能与 OCR 完整方案（V2）

本文是附件 OCR 的**主文档**：包含架构、引擎与部署、路由、原生抽取、图像预检与预处理、
统一文档中间表示（DIR）、表格与业务字段、质量评估、预算级联、缓存、基准、发布门禁、
生产治理、人工复核、API/UI、配置、运维，以及**为提升识别率做过的优化和验证方法**。
端到端部署细节可对照 [ocr-solution.md](ocr-solution.md)，70 项改进建议的原始清单见
[ocr.md](ocr.md)。

当前落地范围：**V2 骨架 + P0 + P1 + P2 全部规划能力**。原生抽取、区域级路由、
DIR 整理、13 项质量信号、预算级联、关键字段/单元格复认、字段溯源与人工修订、分层基准、
发布门禁、运行时阈值拟合、反馈样本池与预算化主动学习、客户/组织看板、漂移检测、
版本链、优化台账、知识图谱、模型/流水线注册表与自动灰度晋级/回滚均已上线。
VLM 区域修复、专用区域识别（图表/手写/印章/签名）与 Camelot 表格适配器已接入协议与
级联，只有配置对应 HTTP 服务时才启用；未配置时保持惰性，不改变既有识别路径。

---

## 1. 方案摘要

**原生优先（native-first）、按需识别、结构统一、质量驱动恢复、基准闭环、人工复核。**
1. 能直接读取文本层的文档不跑 OCR，从源头避免识别错误。
2. 只对扫描页、嵌入图片或视觉区域渲染识别；混合 PDF 按页、按区域选择原生或 OCR。
3. 所有引擎统一输出 DIR，质量、基准、版本链与后续修复共享同一结构。
4. 首次结果先评分，不达标才在预算内做定向恢复，并保留质量最高的结果。
5. 低质量结果只标记人工复核，**系统永远不自动改写识别文本**。
6. 用固定语料与多项指标量化每次改动，而不是凭感觉调参。
7. 所有自动决策可解释、可回放；字段、阶段、模型与参数都可追溯。
8. 生产错误、人工修订与投诉回流为样本，驱动下一轮优化。

### 1.1 不可破坏的约束

| 约束                   | 含义                                                             |
| ---------------------- | ---------------------------------------------------------------- |
| 原始结果不可覆盖       | 预处理图、初次 OCR、恢复候选、最终选择与人工修订分层保存         |
| 候选不等于事实         | 复认、N-best、VLM 候选都有来源、置信度与证据区域，不静默替换原文 |
| 关键字段优先           | 金额、账号、日期、编号等高风险字段使用更严格的质量门槛           |
| 区域恢复优先于整页重跑 | 成本更低，问题定位更精确                                         |
| 基准必须分层           | 按类型、语言、难度、退化与字段类别报告结果                       |
| 识别率必须被证明       | 不能仅凭模型版本更新或 confidence 提升判断效果                   |

---

## 2. 总体架构

```text
浏览器（附件面板 / 复核弹窗 / Ops 基准与治理）
        │
        ▼
Hono API ── 上传校验、附件元数据、OCR 查询与重跑、基准、治理
        │
        ▼
SQLite attachments 队列（pending → processing → done / failed / skipped）
        │
        ▼
OcrWorker（Node 进程内）
  ├─ 缓存复用（sha256 + 模型/流水线/运行时指纹 + 模式 + DPI）
  ├─ 首次抽取（native / visual / hybrid）
  ├─ 质量评估
  ├─ 预算级联（区域/单元格复认 → 语言纠正 / DPI / enhanced / structure）
  └─ 持久化文本、DIR、质量、阶段、复核标记与反馈样本
        │  HTTP + X-OCR-Token
        ▼
┌───────────────────────┬───────────────────────┐
│ Paddle sidecar :8765  │ Docling sidecar :8766 │
│ 图片 / PDF / 表格      │ Office 文档 / 兜底     │
└───────────────────────┴───────────────────────┘
```

### 2.1 模块清单

| 模块           | 位置                                                                | 职责                                                     |
| -------------- | ------------------------------------------------------------------- | -------------------------------------------------------- |
| 附件路由       | `src/routes/attachments.ts`                                         | 上传、类型校验、缓存复用、OCR 查询与重跑、字段与投诉     |
| OCR 客户端     | `src/ocr.ts`                                                        | sidecar 调用、结果解析、模型探测、缓存键与运行时指纹     |
| 任务队列       | `src/stores/attachments.ts`                                         | 原子领取、重试、恢复中断任务、缓存查询                   |
| Worker         | `src/ocr-worker.ts`                                                 | 轮询、缓存复用、级联、灰度分桶、持久化                   |
| DIR            | `src/document-ir.ts`                                                | 解析、上限、确定性整理、阅读序与跨页关系                 |
| 无框线表格     | `src/ocr-borderless.ts`                                             | 文本对齐与间距推断候选网格，只标记不改写                 |
| 表格与业务字段 | `src/ocr-tables.ts`                                                 | 列类型、多级表头、数值候选、业务约束                     |
| 数值与混淆     | `src/ocr-numeric.ts` / `src/ocr-confusions.ts`                      | 数字规范化、占位值、OCR 混淆兼容、中文数字与量纲语义     |
| 独立字段校验   | `src/ocr-field-validation.ts`                                       | 校验位（USCC/身份证/Luhn/IBAN/ISBN/VIN）与大小写金额互校 |
| 质量引擎       | `src/ocr-quality.ts`                                                | 13 项信号、硬性风险、可解释分量                          |
| 级联           | `src/ocr-cascade.ts`                                                | 恢复规划、期望收益门控、预算、保留最佳结果               |
| 溯源           | `src/ocr-provenance.ts`                                             | 关键字段定位、候选证据、修订关联                         |
| 基准           | `src/ocr-bench.ts`                                                  | 语料执行、CER/字段/表格/校准/门禁、回放                  |
| 实验           | `src/ocr-experiments.ts`                                            | 模型 × 预处理对照实验、筛选与全量排序                    |
| 阈值校准       | `src/ocr-calibration.ts` / `src/stores/ocr-calibration.ts`          | Youden J、精确率目标、ECE/Brier 报告、分维度阈值 profile |
| 治理           | `src/ocr-feedback.ts` / `src/ocr-governance.ts`                     | 反馈池、预算化主动学习、看板、版本链、台账               |
| 漂移           | `src/ocr-drift.ts`                                                  | 六维分布比较、告警与补语料建议                           |
| 模型矩阵       | `src/ocr-models.ts`                                                 | 能力矩阵、可解释路由、灰度分桶                           |
| 外部适配器     | `src/ocr-adapters.ts`                                               | Camelot / VLM / 专用区域识别 HTTP 协议，未配置时惰性     |
| 注册表与灰度   | `src/ocr-registry.ts` / `src/stores/ocr-registry.ts`                | 控制/候选/回滚角色、自动晋级回滚、人工钉住与审计         |
| 知识图谱       | `src/ocr-knowledge.ts`                                              | 跨附件实体归一、共同出现/正文引用关系、金额指标          |
| 侧车           | `scripts/ocr_sidecar.py`                                            | 原生抽取、PaddleOCR、结构分析、PDF 逐页路由              |
| UI             | `web/src/components/AttachmentsPanel.tsx` / `web/src/pages/Ops.tsx` | 附件复核、基准、治理面板                                 |

### 2.2 数据与持久化

- `attachments`：OCR 状态、文本、模型、路由、模式、DPI、DIR、质量、阶段、复核标记，
  以及缓存配置指纹 `ocr_config_hash` 与 worker 租约 `ocr_lease_until`。
- `ocr_field_revisions`：字段级人工修订，保留原文、修订值、原因、操作者与证据区域。
- `ocr_feedback_samples`：按 `SHA-256 + 错误类型` 去重的待标注样本。
- `ocr_drift_baseline` / `ocr_drift_alerts`：漂移基准快照与按天去重告警。
- `ocr_optimizations`：优化台账与收益/成本排序。
- `ocr_threshold_profiles`：按整体/文档类型/难度/语言/文件类型/工作区拟合的阈值。
- `ocr_registry_entries` / `ocr_registry_decisions`：模型/流水线角色、基准与生产指标、
  自动/人工决策审计。
- 基准运行与逐文件结果：支持历史对比、回放与实验；知识图谱按读取时构建，不落库。

---

## 3. 处理流程与状态机

```text
上传附件
  └─ 按扩展名决定是否需要 OCR（无引擎 → skipped）
       └─ 入库 pending，唤醒 worker
            └─ claimNext 原子改为 processing，attempts+1，写入 120s 租约
                 ├─ 命中可复用缓存 → 用当前阈值重新评分 → done
                 └─ 调用级联
                      ├─ 首次抽取（native / visual / hybrid）+ 图像预检
                      ├─ DIR 确定性整理
                      ├─ 质量评估
                      ├─ 未通过 → 区域/单元格复认 → 预算内恢复
                      └─ 取最高分 → 持久化 → done
                           └─ review / fail → reviewRequired = 1
                                └─ 反馈池、看板、投诉、修订、版本链、回放
```

| 状态         | 含义与处理                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| `pending`    | 已排队或等待重试                                                                                         |
| `processing` | 已被某个 worker 原子领取并持有 120 秒租约（`ocr_lease_until`），识别期间每 30 秒续租；租约过期即重新排队 |
| `done`       | 已拿到结果；质量状态另记为 pass / review / fail                                                          |
| `failed`     | 永久错误（4xx）或达到最大尝试次数（3 次，退避 60s × 已尝试次数）                                         |
| `skipped`    | 纯文本、CSV、Markdown、JSON、ZIP 等无需 OCR 的附件                                                       |
- 领取使用单条条件 `UPDATE ... RETURNING`，多 worker 并发不会重复处理。
- **租约取代固定超时**（改进点 #51）：慢任务只要仍在运行就会持续续租，不会被误判为
  中断而被第二个 worker 抢先重复识别；进程崩溃后续租停止，最长 120 秒后任务自动回收。
  没有租约的历史行仍按 `OCR_TIMEOUT_SECONDS + 60s` 的旧规则回收。
- 单页失败不丢弃整份文档：记录空页后继续，质量引擎通过覆盖率发现缺页。
- 页数、总页数或时间预算触发时只标记 `truncated` 并把页数写进 DIR 元数据，
  **不再往正文追加「已截断/仅解析前 N 页」提示语**（改进点 #53），避免搜索、字段
  匹配与 CER 把提示语当成文档内容。
- 质量 `fail` 的缓存不参与复用，避免坏结果扩散。
- 缓存复用的结果会用**当前阈值**重新评分，不信任历史质量分。

---

## 4. 引擎、部署与安全边界

### 4.1 Paddle sidecar（默认 8765）

- 默认模型：`PP-OCRv6_medium_det` + `PP-OCRv6_medium_rec`。
- 初始化失败时依次回退：`PP-OCRv5_server_det/rec` → Paddle 默认模型（带方向分类）
  → 默认模型（不带方向分类）。
- 基础 OCR 保留页面方向分类，但关闭文档去畸变与文本行方向，保证 `auto` 路径速度；
  `enhanced` 模式额外开启这两项预处理。
- `table` / `structure` 使用 `TableRecognitionPipelineV2`，优先固定
  `PP-DocLayout_plus-L`、`PP-LCNet_x1_0_table_cls`、`SLANeXt_wired` / `SLANet_plus`
  与对应单元格检测模型；固定组合不可用时退回默认组合。
- 单进程内用锁串行执行抽取，避免多个请求同时占用同一模型实例。
- 表格结果输出行、单元格、bbox 与**逐单元格置信度**，供质量引擎和字段溯源使用。

### 4.2 Docling sidecar（默认 8766）

- 负责 `.docx` / `.xlsx` / `.pptx`。
- 优先使用 `python-docx` / `openpyxl` / `python-pptx` 原生读取段落、工作表和表格；
  依赖缺失或结果为空时回退 Docling。
- Docling 输出 markdown 后统一归一化，并包装为单页 DIR。

### 4.3 启动方式与依赖

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

### 4.4 Sidecar 接口与安全

| 接口                   | 说明                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `GET /health`          | 引擎、是否就绪、流水线版本、当前模型与运行时版本                                                  |
| `POST /extract`        | `path` / `name` / `mode` / `dpi`，返回文本、置信度、路由、DIR、预检与运行时                       |
| `POST /extract-region` | `path` / `name` / `page` / `bbox` / `dpi` / `mode` / `padding` / `lang` / `model`，只识别局部区域 |
- 只接受 `--upload-root` 下的绝对路径，解析后校验父目录，阻止路径穿越。
- 可选 `X-OCR-Token`，使用常量时间比较；未配置 token 时不做鉴权。
- 请求体上限 64 KB；缺失 `Content-Length` 返回 411，超限返回 413。
- `mode` 仅允许 `auto` / `table` / `structure` / `enhanced`；非 Paddle 引擎只允许
  `auto`；`table` / `structure` 仅支持图片与 PDF。
- DPI 仅允许 100–400。
- 启动时预加载模型；`GET /health` 的 `ready=false` 表示仍在加载。

解析器加固与资源预算（评审 #07）：

| 约束           | 取值                            | 触发结果                |
| -------------- | ------------------------------- | ----------------------- |
| 单张图片像素   | `MAX_IMAGE_PIXELS = 80_000_000` | 422 拒绝                |
| PDF 渲染页像素 | 同上                            | 该页跳过并记问题        |
| OOXML 解压总量 | 200 MB                          | 422 拒绝                |
| OOXML 条目数   | 10 000                          | 422 拒绝                |
| OOXML 压缩比   | 500                             | 422 拒绝                |
| OOXML 条目头部 | 出现 `<!DOCTYPE` 或 `<!ENTITY`  | 422 拒绝（XXE/膨胀）    |
| 加密 PDF       | pypdfium2 打不开                | `422 password_required` |
- `Image.MAX_IMAGE_PIXELS` 同步设为同一预算，Pillow 自身的解压炸弹保护不会晚于我们的检查触发。
- Node 侧把 `password_required` 映射为**永久失败且不重试**（`src/ocr.ts`），避免每轮
  worker 都重新尝试一份需要密码的文件；附件详情显示「PDF 已加密，需要密码后才能读取」。
- 两个引擎容器以 uid/gid `10001` 运行，`cap_drop: ALL`、`no-new-privileges:true`，
  并设置 `mem_limit` / `cpus`，解析崩溃不能提权或耗尽宿主机（见 `docker-compose.yml`）。

---

## 5. 路由策略

### 5.1 文件类型路由

| 输入                                 | 首选                                        | 回退 / 说明                                      |
| ------------------------------------ | ------------------------------------------- | ------------------------------------------------ |
| XLSX                                 | openpyxl 原生单元格与工作表                 | 缺少依赖时 Docling                               |
| DOCX                                 | python-docx 段落与表格                      | 缺少依赖时 Docling                               |
| PPTX                                 | python-pptx 幻灯片文本与表格                | 缺少依赖时 Docling                               |
| 带文本层 PDF                         | pdfplumber 文本、行框与原生表格             | 无文本页渲染后交给 Paddle；混合来源记为 `hybrid` |
| 扫描 PDF                             | pypdfium2 渲染 + PaddleOCR                  | PDF 打不开或无文本时整篇交给 Paddle PDF 管线     |
| 混合 PDF                             | 文本层走原生，扫描页走 OCR                  | 原生页内嵌位图按区域单独 OCR                     |
| 图片（截图/照片）                    | PP-OCRv6_medium                             | `table`/`structure` 使用 PP-StructureV3          |
| 表格图片                             | PP-StructureV3 + TableRecognitionPipelineV2 | 输出单元格、行、bbox 与单元格置信度              |
| 无框线表格                           | 文本对齐、行间距与数值列特征推断候选网格    | 只标记 `meta`，不改写单元格                      |
| 印章 / 签名                          | 颜色与版面规则隔离为独立 block              | 不参与正文阅读序，保留 bbox 与类型               |
| 图表 / 公式 / 手写                   | 版面标签与启发式标记类型                    | 隔离后可调用 VLM/专用识别；未配置时只分类与隔离  |
| 纯文本 / CSV / Markdown / JSON / ZIP | 不 OCR                                      | 标记 `skipped`                                   |
| 暂不支持的格式                       | 返回明确错误                                | 不静默降级为纯文本                               |

### 5.2 PDF 逐页与混合路由

1. pdfplumber 读取每页文本、行框与原生表格。
2. 每页文本层先计算 0–1 可信度：综合去空白长度、替换符/控制字符/私用区字符比例
   与可读字符占比（`OCR_PDF_TEXT_TRUST_MIN`，默认 0.6）。可信度达标且非强制结构模式时，
   直接使用原生文本；低可信页渲染后交给视觉 OCR，避免占位文本层或损坏字体冒充可用文本。
   DIR `meta.textLayer` 记录页数、达标页数、阈值、最低/平均可信度与扣分原因；附件详情
   展示「PDF 文本层 X/Y 页可信 · 最低 Z%」，未达标时高亮并通过 title 说明阈值与
   扣分原因（空文本层、文本过短、乱码字符、可读字符不足）。
3. 可信页按确定性等距抽样交叉验证：`OCR_PDF_TEXT_CROSSCHECK_RATE`（默认 0.1）
   决定抽样比例，`OCR_PDF_TEXT_CROSSCHECK_MAX_PAGES`（默认 2）封顶，抽样页渲染后
   重新 OCR，与原生文本做去空白相似度比较（`OCR_PDF_TEXT_CROSSCHECK_MIN_SIMILARITY`，
   默认 0.85）。**含数字最多的可信页优先入选**（改进点 #02）：风险页至少占用
   `max_pages` 一半的配额，其余按等距补足，保证金额/编号页不会因为随机抽样被跳过。
   每页样本除相似度外还比较**数字 token 序列**（全角、千分位与小数点归一后排序），
   整体相似度达标但数字不一致时单独记 `numericMismatch`。结果写入
   `meta.textLayer.crosscheck`（抽样/一致/不一致页、数字不一致页数、最低相似度、
   是否受时间预算截断）；**原生文本从不被改写**，不一致（含仅数字不一致）只生成
   `text_layer_mismatch` 质量问题与硬风险，附件详情展示「文本层交叉验证 M/N 页一致 · 最低 X%」。
4. 否则渲染该页并 OCR；数字页不计入 OCR 页数上限。
5. 原生页与 OCR 页混合时路由记为 `hybrid`，模型标签增加 `+pdf-text` 后缀。
6. 原生页内嵌入位图区域（图表、截图、扫描插图）也按区域路由：面积占比 0.04–0.8、
   尺寸 ≥ 40pt 且原生行文本少于 3 行的图片会被裁剪后单独 OCR，识别块坐标映射回
   PDF point 并标记 `meta.hybrid = "embedded_image"`；整页位图视为 OCR 文本层，不重复识别。
7. 单页失败不会丢弃整份文档：记录空页后继续，质量引擎会通过覆盖率发现缺页。
8. 页数上限、总页数上限与时间预算触发时标记 `truncated`，已处理/总页数只写入
   `meta.processedPages` / `meta.totalPages`，正文不再追加说明文字。

### 5.3 图片与多帧

- TIFF / GIF 按帧拆分，最多 `OCR_MAX_IMAGE_FRAMES`（默认 20）帧。
- 单帧失败或超出上限时标记截断。
- 单选图片按 EXIF 方向自动转正；多帧图片逐帧转为 PNG 后再识别。
- 图像预检在识别前记录清晰度、亮度、对比度、像素数、反光、阴影、噪声、倾斜与方向。

### 5.4 模式语义

| 模式        | 语义                                                       |
| ----------- | ---------------------------------------------------------- |
| `auto`      | 按布局自动分组，普通文本与表格混排的快速路径               |
| `table`     | 表格结构化，仅 Paddle 且输入为图片或 PDF                   |
| `structure` | 整页结构分析（表格 + 版面），用于弱文本恢复与表格文档      |
| `enhanced`  | 方向矫正、去畸变、文本行方向分类，适合倾斜照片与低质量扫描 |

### 5.5 可解释路由与模型矩阵

路由结果记录 `OcrRouteDecision`：
- `engine`、`mode`、`language`、`modelId`、`profile`、`numeric`、`fallbacks`、
  `explicit` 与 `reasons`。
- 相同输入的确定性路由保持不变；灰度发布只替换侧车模型 profile，不改变路由原因。
- 模型能力矩阵记录语言、文档类型、速度、内存、许可证、优势/限制与准确率；
  准确率在基准测出前保持 `null`，不凭空声称精度。
- 支持中文/英文、日文、韩文、阿拉伯文与拉丁字母 profile；检测到对应脚本时切换，
  中英混排默认使用中文模型。
- 声明语言与实测文字脚本不符时触发语言纠正恢复（见第 11 节）。

---

## 6. 原生抽取与文本归一

### 6.1 Office 与数字 PDF

- Office 三件套优先原生读取，保留工作表、段落与表格结构；失败时才回退 Docling。
- DOCX 额外读取页眉页脚、文本框、脚注尾注、批注、图表、媒体与 OLE；修订痕迹保留插入、
  忽略删除并统计字符数。XLSX 标记隐藏工作表，PPTX 标记隐藏幻灯片、组合形状与备注。
  各类计数写入 `meta.office`，图片/OLE 内容不做原生 OCR，而是计入 `unrendered`，
  由质量层通过 `officeCoverage` 提示覆盖缺口（评审 #05）。
- 数字 PDF 使用 pdfplumber 的文本、行框与原生表格；表格区域内的行文本会去重，
  避免同一内容同时出现在行块与表格块。
- Docling 的 markdown 输出会反转义 HTML 实体、归一 NBSP 与控制字符，再包装为 DIR。

### 6.2 文本后处理

后处理只做确定性归一，不改变语义，也不自动修复疑似错误：
- 全角数字分隔符归一：`1，280，500` → `1,280,500`。
- HTML 实体反转义、NBSP 归一。
- CJK 与拉丁/数字边界补空格，冒号、句末标点后补空格。
- 控制字符清理与换行统一。
- 数字文本的规范化只用于校验与展示，原始单元格/字段文本保持不变。

#### 6.2.1 原文与归一文本分开存储（评审 #19）

边界补空格这类规则虽然确定，但仍会**改变字符序列**：`客户：上海编号：SH20240101`
归一后变成 `客户： 上海 编号： SH20240101`。如果只有这一份文本可查，就无法回答
「引擎到底读到了什么」，跨文档实体对齐也会因空格差异把同一编号拆成两个实体。

| 字段                       | 内容                                 | 用途                                 |
| -------------------------- | ------------------------------------ | ------------------------------------ |
| `attachments.ocr_text`     | 归一化后的展示文本                   | 预览、关键词匹配、字段抽取、CER 比对 |
| `attachments.ocr_raw_text` | 引擎原文（`raw_text_from_document`） | 知识图谱/实体对齐、复核时核对忠实度  |
- 归一只影响空白与全角符号，绝不替换数字、字母或标点种类；selftest 用编号、IBAN、
  时间、URL 等 10 类值断言归一后原值仍是子串。
- `ocr_raw_text` 为 `NULL`（迁移前的历史数据）时回退到 `ocr_text`，不阻塞读取。
- 附件详情在两份文本不一致时显示「查看引擎原文 / 查看归一文本」切换，默认展示归一文本。
- 知识图谱从 `COALESCE(ocr_raw_text, ocr_text)` 取文，空格差异不会拆散同一实体。

---

## 7. 图像预检与预处理

### 7.1 预检信号

`OcrPreflight` 在识别前测量：

| 信号          | 含义                                 | 默认门限  |
| ------------- | ------------------------------------ | --------- |
| `sharpness`   | 边缘方差，低值表示模糊               | ≥ 0.2     |
| `brightness`  | 平均亮度 0–1                         | 0.25–0.95 |
| `contrast`    | 亮度标准差                           | ≥ 0.08    |
| 像素总数      | 宽 × 高                              | ≥ 300000  |
| `glare`       | 近白像素比例，反光                   | ≤ 0.02    |
| `shadow`      | 低频背景亮度差，阴影                 | ≤ 0.35    |
| `noise`       | 中值残差噪声估计                     | ≤ 0.09    |
| `skew`        | 近水平线中位角                       | ≤ 3°      |
| `orientation` | EXIF、应用旋转、长宽比、方向不确定性 | 多信号    |
| `textHeight`  | DIR 实测文字高度                     | ≥ 12px    |
- 预检问题会写入质量 `issues`：`image_blurry`、`image_exposure`、
  `image_low_resolution`、`image_glare`、`image_shadow`、`image_skew`、
  `image_noise`、`image_orientation`、`image_retake`、`small_text`。
- 反光严重或分辨率过低时输出 `retake.required` 与原因，建议重新采集，
  而不是用锐化制造虚假字符。
- 没有 Pillow 时预检字段可为空，不影响主流程。

### 7.2 预处理与增强

- `enhanced` 模式启用方向分类、文档去畸变、文本行方向分类；`auto` 为速度关闭。
- 有界光度候选：阴影校正、对比度、降噪、锐化、Otsu、自适应阈值、红通道；
  候选必须通过区域识别评分超过原图才会被采用，避免过度增强产生伪边缘。
- 可选透视矫正/去倾斜（`OCR_PREPROCESS_GEOMETRY=1`），同时保留变换矩阵，
  将 bbox 映射回原始页面坐标。
- 自适应 DPI：按 DIR 实测文字高度计算目标 DPI（目标约 24px 字高，50 为步长，
  上限 400），不再固定 200 → 300 → 400 阶梯。
- `enhanced` 已启用 Paddle 文档去畸变（含弯曲/透视校正）；专用深度展平模型尚未接入，
  极端弯曲、运动模糊与强反光仍需真实样本评估修复收益。

---

## 8. 统一文档中间表示（DIR）

### 8.1 结构

```ts
type DocumentIr = {
  version: 1;
  route: 'native' | 'visual' | 'hybrid';
  pages: DocumentPage[];
  readingOrder: string[];
  meta: Record<string, unknown>;
};
```

- Block 类型：`paragraph` / `heading` / `table` / `formula` / `chart` / `handwriting`
  / `stamp` / `signature` / `header` / `footer` / `image`。
- 每个 block 记录 `bbox`、`confidence`、`source`（引擎、模型、`native` / `visual` /
  `recovery` / `vlm` 阶段）与 `validation`（passed / flagged / failed + 问题列表）。
- Table block 携带 `rows` 与 `cells`；单元格含行、列、`rowSpan` / `columnSpan`、
  `bbox`、文本与可选的独立识别置信度。
- 空页保留 page 记录，便于质量引擎发现「有页无内容」。
- 防爆上限：200 页、每页 3000 块、单表 5000 单元格、20000 个阅读序条目、
  100k 字符；超出即截断并在结果中标记。

### 8.2 确定性整理

解析后运行 `src/document-ir.ts`，只增加标记与顺序，不删除或改写内容：
- 跨页重复的顶部/底部文本标记为 `header` / `footer`；页码数字归一后比较，
  `第 1 页` 与 `第 2 页` 视为同一模板，写入 `meta.template` / `meta.templatePages`。
- 同页 bbox IoU ≥ 0.6 且文本相似度 ≥ 0.85 的重复块，保留来源/置信度更高者，
  另一个写入 `meta.overlapOf`，仅从阅读序中排除。
- 阅读顺序先按横向跨栏块分带，再按列聚合（列内自上而下），块上记录
  `meta.orderReason` / `meta.orderColumn`；无 bbox 时回退原始顺序。
- 相邻页底部表格与下一页顶部表格在列数一致、表头相似且列宽分布一致时建立
  `meta.continuedTo` / `meta.continuedFrom`，写入 `meta.continuationEvidence`
  （表头相似度、列宽相似度、位置关系）；表头重复时标记 `meta.repeatedHeader`，
  但绝不合并行。
- `tableChains()` / `meta.tableContinuations` 提供只读拼接视图，每页原始表格与行保持不变。
- 统计汇总在 `meta.refinement`，供质量、UI 与基准使用。

### 8.3 区域与版面

- 版面区域标签（标题、公式、页眉页脚、印章、签名等）写入 block / page `meta`；
  表格网格只对区域内文本分组，标题与表后说明保持正文。
- 颜色与几何规则识别的彩色印章、蓝色签名隔离为独立 block；它们通常为空文本，
  但保留区域标记，避免污染正文与字段匹配。
- 原生页内嵌入位图独立 OCR 后，坐标反算回页面；标记 `meta.hybrid = "embedded_image"`。
- 普通低置信文本行也纳入区域复认，关键字段优先。
- 无框线表格由 `src/ocr-borderless.ts` 推断：同页短文本行按垂直重叠分组、
  按水平中心聚类成列，结合数值/日期占比、列填充率与行间距生成候选网格，
  写入 `meta.borderlessTables` 并在参与块上标记 `meta.borderlessTable`；不改文本或坐标。

---

## 9. 表格与业务字段

### 9.1 表格结构

- 图片/PDF 表格通过 PP-StructureV3 + TableRecognitionPipelineV2 输出行、列、单元格、
  bbox 与单元格置信度。
- 原生 PDF 表格由 pdfplumber 提取，并与行文本去重。
- 表格完整性检查：空表、行列不一致、缺单元格、填充率异常。
- 合并单元格保留 `rowSpan` / `columnSpan`，基准可评估跨度准确率。
- 无框线表格只生成候选网格标记；跨页续表只建立关系与只读拼接视图。

### 9.2 列类型、表头与数值候选

- 从表头推断金额、日期、数量、比例、数值、币种、借方/贷方、税额与税率列。
- 支持多级表头，列结构写入 `block.meta.columnSchema`。
- 金额保留多种可能解析（`block.meta.numberCandidates`），例如 `1,280.00` /
  `1.280,00` / 歧义的 `1,280`；结合区域、币种与列类型判断，不提前归一。
- 占位值 `-` / `N/A` / `待定` / `无` 不参与异常统计。
- 只有含数字但无法解析的单元格（如 `1O0`、`2024-1O-02`）才计入列类型异常。
- 列类型校验只用于告警、评分与恢复触发，不修改单元格文本。

### 9.3 业务约束

`src/ocr-tables.ts` 按列标签自动触发：

| 规则           | 说明                                        |
| -------------- | ------------------------------------------- |
| 必填列         | 缺少金额、日期等必需列时告警                |
| 借贷平衡       | 借方合计与贷方合计在容差内比较              |
| 税额校验       | `税额 ≈ 基数 × 税率`，逐行比较              |
| 币种一致性     | 金额列出现多种币种时告警                    |
| 日期范围       | 日期列解析与范围检查                        |
| 编号形态       | 编号/账号/订单号格式检查                    |
| 数量 × 单价    | 明细金额优先用数量 × 单价校验               |
| 合计/总计/小计 | 合计行与明细求和比较；序号/编号列不参与求和 |

校验失败只产生问题、硬性风险与恢复触发，不修正数值。业务约束失败会升级为
`field_validation_failed` 硬性风险，不能被其他高分抵消。

### 9.4 关键字段与字段溯源

- 关键字段类型：金额、日期、编号/订单号/发票号、账号、数量。
- `GET .../ocr/fields` 返回每个字段的 page / block / bbox / crop、原始文本、置信度、
  来源（引擎、模型、阶段）、校验规则、数字规范值、复认候选与修订历史。
- 业务系统可直接用该区域重新裁剪或复核，无需重跑整份文档。
- 字段修订写入独立表，不覆盖 `ocr_text`，可直接作为标注回流数据。

**独立校验（`src/ocr-field-validation.ts`，改进点 #23/#24/#25）**用与识别模型无关的
证据交叉验证高风险字段，只做判定、绝不改写文本：

| 校验             | 规则                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 大小写金额互校   | 解析大写金额（支持 `零` 前缀的角/分与 `整/正`）并与同文内任意小写金额比对，容忍 `元/千元/万元/百万元/亿元` 量纲；不一致产生 `amount_words_mismatch` |
| 统一社会信用代码 | GB 32100 加权模 31 校验位                                                                                                                           |
| 身份证号         | ISO 7064 MOD 11-2 校验位 + 出生日期范围                                                                                                             |
| 银行卡/账号      | Luhn（12–19 位）                                                                                                                                    |
| IBAN             | mod 97 = 1，重排后逐位取模                                                                                                                          |
| ISBN             | ISBN-10 加权和模 11、ISBN-13 交替 1/3 模 10                                                                                                         |
| VIN              | 转写值 × 位置权重模 11，第 9 位为校验位                                                                                                             |

带标签（统一社会信用代码/身份证/银行卡/账号/卡号/IBAN/ISBN/VIN/车架号）才触发；
无标签的一串数字一律不猜测，避免把订单号误判成银行卡。失败产生
`identifier_checksum` 问题与 `field_validation_failed` 硬性风险。
`src/ocr-numeric.ts` 同步扩展：中文数字与财务大写、全角、括号负数、尾缀 `-`、
`CR/DR`、货币符号与量纲归一（`numericSemantics` 返回数值、符号、币种、量纲与百分比）。

---

## 10. 质量评估

`src/ocr-quality.ts` 对每次抽取输出 0–1 分、状态、信号、问题清单、可解释分量与硬性风险。
权重会按权重和归一化。

| 信号         | 权重 | 触发问题                                                                                |
| ------------ | ---- | --------------------------------------------------------------------------------------- |
| 平均置信度   | 0.25 | `low_confidence`                                                                        |
| 低置信行占比 | 0.10 | `low_confidence`；block 与表格单元格置信度共同计入，低置信占比 ≥ 25% 时告警             |
| 文本覆盖率   | 0.20 | `low_coverage` / `empty_page` / `empty_text`                                            |
| 表格完整性   | 0.15 | `table_integrity`（空表、行列不一致、缺单元格）                                         |
| 字段算术校验 | 0.15 | `field_mismatch`（合计/总计/小计与明细不符）                                            |
| 列类型校验   | 0.10 | `cell_type_mismatch`（金额/日期/数量/比例列出现无法解析的数值）                         |
| 业务约束     | 0.10 | `business_constraint`（借贷、税额、币种、日期、编号、必填列）                           |
| 阅读顺序     | 0.10 | `reading_order`（重复或缺失的 readingOrder）                                            |
| 重复内容     | 0.05 | `duplicate_content`                                                                     |
| 结构校验     | 0.05 | `block_validation`（validation 为 flagged/failed）                                      |
| 图像质量     | 0.05 | `image_blurry` / `image_exposure` / `image_low_resolution` / `image_glare`              |
| 单元格复认   | 0.05 | `cell_recovery_conflict`（复认候选与原文冲突）                                          |
| 关键区域覆盖 | 0.05 | `key_region_missing`（关键字段区域缺失或未命中）                                        |
| 业务 schema  | 0.10 | `schema_field_missing` / `schema_field_invalid` / `schema_conflict`                     |
| 机读证据     | 0.10 | `machine_readable_confirmed` / `machine_readable_partial` / `machine_readable_mismatch` |
| 预处理选择   | 0.05 | `preprocess_conflict`（增强候选丢失原图数字）                                           |
| Office 覆盖  | 0.05 | `embedded_object_unread` / `tracked_changes_excluded`                                   |

### 10.1 状态判定

- `score >= OCR_QUALITY_REVIEW_THRESHOLD`（默认 0.7）→ `pass`。
- `score < OCR_QUALITY_FAIL_THRESHOLD`（默认 0.45）→ `fail`。
- 其余 → `review`。
- 阈值配置反转时，强制保留至少 1% 的 `review` 区间。
- 空文本直接 `fail`；结果截断或存在未通过结构校验的 block 时最多只能到 `review`。
- 没有 DIR 的旧引擎走宽松路径：缺失置信度但确实有文本时**不再默认 0.75**（改进点
  #64），而是记 `confidence_unknown` 问题、按 `min(复核阈值 - 0.01, 0.5)` 打分并落到
  `review`——「无法评分」必须显式暴露为待复核，不能伪装成通过。
- 运行时优先使用已拟合且样本量达标的阈值 profile；没有可用 profile 时使用默认阈值。
  `quality.calibrated` 表示本次是否实际应用了标注拟合的置信度映射与阈值，而不是
  永远为 false。

### 10.2 硬性风险不可补偿

以下风险即使加权分很高也强制 `review`：

| 风险码                      | 触发条件                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `key_field_low_confidence`  | 关键字段置信度低于 `OCR_KEY_FIELD_CONFIDENCE`（默认 0.85）                                 |
| `key_region_missing`        | 关键区域覆盖不足 50%                                                                       |
| `field_validation_failed`   | 算术/业务约束失败、≥2 个列类型异常、单元格复认冲突、大小写金额不一致、带标签编号校验位失败 |
| `text_layer_mismatch`       | PDF 文本层抽样与渲染 OCR 相似度不足，或数字 token 不一致（改进点 #02）                     |
| `table_structure_risk`      | 表格结构不完整或严重错行                                                                   |
| `image_quality`             | 模糊、曝光、低分辨率、反光、阴影、噪声或倾斜超限                                           |
| `image_retake`              | 图像已不具备可靠识别条件，建议重拍                                                         |
| `small_text`                | 文字高度低于阈值的 65%                                                                     |
| `machine_readable_conflict` | 条码/二维码字段未在正文出现，或 MRZ 校验位失败（评审 #15）                                 |
| `preprocess_conflict`       | 增强候选丢失原图数字 token，差异可能来自预处理伪影（评审 #13）                             |
| `schema_incomplete`         | 已判定业务类型（置信度 ≥ 0.7）但必填字段未识别到（评审 #21）                               |
| `schema_invalid`            | 已判定类型的必填字段格式不合法（评审 #21）                                                 |
| `schema_conflict`           | 已判定类型的字段交叉约束失败，如合计低于税额、甲乙方同名（评审 #21）                       |

区域/单元格复认一致的关键字段是例外：它只提供证据，不改写原文，也不会因为复认
一致就掩盖其他硬性风险。

### 10.3 可解释分量

质量输出同时保留四个分量，便于 UI 解释「为什么复核」：
- `ocrConfidence`
- `structureConfidence`
- `fieldValidation`
- `businessConsistency`

质量分只用于路由与复核，不会修改任何识别文本。

### 10.4 独立证据、业务类型与置信度校准（评审 #15 / #21 / #31）

- **机读证据**：sidecar 从像素解码二维码（OpenCV，可选 pyzbar 补充一维条码），并从
  文本解析 TD1/TD2/TD3 MRZ 与 ICAO 9303 校验位。条码业务 token 与正文一致的关键字段
  标记 `confirmed_independent`；未出现的字段、MRZ 校验失败进入不可补偿硬风险。
  MRZ 字段若在 MRZ 带以外被识别到，只算同引擎一致（`confirmed_same_engine`）。
  证据只用于校验，不写回正文；`OCR_MACHINE_READABLE=0` 可关闭符号解码。
- **业务类型与 schema**：`src/ocr-doc-type.ts` 按加权词法 + 表格证据判定发票、收据、
  合同、证件、银行回单、采购订单、送货单、对账单或 `generic`，要求最高分 ≥ 2 且领先
  第二名 ≥ 1。每个类型定义必填/可选字段、格式校验与跨字段约束，输出 `missing` /
  `invalid` / `conflicts` / `coverage`。`generic` 不检查 schema，不改变评分。
- **置信度校准**：`src/ocr-calibration.ts` 用加权 PAV 等渗回归把原始置信度映射为
  校准置信度；阈值拟合与质量打分都使用映射后的值，profile 输出校准前后 ECE/Brier。
  profile 需达到最少样本与正例数，否则回退默认阈值；映射只调整分数，不改写文本。

---

## 11. 预算级联与恢复

`src/ocr-cascade.ts` 在首次抽取后决定是否追加恢复。阶段类型：
`native` / `visual` / `camelot` / `specialized` / `recovery_dpi` / `recovery_structure` /
`recovery_enhance` / `recovery_region` / `recovery_cell` / `candidate` / `vlm`。
`camelot`、`specialized` 与 `vlm` 只有在对应服务配置后才可能进入级联。

### 11.1 触发与动作

| 场景                                 | 恢复顺序                                                      |
| ------------------------------------ | ------------------------------------------------------------- |
| 关键字段置信度低                     | 区域复认（最多 4 个区域），候选一致即结束                     |
| 表格单元格无法解析或整表置信度低     | 单元格复认（最多 4 个单元格）                                 |
| PDF 有表格问题                       | `structure` → 更高自适应 DPI                                  |
| PDF 弱文本                           | 自适应 DPI → `structure`                                      |
| PDF 图像模糊/曝光/低分辨率或文字过小 | 自适应 DPI → `enhanced` → `structure`                         |
| 图片弱文本                           | `enhanced` → 必要时 `structure`                               |
| 图片有表格问题                       | `structure`（在 `enhanced` 之后）                             |
| 局部恢复后仍不达标且配置了互补模型   | 整页候选复认：互补模型 → 第二引擎（最后一步，严格提分才采用） |
| 配置了可读同格式的第二引擎           | 整页候选复认（`candidate`，自动模式，最多 1 个引擎）          |
| 语言与声明语言明显不符               | 用检测到的语言重跑 `enhanced`                                 |
| 非 Paddle / native / 已截断          | 不恢复                                                        |

### 11.2 期望收益门控

每个恢复动作在运行前估算：
- `expectedGain`：预期质量分提升 × 成功概率。
- `costSeconds`：预计耗时。
- `value`：扣除归一化成本后的净值；只有净值为正才执行。

决策写入阶段 `decision`，避免固定级联浪费预算。阶段按
`引擎 + mode + DPI + 语言 + 模型` 去重，相同参数不重复调用。整页候选复认排在
其他恢复之后：先尝试互补模型，再尝试可读同格式的第二引擎；消息记录与原结果的字符
一致度、质量分变化与是否采用，只有分层评分严格提升才替换最佳结果；截断的候选即使
分数更高也会保留完整结果。引擎候选来自
`OcrClient.candidatesFor`，目前 Docling 额外支持 PDF/图片，因此 Paddle 的 PDF/图片
可获得 Docling 候选；Office 仍只有 Docling。引擎候选使用 `auto` 模式且不继承主引擎
的模型 profile，阶段 `engine` 记录实际执行引擎，重放时按该引擎复现。附件详情在每个
阶段显示引擎、模型与状态，跨引擎候选沿用同一套阶段列表并给出「采用/保留原结果」判定；
Ops 阶段重放按「阶段 + 引擎 + 第几次」选择，结果区回显实际重放引擎。Docling 候选的
DIR 结构比 Paddle 简化（整页 Markdown），因此在表格/版面权重高的页面上通常只作为
交叉证据，不会仅凭文字相似就替换 Paddle 结果；这是保守策略的有意取舍。

成功概率会随历史数据调整：worker 在每次识别后统计恢复阶段是否把质量分提升超过
0.005，累计到 `ocr_recovery_yields`；样本达到 `OCR_RECOVERY_YIELD_MIN_SAMPLES`
（默认 5）后，用 Beta 平滑（先验强度 4）替换硬编码先验，样本不足时仍沿用先验。
治理面板「恢复收益」展示尝试/成功次数、平滑成功率与先验；统计只影响是否花预算，
不改写任何文本。

### 11.3 区域与单元格复认

- 只裁剪关键字段/单元格区域，bbox 外加上下文边距重新识别。
- 第一遍 `auto` + 35% 边距；不一致时追加 `enhanced` + 60% 边距；
  `OCR_REGION_PASSES=3` 时再提高 100 DPI（上限 400）。
- 每个候选保留 pass、mode、DPI、边距、置信度、模型与 `agreesWithInitial`。
- 所有成功候选一致 → `confirmed`；高置信分歧 → `conflict`；只有低置信分歧 →
  `unverified`。冲突与未确认都保留原文。
- 单元格复认优先无法解析的金额/日期/数量/比例/数值单元格，其次低置信整表中的
  类型化单元格；缺坐标时按表 bbox 与行列数估算并标记 `bboxEstimated`。
- 多遍一致且高置信时，原值可在 `fieldEvidence` 中标记为 `candidate_selected`，
  但单元格文本仍保持原样。

### 11.4 语言纠正与自适应 DPI

- 检测脚本/语言与声明语言不兼容时，用识别出的语言 profile 重跑，阶段触发原因记为
  `language_mismatch`；中英兼容场景不会误触发。
- 即使首次结果 `pass`，声明语言与实测脚本明显不符也会追加一次语言纠正。
- 自适应 DPI 根据 DIR 实测文字高度计算（目标约 24px，50 为步长，上限 400），
  不再固定阶梯。

### 11.5 预算与结果选择

- 每步最多 `OCR_CASCADE_MAX_STAGES`（默认 3，含首次）。
- 总时长不超过 `OCR_CASCADE_BUDGET_SECONDS`（默认 180 秒），复认同样计入。
- 单步失败只记录 `failed` stage，不影响已有最佳结果。
- 结果选择按层比较，而不是只看融合分：硬性风险更少 → 关键字段覆盖率更高 →
  页面/区域覆盖率更高 → 字段校验通过率更高 → 表格完整性更好 → 阅读顺序更合理 →
  融合分更高。融合分差在 0.005 以内视为平手，保留已有结果，避免更高分候选掩盖
  漏页、漏字段或结构缺失。
- 所有阶段（kind、status、mode、DPI、耗时、分数、错误、触发原因、决策、参数）
  随附件持久化，UI、基准、看板与回放均可查看。

### 11.6 可重放

每个阶段保存：
- 输入文件 SHA-256；
- 输出 DIR/文本指纹 `outputSha256`；
- 完整参数 `params`（mode、DPI、page、bbox、padding）；
- 评分快照 `quality`（分数、状态、问题码、硬性风险、信号）。

`POST /api/ocr/lab/replay` 可按阶段序号重放整页，或指定 `page + bbox + padding`
只重放单个区域；响应包含 `inputMatches`、`outputMatches`、`scoreDelta` 与重放质量。
哈希为 `null` 表示缺少可比对指纹。

---

## 12. 缓存、复用与重跑

缓存键由以下部分组成：

```text
sha256 + engine + engineModel（模型@流水线@运行时版本/模型哈希）+ configHash + mode + dpi
```

- 内容相同的附件直接复用已有结果，避免重复识别。
- 流水线版本（当前 `dir2`）、Paddle/PaddleOCR 运行时或模型文件哈希变化会使旧缓存失效。
- **配置指纹 `configHash`（改进点 #12）**：`ocrConfigFingerprint()` 对所有会影响识别
  结果的 OCR 环境变量（语言、模式、模型、预处理、级联预算、区域/单元格复认、VLM、
  专项模型、混合路由、页数/字符上限、通道、控制模型等前缀）排序后取 SHA-256 前 16 位，
  写入 `attachments.ocr_config_hash` 并纳入复用条件。端点 URL、Token 与只影响复核/
  门禁的阈值被显式排除，因此调阈值不会作废缓存，而改 DPI 阶梯、语言或预处理参数
  一定会触发重识别——避免「用旧配置识别、按新配置验收」的指标漂移。
- 引入指纹前完成的附件 `ocr_config_hash` 为 `NULL`，不参与新配置的复用。
- 质量 `fail` 的结果不参与复用，避免坏结果扩散。
- **复用范围限定在同一客户/组织内（改进点 #12 / #49）**：`findReusableOcr()` 把候选附件
  所属项目的 `workspace_id` 与目标项目比较（两侧都 `COALESCE(...,'')`，未归属组织的附件
  只与同样未归属的结果互相复用）。仅按内容哈希复用意味着两个客户上传同一份模板
  （同名同字节的表单、发票、对账单）时，后一个客户能读到前一个客户的识别文本，
  属于跨租户数据泄露；同时复用查询排除 `fail`、截断与正在处理的附件。
- `review` 结果可以复用，但会按当前阈值重新评分并保留复核标记。
- 复用与重跑都不信任历史质量分，始终用当前配置重新评估。
- 手动重跑只允许 `done` / `failed` 的附件，排队时清空路由、DIR、质量、阶段与复核标记，
  防止展示过期元数据。
- 无需 OCR 的附件（如纯文本）调用重跑返回 400。

---

## 13. 基准、指标与发布门禁

### 13.1 语料与标注

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
- `provenance` 记录标注人、复核人、时间、原始文件 SHA256 与来源；运行时重新计算哈希
  并给出 `hashVerified`（未声明时为 null），不一致不会阻止运行但会显式标记。
- `uncertain` 字段仍有争议，不计入字段准确率、业务损失与全对率。
- `tables` 提供结构真值；没有表格真值的样本不参与表格指标与门禁。
- 扩展语料位于 `benchmarks/corpus-v2/{wide-tables,degraded-layout,semantic-regions}/`
  （6 / 8 / 7 个样本），每个包附带生成脚本与 `--check` 校验；
  `test/ocr-corpus.test.ts` 复核文件/真值双射与 SHA256。用 `OCR_BENCH_DIR` 指向单个
  包运行，加载器只读取目录顶层文件。
- 默认包含 PDF；Ops 页面可取消勾选（耗时更长）。发布门禁默认要求语料中至少有一个
  PDF 样本（见 13.3）。
- 21 个合成样本用于回归与相对比较，真实扫描/客户分层语料仍待补充，指标不代表生产
  总体准确率。

#### 13.1.1 语料角色切分：dev / calibration / blind（评审 #45）

在同一份语料上既调参又宣布达标，指标必然虚高。基准语料按**模板族**而不是按文件划分角色：
1. **模板族键** `templateKeyOf()`：`kind + 折叠变体后缀的文件名主干`。
   `_(clean|skew|blur|warp|copy|dark|light|v2|3)…` 这类后缀会被逐个剥离，
   因此 `wide_inventory_clean.png` 与 `wide_inventory_skew.png` 属于同一族。
   真值条目可显式写 `template` 覆盖。
2. **角色分配** `splitOf()`：对 `OCR_BENCH_SPLIT_SALT|模板族键` 取 fnv1a 哈希映射到
   `[0,1)`，落在 `OCR_BENCH_DEV_SHARE`（默认 0.6）之内为 `dev`，
   再往后 `OCR_BENCH_CALIBRATION_SHARE`（默认 0.2）为 `calibration`，其余为 `blind`。
   哈希对象是模板族而不是文件名，所以新增无关样本不会改变已有族的角色；
   真值条目写 `split` 可以直接钉住角色。
3. **门禁只看盲测子集**：`aggregateBenchResults()` 仍然输出全量聚合指标供观察，
   但 `gate.checks` 的数值来自 `split === 'blind'` 的子集；`blind_evidence` 检查要求
   盲测子集至少 `OCR_GATE_MIN_BLIND_FILES`（默认 3）个文件。语料完全没有标签时
   该检查为「未评估」，门禁退回全量判定并给出 `note`「语料没有盲测样本，门禁退位在全部样本上判定」。
4. **阈值拟合只用校准子集**：`OcrBench.calibrationSamples()` 在有标签的最近运行上
   跳过非 `calibration` 的结果，并始终并入通过文档审计的无偏结论（见 14.8）。
5. **UI**：Ops 基准区显示「语料切分：调参集 n / 校准集 n / 盲测集 n」并标注门禁所用子集，
   逐文件结果带角色徽标；未通过项与门禁明细会显示 `note`。

`benchmarks/corpus-v2/` 的三个合成包定位为**独立回归层**：它们覆盖真实语料里没有的失败模式
（宽表、退化版面、语义区域），与 `benchmarks/ocr/` 分开运行，不与真实语料混算同一个门禁结论。

### 13.2 指标

| 指标           | 定义                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原始 CER       | 保留大小写与标点，仅折叠空白（CJK 之间的换行空白不计错）                                                                                                                  |
| CER            | 小写并只保留字母、数字与 `%` 后的字符错误率                                                                                                                               |
| 数值 CER       | 只比较数字 token；全角数字/小数点/百分号归一，千分位去除，逗号列表保留                                                                                                    |
| 关键符号 CER   | 金额关键符号骨架（小数点、千分位、正负号、括号、货币符、百分号）的错误率；数字本身算错归数值 CER，丢掉 `-`/`.`/`,`/`()` 算在这里；真值不含关键符号时为 null（改进点 #42） |
| WER            | 空格分词语言（拉丁字母/数字）的词级错误率；CJK 以 CER 为准                                                                                                                |
| 关键词召回     | 归一化后按关键词是否出现计算命中率，适合无法逐字比对的表格/PDF                                                                                                            |
| 字段准确率     | 归一化后逐字段判断是否出现在全文，输出命中数、比例与 95% Wilson 区间；作为召回观察，不单独作为发布证据                                                                    |
| 字段强命中率   | 命中必须能定位：标注页/bbox、真值上下文，或同一 block 内长度 ≥2 的标签旁的值；无法定位的字段记为 `unverifiable`，排除在分母外，全语料不可定位时为 null                    |
| 字段精确率     | 仅折叠空白后逐字段精确匹配，保留千分位、百分号等格式差异                                                                                                                  |
| 文档全对率     | 所有非 uncertain 字段命中且 CER 为 0 的文档比例，附 95% Wilson 区间                                                                                                       |
| 业务损失       | 按字段风险加权：金额/账号 8、日期 4、币种/编号 3、数量 2、文本 1；数值字段按最接近数字串的编辑距离计分                                                                    |
| 表格结构       | 行/列签名 F1、同位置单元格准确率、bbox IoU、合并单元格跨度准确率与简化 TEDS                                                                                               |
| 错误分类       | 字符替换/插入/删除、缺失字段、表格结构、阅读顺序、重复文本等；输出 Top 分类、计数与前 3 个样本；同时保留替换/插入/删除的归一化偏移与上下文                                |
| 错误诊断       | 区分检测/切分与识别两类可疑原因                                                                                                                                           |
| 置信度校准     | 置信度与全对结果的分箱对比，输出 ECE 与 Brier                                                                                                                             |
| 分组校准       | 按文档类型与语言分别输出 ECE/Brier；样本不足时只报告样本数                                                                                                                |
| 字段类别可靠性 | 按金额/日期/账号/编号/数量/比例/币种归类，输出命中率、Wilson 区间、可定位样本数与口径（强/混合/弱）及类别内 ECE/Brier                                                     |
| 分层结果       | 按文档类型、语言、难度与退化类型统计 CER、字段准确率及其样本数、全对率与页数                                                                                              |
| 样本规模       | 文档数、评估数、总页数与总字符数                                                                                                                                          |
| 质量分/状态    | 观察启发式分数与真实错误的相关性                                                                                                                                          |
| 路由/阶段/耗时 | 评估 native 占比、恢复次数与成本                                                                                                                                          |

### 13.3 发布门禁

聚合结果按环境变量检查：
- CER 上限 `OCR_GATE_MAX_CER`（默认 0.05）。
- 数值 CER 上限 `OCR_GATE_MAX_NUMERIC_CER`（默认 0.02）。
- 关键符号 CER 上限 `OCR_GATE_MAX_SYMBOL_CER`（默认 0.01）：只盯小数点、千分位、
  正负号、括号、货币符与百分号，专门捕捉「数字对但符号丢/换位」这类金额事故。
- 按文档类型覆盖 `OCR_GATE_MAX_CER_<KIND>`，未配置时回退统一 CER 上限。
- **字段强命中率下限** `OCR_GATE_MIN_FIELD_STRONG_ACCURACY`（默认 0.9，改进点 #41）：
  只有能定位到页面区域/真值上下文/同块标签的值才算命中；找不到定位证据的字段记入
  `fieldStrong.unverifiable`，不进分子也不进分母。整份语料没有可定位字段时该项为
  「未评估」，不会因为一个值碰巧出现在全文而放行。旧运行没有该计数时以 null 保存，
  UI 不把它显示为 0。
- 文档全对率下限 `OCR_GATE_MIN_FULLY_CORRECT`（默认 0.8）。
- **Wilson 95% 下界**（改进点 #43）：字段**强命中**下界
  `OCR_GATE_MIN_FIELD_ACCURACY_LOWER`（默认 0.9）与全对率下界
  `OCR_GATE_MIN_FULLY_CORRECT_LOWER`（默认 0.7）。小语料上的
  点估计靠运气也能过，门禁只看有统计支撑的下界。
- **高风险字段类别门槛**：金额 `OCR_GATE_MIN_AMOUNT_ACCURACY`（0.99）、账号
  `OCR_GATE_MIN_ACCOUNT_ACCURACY`（0.99）、日期 `OCR_GATE_MIN_DATE_ACCURACY`（0.95）、
  编号 `OCR_GATE_MIN_IDENTIFIER_ACCURACY`（0.95），同样按 Wilson 下界判定；且该类
  比较数必须 ≥ `OCR_GATE_MIN_CATEGORY_SAMPLES`（默认 30），样本不足直接判失败而不是放行。
  语料里完全不存在的类别不生成检查项。类别可靠性带口径标注：全部可定位为「强」，
  部分可定位为「混合」，完全不可定位为「弱」；弱/混合口径的检查附 `note`，说明
  该数字仍含全文包含成分，避免被当成强证据。
- 失败率上限 `OCR_GATE_MAX_FAILED_RATE`（默认 0.1）。
- 加权业务损失上限 `OCR_GATE_MAX_BUSINESS_LOSS`（默认 0.05）。
- 表格 TEDS 下限 `OCR_GATE_MIN_TABLE_TEDS`（默认 0.9）。
- **PDF 证据要求**：`pdf_evidence` 检查语料中 `kind = pdf` 的文件数 ≥
  `OCR_GATE_MIN_PDF_FILES`（默认 1）。native-first 的 PDF 路径是产品核心，一次没有
  PDF 样本的基准运行不能签发发布结论；确实没有 PDF 语料时可用 `OCR_GATE_REQUIRE_PDF=0`
  显式关闭（改进点 #66）。
- 最差分组 CER 上限 `OCR_GATE_MAX_WORST_GROUP_CER`（默认 0.15）与最差分组字段
  准确率下限 `OCR_GATE_MIN_WORST_GROUP_FIELD_ACCURACY`（默认 0.85）。分组维度为
  文档类型、语言、难度与退化类型；只有文件数 ≥ `OCR_GATE_WORST_GROUP_MIN_FILES`
  （默认 3）且字段比较数 ≥ `OCR_GATE_WORST_GROUP_MIN_FIELDS`（默认 3）的分组参与，
  避免单文件或单字段桶翻转门禁。总体平均合格但某一组严重退化时门禁失败。
- 两项最差分组检查会把实际命中的分组写入 `group`（维度 + 分组值），Ops 页面直接展示
  「最差分组 CER（语言：ja）」这类归因，并把字段样本数（`fieldTotal`）列在分层表中，
  提示小样本桶的噪声。字段最差分组优先用强命中率比较；某分组没有可定位字段证据时
  退回全文包含口径，并在检查上写 `note`。
- **证据充分性**（改进点 #67）：每个比率检查按阈值反推所需观测数写入
  `requiredSamples`。点估计通过但观测数不足的检查仍标为通过，同时由
  `evidence_sufficiency` 汇总并判门禁未达标；`OCR_GATE_ALLOW_THIN_EVIDENCE=1`
  可显式放行（只建议用于探索性运行）。表格 TEDS 至少需要
  `OCR_GATE_MIN_TABLE_STRUCTURE_SAMPLES`（默认 5）张表，校准 ECE 至少需要
  `OCR_GATE_ECE_MIN_SAMPLES`（默认 20）条置信样本才参与判定。Ops 页面把「低于阈值」
  显示为「未达标」，把「样本不足」显示为「证据不足」，并列出各指标还差多少观测。

任一项不满足即 `gate.passed = false`；没有表格真值时该项为「未评估」，不阻塞门禁。
门禁只用于发布决策，不修改逐文件结果。
- **判定子集**：语料带角色标签时，所有门禁数值只在 `blind` 子集上计算（全量聚合指标
  仍然展示，但不参与判定）；`blind_evidence` 要求盲测文件数 ≥
  `OCR_GATE_MIN_BLIND_FILES`（默认 3）。没有标签的语料退化为全量判定，检查记为
  「未评估」并附 `note`，UI 在门禁明细里显示退位原因（见 13.1.1）。

### 13.4 运行、回放与实验

- 运行：Ops 页面「运行基准」或 `POST /api/ocr/lab/run`，仅工作区管理员。
- 结果持久化，支持当前运行、逐文件结果、聚合指标、分层表、错误分类、校准、
  业务损失、表格结构、历史运行与样本链接。
- 回放：`POST /api/ocr/lab/replay`，请求体
  `{ name, kind, occurrence?, page?, bbox?, padding? }`。
- 对照实验：`GET/POST /api/ocr/lab/experiment`，支持模型 × 预处理（mode + DPI + 通道）
  组合；最多 12 个变体，先分层筛选，再把最优变体跑全量，综合 CER/字段/耗时排序。
  通道取 `rgb`（默认）、`gray` 或 `red`，仅 PaddleOCR 支持；汇总与变体都带 `channel`，
  可直接按通道对比同一语料。
- 模型矩阵记录许可证、内存占用与能力，不用版本新旧代替实测。

### 13.5 推荐验证流程

1. 固定语料与 `conditions`，先跑基线并保留历史。
2. 一次只改一个变量（模型、模式、DPI 或后处理），避免收益无法归因。
3. 业务关键场景优先看数值 CER 与字段准确率，再结合整体 CER。
4. 同时观察路由、阶段数与耗时，确认准确率提升没有带来不可接受成本。
5. 出现回退时对比历史结果，定位是哪类样本变差，再决定是否保留改动。
6. 上线前通过门禁；上线后观察生产看板、漂移与投诉，并记录到优化台账。

---

## 14. 生产治理闭环

### 14.1 反馈样本池与主动学习

OCR 完成（含缓存复用）、人工字段修订与用户投诉会进入样本池：
- 错误类型：`low_confidence`、`model_disagreement`、`field_validation`、
  `human_revision`、`user_complaint`。
- 去重键：`sha256 ?? attachmentId` + 错误类型；重复回流不新增行。
- 信号：
  - `uncertainty`：由 confidence 线性映射，缺少 confidence 时按质量状态估计。
  - `disagreement`：字段冲突/未确认/多模型文本差异，字段校验失败时下限 0.5。
  - `fieldFailure`：失败/标记字段比例、`signals.fieldAccuracy`、硬风险。
  - `novelty`：按池内文档类别计数，新类别更高。
  - `revision`：存在人工修订。
- 优先级：
  `0.3×uncertainty + 0.3×disagreement + 0.25×fieldFailure + 0.1×novelty + 0.05×revision`。
- 抽样：按「错误类型 × 文档类别」分层，每组按**优先级 / 标注成本**降序轮询；
  受 `perStratum`、`total` 与可选 `budget` 三重限制，返回已用/剩余预算与类别覆盖。
- 标注成本是相对单位：投诉与模型分歧高于低置信确认，定位到具体 page/field 有少量附加；
  预算不足时跳过昂贵的低价值样本，而不是挤占全部名额。
- 状态流转 `pool` → `sampled` → `labeled` / `dismissed`；复核修订、投诉、缓存复用完成
  与 worker 完成都会自动回流，重复回流按去重键忽略。
- 回流只记录附件、字段、page/block/bbox 与信号，不复制或改写识别原文。

### 14.2 生产质量看板

`GET /api/ocr/quality/dashboard?days=N` 聚合最近 1–365 天（默认 30 天）的 OCR 元数据，
不返回文档正文：
- 总量与比率：文档数、完成/失败/排队/处理中、失败率、复核率、截断率、
  修订观察率（有修订文档数 / 完成数，`revisionObservedRate`）、修订总数。
- 代理指标：`confidenceRiskProxy = 1 − 平均 confidence`，只用于趋势监控；
  `revisionObservedRate` 是人工修订的观察值，两者都不等同于真实 CER / 字段错误率。
  Ops 看板的指标卡与表头显式标注「（代理）」，生产看板文案也注明「非真实 CER」。
- 延迟与吞吐：平均耗时、p95 耗时、总页数、总字符数、字符/秒。
- 分组：模型（`engine:model`）、语言、文件类型、客户/组织（工作区）、业务类型（按文件名
  推断发票/收据/合同/报告/证件/表格等，不读正文）、页数区间（1、2–3、4–10、11–20、21+）
  与处理阶段。
- 客户/组织维度同时返回该组织已拟合的阈值 profile；未校准组织回退整体阈值。

### 14.3 数据漂移

- 对分辨率、语言、文件类型、页面尺寸、噪声与版面六类元数据建立分布。
- 使用 total variation distance 与基线比较，默认阈值 0.2。
- 基线少于 20 个样本或当前窗口少于 10 个样本时状态为 `insufficient`，不误报。
- 超过阈值为 `warn`；≥ 1.75× 阈值为 `critical`，列出偏移最大的 3 个桶，
  给出补语料与重新评估建议。
- 基线是显式快照，告警按「维度 + 日期」去重持久化。
- 漂移只比较元数据分布；分布稳定不代表内容质量稳定，需要结合看板与投诉判断。

### 14.4 版本链与优化台账

`GET .../ocr/versions` 把一次识别组装为不可变节点链：
1. `original`：原始 OCR 文本摘要、引擎/模型、路由、模式、DPI、质量状态。
2. `stage`：级联各阶段的输入/输出 SHA-256、触发原因、决策、参数、质量与耗时。
3. `selection`：字段候选选择，保留原始文本、选中候选、候选模型、轮次与失败摘要。
4. `revision`：人工修订文本、原始值、原因、修改人与证据区域。

每个节点带 `parents` 指向前一步；修订优先挂在对应字段选择上。版本链只读，不覆盖原文。

`ocr_optimizations` 是持续优化台账：
- 记录目标错误类型、预期收益（0–1）、实现成本（人日）、推理成本（相对值）、
  风险、基准结果、生产观察、状态（proposed / implemented / measured / rolled_back）
  与创建人。
- 排序分：`expectedGain / max(0.1, implementationCost + inferenceCost)`。
- 用同一把尺子比较不同优化项，避免同时引入多个改动后无法归因。

### 14.5 灰度发布与模型注册表

注册表把模型/流水线分到四类角色：`control`、`candidate`、`rollback`、`retired`。
当存在注册表条目时，worker 以注册表为准；没有条目时回退到环境变量灰度配置。

| 模式       | 行为                                                   |
| ---------- | ------------------------------------------------------ |
| `canary`   | 按附件 ID 确定性分桶，候选模型只服务配置比例的流量     |
| `shadow`   | 对照组结果为准；候选模型旁路运行，比较文本相似度与耗时 |
| `rollback` | 全量回到回滚模型                                       |
- 分桶确定性，同一附件不会在候选/对照之间漂移。
- 候选 `percent` 为 0 或 100 时视为无 canary，worker 直接使用注册的 control 模型。
- 模型 profile 缺失时记录告警并回退，不阻断识别。
- 灰度不改变路由原因，只替换侧车模型 profile；缓存键包含模型指纹，避免误用旧结果。
- **自动晋级**：候选与对照的基准样本都达到 `minSamples`，候选领先 ≥ `promoteMargin`
  且生产分不明显低于对照时，候选晋升为 control，原 control 转为 rollback。
- **统计显著性**：存在完整实验结果时，按文件配对候选/对照的 CER，只统计可比文件；
  胜/负/平分别对应候选更低/更高/相同 CER。可比较文件达到 `minSamples`、候选胜多负少
  且精确双侧 McNemar 检验 `p ≤ significance` 才允许自动晋级，否则保持 `hold` 并说明
  原因。没有配对证据时保持旧行为（仅看分数与样本），人工决策不受影响。
- **自动回滚**：control 的生产或基准分低于 rollback ≥ `rollbackMargin` 时，恢复
  rollback 为 control；比较使用 `<= -margin`，与晋级阈值对称。
- 人工可随时 `promote` / `rollback` / `hold` / `retire` / `pin` / 调整 `percent` 与
  `mode`；人工决策写入不可变审计表，`hold` 只记录不改变角色。
- 自动策略受 `OCR_REGISTRY_AUTO` 与样本/边际变量控制；关闭自动后仍保留人工操作。

### 14.6 文档知识图谱

`GET /api/ocr/knowledge` 在读取时跨附件构建只读知识图谱，不新增写入路径：
- 实体类型：编号（identifier）、账号（account）、金额（amount）、日期（date）。
- 归一化：编号去标签与空白并统一大小写；账号只保留数字；金额保留规范数值并识别
  CNY/USD/EUR/GBP；日期同时接受紧凑数字与 `2026年9月1日` 等单数字月日形式。
- 字段取值为最新人工修订值；没有修订时使用原 OCR 字段。原文本始终保留在各 occurrence。
- 关系：
  - `shared`：同一实体出现在多个附件（按附件去重后建立星型关系）。
  - `mentions`：编号/账号出现在另一附件的识别正文中，建立跨文档引用。
- 指标：文档数、实体总数、跨文档实体数，以及按币种与月份的金额合计。
- 跳过无法归一化的字段并返回 warning；实体与关系有上限，防止超大工作区拖慢响应。
- 图谱只用于检索、关联与对账，不回写 OCR 文本，也不替代人工确认。

### 14.7 阈值校准

`POST /api/ocr/calibration/fit` 用标注样本拟合复核阈值、失败阈值与关键字段置信度：
- 维度：`overall`、`kind`、`difficulty`、`language`、`file_type`、`workspace`。
- 复核阈值以 Youden J 为主，并受精确率/召回目标约束；失败阈值低于复核阈值。
- 每个 profile 输出样本数、正例数、precision/recall、false review rate、ECE 与 Brier；
  样本或正例不足时标记 `calibrated=false`，ECE/Brier 仅作报告。
- 达标的 profile 同时拟合加权 PAV 等渗置信度映射（原始 → 校准），阈值和质量打分都在
  校准后的置信度上计算，避免在乐观的原始分上再切阈值；输出校准前后 ECE
  （`ece` / `calibratedEce`）与持久化的 `confidenceMap`。
- 选择 profile 时按最具体且已校准的维度回退到整体；运行时通过
  `thresholdsFromProfile` 注入质量引擎与关键字段门槛。
- 客户/组织阈值随生产看板返回，未校准组织显式回退整体配置。
- 拟合样本来源：最近一次基准运行的 `calibration` 子集 + 通过文档随机审计的审结结论
  （见 14.8）。语料没有角色标签时退回使用全部基准结果，保持向后兼容。

### 14.8 通过文档随机审计与静默错误率（评审 #38）

14.1 的样本池只收集**系统自己怀疑过**的文档（低置信、模型分歧、字段校验失败、人工修订、
投诉）。用它算出的错误率带有选择偏差：质量分高但实际读错的文档根本不会进池，
「静默错误率」无法估计，而它恰恰是自动化程度越高越危险的指标。

`src/stores/ocr-audits.ts` + `ocr_pass_audits` 表补上这条无偏路径：
- **总体**：`ocr_status = done`、有文本、未截断、`ocr_quality_status = pass`
  且 `ocr_review_required = 0` 的附件。
- **分层随机抽样**：按文件类型（扩展名）分层；层内顺序为
  `sha256(period|attachmentId|OCR_AUDIT_SALT)`，同周期同盐值可复现，换盐值换一批。
  每层取 `min(层内数量, perType, max(1, ceil(层内数量 × fraction)))`，
  已抽过的附件不再入池（`UNIQUE (attachment_id)`）。
- **周期**：ISO 周 `YYYY-Www`（`OcrPassAuditStore.periodOf`），可按 `period` 查询历史。
- **双人独立复核**：结论只接受 `clean` / `error`。同一人重复提交覆盖自己那一栏；
  第一栏空 → 记一审，否则记二审；两栏都已被他人填写 → 400
  「该样本已有两名复核人，需要第三人重新抽样」。只有一审的样本状态是 `pending`，
  **不算审结**，两审一致才取该结论，不一致记 `disputed`。
- **指标**：静默错误率 = `(error + disputed) / audited`（分歧按有错处理，估计偏保守），
  附 95% Wilson 区间（`src/stats.ts`）；另输出分歧率 `disputed / 双审样本数`、
  抽样覆盖率 `sampled / passDocuments` 与按文件类型的同口径明细。
- **反哺**：审结样本以 `correct = 两审一致且为 clean` 进入 `OcrCalibrationSample`，
  与基准校准子集一起参与 14.7 的阈值拟合——这是唯一不受系统自我怀疑影响的标注来源。
- **接口**（均仅工作区管理员，写审计事件 `ocr.pass_audit_sampled` / `ocr.pass_audited`）：
  - `GET /api/ocr/pass-audits?status=all|pending|audited&period&projectId`
  - `POST /api/ocr/pass-audits/sample` `{ fraction 0.001–0.2, perType 1–50, period, projectId }`
  - `POST /api/ocr/pass-audits/:id/verdict` `{ verdict: clean|error, note ≤500 字 }`
- **UI**：Ops →「OCR 生产治理」→「通过文档随机审计」，标题即显示静默错误率与
  `已审/抽样` 数；展开后有指标条（通过文档数、抽样与覆盖率、待复核、一致通过、
  一致有错、分歧、分歧率、95% 区间）、抽样比例与每类上限输入、抽取按钮、队列筛选、
  逐条一审/二审与结论（含干净/有错按钮和说明输入），以及按文件类型的明细表。

---

## 15. 人工复核、字段溯源与修订

- 质量状态为 `review` / `fail` 时，附件记录 `ocr_review_required = 1`。
- 附件列表的 OCR 标签显示「待复核」，详情弹窗展示质量分、结构化统计、问题清单、
  级联阶段、关键字段候选证据、版本链与 DIR。
- `GET .../ocr/fields` 返回关键字段（含表格类型化单元格）的 page / block / bbox /
  crop、模型与阶段、原始置信度、校验规则、数字规范值、复认候选和修订历史。
- `POST .../ocr/fields/:fieldId/revisions` 记录原始 OCR 值、修订值、原因、修改人、
  时间与证据区域，写入独立表，不覆盖 `ocr_text`。
- `POST .../ocr/complaints` 记录用户投诉，进入反馈池与审计事件，不修改原文。
- 系统不自动替换、润色或补全文本；复核入口只提供原文、候选与诊断信息。
- 质量 `fail` 的缓存不会被其他上传复用。
- 复核数据是阈值校准、主动学习与优化台账的输入。

### 15.1 数据生命周期与脱敏导出（评审 #49）

- `OCR_RETENTION_DAYS=0`（默认）永久保留；大于 0 时每日保留任务清除过期 OCR 的
  `ocr_text` / `ocr_raw_text` / DIR / 质量 / 阶段数据与字段修订，并写入
  `ocr_purged_at`。附件与识别元数据保留；被清理的附件需重新识别才能导出文本。
- 删除附件级联删除 OCR 结果、字段修订与识别记录，所有引用表使用
  `ON DELETE CASCADE` 或 `ON DELETE SET NULL`。
- `GET .../ocr/export` 返回脱敏文本与替换计数（身份证、手机、座机、邮箱、银行卡、
  MRZ 行）；先处理 MRZ 与身份证，再匹配通用卡号，并带边界避免误改相邻编号或日期。
  审计只记录项目、附件、字符数与计数，不记录正文或 PII；导出不进入离线快照缓存。
- 缓存复用限定在同一工作区，跨租户/跨组织不会因哈希相同而读到对方文本。

---

## 16. API 与 UI

### 16.1 API

| 接口                                                   | 权限          | 说明                                        |
| ------------------------------------------------------ | ------------- | ------------------------------------------- |
| `GET /api/projects/:id/attachments/:attachmentId/ocr`  | 项目可见      | 文本、DIR、质量、阶段与摘要                 |
| `GET .../ocr/export`                                   | 项目可见      | 脱敏文本与替换计数；已清理或未完成时拒绝    |
| `POST /api/projects/:id/attachments/:attachmentId/ocr` | 项目可写      | 重跑，可选 `mode` / `dpi`                   |
| `GET .../ocr/fields`                                   | 项目可见      | 关键字段定位、校验与修订历史                |
| `POST .../ocr/fields/:fieldId/revisions`               | 上传者/管理者 | 记录字段级人工修订                          |
| `GET .../ocr/versions`                                 | 项目可见      | 原始/阶段/选择/修订版本链                   |
| `POST .../ocr/complaints`                              | 项目成员      | 用户投诉回流，不修改原文                    |
| `GET /api/ocr/feedback`                                | 工作区管理员  | 错误样本池与过滤                            |
| `POST /api/ocr/feedback/sync`                          | 工作区管理员  | 回填近期 OCR 样本                           |
| `POST /api/ocr/feedback/sample`                        | 工作区管理员  | 分层主动学习抽样（可选预算）                |
| `POST /api/ocr/feedback/:id/status`                    | 工作区管理员  | 样本标注/忽略状态                           |
| `GET /api/ocr/quality/dashboard`                       | 工作区管理员  | 生产质量看板与告警                          |
| `GET /api/ocr/knowledge`                               | 工作区管理员  | 跨附件知识图谱与金额指标                    |
| `GET /api/ocr/calibration`                             | 工作区管理员  | 分维度阈值 profile                          |
| `POST /api/ocr/calibration/fit`                        | 工作区管理员  | 用标注/基准样本拟合阈值                     |
| `GET /api/ocr/registry`                                | 工作区管理员  | 注册表角色、决策与策略                      |
| `POST /api/ocr/registry/register`                      | 工作区管理员  | 注册模型/流水线                             |
| `POST /api/ocr/registry/decision`                      | 工作区管理员  | 人工晋级/回滚/固定/退场或调整灰度比例与模式 |
| `POST /api/ocr/registry/evaluate`                      | 工作区管理员  | 同步指标并执行自动晋级/回滚                 |
| `GET /api/ocr/recovery-yields`                         | 工作区管理员  | 恢复阶段历史成功率与平滑先验                |
| `GET /api/ocr/pass-audits`                             | 工作区管理员  | 通过文档审计队列、静默错误率与按类型明细    |
| `POST /api/ocr/pass-audits/sample`                     | 工作区管理员  | 按文件类型分层随机抽样通过文档              |
| `POST /api/ocr/pass-audits/:id/verdict`                | 工作区管理员  | 登记第一/第二复核结论（`clean` / `error`）  |
| `GET /api/ocr/drift`                                   | 工作区管理员  | 数据漂移报告                                |
| `POST /api/ocr/drift/baseline`                         | 工作区管理员  | 保存漂移基线                                |
| `POST /api/ocr/drift/check`                            | 工作区管理员  | 检查并持久化漂移告警                        |
| `GET/POST /api/ocr/optimizations`                      | 工作区管理员  | 优化台账查询与新增                          |
| `PATCH /api/ocr/optimizations/:id`                     | 工作区管理员  | 更新状态与生产观察                          |
| `GET /api/ocr/lab`                                     | 工作区管理员  | 语料、模型、最近运行与历史                  |
| `POST /api/ocr/lab/run`                                | 工作区管理员  | 运行基准，可选 `includePdf`                 |
| `POST /api/ocr/lab/replay`                             | 工作区管理员  | 重放指定阶段/区域                           |
| `GET /api/ocr/lab/experiment`                          | 工作区管理员  | 最近一次模型/预处理对照实验                 |
| `POST /api/ocr/lab/experiment`                         | 工作区管理员  | 运行对照实验并综合排序                      |

### 16.2 UI

- 附件面板：OCR 状态、模型、路由、质量标签、复核提示；上传入口是真实按钮，
  轮询、字段证据与版本链失败会就地提示并可重试，关闭弹窗会作废未完成的读取，
  避免旧响应覆盖新选择；窄屏下附件行自动换行。
- 详情弹窗：全文、结构化统计、问题清单、级联阶段、关键字段候选证据、版本链、DIR、
  投诉入口；每个阶段显示引擎与模型，失败/跳过同时给出文字状态（不只依赖颜色），
  候选阶段额外说明整页第二意见只在质量分严格提升时采用；投诉输入有显式 `<label>`，
  待处理/完成状态使用 `role="status"`，失败使用 `role="alert"`。
- Ops 页面：基准运行、聚合指标、分层结果、分组校准、字段类别可靠性、错误分类、
  置信度校准、发布门禁（通过/失败分别显示 `≤`/`>`、`≥`/`<`）、历史运行，
  以及「模型与预处理对照实验」和「阶段重放」：
  - 对照实验可选择引擎、模式、DPI 与 RGB/灰度/红通道，配置抽样数、晋级数与是否跑全量；
    结果表按排名显示变体、CER/数值 CER、字段准确率与耗时。
  - 阶段重放按「阶段 + 引擎 + 第几次」选择（同名阶段不再靠手填 occurrence），
    展示实际重放引擎、输入/输出指纹是否一致、质量分前后变化与区域候选文本。
  - 基准/实验加载失败显示告警与重试按钮；已有数据时保留上次成功结果并标注刷新失败。
- 生产治理页签：质量看板、客户/组织阈值、错误样本池（可配置每层/总量/预算，
  显示筛选命中数与当前已加载数，支持「加载更多」分页）、漂移告警、文档知识图谱、
  优化台账、模型注册表（候选灰度比例与模式内联调整、固定/恢复自动、退役与回退二次确认）
  与决策审计，以及「质量阈值配置」：显示各维度 profile、校准状态、样本/正例数、
  复核/失败/关键字段阈值、ECE 与更新时间，并可用最近基准样本重新拟合。
- Ops「OCR 生产治理」中的「通过文档随机审计」面板：标题即显示静默错误率与
  `已审/抽样`，展开后有指标条（通过文档数、抽样与覆盖率、待复核、一致通过、一致有错、
  分歧、分歧率、95% Wilson 区间）、抽样比例与每类上限输入、「抽取本周审计样本」、
  队列筛选（待复核/已审结/全部）、逐条一审/二审与结论 + 干净/有错按钮 + 说明输入，
  以及按文件类型的静默错误率明细表（见 14.8）。
- 附件详情的识别文本默认展示归一化版本；当引擎原文与归一文本不一致时提供
  「查看引擎原文 / 查看归一文本」切换，复核时可以确认归一没有改动编号与金额（见 6.2.1）。
- 附件详情同时展示机读符号（QR/条码/MRZ 与校验失败数）、预处理冲突页数、Office
  覆盖（页眉页脚、脚注、批注、图表、图片、嵌入对象、修订过滤、隐藏页），以及业务
  类型 chip（类型、证据、必填覆盖率、缺失/格式无效/矛盾字段）。已清理文本显示清理
  时间与重跑提示；完成且未清理时可下载脱敏文本，删除与导出都有明确结果提示。

---

## 17. 配置

### 17.1 路由与引擎

| 变量                                     | 默认值                | 说明                             |
| ---------------------------------------- | --------------------- | -------------------------------- |
| `OCR_PADDLE_URL`                         | 空（禁用）            | Paddle sidecar 地址              |
| `OCR_DOCLING_URL`                        | 空（禁用）            | Docling sidecar 地址             |
| `OCR_TOKEN`                              | 空                    | sidecar 共享密钥                 |
| `OCR_PADDLE_DET_MODEL`                   | `PP-OCRv6_medium_det` | 检测模型                         |
| `OCR_PADDLE_REC_MODEL`                   | `PP-OCRv6_medium_rec` | 识别模型                         |
| `OCR_PDF_DPI`                            | 200                   | 扫描页默认渲染 DPI               |
| `OCR_MAX_PDF_PAGES`                      | 100                   | 单份 PDF 最多 OCR 的扫描页数     |
| `OCR_MAX_PDF_TOTAL_PAGES`                | 1000                  | 单份 PDF 最多检查的总页数        |
| `OCR_PDF_TIME_BUDGET_SECONDS`            | 240                   | 单份 PDF 的识别时间预算          |
| `OCR_PDF_TEXT_TRUST_MIN`                 | 0.6                   | 使用原生文本层的最低可信度       |
| `OCR_PDF_TEXT_CROSSCHECK_RATE`           | 0.1                   | 文本层抽样交叉验证比例（0 关闭） |
| `OCR_PDF_TEXT_CROSSCHECK_MAX_PAGES`      | 2                     | 单份 PDF 最多抽样验证页数        |
| `OCR_PDF_TEXT_CROSSCHECK_MIN_SIMILARITY` | 0.85                  | 抽样页视为一致的最低相似度       |
| `OCR_MAX_IMAGE_FRAMES`                   | 20                    | 多帧图片最多处理帧数             |
| `OCR_INTERVAL_SECONDS`                   | 5                     | worker 轮询间隔                  |
| `OCR_TIMEOUT_SECONDS`                    | 300                   | 单附件请求超时                   |
| `OCR_MAX_CHARACTERS`                     | 500000                | 返回文本上限                     |
| `OCR_HYBRID_IMAGE_MIN_RATIO`             | 0.04                  | 原生页嵌入图最小面积占比         |
| `OCR_HYBRID_IMAGE_MAX_REGIONS`           | 2                     | 单页最多 OCR 的嵌入图区域数      |

### 17.2 质量与预处理

| 变量                               | 默认值 | 说明                          |
| ---------------------------------- | ------ | ----------------------------- |
| `OCR_QUALITY_REVIEW_THRESHOLD`     | 0.7    | 低于该分数标记人工复核        |
| `OCR_QUALITY_FAIL_THRESHOLD`       | 0.45   | 低于该分数标记失败            |
| `OCR_LOW_CONFIDENCE`               | 0.75   | 行级/单元格低置信阈值         |
| `OCR_KEY_FIELD_CONFIDENCE`         | 0.85   | 关键字段置信度门槛            |
| `OCR_MIN_SHARPNESS`                | 0.2    | 图像清晰度下限                |
| `OCR_MIN_BRIGHTNESS`               | 0.25   | 图像亮度下限                  |
| `OCR_MAX_BRIGHTNESS`               | 0.95   | 图像亮度上限                  |
| `OCR_MIN_CONTRAST`                 | 0.08   | 图像对比度下限                |
| `OCR_MIN_PIXELS`                   | 300000 | 图像像素总数下限              |
| `OCR_MIN_TEXT_HEIGHT`              | 12     | 文字高度下限（px）            |
| `OCR_MAX_GLARE`                    | 0.02   | 反光像素比例上限              |
| `OCR_MAX_SHADOW`                   | 0.35   | 阴影亮度差上限                |
| `OCR_MAX_NOISE`                    | 0.09   | 噪声估计上限                  |
| `OCR_MAX_SKEW`                     | 3      | 倾斜角上限（度）              |
| `OCR_PREPROCESS_MAX_CANDIDATES`    | 4      | 增强模式最多生成候选数        |
| `OCR_PREPROCESS_GEOMETRY`          | 0      | 是否启用透视/去倾斜矫正       |
| `OCR_MACHINE_READABLE`             | 1      | 是否解码二维码/条码（0 关闭） |
| `OCR_MACHINE_READABLE_MAX_SYMBOLS` | 8      | 单页最多解码的符号数          |

### 17.3 级联与门禁

| 变量                                      | 默认值           | 说明                                           |
| ----------------------------------------- | ---------------- | ---------------------------------------------- |
| `OCR_CASCADE_MAX_STAGES`                  | 3                | 含首次抽取的最大阶段数                         |
| `OCR_CASCADE_BUDGET_SECONDS`              | 180              | 单附件级联总时长上限                           |
| `OCR_RECOVERY_YIELD_MIN_SAMPLES`          | 5                | 启用实测恢复成功率所需的最少尝试次数           |
| `OCR_REGION_MAX_CANDIDATES`               | 4                | 单次最多复认区域数                             |
| `OCR_REGION_PASSES`                       | 2                | 每个区域最多复认遍数（1–3）                    |
| `OCR_CELL_MAX_CANDIDATES`                 | 4                | 单次最多复认单元格数                           |
| `OCR_CELL_PASSES`                         | 2                | 每个单元格最多复认遍数（1–3）                  |
| `OCR_GATE_MAX_CER`                        | 0.05             | 发布门禁 CER 上限                              |
| `OCR_GATE_MAX_NUMERIC_CER`                | 0.02             | 发布门禁数值 CER 上限                          |
| `OCR_GATE_MAX_CER_<KIND>`                 | 回退到 CER 上限  | 按文档类型覆盖 CER 上限                        |
| `OCR_GATE_MIN_FIELD_STRONG_ACCURACY`      | 0.9              | 发布门禁字段强命中率下限                       |
| `OCR_GATE_MIN_FULLY_CORRECT`              | 0.8              | 发布门禁文档全对率下限                         |
| `OCR_GATE_MAX_FAILED_RATE`                | 0.1              | 发布门禁失败率上限                             |
| `OCR_GATE_MAX_BUSINESS_LOSS`              | 0.05             | 发布门禁加权业务损失上限                       |
| `OCR_GATE_MIN_TABLE_TEDS`                 | 0.9              | 发布门禁表格 TEDS 下限                         |
| `OCR_GATE_MIN_TABLE_STRUCTURE_SAMPLES`    | 5                | 表格 TEDS 门禁所需最少表格数                   |
| `OCR_GATE_ECE_MIN_SAMPLES`                | 20               | 校准 ECE 门禁所需最少置信样本数                |
| `OCR_GATE_ALLOW_THIN_EVIDENCE`            | 0                | 设为 1 时不再因样本不足判未达标                |
| `OCR_GATE_WORST_GROUP_MIN_FILES`          | 3                | 参与最差分组门禁的最少文件数                   |
| `OCR_GATE_WORST_GROUP_MIN_FIELDS`         | 3                | 参与最差分组字段门禁的最少字段比较数           |
| `OCR_GATE_MAX_WORST_GROUP_CER`            | 0.15             | 最差分组 CER 上限                              |
| `OCR_GATE_MIN_WORST_GROUP_FIELD_ACCURACY` | 0.85             | 最差分组字段准确率下限                         |
| `OCR_BENCH_DIR`                           | `benchmarks/ocr` | 基准语料目录                                   |
| `OCR_BENCH_SPLIT_SALT`                    | `v1`             | 语料角色切分的哈希盐值                         |
| `OCR_BENCH_DEV_SHARE`                     | 0.6              | 调参集占模板族的比例                           |
| `OCR_BENCH_CALIBRATION_SHARE`             | 0.2              | 校准集占模板族的比例（余量为盲测集）           |
| `OCR_GATE_MIN_BLIND_FILES`                | 3                | 门禁所需的盲测文件数下限                       |
| `OCR_AUDIT_SALT`                          | `v1`             | 通过文档随机抽样的排序盐值                     |
| `OCR_REVISION_QC_SALT`                    | `v1`             | 人工修订质检抽样的排序盐值                     |
| `OCR_ANNOTATION_SINGLE_WEIGHT`            | 0.4              | 单人标注相对双人一致的可靠性权重               |
| `OCR_INK_MAX_REGIONS`                     | 3                | 单次级联最多复认的墨迹空隙数                   |
| `OCR_INK_MAX_GAPS`                        | 12               | sidecar 单页最多上报的墨迹空隙（0 关闭）       |
| `OCR_INK_MIN_PIXELS`                      | 45               | 墨迹空隙最小像素数（下限 8）                   |
| `OCR_INK_MAX_SIDE`                        | 900              | 墨迹检测栅格单边上限                           |
| `OCR_UPLOAD_ROOT`                         | 无               | sidecar 允许读取的上传根目录                   |
| `OCR_RETENTION_DAYS`                      | 0                | OCR 文本/结构化结果/字段修订保留天数（0 永久） |

### 17.4 灰度

| 变量                 | 默认值             | 说明                             |
| -------------------- | ------------------ | -------------------------------- |
| `OCR_GREY_PERCENT`   | 0（禁用）          | 候选模型流量百分比               |
| `OCR_GREY_MODE`      | `canary`           | `canary` / `shadow` / `rollback` |
| `OCR_GREY_MODEL`     | `paddle-v6-server` | 候选模型                         |
| `OCR_CONTROL_MODEL`  | `paddle-v6-medium` | 对照模型                         |
| `OCR_ROLLBACK_MODEL` | 空                 | 回滚模型；`rollback` 模式必需    |

注册表存在条目时以注册表为准；以下变量只在没有注册表条目时作为灰度回退配置。

### 17.5 外部适配器（可选）

| 变量                              | 默认值 | 说明                                        |
| --------------------------------- | ------ | ------------------------------------------- |
| `OCR_CAMELOT_URL`                 | 空     | 数字 PDF 表格抽取服务（`/tables`）          |
| `OCR_CAMELOT_TOKEN`               | 空     | Camelot 服务令牌                            |
| `OCR_CAMELOT_TIMEOUT_SECONDS`     | 30     | Camelot 超时                                |
| `OCR_VLM_URL`                     | 空     | 问题区域 VLM 修复服务（`/repair`）          |
| `OCR_VLM_TOKEN`                   | 空     | VLM 服务令牌                                |
| `OCR_VLM_MODEL`                   | 空     | 请求中声明的 VLM 模型名                     |
| `OCR_VLM_TIMEOUT_SECONDS`         | 45     | VLM 超时                                    |
| `OCR_SPECIALIZED_URL`             | 空     | 图表/手写/印章/签名专用识别（`/recognize`） |
| `OCR_SPECIALIZED_TOKEN`           | 空     | 专用识别服务令牌                            |
| `OCR_SPECIALIZED_MODEL`           | 空     | 专用识别模型名                              |
| `OCR_SPECIALIZED_TIMEOUT_SECONDS` | 30     | 专用识别超时                                |
| `OCR_CAMELOT_MAX_PAGES`           | 200    | Camelot 单次最多分析的页数（sidecar 读取）  |
| `OCR_CAMELOT_TIME_BUDGET_SECONDS` | 120    | Camelot 单次分析时间预算（sidecar 读取）    |
| `OCR_DOCLING_MAX_PAGES`           | 500    | Docling 单次最多转换页数（sidecar 读取）    |
| `OCR_MAX_OFFICE_PAGES`            | 200    | Office 文档单次最多转换页数（sidecar 读取） |

Camelot 超过页数或时间预算时返回已完成的表格并置 `truncated=true`，应用会把该标志
写入提取结果、阶段消息与 `ocrData.truncated`，UI 显示「已截断」，不会把部分结果
误报为完整表格。

所有适配器未配置时完全惰性：不发起网络请求、不改变级联阶段与最终文本。适配器返回的
文本只作为候选证据（`agreement=confirmed|conflict|unverified`），从不静默覆盖原文。

### 17.6 注册表自动策略

| 变量                           | 默认值 | 说明                                |
| ------------------------------ | ------ | ----------------------------------- |
| `OCR_REGISTRY_AUTO`            | 1      | 是否允许自动晋级/回滚               |
| `OCR_REGISTRY_MIN_SAMPLES`     | 20     | 参与自动决策所需最少的基准/生产样本 |
| `OCR_REGISTRY_PROMOTE_MARGIN`  | 0.01   | 候选领先对照多少分可晋级            |
| `OCR_REGISTRY_ROLLBACK_MARGIN` | 0.02   | 对照落后回滚组多少分触发回滚        |
| `OCR_REGISTRY_SIGNIFICANCE`    | 0.05   | 配对 McNemar 检验允许的最大 p 值    |

---

## 18. 我们如何优化识别率

优化不是“调高 DPI 或多加几次重试”，而是围绕错误来源分层的系统性改造。

### 18.1 优化闭环

```text
选定真实错误类型
  → 找到最小改动点（路由 / 预处理 / 结构 / 校验 / 恢复）
  → 固定语料，一次只改一个变量
  → 基准对比 CER / 数值 CER / 字段 / 全对率 / TEDS / 耗时
  → 生产看板看失败率、复核率、修订率、漂移
  → 记录优化台账；达到门禁后灰度，异常则回滚
```

### 18.2 减少需要识别的内容

| 优化                        | 解决的问题                                         |
| --------------------------- | -------------------------------------------------- |
| 原生 Office / 数字 PDF 抽取 | OCR 对清晰文本反而可能引入错字；原生文本零识别误差 |
| 混合 PDF 逐页路由           | 数字页与扫描页共存时不再整篇 OCR                   |
| 原生页嵌入位图区域识别      | 扫描插图/截图文字藏在文本层之外被漏掉              |
| 纯文本格式跳过              | 避免无意义调用与错误覆盖                           |
| 内容哈希复用                | 同一文件重复上传不再产生不同结果                   |

### 18.3 输入质量与预处理

| 优化                                                         | 解决的问题                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| 图像预检（清晰度/亮度/对比度/像素/反光/阴影/噪声/倾斜/EXIF） | 低质量图片在识别前就被标记                                   |
| 重拍建议 `retake`                                            | 反光严重或分辨率过低时建议重新采集，而不是硬做后处理         |
| 按实测文字高度自适应 DPI                                     | 小字直接升到足够 DPI，大字不做无谓渲染                       |
| `enhanced` 启用方向分类、去畸变、文本行方向                  | 倾斜照片、倒置扫描、弯曲页面                                 |
| 有界光度候选                                                 | 提升低对比、阴影、手机照片的可识别性，候选必须超过原图才采用 |
| 可选透视/去倾斜并反算 bbox                                   | 拍摄畸变下仍保持区域复认与 DIR 坐标对齐                      |
| 多帧 TIFF/GIF 逐帧识别                                       | 只读第一帧导致漏页                                           |
| 表格网格检测                                                 | 普通 `auto` 路径也能识别出表格块                             |
| 单页失败继续                                                 | 一页损坏不再导致整份文档无结果                               |

### 18.4 模型与流水线选择

| 优化                              | 解决的问题                                               |
| --------------------------------- | -------------------------------------------------------- |
| 默认 PP-OCRv6_medium              | 较新模型，兼顾中英混排与速度                             |
| v6 不可用回退 PP-OCRv5_server     | 新模型下载失败时仍可服务                                 |
| PP-StructureV3 + 固定表格模型组合 | 复杂表格的行列与合并单元格更稳定                         |
| 表格流水线失败回退行级 OCR        | 结构模型不可用时不至于整页失败                           |
| Docling 作为 Office 兜底          | 原生库缺失时仍能抽取                                     |
| 模型能力矩阵 + 对照实验           | 按语言、文档类型、速度、内存与许可证选型，而不是只看版本 |
| 语言 profile 路由 + 语言纠正      | 声明语言错误时自动用检测语言重跑                         |

### 18.5 结构感知与阅读顺序

| 优化                                        | 解决的问题                               |
| ------------------------------------------- | ---------------------------------------- |
| 行级 bbox 分组与按位置排序                  | 多栏、表格混排时文本顺序错乱             |
| 原生 PDF 表格区域行文本去重                 | 表格文本同时出现在行块与表格块           |
| `structure` 模式过滤表格区域内的整体 OCR 块 | 表格内容被识别两遍，污染全文与置信度     |
| 跨栏标题分带 + 列感知阅读顺序               | 多栏页只按 y/x 排序会串栏                |
| 版面区域标签写入 `meta`                     | 标题、公式、页眉页脚、印章混入正文       |
| 只对表格网格区域走表格分组                  | 整页判定为表格会把标题与表后说明并入表格 |
| 颜色区域提示印章与蓝色签名                  | 彩色印章/签名文字污染正文与字段匹配      |
| 同位置重复块按来源优先级标记而非删除        | 整页 OCR、行 OCR、表格 OCR 输出重叠内容  |
| 重复页眉页脚模板标记与跨页表格关联          | 页码/水印污染关键词，续表被误认为新表    |
| 无框线表格候选网格                          | 无网格合同与报表利用文本对齐推断行列     |

### 18.6 文本后处理

| 优化                       | 解决的问题                                    |
| -------------------------- | --------------------------------------------- |
| 全角数字分隔符归一         | 中文识别器输出的全角逗号/句点导致数值解析失败 |
| HTML 实体反转义、NBSP 归一 | Docling markdown 转义与 OCR 回显实体          |
| CJK 与拉丁/数字边界补空格  | 混排文本粘连，影响关键词与字段匹配            |
| 冒号、句末标点后补空格     | 中英混排可读性与分词                          |
| 控制字符清理与换行统一     | 不可见字符干扰比对与展示                      |

### 18.7 质量驱动的定向恢复

| 优化                       | 解决的问题                                 |
| -------------------------- | ------------------------------------------ |
| 多信号加权而不是只看置信度 | 置信度高但漏页、表格错行、合计不符         |
| 按问题类型选择恢复方式     | 表格问题优先结构分析，模糊文本优先增强/DPI |
| 关键字段区域复认           | 整页重跑成本高，局部复认即可确认或暴露冲突 |
| 不一致时追加宽边距增强复认 | 单次裁剪偏差导致误判，二次视角提高可比性   |
| 保留 N-best 候选与来源     | 出现分歧时复核人员能比较 pass/mode/置信度  |
| 复认候选只作证据           | 避免用另一次识别结果静默覆盖原文           |
| 保留最高分结果             | 恢复失败不会覆盖原本可用的文本             |
| 阶段与时间预算             | 避免低质量文档无限重试、拖垮队列           |
| native / 截断结果不恢复    | 确定性结果重复调用没有收益                 |
| `mode + DPI + 语言` 去重   | 结构恢复与 DPI 恢复收敛时避免重复调用      |
| 期望收益门控               | 收益不足时跳过昂贵阶段，控制成本           |
| 语言不匹配自动重跑         | 防止用错误语言模型静默产出低质文本         |

### 18.8 结果校验

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
| 逐单元格置信度          | 低置信定位到单元格，而不是只给整页平均分       |

### 18.9 缓存与版本治理

| 优化                                  | 解决的问题                       |
| ------------------------------------- | -------------------------------- |
| 缓存键包含模型、pipeline 与运行时版本 | 换模型或改后处理后误用旧结果     |
| 模型文件哈希纳入指纹                  | 模型被替换但名称不变时缓存仍失效 |
| `fail` 结果不复用                     | 坏结果扩散到其他附件             |
| 复用与重跑重新评分                    | 阈值调整后沿用旧状态             |
| 重跑清空派生字段                      | UI 展示过期路由/质量/阶段        |

### 18.10 基准闭环

| 优化                                 | 解决的问题                                             |
| ------------------------------------ | ------------------------------------------------------ |
| 原始 CER + 归一 CER + 数值 CER + WER | 单一指标掩盖关键数字或英文单词错误                     |
| 关键词召回 + 归一字段 + 精确字段     | 表格/PDF 难以逐字比对时的可观测性                      |
| 文档全对率 + Wilson 区间             | 平均分掩盖「部分文档完全正确」的真实比例               |
| 业务损失                             | 金额、账号、日期等错误按业务风险加权                   |
| 错误分类与诊断                       | 替换/插入/删除/缺字段/结构问题可归因，并区分检测与识别 |
| 字符级定位                           | 逐处输出归一化偏移与上下文，可直接回看原文差异         |
| 置信度校准（ECE/Brier）              | 判断高置信是否真的更可靠                               |
| 按语言、难度、退化类型分层           | 避免简单样本拉高整体、掩盖难样本退化                   |
| 发布门禁                             | 用固定阈值阻止 CER/字段/失败率回退                     |
| 按文档类型 CER 与数值 CER 门禁       | 防止总体合格但某一类文档严重退化                       |
| 记录路由、阶段、耗时                 | 准确率提升是否以成本为代价                             |
| 历史运行对比                         | 改动前后可回归，而不是凭感觉调参                       |
| 模型 × 预处理实验                    | 先筛选再全量，避免凭经验固定参数                       |

### 18.11 人工复核而非自动改写

- `review` / `fail` 标记复核，详情展示候选与诊断，但原文不动。
- 字段级修订独立存储，形成可审计标注。
- 投诉进入反馈池，进入主动学习。
- 复核数据用于阈值校准与下一轮优化，而不是直接改写历史结果。

### 18.12 近期收口补齐

这一轮针对“最后几个影响闭环的缺口”做了以下优化：

| 优化             | 做法                                                                                             | 解决的问题                                         |
| ---------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| 语言不匹配恢复   | 检测脚本与声明语言不兼容时，用检测语言 profile 重跑；即使首次 pass 也追加一次                    | 声明 `en` 却识别出中文时，不会静默采用错误语言模型 |
| 逐单元格置信度   | sidecar 表格输出单元格 confidence；DIR / API / 质量引擎全链路透传                                | 低置信只影响具体单元格，而不是被整页平均分掩盖     |
| 数值 CER 门禁    | 新增 `OCR_GATE_MAX_NUMERIC_CER`，基准与门禁同时输出数值 CER                                      | 金额、比率等关键数字退化不会被总体 CER 掩盖        |
| 分类型 CER 门禁  | `OCR_GATE_MAX_CER_<KIND>` 按文档类型覆盖阈值                                                     | 总体 CER 合格但某一类文档严重退化                  |
| 最差分组门禁     | 在类型/语言/难度/退化维度查找最差桶，文件数与字段样本不足不参与，检查携带分组归因                | 总体平均掩盖单一严重退化分组，或小样本桶误触发门禁 |
| PDF 文本层可信度 | 按长度、垃圾字符与可读字符比例评分，低可信页渲染 OCR，`meta.textLayer` 记录原因                  | 占位文本层或损坏字体被误当可用原生文本             |
| 分层结果选择     | 硬性风险 → 关键字段覆盖 → 页面覆盖 → 字段校验 → 表格完整性 → 阅读顺序 → 融合分；0.005 内视为平手 | 更高分候选掩盖漏页、漏关键字段或结构缺失           |
| 代理指标命名     | 看板字段改为 `revisionObservedRate` / `confidenceRiskProxy`，UI 标注「（代理）」                 | 观察值被误读为真实 CER / 字段错误率                |
| 业务类型看板     | 按文件名推断发票/合同/报表/证件/表格等业务类型分组                                               | 生产问题可按业务场景定位，而不只看文件扩展名       |
| 单元格复认冲突   | 复认冲突写入 `field_validation_failed` 硬性风险并保留原文                                        | 冲突不能被其他高分抵消，也不能静默改写             |
| 阶段回放         | 保存输入/输出 SHA-256、参数与评分，支持整页或区域重放                                            | 判断一次改动是否真正改善结果，而不是只看单次分数   |
| 灰度发布         | canary / shadow / rollback + 确定性分桶                                                          | 新模型先小流量或影子验证，异常可回滚               |
| 阈值自动拟合     | 用标注样本按整体/类型/难度/语言/文件类型/组织拟合，ECE/Brier 报告                                | 不同业务与组织使用各自阈值，而不是全局硬编码       |
| VLM 区域修复     | 只对未确认的问题区域发起修复，候选保留来源与 bbox                                                | 整页 VLM 成本高，局部修复更便宜且更易对照          |
| 专用区域识别     | 图表/手写/印章/签名区域调用专用服务，证据只标记不改写                                            | 非文本版面不再只能丢弃，但仍需人工确认             |
| Camelot 表格     | 数字 PDF 表格抽取作为独立阶段，与 Paddle 表格合并                                                | 复杂表格多一条独立流水线，失败不影响主路径         |
| 组织维度看板     | 按工作区聚合指标并返回组织阈值 profile                                                           | 客户/组织问题可独立定位，而不是混在全局平均        |
| 注册表灰度       | 角色化模型注册、自动晋级/回滚、人工钉住与审计                                                    | 灰度从人工配置升级为可闭环的模型治理               |
| 知识图谱         | 跨附件实体归一、共同出现/正文引用、币种月度金额指标                                              | 把散落在附件中的编号、金额与引用串起来             |
| 预算化主动学习   | 按优先级/标注成本抽样，返回预算与覆盖统计                                                        | 有限标注预算优先花在高价值、低成本的样本上         |

三轮功能审查（后端/边界 → 回归/失败路径 → UI/无障碍）后补齐的细节：

| 修复                  | 做法                                                                                          | 影响                                                     |
| --------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 门禁比较符号          | 失败的最大值检查显示 `>`，失败的最小值检查显示 `<`，通过时分别显示 `≤`/`≥`                    | 运维人员不会再看到「12% ≤ 8% 未通过」这类自相矛盾的文案  |
| Camelot 截断传播      | sidecar 的 `truncated` 经 `CamelotResult` → 提取结果 → 级联阶段消息透传，UI 标注「已截断」    | 部分表格不会被误认为完整结果                             |
| 原生 bbox DPI 回退    | `blockBboxDpi` 在缺少 `meta.bboxDpi` 时按阶段/引擎识别原生 PDF（72 DPI），再回退到渲染 DPI    | 原生页区域复认的坐标换算不再受扫描 DPI 影响              |
| 知识图谱读取上限      | 单个附件正文截断 5 万字、文档结构超过 8MB 时只使用识别文本，并返回 warnings；修订改为批量查询 | 大文档不会拖垮聚合接口或触发 N+1 查询                    |
| UI 并发与失败可见性   | 附件读取与治理面板加载加入序号守卫；轮询/字段/版本链/基准/实验/注册表失败均提示并可重试       | 快速切换附件或网络抖动时不会显示过期数据，也不会静默失败 |
| 反馈分页与校准入口    | 样本池显示「筛选命中/已加载」并支持加载更多；治理页新增阈值 profile 表与重新拟合按钮          | 大量样本可逐步浏览，校准结果与拟合操作在 UI 闭环         |
| 对照实验与阶段重放 UI | Ops 页面新增变体对照表单/排名表与阶段重放表单/结果摘要                                        | 实验与回放不再只存在于 API，管理员可直接操作和对照       |
| 构建期类型共享        | 实验类型移入 `shared/types.ts`，前后端共用同一份契约并保持旧导出兼容                          | 避免 API 与 UI 类型漂移                                  |

### 18.13 70 项改进域的落地状态

| 改进域（对应 ocr.md） | 已落地                                                                                                                                                                                                      | 仍未完成                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 评估体系 1–10         | 分层 CER/WER/数值 CER、字段准确率/精确率、全对率 + Wilson、错误分类、业务损失、数值与分类型门禁、最差分组门禁、历史对比、样本 provenance/uncertain、阈值自动拟合（ECE/Brier 报告）与发布门禁                | 基准语料规模仍小，拟合阈值需随真实标注增长复核                    |
| 输入与预处理 11–22    | 自适应 DPI、文字高度、自适应阈值/Otsu 候选、去阴影、反光检测、去噪、锐化/对比度候选、可选透视矫正、enhanced 文档去畸变、多信号方向、红通道、重拍建议、多帧、实验通道对照                                    | 极端弯曲/运动模糊/反光修复依赖真实样本或专用模型                  |
| 版面与区域 23–34      | 区域级路由、版面标签、阅读顺序、跨页关联、页眉页脚、重叠去重、区域/单元格置信度、局部二次识别、裁剪边距、坐标反算、表格与正文分离、印章/签名/公式/图表检测隔离、专用区域识别适配器、VLM 问题区域修复        | 专用识别依赖外部服务；图表/公式语义理解仍有限；复杂弯曲版面仍有限 |
| 模型与路由 35–46      | 模型能力矩阵、语言 profile 路由、中英混排、数字路径、混淆集、模型对照实验、可解释路由、检测/识别错误诊断、模型哈希/运行时、注册表自动选择、灰度与自动晋级/回滚、整页互补模型候选、跨引擎候选（`candidate`） | 真实服务上的跨引擎净收益待验证                                    |
| 表格与字段 47–56      | 行列 F1/单元格准确率/IoU/合并单元格/TEDS、无框线候选、跨页续表、单元格复认、列类型、多级表头、业务约束、数值候选、字段溯源、人工修订、Camelot 适配器                                                        | 复杂合并表与超宽表的基准覆盖仍有限                                |
| 质量与级联 57–64      | 校准指标、四分量的可解释性、关键区域覆盖、按错误类型触发、期望收益门控、N-best、硬性风险、分层结果选择、文本层可信度、阶段回放、分维度阈值注入                                                              | 级联成功概率仍为启发式估计                                        |
| 生产治理 65–70        | 错误回流、预算化主动学习、客户/组织看板与阈值、六维漂移、版本链、优化台账、注册表灰度、跨附件知识图谱、原文与归一文本分离、OCR 复用按组织隔离                                                               | 知识图谱只覆盖结构化字段与正文引用，不做开放语义实体抽取          |

### 18.14 第二轮收口：静默错误与证据可信度

这一轮针对评审中与「可信度证据本身不可信」相关的 5 个条目：

| 条目             | 做法                                                                                                                                                                                       | 解决的问题                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| #38 静默错误     | 自动判定 `pass` 的文档按文件类型分层随机抽样，双人独立标注，一致有错 + 分歧计为静默错误并给出 Wilson 95% 区间；共识结果回流校准样本集                                                      | 「通过」不再等于「正确」，阈值校准也不再只看不合格样本         |
| #45 盲测切分     | 按模板族（同一模板的变体归为一族）哈希分配 dev / calibration / blind，发布门禁只在 blind 上判定，阈值只在 calibration 上拟合                                                               | 反复调参的样本不再同时充当验收证据，门禁不再被过拟合的语料说服 |
| #19 原文保真     | `attachments.ocr_raw_text` 单独保存引擎原文，归一只服务于展示；知识图谱与版本链读取原文                                                                                                    | 展示层空格/标点规则不会污染可审计的原始识别结果                |
| #12/#49 复用隔离 | `findReusableOcr` 增加 `COALESCE(workspace_id,'')` 相等条件，跨项目复用必须同属一个组织                                                                                                    | A 客户的识别结果不会被 B 客户命中，字段权限与数据边界一致      |
| #07 输入加固     | 图片 80 MP 像素预算、OOXML 200 MB/10 000 条目/解压比 500、拒绝 `<!DOCTYPE`/`<!ENTITY`、加密 PDF 返回 `422 password_required` 且不重试；引擎容器以 uid 10001 非 root 运行并 `cap_drop: ALL` | 恶意或异常上传不再触发解压炸弹、XXE 与渲染型 OOM；提权面收窄   |

审计闭环的三处可见性补齐：
- 治理面板新增「通过文档随机审计」分组：静默错误率与区间在标题即可读，队列展示一审/二审/结论，分歧单独计数而不是被平均掉。
- Ops 基准表逐文件标注语料角色，门禁检查显示「盲测样本证据」；没有盲测样本时退位在全部样本判定并输出 `note`，而不是静默给出一个看起来正常的结论。
- 审计面板与校准拟合使用同一份共识样本，避免两处数字来自不同的口径。

### 18.15 第三轮收口：位置证据、墨迹漏检与门禁诚实度

这一轮补齐评审第二轮的 5 个条目，并完成三轮自查（后端/边界 → 回归/失败路径 →
UI/无障碍）与修复：

| 条目             | 做法                                                                                                                                                                                                                                                                                                                                                                       | 解决的问题                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| #33 复认独立性   | `agreementOf()` 把一致结果拆为 `confirmed_independent`（另一引擎/另一模型）与 `confirmed_same_engine`（同模型重读）；只有独立一致能降低关键字段低置信风险，同模型一致仍计风险并在质量层单列；旧文档的单一 `confirmed` 在读取时（`normalizeDocumentIr`）归一为 `confirmed_same_engine`，不丢血缘也不冒充独立证据                                                            | 「复读一遍都一样」不再被当成第三方确认，同模型系统性错误不会被掩盖   |
| #41 字段强命中   | 强命中必须能定位：标注页/bbox、真值上下文，或同一 block 内长度 ≥2 的标签旁的值（`STRONG_MATCH_MIN_LENGTH=2`）；无法定位的字段记为 `unverifiable`，不进分母；整份语料无字段可定位时指标为 null；门禁改用 `OCR_GATE_MIN_FIELD_STRONG_ACCURACY` 与强命中 Wilson 下界；类别与最差分组按「强/混合/弱」口径判定并附 `note`                                                       | 值只要在全文任意位置出现就算命中的假阳性，会被值出现在错误角色里拉高 |
| #67 样本量与证据 | 每个比率检查按阈值反推 `requiredSamples`；点估计通过但观测不足的检查汇总为 `evidence_sufficiency`，门禁判「证据不足」而非「达标」；表格 TEDS 至少 5 张表、校准 ECE 至少 20 条样本才参与；`OCR_GATE_ALLOW_THIN_EVIDENCE=1` 可显式放行；Ops 把「未达标」与「证据不足」分开显示并列出各指标缺口                                                                               | 4 份文档全对就被当成发布证据，小样本运气被误读为质量                 |
| #69 修订质检     | 人工修订在进入阈值训练前先做质检：抽样队列由 `OCR_REVISION_QC_SALT` 确定性排序，记录一审/二审、冲突与仲裁；标定可靠性按双人一致与单人标注加权（`OCR_ANNOTATION_SINGLE_WEIGHT`，默认 0.4），单人样本不会被当成等价真值                                                                                                                                                      | 错误修订或单人标注污染阈值拟合，越修越偏                             |
| #60 墨迹漏检     | sidecar 二值化后遮掉已有识别框，按栅格聚类剩余墨迹；空/占位单元格只遮边框带，内部墨迹按 `cell` 空隙经 `table_owner` 归属；未解析或超上限的空隙单独计数；`None`（未分析）与 `[]`（已核对干净）分开；级联把剩余空隙逐区域复认，补回文本作为 `flagged` block 追加并按阅读顺序并入正文，已解决空隙从 `meta.inkGaps` 移除；质量层只对仍有空隙的页面报 `ink_without_text` 硬风险 | 「识别为空」被当成「页面为空」，整行/整格漏识别在质量分里看不出来    |

三轮 review 后修复的细节：

| 修复           | 做法                                                                                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 复认血缘迁移   | `normalizeDocumentIr()` 在附件与治理两条读取路径统一把旧 `confirmed` 映射为 `confirmed_same_engine`，并覆盖 `meta.regionAgreement`                                                        |
| 空隙像素口径   | 每个连通域只统计自身栅格像素（`labels` + `bincount`），不从外接矩形重复计数，避免把同一块墨迹算两次或裁两次                                                                               |
| 空单元格墨迹   | 只有边框带被遮罩（`cover_frame` 只覆盖、不回填），内部墨迹成为可归属的 `cell` 空隙；未填充单元格不再「自己遮掉自己」                                                                      |
| 复认与质量闭环 | 墨迹候选不带 `agreesWithInitial`（此处本来就没有原文可比）；补回的空隙从质量告警中排除；`appendedText` 按阅读顺序生成，不按裁剪顺序                                                       |
| 强命中持久化   | `ocr_bench_files.field_strong_unverifiable` 新列；旧行读出为 null（不是 0），聚合与分组透传可定位样本数                                                                                   |
| 门禁文案       | `evidence_sufficiency` 的 `note` 与 Ops 汇总区分「低于阈值」和「样本不足」；`pdf_evidence` 的单位改为「份 PDF 样本」；CSS 补齐 `confirmed_independent` / `confirmed_same_engine` 徽标样式 |
| 墨迹可见性     | 附件详情显示未覆盖墨迹数、已核查页数、无法解析数与补回数；硬风险以 `role="alert"` 展示，阶段证据显示像素数                                                                                |

仍留在路线图：把 `gate.passed` 接入注册表自动晋级/回滚（目前门禁只作为发布结论与
历史对比，晋级仍为人工确认）；本轮未提升 `PIPELINE_VERSION`，升级前缓存的文档没有
`meta.inkGaps`，会被当作「未分析」而非「已核对且干净」，需要即时覆盖时清缓存或重跑。

### 18.16 第四轮收口：Office 覆盖、独立证据与生命周期

本轮落地 6 个 `P0` 条目，并完成三轮自查（回归/边界 → 失败路径 → 文档与 UI 一致性）：

| 条目              | 做法                                                                                                                                                                                                                                   | 解决的问题                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| #05 Office 覆盖   | OOXML 原生抽取补齐页眉页脚、文本框、脚注尾注、批注、图表、媒体与 OLE；修订保留插入、忽略删除并计数；XLSX 隐藏工作表、PPTX 隐藏幻灯片/组合形状/备注写入 DIR；`meta.office` 输出计数与 `objects`/`unrendered`，质量层报 `officeCoverage` | 只读正文会把嵌入对象里的文字静默漏掉，且无法判断覆盖是否完整 |
| #13 光度候选自证  | 原图与增强结果配对比较数字 token：丢失且一致度 < 0.8 → `numeric_conflict` 保留原图并报硬风险；只有减少损坏、补出 token 或高一致度下的显著置信提升才采用增强结果；选择写入 `meta.preprocess`                                            | 同一识别器的置信度提升被当成增强有效的证据                   |
| #15 独立机读证据  | sidecar 从像素解码 QR/条码（OpenCV/pyzbar 可选），解析 MRZ 并校验 ICAO 9303；条码 token 与正文一致升级为 `confirmed_independent`，缺失字段与 MRZ 校验失败为硬风险；MRZ 跨区域只算同引擎一致                                            | 关键字段只有同模型重复识别，没有与 OCR 无关的独立冗余        |
| #21 类型与 schema | 规则 + 表格证据判定 8 类业务文档或 `generic`；每类定义必填/可选字段、格式校验与交叉约束，输出缺失/非法/矛盾/覆盖率；`generic` 不改变评分                                                                                               | 文件名推断不可靠，缺字段和字段矛盾无法形成可解释风险         |
| #31 置信度校准    | 加权 PAV 等渗回归拟合原始 → 校准置信度；阈值与质量打分使用校准值，输出校准前后 ECE/Brier 与持久化映射；`quality.calibrated` 反映映射是否实际应用                                                                                       | 原始置信度系统性偏乐观，阈值切在未经校准的分数上             |
| #49 生命周期      | `OCR_RETENTION_DAYS`（0 永久）到期清理文本/DIR/质量/阶段/字段修订并记 `ocr_purged_at`；删除附件级联；脱敏导出替换身份证/手机/座机/邮箱/银行卡/MRZ，审计只记元数据；复用限定同工作区                                                    | OCR 文本是 PII，永久保留与整段导出都超出必要范围             |

三轮 review 修复：
- `quality.calibrated` 原先恒为 `false`，即使已应用置信度映射；改为按是否传入映射输出，
  并补测试断言。
- 脱敏顺序与边界：先 MRZ/身份证再通用卡号，正则前后加数字/字母边界，避免把相邻发票号
  或日期纳入替换；测试覆盖六类可识别信息与干净文本。
- 清理后的详情弹窗不再渲染空 `<pre>`，改为显示清理时间与重跑提示；导出下载延迟释放
  Blob URL，避免浏览器取消下载。
- 类型 chip 补齐「格式无效」字段；删除确认明确说明会级联删除 OCR 文本、修订与记录。
- OpenAPI 补齐导出接口与删除级联说明；`.env.example` 与配置表补齐
  `OCR_MACHINE_READABLE` / `OCR_MACHINE_READABLE_MAX_SYMBOLS` 与 `OCR_RETENTION_DAYS`。
- E2E 补齐新 UI：类型 chip 与判定依据、条码/MRZ 统计、预处理冲突页数、Office 覆盖，
  以及脱敏导出的文件名与替换计数；清理场景验证只显示保留说明，不渲染正文与导出按钮。
- 新 schema 信号让合同样例保持 `review`，OCR 级联测试用 `maxStages: 2` 限定语言复跑，
  避免把新增恢复轮次当成回归。

---

## 19. 运维与排障

- 启动时 sidecar 会预加载模型；`GET /health` 的 `ready=false` 表示仍在加载。
- 关键日志事件：`ocr.completed`、`ocr.reused`、`ocr.retry`、`ocr.failed`、
  `ocr.recovered`、`ocr.deferred`、`ocr.benchmark_started/finished/failed`。
- 常见问题：

| 现象                             | 排查                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `未配置 paddle/docling OCR 服务` | 检查 `OCR_PADDLE_URL` / `OCR_DOCLING_URL` 与 sidecar 是否启动                                            |
| `path escapes the upload root`   | sidecar 的 `--upload-root` 与应用 `UPLOAD_DIR` 不一致                                                    |
| `OCR 服务未返回文本`             | 样本为空或模型不可用；查看 sidecar stderr                                                                |
| 任务长期 `processing`            | worker 每 30 秒续租（租约 120 秒）；租约仍是未来时间说明有 worker 正在处理，进程退出后续租停止并自动重排 |
| 质量分数普遍偏低                 | 先用基准确认是模型问题还是阈值过严，再调整环境变量                                                       |
| 缓存未命中                       | 检查模型/pipeline/运行时/DPI/模式/配置指纹（`ocr_config_hash`）是否变化                                  |
| 灰度结果异常                     | 检查 profile 是否存在；必要时切换 `rollback` 模式                                                        |

---

## 20. 当前边界与路线图

### 20.1 边界

- 图表、手写、印章、签名已能做区域检测与隔离；只有配置 `OCR_SPECIALIZED_URL`
  时才有专用识别结果，否则印章/签名块通常为空文本，图表只保留区域标记。
- VLM 修复同样依赖外部服务；未配置时只有本地区域/单元格候选证据。
- 质量分是启发式信号；`review` 不等于错误，`pass` 也不排除个别错误。
- 阈值可按语料自动拟合，但校准质量取决于标注样本数量与分布；样本不足时回退默认阈值。
- 21 个合成扩展样本用于回归与相对比较；真实扫描/客户分层语料仍待补充，门禁阈值需随
  语料规模调整。
- 生产看板的 CER/字段错误率是 confidence 与修订数量的代理，仍需要标注样本提供真值。
- 静默错误率来自 `pass` 文档的分层随机审计，估计精度取决于双人已审样本量；样本不足时
  区间很宽，只能作为趋势而不是结论。同一位复核人不能占满两个槽位，分歧计为错误以保持
  保守。
- 发布门禁只在盲测子集上判定；语料模板族太少时退位在全部样本并输出 `note`，需要随真实
  语料增长复核盲测覆盖。
- 漂移检测只比较元数据分布；分布稳定不代表内容质量稳定。
- 文档类型是规则 + 版面证据的分类器，不是训练模型；证据不足时保持 `generic` 并跳过
  schema，已判定类型的字段检查也可能受标签识别错误影响。二维码/一维条码依赖 sidecar
  安装 OpenCV/pyzbar，缺库时只保留 MRZ；MRZ 来自识别文本，与正文交叉只算同引擎一致。
- 默认全本地处理；接入外部 VLM/专用识别前需单独确认数据合规与服务可用性。
- 系统不自动改写文本，区域复认、VLM 与专用识别也只记录证据，复核仍需人工完成。
- 注册表自动晋级/回滚依赖基准与生产样本达到门槛；指标不足时保持 `hold`，不会仅凭单次
  运行切换模型。
- 知识图谱只归一编号、账号、金额、日期四类结构化字段，正文引用匹配是字符串包含，
  不做语义消歧；图谱只读且不回写 OCR 文本。

### 20.2 下一步

**评审改进点跟进**（详见 `docs/ocr-方案评审与50条改进点.md` 第六、七节实现记录）
- 第一轮已实现：#02 数字 token 交叉验证与风险分层抽样、#12 缓存配置指纹、
  #23/#24/#25 校验位与大小写金额独立证据及数值语义、#42 关键符号 CER、
  #43 Wilson 下界与字段类别门槛、#51 租约心跳、#53 截断只进元数据、
  #64 无置信度不再默认通过、#66 门禁默认覆盖 PDF。
- 第二轮已实现：#19 原文与归一文本分离、#12/#49 OCR 复用按组织隔离、
  #07 输入加固与非 root 容器、#45 语料按模板族切分且门禁只看盲测子集、
  #38 `pass` 文档分层随机审计与静默错误率。
- 第三轮已实现（见 18.15）：#33 复认独立性拆分、#41 字段强命中口径、
  #67 门禁样本量与证据不足、#69 人工修订质检与标注加权、#60 墨迹漏检与补救。
- 第四轮已实现（见 18.16）：#05 Office 嵌入对象/修订覆盖、#13 光度候选自证防护、
  #15 二维码/条码/MRZ 独立证据、#21 文档类型与 schema、#31 置信度等渗校准、
  #49 OCR 保留策略/级联删除/脱敏导出。
- 待继续：#30 用标注真值替代权重启发式、#32/#35/#36/#48 的恢复收益与灰度真实标签，
  以及把 `gate.passed` 接入注册表自动晋级/回滚。

**语料与验证**
- 扩大语料：真实扫描件、倾斜照片、多栏、复杂表格、低质量传真，以及按客户/组织分层。
- 用真实服务验证 VLM、专用识别与 Camelot 的净收益，并按文档类型分别设门禁。
- 跨引擎整页候选已接入：Paddle 的 PDF/图片可追加 Docling 候选，与模型候选共用
  `candidate` 阶段、分层采用规则和重放；下一步用真实服务量化净收益，并改进级联成功
  概率估计。

**知识图谱**
- 从四类结构化字段扩展到合同方、项目、条款等语义实体，并加入消歧与置信度传播。
- 提供按组织/时间/币种的聚合视图与图谱查询 API；保持只读与可追溯。

**模型治理**
- 注册表接入更多引擎/流水线与实验批次，支持按组织或文档类型分流。
- 自动评估滚动窗口与统计显著性检验，避免小样本波动触发晋级/回滚；配对 McNemar
  检验已接入实验评估，滚动窗口仍待补。
- 标注预算与优化台账联动：优先为预期收益高、成本低的错误类型分配标注预算。

### 20.3 分阶段实施计划（Phase 0–3）

按对识别率的预期收益排序，而不是按新增功能数量。数据与训练类事项需要外部资源，
代码侧先补齐可度量、可回退的闭环。

| 阶段 | 事项                                       | 现状与做法                                                                           | 依赖              | 验收                                   |
| ---- | ------------------------------------------ | ------------------------------------------------------------------------------------ | ----------------- | -------------------------------------- |
| 0    | PDF 文本层抽样交叉验证                     | **已实现**：可信页按比例渲染 OCR 对比；差异只标记 `text_layer_mismatch`，不改写原文  | 无                | 抽样率/预算可配；不匹配触发复核        |
| 0    | 恢复收益数据驱动                           | **已实现**：记录各恢复动作实际收益，平滑后替换硬编码先验；样本不足回退先验           | 无                | 历史成功率影响级联决策，可解释         |
| 0    | 模型晋级统计显著性                         | **已实现**：完整实验按文件配对 CER，精确双侧 McNemar 检验通过才晋级                  | 无                | 平局/样本不足/显著领先用例通过         |
| 0    | 字符级错误定位                             | **已实现**：对齐回溯输出替换/插入/删除的归一化偏移与上下文，基准 UI 可展开查看       | 无                | 基准结果与 UI 可定位具体字符           |
| 0    | RGB/灰度/红通道对照                        | **已实现**：实验变体新增 `channel`，侧车按通道转换图像并按通道汇总 CER/字段/耗时     | 无                | 同一语料可输出通道对比表               |
| 1    | 多模型/多引擎候选                          | **已实现**：局部恢复后追加整页互补模型，再追加可读同格式的第二引擎；仅严格提分才采用 | Paddle + Docling  | 一致率/采纳率/耗时写入阶段；单引擎退化 |
| 1    | 超宽表与复杂合并单元格                     | 已扩充 6 个宽表合成样本（最多 14 列）；横向分带 OCR 与列中心/表头对齐尚未实现        | 标注样本          | 新样本 TEDS/单元格准确率可量化         |
| 2    | 语料体系 v2                                | 行/字符 bbox、双标注与仲裁、模板拆分、train/val/test 隔离、困难样本挖掘              | 真实业务样本      | 每类 ≥ 200 份审核样本；泄漏检测通过    |
| 2    | 专项模型与持续学习                         | 领域微调、中文/数字专项、手写；接入注册表、基准、灰度与回滚                          | 训练资源与标注    | 基准显著提升且灰度稳定                 |
| 3    | 弯曲展平、运动模糊/反光修复、公式/竖排语义 | enhanced 已启用文档去畸变；深度展平、模糊/反光修复仍需真实样本或专用模型验证         | 真实样本/专用模型 | 对应场景基准提升，否则不合并           |
| —    | 知识图谱语义扩展、更多看板/审计/组织配置   | 暂缓，优先投入识别率与数据闭环                                                       | —                 | —                                      |

Phase 0 全部为代码侧工作，并且每项都有失败回退；Phase 1 的候选复认已落地，收益取决于
第二引擎是否部署及真实服务验证；超宽表分带仍需标注样本。Phase 2 的语料与训练无法只靠
代码完成，需要与数据标注和训练资源同步启动。

Phase 0 已完成并通过回归：后端 491 项、Web 19 项、E2E 41 项测试全部通过，
typecheck、Biome、stylelint 与生产构建均通过。E2E 覆盖基准门禁文案、对照实验排名、
阶段重放与阈值配置的渲染与交互。
