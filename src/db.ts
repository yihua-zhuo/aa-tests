import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { DEFAULT_RATES } from '../shared/currencies.ts';
import { PROJECT_STATUS_LABELS } from '../shared/permissions.ts';
import type { User } from '../shared/types.ts';
import { log } from './logger.ts';

export const SCHEMA_VERSION = 18;

export function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Rows kept per append-only table before the oldest ones are trimmed. */
export const MAX_ACTIVITIES = positiveIntEnv('ACTIVITY_RETENTION', 2000);

/**
 * Additive schema steps. Version 1 is `#createSchema`, version 2 is the
 * legacy task → project conversion (needs an admin user, so it lives in
 * `migrateLegacyTasks`). Every step must be idempotent so a partially
 * applied historical database can be repaired by restarting.
 */
export const MIGRATION_STEPS = [
  { version: 1, name: 'base schema' },
  { version: 2, name: 'legacy tasks to projects' },
  { version: 3, name: 'demo flag and login failures' },
  { version: 4, name: 'collaboration, MFA and integrations' },
  { version: 5, name: 'password reset tokens' },
  { version: 6, name: 'optimistic concurrency for preferences' },
  { version: 7, name: 'FTS indexes for activities and users' },
  { version: 8, name: 'tasks, subtasks and milestones' },
  { version: 9, name: 'comments, notifications and mail outbox' },
  { version: 10, name: 'workspace currency and saved reports' },
  { version: 11, name: 'attachments and avatars' },
  { version: 12, name: 'web push subscriptions' },
  { version: 13, name: 'workspaces, project visibility and custom roles' },
  { version: 14, name: 'ops settings and feature flags' },
  { version: 15, name: 'enterprise goals, planning, knowledge and governance' },
  { version: 16, name: 'enterprise operations, workflows and analytics' },
  { version: 17, name: 'enterprise collaboration and execution' },
  { version: 18, name: 'cross-project dependencies, routing and reminders' },
] as const;

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export class Database {
  readonly raw: DatabaseSync;
  readonly path: string;
  readonly slowQueryThresholdMs = positiveIntEnv('SLOW_QUERY_MS', 200);
  readonly #statements = new Map<string, StatementSync>();
  #slowQueries = 0;
  #txDepth = 0;

  constructor(path: string) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    backupBeforeMigration(path);
    this.raw = new DatabaseSync(path);
    this.raw.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      PRAGMA temp_store = MEMORY;
    `);
    const integrity = this.raw.prepare('PRAGMA quick_check').all() as unknown as {
      quick_check: string;
    }[];
    if (integrity.length > 0 && integrity.some((row) => row.quick_check !== 'ok')) {
      throw new Error(`database integrity check failed: ${integrity[0]?.quick_check}`);
    }
    this.#createSchema();
    this.#migrateColumns();
    this.#migrateSearchIndexes();
  }

  #migrateSearchIndexes(): void {
    if (this.userVersion >= 7) return;
    this.raw.exec(`
      INSERT INTO activities_fts(rowid, message, actor, project)
      SELECT seq,
             COALESCE(json_extract(payload, '$.message'), type),
             COALESCE(json_extract(payload, '$.actorName'), ''),
             COALESCE(json_extract(payload, '$.projectName'), '')
      FROM activities
      WHERE seq NOT IN (SELECT rowid FROM activities_fts);
      INSERT INTO users_fts(users_fts) VALUES ('rebuild');
    `);
    this.setUserVersion(7);
  }

  #createSchema(): void {
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS custom_roles (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        base_role TEXT NOT NULL CHECK (base_role IN ('admin', 'manager', 'pm', 'viewer')),
        permissions TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workspace_id, name)
      );
      CREATE INDEX IF NOT EXISTS custom_roles_workspace ON custom_roles (workspace_id, name);

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'pm', 'viewer')),
        workspace_id TEXT REFERENCES workspaces(id),
        custom_role_id TEXT,
        password_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        is_demo INTEGER NOT NULL DEFAULT 0,
        timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        mfa_secret TEXT,
        mfa_enabled INTEGER NOT NULL DEFAULT 0,
        mfa_recovery TEXT NOT NULL DEFAULT '[]',
        avatar_url TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        ip TEXT,
        user_agent TEXT
      );
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
      CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at);

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'planning'
          CHECK (status IN ('planning', 'active', 'on_hold', 'completed', 'archived')),
        progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
        owner_id TEXT NOT NULL REFERENCES users(id),
        workspace_id TEXT REFERENCES workspaces(id),
        visibility TEXT NOT NULL DEFAULT 'workspace'
          CHECK (visibility IN ('workspace', 'private')),
        start_date TEXT,
        due_date TEXT,
        is_demo INTEGER NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '',
        deleted_at TEXT,
        legacy_task_id TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS projects_status_updated ON projects (status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS projects_owner ON projects (owner_id);
      CREATE INDEX IF NOT EXISTS projects_updated ON projects (updated_at DESC);
      CREATE INDEX IF NOT EXISTS projects_due ON projects (due_date);

      CREATE TABLE IF NOT EXISTS project_members (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        added_at TEXT NOT NULL,
        PRIMARY KEY (project_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS project_members_user ON project_members (user_id);

      CREATE TABLE IF NOT EXISTS activities (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS activities_project_seq ON activities (project_id, seq DESC);
      CREATE INDEX IF NOT EXISTS activities_created ON activities (created_at DESC);

      CREATE TABLE IF NOT EXISTS daily_metrics (
        date TEXT PRIMARY KEY,
        revenue_cents INTEGER NOT NULL,
        customers INTEGER NOT NULL,
        conversions INTEGER NOT NULL,
        visitors INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channel_daily (
        date TEXT NOT NULL,
        channel TEXT NOT NULL,
        sessions INTEGER NOT NULL,
        PRIMARY KEY (date, channel)
      );

      CREATE TABLE IF NOT EXISTS workspace_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        currency TEXT NOT NULL DEFAULT 'USD',
        rates TEXT NOT NULL DEFAULT '{}',
        time_log_visibility TEXT NOT NULL DEFAULT 'all'
          CHECK (time_log_visibility IN ('all', 'managers', 'self')),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS saved_reports (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        query TEXT NOT NULL,
        frequency TEXT NOT NULL DEFAULT 'none',
        last_run_at TEXT,
        next_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS saved_reports_user ON saved_reports (user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS saved_reports_next ON saved_reports (next_run_at);

      CREATE TABLE IF NOT EXISTS user_preferences (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        default_range TEXT NOT NULL DEFAULT '30d',
        email_notifications INTEGER NOT NULL DEFAULT 1,
        weekly_digest INTEGER NOT NULL DEFAULT 0,
        sidebar_collapsed INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        target TEXT,
        ip TEXT,
        detail TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_created ON audit_log (created_at DESC);
      CREATE INDEX IF NOT EXISTS audit_action ON audit_log (action, seq DESC);
      CREATE INDEX IF NOT EXISTS audit_actor ON audit_log (actor_id, seq DESC);

      CREATE TABLE IF NOT EXISTS login_failures (
        key TEXT PRIMARY KEY,
        failures INTEGER NOT NULL,
        reset_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS login_failures_reset ON login_failures (reset_at);

      CREATE TABLE IF NOT EXISTS mfa_challenges (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_milestones (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        due_date TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS project_milestones_project
        ON project_milestones (project_id, due_date);

      CREATE TABLE IF NOT EXISTS project_tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        parent_id TEXT REFERENCES project_tasks(id) ON DELETE CASCADE,
        milestone_id TEXT REFERENCES project_milestones(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'todo'
          CHECK (status IN ('todo', 'in_progress', 'review', 'done')),
        priority TEXT NOT NULL DEFAULT 'medium'
          CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
        assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        due_date TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        completed_at TEXT,
        estimate_points REAL,
        estimate_hours REAL,
        estimate_size TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS project_tasks_project ON project_tasks (project_id, sort_order);
      CREATE INDEX IF NOT EXISTS project_tasks_assignee ON project_tasks (assignee_id, status);
      CREATE INDEX IF NOT EXISTS project_tasks_due ON project_tasks (due_date);

      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES project_tasks(id) ON DELETE CASCADE,
        author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS comments_project ON comments (project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS comments_task ON comments (task_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS comment_mentions (
        comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (comment_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES project_tasks(id) ON DELETE CASCADE,
        comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        link TEXT,
        read_at TEXT,
        pushed_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS notifications_user ON notifications (user_id, read_at, created_at DESC);
      CREATE INDEX IF NOT EXISTS notifications_created ON notifications (created_at DESC);

      CREATE TABLE IF NOT EXISTS push_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        public_key TEXT NOT NULL,
        private_key TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        user_agent TEXT,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions (user_id);

      CREATE TABLE IF NOT EXISTS mail_outbox (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        recipient TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        dedupe_key TEXT UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'sent', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        sent_at TEXT
      );
      CREATE INDEX IF NOT EXISTS mail_outbox_pending
        ON mail_outbox (status, next_attempt_at);

      CREATE TABLE IF NOT EXISTS project_favorites (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, project_id)
      );

      CREATE TABLE IF NOT EXISTS saved_views (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        query TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS saved_views_user ON saved_views (user_id, name);

      CREATE TABLE IF NOT EXISTS personal_access_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL DEFAULT '[]',
        expires_at TEXT,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS pat_user ON personal_access_tokens (user_id);

      CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        secret TEXT NOT NULL,
        events TEXT NOT NULL DEFAULT '[]',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id TEXT PRIMARY KEY,
        webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
        event TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        response_status INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS webhook_deliveries_pending ON webhook_deliveries (status, next_attempt_at);

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES project_tasks(id) ON DELETE CASCADE,
        uploader_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        stored_name TEXT NOT NULL,
        sha256 TEXT,
        scan TEXT NOT NULL DEFAULT 'clean',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS attachments_project ON attachments (project_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS feature_flags (
        key TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS goal_nodes (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        parent_id TEXT REFERENCES goal_nodes(id) ON DELETE SET NULL,
        level TEXT NOT NULL DEFAULT 'workspace'
          CHECK (level IN ('company', 'department', 'workspace', 'project')),
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        weight REAL NOT NULL DEFAULT 1 CHECK (weight > 0 AND weight <= 100),
        period TEXT NOT NULL DEFAULT '',
        baseline REAL,
        target REAL,
        actual REAL,
        unit TEXT NOT NULL DEFAULT '',
        update_mode TEXT NOT NULL DEFAULT 'manual'
          CHECK (update_mode IN ('manual', 'linked')),
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'locked', 'archived')),
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS goal_nodes_workspace ON goal_nodes (workspace_id, parent_id);
      CREATE INDEX IF NOT EXISTS goal_nodes_project ON goal_nodes (project_id);

      CREATE TABLE IF NOT EXISTS goal_key_results (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES goal_nodes(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        unit TEXT NOT NULL DEFAULT '',
        baseline REAL,
        target REAL,
        actual REAL,
        weight REAL NOT NULL DEFAULT 1 CHECK (weight > 0 AND weight <= 100),
        update_mode TEXT NOT NULL DEFAULT 'manual'
          CHECK (update_mode IN ('manual', 'linked')),
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS goal_key_results_goal ON goal_key_results (goal_id);

      CREATE TABLE IF NOT EXISTS goal_links (
        id TEXT PRIMARY KEY,
        link_key TEXT NOT NULL UNIQUE,
        goal_id TEXT NOT NULL REFERENCES goal_nodes(id) ON DELETE CASCADE,
        key_result_id TEXT REFERENCES goal_key_results(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES project_tasks(id) ON DELETE SET NULL,
        milestone_id TEXT REFERENCES project_milestones(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS goal_links_goal ON goal_links (goal_id);
      CREATE INDEX IF NOT EXISTS goal_links_project ON goal_links (project_id);

      CREATE TABLE IF NOT EXISTS goal_change_logs (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES goal_nodes(id) ON DELETE CASCADE,
        actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        reason TEXT NOT NULL DEFAULT '',
        before_json TEXT NOT NULL DEFAULT '{}',
        after_json TEXT NOT NULL DEFAULT '{}',
        impact_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS goal_change_logs_goal ON goal_change_logs (goal_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS portfolio_factor_configs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        weights_json TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        active INTEGER NOT NULL DEFAULT 1,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workspace_id, name)
      );
      CREATE INDEX IF NOT EXISTS portfolio_configs_workspace
        ON portfolio_factor_configs (workspace_id, active);

      CREATE TABLE IF NOT EXISTS portfolio_scores (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        config_id TEXT NOT NULL REFERENCES portfolio_factor_configs(id) ON DELETE CASCADE,
        factors_json TEXT NOT NULL DEFAULT '{}',
        missing_json TEXT NOT NULL DEFAULT '[]',
        score REAL,
        override_score REAL,
        override_reason TEXT,
        scored_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        scored_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        UNIQUE (project_id, config_id)
      );
      CREATE INDEX IF NOT EXISTS portfolio_scores_config ON portfolio_scores (config_id, score DESC);

      CREATE TABLE IF NOT EXISTS task_dependencies (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        predecessor_id TEXT NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
        successor_id TEXT NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
        type TEXT NOT NULL DEFAULT 'FS'
          CHECK (type IN ('FS', 'SS', 'FF', 'SF')),
        lag_days INTEGER NOT NULL DEFAULT 0 CHECK (lag_days >= 0 AND lag_days <= 365),
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        UNIQUE (predecessor_id, successor_id)
      );
      CREATE INDEX IF NOT EXISTS task_dependencies_project ON task_dependencies (project_id);
      CREATE INDEX IF NOT EXISTS task_dependencies_pred ON task_dependencies (predecessor_id);
      CREATE INDEX IF NOT EXISTS task_dependencies_succ ON task_dependencies (successor_id);

      CREATE TABLE IF NOT EXISTS task_time_logs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        user_name TEXT NOT NULL,
        minutes INTEGER NOT NULL CHECK (minutes > 0 AND minutes <= 1440),
        work_date TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        idempotency_key TEXT UNIQUE,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_time_logs_task ON task_time_logs (task_id, work_date DESC);
      CREATE INDEX IF NOT EXISTS task_time_logs_user ON task_time_logs (user_id, work_date DESC);

      CREATE TABLE IF NOT EXISTS task_blockers (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
        reason TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'other'
          CHECK (category IN ('external', 'decision', 'environment', 'data', 'dependency', 'other')),
        owner_team TEXT NOT NULL DEFAULT '',
        expected_resolve_at TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
        resolved_at TEXT,
        resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        evidence TEXT NOT NULL DEFAULT '',
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_blockers_task ON task_blockers (task_id, status);
      CREATE INDEX IF NOT EXISTS task_blockers_status ON task_blockers (status, created_at DESC);

      CREATE TABLE IF NOT EXISTS recurrence_rules (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'todo'
          CHECK (status IN ('todo', 'in_progress', 'review', 'done')),
        priority TEXT NOT NULL DEFAULT 'medium'
          CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
        assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        rule TEXT NOT NULL,
        timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        starts_on TEXT NOT NULL,
        ends_on TEXT,
        count INTEGER,
        exceptions_json TEXT NOT NULL DEFAULT '[]',
        holidays_json TEXT NOT NULL DEFAULT '[]',
        last_generated_on TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS recurrence_rules_project ON recurrence_rules (project_id, active);

      CREATE TABLE IF NOT EXISTS recurrence_instances (
        id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL REFERENCES recurrence_rules(id) ON DELETE CASCADE,
        occurrence_key TEXT NOT NULL UNIQUE,
        occurrence_date TEXT NOT NULL,
        task_id TEXT REFERENCES project_tasks(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS recurrence_instances_rule
        ON recurrence_instances (rule_id, occurrence_date DESC);

      CREATE TABLE IF NOT EXISTS automation_rules (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        trigger_event TEXT NOT NULL,
        conditions_json TEXT NOT NULL DEFAULT '[]',
        actions_json TEXT NOT NULL DEFAULT '[]',
        active INTEGER NOT NULL DEFAULT 1,
        max_runs_per_hour INTEGER NOT NULL DEFAULT 60,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS automation_rules_workspace
        ON automation_rules (workspace_id, active, trigger_event);

      CREATE TABLE IF NOT EXISTS automation_runs (
        id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
        event_key TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'live' CHECK (mode IN ('live', 'dry_run', 'replay')),
        trigger_event TEXT NOT NULL,
        input_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'skipped', 'failed')),
        output_json TEXT NOT NULL DEFAULT '{}',
        error TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        replay_of TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (rule_id, event_key, mode)
      );
      CREATE INDEX IF NOT EXISTS automation_runs_rule ON automation_runs (rule_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS automation_runs_status ON automation_runs (status, created_at DESC);

      CREATE TABLE IF NOT EXISTS project_documents (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        workspace_id TEXT REFERENCES workspaces(id),
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        format TEXT NOT NULL DEFAULT 'markdown' CHECK (format IN ('markdown', 'text')),
        status TEXT NOT NULL DEFAULT 'draft'
          CHECK (status IN ('draft', 'review', 'published', 'expired', 'archived')),
        owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        confidentiality TEXT NOT NULL DEFAULT 'internal'
          CHECK (confidentiality IN ('internal', 'restricted', 'confidential')),
        review_due_at TEXT,
        review_cycle_days INTEGER,
        version INTEGER NOT NULL DEFAULT 1,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS project_documents_project
        ON project_documents (project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS project_documents_review
        ON project_documents (status, review_due_at);

      CREATE TABLE IF NOT EXISTS document_versions (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES project_documents(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        change_summary TEXT NOT NULL DEFAULT '',
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        UNIQUE (document_id, version)
      );
      CREATE INDEX IF NOT EXISTS document_versions_doc
        ON document_versions (document_id, version DESC);

      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'proposed'
          CHECK (status IN ('proposed', 'approved', 'rejected', 'superseded')),
        context TEXT NOT NULL DEFAULT '',
        options_json TEXT NOT NULL DEFAULT '[]',
        decision TEXT NOT NULL DEFAULT '',
        consequences TEXT NOT NULL DEFAULT '',
        decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        review_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS decisions_workspace ON decisions (workspace_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS decisions_project ON decisions (project_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS decision_versions (
        id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        change_summary TEXT NOT NULL DEFAULT '',
        changed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        UNIQUE (decision_id, version)
      );
      CREATE INDEX IF NOT EXISTS decision_versions_decision
        ON decision_versions (decision_id, version DESC);

      CREATE TABLE IF NOT EXISTS metric_definitions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        unit TEXT NOT NULL DEFAULT '',
        formula TEXT NOT NULL,
        dimensions_json TEXT NOT NULL DEFAULT '[]',
        aggregation TEXT NOT NULL DEFAULT 'sum',
        source TEXT NOT NULL DEFAULT 'daily_metrics',
        owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
        version INTEGER NOT NULL DEFAULT 1,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workspace_id, name)
      );
      CREATE INDEX IF NOT EXISTS metric_definitions_workspace ON metric_definitions (workspace_id, status);

      CREATE TABLE IF NOT EXISTS metric_versions (
        id TEXT PRIMARY KEY,
        metric_id TEXT NOT NULL REFERENCES metric_definitions(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        definition_json TEXT NOT NULL,
        change_summary TEXT NOT NULL DEFAULT '',
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        UNIQUE (metric_id, version)
      );
      CREATE INDEX IF NOT EXISTS metric_versions_metric ON metric_versions (metric_id, version DESC);

      CREATE TABLE IF NOT EXISTS project_budgets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
        cost_center TEXT NOT NULL DEFAULT '',
        currency TEXT NOT NULL DEFAULT 'USD',
        budget_cents INTEGER NOT NULL DEFAULT 0 CHECK (budget_cents >= 0),
        committed_cents INTEGER NOT NULL DEFAULT 0,
        actual_cents INTEGER NOT NULL DEFAULT 0,
        forecast_cents INTEGER NOT NULL DEFAULT 0,
        fx_rate REAL NOT NULL DEFAULT 1 CHECK (fx_rate > 0),
        fx_date TEXT,
        threshold_pct INTEGER NOT NULL DEFAULT 80 CHECK (threshold_pct > 0 AND threshold_pct <= 100),
        version INTEGER NOT NULL DEFAULT 1,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS budget_entries (
        id TEXT PRIMARY KEY,
        budget_id TEXT NOT NULL REFERENCES project_budgets(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('committed', 'actual', 'forecast')),
        amount_cents INTEGER NOT NULL,
        currency TEXT NOT NULL,
        fx_rate REAL NOT NULL DEFAULT 1 CHECK (fx_rate > 0),
        fx_date TEXT,
        note TEXT NOT NULL DEFAULT '',
        idempotency_key TEXT UNIQUE,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS budget_entries_budget ON budget_entries (budget_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS jit_grants (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        resource_type TEXT NOT NULL
          CHECK (resource_type IN ('workspace', 'project', 'task')),
        resource_id TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL DEFAULT '',
        permissions_json TEXT NOT NULL DEFAULT '[]',
        reason TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'active', 'rejected', 'revoked', 'expired')),
        requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        starts_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jit_grants_user
        ON jit_grants (user_id, status, expires_at);
      CREATE INDEX IF NOT EXISTS jit_grants_workspace
        ON jit_grants (workspace_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS stage_gates (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        phase TEXT NOT NULL DEFAULT 'custom',
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'approved', 'rejected', 'waived')),
        required_materials_json TEXT NOT NULL DEFAULT '[]',
        checklist_json TEXT NOT NULL DEFAULT '[]',
        approver_ids_json TEXT NOT NULL DEFAULT '[]',
        sla_hours INTEGER NOT NULL DEFAULT 24 CHECK (sla_hours > 0 AND sla_hours <= 8760),
        due_at TEXT,
        decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        decided_at TEXT,
        decision_note TEXT NOT NULL DEFAULT '',
        fallback TEXT NOT NULL DEFAULT 'hold',
        version INTEGER NOT NULL DEFAULT 1,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS stage_gates_project ON stage_gates (project_id, created_at);
      CREATE INDEX IF NOT EXISTS stage_gates_due ON stage_gates (status, due_at);

      CREATE TABLE IF NOT EXISTS stage_gate_events (
        id TEXT PRIMARY KEY,
        gate_id TEXT NOT NULL REFERENCES stage_gates(id) ON DELETE CASCADE,
        actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        before_json TEXT NOT NULL DEFAULT '{}',
        after_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS stage_gate_events_gate ON stage_gate_events (gate_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS project_health_snapshots (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        score REAL NOT NULL CHECK (score >= 0 AND score <= 100),
        confidence REAL NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
        factors_json TEXT NOT NULL DEFAULT '{}',
        missing_json TEXT NOT NULL DEFAULT '[]',
        predicted_completion TEXT,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS project_health_project
        ON project_health_snapshots (project_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS project_baselines (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        version_no INTEGER NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'active', 'superseded', 'rejected')),
        approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        approved_at TEXT,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        UNIQUE (project_id, version_no)
      );
      CREATE INDEX IF NOT EXISTS project_baselines_project
        ON project_baselines (project_id, version_no DESC);

      CREATE TABLE IF NOT EXISTS change_requests (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'scope'
          CHECK (kind IN ('scope', 'schedule', 'budget', 'resource', 'other')),
        reason TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft'
          CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'implemented')),
        impact_json TEXT NOT NULL DEFAULT '{}',
        proposed_json TEXT NOT NULL DEFAULT '{}',
        task_ids_json TEXT NOT NULL DEFAULT '[]',
        decision_note TEXT NOT NULL DEFAULT '',
        requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        decided_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS change_requests_project
        ON change_requests (project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS change_requests_status ON change_requests (status, created_at DESC);

      CREATE TABLE IF NOT EXISTS capacity_profiles (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        weekly_hours REAL NOT NULL DEFAULT 40 CHECK (weekly_hours >= 0 AND weekly_hours <= 168),
        fte REAL NOT NULL DEFAULT 1 CHECK (fte >= 0 AND fte <= 1.5),
        skills_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS capacity_allocations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT '',
        weekly_hours REAL NOT NULL CHECK (weekly_hours >= 0 AND weekly_hours <= 168),
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'allocation' CHECK (kind IN ('allocation', 'leave')),
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS capacity_allocations_user
        ON capacity_allocations (user_id, start_date, end_date);
      CREATE INDEX IF NOT EXISTS capacity_allocations_project
        ON capacity_allocations (project_id, start_date, end_date);

      CREATE TABLE IF NOT EXISTS project_closures (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'closed', 'reopened')),
        acceptance_json TEXT NOT NULL DEFAULT '[]',
        actual_cost_cents INTEGER NOT NULL DEFAULT 0,
        deliverables_json TEXT NOT NULL DEFAULT '[]',
        open_items_json TEXT NOT NULL DEFAULT '[]',
        feedback TEXT NOT NULL DEFAULT '',
        benefit_plan_json TEXT NOT NULL DEFAULT '[]',
        closed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        closed_at TEXT,
        reopened_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        reopen_reason TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS benefit_reviews (
        id TEXT PRIMARY KEY,
        closure_id TEXT NOT NULL REFERENCES project_closures(id) ON DELETE CASCADE,
        due_on TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
        actual_json TEXT NOT NULL DEFAULT '{}',
        recorded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        recorded_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        UNIQUE (closure_id, due_on)
      );

      CREATE TABLE IF NOT EXISTS task_sla_policies (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        task_type TEXT NOT NULL DEFAULT 'any',
        priority TEXT NOT NULL DEFAULT 'any',
        customer_tier TEXT NOT NULL DEFAULT 'any',
        response_minutes INTEGER NOT NULL DEFAULT 60 CHECK (response_minutes > 0),
        resolve_minutes INTEGER NOT NULL DEFAULT 480 CHECK (resolve_minutes > 0),
        review_minutes INTEGER NOT NULL DEFAULT 120 CHECK (review_minutes > 0),
        business_hours_json TEXT NOT NULL DEFAULT '[]',
        holidays_json TEXT NOT NULL DEFAULT '[]',
        escalation_json TEXT NOT NULL DEFAULT '[]',
        active INTEGER NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 1,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_sla_instances (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE REFERENCES project_tasks(id) ON DELETE CASCADE,
        policy_id TEXT NOT NULL REFERENCES task_sla_policies(id) ON DELETE CASCADE,
        state TEXT NOT NULL DEFAULT 'running'
          CHECK (state IN ('running', 'paused', 'met', 'breached')),
        response_due_at TEXT,
        resolve_due_at TEXT NOT NULL,
        response_at TEXT,
        review_due_at TEXT,
        reviewed_at TEXT,
        pause_reason TEXT,
        resolved_at TEXT,
        paused_at TEXT,
        paused_minutes INTEGER NOT NULL DEFAULT 0,
        escalated_level INTEGER NOT NULL DEFAULT 0,
        escalated_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_sla_state ON task_sla_instances (state, resolve_due_at);

      CREATE TABLE IF NOT EXISTS task_forms (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        fields_json TEXT NOT NULL DEFAULT '[]',
        active INTEGER NOT NULL DEFAULT 1,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_form_values (
        task_id TEXT NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
        form_id TEXT NOT NULL REFERENCES task_forms(id) ON DELETE CASCADE,
        values_json TEXT NOT NULL DEFAULT '{}',
        form_version INTEGER NOT NULL DEFAULT 1,
        completed_at TEXT,
        completed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        signature_name TEXT NOT NULL DEFAULT '',
        signature_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (task_id, form_id)
      );
      CREATE TABLE IF NOT EXISTS task_form_versions (
        id TEXT PRIMARY KEY,
        form_id TEXT NOT NULL REFERENCES task_forms(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        fields_json TEXT NOT NULL DEFAULT '[]',
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        UNIQUE (form_id, version)
      );

      CREATE TABLE IF NOT EXISTS task_checklist_items (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
        form_id TEXT REFERENCES task_forms(id) ON DELETE SET NULL,
        label TEXT NOT NULL,
        required INTEGER NOT NULL DEFAULT 0,
        done INTEGER NOT NULL DEFAULT 0,
        done_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        done_at TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_checklist_task ON task_checklist_items (task_id, sort_order);

      CREATE TABLE IF NOT EXISTS dispatch_rules (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        strategy TEXT NOT NULL DEFAULT 'balanced'
          CHECK (strategy IN ('balanced', 'skills', 'load', 'timezone', 'round_robin')),
        skills_json TEXT NOT NULL DEFAULT '[]',
        max_load_hours REAL NOT NULL DEFAULT 40 CHECK (max_load_hours > 0),
        active INTEGER NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 1,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dispatch_recommendations (
        id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL REFERENCES dispatch_rules(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
        candidate_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        score REAL NOT NULL,
        reasons_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'recommended'
          CHECK (status IN ('recommended', 'accepted', 'rejected')),
        decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        decided_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (rule_id, task_id, candidate_id)
      );
      CREATE INDEX IF NOT EXISTS dispatch_recommendations_task
        ON dispatch_recommendations (task_id, status);

      CREATE TABLE IF NOT EXISTS task_handoffs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
        from_user TEXT REFERENCES users(id) ON DELETE SET NULL,
        to_user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'cancelled')),
        summary_json TEXT NOT NULL DEFAULT '{}',
        note TEXT NOT NULL DEFAULT '',
        due_at TEXT,
        accepted_at TEXT,
        declined_reason TEXT NOT NULL DEFAULT '',
        escalated_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_handoffs_task ON task_handoffs (task_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS task_handoffs_to ON task_handoffs (to_user, status);

      CREATE TABLE IF NOT EXISTS task_deliverables (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        required INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'submitted', 'approved', 'rejected')),
        current_version INTEGER NOT NULL DEFAULT 0,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS task_deliverables_task ON task_deliverables (task_id);

      CREATE TABLE IF NOT EXISTS deliverable_versions (
        id TEXT PRIMARY KEY,
        deliverable_id TEXT NOT NULL REFERENCES task_deliverables(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        filename TEXT NOT NULL,
        checksum TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'submitted'
          CHECK (status IN ('submitted', 'approved', 'rejected')),
        review_note TEXT NOT NULL DEFAULT '',
        uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        reviewed_at TEXT,
        UNIQUE (deliverable_id, version)
      );

      CREATE TABLE IF NOT EXISTS task_blocker_events (
        id TEXT PRIMARY KEY,
        blocker_id TEXT NOT NULL REFERENCES task_blockers(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}',
        actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_blocker_events_blocker
        ON task_blocker_events (blocker_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS document_comments (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES project_documents(id) ON DELETE CASCADE,
        author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        anchor_json TEXT NOT NULL DEFAULT '{}',
        body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
        suggestion_json TEXT NOT NULL DEFAULT '{}',
        assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        resolved_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS document_comments_doc
        ON document_comments (document_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS knowledge_links (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        from_type TEXT NOT NULL,
        from_id TEXT NOT NULL,
        to_type TEXT NOT NULL,
        to_id TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        UNIQUE (from_type, from_id, to_type, to_id)
      );
      CREATE INDEX IF NOT EXISTS knowledge_links_from ON knowledge_links (from_type, from_id);
      CREATE INDEX IF NOT EXISTS knowledge_links_to ON knowledge_links (to_type, to_id);

      CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        series_rule TEXT NOT NULL DEFAULT '',
        timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        starts_at TEXT NOT NULL,
        ends_at TEXT,
        agenda_json TEXT NOT NULL DEFAULT '[]',
        minutes TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'scheduled'
          CHECK (status IN ('scheduled', 'completed', 'cancelled')),
        version INTEGER NOT NULL DEFAULT 1,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS meetings_project ON meetings (project_id, starts_at DESC);

      CREATE TABLE IF NOT EXISTS meeting_attendees (
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'invited'
          CHECK (status IN ('invited', 'accepted', 'declined')),
        PRIMARY KEY (meeting_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS meeting_actions (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        due_on TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
        task_id TEXT REFERENCES project_tasks(id) ON DELETE SET NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS meeting_actions_meeting ON meeting_actions (meeting_id);

      CREATE TABLE IF NOT EXISTS discussion_channels (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        topic TEXT NOT NULL DEFAULT '',
        read_only INTEGER NOT NULL DEFAULT 0,
        member_ids_json TEXT NOT NULL DEFAULT '[]',
        version INTEGER NOT NULL DEFAULT 1,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS discussion_channels_project ON discussion_channels (project_id);

      CREATE TABLE IF NOT EXISTS channel_messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES discussion_channels(id) ON DELETE CASCADE,
        author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        body TEXT NOT NULL,
        parent_id TEXT REFERENCES channel_messages(id) ON DELETE CASCADE,
        pinned INTEGER NOT NULL DEFAULT 0,
        edited_at TEXT,
        deleted_at TEXT,
        task_id TEXT REFERENCES project_tasks(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS channel_messages_channel
        ON channel_messages (channel_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS channel_subscriptions (
        channel_id TEXT NOT NULL REFERENCES discussion_channels(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (channel_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS customer_portals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS portal_accounts (
        id TEXT PRIMARY KEY,
        portal_id TEXT NOT NULL REFERENCES customer_portals(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
        created_at TEXT NOT NULL,
        UNIQUE (portal_id, email)
      );

      CREATE TABLE IF NOT EXISTS portal_requests (
        id TEXT PRIMARY KEY,
        portal_id TEXT NOT NULL REFERENCES customer_portals(id) ON DELETE CASCADE,
        account_id TEXT REFERENCES portal_accounts(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'submitted'
          CHECK (status IN ('submitted', 'triaged', 'in_progress', 'delivered', 'closed')),
        progress_note TEXT NOT NULL DEFAULT '',
        attachments_json TEXT NOT NULL DEFAULT '[]',
        internal_ref TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS portal_requests_portal
        ON portal_requests (portal_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS retrospectives (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
        factors_json TEXT NOT NULL DEFAULT '{}',
        lessons_json TEXT NOT NULL DEFAULT '[]',
        improvements_json TEXT NOT NULL DEFAULT '[]',
        anonymous INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS retrospectives_project ON retrospectives (project_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS playbooks (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        source_retro_id TEXT REFERENCES retrospectives(id) ON DELETE SET NULL,
        scope TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        feedback_json TEXT NOT NULL DEFAULT '[]',
        version INTEGER NOT NULL DEFAULT 1,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft'
          CHECK (status IN ('draft', 'published', 'archived')),
        definition_json TEXT NOT NULL DEFAULT '{}',
        sandbox_limits_json TEXT NOT NULL DEFAULT '{}',
        version INTEGER NOT NULL DEFAULT 1,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS workflows_workspace ON workflows (workspace_id, status);

      CREATE TABLE IF NOT EXISTS workflow_versions (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        definition_json TEXT NOT NULL,
        change_summary TEXT NOT NULL DEFAULT '',
        published_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        UNIQUE (workflow_id, version)
      );

      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        workflow_version INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'running'
          CHECK (status IN ('running', 'waiting', 'completed', 'failed', 'cancelled')),
        mode TEXT NOT NULL DEFAULT 'live' CHECK (mode IN ('live', 'test', 'replay')),
        input_json TEXT NOT NULL DEFAULT '{}',
        state_json TEXT NOT NULL DEFAULT '{}',
        current_node TEXT,
        error TEXT,
        idempotency_key TEXT UNIQUE,
        started_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS workflow_runs_workflow
        ON workflow_runs (workflow_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS workflow_run_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        status TEXT NOT NULL,
        output_json TEXT NOT NULL DEFAULT '{}',
        error TEXT,
        attempt INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS approval_requests (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'general',
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
        amount_cents INTEGER NOT NULL DEFAULT 0,
        risk TEXT NOT NULL DEFAULT 'low' CHECK (risk IN ('low', 'medium', 'high')),
        steps_json TEXT NOT NULL DEFAULT '[]',
        current_step INTEGER NOT NULL DEFAULT 0,
        resource_type TEXT NOT NULL DEFAULT '',
        resource_id TEXT NOT NULL DEFAULT '',
        requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        due_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS approval_requests_workspace
        ON approval_requests (workspace_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS approval_decisions (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
        step INTEGER NOT NULL,
        approver_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        delegate_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL
          CHECK (action IN ('approve', 'reject', 'delegate', 'withdraw', 'escalate')),
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS approval_decisions_request
        ON approval_decisions (request_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS delegations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        delegator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        delegate_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT '',
        avoid_self INTEGER NOT NULL DEFAULT 1,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS delegations_delegate ON delegations (delegate_id, active);

      CREATE TABLE IF NOT EXISTS workflow_triggers (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        workflow_id TEXT REFERENCES workflows(id) ON DELETE CASCADE,
        rule_id TEXT REFERENCES automation_rules(id) ON DELETE CASCADE,
        name TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL
          CHECK (type IN ('schedule', 'cron', 'event', 'threshold', 'condition')),
        config_json TEXT NOT NULL DEFAULT '{}',
        timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        quiet_hours_json TEXT NOT NULL DEFAULT '[]',
        dedupe_window_seconds INTEGER NOT NULL DEFAULT 60,
        max_per_hour INTEGER NOT NULL DEFAULT 20,
        active INTEGER NOT NULL DEFAULT 1,
        last_fired_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS workflow_triggers_active
        ON workflow_triggers (active, type);

      CREATE TABLE IF NOT EXISTS connectors (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL
          CHECK (kind IN ('oauth', 'api_key', 'webhook', 'service_account')),
        scopes_json TEXT NOT NULL DEFAULT '[]',
        rate_limit INTEGER NOT NULL DEFAULT 60 CHECK (rate_limit > 0),
        health TEXT NOT NULL DEFAULT 'ok' CHECK (health IN ('ok', 'degraded', 'down')),
        secret_ref TEXT NOT NULL DEFAULT '',
        allowed_domains_json TEXT NOT NULL DEFAULT '[]',
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        auth_url TEXT NOT NULL DEFAULT '',
        token_url TEXT NOT NULL DEFAULT '',
        client_id TEXT NOT NULL DEFAULT '',
        client_secret_ref TEXT NOT NULL DEFAULT '',
        redirect_uri TEXT NOT NULL DEFAULT '',
        token_expires_at TEXT,
        last_call_at TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 1,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS connector_calls (
        id TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        method TEXT NOT NULL,
        url TEXT NOT NULL,
        status INTEGER,
        ok INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS connector_calls_recent
        ON connector_calls (connector_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS sandbox_checkpoints (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        state_json TEXT NOT NULL DEFAULT '{}',
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sandbox_checkpoints_recent
        ON sandbox_checkpoints (workspace_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS connector_oauth_states (
        state TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        code_verifier TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS domain_events (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        payload_json TEXT NOT NULL DEFAULT '{}',
        dedupe_key TEXT NOT NULL UNIQUE,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS domain_events_workspace
        ON domain_events (workspace_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS event_subscriptions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        filter_json TEXT NOT NULL DEFAULT '{}',
        endpoint TEXT NOT NULL DEFAULT '',
        secret TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS event_subscriptions_workspace
        ON event_subscriptions (workspace_id, event_type, active);

      CREATE TABLE IF NOT EXISTS event_deliveries (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES domain_events(id) ON DELETE CASCADE,
        subscription_id TEXT NOT NULL REFERENCES event_subscriptions(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'delivered', 'failed', 'dead')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT,
        delivered_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (event_id, subscription_id)
      );
      CREATE INDEX IF NOT EXISTS event_deliveries_pending
        ON event_deliveries (status, next_attempt_at);

      CREATE TABLE IF NOT EXISTS background_jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
        payload_json TEXT NOT NULL DEFAULT '{}',
        result_json TEXT NOT NULL DEFAULT '{}',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        next_attempt_at TEXT,
        locked_at TEXT,
        error TEXT,
        idempotency_key TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS background_jobs_due ON background_jobs (status, next_attempt_at);

      CREATE TABLE IF NOT EXISTS metric_anomalies (
        id TEXT PRIMARY KEY,
        metric_id TEXT NOT NULL REFERENCES metric_definitions(id) ON DELETE CASCADE,
        period TEXT NOT NULL,
        value REAL NOT NULL,
        baseline REAL NOT NULL,
        deviation REAL NOT NULL,
        severity TEXT NOT NULL DEFAULT 'warn' CHECK (severity IN ('info', 'warn', 'critical')),
        dimensions_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed')),
        dedupe_key TEXT NOT NULL UNIQUE,
        detected_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS metric_anomalies_metric
        ON metric_anomalies (metric_id, detected_at DESC);

      CREATE TABLE IF NOT EXISTS data_quality_rules (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        dataset TEXT NOT NULL
          CHECK (dataset IN ('daily_metrics', 'opportunities', 'projects', 'tasks')),
        rule_type TEXT NOT NULL
          CHECK (rule_type IN ('completeness', 'uniqueness', 'range', 'consistency', 'continuity')),
        config_json TEXT NOT NULL DEFAULT '{}',
        active INTEGER NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 1,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS data_quality_issues (
        id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL REFERENCES data_quality_rules(id) ON DELETE CASCADE,
        issue_key TEXT NOT NULL UNIQUE,
        details_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'open'
          CHECK (status IN ('open', 'fixed', 'ignored')),
        assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        original_json TEXT NOT NULL DEFAULT '{}',
        fixed_json TEXT NOT NULL DEFAULT '{}',
        fix_reason TEXT NOT NULL DEFAULT '',
        resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        resolved_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS data_quality_issues_status
        ON data_quality_issues (status, created_at DESC);

      CREATE TABLE IF NOT EXISTS forecast_scenarios (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        assumptions_json TEXT NOT NULL DEFAULT '{}',
        base_date TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft'
          CHECK (status IN ('draft', 'published', 'archived')),
        result_json TEXT NOT NULL DEFAULT '{}',
        version INTEGER NOT NULL DEFAULT 1,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS crm_opportunities (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        customer_name TEXT NOT NULL,
        customer_email TEXT NOT NULL,
        stage TEXT NOT NULL DEFAULT 'lead'
          CHECK (stage IN ('lead', 'opportunity', 'contract', 'renewal', 'churned')),
        amount_cents INTEGER NOT NULL DEFAULT 0,
        entered_stage_at TEXT NOT NULL,
        owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS crm_opportunities_stage
        ON crm_opportunities (workspace_id, stage, entered_stage_at);

      CREATE TABLE IF NOT EXISTS query_reports (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        config_json TEXT NOT NULL DEFAULT '{}',
        shared INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS query_reports_workspace
        ON query_reports (workspace_id, shared, created_at DESC);

      CREATE TABLE IF NOT EXISTS report_subscriptions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        report_id TEXT NOT NULL,
        report_kind TEXT NOT NULL DEFAULT 'saved' CHECK (report_kind IN ('saved', 'query')),
        recipients_json TEXT NOT NULL DEFAULT '[]',
        timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        format TEXT NOT NULL DEFAULT 'csv' CHECK (format IN ('csv', 'json', 'pdf', 'xlsx')),
        channel TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'download')),
        failure_notify INTEGER NOT NULL DEFAULT 1,
        cadence TEXT NOT NULL DEFAULT 'daily' CHECK (cadence IN ('daily', 'weekly', 'monthly')),
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_run_at TEXT,
        last_run_at TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 1,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS report_deliveries (
        id TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL REFERENCES report_subscriptions(id) ON DELETE CASCADE,
        period_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'sent', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        download_token TEXT NOT NULL UNIQUE,
        link_expires_at TEXT NOT NULL,
        delivered_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (subscription_id, period_key)
      );

      CREATE TABLE IF NOT EXISTS metric_lineage (
        id TEXT PRIMARY KEY,
        metric_id TEXT NOT NULL REFERENCES metric_definitions(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        relation TEXT NOT NULL DEFAULT 'derives',
        created_at TEXT NOT NULL,
        UNIQUE (metric_id, source_type, source_id, relation)
      );

      CREATE TABLE IF NOT EXISTS budget_categories (
        id TEXT PRIMARY KEY,
        budget_id TEXT NOT NULL REFERENCES project_budgets(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        planned_cents INTEGER NOT NULL DEFAULT 0,
        actual_cents INTEGER NOT NULL DEFAULT 0,
        forecast_cents INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (budget_id, name)
      );

      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS departments (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        parent_id TEXT REFERENCES departments(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        manager_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS departments_org ON departments (org_id, parent_id);

      CREATE TABLE IF NOT EXISTS org_memberships (
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        department_id TEXT REFERENCES departments(id) ON DELETE SET NULL,
        title TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (org_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS workspace_memberships (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'viewer'
          CHECK (role IN ('admin', 'manager', 'pm', 'viewer')),
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'invited', 'disabled')),
        joined_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS permission_samples (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL,
        expected_allow INTEGER NOT NULL,
        last_result_json TEXT NOT NULL DEFAULT '{}',
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS automation_rule_versions (
        id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        change_summary TEXT NOT NULL DEFAULT '',
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        UNIQUE (rule_id, version)
      );

      CREATE TABLE IF NOT EXISTS task_templates (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        tasks_json TEXT NOT NULL DEFAULT '[]',
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_templates_workspace
        ON task_templates (workspace_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS estimate_scales (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        values_json TEXT NOT NULL DEFAULT '[]',
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS estimate_scales_workspace
        ON estimate_scales (workspace_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS search_synonyms (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        term TEXT NOT NULL,
        synonyms_json TEXT NOT NULL DEFAULT '[]',
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, term)
      );

      CREATE TABLE IF NOT EXISTS portal_request_comments (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES portal_requests(id) ON DELETE CASCADE,
        account_id TEXT REFERENCES portal_accounts(id) ON DELETE SET NULL,
        author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        author_name TEXT NOT NULL DEFAULT '',
        author_kind TEXT NOT NULL DEFAULT 'staff'
          CHECK (author_kind IN ('customer', 'staff')),
        body TEXT NOT NULL,
        internal INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS portal_request_comments_request
        ON portal_request_comments (request_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS change_request_comments (
        id TEXT PRIMARY KEY,
        change_id TEXT NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
        author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS change_request_comments_change
        ON change_request_comments (change_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS approval_routing_rules (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'any',
        min_amount_cents INTEGER NOT NULL DEFAULT 0,
        max_amount_cents INTEGER,
        risk TEXT NOT NULL DEFAULT 'any'
          CHECK (risk IN ('any', 'low', 'medium', 'high')),
        steps_json TEXT NOT NULL DEFAULT '[]',
        priority INTEGER NOT NULL DEFAULT 100,
        active INTEGER NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 1,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS approval_routing_rules_workspace
        ON approval_routing_rules (workspace_id, active, priority);

      CREATE TABLE IF NOT EXISTS crm_stage_history (
        id TEXT PRIMARY KEY,
        opportunity_id TEXT NOT NULL REFERENCES crm_opportunities(id) ON DELETE CASCADE,
        from_stage TEXT,
        to_stage TEXT NOT NULL,
        changed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        changed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS crm_stage_history_opportunity
        ON crm_stage_history (opportunity_id, changed_at ASC);

      CREATE TABLE IF NOT EXISTS connector_calls (
        id TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
        method TEXT NOT NULL,
        path TEXT NOT NULL DEFAULT '',
        status INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS connector_calls_connector
        ON connector_calls (connector_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS password_resets (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        ip TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets (user_id, created_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS projects_fts USING fts5(
        name,
        description,
        content='projects',
        content_rowid='rowid',
        tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS projects_fts_ai AFTER INSERT ON projects BEGIN
        INSERT INTO projects_fts(rowid, name, description)
        VALUES (new.rowid, new.name, new.description);
      END;
      CREATE TRIGGER IF NOT EXISTS projects_fts_ad AFTER DELETE ON projects BEGIN
        INSERT INTO projects_fts(projects_fts, rowid, name, description)
        VALUES ('delete', old.rowid, old.name, old.description);
      END;
      CREATE TRIGGER IF NOT EXISTS projects_fts_au AFTER UPDATE OF name, description ON projects BEGIN
        INSERT INTO projects_fts(projects_fts, rowid, name, description)
        VALUES ('delete', old.rowid, old.name, old.description);
        INSERT INTO projects_fts(rowid, name, description)
        VALUES (new.rowid, new.name, new.description);
      END;

      CREATE VIRTUAL TABLE IF NOT EXISTS activities_fts USING fts5(
        message,
        actor,
        project,
        tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS activities_fts_ai AFTER INSERT ON activities BEGIN
        INSERT INTO activities_fts(rowid, message, actor, project)
        VALUES (
          new.seq,
          COALESCE(json_extract(new.payload, '$.message'), new.type),
          COALESCE(json_extract(new.payload, '$.actorName'), ''),
          COALESCE(json_extract(new.payload, '$.projectName'), '')
        );
      END;
      CREATE TRIGGER IF NOT EXISTS activities_fts_ad AFTER DELETE ON activities BEGIN
        DELETE FROM activities_fts WHERE rowid = old.seq;
      END;
      CREATE TRIGGER IF NOT EXISTS activities_fts_au AFTER UPDATE ON activities BEGIN
        DELETE FROM activities_fts WHERE rowid = old.seq;
        INSERT INTO activities_fts(rowid, message, actor, project)
        VALUES (
          new.seq,
          COALESCE(json_extract(new.payload, '$.message'), new.type),
          COALESCE(json_extract(new.payload, '$.actorName'), ''),
          COALESCE(json_extract(new.payload, '$.projectName'), '')
        );
      END;

      CREATE VIRTUAL TABLE IF NOT EXISTS users_fts USING fts5(
        name,
        email,
        content='users',
        content_rowid='rowid',
        tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS users_fts_ai AFTER INSERT ON users BEGIN
        INSERT INTO users_fts(rowid, name, email) VALUES (new.rowid, new.name, new.email);
      END;
      CREATE TRIGGER IF NOT EXISTS users_fts_ad AFTER DELETE ON users BEGIN
        INSERT INTO users_fts(users_fts, rowid, name, email)
        VALUES ('delete', old.rowid, old.name, old.email);
      END;
      CREATE TRIGGER IF NOT EXISTS users_fts_au AFTER UPDATE OF name, email ON users BEGIN
        INSERT INTO users_fts(users_fts, rowid, name, email)
        VALUES ('delete', old.rowid, old.name, old.email);
        INSERT INTO users_fts(rowid, name, email) VALUES (new.rowid, new.name, new.email);
      END;
    `);
  }

  #addColumn(table: string, column: string, definition: string): void {
    if (this.columns(table).has(column)) return;
    this.raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  /**
   * v18 allows dependencies between tasks in different projects, so the
   * project link must become nullable. SQLite cannot drop NOT NULL in place,
   * hence the table rebuild. No other table references task_dependencies.
   */
  #migrateDependenciesV18(): void {
    const info = this.raw.prepare('PRAGMA table_info(task_dependencies)').all() as unknown as {
      name: string;
      notnull: number;
    }[];
    const project = info.find((column) => column.name === 'project_id');
    if (!project || Number(project.notnull) === 0) return;
    this.transaction(() => {
      this.raw.exec(`
        CREATE TABLE task_dependencies_v18 (
          id TEXT PRIMARY KEY,
          project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
          predecessor_id TEXT NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
          successor_id TEXT NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
          type TEXT NOT NULL DEFAULT 'FS'
            CHECK (type IN ('FS', 'SS', 'FF', 'SF')),
          lag_days INTEGER NOT NULL DEFAULT 0 CHECK (lag_days >= 0 AND lag_days <= 365),
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL,
          UNIQUE (predecessor_id, successor_id)
        );
        INSERT INTO task_dependencies_v18
          (id, project_id, predecessor_id, successor_id, type, lag_days, created_by, created_at)
        SELECT id, project_id, predecessor_id, successor_id, type, lag_days, created_by, created_at
        FROM task_dependencies;
        DROP TABLE task_dependencies;
        ALTER TABLE task_dependencies_v18 RENAME TO task_dependencies;
        CREATE INDEX IF NOT EXISTS task_dependencies_project ON task_dependencies (project_id);
        CREATE INDEX IF NOT EXISTS task_dependencies_pred ON task_dependencies (predecessor_id);
        CREATE INDEX IF NOT EXISTS task_dependencies_succ ON task_dependencies (successor_id);
      `);
    });
    this.raw.exec(`
      INSERT OR IGNORE INTO crm_stage_history
        (id, opportunity_id, from_stage, to_stage, changed_by, changed_at)
      SELECT lower(hex(randomblob(16))), id, NULL, stage, owner_id, entered_stage_at
      FROM crm_opportunities
      WHERE id NOT IN (SELECT opportunity_id FROM crm_stage_history);
    `);
  }

  #migrateColumns(): void {
    const hadDemo = this.columns('users').has('is_demo');
    this.#addColumn('users', 'is_demo', 'INTEGER NOT NULL DEFAULT 0');
    if (!hadDemo) {
      this.raw.exec("UPDATE users SET is_demo = 1 WHERE email LIKE '%@pulse.demo'");
    }
    this.#addColumn('users', 'mfa_secret', 'TEXT');
    this.#addColumn('users', 'mfa_enabled', 'INTEGER NOT NULL DEFAULT 0');
    this.#addColumn('users', 'mfa_recovery', "TEXT NOT NULL DEFAULT '[]'");
    this.#addColumn('users', 'avatar_url', 'TEXT');
    this.#addColumn('users', 'version', 'INTEGER NOT NULL DEFAULT 1');
    this.#addColumn('users', 'workspace_id', 'TEXT REFERENCES workspaces(id)');
    this.#addColumn('users', 'custom_role_id', 'TEXT');
    this.#addColumn('projects', 'tags', "TEXT NOT NULL DEFAULT ''");
    this.#addColumn('projects', 'deleted_at', 'TEXT');
    this.#addColumn('projects', 'workspace_id', 'TEXT REFERENCES workspaces(id)');
    this.#addColumn('projects', 'visibility', "TEXT NOT NULL DEFAULT 'workspace'");
    this.#addColumn('user_preferences', 'version', 'INTEGER NOT NULL DEFAULT 1');
    this.#addColumn('daily_metrics', 'currency', "TEXT NOT NULL DEFAULT 'USD'");
    this.#addColumn('daily_metrics', 'source', "TEXT NOT NULL DEFAULT 'seed'");
    this.#addColumn('project_tasks', 'milestone_id', 'TEXT REFERENCES project_milestones(id)');
    this.#addColumn('project_tasks', 'estimate_points', 'REAL');
    this.#addColumn('project_tasks', 'estimate_hours', 'REAL');
    this.#addColumn('project_tasks', 'estimate_size', 'TEXT');
    this.#addColumn('project_tasks', 'task_type', "TEXT NOT NULL DEFAULT 'general'");
    this.#addColumn('project_tasks', 'customer_tier', "TEXT NOT NULL DEFAULT 'standard'");
    this.#addColumn('project_tasks', 'auto_status', 'INTEGER NOT NULL DEFAULT 0');
    this.#addColumn('decisions', 'deciders_json', "TEXT NOT NULL DEFAULT '[]'");
    this.#addColumn('decisions', 'impact_scope', "TEXT NOT NULL DEFAULT ''");
    this.#addColumn('decisions', 'links_json', "TEXT NOT NULL DEFAULT '[]'");
    this.#addColumn('decisions', 'adr', 'INTEGER NOT NULL DEFAULT 0');
    this.#addColumn('decisions', 'review_owner_id', 'TEXT REFERENCES users(id)');
    this.#addColumn('project_documents', 'archived_at', 'TEXT');
    this.#addColumn('automation_rules', 'execution_budget_json', "TEXT NOT NULL DEFAULT '{}'");
    this.#addColumn('jit_grants', 'used_count', 'INTEGER NOT NULL DEFAULT 0');
    this.#addColumn('jit_grants', 'post_review_required', 'INTEGER NOT NULL DEFAULT 0');
    this.#addColumn('jit_grants', 'post_reviewed_by', 'TEXT REFERENCES users(id)');
    this.#addColumn('jit_grants', 'post_reviewed_at', 'TEXT');
    this.#addColumn('jit_grants', 'emergency', 'INTEGER NOT NULL DEFAULT 0');
    this.#addColumn('metric_lineage', 'sensitive', 'INTEGER NOT NULL DEFAULT 0');
    this.#addColumn('notifications', 'actor_id', 'TEXT REFERENCES users(id)');
    this.#addColumn('notifications', 'project_id', 'TEXT REFERENCES projects(id)');
    this.#addColumn('notifications', 'task_id', 'TEXT REFERENCES project_tasks(id)');
    this.#addColumn('notifications', 'comment_id', 'TEXT REFERENCES comments(id)');
    this.#addColumn('notifications', 'pushed_at', 'TEXT');
    this.#addColumn('attachments', 'sha256', 'TEXT');
    this.#addColumn('attachments', 'scan', "TEXT NOT NULL DEFAULT 'clean'");
    this.#addColumn('task_forms', 'version', 'INTEGER NOT NULL DEFAULT 1');
    this.#addColumn('task_form_values', 'signature_name', "TEXT NOT NULL DEFAULT ''");
    this.#addColumn('task_form_values', 'signature_at', 'TEXT');
    this.#addColumn(
      'deliverable_versions',
      'attachment_id',
      'TEXT REFERENCES attachments(id) ON DELETE SET NULL',
    );
    this.#addColumn(
      'attachments',
      'document_id',
      'TEXT REFERENCES project_documents(id) ON DELETE CASCADE',
    );
    this.#addColumn('project_documents', 'attachments_json', "TEXT NOT NULL DEFAULT '[]'");
    this.#addColumn('project_documents', 'reminder_sent_at', 'TEXT');
    this.#addColumn('project_documents', 'review_cycle_days', 'INTEGER');
    this.#addColumn('benefit_reviews', 'reminder_sent_at', 'TEXT');
    this.#addColumn('meetings', 'series_id', 'TEXT');
    this.#addColumn('workflow_runs', 'replay_of', 'TEXT');
    this.#addColumn('task_sla_policies', 'timezone', "TEXT NOT NULL DEFAULT 'Asia/Shanghai'");
    this.#addColumn('task_sla_policies', 'advance_reminder_minutes', 'INTEGER NOT NULL DEFAULT 60');
    this.#addColumn('task_sla_policies', 'auto_escalate', 'INTEGER NOT NULL DEFAULT 1');
    this.#addColumn('task_sla_instances', 'reminded_at', 'TEXT');
    this.#addColumn('task_sla_instances', 'response_notified_at', 'TEXT');
    this.#addColumn('task_sla_instances', 'breach_notified_at', 'TEXT');
    this.#addColumn('task_sla_instances', 'review_due_at', 'TEXT');
    this.#addColumn('task_sla_instances', 'reviewed_at', 'TEXT');
    this.#addColumn('task_sla_instances', 'pause_reason', 'TEXT');
    this.#addColumn('task_sla_policies', 'holidays_json', "TEXT NOT NULL DEFAULT '[]'");
    this.#addColumn('metric_definitions', 'refresh_minutes', 'INTEGER NOT NULL DEFAULT 60');
    this.#addColumn('project_budgets', 'approval_request_id', 'TEXT');
    this.#addColumn('connectors', 'capabilities_json', "TEXT NOT NULL DEFAULT '[]'");
    this.#addColumn('connectors', 'token_expires_at', 'TEXT');
    this.#addColumn('connectors', 'last_call_at', 'TEXT');
    this.#addColumn('connectors', 'auth_url', "TEXT NOT NULL DEFAULT ''");
    this.#addColumn('connectors', 'token_url', "TEXT NOT NULL DEFAULT ''");
    this.#addColumn('connectors', 'client_id', "TEXT NOT NULL DEFAULT ''");
    this.#addColumn('connectors', 'client_secret_ref', "TEXT NOT NULL DEFAULT ''");
    this.#addColumn('connectors', 'redirect_uri', "TEXT NOT NULL DEFAULT ''");
    this.#addColumn(
      'report_subscriptions',
      'cadence',
      "TEXT NOT NULL DEFAULT 'daily' CHECK (cadence IN ('daily', 'weekly', 'monthly'))",
    );
    this.#addColumn('report_subscriptions', 'failure_count', 'INTEGER NOT NULL DEFAULT 0');
    this.#addColumn('report_subscriptions', 'last_error', 'TEXT');
    this.#addColumn('portal_requests', 'delivery_confirmed_at', 'TEXT');
    this.#addColumn(
      'portal_requests',
      'delivery_confirmed_by',
      'TEXT REFERENCES portal_accounts(id) ON DELETE SET NULL',
    );
    this.#addColumn('approval_requests', 'routing_rule_id', 'TEXT');
    this.#addColumn(
      'workspace_settings',
      'time_log_visibility',
      "TEXT NOT NULL DEFAULT 'all' CHECK (time_log_visibility IN ('all', 'managers', 'self'))",
    );
    this.#addColumn('task_handoffs', 'escalated_at', 'TEXT');
    this.raw.exec(
      'CREATE INDEX IF NOT EXISTS attachments_document ON attachments (document_id, created_at DESC)',
    );
    this.raw.exec('CREATE INDEX IF NOT EXISTS meetings_series ON meetings (series_id, starts_at)');
    this.#migrateDependenciesV18();
    this.raw.exec(
      'CREATE INDEX IF NOT EXISTS notifications_created ON notifications (created_at DESC)',
    );
    this.raw.exec('CREATE INDEX IF NOT EXISTS projects_deleted ON projects (deleted_at)');
    this.raw.exec(
      'CREATE INDEX IF NOT EXISTS project_tasks_milestone ON project_tasks (milestone_id)',
    );
    this.raw.exec('CREATE INDEX IF NOT EXISTS users_workspace ON users (workspace_id)');
    this.raw.exec(
      'CREATE INDEX IF NOT EXISTS projects_workspace ON projects (workspace_id, visibility)',
    );
    this.raw
      .prepare(
        `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at, updated_at)
         VALUES ('ws_default', '默认工作区', 'default', ?, ?)`,
      )
      .run(new Date().toISOString(), new Date().toISOString());
    this.raw
      .prepare(
        `INSERT OR IGNORE INTO workspace_settings (id, currency, rates, updated_at)
         VALUES (1, 'USD', ?, ?)`,
      )
      .run(JSON.stringify(DEFAULT_RATES), new Date().toISOString());
  }

  setUserVersionIfLower(version: number): void {
    if (this.userVersion < version) this.setUserVersion(version);
  }

  stmt(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.#instrument(sql, this.raw.prepare(sql));
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  get slowQueries(): number {
    return this.#slowQueries;
  }

  #instrument(sql: string, statement: StatementSync): StatementSync {
    const database = this;
    return new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== 'function') return value;
        if (
          property === 'get' ||
          property === 'all' ||
          property === 'run' ||
          property === 'iterate'
        ) {
          const method = value as (...args: unknown[]) => unknown;
          return (...args: unknown[]): unknown => {
            const started = performance.now();
            try {
              return method.apply(target, args);
            } finally {
              const ms = performance.now() - started;
              if (ms >= database.slowQueryThresholdMs) {
                database.#slowQueries++;
                log('warn', 'db.slow', { ms: Math.round(ms), sql: sql.slice(0, 200) });
              }
            }
          };
        }
        return value.bind(target);
      },
    });
  }

  quickCheck(): boolean {
    try {
      const rows = this.raw.prepare('PRAGMA quick_check(1)').all() as unknown as {
        quick_check: string;
      }[];
      return rows.every((row) => row.quick_check === 'ok');
    } catch {
      return false;
    }
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    // Nested calls use savepoints so domain helpers that own their own
    // transaction can still be composed into a larger atomic operation.
    if (this.#txDepth > 0) {
      const savepoint = `sp_${this.#txDepth}`;
      this.raw.exec(`SAVEPOINT ${savepoint}`);
      this.#txDepth += 1;
      try {
        const result = fn();
        this.raw.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        try {
          this.raw.exec(`ROLLBACK TO ${savepoint}`);
          this.raw.exec(`RELEASE ${savepoint}`);
        } catch {
          // rollback is best-effort; surface the original error
        }
        throw error;
      } finally {
        this.#txDepth -= 1;
      }
    }
    this.raw.exec('BEGIN IMMEDIATE');
    this.#txDepth = 1;
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        // rollback is best-effort; surface the original error
      }
      throw error;
    } finally {
      this.#txDepth = 0;
    }
  }

  get userVersion(): number {
    const row = this.raw.prepare('PRAGMA user_version').get() as unknown as {
      user_version: number;
    };
    return Number(row.user_version);
  }

  setUserVersion(version: number): void {
    this.raw.exec(`PRAGMA user_version = ${Math.floor(version)}`);
  }

  tableExists(name: string): boolean {
    const row = this.raw
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) as unknown as { present: number } | undefined;
    return Boolean(row);
  }

  columns(table: string): Set<string> {
    const rows = this.raw.prepare(`PRAGMA table_info(${table})`).all() as unknown as {
      name: string;
    }[];
    return new Set(rows.map((row) => row.name));
  }

  sqliteVersion(): string {
    const row = this.raw.prepare('SELECT sqlite_version() AS version').get() as unknown as {
      version: string;
    };
    return row.version;
  }

  close(): void {
    this.#statements.clear();
    this.raw.close();
  }
}

/**
 * Copy the database once before applying additive schema changes, and run a
 * WAL checkpoint first so a single-file copy is complete. Restoring is a
 * matter of stopping the server and copying the `.bak` file back.
 */
export function backupBeforeMigration(path: string): void {
  if (path === ':memory:' || !existsSync(path)) return;
  const backupPath = `${path}.pre-v${SCHEMA_VERSION}.bak`;
  if (existsSync(backupPath)) return;

  let probe: DatabaseSync | null = null;
  try {
    probe = new DatabaseSync(path);
    const row = probe.prepare('PRAGMA user_version').get() as unknown as {
      user_version: number;
    };
    const version = Number(row.user_version);
    if (version === 0 || version >= SCHEMA_VERSION) return;
    probe.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    copyFileSync(path, backupPath);
  } catch {
    // A corrupt database will surface a clearer error when opened below.
  } finally {
    probe?.close();
  }
}

/**
 * Copy the v1 database before the destructive task → project migration.
 * Checkpoints WAL first so a single-file copy captures everything.
 */
export function backupLegacyDatabase(path: string): void {
  if (path === ':memory:' || !existsSync(path)) return;
  const backupPath = `${path}.pre-v2.bak`;
  if (existsSync(backupPath)) return;

  let probe: DatabaseSync | null = null;
  try {
    probe = new DatabaseSync(path);
    const version = probe.prepare('PRAGMA user_version').get() as unknown as {
      user_version: number;
    };
    const tasks = probe
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
      .get() as unknown as { present: number } | undefined;
    if (Number(version.user_version) >= SCHEMA_VERSION || !tasks?.present) return;
    probe.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    copyFileSync(path, backupPath);
  } catch {
    // If the probe fails, opening the real database below will surface the error.
  } finally {
    probe?.close();
  }
}

type LegacyTaskRow = {
  id: string;
  title: string;
  done: number;
  due_at?: string | null;
  created_at: string;
  updated_at?: string | null;
};

type LegacyEventRow = {
  type: string;
  payload: string;
  created_at: string;
};

/**
 * Convert the v1 task board into projects. Runs once per database, inside a
 * single transaction, after demo users exist so the admin can own the rows.
 */
export function migrateLegacyTasks(db: Database, admin: User): void {
  if (db.userVersion >= SCHEMA_VERSION && !db.tableExists('tasks')) return;

  if (db.tableExists('tasks')) {
    const columns = db.columns('tasks');
    const dueExpr = columns.has('due_at') ? 'due_at' : 'NULL AS due_at';
    const updatedExpr = columns.has('updated_at') ? 'updated_at' : 'created_at AS updated_at';
    const tasks = db.raw
      .prepare(`SELECT id, title, done, ${dueExpr}, created_at, ${updatedExpr} FROM tasks`)
      .all() as unknown as LegacyTaskRow[];

    db.transaction(() => {
      const insert = db.stmt(`
        INSERT OR IGNORE INTO projects
          (id, name, description, status, progress, owner_id, start_date, due_date,
           is_demo, legacy_task_id, created_at, updated_at, version)
        VALUES (?, ?, '', ?, ?, ?, NULL, ?, 0, ?, ?, ?, 1)
      `);

      for (const task of tasks) {
        const status = task.done === 1 ? 'completed' : 'active';
        insert.run(
          task.id,
          task.title,
          status,
          task.done === 1 ? 100 : 0,
          admin.id,
          task.due_at ?? null,
          task.id,
          task.created_at,
          task.updated_at ?? task.created_at,
        );
      }

      if (db.tableExists('events')) {
        const events = db.raw
          .prepare('SELECT type, payload, created_at FROM events ORDER BY seq ASC')
          .all() as unknown as LegacyEventRow[];
        const insertActivity = db.stmt(`
          INSERT INTO activities (type, actor_id, project_id, payload, created_at)
          VALUES (?, ?, ?, ?, ?)
        `);
        const projectExists = db.raw.prepare('SELECT 1 AS present FROM projects WHERE id = ?');

        for (const event of events) {
          let payload: Record<string, unknown>;
          try {
            const parsed = JSON.parse(event.payload) as unknown;
            payload =
              parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
          } catch {
            continue;
          }

          if (event.type === 'tasks.imported') {
            const count = Number(payload.count ?? 0);
            insertActivity.run(
              'project.imported',
              admin.id,
              null,
              JSON.stringify({
                message: `导入了 ${count} 个项目`,
                actorName: admin.name,
                count,
              }),
              event.created_at,
            );
            continue;
          }

          if (event.type !== 'task.created' && event.type !== 'task.updated') continue;
          const taskId = typeof payload.id === 'string' ? payload.id : null;
          if (!taskId || !projectExists.get(taskId)) continue;
          const name = typeof payload.title === 'string' ? payload.title : '项目';
          const type = event.type === 'task.created' ? 'project.created' : 'project.updated';
          const message =
            type === 'project.created' ? `创建了项目「${name}」` : `更新了项目「${name}」`;
          insertActivity.run(
            type,
            admin.id,
            taskId,
            JSON.stringify({ message, actorName: admin.name, projectName: name }),
            event.created_at,
          );
        }
      }

      db.raw.exec(`
        DROP TRIGGER IF EXISTS tasks_fts_ai;
        DROP TRIGGER IF EXISTS tasks_fts_ad;
        DROP TRIGGER IF EXISTS tasks_fts_au;
        DROP TABLE IF EXISTS tasks_fts;
        DROP TABLE IF EXISTS tasks;
        DROP TABLE IF EXISTS events;
      `);
    });
  }

  db.setUserVersion(SCHEMA_VERSION);
}

export const STATUS_LABELS = PROJECT_STATUS_LABELS;
