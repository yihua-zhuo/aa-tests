import type { ReactNode } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { hasPermission, type Permission } from '../../shared/permissions.ts';
import type { Role } from '../../shared/types.ts';
import { Icon } from './components/Icon.tsx';
import { useAuth } from './hooks/useAuth.tsx';
import { AppShell } from './layout/AppShell.tsx';
import ActivityPage from './pages/Activity.tsx';
import AnalyticsPage from './pages/Analytics.tsx';
import AuditPage from './pages/Audit.tsx';
import EnterprisePage from './pages/Enterprise.tsx';
import LoginPage from './pages/Login.tsx';
import { ForbiddenPage, NotFoundPage } from './pages/NotFound.tsx';
import OpsPage from './pages/Ops.tsx';
import OverviewPage from './pages/Overview.tsx';
import ProjectDetailPage from './pages/ProjectDetail.tsx';
import ProjectsPage from './pages/Projects.tsx';
import SettingsPage from './pages/Settings.tsx';
import UsersPage from './pages/Users.tsx';

function BootSplash() {
  return (
    <div className="boot-splash">
      <span className="brand-glyph brand-glyph-lg" aria-hidden="true">
        <Icon name="spark" size={26} />
      </span>
      <p>正在唤醒工作台…</p>
    </div>
  );
}

function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <BootSplash />;
  if (!user) {
    return (
      <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />
    );
  }
  return <Outlet />;
}

function RequireRoles({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { user } = useAuth();
  if (!user) return null;
  if (!roles.includes(user.role)) return <ForbiddenPage />;
  return <>{children}</>;
}

function RequirePermission({
  permission,
  children,
}: {
  permission: Permission;
  children: ReactNode;
}) {
  const { user } = useAuth();
  if (!user) return null;
  if (!hasPermission(user.role, user.permissions, permission)) return <ForbiddenPage />;
  return <>{children}</>;
}

function RequireFeature({ children }: { children: ReactNode }) {
  const { features } = useAuth();
  if (!features.enterprise) return <NotFoundPage />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route index element={<OverviewPage />} />
          <Route path="analytics" element={<AnalyticsPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="projects/:id" element={<ProjectDetailPage />} />
          <Route path="activity" element={<ActivityPage />} />
          <Route
            path="enterprise"
            element={
              <RequireFeature>
                <EnterprisePage />
              </RequireFeature>
            }
          />
          <Route
            path="users"
            element={
              <RequireRoles roles={['admin', 'manager']}>
                <UsersPage />
              </RequireRoles>
            }
          />
          <Route
            path="audit"
            element={
              <RequireRoles roles={['admin']}>
                <AuditPage />
              </RequireRoles>
            }
          />
          <Route
            path="ops"
            element={
              <RequirePermission permission="workspace.manage">
                <OpsPage />
              </RequirePermission>
            }
          />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
