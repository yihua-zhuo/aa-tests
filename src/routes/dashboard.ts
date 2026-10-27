import { Hono } from 'hono';
import { resolveRange } from '../../shared/ranges.ts';
import { RangeQuerySchema } from '../../shared/schemas.ts';
import type { AppEnv } from '../app-env.ts';
import { noStore, readQuery, validationError } from '../http.ts';
import { currentUser } from '../middleware/auth.ts';
import { runtimeInfo } from '../runtime.ts';
import type { Store } from '../store.ts';
import { workspaceTimeZone } from '../timezone.ts';

export function dashboardRoutes(store: Store): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/dashboard/summary', (c) => {
    const parsed = readQuery(c, RangeQuerySchema);
    if (!parsed.ok) return parsed.response;

    const resolved = resolveRange(parsed.data, store.now(), workspaceTimeZone());
    if (!resolved.ok) return validationError(c, resolved.message);
    const range = resolved.range;
    const user = currentUser(c);

    const metrics = store.analytics.dashboard(range);
    const projects = store.projects.overview(user.role, user.id);
    const activities = store.activities.recent(user.role, user.id, 8);

    noStore(c);
    return c.json({
      range,
      demo: store.demo,
      kpis: metrics.kpis,
      revenue: metrics.revenue,
      channels: metrics.channels,
      projects,
      activities,
      runtime: runtimeInfo(store),
    });
  });

  return app;
}
