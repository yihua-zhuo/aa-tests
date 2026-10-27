import { type FormEvent, useEffect, useState } from 'react';
import type {
  DecisionRecord,
  DocumentStatus,
  DocumentVersion,
  ProjectDocument,
} from '../../../../shared/types.ts';
import { api } from '../../api.ts';
import { formatDate } from '../../format.ts';
import { useApi, useToast } from '../../hooks/useApi.ts';
import { Icon } from '../Icon.tsx';
import { EmptyState, ErrorState, Field, Modal, Spinner, Toaster } from '../ui.tsx';
import {
  EnterpriseStat,
  type EnterpriseTabProps,
  EnterpriseToolbar,
  ProjectPicker,
  ToneBadge,
} from './shared.tsx';

const DOC_STATUS_LABELS: Record<DocumentStatus, string> = {
  draft: '草稿',
  review: '评审中',
  published: '已发布',
  expired: '已过期',
  archived: '已归档',
};

const CONFIDENTIALITY_LABELS: Record<ProjectDocument['confidentiality'], string> = {
  internal: '内部',
  restricted: '受限',
  confidential: '机密',
};

function docTone(status: DocumentStatus): 'success' | 'warning' | 'muted' | 'danger' {
  if (status === 'published') return 'success';
  if (status === 'review') return 'warning';
  if (status === 'expired') return 'danger';
  return 'muted';
}

export function KnowledgeTab({ projects }: EnterpriseTabProps) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const docsState = useApi((signal) => api.documents(projectId, {}, signal), [projectId], {
    skip: !projectId,
  });
  const decisionsState = useApi((signal) => api.decisions({}, signal), []);
  const [createDocOpen, setCreateDocOpen] = useState(false);
  const [editing, setEditing] = useState<ProjectDocument | null>(null);
  const [createDecisionOpen, setCreateDecisionOpen] = useState(false);
  const { toasts, show, dismiss } = useToast();

  useEffect(() => {
    if (!projectId && projects[0]) setProjectId(projects[0].id);
  }, [projectId, projects]);

  const documents = docsState.data ?? [];
  const decisions = decisionsState.data ?? [];
  const published = documents.filter((document) => document.status === 'published').length;
  const approved = decisions.filter((decision) => decision.status === 'approved').length;

  const updateDecisionStatus = async (
    decision: DecisionRecord,
    status: DecisionRecord['status'],
  ) => {
    try {
      await api.updateDecision(decision.id, {
        version: decision.version,
        status,
        changeSummary: `状态调整为 ${status}`,
      });
      show('决策状态已更新');
      decisionsState.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '更新失败', 'error');
    }
  };

  return (
    <div className="enterprise-tab">
      <EnterpriseToolbar>
        <ProjectPicker projects={projects} value={projectId} onChange={setProjectId} />
        <p className="enterprise-hint">项目文档按项目隔离；架构决策记录跨项目共享。</p>
      </EnterpriseToolbar>

      <div className="enterprise-stats">
        <EnterpriseStat label="项目文档" value={documents.length} hint={`${published} 篇已发布`} />
        <EnterpriseStat
          label="决策记录"
          value={decisions.length}
          hint={`${approved} 个已批准`}
          tone="mint"
        />
        <EnterpriseStat
          label="待评审文档"
          value={documents.filter((document) => document.status === 'review').length}
          hint="需要负责人确认"
          tone="peach"
        />
        <EnterpriseStat
          label="机密文档"
          value={documents.filter((document) => document.confidentiality === 'confidential').length}
          hint="访问需谨慎"
          tone="sky"
        />
      </div>

      <section className="card card-pad">
        <header className="card-head">
          <div>
            <h2>项目文档</h2>
            <p className="card-sub">支持版本历史与回滚，内容变更会记录审计。</p>
          </div>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!projectId}
            onClick={() => setCreateDocOpen(true)}
          >
            <Icon name="plus" size={16} />
            新建文档
          </button>
        </header>
        {docsState.error && !docsState.data ? (
          <ErrorState message={docsState.error} onRetry={docsState.reload} compact />
        ) : null}
        {documents.length === 0 ? (
          <EmptyState
            icon="file"
            title="该项目还没有文档"
            description="沉淀需求、方案与操作手册，并保留每次变更的版本。"
            compact
          />
        ) : (
          <div className="card table-card">
            <table className="data-table">
              <thead>
                <tr>
                  <th>标题</th>
                  <th>状态</th>
                  <th>保密级别</th>
                  <th>负责人</th>
                  <th>版本</th>
                  <th>更新时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((document) => (
                  <tr key={document.id}>
                    <td>
                      <strong>{document.title}</strong>
                    </td>
                    <td>
                      <ToneBadge tone={docTone(document.status)}>
                        {DOC_STATUS_LABELS[document.status]}
                      </ToneBadge>
                    </td>
                    <td className="table-muted">
                      {CONFIDENTIALITY_LABELS[document.confidentiality]}
                    </td>
                    <td>{document.ownerName ?? '—'}</td>
                    <td className="table-muted">v{document.version}</td>
                    <td className="table-muted">{formatDate(document.updatedAt)}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-soft btn-sm"
                        onClick={() => setEditing(document)}
                      >
                        查看 / 编辑
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
            <h2>架构决策记录</h2>
            <p className="card-sub">记录背景、选项与结论，便于追溯关键取舍。</p>
          </div>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setCreateDecisionOpen(true)}
          >
            <Icon name="plus" size={16} />
            新建决策
          </button>
        </header>
        {decisionsState.error && !decisionsState.data ? (
          <ErrorState message={decisionsState.error} onRetry={decisionsState.reload} compact />
        ) : null}
        {decisions.length === 0 ? (
          <EmptyState icon="file" title="还没有决策记录" compact />
        ) : (
          <ul className="enterprise-sublist">
            {decisions.map((decision) => (
              <li key={decision.id}>
                <div className="enterprise-subject">
                  <span>
                    {decision.title}{' '}
                    {decision.projectName ? (
                      <span className="table-muted">· {decision.projectName}</span>
                    ) : (
                      <span className="table-muted">· 工作区级</span>
                    )}
                  </span>
                  <select
                    className="input input-sm"
                    value={decision.status}
                    aria-label={`更新决策 ${decision.title} 状态`}
                    onChange={(event) =>
                      void updateDecisionStatus(
                        decision,
                        event.target.value as DecisionRecord['status'],
                      )
                    }
                  >
                    <option value="proposed">提议中</option>
                    <option value="approved">已批准</option>
                    <option value="rejected">已拒绝</option>
                    <option value="superseded">已被取代</option>
                  </select>
                </div>
                {decision.context ? <p className="enterprise-hint">{decision.context}</p> : null}
                {decision.decision ? (
                  <p className="enterprise-hint">
                    结论：{decision.decision}
                    {decision.decidedByName ? ` · ${decision.decidedByName}` : ''}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <DocumentDialog
        open={createDocOpen}
        projectId={projectId}
        onClose={() => setCreateDocOpen(false)}
        onCreated={(document) => {
          setCreateDocOpen(false);
          show(`已创建文档「${document.title}」`);
          docsState.reload();
        }}
        onError={(message) => show(message, 'error')}
      />

      <EditDocumentDialog
        document={editing}
        onClose={() => setEditing(null)}
        onSaved={(document) => {
          setEditing(null);
          show(`文档「${document.title}」已更新到 v${document.version}`);
          docsState.reload();
        }}
        onRestored={(document) => {
          setEditing(document);
          show(`已回滚到 v${document.version}`);
          docsState.reload();
        }}
        onError={(message) => show(message, 'error')}
      />

      <CreateDecisionDialog
        open={createDecisionOpen}
        projects={projects}
        defaultProjectId={projectId}
        onClose={() => setCreateDecisionOpen(false)}
        onCreated={(decision) => {
          setCreateDecisionOpen(false);
          show(`已创建决策「${decision.title}」`);
          decisionsState.reload();
        }}
        onError={(message) => show(message, 'error')}
      />

      <Toaster toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

function DocumentDialog({
  open,
  projectId,
  onClose,
  onCreated,
  onError,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onCreated: (document: ProjectDocument) => void;
  onError: (message: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [status, setStatus] = useState<DocumentStatus>('draft');
  const [confidentiality, setConfidentiality] =
    useState<ProjectDocument['confidentiality']>('internal');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const document = await api.createDocument(projectId, {
        title,
        content,
        status,
        confidentiality,
        format: 'markdown',
      });
      setTitle('');
      setContent('');
      onCreated(document);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : '创建失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建文档"
      wide
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            form="document-create-form"
            className="btn btn-primary"
            disabled={busy}
          >
            {busy ? <Spinner size={16} /> : <Icon name="plus" size={16} />}
            创建文档
          </button>
        </>
      }
    >
      <form
        id="document-create-form"
        className="form-grid"
        onSubmit={(event) => void submit(event)}
      >
        <Field label="标题" htmlFor="doc-title">
          <input
            id="doc-title"
            className="input"
            value={title}
            required
            maxLength={160}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <Field label="状态" htmlFor="doc-status">
          <select
            id="doc-status"
            className="input"
            value={status}
            onChange={(event) => setStatus(event.target.value as DocumentStatus)}
          >
            {Object.entries(DOC_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="保密级别" htmlFor="doc-confidentiality">
          <select
            id="doc-confidentiality"
            className="input"
            value={confidentiality}
            onChange={(event) =>
              setConfidentiality(event.target.value as ProjectDocument['confidentiality'])
            }
          >
            {Object.entries(CONFIDENTIALITY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="内容（Markdown）" htmlFor="doc-content">
          <textarea
            id="doc-content"
            className="input textarea enterprise-doc-editor"
            value={content}
            maxLength={100_000}
            onChange={(event) => setContent(event.target.value)}
          />
        </Field>
      </form>
    </Modal>
  );
}

function EditDocumentDialog({
  document,
  onClose,
  onSaved,
  onRestored,
  onError,
}: {
  document: ProjectDocument | null;
  onClose: () => void;
  onSaved: (document: ProjectDocument) => void;
  onRestored: (document: ProjectDocument) => void;
  onError: (message: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [status, setStatus] = useState<DocumentStatus>('draft');
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [versions, setVersions] = useState<DocumentVersion[]>([]);

  useEffect(() => {
    if (!document) return;
    setTitle(document.title);
    setContent(document.content);
    setStatus(document.status);
    setSummary('');
    setVersions([]);
    void api
      .documentVersions(document.id)
      .then(setVersions)
      .catch(() => setVersions([]));
  }, [document]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!document || busy) return;
    setBusy(true);
    try {
      const saved = await api.updateDocument(document.id, {
        version: document.version,
        title,
        content,
        status,
        changeSummary: summary || undefined,
      });
      onSaved(saved);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const restore = async (version: number) => {
    if (!document || busy) return;
    setBusy(true);
    try {
      const restored = await api.restoreDocument(document.id, {
        version,
        changeSummary: `回滚到 v${version}`,
      });
      onRestored(restored);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : '回滚失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={document !== null}
      onClose={onClose}
      title={`编辑文档${document ? `：${document.title}` : ''}`}
      wide
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            关闭
          </button>
          <button
            type="submit"
            form="document-edit-form"
            className="btn btn-primary"
            disabled={busy}
          >
            {busy ? <Spinner size={16} /> : <Icon name="check" size={16} />}
            保存新版本
          </button>
        </>
      }
    >
      <form id="document-edit-form" className="form-grid" onSubmit={(event) => void submit(event)}>
        <Field label="标题" htmlFor="doc-edit-title">
          <input
            id="doc-edit-title"
            className="input"
            value={title}
            required
            maxLength={160}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <Field label="状态" htmlFor="doc-edit-status">
          <select
            id="doc-edit-status"
            className="input"
            value={status}
            onChange={(event) => setStatus(event.target.value as DocumentStatus)}
          >
            {Object.entries(DOC_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="变更说明" htmlFor="doc-edit-summary" hint="会写入版本历史">
          <input
            id="doc-edit-summary"
            className="input"
            value={summary}
            maxLength={200}
            onChange={(event) => setSummary(event.target.value)}
          />
        </Field>
        <Field label="内容" htmlFor="doc-edit-content">
          <textarea
            id="doc-edit-content"
            className="input textarea enterprise-doc-editor"
            value={content}
            maxLength={100_000}
            onChange={(event) => setContent(event.target.value)}
          />
        </Field>
        {versions.length > 0 ? (
          <div className="form-span-2 enterprise-version-list">
            <strong>版本历史</strong>
            <ul className="enterprise-sublist">
              {versions.slice(0, 6).map((version) => (
                <li key={version.id}>
                  <div className="enterprise-subject">
                    <span>
                      v{version.version} · {version.changeSummary || '无变更说明'}
                    </span>
                    <span className="table-muted">
                      {version.createdByName ?? '系统'} · {formatDate(version.createdAt)}
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={busy || version.version === document?.version}
                      onClick={() => void restore(version.version)}
                    >
                      回滚
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </form>
    </Modal>
  );
}

function CreateDecisionDialog({
  open,
  projects,
  defaultProjectId,
  onClose,
  onCreated,
  onError,
}: {
  open: boolean;
  projects: EnterpriseTabProps['projects'];
  defaultProjectId: string;
  onClose: () => void;
  onCreated: (decision: DecisionRecord) => void;
  onError: (message: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [projectId, setProjectId] = useState(defaultProjectId);
  const [context, setContext] = useState('');
  const [decision, setDecision] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setProjectId(defaultProjectId);
  }, [open, defaultProjectId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const record = await api.createDecision({
        title,
        projectId: projectId || null,
        context,
        decision,
        status: 'proposed',
      });
      setTitle('');
      setContext('');
      setDecision('');
      onCreated(record);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : '创建失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建决策记录"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            form="decision-create-form"
            className="btn btn-primary"
            disabled={busy}
          >
            {busy ? <Spinner size={16} /> : <Icon name="plus" size={16} />}
            创建
          </button>
        </>
      }
    >
      <form
        id="decision-create-form"
        className="form-grid"
        onSubmit={(event) => void submit(event)}
      >
        <Field label="标题" htmlFor="decision-title">
          <input
            id="decision-title"
            className="input"
            value={title}
            required
            maxLength={160}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <Field label="关联项目" htmlFor="decision-project" hint="留空表示工作区级决策">
          <select
            id="decision-project"
            className="input"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">工作区级</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="背景" htmlFor="decision-context">
          <textarea
            id="decision-context"
            className="input textarea"
            value={context}
            maxLength={5000}
            onChange={(event) => setContext(event.target.value)}
          />
        </Field>
        <Field label="结论" htmlFor="decision-result">
          <textarea
            id="decision-result"
            className="input textarea"
            value={decision}
            maxLength={5000}
            onChange={(event) => setDecision(event.target.value)}
          />
        </Field>
      </form>
    </Modal>
  );
}
