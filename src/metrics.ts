const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500];
const MAX_ROUTES = 150;
const MAX_DURATION_ROUTES = 60;

const STATIC_ROUTES = new Set([
  '/',
  '/index.html',
  '/favicon.ico',
  '/metrics',
  '/ws',
  '/api/health',
  '/api/health/ready',
  '/api/events',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/me',
  '/api/auth/demo-users',
  '/api/dashboard/summary',
  '/api/analytics/revenue',
  '/api/analytics/channels',
  '/api/analytics/audience',
  '/api/analytics/projects',
  '/api/projects',
  '/api/projects/export.csv',
  '/api/projects/import',
  '/api/activities',
  '/api/search',
  '/api/users',
  '/api/users/options',
  '/api/profile',
  '/api/profile/password',
  '/api/preferences',
  '/api/openapi.json',
  '/api/doc',
]);

// Unknown paths are folded into a fixed label so scanners cannot create
// unbounded metric series.
function normalizePath(path: string): string {
  if (/^\/api\/projects\/[^/]+$/.test(path) && path !== '/api/projects/') {
    return '/api/projects/:id';
  }
  if (/^\/api\/users\/[^/]+$/.test(path) && path !== '/api/users/options') {
    return '/api/users/:id';
  }
  if (path.startsWith('/assets/')) return '/assets/:file';
  if (STATIC_ROUTES.has(path)) return path;
  return path.startsWith('/api/') ? '/api/(other)' : '/(other)';
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

type Histogram = {
  buckets: number[];
  sum: number;
  count: number;
};

export type MetricSnapshot = {
  sseClients: number;
  wsClients: number;
  projects: number;
  users: number;
  sessions: number;
  slowQueries: number;
};

export class Metrics {
  readonly #requests = new Map<string, number>();
  readonly #durations = new Map<string, Histogram>();
  #loginFailures = 0;

  observe(method: string, path: string, status: number, ms: number): void {
    let route = normalizePath(path);
    let key = `${method}\u0000${route}\u0000${status}`;
    if (!this.#requests.has(key) && this.#requests.size >= MAX_ROUTES) {
      route = '/(overflow)';
      key = `${method}\u0000${route}\u0000${status}`;
    }
    this.#requests.set(key, (this.#requests.get(key) ?? 0) + 1);

    let durationRoute = route;
    if (!this.#durations.has(durationRoute) && this.#durations.size >= MAX_DURATION_ROUTES) {
      durationRoute = '/(overflow)';
    }
    let histogram = this.#durations.get(durationRoute);
    if (!histogram) {
      histogram = { buckets: new Array<number>(BUCKETS.length + 1).fill(0), sum: 0, count: 0 };
      this.#durations.set(durationRoute, histogram);
    }
    histogram.count++;
    histogram.sum += ms;
    const index = BUCKETS.findIndex((bucket) => ms <= bucket);
    const slot = index === -1 ? BUCKETS.length : index;
    histogram.buckets[slot] = (histogram.buckets[slot] ?? 0) + 1;

    if (path === '/api/auth/login' && status >= 400 && status < 500) {
      this.#loginFailures++;
    }
  }

  render(snapshot: MetricSnapshot): string {
    const lines: string[] = [];

    lines.push('# HELP node_pulse_http_requests_total HTTP requests by method, route and status.');
    lines.push('# TYPE node_pulse_http_requests_total counter');
    for (const [key, value] of this.#requests) {
      const [method, route, status] = key.split('\u0000');
      lines.push(
        `node_pulse_http_requests_total{method="${escapeLabel(method!)}",route="${escapeLabel(route!)}",status="${escapeLabel(status!)}"} ${value}`,
      );
    }

    lines.push('# HELP node_pulse_http_request_duration_ms HTTP request duration in milliseconds.');
    lines.push('# TYPE node_pulse_http_request_duration_ms histogram');
    for (const [route, histogram] of this.#durations) {
      const label = escapeLabel(route);
      let cumulative = 0;
      BUCKETS.forEach((bucket, index) => {
        cumulative += histogram.buckets[index] ?? 0;
        lines.push(
          `node_pulse_http_request_duration_ms_bucket{route="${label}",le="${bucket}"} ${cumulative}`,
        );
      });
      lines.push(
        `node_pulse_http_request_duration_ms_bucket{route="${label}",le="+Inf"} ${histogram.count}`,
      );
      lines.push(
        `node_pulse_http_request_duration_ms_sum{route="${label}"} ${histogram.sum.toFixed(1)}`,
      );
      lines.push(`node_pulse_http_request_duration_ms_count{route="${label}"} ${histogram.count}`);
    }

    lines.push('# TYPE node_pulse_sse_clients gauge');
    lines.push(`node_pulse_sse_clients ${snapshot.sseClients}`);
    lines.push('# TYPE node_pulse_ws_clients gauge');
    lines.push(`node_pulse_ws_clients ${snapshot.wsClients}`);
    lines.push('# TYPE node_pulse_projects_total gauge');
    lines.push(`node_pulse_projects_total ${snapshot.projects}`);
    lines.push('# TYPE node_pulse_users_total gauge');
    lines.push(`node_pulse_users_total ${snapshot.users}`);
    lines.push('# TYPE node_pulse_sessions_total gauge');
    lines.push(`node_pulse_sessions_total ${snapshot.sessions}`);
    lines.push('# TYPE node_pulse_login_failures_total counter');
    lines.push(`node_pulse_login_failures_total ${this.#loginFailures}`);
    lines.push('# TYPE node_pulse_slow_queries_total counter');
    lines.push(`node_pulse_slow_queries_total ${snapshot.slowQueries}`);

    return `${lines.join('\n')}\n`;
  }
}
