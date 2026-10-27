#!/usr/bin/env node
// Simple load generator: signs in, then reads authenticated endpoints under
// concurrency and prints latency percentiles plus the matching Prometheus metrics.

const base = process.argv[2] ?? process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const email = process.env.LOAD_EMAIL ?? 'admin@pulse.demo';
const password = process.env.LOAD_PASSWORD ?? 'Demo1234!';
const total = Number(process.env.REQUESTS ?? 1_000);
const concurrency = Number(process.env.CONCURRENCY ?? 20);
const paths = ['/api/projects?pageSize=10', '/api/dashboard/summary?range=7d', '/api/health'];

const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
if (!login.ok) {
  console.error(`login failed: ${login.status} ${await login.text()}`);
  process.exit(1);
}
const cookie = login.headers
  .getSetCookie()
  .map((value) => value.split(';')[0])
  .join('; ');
const headers = { cookie };

const latencies = [];
const statuses = new Map();
let cursor = 0;

async function worker() {
  while (true) {
    const index = cursor++;
    if (index >= total) return;
    const path = paths[index % paths.length];
    const started = performance.now();
    try {
      const res = await fetch(base + path, { headers });
      await res.arrayBuffer();
      statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
    } catch (error) {
      statuses.set('error', (statuses.get('error') ?? 0) + 1);
      console.error(String(error));
    }
    latencies.push(performance.now() - started);
  }
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

console.log(`load: ${total} requests, concurrency ${concurrency} -> ${base}`);
const started = performance.now();
await Promise.all(Array.from({ length: concurrency }, () => worker()));
const wall = performance.now() - started;

latencies.sort((a, b) => a - b);
console.log(
  `elapsed ${(wall / 1000).toFixed(2)}s  throughput ${(total / (wall / 1000)).toFixed(0)} req/s`,
);
console.log(
  `latency ms  p50 ${percentile(latencies, 50).toFixed(1)}  p95 ${percentile(latencies, 95).toFixed(1)}  p99 ${percentile(latencies, 99).toFixed(1)}  max ${latencies.at(-1).toFixed(1)}`,
);
console.log('statuses', Object.fromEntries(statuses));

try {
  const metrics = await (await fetch(`${base}/metrics`)).text();
  const lines = metrics
    .split('\n')
    .filter((line) =>
      /^node_pulse_(http_requests_total|sse_clients|projects_total|users_total|sessions_total)/.test(
        line,
      ),
    );
  console.log('\n--- /metrics ---');
  console.log(lines.join('\n'));
} catch (error) {
  console.error('could not read /metrics:', String(error));
}
