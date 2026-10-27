import { type FormEvent, useEffect, useState } from 'react';
import { canManageWorkspace } from '../../../shared/permissions.ts';
import type {
  FeatureFlagKey,
  OpsBackup,
  OpsIntegrity,
  OpsSettings,
  UserDirectoryEntry,
} from '../../../shared/types.ts';
import { api } from '../api.ts';
import { Icon } from '../components/Icon.tsx';
import { ConfirmDialog, ErrorState, Field, Skeleton, Toaster } from '../components/ui.tsx';
import { formatDateTime, formatNumber } from '../format.ts';
import { useApi, useToast } from '../hooks/useApi.ts';
import { useAuth } from '../hooks/useAuth.tsx';

const FLAGS: Record<FeatureFlagKey, { label: string; description: string }> = {
  analytics: { label: '分析报表', description: '控制侧栏「分析」入口与报表导航' },
  audit_center: { label: '审计中心', description: '控制管理员审计日志页面入口' },
  webhooks: { label: 'Webhook 集成', description: '控制个人设置中的 Webhook 管理' },
  push_notifications: { label: 'Web Push', description: '控制浏览器推送通知订阅' },
  project_templates: { label: '项目模板', description: '控制「从模板创建」快捷入口' },
  enterprise: { label: '企业套件', description: '控制战略目标、组合、知识与治理工作台' },
};

const RETENTION_FIELDS: {
  key:
    | 'backupRetentionDays'
    | 'trashRetentionDays'
    | 'auditRetentionDays'
    | 'activityRetentionDays';
  label: string;
  hint: string;
}[] = [
  { key: 'backupRetentionDays', label: '备份保留天数', hint: '自动删除更早的快照' },
  { key: 'trashRetentionDays', label: '回收站保留天数', hint: '到期后彻底删除项目' },
  { key: 'auditRetentionDays', label: '审计日志保留天数', hint: '到期后裁剪审计记录' },
  { key: 'activityRetentionDays', label: '活动流保留天数', hint: '到期后裁剪动态' },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function OpsPage() {
  const { user, refresh } = useAuth();
  const { toasts, show, dismiss } = useToast();
  const state = useApi((signal) => api.ops(signal), [], { live: false });
  const users = useApi(
    (signal) => api.users({ page: 1, pageSize: 50, role: 'all', status: 'all' }, signal),
    [],
    { live: false },
  );
  const [settings, setSettings] = useState<OpsSettings | null>(null);
  const [integrity, setIntegrity] = useState<OpsIntegrity | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<OpsBackup | null>(null);
  const [demoConfirm, setDemoConfirm] = useState(false);
  const [selectedUser, setSelectedUser] = useState('');
  const [eraseTarget, setEraseTarget] = useState<UserDirectoryEntry | null>(null);

  const status = state.data?.status;
  const canOperate = user ? canManageWorkspace(user.role, user.permissions) : false;

  useEffect(() => {
    if (status) setSettings(status.settings);
  }, [status]);

  useEffect(() => {
    if (users.data && users.data.users.length > 0 && !selectedUser) {
      setSelectedUser(users.data.users[0]!.id);
    }
  }, [users.data, selectedUser]);

  if (!canOperate) return <ErrorState message="只有工作区管理员可以访问运维面板。" />;

  if (state.error && !status) {
    return <ErrorState message={state.error} onRetry={state.reload} />;
  }

  if (!status || !settings) {
    return (
      <div className="page ops-page">
        <div className="ops-skeleton">
          <Skeleton height={140} />
          <Skeleton height={260} />
          <Skeleton height={200} />
        </div>
      </div>
    );
  }

  const runIntegrity = async () => {
    setChecking(true);
    try {
      const result = await api.opsIntegrity();
      setIntegrity(result.integrity);
      show(
        result.integrity.ok ? '数据库完整性检查通过' : '完整性检查发现问题',
        result.integrity.ok ? 'success' : 'error',
      );
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '完整性检查失败', 'error');
    } finally {
      setChecking(false);
    }
  };

  const saveRetention = async (event: FormEvent) => {
    event.preventDefault();
    setBusy('retention');
    try {
      const result = await api.updateOpsSettings({
        backupRetentionDays: settings.backupRetentionDays,
        trashRetentionDays: settings.trashRetentionDays,
        auditRetentionDays: settings.auditRetentionDays,
        activityRetentionDays: settings.activityRetentionDays,
      });
      setSettings(result.settings);
      show('保留期已更新，将在下一次备份任务中生效');
      state.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '保存失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  const createBackup = async () => {
    setBusy('backup');
    try {
      const result = await api.createBackup();
      show(`已创建备份 ${result.backup.name}`);
      state.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '创建备份失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  const stageRestore = async () => {
    if (!restoreTarget) return;
    setBusy('restore');
    try {
      const result = await api.stageRestore(restoreTarget.name);
      show(result.message);
      setRestoreTarget(null);
      state.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '恢复失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  const toggleFlag = async (key: FeatureFlagKey, enabled: boolean) => {
    setBusy(`flag:${key}`);
    try {
      await api.setFeature(key, enabled);
      show(`${FLAGS[key].label}已${enabled ? '启用' : '停用'}`);
      state.reload();
      await refresh();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '切换失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  const setDemoData = async (enabled: boolean) => {
    setBusy('demo');
    try {
      const result = await api.toggleDemoData(enabled);
      show(
        enabled
          ? `已生成 ${result.demo.projects} 个演示项目`
          : `已清除 ${result.removed} 个演示项目`,
      );
      setDemoConfirm(false);
      state.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '切换演示数据失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  const eraseUser = async () => {
    if (!eraseTarget) return;
    setBusy('erase');
    try {
      await api.eraseUser(eraseTarget.id);
      show(`已匿名化 ${eraseTarget.name} 的个人数据`);
      setEraseTarget(null);
      state.reload();
      users.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '删除失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  const target = users.data?.users.find((entry) => entry.id === selectedUser) ?? null;

  return (
    <div className="page ops-page">
      <header className="page-head">
        <div className="page-head-copy">
          <p className="eyebrow">Ops</p>
          <h1>运维面板</h1>
          <p className="page-sub">
            备份与恢复、数据库完整性、数据保留期、演示数据、功能开关与 GDPR 数据操作集中在这里。
          </p>
        </div>
        <div className="page-head-actions">
          <button type="button" className="btn btn-ghost" onClick={state.reload}>
            <Icon name="refresh" size={16} />
            刷新
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void runIntegrity()}
            disabled={checking}
          >
            <Icon name="shield" size={16} />
            {checking ? '检查中…' : '检查完整性'}
          </button>
        </div>
      </header>

      <section className="card card-pad ops-summary">
        <div className="ops-metrics">
          <div className="ops-metric">
            <span className="stat-label">数据库状态</span>
            <strong className={status.healthy ? 'status-text is-active' : 'status-text is-danger'}>
              {status.healthy ? '正常' : '异常'}
            </strong>
            <small>
              SQLite {status.sqliteVersion} · schema v{status.schemaVersion}
            </small>
          </div>
          <div className="ops-metric">
            <span className="stat-label">数据库大小</span>
            <strong>{formatBytes(status.databaseBytes)}</strong>
            <small>含 WAL 文件</small>
          </div>
          <div className="ops-metric">
            <span className="stat-label">备份数量</span>
            <strong>{formatNumber(status.backups.length)}</strong>
            <small>{status.backupDir}</small>
          </div>
          <div className="ops-metric">
            <span className="stat-label">数据量</span>
            <strong>{formatNumber(status.counts.projects)} 项目</strong>
            <small>
              {formatNumber(status.counts.users)} 成员 · {formatNumber(status.counts.activities)}{' '}
              动态
            </small>
          </div>
        </div>
        {integrity ? (
          <div className={`ops-integrity ${integrity.ok ? 'is-ok' : 'is-bad'}`} role="status">
            <Icon name={integrity.ok ? 'check' : 'alert'} size={18} />
            <div>
              <strong>{integrity.ok ? '完整性检查通过' : '完整性检查失败'}</strong>
              <p>{integrity.messages.join('；')}</p>
              <small>{formatDateTime(integrity.checkedAt)}</small>
            </div>
          </div>
        ) : null}
        {status.pendingRestore ? (
          <div className="ops-integrity is-warn" role="status">
            <Icon name="alert" size={18} />
            <div>
              <strong>有排队中的恢复任务</strong>
              <p>重启服务后将用备份替换当前数据库，原数据库会保留为 .pre-restore-*.bak。</p>
            </div>
          </div>
        ) : null}
      </section>

      <div className="settings-grid">
        <div className="settings-column">
          <section className="card card-pad">
            <header className="card-head">
              <div>
                <h2>备份与恢复</h2>
                <p className="card-sub">
                  快照使用 VACUUM INTO，可在写入过程中安全执行；恢复需要重启服务。
                </p>
              </div>
              <Icon name="database" size={20} />
            </header>
            <div className="ops-actions">
              <button
                type="button"
                className="btn btn-soft"
                onClick={() => void createBackup()}
                disabled={busy === 'backup'}
              >
                <Icon name="download" size={16} />
                {busy === 'backup' ? '备份中…' : '立即备份'}
              </button>
            </div>
            {status.backups.length === 0 ? (
              <p className="muted">还没有备份文件。</p>
            ) : (
              <div className="table-wrap">
                <table className="table ops-backups">
                  <caption className="sr-only">可用备份</caption>
                  <thead>
                    <tr>
                      <th scope="col">文件</th>
                      <th scope="col">大小</th>
                      <th scope="col">创建时间</th>
                      <th scope="col">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.backups.map((backup) => (
                      <tr key={backup.name}>
                        <td>
                          <code>{backup.name}</code>
                        </td>
                        <td>{formatBytes(backup.sizeBytes)}</td>
                        <td>{formatDateTime(backup.createdAt)}</td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs"
                            onClick={() => setRestoreTarget(backup)}
                          >
                            恢复
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card card-pad">
            <header className="card-head">
              <div>
                <h2>数据保留期</h2>
                <p className="card-sub">
                  每日备份任务会按这里的期限裁剪备份、回收站、审计日志与活动流。
                </p>
              </div>
              <Icon name="clock" size={20} />
            </header>
            <form className="form-grid" onSubmit={saveRetention}>
              {RETENTION_FIELDS.map((field) => (
                <Field
                  key={field.key}
                  label={field.label}
                  htmlFor={`ops-${field.key}`}
                  hint={field.hint}
                >
                  <input
                    id={`ops-${field.key}`}
                    className="input"
                    type="number"
                    min={1}
                    max={3650}
                    required
                    value={settings[field.key]}
                    onChange={(event) =>
                      setSettings({ ...settings, [field.key]: Number(event.target.value) })
                    }
                  />
                </Field>
              ))}
              <div className="form-span-2 ops-actions">
                <button type="submit" className="btn btn-primary" disabled={busy === 'retention'}>
                  {busy === 'retention' ? '保存中…' : '保存保留期'}
                </button>
              </div>
            </form>
          </section>

          <section className="card card-pad">
            <header className="card-head">
              <div>
                <h2>演示数据</h2>
                <p className="card-sub">
                  演示项目用于产品展示；关闭会删除所有 is_demo 项目，重新开启会按内置模板重建。
                </p>
              </div>
              <Icon name="spark" size={20} />
            </header>
            <div className="ops-toggle-row">
              <div>
                <strong>{status.demo.enabled ? '演示数据已开启' : '演示数据已关闭'}</strong>
                <p className="muted">
                  {formatNumber(status.demo.projects)} 个演示项目 ·{' '}
                  {formatNumber(status.demo.users)} 个演示账号
                </p>
              </div>
              <button
                type="button"
                className={`btn ${status.demo.enabled ? 'btn-ghost' : 'btn-primary'}`}
                onClick={() => {
                  if (status.demo.enabled) setDemoConfirm(true);
                  else void setDemoData(true);
                }}
                disabled={busy === 'demo'}
              >
                {status.demo.enabled ? '清除演示数据' : '生成演示数据'}
              </button>
            </div>
          </section>
        </div>

        <div className="settings-column">
          <section className="card card-pad">
            <header className="card-head">
              <div>
                <h2>功能开关</h2>
                <p className="card-sub">停用后对应入口立即从导航与设置中隐藏，接口保持可用。</p>
              </div>
              <Icon name="settings" size={20} />
            </header>
            <ul className="ops-flags">
              {status.features.map((flag) => {
                const meta = FLAGS[flag.key];
                return (
                  <li key={flag.key}>
                    <label className="ops-flag">
                      <input
                        type="checkbox"
                        checked={flag.enabled}
                        disabled={busy === `flag:${flag.key}`}
                        onChange={(event) => void toggleFlag(flag.key, event.target.checked)}
                      />
                      <span>
                        <strong>{meta.label}</strong>
                        <small>{meta.description}</small>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="card card-pad">
            <header className="card-head">
              <div>
                <h2>GDPR 数据操作</h2>
                <p className="card-sub">
                  导出成员的全部个人数据；删除会匿名化账号并撤销会话、令牌与集成，且不可撤销。
                </p>
              </div>
              <Icon name="users" size={20} />
            </header>
            <Field label="选择成员" htmlFor="ops-gdpr-user">
              <select
                id="ops-gdpr-user"
                className="input"
                value={selectedUser}
                onChange={(event) => setSelectedUser(event.target.value)}
              >
                {(users.data?.users ?? []).map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name} · {entry.email}
                    {entry.status === 'disabled' ? '（已停用）' : ''}
                  </option>
                ))}
              </select>
            </Field>
            {users.error ? <p className="field-hint">成员列表加载失败：{users.error}</p> : null}
            <div className="ops-actions">
              <a
                className={`btn btn-ghost${target ? '' : ' is-disabled'}`}
                href={target ? api.exportUserUrl(target.id) : undefined}
                download
                aria-disabled={!target}
                onClick={(event) => {
                  if (!target) event.preventDefault();
                }}
              >
                <Icon name="download" size={16} />
                导出 JSON
              </a>
              <button
                type="button"
                className="btn btn-danger"
                disabled={!target || target.id === user?.id}
                onClick={() => target && setEraseTarget(target)}
              >
                <Icon name="trash" size={16} />
                匿名化删除
              </button>
            </div>
            <p className="field-hint">会话与令牌会立即失效；成员创建的项目会转移给当前管理员。</p>
          </section>
        </div>
      </div>

      <ConfirmDialog
        open={restoreTarget !== null}
        title="恢复备份"
        message={`将把 ${restoreTarget?.name ?? ''} 排入恢复队列。服务重启后当前数据库会被替换，并保留一份 .pre-restore 备份。`}
        confirmLabel="排队恢复"
        busy={busy === 'restore'}
        onCancel={() => setRestoreTarget(null)}
        onConfirm={() => void stageRestore()}
      />
      <ConfirmDialog
        open={demoConfirm}
        title="清除演示数据"
        message="所有演示项目及其任务、评论会被删除，演示账号保留。之后可随时重新生成。"
        confirmLabel="清除演示数据"
        busy={busy === 'demo'}
        onCancel={() => setDemoConfirm(false)}
        onConfirm={() => void setDemoData(false)}
      />
      <ConfirmDialog
        open={eraseTarget !== null}
        title="匿名化删除成员"
        message={`将永久删除 ${eraseTarget?.name ?? ''} 的个人数据并停用账号。该操作不可撤销。`}
        confirmLabel="匿名化删除"
        busy={busy === 'erase'}
        onCancel={() => setEraseTarget(null)}
        onConfirm={() => void eraseUser()}
      />
      <Toaster toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
