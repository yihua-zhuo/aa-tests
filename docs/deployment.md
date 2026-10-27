# 部署与运维

本文覆盖生产部署、TLS/反向代理、升级与回滚、备份恢复和故障排查。

## 1. 运行形态

- 单进程 Node.js（支持 24.x LTS 与 26.x，开发/CI 推荐 `.nvmrc` 的 26.12.1），内置 `node:sqlite`，无需外部数据库。
- 部署前可运行 `npm run check:runtime`：同时校验 Node 版本、`.nvmrc`、lockfile v3 与依赖完整性。
- 默认端口 `3000`；SQLite 文件默认 `./data/pulse.db`（WAL 模式）。
- 数据目录还包含 `backups/`（自动快照）和迁移前的 `.pre-v2.bak`。
- 进程同时提供 HTTP、SSE（`/api/events`）与 WebSocket（`/ws`），反向代理需支持三者。

## 2. 环境变量与安全组合

完整清单见 [`.env.example`](../.env.example)。最关键的组合：

| 场景                 | TRUST_PROXY | COOKIE_SECURE | ALLOW_INSECURE_COOKIES |
| -------------------- | ----------- | ------------- | ---------------------- |
| TLS 反向代理（推荐） | `1`         | `1`           | 不设置                 |
| 本地/内网 HTTP 评估  | 按需        | `0`           | `1`（显式确认风险）    |

生产模式（`NODE_ENV=production`）下，若既未信任代理、也未启用安全 Cookie 且未显式
允许不安全 Cookie，进程会拒绝启动。`DEMO_MODE=0` 时必须提供
`ADMIN_EMAIL` / `ADMIN_PASSWORD`，否则同样拒绝启动。

建议同时设置：
- `ALLOWED_ORIGINS=https://your.domain`（跨源与 WebSocket 校验）
- `ALLOWED_HOSTS=your.domain`（防 Host 头注入）
- `WORKSPACE_TIMEZONE=Asia/Shanghai`（日期分桶与“今天”）
- `METRICS_TOKEN=<长随机串>`（生产环境 `/metrics` 默认隐藏，设置后以 Bearer 保护）

## 3. Docker Compose 部署

```bash
cp .env.example .env
# 编辑 .env：DEMO_MODE=0、ADMIN_*、ALLOWED_ORIGINS、TRUST_PROXY/COOKIE_SECURE
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:3000/api/health
```

说明：
- 镜像多阶段构建，仅保留生产依赖；以非 root 用户 `node`（uid 1000）运行。
- `./data` 以 bind mount 挂载。宿主机目录需对 uid 1000 可写：
  `sudo chown -R 1000:1000 data`。
- 端口只绑定 `127.0.0.1`，由反向代理对外提供 TLS。
- 容器带 `HEALTHCHECK`，并设置 `stop_grace_period: 20s` 以等待优雅关闭。

直接运行镜像（不使用 Compose）时，必须显式传入管理员与 TLS 相关变量：

```bash
docker run -d --name pulse -p 127.0.0.1:3000:3000 \
  -v "$PWD/data:/app/data" \
  -e DEMO_MODE=0 -e ADMIN_EMAIL=admin@example.com -e ADMIN_PASSWORD='...' \
  -e TRUST_PROXY=1 -e COOKIE_SECURE=1 -e ALLOWED_ORIGINS=https://pulse.example.com \
  pulse:local
```

## 4. 直接使用 Node + systemd

```bash
npm ci
npm run build
cp .env.example .env   # 填写生产配置
```

`/etc/systemd/system/pulse.service`：

```ini
[Unit]
Description=Pulse dashboard
After=network.target

[Service]
Type=simple
User=pulse
WorkingDirectory=/opt/pulse
EnvironmentFile=/opt/pulse/.env
ExecStart=/usr/bin/node src/server.ts
Restart=on-failure
RestartSec=3
# Graceful shutdown: the app drains for SHUTDOWN_DRAIN_MS then closes SSE/WS.
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pulse
journalctl -u pulse -f
```

`data/` 与 `.env` 应仅对该用户可读写（`chmod 700 data`、`chmod 600 .env`）。

## 5. 反向代理

示例文件：
- nginx：[`deploy/nginx.conf`](../deploy/nginx.conf)
- Caddy：[`deploy/Caddyfile`](../deploy/Caddyfile)

要点：
- 透传 `Host`、`X-Forwarded-For` 与 `X-Forwarded-Proto`。
- SSE `/api/events` 需要关闭代理缓冲（nginx `proxy_buffering off`、
  Caddy `flush_interval -1`），并把读超时调到小时级。
- WebSocket `/ws` 需要 `Upgrade` / `Connection` 头（Caddy 自动处理）。
- 上传上限：应用对导入请求限制 2 MB，代理 `client_max_body_size` 建议 3 MB。
- 应用自身已设置 CSP/HSTS 等安全头；在代理层不要重复添加冲突规则。

## 6. 健康检查与指标

| 端点                | 用途                                                       |
| ------------------- | ---------------------------------------------------------- |
| `/api/health`       | 存活探针，不访问数据库，始终轻量                           |
| `/api/health/ready` | 就绪探针，检查数据库；优雅关闭期间返回 503                 |
| `/metrics`          | Prometheus 文本指标，生产需 `METRICS_TOKEN` 且 Bearer 认证 |

```bash
curl -fsS http://127.0.0.1:3000/api/health/ready
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:3000/metrics | head
```

## 7. 备份

自动备份：进程启动约 `BACKUP_STARTUP_DELAY_SECONDS` 后以及每
`BACKUP_INTERVAL_HOURS` 小时执行 `VACUUM INTO`，生成
`data/backups/pulse-<UTC 时间戳>.db`，并按 `BACKUP_RETENTION_DAYS` 清理。
`VACUUM INTO` 在 WAL 下也保证一致性，可在服务运行时执行。

手动快照（任意时刻，安全）：

```bash
node scripts/backup.mjs                 # 使用 DB_PATH 或默认 data/pulse.db
node scripts/backup.mjs data/pulse.db   # 显式指定数据库
```

在容器内：

```bash
docker compose exec app node scripts/backup.mjs
```

输出为 `data/backups/manual-<UTC 时间戳>.db`。也可以停服后直接复制整个 `data/`
目录（包含 WAL/SHM）。

## 8. 恢复

```bash
# 1) 停止服务，避免写入
sudo systemctl stop pulse        # 或 docker compose stop app

# 2) 恢复（默认目标 data/pulse.db；已存在时需 --force，旧库会自动留档）
node scripts/restore.mjs data/backups/pulse-2026-10-24_03-00-00-000Z.db data/pulse.db --force

# 3) 校验并启动
sudo systemctl start pulse
curl -fsS http://127.0.0.1:3000/api/health/ready
```

恢复脚本会先 `PRAGMA quick_check` 校验快照，替换前把旧库改名为
`pulse.db.pre-restore-<时间戳>`，并清理残留的 `-wal` / `-shm`。

## 9. 升级与回滚

### 源码部署

```bash
# 备份（自动快照之外再留一份）
node scripts/backup.mjs
cp -a data "data-backup-$(date +%Y%m%d%H%M%S)"

sudo systemctl stop pulse
git pull            # 或解压新版本
npm ci
npm run build
sudo systemctl start pulse
```

- 启动时会执行 schema 迁移；旧版 schema 会先生成 `data/pulse.db.pre-v2.bak`。
- 迁移失败时进程不会进入就绪状态，日志会给出原因；此时停止服务并从快照恢复。

### Docker 部署

```bash
# 给当前版本打标签，便于回滚
docker tag pulse:local pulse:2026-10-24
cp -a data "data-backup-$(date +%Y%m%d%H%M%S)"
docker compose build app
docker compose up -d app
docker compose logs -f app
```

回滚：

```bash
docker compose stop app
docker tag pulse:2026-10-24 pulse:local   # 或修改 compose 的 image
docker compose up -d app
```

若新版本已迁移数据库且旧版本不兼容，先停机再用升级前的快照恢复（见第 8 节），
然后启动旧版本。回滚前务必保留当前数据库副本。

## 10. 故障排查

| 现象                                 | 排查方向                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| 进程启动即退出，日志 `server.config` | 生产环境 Cookie/代理配置缺失；或 `DEMO_MODE=0` 未提供管理员凭据               |
| 登录后立刻掉线                       | 代理未透传 `X-Forwarded-Proto`，或 `COOKIE_SECURE` 与访问协议不一致           |
| 实时更新不推送                       | 代理缓冲未关闭（SSE）或未转发 Upgrade 头（WebSocket）；检查 `ALLOWED_ORIGINS` |
| `SQLITE_BUSY` / 写入慢               | 确认单实例运行、磁盘可靠；查看 `/metrics` 与慢请求日志（`SLOW_REQUEST_MS`）   |
| 备份目录为空                         | `BACKUP_STARTUP_DELAY_SECONDS` 未到、`DB_PATH=:memory:` 或目录不可写          |
| 429 频繁出现                         | 调整 `RATE_LIMIT_MAX` / `LOGIN_RATE_LIMIT_MAX` / `IMPORT_RATE_LIMIT_MAX`      |
| `/metrics` 404                       | 生产环境默认隐藏；设置 `METRICS_TOKEN` 后用 Bearer 访问                       |
| `/api/doc` 404                       | 生产环境默认关闭；确需开启时设置 `API_DOCS=1`                                 |

## 11. 上线检查清单

- [ ] `DEMO_MODE=0`，管理员密码为强随机值并通过登录验证
- [ ] 反向代理 TLS 正常，`TRUST_PROXY=1`、`COOKIE_SECURE=1`
- [ ] `ALLOWED_ORIGINS` / `ALLOWED_HOSTS` 与实际域名一致
- [ ] `METRICS_TOKEN` 已设置，监控采集 `/api/health`、`/api/health/ready` 与 `/metrics`
- [ ] `data/` 与 `.env` 权限收紧，`data/` 纳入宿主机备份
- [ ] 手工执行一次备份与恢复演练（第 7、8 节）
- [ ] 升级前打镜像标签并额外复制 `data/`，确认回滚步骤可执行
