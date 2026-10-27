import { type FormEvent, useEffect, useState } from 'react';
import type { ProjectDetail } from '../../../shared/types.ts';
import type { DuplicateProjectInput } from '../api.ts';
import { Icon } from './Icon.tsx';
import { Field, Modal, Spinner } from './ui.tsx';

type Props = {
  open: boolean;
  project: ProjectDetail;
  onClose: () => void;
  onSubmit: (input: DuplicateProjectInput) => Promise<void>;
};

export function DuplicateProjectDialog({ open, project, onClose, onSubmit }: Props) {
  const [name, setName] = useState('');
  const [offset, setOffset] = useState(0);
  const [includeMembers, setIncludeMembers] = useState(true);
  const [includeTasks, setIncludeTasks] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(`${project.name} 副本`.slice(0, 120));
    setOffset(0);
    setIncludeMembers(true);
    setIncludeTasks(true);
    setBusy(false);
    setError(null);
  }, [open, project.name]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!name.trim()) {
      setError('项目名称不能为空');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        dateOffsetDays: offset,
        includeMembers,
        includeTasks,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '复制项目失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="复制项目"
      description="复制会生成独立的里程碑与任务，评论和活动记录不会一起复制。"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="submit" form="duplicate-form" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner size={16} /> : <Icon name="projects" size={16} />}
            复制项目
          </button>
        </>
      }
    >
      <form id="duplicate-form" className="form-grid" onSubmit={submit}>
        <div className="form-span-2">
          <Field label="新项目名称" htmlFor="duplicate-name">
            <input
              id="duplicate-name"
              className="input"
              value={name}
              maxLength={120}
              required
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
        </div>

        <Field
          label="日期偏移（天）"
          htmlFor="duplicate-offset"
          hint="正数向后顺延，负数向前，0 表示保持原日期。"
        >
          <input
            id="duplicate-offset"
            type="number"
            className="input"
            min={-365}
            max={365}
            step={1}
            value={offset}
            onChange={(event) => setOffset(Number(event.target.value) || 0)}
          />
        </Field>

        <div className="duplicate-options">
          <label className="member-option">
            <input
              type="checkbox"
              checked={includeMembers}
              onChange={(event) => setIncludeMembers(event.target.checked)}
            />
            <span>复制项目成员</span>
          </label>
          <label className="member-option">
            <input
              type="checkbox"
              checked={includeTasks}
              onChange={(event) => setIncludeTasks(event.target.checked)}
            />
            <span>复制里程碑与任务</span>
          </label>
        </div>

        <p className="field-hint form-span-2">
          副本默认进入「规划中」，并记录一条「复制项目」动态。
        </p>

        {error ? (
          <div className="form-error form-span-2" role="alert">
            <Icon name="alert" size={16} />
            <span>{error}</span>
          </div>
        ) : null}
      </form>
    </Modal>
  );
}
