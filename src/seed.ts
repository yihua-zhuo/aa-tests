import { randomBytes } from 'node:crypto';
import { addDays, dayKeyInTimeZone } from '../shared/ranges.ts';
import type { Role, User } from '../shared/types.ts';
import { hashPasswordSync, verifyPasswordSync } from './auth.ts';
import type { Database } from './db.ts';
import type { ProjectsStore } from './stores/projects.ts';
import type { UsersStore } from './stores/users.ts';
import { workspaceTimeZone } from './timezone.ts';

export const DEMO_PASSWORD = 'Demo1234!';

type DemoUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  timezone: string;
};

export const DEMO_USERS: readonly DemoUser[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'admin@pulse.demo',
    name: '林晓',
    role: 'admin',
    timezone: 'Asia/Shanghai',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'manager@pulse.demo',
    name: '陈墨',
    role: 'manager',
    timezone: 'Asia/Shanghai',
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    email: 'pm@pulse.demo',
    name: '周岚',
    role: 'pm',
    timezone: 'Asia/Shanghai',
  },
  {
    id: '44444444-4444-4444-8444-444444444444',
    email: 'viewer@pulse.demo',
    name: '顾言',
    role: 'viewer',
    timezone: 'Asia/Shanghai',
  },
];

export function isDemoEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  return DEMO_USERS.some((user) => user.email === normalized);
}

export function ensureBootstrapAdmin(
  users: UsersStore,
  input: { email: string; password: string; name?: string },
): User {
  const email = input.email.trim().toLowerCase();
  if (!email.includes('@')) throw new Error('ADMIN_EMAIL 不是有效的邮箱地址');
  if (input.password.length < 8) throw new Error('ADMIN_PASSWORD 至少需要 8 个字符');

  const existing = users.authByEmail(email);
  if (existing) {
    if (existing.role !== 'admin') {
      throw new Error('ADMIN_EMAIL 对应的账号不是管理员');
    }
    return existing;
  }

  const result = users.create({
    email,
    name: input.name?.trim() || '管理员',
    role: 'admin',
    passwordHash: hashPasswordSync(input.password),
  });
  if (!result.ok) throw new Error(`无法创建引导管理员 ${email}`);
  return result.user;
}

export function ensureDemoUsers(users: UsersStore): User {
  let passwordHash: string | null = null;
  let admin: User | null = null;

  for (const demo of DEMO_USERS) {
    const existing = users.authByEmail(demo.email);
    let user: User;
    if (existing) {
      user = existing;
    } else {
      passwordHash ??= hashPasswordSync(DEMO_PASSWORD);
      const result = users.create({
        id: demo.id,
        email: demo.email,
        name: demo.name,
        role: demo.role,
        passwordHash,
        timezone: demo.timezone,
        isDemo: true,
      });
      if (!result.ok) throw new Error(`failed to seed demo user ${demo.email}`);
      user = result.user;
    }
    if (demo.role === 'admin') admin = user;
  }

  if (!admin) throw new Error('demo admin account is missing');
  return admin;
}

/**
 * Demo credentials are published. When demo logins are disabled, replace any
 * still-known demo password so a later mode switch cannot revive old access.
 */
export function rotateDemoCredentials(users: UsersStore): void {
  for (const demo of DEMO_USERS) {
    const account = users.authByEmail(demo.email);
    if (!account) continue;
    if (!verifyPasswordSync(DEMO_PASSWORD, account.passwordHash)) continue;
    users.setPassword(account.id, hashPasswordSync(randomBytes(32).toString('base64url')));
  }
}

function hashString(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const CHANNEL_SHARES: readonly [string, number][] = [
  ['Organic Search', 0.38],
  ['Direct', 0.27],
  ['Social Media', 0.21],
  ['Email', 0.14],
];

const DAYS_OF_METRICS = 730;

export function seedAnalytics(db: Database, now: Date = new Date()): void {
  const existing = db.raw
    .prepare('SELECT COUNT(*) AS total, MAX(date) AS latest FROM daily_metrics')
    .get() as unknown as { total: number; latest: string | null };
  const today = dayKeyInTimeZone(now, workspaceTimeZone());
  if (existing.total >= DAYS_OF_METRICS && existing.latest === today) return;

  const start = addDays(today, -(DAYS_OF_METRICS - 1));

  db.transaction(() => {
    const insertDay = db.stmt(
      `INSERT OR IGNORE INTO daily_metrics
         (date, revenue_cents, customers, conversions, visitors)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertChannel = db.stmt(
      'INSERT OR IGNORE INTO channel_daily (date, channel, sessions) VALUES (?, ?, ?)',
    );

    for (let offset = 0; offset < DAYS_OF_METRICS; offset++) {
      const date = addDays(start, offset);
      const random = seededRandom(hashString(date));
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      const seasonal = weekday === 0 ? 0.64 : weekday === 6 ? 0.72 : weekday === 1 ? 1.06 : 1;
      const growth = Math.min(
        1.35,
        Math.max(
          0.18,
          (Date.parse(`${date}T00:00:00Z`) - Date.parse('2024-01-01T00:00:00Z')) /
            (86_400_000 * 720),
        ),
      );

      const revenueCents = Math.round((150_000 + growth * 95_000 + random() * 42_000) * seasonal);
      const customers = Math.round((22 + growth * 26 + random() * 12) * seasonal);
      const visitors = Math.round(customers / (0.031 + random() * 0.021));
      const conversions = Math.round(visitors * (0.031 + random() * 0.013));
      const realCustomers = Math.max(1, Math.round(conversions * (0.82 + random() * 0.22)));

      insertDay.run(date, revenueCents, realCustomers, conversions, visitors);

      let noiseTotal = 0;
      const noises = CHANNEL_SHARES.map(() => {
        const noise = random() * 0.08 - 0.04;
        noiseTotal += noise;
        return noise;
      });
      CHANNEL_SHARES.forEach(([channel, share], index) => {
        const adjusted = Math.max(
          0.02,
          share + (noises[index] ?? 0) - noiseTotal / CHANNEL_SHARES.length,
        );
        insertChannel.run(date, channel, Math.round(visitors * adjusted));
      });
    }
  });

  if (existing.total === 0) {
    db.raw.exec("INSERT INTO projects_fts(projects_fts) VALUES ('rebuild')");
  }
}

type DemoProject = {
  name: string;
  description: string;
  status: 'planning' | 'active' | 'on_hold' | 'completed' | 'archived';
  progress: number;
  owner: string;
  members: string[];
  dueOffset: number | null;
  createdDaysAgo: number;
};

const DEMO_PROJECTS: readonly DemoProject[] = [
  {
    name: '官网品牌重塑',
    description: '新版品牌视觉、组件库与营销页同步上线。',
    status: 'active',
    progress: 68,
    owner: 'admin@pulse.demo',
    members: ['manager@pulse.demo', 'viewer@pulse.demo'],
    dueOffset: 24,
    createdDaysAgo: 42,
  },
  {
    name: 'Q4 增长实验',
    description: '围绕激活漏斗的 A/B 实验与渠道预算重分配。',
    status: 'active',
    progress: 42,
    owner: 'manager@pulse.demo',
    members: ['pm@pulse.demo', 'viewer@pulse.demo'],
    dueOffset: 38,
    createdDaysAgo: 21,
  },
  {
    name: '客户数据中台',
    description: '统一客户事件模型，打通订阅与支持数据。',
    status: 'planning',
    progress: 12,
    owner: 'pm@pulse.demo',
    members: ['admin@pulse.demo'],
    dueOffset: 96,
    createdDaysAgo: 9,
  },
  {
    name: '订阅计费升级',
    description: '迁移到新的计费引擎，支持按席位与用量混合计费。',
    status: 'on_hold',
    progress: 55,
    owner: 'admin@pulse.demo',
    members: ['manager@pulse.demo'],
    dueOffset: 53,
    createdDaysAgo: 65,
  },
  {
    name: '移动端 2.0',
    description: '重构移动端信息架构，提升周活与留存。',
    status: 'active',
    progress: 81,
    owner: 'pm@pulse.demo',
    members: ['admin@pulse.demo', 'viewer@pulse.demo'],
    dueOffset: 11,
    createdDaysAgo: 78,
  },
  {
    name: '年度品牌视频',
    description: '客户故事与产品演示短片，用于官网与发布会。',
    status: 'completed',
    progress: 100,
    owner: 'manager@pulse.demo',
    members: ['viewer@pulse.demo'],
    dueOffset: -14,
    createdDaysAgo: 120,
  },
  {
    name: '帮助中心改版',
    description: '按使用场景重组知识库，并接入站内搜索。',
    status: 'planning',
    progress: 5,
    owner: 'viewer@pulse.demo',
    members: [],
    dueOffset: 74,
    createdDaysAgo: 4,
  },
  {
    name: '旧版营销页归档',
    description: '历史活动页面的归档与链接重定向。',
    status: 'archived',
    progress: 100,
    owner: 'admin@pulse.demo',
    members: ['manager@pulse.demo'],
    dueOffset: -60,
    createdDaysAgo: 200,
  },
];

export function seedDemoProjects(
  projects: ProjectsStore,
  users: UsersStore,
  now: Date = new Date(),
): void {
  if (projects.countDemo() > 0) return;

  const byEmail = new Map(
    DEMO_USERS.map((demo) => {
      const user = users.authByEmail(demo.email);
      return [demo.email, user] as const;
    }),
  );
  const today = dayKeyInTimeZone(now, workspaceTimeZone());

  for (const demo of DEMO_PROJECTS) {
    const owner = byEmail.get(demo.owner);
    if (!owner) continue;
    const createdAt = new Date(now.getTime() - demo.createdDaysAgo * 86_400_000).toISOString();
    projects.create(
      {
        name: demo.name,
        description: demo.description,
        status: demo.status,
        progress: demo.progress,
        ownerId: owner.id,
        dueDate: demo.dueOffset === null ? null : addDays(today, demo.dueOffset),
        memberIds: demo.members
          .map((email) => byEmail.get(email)?.id)
          .filter((id): id is string => Boolean(id)),
      },
      { id: owner.id, name: owner.name },
      { ownerName: owner.name, isDemo: true, createdAt },
    );
  }
}
