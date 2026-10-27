import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CURRENCIES, CURRENCY_LABELS } from '../../../shared/currencies.ts';
import { canManageUsers } from '../../../shared/permissions.ts';
import { RANGE_KEYS, RANGE_LABELS } from '../../../shared/ranges.ts';
import type {
  CurrencyCode,
  DateRangeKey,
  Preferences,
  TokenScope,
  Webhook,
  WebhookDelivery,
  WebhookEvent,
  WorkspaceSummary,
} from '../../../shared/types.ts';
import { WEBHOOK_EVENTS } from '../../../shared/types.ts';
import { WEBHOOK_EVENT_LABELS } from '../../../shared/webhooks.ts';
import { ApiError, api } from '../api.ts';
import { Icon } from '../components/Icon.tsx';
import {
  Avatar,
  DemoBadge,
  Field,
  RoleBadge,
  SegmentedControl,
  Skeleton,
  Spinner,
  Toaster,
  UpgradeCard,
} from '../components/ui.tsx';
import { formatDateTime } from '../format.ts';
import { useApi, useToast } from '../hooks/useApi.ts';
import { useAuth } from '../hooks/useAuth.tsx';
import { type Locale, useLocale } from '../i18n.ts';
import { centerCropAvatar } from '../image.ts';
import {
  canInstall,
  disablePush,
  enablePush,
  notificationPermission,
  promptInstall,
  pushSubscriptionActive,
  pushSupported,
} from '../pwa.ts';

const TIMEZONES = [
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
  'UTC',
];

const PREF_RANGES = RANGE_KEYS.filter((key) => key !== 'custom');

const SETTINGS_TABS = [
  { value: 'profile', label: '个人资料' },
  { value: 'security', label: '登录与安全' },
  { value: 'notifications', label: '通知与偏好' },
  { value: 'integrations', label: '集成' },
  { value: 'workspace', label: '工作区' },
] as const;

type SettingsTab = (typeof SETTINGS_TABS)[number]['value'];

const SETTINGS_TAB_VALUES = new Set<string>(SETTINGS_TABS.map((tab) => tab.value));

function deviceLabel(userAgent: string | null): string {
  if (!userAgent) return '未知设备';
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Firefox\//.test(userAgent)
      ? 'Firefox'
      : /Chrome\//.test(userAgent)
        ? 'Chrome'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : '浏览器';
  const os = /Windows/.test(userAgent)
    ? 'Windows'
    : /Mac OS X/.test(userAgent)
      ? 'macOS'
      : /Android/.test(userAgent)
        ? 'Android'
        : /iPhone|iPad/.test(userAgent)
          ? 'iOS'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : '';
  return os ? `${browser} · ${os}` : browser;
}

export default function SettingsPage() {
  const {
    user,
    preferences,
    workspace,
    workspaceInfo,
    setPreferences,
    refresh,
    logout,
    demo,
    features,
  } = useAuth();
  const { toasts, show, dismiss } = useToast();
  const { locale, setLocale, t } = useLocale();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const tab: SettingsTab =
    requestedTab && SETTINGS_TAB_VALUES.has(requestedTab)
      ? (requestedTab as SettingsTab)
      : 'profile';
  const setTab = (next: SettingsTab) => {
    const params = new URLSearchParams(searchParams);
    if (next === 'profile') params.delete('tab');
    else params.set('tab', next);
    setSearchParams(params, { replace: true });
  };
  const profileState = useApi((signal) => api.profile(signal), [], { live: false });
  const sessionsState = useApi((signal) => api.sessions(signal), [], { live: false });
  const mfaState = useApi((signal) => api.mfaStatus(signal), [], { live: false });
  const tokensState = useApi((signal) => api.tokens(signal), [], { live: false });
  const webhooksState = useApi((signal) => api.webhooks(signal), [], { live: false });

  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('Asia/Shanghai');
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const avatarInput = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState('');
  const [emailPassword, setEmailPassword] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pushState, setPushState] = useState<'loading' | 'on' | 'off' | 'denied' | 'unsupported'>(
    'loading',
  );
  const [pushBusy, setPushBusy] = useState(false);
  const [installable, setInstallable] = useState(canInstall);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const [prefBusy, setPrefBusy] = useState(false);
  const [prefError, setPrefError] = useState<string | null>(null);
  const [prefSaved, setPrefSaved] = useState(false);
  const [sessionBusy, setSessionBusy] = useState<string | null>(null);
  const [mfaSetup, setMfaSetup] = useState<{
    secret: string;
    otpauth: string;
    recoveryCodes: string[];
  } | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaPassword, setMfaPassword] = useState('');
  const [mfaBusy, setMfaBusy] = useState(false);
  const [mfaError, setMfaError] = useState<string | null>(null);

  const [tokenName, setTokenName] = useState('');
  const [tokenScope, setTokenScope] = useState<TokenScope>('read');
  const [tokenExpiry, setTokenExpiry] = useState('90');
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [tokenSecret, setTokenSecret] = useState<{ name: string; token: string } | null>(null);

  const [workspaceCurrency, setWorkspaceCurrency] = useState<CurrencyCode>('USD');
  const [workspaceRate, setWorkspaceRate] = useState('1');
  const [workspaceTimeLogVisibility, setWorkspaceTimeLogVisibility] = useState<
    'all' | 'managers' | 'self'
  >('all');
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspaceList, setWorkspaceList] = useState<WorkspaceSummary[]>([]);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [adminWorkspaceBusy, setAdminWorkspaceBusy] = useState(false);
  const [adminWorkspaceError, setAdminWorkspaceError] = useState<string | null>(null);
  const canAdminWorkspace = user ? canManageUsers(user.role, user.permissions) : false;

  const [hookUrl, setHookUrl] = useState('');
  const [hookEvents, setHookEvents] = useState<WebhookEvent[]>(['project.created']);
  const [hookBusy, setHookBusy] = useState(false);
  const [hookError, setHookError] = useState<string | null>(null);
  const [hookSecret, setHookSecret] = useState<{ url: string; secret: string } | null>(null);
  const [deliveries, setDeliveries] = useState<Record<string, WebhookDelivery[]>>({});
  const [deliveryBusy, setDeliveryBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!workspace) return;
    setWorkspaceCurrency(workspace.currency);
    setWorkspaceRate(String(workspace.rates[workspace.currency] ?? 1));
    setWorkspaceTimeLogVisibility(workspace.timeLogVisibility);
  }, [workspace]);

  useEffect(() => {
    if (!workspaceInfo) return;
    setWorkspaceName(workspaceInfo.name);
  }, [workspaceInfo]);

  useEffect(() => {
    if (!canAdminWorkspace) return;
    let active = true;
    void api
      .workspaces()
      .then((result) => {
        if (active) setWorkspaceList(result.workspaces);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [canAdminWorkspace]);

  useEffect(() => {
    if (profileState.data) {
      setName(profileState.data.name);
      setTimezone(profileState.data.timezone);
      setEmail(profileState.data.email);
    }
  }, [profileState.data]);

  useEffect(() => {
    if (!prefSaved) return;
    const timer = window.setTimeout(() => setPrefSaved(false), 1800);
    return () => window.clearTimeout(timer);
  }, [prefSaved]);

  useEffect(() => {
    let alive = true;
    if (!pushSupported()) {
      setPushState('unsupported');
      return;
    }
    void pushSubscriptionActive()
      .then((active) => {
        if (!alive) return;
        setPushState(active ? 'on' : notificationPermission() === 'denied' ? 'denied' : 'off');
      })
      .catch(() => {
        if (alive) setPushState('off');
      });
    const handleInstallable = () => setInstallable(true);
    const handleInstalled = () => setInstallable(false);
    window.addEventListener('pwa:installable', handleInstallable);
    window.addEventListener('pwa:installed', handleInstalled);
    return () => {
      alive = false;
      window.removeEventListener('pwa:installable', handleInstallable);
      window.removeEventListener('pwa:installed', handleInstalled);
    };
  }, []);

  const togglePush = async () => {
    if (pushBusy || pushState === 'loading') return;
    setPushBusy(true);
    try {
      if (pushState === 'on') {
        await disablePush();
        setPushState('off');
        show('已关闭浏览器通知');
      } else {
        await enablePush();
        setPushState('on');
        show('浏览器通知已开启');
      }
    } catch (cause) {
      if (notificationPermission() === 'denied') setPushState('denied');
      show(cause instanceof Error ? cause.message : '无法更新通知设置', 'error');
    } finally {
      setPushBusy(false);
    }
  };

  const installApp = async () => {
    try {
      if (await promptInstall()) show('已添加到桌面');
      else setInstallable(false);
    } catch {
      show('无法打开安装提示', 'error');
    }
  };

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    if (profileBusy) return;
    setProfileBusy(true);
    setProfileError(null);
    try {
      await api.updateProfile({
        name: name.trim(),
        timezone,
        version: profileState.data?.version,
      });
      await refresh();
      profileState.reload();
      show('个人资料已更新');
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) profileState.reload();
      setProfileError(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setProfileBusy(false);
    }
  };

  const uploadAvatar = async (event: { target: HTMLInputElement }) => {
    const file = event.target.files?.[0];
    if (!file || avatarBusy) return;
    if (!/^image\/(png|jpeg|webp|gif)$/i.test(file.type)) {
      show('头像仅支持 PNG、JPEG、WebP 或 GIF 图片', 'error');
      event.target.value = '';
      return;
    }
    if (file.size > 8_000_000) {
      show('原始图片不能超过 8MB', 'error');
      event.target.value = '';
      return;
    }
    setAvatarBusy(true);
    try {
      const cropped = await centerCropAvatar(file);
      await api.uploadAvatar(cropped);
      await refresh();
      profileState.reload();
      show('头像已更新');
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '头像上传失败', 'error');
    } finally {
      setAvatarBusy(false);
      event.target.value = '';
    }
  };

  const removeAvatar = async () => {
    if (avatarBusy) return;
    setAvatarBusy(true);
    try {
      await api.removeAvatar();
      await refresh();
      profileState.reload();
      show('头像已移除');
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '无法移除头像', 'error');
    } finally {
      setAvatarBusy(false);
    }
  };

  const saveWorkspace = async (event: FormEvent) => {
    event.preventDefault();
    const rate = Number(workspaceRate);
    if (!Number.isFinite(rate) || rate <= 0) {
      setWorkspaceError('汇率必须大于 0');
      return;
    }
    if (workspaceBusy) return;
    setWorkspaceBusy(true);
    setWorkspaceError(null);
    try {
      await api.updateWorkspace({
        currency: workspaceCurrency,
        rate,
        timeLogVisibility: workspaceTimeLogVisibility,
      });
      await refresh();
      show('工作区币种已更新');
    } catch (cause) {
      setWorkspaceError(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setWorkspaceBusy(false);
    }
  };

  const renameWorkspace = async (event: FormEvent) => {
    event.preventDefault();
    if (!workspaceInfo || adminWorkspaceBusy) return;
    if (!workspaceName.trim()) {
      setAdminWorkspaceError('工作区名称不能为空');
      return;
    }
    setAdminWorkspaceBusy(true);
    setAdminWorkspaceError(null);
    try {
      const result = await api.renameWorkspace(workspaceInfo.id, workspaceName.trim());
      setWorkspaceList((current) =>
        current.map((entry) => (entry.id === result.workspace.id ? result.workspace : entry)),
      );
      await refresh();
      show('工作区已重命名');
    } catch (cause) {
      setAdminWorkspaceError(cause instanceof Error ? cause.message : '重命名失败');
    } finally {
      setAdminWorkspaceBusy(false);
    }
  };

  const createWorkspace = async (event: FormEvent) => {
    event.preventDefault();
    if (adminWorkspaceBusy) return;
    if (!newWorkspaceName.trim()) {
      setAdminWorkspaceError('工作区名称不能为空');
      return;
    }
    setAdminWorkspaceBusy(true);
    setAdminWorkspaceError(null);
    try {
      const result = await api.createWorkspace(newWorkspaceName.trim());
      setWorkspaceList((current) => [...current, result.workspace]);
      setNewWorkspaceName('');
      show(`已创建工作区「${result.workspace.name}」`);
    } catch (cause) {
      setAdminWorkspaceError(cause instanceof Error ? cause.message : '创建失败');
    } finally {
      setAdminWorkspaceBusy(false);
    }
  };

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (passwordBusy) return;
    if (newPassword.length < 8) {
      setPasswordError('新密码至少 8 位');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('两次输入的新密码不一致');
      return;
    }
    setPasswordBusy(true);
    setPasswordError(null);
    try {
      await api.changePassword({ currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      sessionsState.reload();
      show('密码已更新，其他会话已失效');
    } catch (cause) {
      setPasswordError(cause instanceof Error ? cause.message : '修改失败');
    } finally {
      setPasswordBusy(false);
    }
  };

  const changeEmail = async (event: FormEvent) => {
    event.preventDefault();
    if (emailBusy || !profileState.data) return;
    const next = email.trim().toLowerCase();
    if (next === profileState.data.email.toLowerCase()) {
      setEmailError('新邮箱与当前邮箱相同');
      return;
    }
    setEmailBusy(true);
    setEmailError(null);
    try {
      const result = await api.changeEmail({ email: next, password: emailPassword });
      setEmailPassword('');
      await refresh();
      profileState.reload();
      sessionsState.reload();
      show(`登录邮箱已更新为 ${result.email}，其他设备已退出登录`);
    } catch (cause) {
      setEmailError(cause instanceof Error ? cause.message : '邮箱更新失败');
    } finally {
      setEmailBusy(false);
    }
  };

  const deleteAccount = async (event: FormEvent) => {
    event.preventDefault();
    if (deleteBusy || !profileState.data) return;
    if (deleteConfirm.trim().toLowerCase() !== profileState.data.email.toLowerCase()) {
      setDeleteError('请输入当前登录邮箱以确认');
      return;
    }
    if (!window.confirm('注销后账号会被匿名化，所有会话与令牌立即失效且无法恢复。确定继续？')) {
      return;
    }
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await api.deleteAccount({
        password: deletePassword,
        confirmEmail: deleteConfirm.trim().toLowerCase(),
      });
      setDeleteBusy(false);
      show('账号已注销');
      await logout();
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : '注销失败');
      setDeleteBusy(false);
    }
  };

  const startMfa = async () => {
    if (mfaBusy) return;
    setMfaBusy(true);
    setMfaError(null);
    try {
      setMfaSetup(await api.setupMfa());
    } catch (cause) {
      setMfaError(cause instanceof Error ? cause.message : '无法生成密钥');
    } finally {
      setMfaBusy(false);
    }
  };

  const enableMfa = async (event: FormEvent) => {
    event.preventDefault();
    if (mfaBusy) return;
    setMfaBusy(true);
    setMfaError(null);
    try {
      await api.enableMfa(mfaCode.trim());
      setMfaSetup(null);
      setMfaCode('');
      mfaState.reload();
      show('双因素认证已启用');
    } catch (cause) {
      setMfaError(cause instanceof Error ? cause.message : '验证失败');
    } finally {
      setMfaBusy(false);
    }
  };

  const disableMfa = async (event: FormEvent) => {
    event.preventDefault();
    if (mfaBusy) return;
    setMfaBusy(true);
    setMfaError(null);
    try {
      await api.disableMfa(mfaPassword);
      setMfaPassword('');
      mfaState.reload();
      show('双因素认证已关闭');
    } catch (cause) {
      setMfaError(cause instanceof Error ? cause.message : '关闭失败');
    } finally {
      setMfaBusy(false);
    }
  };

  const revokeSession = async (id: string) => {
    if (sessionBusy) return;
    setSessionBusy(id);
    try {
      await api.revokeSession(id);
      show('已注销该设备的会话');
      sessionsState.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '注销失败', 'error');
    } finally {
      setSessionBusy(null);
    }
  };

  const revokeOtherSessions = async () => {
    if (sessionBusy) return;
    setSessionBusy('all');
    try {
      const { revoked } = await api.revokeOtherSessions();
      show(revoked > 0 ? `已注销 ${revoked} 个其他会话` : '没有需要注销的会话');
      sessionsState.reload();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '注销失败', 'error');
    } finally {
      setSessionBusy(null);
    }
  };

  const savePreference = async (patch: Partial<Preferences>) => {
    if (!preferences || prefBusy) return;
    setPrefBusy(true);
    setPrefError(null);
    setPreferences({ ...preferences, ...patch });
    try {
      const next = await api.updatePreferences({ ...patch, version: preferences.version });
      setPreferences(next);
      setPrefSaved(true);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        const latest = await api.preferences().catch(() => preferences);
        setPreferences(latest);
      } else {
        setPreferences(preferences);
      }
      setPrefError(cause instanceof Error ? cause.message : '偏好保存失败');
    } finally {
      setPrefBusy(false);
    }
  };

  const copySecret = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      show(`${label}已复制`);
    } catch {
      show('复制失败，请手动选择文本', 'error');
    }
  };

  const createToken = async (event: FormEvent) => {
    event.preventDefault();
    if (tokenBusy) return;
    const name = tokenName.trim();
    if (!name) {
      setTokenError('请填写令牌名称');
      return;
    }
    setTokenBusy(true);
    setTokenError(null);
    try {
      const created = await api.createToken({
        name,
        scopes: [tokenScope],
        expiresInDays: tokenExpiry === 'never' ? null : Number(tokenExpiry),
      });
      setTokenSecret({ name: created.item.name, token: created.token });
      setTokenName('');
      tokensState.reload();
      show('访问令牌已创建');
    } catch (cause) {
      setTokenError(cause instanceof Error ? cause.message : '创建失败');
    } finally {
      setTokenBusy(false);
    }
  };

  const revokeToken = async (id: string) => {
    if (!window.confirm('吊销后使用该令牌的集成会立即失效，确定继续？')) return;
    try {
      await api.revokeToken(id);
      setTokenSecret(null);
      tokensState.reload();
      show('访问令牌已吊销');
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '吊销失败', 'error');
    }
  };

  const toggleHookEvent = (event: WebhookEvent) => {
    setHookEvents((current) =>
      current.includes(event) ? current.filter((item) => item !== event) : [...current, event],
    );
  };

  const createWebhook = async (event: FormEvent) => {
    event.preventDefault();
    if (hookBusy) return;
    if (hookEvents.length === 0) {
      setHookError('至少订阅一个事件');
      return;
    }
    setHookBusy(true);
    setHookError(null);
    try {
      const created = await api.createWebhook({ url: hookUrl.trim(), events: hookEvents });
      setHookSecret({ url: created.webhook.url, secret: created.secret });
      setHookUrl('');
      webhooksState.reload();
      show('Webhook 已创建');
    } catch (cause) {
      setHookError(cause instanceof Error ? cause.message : '创建失败');
    } finally {
      setHookBusy(false);
    }
  };

  const toggleWebhook = async (webhook: Webhook) => {
    try {
      await api.updateWebhook(webhook.id, { active: !webhook.active });
      webhooksState.reload();
      show(webhook.active ? 'Webhook 已停用' : 'Webhook 已启用');
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '更新失败', 'error');
    }
  };

  const removeWebhook = async (webhook: Webhook) => {
    if (!window.confirm('删除后历史投递记录也会清除，确定删除该 Webhook？')) return;
    try {
      await api.deleteWebhook(webhook.id);
      setHookSecret(null);
      webhooksState.reload();
      show('Webhook 已删除');
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '删除失败', 'error');
    }
  };

  const loadDeliveries = async (webhook: Webhook) => {
    if (deliveries[webhook.id]) {
      setDeliveries((current) => {
        const next = { ...current };
        delete next[webhook.id];
        return next;
      });
      return;
    }
    if (deliveryBusy) return;
    setDeliveryBusy(webhook.id);
    try {
      const { deliveries: rows } = await api.webhookDeliveries(webhook.id);
      setDeliveries((current) => ({ ...current, [webhook.id]: rows }));
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '无法加载投递记录', 'error');
    } finally {
      setDeliveryBusy(null);
    }
  };

  const quota = tokensState.data?.quota;
  const isDemoAccount = Boolean(
    profileState.data && /@pulse\.demo$/i.test(profileState.data.email),
  );

  return (
    <div className="page settings-page">
      <header className="page-head">
        <div className="page-head-copy">
          <p className="eyebrow">Settings</p>
          <h1>账户设置</h1>
          <p className="page-sub">
            管理个人资料、登录密码与工作台偏好。所有变更即时保存到本机 SQLite。
          </p>
        </div>
        <div className="page-head-actions">{user ? <RoleBadge role={user.role} /> : null}</div>
      </header>

      <div className="settings-tabs">
        <SegmentedControl
          options={[...SETTINGS_TABS]}
          value={tab}
          onChange={setTab}
          label="设置页签"
        />
      </div>

      <div className="settings-stack tab-panel" key={tab}>
        {tab === 'profile' ? (
          <>
            <section className="card card-pad">
              <header className="card-head">
                <div>
                  <h2>个人资料</h2>
                  <p className="card-sub">显示在活动流与项目卡片中的信息</p>
                </div>
                <Icon name="users" size={20} />
              </header>

              {!profileState.data ? (
                <div className="settings-skeleton">
                  <Skeleton height={40} />
                  <Skeleton height={40} />
                  <Skeleton height={40} />
                </div>
              ) : (
                <form className="form-grid" onSubmit={saveProfile}>
                  <Field label="姓名" htmlFor="profile-name">
                    <input
                      id="profile-name"
                      className="input"
                      value={name}
                      maxLength={80}
                      required
                      onChange={(event) => setName(event.target.value)}
                    />
                  </Field>

                  <Field label="邮箱" htmlFor="profile-email" hint="可在「登录与安全」页签修改。">
                    <input
                      id="profile-email"
                      className="input"
                      value={profileState.data.email}
                      disabled
                    />
                  </Field>

                  <Field
                    label="时区"
                    htmlFor="profile-timezone"
                    hint="界面时间按此时区展示；报表日边界使用工作区时区（WORKSPACE_TIMEZONE）。"
                  >
                    <select
                      id="profile-timezone"
                      className="input"
                      value={timezone}
                      onChange={(event) => setTimezone(event.target.value)}
                    >
                      {TIMEZONES.map((zone) => (
                        <option key={zone} value={zone}>
                          {zone}
                        </option>
                      ))}
                    </select>
                  </Field>

                  <Field label="角色">
                    <div className="readonly-pill">
                      <RoleBadge role={profileState.data.role} />
                      <span>由管理员维护</span>
                    </div>
                  </Field>

                  <dl className="profile-meta form-span-2">
                    <div>
                      <dt>加入时间</dt>
                      <dd>{formatDateTime(profileState.data.createdAt)}</dd>
                    </div>
                    <div>
                      <dt>上次登录</dt>
                      <dd>
                        {profileState.data.lastLoginAt
                          ? formatDateTime(profileState.data.lastLoginAt)
                          : '—'}
                      </dd>
                    </div>
                  </dl>

                  {profileError ? (
                    <div className="form-error form-span-2" role="alert">
                      <Icon name="alert" size={16} />
                      {profileError}
                    </div>
                  ) : null}

                  <div className="form-actions form-span-2">
                    <button type="submit" className="btn btn-primary" disabled={profileBusy}>
                      {profileBusy ? <span className="spinner" /> : <Icon name="check" size={16} />}
                      保存资料
                    </button>
                  </div>
                </form>
              )}
            </section>

            <section className="card card-pad">
              <header className="card-head">
                <div>
                  <h2>头像</h2>
                  <p className="card-sub">上传后自动居中裁切为 256×256 的方形 JPEG。</p>
                </div>
                <Icon name="users" size={20} />
              </header>
              <div className="avatar-editor">
                <Avatar
                  name={profileState.data?.name ?? user?.name ?? '成员'}
                  src={profileState.data?.avatarUrl ?? user?.avatarUrl}
                  size={72}
                />
                <div className="avatar-editor-copy">
                  <p>支持 PNG、JPEG、WebP 或 GIF，原始图片最大 8MB。</p>
                  <div className="avatar-editor-actions">
                    <input
                      ref={avatarInput}
                      id="avatar-file"
                      className="visually-hidden"
                      type="file"
                      aria-label="选择头像图片"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      onChange={(event) => void uploadAvatar(event)}
                    />
                    <button
                      type="button"
                      className="btn btn-soft btn-sm"
                      onClick={() => avatarInput.current?.click()}
                      disabled={avatarBusy}
                    >
                      {avatarBusy ? <Spinner size={15} /> : <Icon name="upload" size={15} />}
                      {profileState.data?.avatarUrl ? '更换头像' : '上传头像'}
                    </button>
                    {profileState.data?.avatarUrl ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => void removeAvatar()}
                        disabled={avatarBusy}
                      >
                        移除
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            </section>
          </>
        ) : null}

        {tab === 'notifications' ? (
          <section className="card card-pad">
            <header className="card-head">
              <div>
                <h2>浏览器通知与安装</h2>
                <p className="card-sub">在离线或切到后台时也能收到指派、评论与提醒。</p>
              </div>
              <Icon name="bell" size={20} />
            </header>
            <div className="pwa-actions">
              {features.push_notifications ? (
                <button
                  type="button"
                  className="btn btn-soft"
                  onClick={() => void togglePush()}
                  disabled={pushBusy || pushState === 'loading' || pushState === 'unsupported'}
                >
                  {pushBusy ? (
                    <Spinner size={15} />
                  ) : (
                    <Icon name={pushState === 'on' ? 'check' : 'bell'} size={15} />
                  )}
                  {pushState === 'on' ? '关闭浏览器通知' : '开启浏览器通知'}
                </button>
              ) : null}
              {installable ? (
                <button type="button" className="btn btn-ghost" onClick={() => void installApp()}>
                  <Icon name="download" size={15} />
                  安装到桌面
                </button>
              ) : null}
            </div>
            {features.push_notifications ? (
              <p className="pwa-hint">
                {pushState === 'loading'
                  ? '正在检查通知权限…'
                  : pushState === 'on'
                    ? '已开启：新通知会通过系统推送送达当前浏览器。'
                    : pushState === 'denied'
                      ? '浏览器已阻止通知，请在站点设置中允许通知后刷新页面。'
                      : pushState === 'unsupported'
                        ? '当前浏览器不支持 Web Push（需要 HTTPS 与 Service Worker）。'
                        : '未开启：仍可在应用内的通知中心查看全部消息。'}
              </p>
            ) : null}
            <p className="pwa-hint">离线时应用会保留最近同步的只读快照；重新联网后自动刷新。</p>
          </section>
        ) : null}

        {tab === 'security' ? (
          <>
            <section className="card card-pad">
              <header className="card-head">
                <div>
                  <h2>登录邮箱</h2>
                  <p className="card-sub">
                    修改后其他设备会自动退出；尚未发送的通知邮件会改投新地址。
                  </p>
                </div>
                <Icon name="mail" size={20} />
              </header>

              {!profileState.data ? (
                <div className="settings-skeleton">
                  <Skeleton height={40} />
                  <Skeleton height={40} />
                </div>
              ) : isDemoAccount ? (
                <p className="card-note">演示账号使用固定邮箱，请在正式环境中修改登录邮箱。</p>
              ) : (
                <form className="form-grid" onSubmit={changeEmail}>
                  <div className="form-span-2">
                    <Field
                      label="新邮箱"
                      htmlFor="profile-email-new"
                      hint={`当前邮箱：${profileState.data.email}`}
                    >
                      <input
                        id="profile-email-new"
                        type="email"
                        className="input"
                        autoComplete="email"
                        value={email}
                        maxLength={160}
                        required
                        onChange={(event) => setEmail(event.target.value)}
                      />
                    </Field>
                  </div>
                  <div className="form-span-2">
                    <Field
                      label="当前密码（邮箱验证）"
                      htmlFor="profile-email-password"
                      hint="修改登录邮箱前需要验证当前密码。"
                    >
                      <input
                        id="profile-email-password"
                        type="password"
                        className="input"
                        autoComplete="current-password"
                        value={emailPassword}
                        required
                        onChange={(event) => setEmailPassword(event.target.value)}
                      />
                    </Field>
                  </div>
                  {emailError ? (
                    <div className="form-error form-span-2" role="alert">
                      <Icon name="alert" size={16} />
                      {emailError}
                    </div>
                  ) : null}
                  <div className="form-actions form-span-2">
                    <button type="submit" className="btn btn-primary" disabled={emailBusy}>
                      {emailBusy ? <span className="spinner" /> : <Icon name="mail" size={16} />}
                      更新邮箱
                    </button>
                  </div>
                </form>
              )}
            </section>

            <section className="card card-pad">
              <header className="card-head">
                <div>
                  <h2>修改密码</h2>
                  <p className="card-sub">修改后会吊销其他设备上的全部会话，并自动刷新当前登录。</p>
                </div>
                <Icon name="lock" size={20} />
              </header>

              <form className="form-grid" onSubmit={changePassword}>
                <div className="form-span-2">
                  <Field label="当前密码" htmlFor="password-current">
                    <input
                      id="password-current"
                      type="password"
                      className="input"
                      autoComplete="current-password"
                      value={currentPassword}
                      required
                      onChange={(event) => setCurrentPassword(event.target.value)}
                    />
                  </Field>
                </div>
                <Field label="新密码" htmlFor="password-new" hint="至少 8 位。">
                  <input
                    id="password-new"
                    type="password"
                    className="input"
                    autoComplete="new-password"
                    minLength={8}
                    value={newPassword}
                    required
                    onChange={(event) => setNewPassword(event.target.value)}
                  />
                </Field>
                <Field label="确认新密码" htmlFor="password-confirm">
                  <input
                    id="password-confirm"
                    type="password"
                    className="input"
                    autoComplete="new-password"
                    minLength={8}
                    value={confirmPassword}
                    required
                    onChange={(event) => setConfirmPassword(event.target.value)}
                  />
                </Field>

                {passwordError ? (
                  <div className="form-error form-span-2" role="alert">
                    <Icon name="alert" size={16} />
                    {passwordError}
                  </div>
                ) : null}

                <div className="form-actions form-span-2">
                  <button type="submit" className="btn btn-primary" disabled={passwordBusy}>
                    {passwordBusy ? <span className="spinner" /> : <Icon name="key" size={16} />}
                    更新密码
                  </button>
                </div>
              </form>
            </section>

            <section className="card card-pad">
              <header className="card-head">
                <div>
                  <h2>双因素认证</h2>
                  <p className="card-sub">
                    使用 TOTP 验证器（1Password、Google Authenticator 等）保护账号。
                  </p>
                </div>
                <Icon name="shield" size={20} />
              </header>

              {mfaState.data?.enabled ? (
                <form className="form-grid" onSubmit={disableMfa}>
                  <div className="form-span-2">
                    <p className="mfa-status">
                      <span className="badge" data-tone="success">
                        已启用
                      </span>
                      每次登录都需要输入验证码或备用码。
                    </p>
                  </div>
                  <Field
                    label="确认密码"
                    htmlFor="mfa-password"
                    hint="关闭双因素认证需要验证当前密码。"
                  >
                    <input
                      id="mfa-password"
                      type="password"
                      className="input"
                      autoComplete="current-password"
                      value={mfaPassword}
                      required
                      onChange={(event) => setMfaPassword(event.target.value)}
                    />
                  </Field>
                  {mfaError ? (
                    <p className="field-error form-span-2" role="alert">
                      {mfaError}
                    </p>
                  ) : null}
                  <div className="form-actions form-span-2">
                    <button type="submit" className="btn btn-ghost" disabled={mfaBusy}>
                      {mfaBusy ? <span className="spinner" /> : <Icon name="lock" size={16} />}
                      关闭双因素认证
                    </button>
                  </div>
                </form>
              ) : mfaSetup ? (
                <div className="mfa-setup">
                  <p className="muted">
                    1. 在验证器中添加账户，手动输入密钥
                    <code className="mfa-secret">{mfaSetup.secret}</code>
                    或导入 <code>{mfaSetup.otpauth}</code>。
                  </p>
                  <p className="muted">2. 妥善保存以下备用码，每个只能使用一次：</p>
                  <ul className="mfa-recovery">
                    {mfaSetup.recoveryCodes.map((code) => (
                      <li key={code}>
                        <code>{code}</code>
                      </li>
                    ))}
                  </ul>
                  <form className="form-grid" onSubmit={enableMfa}>
                    <Field label="验证码" htmlFor="mfa-code" hint="输入验证器当前显示的 6 位数字。">
                      <input
                        id="mfa-code"
                        className="input"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        value={mfaCode}
                        required
                        onChange={(event) => setMfaCode(event.target.value)}
                      />
                    </Field>
                    {mfaError ? (
                      <p className="field-error form-span-2" role="alert">
                        {mfaError}
                      </p>
                    ) : null}
                    <div className="form-actions form-span-2">
                      <button type="submit" className="btn btn-primary" disabled={mfaBusy}>
                        {mfaBusy ? <span className="spinner" /> : <Icon name="check" size={16} />}
                        验证并启用
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => {
                          setMfaSetup(null);
                          setMfaError(null);
                        }}
                      >
                        取消
                      </button>
                    </div>
                  </form>
                </div>
              ) : (
                <div className="form-actions">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => void startMfa()}
                    disabled={mfaBusy}
                  >
                    {mfaBusy ? <span className="spinner" /> : <Icon name="shield" size={16} />}
                    启用双因素认证
                  </button>
                  {mfaError ? (
                    <p className="field-error" role="alert">
                      {mfaError}
                    </p>
                  ) : null}
                </div>
              )}
            </section>
          </>
        ) : null}

        {tab === 'notifications' ? (
          <section className="card card-pad">
            <header className="card-head">
              <div>
                <h2>工作台偏好</h2>
                <p className="card-sub">
                  自动保存 · {prefBusy ? '保存中…' : prefSaved ? '已保存' : '仅作用于当前账户'}
                </p>
              </div>
              <Icon name="settings" size={20} />
            </header>

            {preferences ? (
              <div className="pref-list">
                <div className="pref-row">
                  <div>
                    <strong>{t('settings.language')}</strong>
                    <span>{t('settings.language.hint')}</span>
                  </div>
                  <select
                    className="input input-sm pref-select"
                    aria-label={t('settings.language')}
                    value={locale}
                    onChange={(event) => setLocale(event.target.value as Locale)}
                  >
                    <option value="zh-CN">{t('common.language.zh')}</option>
                    <option value="en">{t('common.language.en')}</option>
                  </select>
                </div>

                <div className="pref-row">
                  <div>
                    <strong>默认时间范围</strong>
                    <span>Overview 打开时使用的日期范围</span>
                  </div>
                  <select
                    className="input input-sm pref-select"
                    aria-label="默认时间范围"
                    value={preferences.defaultRange}
                    onChange={(event) =>
                      void savePreference({ defaultRange: event.target.value as DateRangeKey })
                    }
                  >
                    {PREF_RANGES.map((key) => (
                      <option key={key} value={key}>
                        {RANGE_LABELS[key]}
                      </option>
                    ))}
                  </select>
                </div>

                <label className="pref-row">
                  <div>
                    <strong>邮件通知</strong>
                    <span>新通知会进入邮件队列；配置 SMTP 后才会实际发送。</span>
                  </div>
                  <span className="switch">
                    <input
                      type="checkbox"
                      checked={preferences.emailNotifications}
                      onChange={(event) =>
                        void savePreference({ emailNotifications: event.target.checked })
                      }
                    />
                    <span className="switch-track" aria-hidden="true" />
                  </span>
                </label>

                <label className="pref-row">
                  <div>
                    <strong>每周摘要</strong>
                    <span>每周汇总未读通知，需同时开启邮件通知。</span>
                  </div>
                  <span className="switch">
                    <input
                      type="checkbox"
                      checked={preferences.weeklyDigest}
                      onChange={(event) =>
                        void savePreference({ weeklyDigest: event.target.checked })
                      }
                    />
                    <span className="switch-track" aria-hidden="true" />
                  </span>
                </label>

                <label className="pref-row">
                  <div>
                    <strong>收起侧栏</strong>
                    <span>为内容区腾出更多空间</span>
                  </div>
                  <span className="switch">
                    <input
                      type="checkbox"
                      checked={preferences.sidebarCollapsed}
                      onChange={(event) =>
                        void savePreference({ sidebarCollapsed: event.target.checked })
                      }
                    />
                    <span className="switch-track" aria-hidden="true" />
                  </span>
                </label>

                {prefError ? <p className="field-error">{prefError}</p> : null}
              </div>
            ) : (
              <div className="settings-skeleton">
                <Skeleton height={44} />
                <Skeleton height={44} />
                <Skeleton height={44} />
              </div>
            )}
          </section>
        ) : null}

        {tab === 'security' ? (
          <>
            <section className="card card-pad">
              <header className="card-head">
                <div>
                  <h2>登录设备</h2>
                  <p className="card-sub">
                    {sessionsState.data
                      ? `${sessionsState.data.sessions.length} 个活跃会话 · 修改密码会自动注销其他设备`
                      : '正在加载…'}
                  </p>
                </div>
                <Icon name="shield" size={20} />
              </header>

              {sessionsState.data ? (
                <div className="pref-list">
                  {sessionsState.data.sessions.map((session) => (
                    <div className="pref-row" key={session.id}>
                      <div>
                        <strong>
                          {deviceLabel(session.userAgent)}
                          {session.current ? <span className="self-tag">当前</span> : null}
                        </strong>
                        <span>
                          {session.ip ?? '未知 IP'} · 最近活动 {formatDateTime(session.lastSeenAt)}
                        </span>
                      </div>
                      {session.current ? (
                        <span className="status-text is-active">
                          <span className="live-dot" aria-hidden="true" />
                          使用中
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs"
                          disabled={sessionBusy !== null}
                          onClick={() => void revokeSession(session.id)}
                        >
                          {sessionBusy === session.id ? (
                            <Spinner size={14} />
                          ) : (
                            <Icon name="lock" size={14} />
                          )}
                          注销
                        </button>
                      )}
                    </div>
                  ))}
                  {sessionsState.data.sessions.some((session) => !session.current) ? (
                    <button
                      type="button"
                      className="btn btn-soft btn-sm"
                      disabled={sessionBusy !== null}
                      onClick={() => void revokeOtherSessions()}
                    >
                      {sessionBusy === 'all' ? (
                        <Spinner size={16} />
                      ) : (
                        <Icon name="lock" size={16} />
                      )}
                      注销其他设备
                    </button>
                  ) : null}
                </div>
              ) : (
                <div className="settings-skeleton">
                  <Skeleton height={44} />
                  <Skeleton height={44} />
                </div>
              )}
            </section>

            <section className="card card-pad">
              <header className="card-head">
                <div>
                  <h2>个人访问令牌</h2>
                  <p className="card-sub">
                    {quota
                      ? `用于脚本与集成的 Bearer 令牌 · 每分钟 ${quota.max} 次请求额度`
                      : '用于脚本与集成的 Bearer 令牌'}
                  </p>
                </div>
                <Icon name="key" size={20} />
              </header>

              {tokenSecret ? (
                <div className="secret-banner" role="status">
                  <div className="secret-copy">
                    <strong>令牌「{tokenSecret.name}」仅显示一次</strong>
                    <code className="secret-value">{tokenSecret.token}</code>
                  </div>
                  <div className="secret-actions">
                    <button
                      type="button"
                      className="btn btn-soft btn-xs"
                      onClick={() => void copySecret(tokenSecret.token, '令牌')}
                    >
                      <Icon name="key" size={14} />
                      复制
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs"
                      onClick={() => setTokenSecret(null)}
                    >
                      关闭
                    </button>
                  </div>
                </div>
              ) : null}

              <form className="form-grid" onSubmit={createToken}>
                <Field label="名称" htmlFor="token-name">
                  <input
                    id="token-name"
                    className="input"
                    value={tokenName}
                    maxLength={80}
                    placeholder="例如：报表导出脚本"
                    onChange={(event) => setTokenName(event.target.value)}
                  />
                </Field>
                <Field label="权限范围" htmlFor="token-scope">
                  <select
                    id="token-scope"
                    className="input"
                    value={tokenScope}
                    onChange={(event) => setTokenScope(event.target.value as TokenScope)}
                  >
                    <option value="read">只读（GET / HEAD）</option>
                    <option value="write">读写（含写入接口）</option>
                  </select>
                </Field>
                <Field label="有效期" htmlFor="token-expiry">
                  <select
                    id="token-expiry"
                    className="input"
                    value={tokenExpiry}
                    onChange={(event) => setTokenExpiry(event.target.value)}
                  >
                    <option value="30">30 天</option>
                    <option value="90">90 天</option>
                    <option value="365">1 年</option>
                    <option value="never">永不过期</option>
                  </select>
                </Field>
                <div className="form-span-2">
                  {tokenError ? (
                    <p className="field-error" role="alert">
                      {tokenError}
                    </p>
                  ) : null}
                  <p className="card-note">
                    令牌无法管理令牌、Webhook、密码、双因素与登录会话；吊销后立即失效。
                  </p>
                </div>
                <div className="form-actions form-span-2">
                  <button type="submit" className="btn btn-primary" disabled={tokenBusy}>
                    {tokenBusy ? <span className="spinner" /> : <Icon name="plus" size={16} />}
                    创建令牌
                  </button>
                </div>
              </form>

              <div className="integration-list">
                {tokensState.data ? (
                  tokensState.data.tokens.length === 0 ? (
                    <p className="muted">还没有令牌。</p>
                  ) : (
                    tokensState.data.tokens.map((token) => (
                      <div className="integration-row" key={token.id}>
                        <div className="integration-main">
                          <strong>{token.name}</strong>
                          <span>
                            {token.scopes.map((scope) => (
                              <span className="badge" data-tone="muted" key={scope}>
                                {scope === 'read' ? '只读' : '读写'}
                              </span>
                            ))}
                            <span>创建于 {formatDateTime(token.createdAt)}</span>
                          </span>
                          <span>
                            {token.revokedAt
                              ? `已吊销 ${formatDateTime(token.revokedAt)}`
                              : token.expired
                                ? '已过期'
                                : token.expiresAt
                                  ? `有效期至 ${formatDateTime(token.expiresAt)}`
                                  : '永不过期'}
                            {token.lastUsedAt
                              ? ` · 最近使用 ${formatDateTime(token.lastUsedAt)}`
                              : ' · 尚未使用'}
                          </span>
                        </div>
                        <div className="integration-actions">
                          {token.revokedAt ? (
                            <span className="badge" data-tone="danger">
                              已吊销
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-ghost btn-xs"
                              onClick={() => void revokeToken(token.id)}
                            >
                              <Icon name="trash" size={14} />
                              吊销
                            </button>
                          )}
                        </div>
                      </div>
                    ))
                  )
                ) : (
                  <div className="settings-skeleton">
                    <Skeleton height={44} />
                    <Skeleton height={44} />
                  </div>
                )}
              </div>
            </section>

            <section className="card card-pad settings-danger">
              <header className="card-head">
                <div>
                  <h2>注销账号</h2>
                  <p className="card-sub">永久删除账号并匿名化历史记录，此操作不可撤销。</p>
                </div>
                <Icon name="alert" size={20} />
              </header>

              {!profileState.data ? (
                <div className="settings-skeleton">
                  <Skeleton height={40} />
                  <Skeleton height={40} />
                </div>
              ) : isDemoAccount ? (
                <p className="card-note">演示账号不能注销。</p>
              ) : (
                <>
                  <p className="card-note">
                    注销后所有会话、访问令牌与 Webhook
                    立即失效；你创建的项目会转交给同工作区的其他管理员。
                  </p>
                  <form className="form-grid" onSubmit={deleteAccount}>
                    <div className="form-span-2">
                      <Field
                        label="当前密码（注销验证）"
                        htmlFor="delete-password"
                        hint="用于确认是本人操作。"
                      >
                        <input
                          id="delete-password"
                          type="password"
                          className="input"
                          autoComplete="current-password"
                          value={deletePassword}
                          required
                          onChange={(event) => setDeletePassword(event.target.value)}
                        />
                      </Field>
                    </div>
                    <div className="form-span-2">
                      <Field
                        label="确认登录邮箱"
                        htmlFor="delete-confirm"
                        hint={`输入 ${profileState.data.email} 以确认删除。`}
                      >
                        <input
                          id="delete-confirm"
                          type="email"
                          className="input"
                          autoComplete="off"
                          value={deleteConfirm}
                          required
                          onChange={(event) => setDeleteConfirm(event.target.value)}
                        />
                      </Field>
                    </div>
                    {deleteError ? (
                      <div className="form-error form-span-2" role="alert">
                        <Icon name="alert" size={16} />
                        {deleteError}
                      </div>
                    ) : null}
                    <div className="form-actions form-span-2">
                      <button type="submit" className="btn btn-danger" disabled={deleteBusy}>
                        {deleteBusy ? (
                          <span className="spinner" />
                        ) : (
                          <Icon name="trash" size={16} />
                        )}
                        永久注销账号
                      </button>
                    </div>
                  </form>
                </>
              )}
            </section>
          </>
        ) : null}

        {tab === 'integrations' && features.webhooks ? (
          <section className="card card-pad">
            <header className="card-head">
              <div>
                <h2>Webhook 集成</h2>
                <p className="card-sub">
                  项目与你可见的活动会以签名 POST 推送到指定地址，失败自动重试。
                </p>
              </div>
              <Icon name="globe" size={20} />
            </header>

            {hookSecret ? (
              <div className="secret-banner" role="status">
                <div className="secret-copy">
                  <strong>签名密钥仅显示一次（{hookSecret.url}）</strong>
                  <code className="secret-value">{hookSecret.secret}</code>
                </div>
                <div className="secret-actions">
                  <button
                    type="button"
                    className="btn btn-soft btn-xs"
                    onClick={() => void copySecret(hookSecret.secret, '签名密钥')}
                  >
                    <Icon name="key" size={14} />
                    复制
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    onClick={() => setHookSecret(null)}
                  >
                    关闭
                  </button>
                </div>
              </div>
            ) : null}

            <form className="form-grid" onSubmit={createWebhook}>
              <div className="form-span-2">
                <Field
                  label="回调地址"
                  htmlFor="hook-url"
                  hint="必须为公网 HTTPS/HTTP 地址，禁止 localhost 与内网主机。"
                >
                  <input
                    id="hook-url"
                    className="input"
                    value={hookUrl}
                    maxLength={500}
                    placeholder="https://hooks.example.com/clay"
                    onChange={(event) => setHookUrl(event.target.value)}
                  />
                </Field>
              </div>
              <div className="form-span-2">
                <span className="field-label">订阅事件</span>
                <div className="event-chips" role="group" aria-label="订阅事件">
                  {WEBHOOK_EVENTS.map((event) => (
                    <label
                      key={event}
                      className="event-chip"
                      data-checked={hookEvents.includes(event) ? 'true' : undefined}
                    >
                      <input
                        type="checkbox"
                        checked={hookEvents.includes(event)}
                        onChange={() => toggleHookEvent(event)}
                      />
                      <span>{WEBHOOK_EVENT_LABELS[event]}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="form-span-2">
                {hookError ? (
                  <p className="field-error" role="alert">
                    {hookError}
                  </p>
                ) : null}
                <p className="card-note">
                  请求头包含 <code>x-clay-event</code>、<code>x-clay-delivery</code>、
                  <code>x-clay-timestamp</code> 与 <code>x-clay-signature</code>。
                </p>
              </div>
              <div className="form-actions form-span-2">
                <button type="submit" className="btn btn-primary" disabled={hookBusy}>
                  {hookBusy ? <span className="spinner" /> : <Icon name="plus" size={16} />}
                  添加 Webhook
                </button>
              </div>
            </form>

            <div className="integration-list">
              {webhooksState.data ? (
                webhooksState.data.webhooks.length === 0 ? (
                  <p className="muted">还没有 Webhook。</p>
                ) : (
                  webhooksState.data.webhooks.map((webhook) => {
                    const rows = deliveries[webhook.id];
                    return (
                      <div className="integration-row" key={webhook.id}>
                        <div className="integration-main">
                          <strong>{webhook.url}</strong>
                          <span>
                            {webhook.events.map((event) => WEBHOOK_EVENT_LABELS[event]).join('、')}
                          </span>
                          <span>
                            {webhook.active ? '已启用' : '已停用'}
                            {webhook.lastStatus
                              ? ` · 最近投递${
                                  webhook.lastStatus === 'sent'
                                    ? '成功'
                                    : webhook.lastStatus === 'failed'
                                      ? '失败'
                                      : '排队中'
                                }${webhook.lastDeliveryAt ? ` ${formatDateTime(webhook.lastDeliveryAt)}` : ''}`
                              : ' · 暂无投递'}
                          </span>
                        </div>
                        <div className="integration-actions">
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs"
                            disabled={deliveryBusy === webhook.id}
                            onClick={() => void loadDeliveries(webhook)}
                          >
                            {deliveryBusy === webhook.id ? (
                              <Spinner size={14} />
                            ) : (
                              <Icon name="activity" size={14} />
                            )}
                            投递记录
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs"
                            onClick={() => void toggleWebhook(webhook)}
                          >
                            {webhook.active ? '停用' : '启用'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs"
                            onClick={() => void removeWebhook(webhook)}
                          >
                            <Icon name="trash" size={14} />
                            删除
                          </button>
                        </div>
                        {rows ? (
                          <ul className="delivery-list">
                            {rows.length === 0 ? (
                              <li className="muted">暂无投递记录</li>
                            ) : (
                              rows.map((delivery) => (
                                <li key={delivery.id}>
                                  <span>{WEBHOOK_EVENT_LABELS[delivery.event]}</span>
                                  <span
                                    className="badge"
                                    data-tone={
                                      delivery.status === 'sent'
                                        ? 'success'
                                        : delivery.status === 'failed'
                                          ? 'danger'
                                          : 'muted'
                                    }
                                  >
                                    {delivery.status === 'sent'
                                      ? '成功'
                                      : delivery.status === 'failed'
                                        ? '失败'
                                        : '排队中'}
                                  </span>
                                  <span>
                                    {delivery.attempts} 次尝试
                                    {delivery.responseStatus
                                      ? ` · HTTP ${delivery.responseStatus}`
                                      : ''}
                                  </span>
                                  <time>{formatDateTime(delivery.createdAt)}</time>
                                </li>
                              ))
                            )}
                          </ul>
                        ) : null}
                      </div>
                    );
                  })
                )
              ) : (
                <div className="settings-skeleton">
                  <Skeleton height={44} />
                  <Skeleton height={44} />
                </div>
              )}
            </div>
          </section>
        ) : null}

        {tab === 'workspace' && canAdminWorkspace ? (
          <section className="card card-pad">
            <header className="card-head">
              <div>
                <h2>工作区</h2>
                <p className="card-sub">
                  工作区隔离项目与成员；成员管理中可把新成员分配到不同工作区。
                </p>
              </div>
              <Icon name="users" size={20} />
            </header>
            {workspaceInfo ? (
              <form className="form-grid" onSubmit={renameWorkspace}>
                <Field
                  label="当前工作区"
                  htmlFor="workspace-admin-name"
                  hint={`${workspaceInfo.memberCount} 名成员 · ${workspaceInfo.projectCount} 个项目`}
                >
                  <input
                    id="workspace-admin-name"
                    className="input"
                    value={workspaceName}
                    maxLength={60}
                    required
                    onChange={(event) => setWorkspaceName(event.target.value)}
                  />
                </Field>
                <div className="form-span-2">
                  <button type="submit" className="btn btn-primary" disabled={adminWorkspaceBusy}>
                    {adminWorkspaceBusy ? <Spinner size={16} /> : null}
                    重命名工作区
                  </button>
                </div>
              </form>
            ) : null}
            <form className="form-grid" onSubmit={createWorkspace}>
              <Field
                label="新建工作区"
                htmlFor="workspace-new-name"
                hint={`当前共 ${workspaceList.length} 个工作区。`}
              >
                <input
                  id="workspace-new-name"
                  className="input"
                  value={newWorkspaceName}
                  maxLength={60}
                  onChange={(event) => setNewWorkspaceName(event.target.value)}
                  placeholder="例如：华东团队"
                />
              </Field>
              <div className="form-span-2">
                <button
                  type="submit"
                  className="btn btn-soft"
                  disabled={adminWorkspaceBusy || newWorkspaceName.trim() === ''}
                >
                  创建工作区
                </button>
              </div>
            </form>
            {adminWorkspaceError ? (
              <p className="field-error" role="alert">
                {adminWorkspaceError}
              </p>
            ) : null}
          </section>
        ) : null}

        {tab === 'workspace' && user?.role === 'admin' ? (
          <section className="card card-pad">
            <header className="card-head">
              <div>
                <h2>工作区币种</h2>
                <p className="card-sub">影响分析报表金额展示与指标导入换算</p>
              </div>
              <Icon name="settings" size={20} />
            </header>
            <form className="form-grid" onSubmit={saveWorkspace}>
              <Field
                label="展示币种"
                htmlFor="workspace-currency"
                hint="日指标以美元为基准存储，读取时按汇率换算。"
              >
                <select
                  id="workspace-currency"
                  className="input"
                  value={workspaceCurrency}
                  onChange={(event) => {
                    const code = event.target.value as CurrencyCode;
                    setWorkspaceCurrency(code);
                    setWorkspaceRate(String(workspace?.rates[code] ?? 1));
                  }}
                >
                  {CURRENCIES.map((code) => (
                    <option key={code} value={code}>
                      {CURRENCY_LABELS[code]}（{code}）
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="每 1 美元折算"
                htmlFor="workspace-rate"
                hint={`当前使用的 ${workspaceCurrency} 汇率`}
              >
                <input
                  id="workspace-rate"
                  className="input"
                  type="number"
                  min="0.0001"
                  step="0.0001"
                  value={workspaceRate}
                  onChange={(event) => setWorkspaceRate(event.target.value)}
                />
              </Field>
              <Field
                label="工时可见范围"
                htmlFor="workspace-time-log-visibility"
                hint="控制成员能否查看全部、仅管理者或仅自己的工时记录。"
              >
                <select
                  id="workspace-time-log-visibility"
                  className="input"
                  value={workspaceTimeLogVisibility}
                  onChange={(event) =>
                    setWorkspaceTimeLogVisibility(event.target.value as 'all' | 'managers' | 'self')
                  }
                >
                  <option value="all">所有成员可见</option>
                  <option value="managers">仅管理者可见</option>
                  <option value="self">仅本人可见</option>
                </select>
              </Field>
              {workspaceError ? <p className="field-error form-span-2">{workspaceError}</p> : null}
              <div className="form-span-2">
                <button type="submit" className="btn btn-primary" disabled={workspaceBusy}>
                  {workspaceBusy ? <Spinner size={16} /> : null}
                  保存币种设置
                </button>
              </div>
            </form>
          </section>
        ) : null}

        {tab === 'workspace' ? (
          <>
            <section className="card card-pad demo-info-card">
              <header className="card-head">
                <div>
                  <div className="card-title-row">
                    <h2>演示数据</h2>
                    {demo ? <DemoBadge /> : null}
                  </div>
                  <p className="card-sub">了解哪些数据是真实的</p>
                </div>
                <Icon name="database" size={20} />
              </header>
              <ul className="info-list">
                <li>
                  <Icon name="trend" size={16} />
                  <span>
                    <strong>收入 / 客户 / 渠道</strong>
                    演示环境由种子脚本生成 730 天数据；生产环境可通过分析页的 CSV/API
                    导入真实日指标。
                  </span>
                </li>
                <li>
                  <Icon name="projects" size={16} />
                  <span>
                    <strong>项目与活动</strong>
                    来自真实 SQLite 操作；示例项目带有 <DemoBadge label="Demo" /> 标记。
                  </span>
                </li>
                <li>
                  <Icon name="shield" size={16} />
                  <span>
                    <strong>账户安全</strong>
                    密码 scrypt 加盐、Session 仅存哈希、HttpOnly Cookie，登录限流 10 次/15 分钟。
                  </span>
                </li>
              </ul>
              {demo ? (
                <p className="card-note">
                  演示账号共享密码 <code>Demo1234!</code>；设置 <code>DEMO_MODE=0</code>{' '}
                  后演示账号将无法登录。
                </p>
              ) : null}
            </section>

            <UpgradeCard />
          </>
        ) : null}
      </div>

      <Toaster toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
