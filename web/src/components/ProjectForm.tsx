import { type FormEvent, useEffect, useRef, useState } from 'react';
import {
  canViewAllProjects,
  PROJECT_STATUS_LABELS,
  PROJECT_STATUSES,
} from '../../../shared/permissions.ts';
import type {
  Project,
  ProjectDetail,
  ProjectStatus,
  ProjectVisibility,
  UserOption,
} from '../../../shared/types.ts';
import { ApiError, api } from '../api.ts';
import { useAuth } from '../hooks/useAuth.tsx';
import { Icon } from './Icon.tsx';
import { Avatar, Field, Modal, Spinner } from './ui.tsx';

type Props = {
  open: boolean;
  project: ProjectDetail | null;
  users: UserOption[];
  onClose: () => void;
  onSaved: (project: ProjectDetail, message: string) => void;
  onTyping?: (active: boolean) => void;
};

export function ProjectForm({ open, project, users, onClose, onSaved, onTyping }: Props) {
  const { user } = useAuth();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<ProjectStatus>('planning');
  const [visibility, setVisibility] = useState<ProjectVisibility>('workspace');
  const [progress, setProgress] = useState(0);
  const [ownerId, setOwnerId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [version, setVersion] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Project | null>(null);
  const initialized = useRef('');

  const canPickOwner = user ? canViewAllProjects(user.role, user.permissions) : false;

  useEffect(() => {
    const key = open ? `${project?.id ?? 'new'}` : '';
    if (!open || initialized.current === key) return;
    initialized.current = key;
    setName(project?.name ?? '');
    setDescription(project?.description ?? '');
    setStatus(project?.status ?? 'planning');
    setVisibility(project?.visibility ?? 'workspace');
    setProgress(project?.progress ?? 0);
    setOwnerId(project?.ownerId ?? user?.id ?? '');
    setStartDate(project?.startDate ?? '');
    setDueDate(project?.dueDate ?? '');
    setTagsText(project?.tags.join(', ') ?? '');
    setMemberIds(project?.members.map((member) => member.id) ?? []);
    setVersion(project?.version ?? 1);
    setError(null);
    setConflict(null);
    setBusy(false);
  }, [open, project, user?.id]);

  useEffect(() => {
    if (!open) initialized.current = '';
  }, [open]);

  const toggleMember = (id: string) => {
    setMemberIds((current) =>
      current.includes(id) ? current.filter((memberId) => memberId !== id) : [...current, id],
    );
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!name.trim()) {
      setError('项目名称不能为空');
      return;
    }
    if (startDate && dueDate && startDate > dueDate) {
      setError('截止日期不能早于开始日期');
      return;
    }
    const tags = [
      ...new Set(
        tagsText
          .split(/[,，\n]/)
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    ];
    if (tags.length > 5) {
      setError('最多添加 5 个标签');
      return;
    }
    if (tags.some((tag) => tag.length > 24)) {
      setError('单个标签最多 24 个字符');
      return;
    }

    setBusy(true);
    setError(null);
    setConflict(null);
    const payload = {
      name: name.trim(),
      description: description.trim(),
      status,
      visibility,
      progress,
      ownerId: ownerId || undefined,
      startDate: startDate || null,
      dueDate: dueDate || null,
      tags,
      memberIds,
    };

    try {
      if (project) {
        const saved = await api.updateProject(project.id, { ...payload, version });
        onSaved(saved, '项目已更新');
      } else {
        const created = await api.createProject(payload);
        onSaved(created, '项目已创建');
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409 && cause.current) {
        setConflict(cause.current);
        setError(cause.message);
      } else {
        setError(cause instanceof Error ? cause.message : '保存失败');
      }
    } finally {
      setBusy(false);
    }
  };

  const loadLatest = () => {
    if (!conflict) return;
    setName(conflict.name);
    setDescription(conflict.description);
    setStatus(conflict.status);
    setVisibility(conflict.visibility);
    setProgress(conflict.progress);
    setOwnerId(conflict.ownerId);
    setStartDate(conflict.startDate ?? '');
    setDueDate(conflict.dueDate ?? '');
    setTagsText(conflict.tags.join(', '));
    setVersion(conflict.version);
    setConflict(null);
    setError(null);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={project ? '编辑项目' : '新建项目'}
      description={
        project
          ? '保存时会校验版本号，其他会话的修改不会在无声中被覆盖。'
          : '项目会立即出现在团队看板，并记录一条活动。'
      }
      wide
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="submit" form="project-form" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner size={16} /> : <Icon name="check" size={16} />}
            {project ? '保存修改' : '创建项目'}
          </button>
        </>
      }
    >
      <form id="project-form" className="form-grid" onSubmit={submit}>
        <div className="form-span-2">
          <Field label="项目名称" htmlFor="project-name">
            <input
              id="project-name"
              className="input"
              value={name}
              maxLength={120}
              required
              onChange={(event) => {
                setName(event.target.value);
                onTyping?.(true);
              }}
              onBlur={() => onTyping?.(false)}
              placeholder="例如：Q4 品牌升级"
            />
          </Field>
        </div>

        <div className="form-span-2">
          <Field label="描述" htmlFor="project-description" hint="最多 2000 字，可被全局搜索命中。">
            <textarea
              id="project-description"
              className="input textarea"
              rows={3}
              maxLength={2000}
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
                onTyping?.(true);
              }}
              onBlur={() => onTyping?.(false)}
              placeholder="项目目标、范围或关键里程碑…"
            />
          </Field>
        </div>

        <div className="form-span-2">
          <Field
            label="标签"
            htmlFor="project-tags"
            hint="用逗号分隔，最多 5 个；可用于筛选与保存视图。"
          >
            <input
              id="project-tags"
              className="input"
              value={tagsText}
              maxLength={140}
              onChange={(event) => setTagsText(event.target.value)}
              placeholder="例如：设计, Q4, 重点"
            />
          </Field>
        </div>

        <Field label="状态" htmlFor="project-status">
          <select
            id="project-status"
            className="input"
            value={status}
            onChange={(event) => setStatus(event.target.value as ProjectStatus)}
          >
            {PROJECT_STATUSES.map((value) => (
              <option key={value} value={value}>
                {PROJECT_STATUS_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="可见范围"
          htmlFor="project-visibility"
          hint={
            visibility === 'private'
              ? '仅项目负责人和成员可见，拥有“查看全部项目”权限的经理也不会看到。'
              : '工作区内拥有查看全部权限的经理可以看到此项目。'
          }
        >
          <select
            id="project-visibility"
            className="input"
            value={visibility}
            onChange={(event) => setVisibility(event.target.value as ProjectVisibility)}
          >
            <option value="workspace">工作区可见</option>
            <option value="private">仅成员可见</option>
          </select>
        </Field>

        <Field label="负责人" htmlFor="project-owner">
          {canPickOwner ? (
            <select
              id="project-owner"
              className="input"
              value={ownerId}
              onChange={(event) => setOwnerId(event.target.value)}
            >
              {users.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          ) : (
            <input id="project-owner" className="input" value={user?.name ?? ''} disabled />
          )}
        </Field>

        <Field label={`进度 · ${progress}%`} htmlFor="project-progress">
          <input
            id="project-progress"
            type="range"
            min={0}
            max={100}
            step={1}
            value={progress}
            onChange={(event) => setProgress(Number(event.target.value))}
            className="range-input"
          />
        </Field>

        <Field label="开始日期" htmlFor="project-start">
          <input
            id="project-start"
            type="date"
            className="input"
            value={startDate}
            onChange={(event) => setStartDate(event.target.value)}
          />
        </Field>

        <Field label="截止日期" htmlFor="project-due">
          <input
            id="project-due"
            type="date"
            className="input"
            value={dueDate}
            min={startDate || undefined}
            onChange={(event) => setDueDate(event.target.value)}
          />
        </Field>

        <div className="form-span-2">
          <p className="form-label">项目成员</p>
          <div className="member-picker">
            {users.map((option) => (
              <label key={option.id} className="member-option">
                <input
                  type="checkbox"
                  checked={memberIds.includes(option.id)}
                  onChange={() => toggleMember(option.id)}
                />
                <Avatar name={option.name} size={26} muted={!memberIds.includes(option.id)} />
                <span>{option.name}</span>
              </label>
            ))}
          </div>
          <p className="field-hint">只读成员与项目经理只能看到自己拥有或加入的项目。</p>
        </div>

        {error ? (
          <div className="form-error form-span-2" role="alert">
            <Icon name="alert" size={16} />
            <span>{error}</span>
            {conflict ? (
              <button type="button" className="btn btn-soft btn-xs" onClick={loadLatest}>
                载入最新版本 (v{conflict.version})
              </button>
            ) : null}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}
