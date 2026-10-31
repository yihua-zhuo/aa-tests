# 可选 OCR Sidecar 容器（PaddleOCR / Docling）

`scripts/ocr_sidecar.py` 每个进程只服务一种引擎，因此这里提供两个独立镜像：

| 服务      | 引擎      | 端口 | Dockerfile                      | Python |
| --------- | --------- | ---- | ------------------------------- | ------ |
| `paddle`  | PaddleOCR | 8765 | `deploy/ocr/Dockerfile.paddle`  | 3.10   |
| `docling` | Docling   | 8766 | `deploy/ocr/Dockerfile.docling` | 3.11   |

两者都是**可选的**，默认不启动：只有使用 `--profile ocr` 时才会创建容器。镜像仅监听
容器内部网络，不向宿主机发布端口；应用容器通过服务名访问它们。

同时配置两个 sidecar 时，Docling 除了 Office，也会接受 PDF 与页面图片（标准管线
显式启用 `do_ocr=True`）。Paddle 处理 PDF/图片遇到低质量结果时，应用会把 Docling
作为整页候选复认（阶段 `candidate`，最多 1 个引擎），只有分层质量评分严格提升才采用；
Office 文档仍只由 Docling 处理。跨引擎候选没有单独开关：移除 `OCR_DOCLING_URL` 可停用
它（同时会失去 Office 提取），只部署 Paddle 时 Office 上传会被跳过。

## 1. 前置条件

1. 宿主机存在上传目录 `data/uploads`。应用把上传文件写到 `<DB_PATH 所在目录>/uploads`，
   而 Compose 中 `DB_PATH=/app/data/pulse.db`，所以 sidecar 看到的路径必须是
   `/app/data/uploads`。首次使用前执行：

   ```bash
   mkdir -p data/uploads
   ```

   （应用启动后也会自动创建该目录，但容器启动顺序不保证，建议显式创建。）
   目录以**只读**方式挂载（`./data:/app/data:ro`），sidecar 不需要写入权限。

   sidecar 容器以非特权用户运行（`user: "10001:10001"`，`cap_drop: ALL`，
   `no-new-privileges`，`mem_limit`/`cpus` 见 `docker-compose.yml`）。因此宿主上的
   `data/` 必须对该 uid 可读：目录需要 `o+rX`，或让应用容器与 sidecar 使用同一 gid。
   权限不足时 sidecar 会返回 `404/403`，日志里表现为打不开文件：

   ```bash
   chmod -R o+rX data
   ```

2. 在 `.env` 中设置（Compose 的变量插值也读取根目录 `.env`）：

   ```dotenv
   OCR_TOKEN=<与 sidecar 共享的长随机串>
   OCR_PADDLE_URL=http://paddle:8765
   OCR_DOCLING_URL=http://docling:8766
   ```

   - `OCR_TOKEN` 同时注入 `app` 与两个 sidecar，作为 `X-OCR-Token` 请求头。
     留空表示关闭鉴权，仅建议在完全可信的内网中使用。
   - 两个 URL 留空时应用不会调用 OCR，上传仍可正常进行（标记为 skipped）。
   - 应用侧不硬编码默认值，因为该 profile 是可选启用的。

## 2. 构建与启动

```bash
# 两个引擎一起启动
docker compose --profile ocr up -d --build

# 只启动其中一个
docker compose --profile ocr up -d paddle
docker compose --profile ocr up -d docling

# 查看状态与日志（health 来自镜像内的 HEALTHCHECK）
docker compose ps
docker compose logs -f paddle
```

注意：仅执行 `docker compose up -d`（不带 profile）不会启动 sidecar；因此修改 `.env`
中的 URL 后，必须显式带上 `--profile ocr` 才会拉起对应服务。

单独构建镜像（不经 Compose）：

```bash
docker build -f deploy/ocr/Dockerfile.paddle -t pulse-ocr-paddle:local .
docker build -f deploy/ocr/Dockerfile.docling -t pulse-ocr-docling:local .
```

## 3. 健康检查

`GET /health` 在设置 `OCR_TOKEN` 时要求 `X-OCR-Token` 头。两个 sidecar 端口未映射到
宿主机，可在容器内或从 `app` 容器验证：

```bash
# 在 sidecar 容器内（token 从容器环境读取，与运行配置一致）
docker compose exec paddle python -c "import json, os, urllib.request as u; print(json.load(u.urlopen(u.Request('http://127.0.0.1:8765/health', headers={'X-OCR-Token': os.environ.get('OCR_TOKEN', '')}), timeout=10)))"

# 从 app 容器访问（容器名即服务名）
docker compose exec app node -e "fetch('http://paddle:8765/health',{headers:{'X-OCR-Token':process.env.OCR_TOKEN||''}}).then(r=>r.text()).then(console.log)"
```

返回示例：`{"ok": true, "engine": "paddle", "ready": true, ...}`。若 token 不匹配会得到
`401 {"error": "invalid token"}`，此时容器健康状态为 `unhealthy`。

镜像内的 HEALTHCHECK：`--interval=30s --timeout=15s --start-period=180s --retries=3`。
`start-period` 较长是因为进程会在开始监听前完成引擎初始化（`ensure_engine()`）。

## 4. 镜像体积与首次启动

- `paddle`：构建后约 1.5–2.5 GB；`docling`：约 2.5–4 GB（均指未压缩镜像，取决于上游
  依赖版本）。
- 模型权重**没有打进镜像**：首次启动时下载到容器内（Paddle 的检测/识别模型约数百 MB，
  Docling 的版面/表格模型与 OCR 引擎权重约 1–2 GB）。需要外网访问，且第一次启动会明显
  超过通常的健康检查窗口（因此 180s start-period）。Docling 的 OCR 引擎由
  `OcrAutoOptions` 自动选择；标准安装通常提供 RapidOCR，若构建中加入 EasyOCR/Tesseract
  需要相应系统依赖。
- 容器重建后模型缓存会丢失（容器内 `$HOME/.cache` 等目录是临时的）。如需持久化缓存，
  可通过 override 文件为对应服务挂载可写的命名卷，例如
  `paddle-models:/home/ocr/.paddleocr:rw`、`docling-models:/home/ocr/.cache:rw`（需要同时在
  override 的 `volumes:` 顶层声明这些卷；注意不要覆盖 `/app/data` 的只读挂载）。sidecar
  以 uid `10001`（镜像内用户 `ocr`）运行，命名卷首次挂载属 root 时需要
  `chown 10001:10001`，或直接用 `user: "10001:10001"` 的镜像默认值配合卷的属主设置。
- Paddle 在开始监听前完成引擎初始化；Docling 的转换器在首次 `/extract` 时才加载模型，
  因此健康检查通过不代表模型已就绪。首次识别前建议先用一个小 PDF/PNG 预热，或保留
  `OCR_TIMEOUT_SECONDS`（默认 300）的余量。

## 5. CPU / GPU 说明

- 两个镜像默认安装 **CPU** 轮子（`paddlepaddle`，Docling 使用 CPU 的 torch/onnx 后端），
  可在无 GPU 的宿主机上直接运行。
- 需要 GPU 时：主机安装 NVIDIA 驱动与 `nvidia-container-toolkit`；将基础镜像换成
  CUDA 版本、Paddle 改为 `paddlepaddle-gpu`（CUDA 版本需与驱动匹配），并在 override 中
  为服务添加 `deploy.resources.reservations.devices`（`driver: nvidia`,
  `count: 1`, `capabilities: [gpu]`）。Compose 文件里未启用 GPU，避免无 GPU 环境下
  启动失败。

## 6. 上传路径要求

- sidecar 只处理 `--upload-root` 之下的**绝对路径**，入口固定为
  `--upload-root /app/data/uploads`，请求中携带的文件路径由应用给出，因此两侧路径必须
  完全一致；这也是把宿主 `./data` 挂到 `/app/data` 的原因。
- 若自定义了 `DB_PATH`/`UPLOAD_DIR`（上传目录不再位于数据库同级的 `uploads`），需要
  同步修改 `deploy/ocr/Dockerfile.*` 的 `ENTRYPOINT` 与 `docker-compose.yml` 中的挂载点。
- 挂载是只读的：sidecar 只读取文件，写入由 `app` 负责。

## 7. 常见问题

| 现象                                            | 原因与处理                                                            |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| 容器立即退出，日志 `upload root does not exist` | 宿主 `data/uploads` 不存在；先 `mkdir -p data/uploads` 再重启         |
| `unhealthy`，日志/手动请求返回 `401`            | `OCR_TOKEN` 不一致；确认 `.env` 中值已注入两个容器并重建              |
| 应用不使用 OCR，上传标记 skipped                | `.env` 里 `OCR_PADDLE_URL` / `OCR_DOCLING_URL` 未设置，或未带 profile |
| 首次启动长时间 `starting`                       | 正在下载模型；`docker compose logs -f <service>` 观察进度             |
| 首次识别超时或 `candidate` 阶段失败             | Docling 首次转换会下载/加载模型；先预热或调大 `OCR_TIMEOUT_SECONDS`   |
| 构建失败（下载超时）                            | 需要访问 PyPI 与模型站点；可在构建时配置代理或使用内部镜像源          |
| 日志显示打不开上传文件（`404`/权限错误）        | `data/` 对 uid `10001` 不可读；`chmod -R o+rX data` 或对齐 gid        |
