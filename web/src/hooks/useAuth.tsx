import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  FeatureFlags,
  Preferences,
  SessionUser,
  WorkspaceSettings,
  WorkspaceSummary,
} from '../../../shared/types.ts';
import { api } from '../api.ts';
import { setDisplayCurrency, setDisplayTimeZone } from '../format.ts';

const DEFAULT_FEATURES: FeatureFlags = {
  analytics: true,
  audit_center: true,
  webhooks: true,
  push_notifications: true,
  project_templates: true,
  enterprise: true,
};

type MfaChallenge = { mfaRequired: true; ticket: string; expiresIn: number };

type AuthContextValue = {
  user: SessionUser | null;
  preferences: Preferences | null;
  workspace: WorkspaceSettings | null;
  workspaceInfo: WorkspaceSummary | null;
  features: FeatureFlags;
  demo: boolean;
  loading: boolean;
  login: (email: string, password: string) => Promise<MfaChallenge | null>;
  completeMfa: (ticket: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  setPreferences: (preferences: Preferences) => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [preferences, setPreferencesState] = useState<Preferences | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceSettings | null>(null);
  const [workspaceInfo, setWorkspaceInfo] = useState<WorkspaceSummary | null>(null);
  const [features, setFeatures] = useState<FeatureFlags>(DEFAULT_FEATURES);
  const [demo, setDemo] = useState(false);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const state = await api.me();
      if (generation.current !== current) return;
      setUser(state.user);
      setPreferencesState(state.preferences);
      setWorkspace(state.workspace ?? null);
      setWorkspaceInfo(state.workspaceInfo ?? null);
      setFeatures({ ...DEFAULT_FEATURES, ...(state.features ?? {}) });
      setDemo(state.demo);
    } catch {
      if (generation.current !== current) return;
      setUser(null);
      setPreferencesState(null);
      setWorkspace(null);
      setWorkspaceInfo(null);
      setFeatures(DEFAULT_FEATURES);
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setDisplayTimeZone(user?.timezone);
  }, [user?.timezone]);

  useEffect(() => {
    if (workspace) setDisplayCurrency(workspace.currency);
  }, [workspace]);

  useEffect(() => {
    const expired = () => {
      setUser(null);
      setPreferencesState(null);
      setWorkspace(null);
      setWorkspaceInfo(null);
      setFeatures(DEFAULT_FEATURES);
    };
    window.addEventListener('auth:expired', expired);
    return () => window.removeEventListener('auth:expired', expired);
  }, []);

  const applySession = useCallback((state: Awaited<ReturnType<typeof api.me>>) => {
    generation.current++;
    setUser(state.user);
    setPreferencesState(state.preferences);
    setWorkspace(state.workspace ?? null);
    setWorkspaceInfo(state.workspaceInfo ?? null);
    setFeatures({ ...DEFAULT_FEATURES, ...(state.features ?? {}) });
    setDemo(state.demo ?? false);
    setLoading(false);
  }, []);

  const login = useCallback(
    async (email: string, password: string): Promise<MfaChallenge | null> => {
      generation.current++;
      const state = await api.login(email, password);
      if ('mfaRequired' in state) return state;
      applySession(state);
      return null;
    },
    [applySession],
  );

  const completeMfa = useCallback(
    async (ticket: string, code: string) => {
      const state = await api.mfaLogin(ticket, code);
      applySession(state);
    },
    [applySession],
  );

  const logout = useCallback(async () => {
    generation.current++;
    try {
      await api.logout();
    } finally {
      generation.current++;
      setUser(null);
      setPreferencesState(null);
      setWorkspace(null);
      setWorkspaceInfo(null);
      setFeatures(DEFAULT_FEATURES);
    }
  }, []);

  const setPreferences = useCallback((next: Preferences) => {
    setPreferencesState(next);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      preferences,
      workspace,
      workspaceInfo,
      features,
      demo,
      loading,
      login,
      completeMfa,
      logout,
      refresh,
      setPreferences,
    }),
    [
      user,
      preferences,
      workspace,
      workspaceInfo,
      features,
      demo,
      loading,
      login,
      completeMfa,
      logout,
      refresh,
      setPreferences,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
