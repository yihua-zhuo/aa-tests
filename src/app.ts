import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Scalar } from '@scalar/hono-api-reference';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import type { OcrEngine } from '../shared/types.ts';
import type { AppEnv } from './app-env.ts';
import { defaultBackupDir } from './backup.ts';
import { MAX_IMPORT_BYTES } from './csv.ts';
import { log } from './logger.ts';
import { Metrics } from './metrics.ts';
import { enforceTokenPolicy, loadUser, requireAuth, requireSession } from './middleware/auth.ts';
import { bodyLimit, rateLimit } from './middleware/limits.ts';
import { requireSameOrigin, requireTrustedHost } from './middleware/security.ts';
import { tokenQuota } from './middleware/token-quota.ts';
import { contextIp, parseHosts, parseOrigins, safeEqual } from './net.ts';
import type { OcrBench } from './ocr-bench.ts';
import { openApiDocument } from './openapi.ts';
import { PushSender } from './push.ts';
import { activityRoutes } from './routes/activities.ts';
import { analyticsRoutes } from './routes/analytics.ts';
import { attachmentRoutes } from './routes/attachments.ts';
import { auditRoutes } from './routes/audit.ts';
import { authRoutes } from './routes/auth.ts';
import { automationRoutes } from './routes/automation.ts';
import { commentRoutes } from './routes/comments.ts';
import { dashboardRoutes } from './routes/dashboard.ts';
import { domainActionRoutes } from './routes/domain-actions.ts';
import { eventsRoutes } from './routes/events.ts';
import { governanceRoutes } from './routes/governance.ts';
import { insightsRoutes } from './routes/insights.ts';
import { integrationRoutes } from './routes/integrations.ts';
import { knowledgeRoutes } from './routes/knowledge.ts';
import { notificationRoutes } from './routes/notifications.ts';
import { ocrGovernanceRoutes } from './routes/ocr-governance.ts';
import { ocrLabRoutes } from './routes/ocr-lab.ts';
import { ocrRegistryRoutes } from './routes/ocr-registry.ts';
import { opsRoutes } from './routes/ops.ts';
import { planningRoutes } from './routes/planning.ts';
import { profileRoutes } from './routes/profile.ts';
import { projectRoutes } from './routes/projects.ts';
import { pushRoutes } from './routes/push.ts';
import { searchRoutes } from './routes/search.ts';
import { strategyRoutes } from './routes/strategy.ts';
import { taskRoutes } from './routes/tasks.ts';
import { userRoutes } from './routes/users.ts';
import { workbenchRoutes } from './routes/workbench.ts';
import { runtimeInfo } from './runtime.ts';
import type { EventHub } from './sse.ts';
import type { Store } from './store.ts';
import { MAX_ATTACHMENT_BYTES, MAX_AVATAR_BYTES } from './uploads.ts';
import type { WsHub } from './ws.ts';

export type AppOptions = {
  staticDir?: string;
  wsHub?: WsHub;
  trustProxy?: boolean;
  allowedOrigins?: readonly string[];
  allowedHosts?: readonly string[];
  maxSseClients?: number;
  maxSsePerIp?: number;
  maxSseHandshakes?: number;
  metricsToken?: string;
  metricsPublic?: boolean;
  enableDocs?: boolean;
  rateLimitMax?: number;
  loginRateLimitMax?: number;
  importRateLimitMax?: number;
  tokenQuotaMax?: number;
  isReady?: () => boolean;
  push?: PushSender;
  backupDir?: string;
  ocrWake?: () => void;
  ocrModelPeek?: (engine: OcrEngine) => string | null;
  ocrLab?: OcrBench;
};

const SCALAR_CDN = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.76.0';

const DOC_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: https:; connect-src 'self' https:; font-src 'self' data: https:;";

const PUBLIC_API_PATHS = new Set([
  '/api/health',
  '/api/health/ready',
  '/api/auth/login',
  '/api/auth/mfa',
  '/api/auth/password-reset/request',
  '/api/auth/password-reset/confirm',
  '/api/auth/logout',
  '/api/auth/demo-users',
  '/api/openapi.json',
  '/api/doc',
]);

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function createApp(store: Store, hub: EventHub, options: AppOptions = {}): Hono<AppEnv> {
  const metrics = new Metrics();
  const trustProxy = options.trustProxy ?? /^(1|true)$/i.test(process.env.TRUST_PROXY ?? '');
  const allowedOrigins = options.allowedOrigins ?? parseOrigins(process.env.ALLOWED_ORIGINS);
  const allowedHosts = options.allowedHosts ?? parseHosts(process.env.ALLOWED_HOSTS);
  const maxSseClients = options.maxSseClients ?? positiveInt(process.env.MAX_SSE_CLIENTS, 200);
  const maxSsePerIp = options.maxSsePerIp ?? positiveInt(process.env.MAX_SSE_PER_IP, 10);
  const maxSseHandshakes =
    options.maxSseHandshakes ?? positiveInt(process.env.MAX_SSE_HANDSHAKES, 30);
  const metricsToken = options.metricsToken ?? process.env.METRICS_TOKEN;
  const production = process.env.NODE_ENV === 'production';
  const metricsPublic = options.metricsPublic ?? (!production && metricsToken === undefined);
  const docsEnabled =
    options.enableDocs ?? (!production || /^(1|true)$/i.test(process.env.API_DOCS ?? ''));
  const rateMax = options.rateLimitMax ?? positiveInt(process.env.RATE_LIMIT_MAX, 240);
  const loginRateMax =
    options.loginRateLimitMax ?? positiveInt(process.env.LOGIN_RATE_LIMIT_MAX, 30);
  const importRateMax =
    options.importRateLimitMax ?? positiveInt(process.env.IMPORT_RATE_LIMIT_MAX, 10);
  const tokenQuotaMax = options.tokenQuotaMax ?? positiveInt(process.env.TOKEN_RATE_LIMIT_MAX, 120);
  const slowRequestMs = positiveInt(process.env.SLOW_REQUEST_MS, 500);
  const backupDir = options.backupDir ?? defaultBackupDir(store.db.path);
  const app = new Hono<AppEnv>();

  app.use(async (c, next) => {
    const reqId = crypto.randomUUID().slice(0, 8);
    c.set('reqId', reqId);
    c.header('X-Request-Id', reqId);
    const started = performance.now();
    try {
      await next();
    } finally {
      const ms = performance.now() - started;
      metrics.observe(c.req.method, c.req.path, c.res.status, ms);
      const fields = {
        reqId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(ms),
      };
      log('info', 'http', fields);
      if (ms >= slowRequestMs) log('warn', 'http.slow', fields);
    }
  });

  const secure = secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      baseUri: ["'none'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'"],
      styleSrcAttr: ["'unsafe-inline'"],
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: 'same-origin',
    xFrameOptions: 'DENY',
    permissionsPolicy: {
      camera: [],
      microphone: [],
      geolocation: [],
      payment: [],
    },
  });

  app.use('*', async (c, next) => {
    if (c.req.path === '/api/doc' || c.req.path.startsWith('/api/doc/')) {
      await next();
      c.header('Content-Security-Policy', DOC_CSP);
      c.header('X-Content-Type-Options', 'nosniff');
      c.header('X-Frame-Options', 'DENY');
      return;
    }
    await secure(c, next);
    if (production || new URL(c.req.url).protocol === 'https:') {
      c.header('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
  });

  app.use('*', requireTrustedHost({ allowedHosts }));

  app.use(compress({ threshold: 1024 }));

  app.use('/api/*', requireSameOrigin({ allowedOrigins }));

  app.use(
    '/api/*',
    rateLimit({
      max: rateMax,
      trustProxy,
      skip: (path) => path === '/api/events' || path === '/api/doc' || path === '/api/openapi.json',
    }),
  );

  app.use('/api/auth/login', rateLimit({ max: loginRateMax, windowMs: 15 * 60_000, trustProxy }));
  app.use('/api/auth/mfa', rateLimit({ max: loginRateMax, windowMs: 15 * 60_000, trustProxy }));
  for (const path of ['/api/auth/password-reset/request', '/api/auth/password-reset/confirm']) {
    app.use(path, rateLimit({ max: loginRateMax, windowMs: 15 * 60_000, trustProxy }));
  }

  app.use('/api/projects/import', rateLimit({ max: importRateMax, trustProxy }));

  app.use('/metrics', rateLimit({ max: rateMax, trustProxy }));
  app.use('/files/*', rateLimit({ max: rateMax, trustProxy }));

  app.use(
    '/api/*',
    bodyLimit({
      defaultBytes: 64 * 1024,
      // Allow multipart framing on top of the file limits.
      overrides: {
        '/api/projects/import': MAX_IMPORT_BYTES + 64 * 1024,
        '/api/analytics/import': MAX_IMPORT_BYTES + 64 * 1024,
        '/api/profile/avatar': MAX_AVATAR_BYTES + 64 * 1024,
      },
      patternOverrides: [
        {
          pattern: /^\/api\/projects\/[^/]+\/attachments$/,
          bytes: MAX_ATTACHMENT_BYTES + 64 * 1024,
        },
        {
          pattern: /^\/api\/projects\/[^/]+\/documents$/,
          bytes: 512 * 1024,
        },
        {
          pattern: /^\/api\/documents\/[^/]+$/,
          bytes: 512 * 1024,
        },
        {
          pattern: /^\/api\/ocr\/calibration\/fit$/,
          bytes: 4 * 1024 * 1024,
        },
      ],
    }),
  );

  app.use('/api/*', loadUser(store));

  app.use('/api/*', async (c, next) => {
    if (PUBLIC_API_PATHS.has(c.req.path) || c.req.path.startsWith('/api/portal/')) {
      await next();
      return;
    }
    return requireAuth(c, next);
  });

  app.use('/api/*', enforceTokenPolicy);
  app.use('/api/*', tokenQuota({ max: tokenQuotaMax }));

  if (options.wsHub) {
    app.get(
      '/ws',
      loadUser(store),
      requireSession,
      options.wsHub.handler((c) => {
        const user = c.get('user');
        return user ? { user, sessionHash: c.get('sessionHash') } : null;
      }),
    );
  }

  app.use('*', async (c, next) => {
    await next();
    if (c.res.status !== 200) return;
    if (c.req.path.startsWith('/assets/')) {
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (c.req.path === '/' || c.req.path === '/index.html' || c.req.path === '/sw.js') {
      c.header('Cache-Control', 'no-cache');
    } else if (c.req.path === '/manifest.webmanifest') {
      c.header('Cache-Control', 'public, max-age=3600');
    }
  });

  if (options.staticDir) {
    app.use('*', serveStatic({ root: options.staticDir }));
  }

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      status: 'live',
      node: process.version,
      pid: process.pid,
      uptime: Number(process.uptime().toFixed(1)),
      clients: hub.size,
      wsClients: options.wsHub?.size ?? 0,
      demo: store.demo,
      memoryMB: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)),
    }),
  );

  app.get('/api/health/ready', (c) => {
    const databaseOk = store.db.quickCheck();
    const draining = options.isReady ? !options.isReady() : false;
    const ready = databaseOk && !draining;
    let runtime: ReturnType<typeof runtimeInfo> | null = null;
    try {
      runtime = runtimeInfo(store);
    } catch {
      runtime = null;
    }
    c.header('Cache-Control', 'no-store');
    const payload = {
      ok: ready,
      status: ready ? 'ready' : 'unready',
      checks: {
        database: databaseOk ? 'ok' : 'failed',
        lifecycle: draining ? 'draining' : 'ok',
      },
      runtime,
      clients: hub.size,
      wsClients: options.wsHub?.size ?? 0,
      slowQueries: store.db.slowQueries,
      ocr: databaseOk ? store.attachments.ocrStats() : null,
    };
    return ready ? c.json(payload) : c.json(payload, 503);
  });

  app.get('/metrics', (c) => {
    if (metricsToken) {
      const header = c.req.header('authorization') ?? '';
      const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!safeEqual(provided, metricsToken)) {
        c.header('WWW-Authenticate', 'Bearer');
        c.header('Cache-Control', 'no-store');
        return c.json({ error: 'unauthorized' }, 401);
      }
    } else if (!metricsPublic) {
      c.header('Cache-Control', 'no-store');
      return c.notFound();
    }
    c.header('Cache-Control', 'no-store');
    const stats = store.stats();
    return c.text(
      metrics.render({
        sseClients: hub.size,
        wsClients: options.wsHub?.size ?? 0,
        projects: stats.projects,
        users: stats.users,
        sessions: stats.sessions,
        slowQueries: store.db.slowQueries,
        ocr: store.attachments.ocrStats(),
      }),
      200,
      {
        'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      },
    );
  });

  app.route('/', authRoutes(store, hub, options.wsHub, trustProxy));
  app.route('/', dashboardRoutes(store));
  app.route('/', analyticsRoutes(store, trustProxy));
  app.route(
    '/',
    attachmentRoutes(store, trustProxy, {
      ocrWake: options.ocrWake,
      ocrModelPeek: options.ocrModelPeek,
    }),
  );
  app.route('/', ocrLabRoutes(options.ocrLab));
  app.route('/', ocrRegistryRoutes(store, options.ocrLab));
  app.route('/', ocrGovernanceRoutes(store, trustProxy));
  app.route(
    '/',
    pushRoutes(
      store,
      options.push ??
        new PushSender(store.push, {
          enabled: !/^(0|false|off)$/i.test(process.env.PUSH_ENABLED ?? ''),
        }),
    ),
  );
  app.route('/', projectRoutes(store, hub, trustProxy));
  app.route('/', taskRoutes(store, hub));
  app.route('/', commentRoutes(store, hub));
  app.route('/', strategyRoutes(store));
  app.route('/', planningRoutes(store, hub));
  app.route('/', automationRoutes(store));
  app.route('/', knowledgeRoutes(store));
  app.route('/', insightsRoutes(store));
  app.route('/', governanceRoutes(store));
  app.route('/', workbenchRoutes(store));
  app.route('/', domainActionRoutes(store));
  app.route('/', notificationRoutes(store));
  app.route('/', activityRoutes(store));
  app.route('/', searchRoutes(store));
  app.route('/', userRoutes(store, hub, options.wsHub, trustProxy));
  app.route('/', profileRoutes(store, hub, options.wsHub, trustProxy));
  app.route('/', integrationRoutes(store, trustProxy, { max: tokenQuotaMax, windowSeconds: 60 }));
  app.route('/', auditRoutes(store, trustProxy));
  app.route('/', opsRoutes(store, hub, options.wsHub, trustProxy, backupDir));
  app.route(
    '/',
    eventsRoutes(store, hub, {
      trustProxy,
      maxClients: maxSseClients,
      maxPerIp: maxSsePerIp,
      handshakeMax: maxSseHandshakes,
    }),
  );

  if (docsEnabled) {
    app.get('/api/openapi.json', (c) => {
      c.header('Cache-Control', 'no-store');
      return c.json(openApiDocument() as never);
    });
    app.get('/api/doc', Scalar({ url: '/api/openapi.json', cdn: SCALAR_CDN }));
  }

  let indexHtml: string | null = null;
  if (options.staticDir) {
    try {
      indexHtml = readFileSync(join(options.staticDir, 'index.html'), 'utf8');
    } catch {
      indexHtml = null;
    }
  }
  if (indexHtml) {
    const html = indexHtml;
    app.get('*', (c) => {
      const path = c.req.path;
      if (
        path.startsWith('/api/') ||
        path === '/metrics' ||
        path === '/ws' ||
        path.startsWith('/assets/') ||
        /\.[a-zA-Z0-9]+$/.test(path)
      ) {
        return c.notFound();
      }
      c.header('Cache-Control', 'no-cache');
      return c.html(html);
    });
  }

  app.notFound((c) => c.json({ error: 'not_found', path: c.req.path, reqId: c.get('reqId') }, 404));

  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return error.getResponse();
    }
    log('error', 'unhandled', {
      reqId: c.get('reqId'),
      error: error.message,
      ...(production ? {} : { stack: error.stack }),
    });
    return c.json({ error: 'internal_error', reqId: c.get('reqId') }, 500);
  });

  return app;
}

export { contextIp };
