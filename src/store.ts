import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { backupLegacyDatabase, Database, migrateLegacyTasks } from './db.ts';
import { DomainActions } from './domain/actions.ts';
import { DomainService } from './domain/service.ts';
import {
  ensureBootstrapAdmin,
  ensureDemoUsers,
  rotateDemoCredentials,
  seedAnalytics,
  seedDemoProjects,
} from './seed.ts';
import { ActivitiesStore } from './stores/activities.ts';
import { AnalyticsStore } from './stores/analytics.ts';
import { AttachmentsStore } from './stores/attachments.ts';
import { AutomationStore } from './stores/automation.ts';
import { CommentsStore } from './stores/comments.ts';
import { GoalsStore } from './stores/goals.ts';
import { GovernanceStore } from './stores/governance.ts';
import { InsightsStore } from './stores/insights.ts';
import { KnowledgeStore } from './stores/knowledge.ts';
import { NotificationsStore } from './stores/notifications.ts';
import { OpsStore } from './stores/ops.ts';
import { PlanningStore } from './stores/planning.ts';
import { PortfolioStore } from './stores/portfolio.ts';
import { ProjectsStore } from './stores/projects.ts';
import { PushStore } from './stores/push.ts';
import { ReportsStore } from './stores/reports.ts';
import { AuditStore, LoginAttemptsStore, PreferencesStore } from './stores/settings.ts';
import { TasksStore } from './stores/tasks.ts';
import { PersonalAccessTokensStore } from './stores/tokens.ts';
import {
  MfaChallengesStore,
  PasswordResetsStore,
  SessionsStore,
  UsersStore,
} from './stores/users.ts';
import { WebhooksStore } from './stores/webhooks.ts';
import { WorkspaceStore } from './stores/workspace.ts';
import { WorkspacesStore } from './stores/workspaces.ts';
import { UploadStore } from './uploads.ts';

export type StoreOptions = {
  demo?: boolean;
  demoAccounts?: boolean;
  bootstrapAdmin?: { email: string; password: string; name?: string };
  now?: Date | (() => Date);
  uploadDir?: string;
};

export class Store {
  readonly db: Database;
  readonly users: UsersStore;
  readonly sessions: SessionsStore;
  readonly mfaChallenges: MfaChallengesStore;
  readonly passwordResets: PasswordResetsStore;
  readonly projects: ProjectsStore;
  readonly tasks: TasksStore;
  readonly attachments: AttachmentsStore;
  readonly uploads: UploadStore;
  readonly comments: CommentsStore;
  readonly notifications: NotificationsStore;
  readonly push: PushStore;
  readonly activities: ActivitiesStore;
  readonly workspace: WorkspaceStore;
  readonly workspaces: WorkspacesStore;
  readonly analytics: AnalyticsStore;
  readonly reports: ReportsStore;
  readonly preferences: PreferencesStore;
  readonly audit: AuditStore;
  readonly loginAttempts: LoginAttemptsStore;
  readonly tokens: PersonalAccessTokensStore;
  readonly webhooks: WebhooksStore;
  readonly ops: OpsStore;
  readonly goals: GoalsStore;
  readonly portfolio: PortfolioStore;
  readonly planning: PlanningStore;
  readonly automation: AutomationStore;
  readonly knowledge: KnowledgeStore;
  readonly insights: InsightsStore;
  readonly governance: GovernanceStore;
  readonly domain: DomainService;
  readonly actions: DomainActions;
  readonly demo: boolean;
  readonly demoAccounts: boolean;
  readonly now: () => Date;

  constructor(path = ':memory:', options: StoreOptions = {}) {
    this.demo = options.demo ?? !/^(0|false|off)$/i.test(process.env.DEMO_MODE ?? '');
    this.demoAccounts = options.demoAccounts ?? this.demo;
    const clock = options.now;
    this.now = typeof clock === 'function' ? clock : () => clock ?? new Date();
    const now = this.now();

    backupLegacyDatabase(path);
    this.db = new Database(path);
    const configuredUploads = options.uploadDir ?? process.env.UPLOAD_DIR?.trim();
    const uploadRoot =
      configuredUploads ||
      (path === ':memory:'
        ? mkdtempSync(join(tmpdir(), 'pulse-uploads-'))
        : join(dirname(path), 'uploads'));
    this.uploads = new UploadStore(uploadRoot);
    this.activities = new ActivitiesStore(this.db);
    this.users = new UsersStore(this.db);
    this.sessions = new SessionsStore(this.db);
    this.mfaChallenges = new MfaChallengesStore(this.db);
    this.passwordResets = new PasswordResetsStore(this.db);
    this.projects = new ProjectsStore(this.db, this.activities);
    this.tasks = new TasksStore(this.db, this.activities);
    this.attachments = new AttachmentsStore(this.db);
    this.notifications = new NotificationsStore(this.db);
    this.push = new PushStore(this.db);
    this.comments = new CommentsStore(this.db, this.activities, this.notifications);
    this.workspace = new WorkspaceStore(this.db);
    this.workspaces = new WorkspacesStore(this.db);
    this.analytics = new AnalyticsStore(this.db, this.workspace);
    this.reports = new ReportsStore(this.db, this.analytics);
    this.preferences = new PreferencesStore(this.db);
    this.audit = new AuditStore(this.db);
    this.loginAttempts = new LoginAttemptsStore(this.db);
    this.tokens = new PersonalAccessTokensStore(this.db);
    this.webhooks = new WebhooksStore(this.db, this.projects);
    this.ops = new OpsStore(this.db, { demoDataEnabled: this.demo });
    this.goals = new GoalsStore(this.db);
    this.portfolio = new PortfolioStore(this.db);
    this.planning = new PlanningStore(this.db, this.tasks);
    this.automation = new AutomationStore(this.db, this.tasks, this.comments, this.notifications);
    this.knowledge = new KnowledgeStore(this.db);
    this.insights = new InsightsStore(this.db);
    this.governance = new GovernanceStore(this.db, this.users);
    this.domain = new DomainService(this);
    this.actions = new DomainActions(this);

    let admin = this.demoAccounts ? ensureDemoUsers(this.users) : null;
    if (options.bootstrapAdmin) {
      admin = ensureBootstrapAdmin(this.users, options.bootstrapAdmin);
    }
    if (!this.demoAccounts) rotateDemoCredentials(this.users);
    if (!admin) {
      throw new Error('non-demo mode requires ADMIN_EMAIL/ADMIN_PASSWORD bootstrap credentials');
    }
    migrateLegacyTasks(this.db, admin);
    this.workspaces.backfill();
    if (this.demo) {
      seedAnalytics(this.db, now);
      seedDemoProjects(this.projects, this.users, now);
    }
    this.sessions.cleanup(now.toISOString());
    this.mfaChallenges.cleanup(now.toISOString());
    this.passwordResets.cleanup(now.toISOString());
  }

  stats(): { projects: number; users: number; sessions: number } {
    return {
      projects: this.projects.total(),
      users: this.users.count(),
      sessions: this.sessions.count(),
    };
  }

  close(): void {
    this.analytics.close();
    this.db.close();
  }
}

export function createStore(path = ':memory:', options: StoreOptions = {}): Store {
  return new Store(path, options);
}
