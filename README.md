# Clay Dashboard / Pulse

SaaS 分析与项目协作工作台：Hono + Node.js 内置 SQLite（`node:sqlite`）+ React 19。
包含 RBAC、项目回收站、活动流与 SSE 实时更新、WebSocket 协作、审计与指标、MFA、
CSV 导入导出、图表无障碍与导出、中英文界面、带作用域的个人访问令牌与签名
Webhook 集成、任务/子任务/里程碑、评论与通知中心、附件（类型/大小校验、签名私有
下载链接、原生抽取优先的本地 OCR 与质量复核）与头像上传裁剪，以及标签、收藏、
个人视图与批量操作等能力；分析数据支持
CSV/API 导入、工作区币种与汇率换算、CSV 导出和每周/每月定时报表邮件。前端支持安装为
PWA：Service Worker 缓存应用外壳，离线时可查看最近同步的只读快照；开启浏览器通知后，
新消息通过 Web Push（VAPID + RFC 8291 加密）推送到桌面与移动端。

## 快速开始（演示模式）

```bash
nvm use            # .nvmrc = Node 26.12.1（需 >= 24）
npm ci
npm run dev        # API :3000 + Vite :5173
```

打开 <http://localhost:5173>，使用演示账号登录（密码统一为 `Demo1234!`）：

| 角色     | 邮箱               |
| -------- | ------------------ |
| 管理员   | admin@pulse.demo   |
| 业务经理 | manager@pulse.demo |
| 项目经理 | pm@pulse.demo      |
| 只读成员 | viewer@pulse.demo  |

演示数据写入 `data/pulse.db`。生产部署请设置 `DEMO_MODE=0` 并提供
`ADMIN_EMAIL` / `ADMIN_PASSWORD`，否则服务会拒绝启动。

## 生产运行

### 直接使用 Node

```bash
cp .env.example .env      # 按注释填写；务必替换管理员密码
npm ci
npm run build             # 输出 web/dist
npm start                 # NODE_ENV=production，读取 .env
```

更严格的权限模型（禁止写 `data/` 之外的文件）：

```bash
npm run start:locked
```

### Docker Compose

```bash
cp .env.example .env
docker compose up -d --build
```

容器监听 `127.0.0.1:3000`，数据目录挂载到 `./data`（包含数据库与自动备份）。
默认假设前面有 TLS 反向代理；直接暴露 HTTP 时请设置
`COOKIE_SECURE=0` 与 `ALLOW_INSECURE_COOKIES=1`。

完整的部署、升级/回滚、备份恢复与反向代理示例见
[docs/deployment.md](docs/deployment.md)；当前功能、角色权限与模块说明见
[docs/features.md](docs/features.md)；OCR 完整方案、部署与识别率优化见
[docs/ocr-solution.md](docs/ocr-solution.md)，文档智能架构与质量/基准指标见
[docs/document-intelligence.md](docs/document-intelligence.md)。环境变量全集见
[.env.example](.env.example)。

## 常用脚本

| 命令                    | 说明                                                      |
| ----------------------- | --------------------------------------------------------- |
| `npm run dev`           | 并行启动 API（watch）与 Vite 开发服务器                   |
| `npm run build`         | 构建 SPA 到 `web/dist`                                    |
| `npm start`             | 以生产模式启动服务                                        |
| `npm run typecheck`     | 后端与前端两个 tsconfig 的严格类型检查                    |
| `npm run lint`          | Biome 检查（lint + 格式 + 导入排序）；`lint:fix` 自动修复 |
| `npm run lint:css`      | stylelint 检查拆分后的样式模块                            |
| `npm test`              | node:test 单元/集成测试（`test/`）                        |
| `npm run test:web`      | Vitest + Testing Library 前端测试                         |
| `npm run test:coverage` | 后端测试与行覆盖率阈值（85%）                             |
| `npm run e2e`           | Playwright 端到端测试（自动构建并以 `data/e2e.db` 启动）  |
| `npm run check:runtime` | 校验 Node/`.nvmrc`/lockfile 完整性与依赖一致性            |
| `npm run ci`            | 运行时校验 → typecheck → lint → CSS lint → 测试 → 构建    |

可选：
- `E2E_ALL_BROWSERS=1 npm run e2e`：追加 Firefox / WebKit。
- `E2E_VISUAL=1 npx playwright test e2e/visual.spec.ts --update-snapshots`：维护视觉基线。
- `node scripts/bench-search.mjs`、`node scripts/load.mjs`：搜索基准与 SSE 负载脚本，
  变量见脚本头部。

## 目录结构

```text
src/                 Hono 应用、路由、存储层、SSE/WebSocket、备份与指标
shared/              前后端共享的 Zod schema、权限、活动类型、日期范围
web/src/             React 19 SPA（路由、页面、组件、样式模块、i18n、前端测试）
test/                node:test 集成测试、OpenAPI 契约与运行时策略测试
e2e/                 Playwright 场景、移动端与无障碍测试
scripts/             备份恢复、运行时校验、搜索基准与负载工具
docs/                验收记录与运维文档
data/                SQLite 数据库与自动快照（勿提交）
```

## API 文档

开发环境（或设置 `API_DOCS=1`）下：
- `GET /api/openapi.json`：由共享 Zod schema 生成的 OpenAPI 3.1 文档。
- `GET /api/doc`：Scalar 交互式文档。

`test/openapi.test.ts` 会比对 Hono 实际挂载的路由与文档，防止二者漂移。

## 安全与运维要点

- 密码使用 scrypt 哈希；登录限流、账户锁定、可选 TOTP MFA 与一次性恢复码。
- 会话 Cookie 为 `HttpOnly` + `SameSite=Lax`，TLS 下使用 `__Host-` 前缀；
  修改密码或管理员停用账户会吊销相关会话与 WebSocket。
- CSP、HSTS、Host 校验、Origin 校验、请求体上限与细粒度限流默认开启。
- 每日通过 `VACUUM INTO` 生成一致性快照到 `data/backups/`，按保留天数清理。
- `/api/health`（存活）与 `/api/health/ready`（就绪）供编排系统探活；
  优雅关闭时先返回 503 再断开 SSE/WebSocket。
- 生产环境默认隐藏 `/api/doc` 与 `/metrics`；指标可通过 `METRICS_TOKEN` 保护。

## 运行时支持

- 支持矩阵：Node.js **24.x LTS 与 26.x**（`engines.node` 为 `>=24.0.0 <27`）；
  开发与 e2e 固定使用 `.nvmrc` 中的 26.12.1，CI 在 24 与 26 两条线上跑 lint、类型检查、测试与构建。
- `npm run check:runtime` 校验当前 Node 与 `.nvmrc` 满足 `engines`，并要求 `package-lock.json`
  为 v3、根依赖与 `package.json` 完全一致、所有 registry 包带 sha512 完整性哈希；CI 在安装后立即执行。
- 依赖内置 `node:sqlite` 与原生 TypeScript 类型剥离，无需额外编译步骤。
- 支持 Linux / macOS；Windows 建议使用 WSL2。
- 依赖更新由 Dependabot 每周发起（React/工具链分组，semver-major 需手动评审），CI 对生产依赖执行
  `npm audit --omit=dev --audit-level=high`。
