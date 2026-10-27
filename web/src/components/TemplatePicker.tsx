import { type FormEvent, useEffect, useState } from 'react';
import {
  type ProjectTemplate,
  templateMilestoneCount,
  templateTaskCount,
} from '../../../shared/templates.ts';
import type { TemplateApplyInput } from '../api.ts';
import { Icon } from './Icon.tsx';
import { Field, Modal, Spinner } from './ui.tsx';

type Props = {
  open: boolean;
  templates: ProjectTemplate[];
  loading: boolean;
  canPickOwner: boolean;
  users: { id: string; name: string }[];
  ownerId: string;
  onClose: () => void;
  onSubmit: (input: TemplateApplyInput) => Promise<void>;
};

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function TemplatePicker({
  open,
  templates,
  loading,
  canPickOwner,
  users,
  ownerId,
  onClose,
  onSubmit,
}: Props) {
  const [selectedId, setSelectedId] = useState('');
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState(todayKey);
  const [owner, setOwner] = useState(ownerId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = templates.find((template) => template.id === selectedId) ?? templates[0];

  useEffect(() => {
    if (!open) return;
    setSelectedId('');
    setName('');
    setStartDate(todayKey());
    setOwner(ownerId);
    setBusy(false);
    setError(null);
  }, [open, ownerId]);

  useEffect(() => {
    if (!open || selectedId || templates.length === 0) return;
    const first = templates[0];
    setSelectedId(first.id);
    setName(first.name);
  }, [open, selectedId, templates]);

  const choose = (template: ProjectTemplate) => {
    setSelectedId(template.id);
    setName(template.name);
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || busy) return;
    if (!name.trim()) {
      setError('项目名称不能为空');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        templateId: selected.id,
        name: name.trim(),
        startDate: startDate || undefined,
        ownerId: canPickOwner ? owner || undefined : undefined,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建项目失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="从模板创建项目"
      description="模板会一次性生成本地里程碑与任务，日期按开始日期自动顺延。"
      wide
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="submit"
            form="template-form"
            className="btn btn-primary"
            disabled={busy || loading || !selected}
          >
            {busy ? <Spinner size={16} /> : <Icon name="rocket" size={16} />}
            创建项目
          </button>
        </>
      }
    >
      {loading ? (
        <div className="template-loading" aria-label="加载模板">
          <span className="spinner" />
          正在加载模板…
        </div>
      ) : templates.length === 0 ? (
        <p className="import-empty">暂无可用模板。</p>
      ) : (
        <form id="template-form" className="template-picker" onSubmit={submit}>
          <div className="template-list" role="radiogroup" aria-label="选择项目模板">
            {templates.map((template) => (
              <button
                key={template.id}
                type="button"
                role="radio"
                aria-checked={selected?.id === template.id}
                className={`template-option${selected?.id === template.id ? ' is-active' : ''}`}
                onClick={() => choose(template)}
              >
                <span className="template-option-head">
                  <strong>{template.name}</strong>
                  <span className="template-category">{template.category}</span>
                </span>
                <span className="template-summary">{template.summary}</span>
                <span className="template-meta">
                  {templateMilestoneCount(template)} 个里程碑 · {templateTaskCount(template)} 个任务
                  · {template.durationDays} 天
                </span>
              </button>
            ))}
          </div>

          {selected ? (
            <div className="template-preview">
              <p className="template-preview-desc">{selected.description}</p>
              <ol className="template-milestones">
                {selected.milestones.map((milestone) => (
                  <li key={milestone.key}>
                    <span className="template-milestone-dot" aria-hidden="true" />
                    <strong>{milestone.title}</strong>
                    <span>第 {milestone.dueOffsetDays} 天</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          <div className="form-grid template-form-grid">
            <div className="form-span-2">
              <Field label="项目名称" htmlFor="template-name">
                <input
                  id="template-name"
                  className="input"
                  value={name}
                  maxLength={120}
                  required
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
            </div>

            <Field label="开始日期" htmlFor="template-start">
              <input
                id="template-start"
                type="date"
                className="input"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
              />
            </Field>

            <Field label="负责人" htmlFor="template-owner">
              {canPickOwner ? (
                <select
                  id="template-owner"
                  className="input"
                  value={owner}
                  onChange={(event) => setOwner(event.target.value)}
                >
                  {users.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="template-owner"
                  className="input"
                  value={users.find((option) => option.id === owner)?.name ?? ''}
                  disabled
                />
              )}
            </Field>
          </div>

          {error ? (
            <div className="form-error" role="alert">
              <Icon name="alert" size={16} />
              <span>{error}</span>
            </div>
          ) : null}
        </form>
      )}
    </Modal>
  );
}
