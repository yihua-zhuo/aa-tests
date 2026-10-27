import type { RuntimeInfo } from '../shared/types.ts';
import type { Store } from './store.ts';

export function runtimeInfo(store: Store): RuntimeInfo {
  return {
    node: process.version,
    sqlite: store.db.sqliteVersion(),
    pid: process.pid,
    uptime: Number(process.uptime().toFixed(1)),
  };
}
