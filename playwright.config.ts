import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${port}`;

// WSL without system libgbm: pick up the locally extracted Playwright dependency libs.
const localLibs = join(homedir(), '.cache', 'pw-libs', 'usr', 'lib', 'x86_64-linux-gnu');
const libraryPath = existsSync(join(localLibs, 'libgbm.so.1'))
  ? [localLibs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':')
  : process.env.LD_LIBRARY_PATH;

export default defineConfig({
  testDir: join(root, 'e2e'),
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  testIgnore: process.env.E2E_VISUAL === '1' ? [] : ['**/visual.spec.ts'],
  use: {
    baseURL,
    trace: 'on-first-retry',
    launchOptions: libraryPath ? { env: { ...process.env, LD_LIBRARY_PATH: libraryPath } } : {},
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ...(process.env.E2E_ALL_BROWSERS === '1'
      ? [
          { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
          { name: 'webkit', use: { ...devices['Desktop Safari'] } },
        ]
      : []),
  ],
  webServer: {
    command: 'rm -f data/e2e.db data/e2e.db-wal data/e2e.db-shm && npm run build && npm start',
    url: `${baseURL}/api/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      PORT: String(port),
      DB_PATH: join(root, 'data', 'e2e.db'),
      BACKUP_DIR: join(root, 'data', 'e2e-backups'),
      NODE_ENV: 'production',
      COOKIE_SECURE: '0',
      ALLOW_INSECURE_COOKIES: '1',
      RATE_LIMIT_MAX: '100000',
      LOGIN_RATE_LIMIT_MAX: '100000',
      MAX_SSE_HANDSHAKES: '100000',
      LOG_LEVEL: 'silent',
    },
  },
});
