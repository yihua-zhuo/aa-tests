import { styleText } from 'node:util';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;

export type LogLevel = keyof typeof LEVELS;

const SENSITIVE_KEY =
  /^(password|currentpassword|newpassword|passwordhash|token|resettoken|authorization|cookie|setcookie|secret|apikey|mfasecret|recoverycodes)$/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY.test(key.replace(/[-_]/g, ''))
        ? '[redacted]'
        : redact(item, depth + 1);
    }
    return output;
  }
  return value;
}

function threshold(): number {
  const configured = process.env.LOG_LEVEL as LogLevel | undefined;
  return configured && configured in LEVELS ? LEVELS[configured] : LEVELS.info;
}

export function log(
  level: Exclude<LogLevel, 'silent'>,
  message: string,
  fields: Record<string, unknown> = {},
): void {
  if (LEVELS[level] < threshold()) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...(redact(fields) as Record<string, unknown>),
  });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export function banner(port: number, dbPath: string, demo = true): void {
  const title = styleText(['bold', 'cyan'], 'CLAY DASHBOARD');
  const dim = (text: string) => styleText('dim', text);
  console.log('');
  console.log(`  ${title} ${dim('— SaaS 分析平台 · Hono + node:sqlite')}`);
  console.log(`  ${dim('local')}       ${styleText('green', `http://localhost:${port}`)}`);
  console.log(`  ${dim('host')}        ${styleText('green', `http://<本机IP>:${port}`)}`);
  console.log(`  ${dim('runtime')}     ${process.version}  ${dim('db')} ${dbPath}`);
  console.log(
    `  ${dim('demo')}        ${
      demo ? styleText('green', 'admin@pulse.demo / Demo1234!') : dim('disabled (DEMO_MODE=0)')
    }`,
  );
  console.log('');
}
