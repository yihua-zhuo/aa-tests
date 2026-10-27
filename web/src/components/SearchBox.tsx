import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PROJECT_STATUS_LABELS, ROLE_LABELS } from '../../../shared/permissions.ts';
import type { SearchResults } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { formatPercent, timeAgo } from '../format.ts';
import { useDebounced } from '../hooks/useApi.ts';
import { useLocale } from '../i18n.ts';
import { Icon } from './Icon.tsx';
import { Avatar, cx, Spinner, StatusBadge } from './ui.tsx';

const RECENT_KEY = 'pulse.recent-searches';

function loadRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string').slice(0, 5);
  } catch {
    return [];
  }
}

export function SearchBox() {
  const navigate = useNavigate();
  const { t } = useLocale();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [activeIndex, setActiveIndex] = useState(-1);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounced = useDebounced(query, 240);

  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
        return;
      }
      if (event.key === 'Escape' && document.activeElement === inputRef.current) {
        setOpen(false);
        inputRef.current?.blur();
      }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  useEffect(() => {
    const term = debounced.trim();
    setActiveIndex(-1);
    if (term.length < 2) {
      setResults(null);
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api
      .search(term, controller.signal)
      .then((next) => setResults(next))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : '搜索失败');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [debounced]);

  const term = query.trim();
  const hasResults =
    results !== null &&
    (results.projects.length > 0 || results.activities.length > 0 || results.users.length > 0);

  const actions: { key: string; to: string }[] = [];
  if (results) {
    for (const project of results.projects) {
      actions.push({ key: `p-${project.id}`, to: `/projects/${project.id}` });
    }
    for (const item of results.activities.slice(0, 5)) {
      actions.push({
        key: `a-${item.seq}`,
        to: item.project ? `/projects/${item.project.id}` : '/activity',
      });
    }
    for (const user of results.users.slice(0, 4)) {
      actions.push({ key: `u-${user.id}`, to: '/users' });
    }
  }
  if (hasResults) {
    actions.push({ key: 'all', to: `/projects?q=${encodeURIComponent(term)}` });
  }

  const remember = (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length < 2) return;
    const next = [trimmed, ...recent.filter((item) => item !== trimmed)].slice(0, 5);
    setRecent(next);
    try {
      window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      // storage can be unavailable in private mode
    }
  };

  const go = (to: string) => {
    setOpen(false);
    setQuery('');
    setResults(null);
    setActiveIndex(-1);
    navigate(to);
  };

  const pick = (index: number) => {
    const action = actions[index];
    if (!action) return;
    remember(term);
    go(action.to);
  };

  const activityOffset = results?.projects.length ?? 0;
  const userOffset = activityOffset + (results?.activities.slice(0, 5).length ?? 0);
  const allIndex = actions.length - 1;

  return (
    <div className="searchbox" ref={wrapperRef}>
      <span className="searchbox-icon" aria-hidden="true">
        <Icon name="search" size={17} />
      </span>
      <input
        ref={inputRef}
        type="search"
        value={query}
        placeholder="搜索项目、活动或成员…"
        aria-label="全局搜索（Ctrl+K）"
        role="combobox"
        aria-expanded={open}
        aria-controls="global-search-panel"
        aria-autocomplete="list"
        aria-activedescendant={activeIndex >= 0 ? `search-option-${activeIndex}` : undefined}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            if (actions.length === 0) return;
            event.preventDefault();
            setOpen(true);
            setActiveIndex((current) => Math.min(current + 1, actions.length - 1));
          } else if (event.key === 'ArrowUp') {
            if (actions.length === 0) return;
            event.preventDefault();
            setActiveIndex((current) => Math.max(current - 1, 0));
          } else if (event.key === 'Enter') {
            event.preventDefault();
            if (activeIndex >= 0) pick(activeIndex);
            else if (term) {
              remember(term);
              go(`/projects?q=${encodeURIComponent(term)}`);
            }
          } else if (event.key === 'Escape') {
            setOpen(false);
            inputRef.current?.blur();
          }
        }}
      />
      <kbd className="search-kbd" aria-hidden="true">
        Ctrl K
      </kbd>
      {loading ? <Spinner size={15} /> : null}

      {open && term.length < 2 && recent.length > 0 ? (
        <div className="search-panel" id="global-search-panel" role="listbox">
          <p className="search-group-title">{t('search.recent')}</p>
          {recent.map((item) => (
            <button
              key={item}
              type="button"
              className="search-hit"
              role="option"
              aria-selected={false}
              onClick={() => {
                setQuery(item);
                setOpen(true);
                inputRef.current?.focus();
              }}
            >
              <span className="search-hit-icon" data-tone="mint">
                <Icon name="search" size={15} />
              </span>
              <span className="search-hit-body">
                <span className="search-hit-title">{item}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {open && term.length >= 2 ? (
        <div className="search-panel" id="global-search-panel" role="listbox">
          {error ? <p className="search-empty">{error}</p> : null}
          {!error && !loading && !hasResults ? (
            <p className="search-empty">没有找到与「{term}」相关的内容</p>
          ) : null}

          {results && results.projects.length > 0 ? (
            <div className="search-group">
              <p className="search-group-title">Projects</p>
              {results.projects.map((project, index) => (
                <button
                  key={project.id}
                  type="button"
                  id={`search-option-${index}`}
                  className={cx('search-hit', index === activeIndex && 'is-active')}
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => pick(index)}
                >
                  <span className="search-hit-icon" data-tone="lilac">
                    <Icon name="projects" size={16} />
                  </span>
                  <span className="search-hit-body">
                    <span className="search-hit-title">{project.name}</span>
                    <span className="search-hit-meta">
                      {PROJECT_STATUS_LABELS[project.status]} · {formatPercent(project.progress)}{' '}
                      进度
                    </span>
                  </span>
                  <StatusBadge status={project.status} />
                </button>
              ))}
            </div>
          ) : null}

          {results && results.activities.length > 0 ? (
            <div className="search-group">
              <p className="search-group-title">Activity</p>
              {results.activities.slice(0, 5).map((item, index) => {
                const actionIndex = activityOffset + index;
                return (
                  <button
                    key={item.seq}
                    type="button"
                    id={`search-option-${actionIndex}`}
                    className={cx('search-hit', actionIndex === activeIndex && 'is-active')}
                    role="option"
                    aria-selected={actionIndex === activeIndex}
                    onMouseEnter={() => setActiveIndex(actionIndex)}
                    onClick={() => pick(actionIndex)}
                  >
                    <span className="search-hit-icon" data-tone="mint">
                      <Icon name="activity" size={16} />
                    </span>
                    <span className="search-hit-body">
                      <span className="search-hit-title">{item.message}</span>
                      <span className="search-hit-meta">
                        {item.actor?.name ?? '系统'} · {timeAgo(item.createdAt)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {results && results.users.length > 0 ? (
            <div className="search-group">
              <p className="search-group-title">Users</p>
              {results.users.slice(0, 4).map((user, index) => {
                const actionIndex = userOffset + index;
                return (
                  <button
                    key={user.id}
                    type="button"
                    id={`search-option-${actionIndex}`}
                    className={cx('search-hit', actionIndex === activeIndex && 'is-active')}
                    role="option"
                    aria-selected={actionIndex === activeIndex}
                    onMouseEnter={() => setActiveIndex(actionIndex)}
                    onClick={() => pick(actionIndex)}
                  >
                    <Avatar name={user.name} src={user.avatarUrl} size={30} />
                    <span className="search-hit-body">
                      <span className="search-hit-title">{user.name}</span>
                      <span className="search-hit-meta">{user.email}</span>
                    </span>
                    <span className="search-hit-role">{ROLE_LABELS[user.role]}</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {hasResults ? (
            <button
              type="button"
              id={`search-option-${allIndex}`}
              className={cx('search-all', allIndex === activeIndex && 'is-active')}
              role="option"
              aria-selected={allIndex === activeIndex}
              onMouseEnter={() => setActiveIndex(allIndex)}
              onClick={() => pick(allIndex)}
            >
              在 Projects 中查看「{term}」
              <Icon name="arrowRight" size={15} />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
