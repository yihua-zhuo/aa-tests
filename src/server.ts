import type { Server } from 'node:http';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { canAccessProject } from '../shared/permissions.ts';
import { createApp } from './app.ts';
import { applyPendingRestore, defaultBackupDir, startBackupScheduler } from './backup.ts';
import { positiveIntEnv } from './db.ts';
import { EnterpriseWorker } from './enterprise-worker.ts';
import { banner, log } from './logger.ts';
import { createMailer } from './mailer.ts';
import { parseHosts, parseOrigins } from './net.ts';
import { NotificationWorker } from './notification-worker.ts';
import { PushSender } from './push.ts';
import { PushWorker } from './push-worker.ts';
import { isDemoEmail } from './seed.ts';
import { EventHub } from './sse.ts';
import { createStore } from './store.ts';
import { WebhookWorker } from './webhook-worker.ts';
import { createWebSocketServer, WsHub } from './ws.ts';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  log('error', 'server.config', { message: `PORT 无效：${process.env.PORT}` });
  process.exit(1);
}
const dbPath = process.env.DB_PATH ?? join(import.meta.dirname, '..', 'data', 'pulse.db');
const trustProxy = /^(1|true)$/i.test(process.env.TRUST_PROXY ?? '');
const allowedOrigins = parseOrigins(process.env.ALLOWED_ORIGINS);
const allowedHosts = parseHosts(process.env.ALLOWED_HOSTS);
const production = process.env.NODE_ENV === 'production';
const allowInsecureCookies = /^(1|true)$/i.test(process.env.ALLOW_INSECURE_COOKIES ?? '');
if (production && !trustProxy && process.env.COOKIE_SECURE !== '1' && !allowInsecureCookies) {
  log('error', 'server.config', {
    message:
      '生产环境需要在 TLS 终止代理后设置 TRUST_PROXY=1，或设置 COOKIE_SECURE=1；确需明文 HTTP 时请显式设置 ALLOW_INSECURE_COOKIES=1',
  });
  process.exit(1);
}

const bootstrapAdmin =
  process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD
    ? {
        email: process.env.ADMIN_EMAIL,
        password: process.env.ADMIN_PASSWORD,
        name: process.env.ADMIN_NAME,
      }
    : undefined;

const restoredFrom = applyPendingRestore(dbPath);
if (restoredFrom) {
  log('warn', 'server.restore_applied', {
    dbPath,
    previousBackup: restoredFrom,
    message: '已应用运维面板排队的备份恢复',
  });
}

const store = createStore(dbPath, { bootstrapAdmin });
if (!store.demo && store.users.activeAdmins(undefined, isDemoEmail) === 0) {
  log('error', 'server.bootstrap', {
    message: 'DEMO_MODE=0 需要 ADMIN_EMAIL / ADMIN_PASSWORD 以创建首个管理员',
  });
  store.close();
  process.exit(1);
}
const hub = new EventHub();
const mailer = createMailer();
const mailWorker = mailer
  ? new NotificationWorker(store, mailer, {
      intervalMs: positiveIntEnv('MAIL_INTERVAL_SECONDS', 30) * 1000,
    })
  : null;
mailWorker?.start();
const webhookWorker = new WebhookWorker(store, {
  intervalMs: positiveIntEnv('WEBHOOK_INTERVAL_SECONDS', 10) * 1000,
  timeoutMs: positiveIntEnv('WEBHOOK_TIMEOUT_SECONDS', 10) * 1000,
});
webhookWorker.start();
const pushSender = new PushSender(store.push, {
  enabled: !/^(0|false|off)$/i.test(process.env.PUSH_ENABLED ?? ''),
});
await pushSender.init().catch((cause: unknown) => {
  log('warn', 'push.init_failed', {
    message: cause instanceof Error ? cause.message : String(cause),
  });
});
const pushWorker = new PushWorker(store, pushSender, {
  intervalMs: positiveIntEnv('PUSH_INTERVAL_SECONDS', 15) * 1000,
});
pushWorker.start();
const enterpriseWorker = new EnterpriseWorker(store, {
  intervalMs: positiveIntEnv('ENTERPRISE_INTERVAL_SECONDS', 60) * 1000,
});
enterpriseWorker.start();
const backupDir = process.env.BACKUP_DIR ?? defaultBackupDir(dbPath);
const backups = startBackupScheduler(store, {
  dir: backupDir,
  retentionDays: positiveIntEnv('BACKUP_RETENTION_DAYS', 14),
  trashRetentionDays: positiveIntEnv('TRASH_RETENTION_DAYS', 30),
  intervalMs: positiveIntEnv('BACKUP_INTERVAL_HOURS', 24) * 60 * 60 * 1000,
  startupDelayMs: positiveIntEnv('BACKUP_STARTUP_DELAY_SECONDS', 60) * 1000,
  retention: () => store.ops.retention(),
});
const wsHub = new WsHub({
  trustProxy,
  allowedOrigins,
  allowedHosts,
  canAccess: (role, userId, projectId) => {
    const access = store.projects.access(projectId);
    if (!access) return false;
    return canAccessProject(role, userId, access);
  },
});
const wss = createWebSocketServer();
const staticDir =
  process.env.STATIC_DIR ??
  (process.env.NODE_ENV === 'production'
    ? join(import.meta.dirname, '..', 'web', 'dist')
    : undefined);
let shuttingDown = false;
const drainMs = positiveIntEnv('SHUTDOWN_DRAIN_MS', 1_000);
const app = createApp(store, hub, {
  staticDir,
  wsHub,
  trustProxy,
  allowedOrigins,
  allowedHosts,
  isReady: () => !shuttingDown,
  push: pushSender,
  backupDir,
});

const server = serve(
  { fetch: app.fetch, port, hostname: '0.0.0.0', websocket: { server: wss } },
  (info) => {
    banner(info.port, dbPath, store.demo);
    log('info', 'server.start', {
      port: info.port,
      node: process.version,
      sqlite: store.db.sqliteVersion(),
      pid: process.pid,
      dbPath,
      staticDir,
      demo: store.demo,
      mail: Boolean(mailer),
    });
  },
);

const httpServer = server as Server;
httpServer.requestTimeout = 30_000;
httpServer.headersTimeout = 10_000;
httpServer.keepAliveTimeout = 5_000;
httpServer.maxHeadersCount = 100;

server.on('error', (error: Error) => {
  log('error', 'server.error', { error: error.message });
  process.exit(1);
});

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'server.shutdown', { signal, drainMs });
  backups.stop();
  mailWorker?.stop();
  webhookWorker.stop();
  pushWorker.stop();
  enterpriseWorker.stop();

  const force = setTimeout(() => {
    log('warn', 'server.force_exit');
    process.exit(1);
  }, 10_000);
  force.unref();

  // Readiness reports 503 immediately; give load balancers a moment to notice
  // before dropping live streams and no longer accepting connections.
  setTimeout(() => {
    hub.closeAll();
    wsHub.closeAll();
    wss.close();
    httpServer.closeIdleConnections();
    server.close(() => {
      clearTimeout(force);
      store.close();
      log('info', 'server.closed', { signal });
      process.exit(0);
    });
  }, drainMs);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
