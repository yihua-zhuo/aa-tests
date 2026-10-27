import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  canManageWorkspace,
  canViewAudit,
  canViewUserDirectory,
  ROLE_LABELS,
} from '../../../shared/permissions.ts';
import { api } from '../api.ts';
import { Icon, type IconName } from '../components/Icon.tsx';
import { NotificationBell } from '../components/NotificationBell.tsx';
import { OfflineBanner } from '../components/OfflineBanner.tsx';
import { SearchBox } from '../components/SearchBox.tsx';
import { Avatar, ClayDecor, cx, RoleBadge } from '../components/ui.tsx';
import { useAuth } from '../hooks/useAuth.tsx';
import { useLiveData } from '../hooks/useLiveData.ts';
import { type MessageKey, useLocale } from '../i18n.ts';

type NavItem = { to: string; label: string; hint: string; icon: IconName; end?: boolean };
type NavSource = Omit<NavItem, 'hint'> & { hint: MessageKey };

const BASE_NAV: NavSource[] = [
  { to: '/', label: 'Overview', hint: 'nav.overview.hint', icon: 'overview', end: true },
  { to: '/analytics', label: 'Analytics', hint: 'nav.analytics.hint', icon: 'analytics' },
  { to: '/projects', label: 'Projects', hint: 'nav.projects.hint', icon: 'projects' },
  { to: '/activity', label: 'Activity', hint: 'nav.activity.hint', icon: 'activity' },
];

export function AppShell() {
  const { user, preferences, workspaceInfo, features, setPreferences, logout } = useAuth();
  const { t } = useLocale();
  const navigate = useNavigate();
  const location = useLocation();
  const { connected, clients } = useLiveData(Boolean(user));
  const [mobileOpen, setMobileOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  const accountButtonRef = useRef<HTMLButtonElement>(null);

  const collapsed = preferences?.sidebarCollapsed ?? false;
  const nav: NavItem[] = BASE_NAV.filter(
    (item) => item.to !== '/analytics' || features.analytics,
  ).map((item) => ({ ...item, hint: t(item.hint) }));
  if (user && canViewUserDirectory(user.role, user.permissions)) {
    nav.push({ to: '/users', label: 'Users', hint: t('nav.users.hint'), icon: 'users' });
  }
  if (features.enterprise) {
    nav.push({
      to: '/enterprise',
      label: 'Enterprise',
      hint: t('nav.enterprise.hint'),
      icon: 'trend',
    });
  }
  if (user && canViewAudit(user.role, user.permissions) && features.audit_center) {
    nav.push({ to: '/audit', label: 'Audit', hint: t('nav.audit.hint'), icon: 'shield' });
  }
  if (user && canManageWorkspace(user.role, user.permissions)) {
    nav.push({ to: '/ops', label: 'Ops', hint: t('nav.ops.hint'), icon: 'database' });
  }
  nav.push({ to: '/settings', label: 'Settings', hint: t('nav.settings.hint'), icon: 'settings' });

  useEffect(() => {
    setMobileOpen(false);
    setMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (accountRef.current && !accountRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMenuOpen(false);
      accountButtonRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [mobileOpen]);

  const toggleCollapsed = () => {
    if (!preferences) return;
    const next = { ...preferences, sidebarCollapsed: !collapsed };
    setPreferences(next);
    void api.updatePreferences({ sidebarCollapsed: next.sidebarCollapsed }).catch(() => undefined);
  };

  const signOut = async () => {
    setSigningOut(true);
    try {
      await logout();
      navigate('/login', { replace: true });
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div className={cx('app-shell', collapsed && 'is-collapsed')}>
      <ClayDecor />

      <aside className={cx('sidebar', collapsed && 'is-collapsed', mobileOpen && 'is-open')}>
        <div className="sidebar-brand">
          <Link to="/" className="brand-mark" aria-label="Clay Dashboard 首页">
            <span className="brand-glyph" aria-hidden="true">
              <Icon name="spark" size={22} />
            </span>
            <span className="brand-text">
              <strong>Clay</strong>
              <span>Dashboard</span>
            </span>
          </Link>
          <button
            type="button"
            className="btn btn-icon btn-ghost sidebar-collapse"
            onClick={toggleCollapsed}
            aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
            title={collapsed ? '展开侧栏' : '收起侧栏'}
          >
            <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} size={16} />
          </button>
        </div>

        <nav className="sidebar-nav" aria-label="主导航">
          <p className="sidebar-label" title={workspaceInfo?.name}>
            {workspaceInfo?.name ?? 'Workspace'}
          </p>
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => cx('sidebar-link', isActive && 'is-active')}
              title={collapsed ? `${item.label} · ${item.hint}` : undefined}
            >
              <span className="sidebar-icon" aria-hidden="true">
                <Icon name={item.icon} size={19} />
              </span>
              <span className="sidebar-link-text">
                <span>{item.label}</span>
                <small>{item.hint}</small>
              </span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-spacer" />

        <div className="sidebar-live">
          <span className={cx('live-dot', connected && 'is-live')} aria-hidden="true" />
          <span
            className="sidebar-live-text"
            title={clients.map((client) => client.name).join('、') || undefined}
          >
            {connected
              ? t('live.connected', { count: Math.max(clients.length, 1) })
              : t('live.connecting')}
          </span>
        </div>

        {user ? (
          <div className="sidebar-account">
            <Avatar name={user.name} src={user.avatarUrl} size={38} />
            <div className="sidebar-account-text">
              <strong>{user.name}</strong>
              <span title={user.workspaceName}>
                {user.customRole?.name ?? ROLE_LABELS[user.role]}
              </span>
            </div>
            <button
              type="button"
              className="btn btn-icon btn-ghost"
              onClick={() => void signOut()}
              aria-label="退出登录"
              title="退出登录"
              disabled={signingOut}
            >
              <Icon name="logout" size={18} />
            </button>
          </div>
        ) : null}
      </aside>

      {mobileOpen ? (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="关闭菜单"
          onClick={() => setMobileOpen(false)}
        />
      ) : null}

      <div className="shell-body">
        <header className="topbar">
          <button
            type="button"
            className="btn btn-icon btn-ghost shell-menu"
            onClick={() => setMobileOpen(true)}
            aria-label="打开导航菜单"
          >
            <Icon name="menu" size={20} />
          </button>

          <SearchBox />

          <div className="topbar-actions">
            <span className={cx('connection-pill', connected && 'is-live')}>
              <span className="live-dot" aria-hidden="true" />
              {connected ? 'Live' : 'Connecting'}
            </span>

            <NotificationBell />

            {user ? (
              <div className="account" ref={accountRef}>
                <button
                  ref={accountButtonRef}
                  type="button"
                  className="account-button"
                  onClick={() => setMenuOpen((current) => !current)}
                  aria-expanded={menuOpen}
                  aria-haspopup="true"
                  aria-controls="account-menu"
                >
                  <Avatar name={user.name} src={user.avatarUrl} size={34} />
                  <span className="account-name">{user.name}</span>
                  <Icon name="chevronDown" size={14} className="account-caret" />
                </button>
                {menuOpen ? (
                  <div className="account-menu" id="account-menu">
                    <div className="account-menu-head">
                      <strong>{user.name}</strong>
                      <span>{user.email}</span>
                      <RoleBadge role={user.role} />
                    </div>
                    <Link to="/settings" className="account-menu-item">
                      <Icon name="settings" size={16} />
                      账户设置
                    </Link>
                    <button
                      type="button"
                      className="account-menu-item is-danger"
                      onClick={() => void signOut()}
                      disabled={signingOut}
                    >
                      <Icon name="logout" size={16} />
                      退出登录
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </header>

        <main className="shell-main">
          <OfflineBanner />
          <Outlet />
        </main>
      </div>

      <nav className="mobile-nav" aria-label="移动端导航">
        {nav.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => cx('mobile-nav-link', isActive && 'is-active')}
          >
            <Icon name={item.icon} size={20} />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
