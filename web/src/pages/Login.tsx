import { type FormEvent, useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import type { Role } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { Icon, IconTile } from '../components/Icon.tsx';
import { Avatar, RoleBadge } from '../components/ui.tsx';
import { useAuth } from '../hooks/useAuth.tsx';

type DemoAccount = { email: string; name: string; role: Role };

export default function LoginPage() {
  const { user, loading, login, completeMfa } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState<{ password: string; users: DemoAccount[] } | null>(null);
  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [resetMode, setResetMode] = useState(false);
  const [resetStep, setResetStep] = useState<'request' | 'confirm'>('request');
  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api
      .demoUsers()
      .then((payload) => {
        if (active) setDemo(payload);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  if (!loading && user) {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from && from !== '/login' ? from : '/'} replace />;
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (resetMode) {
        if (resetStep === 'request') {
          const payload = await api.requestPasswordReset(email.trim());
          if (payload.resetToken) {
            setResetToken(payload.resetToken);
            setResetStep('confirm');
            setNotice('开发模式：重置令牌已生成，请在下方设置新密码。');
          } else {
            setNotice('如果该邮箱对应可用账号，重置链接已发送，请在 30 分钟内完成。');
          }
        } else {
          await api.confirmPasswordReset(resetToken.trim(), newPassword);
          setResetMode(false);
          setResetStep('request');
          setResetToken('');
          setNewPassword('');
          setNotice('密码已重置，请使用新密码登录。');
        }
        return;
      }
      if (ticket) {
        await completeMfa(ticket, code.trim());
      } else {
        const challenge = await login(email.trim(), password);
        if (challenge) {
          setTicket(challenge.ticket);
          setCode('');
          return;
        }
      }
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from !== '/login' ? from : '/', { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '登录失败，请稍后再试');
    } finally {
      setBusy(false);
    }
  };

  const fill = (account: DemoAccount) => {
    setEmail(account.email);
    setPassword(demo?.password ?? '');
    setError(null);
  };

  return (
    <div className="login-page">
      <section className="login-brand">
        <span className="clay-orb clay-orb-a" aria-hidden="true" />
        <span className="clay-orb clay-orb-b" aria-hidden="true" />
        <span className="clay-ring" aria-hidden="true" />

        <div className="login-brand-top">
          <span className="brand-glyph brand-glyph-lg" aria-hidden="true">
            <Icon name="spark" size={26} />
          </span>
          <span className="login-brand-name">Clay Dashboard</span>
        </div>

        <div className="login-headline">
          <p className="eyebrow">SaaS Analytics · 本地演示</p>
          <h1>
            让每一个项目
            <br />
            都有自己的脉搏。
          </h1>
          <p className="login-lead">
            收入趋势、渠道表现与团队项目集中在一个柔软的黏土工作台。
            四个角色、完整权限与实时活动流，数据保存在本机 SQLite。
          </p>
        </div>

        <div className="login-feature-row">
          <div className="login-feature">
            <IconTile name="trend" tone="lilac" size={40} />
            <div>
              <strong>KPI 环比</strong>
              <span>收入 · 客户 · 转化率</span>
            </div>
          </div>
          <div className="login-feature">
            <IconTile name="users" tone="mint" size={40} />
            <div>
              <strong>角色权限</strong>
              <span>Admin · Manager · PM · Viewer</span>
            </div>
          </div>
          <div className="login-feature">
            <IconTile name="activity" tone="peach" size={40} />
            <div>
              <strong>实时协作</strong>
              <span>SSE 活动流与在线状态</span>
            </div>
          </div>
        </div>

        <div className="login-preview" aria-hidden="true">
          <div className="preview-card preview-main">
            <div className="preview-head">
              <span className="preview-dot" />
              <span className="preview-line" />
            </div>
            <div className="preview-value">$83,609</div>
            <div className="preview-chart">
              {[38, 52, 44, 66, 58, 74, 62, 86, 70, 92].map((height, index) => (
                <span key={index} style={{ height: `${height}%` }} />
              ))}
            </div>
          </div>
          <div className="preview-card preview-side">
            <div className="preview-ring" />
            <div>
              <strong>68%</strong>
              <span>完成度</span>
            </div>
          </div>
        </div>

        <p className="login-footnote">
          Node {`${new Date().getFullYear()}`} · Hono + node:sqlite · 无外部字体与追踪脚本
        </p>
      </section>

      <section className="login-panel">
        <div className="login-card card">
          <div className="login-card-head">
            <span className="login-lock">
              <Icon name="lock" size={20} />
            </span>
            <div>
              <h2>登录工作台</h2>
              <p>使用本地演示账号或管理员为你创建的账户</p>
            </div>
          </div>

          <form className="login-form" onSubmit={submit}>
            {resetMode ? (
              <>
                <p className="login-mfa-hint">
                  {resetStep === 'request'
                    ? '输入账号邮箱，我们会生成一个 30 分钟内有效的一次性重置令牌。'
                    : '粘贴重置令牌并设置新密码。令牌只能使用一次，完成后所有旧会话都会失效。'}
                </p>
                {resetStep === 'request' ? (
                  <label className="field">
                    <span>邮箱</span>
                    <div className="input-with-icon">
                      <Icon name="mail" size={17} />
                      <input
                        type="email"
                        className="input"
                        autoComplete="username"
                        required
                        autoFocus
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        placeholder="you@company.com"
                      />
                    </div>
                  </label>
                ) : (
                  <>
                    <label className="field">
                      <span>重置令牌</span>
                      <div className="input-with-icon">
                        <Icon name="key" size={17} />
                        <input
                          className="input"
                          required
                          autoFocus
                          value={resetToken}
                          onChange={(event) => setResetToken(event.target.value)}
                          placeholder="粘贴邮件中的令牌"
                        />
                      </div>
                    </label>
                    <label className="field">
                      <span>新密码</span>
                      <div className="input-with-icon">
                        <Icon name="lock" size={17} />
                        <input
                          type="password"
                          className="input"
                          autoComplete="new-password"
                          required
                          minLength={8}
                          value={newPassword}
                          onChange={(event) => setNewPassword(event.target.value)}
                          placeholder="至少 8 位，包含大小写与数字"
                        />
                      </div>
                    </label>
                  </>
                )}
                {notice ? (
                  <p className="login-notice" role="status">
                    <Icon name="check" size={16} />
                    {notice}
                  </p>
                ) : null}
                {error ? (
                  <p className="login-error" role="alert">
                    <Icon name="alert" size={16} />
                    {error}
                  </p>
                ) : null}
                <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
                  {busy ? <span className="spinner" /> : <Icon name="key" size={17} />}
                  {busy ? '正在处理…' : resetStep === 'request' ? '获取重置令牌' : '设置新密码'}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-block"
                  onClick={() => {
                    setResetMode(false);
                    setResetStep('request');
                    setResetToken('');
                    setNewPassword('');
                    setError(null);
                    setNotice(null);
                  }}
                >
                  返回账号登录
                </button>
              </>
            ) : ticket ? (
              <>
                <p className="login-mfa-hint">
                  该账号已启用双因素认证。请输入身份验证器中的 6 位验证码，或使用一个备用码。
                </p>
                <label className="field">
                  <span>验证码</span>
                  <div className="input-with-icon">
                    <Icon name="shield" size={17} />
                    <input
                      className="input"
                      autoComplete="one-time-code"
                      inputMode="text"
                      required
                      autoFocus
                      value={code}
                      onChange={(event) => setCode(event.target.value)}
                      placeholder="6 位验证码或备用码"
                    />
                  </div>
                </label>
                <button
                  type="button"
                  className="btn btn-ghost btn-block"
                  onClick={() => {
                    setTicket(null);
                    setCode('');
                    setError(null);
                  }}
                >
                  返回账号登录
                </button>
              </>
            ) : (
              <>
                <label className="field">
                  <span>邮箱</span>
                  <div className="input-with-icon">
                    <Icon name="mail" size={17} />
                    <input
                      type="email"
                      className="input"
                      autoComplete="username"
                      required
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="you@company.com"
                    />
                  </div>
                </label>

                <label className="field">
                  <span>密码</span>
                  <div className="input-with-icon">
                    <Icon name="key" size={17} />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      className="input"
                      autoComplete="current-password"
                      required
                      minLength={8}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder="至少 8 位字符"
                    />
                    <button
                      type="button"
                      className="input-action"
                      onClick={() => setShowPassword((current) => !current)}
                      aria-label={showPassword ? '隐藏密码' : '显示密码'}
                    >
                      <Icon name="eye" size={17} />
                    </button>
                  </div>
                </label>
                <div className="login-links">
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => {
                      setResetMode(true);
                      setResetStep('request');
                      setError(null);
                      setNotice(null);
                    }}
                  >
                    忘记密码？
                  </button>
                </div>
              </>
            )}

            {!resetMode && notice ? (
              <p className="login-notice" role="status">
                <Icon name="check" size={16} />
                {notice}
              </p>
            ) : null}

            {!resetMode && error ? (
              <p className="login-error" role="alert">
                <Icon name="alert" size={16} />
                {error}
              </p>
            ) : null}

            {!resetMode ? (
              <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
                {busy ? (
                  <span className="spinner" />
                ) : (
                  <Icon name={ticket ? 'shield' : 'logout'} size={17} />
                )}
                {busy ? '正在验证…' : ticket ? '验证并登录' : '登录'}
              </button>
            ) : null}
          </form>

          {demo && demo.users.length > 0 ? (
            <div className="demo-accounts">
              <div className="demo-accounts-head">
                <span className="badge" data-tone="demo">
                  <span className="badge-dot" />
                  Demo 模式
                </span>
                <p>
                  统一密码 <code>{demo.password}</code>，点击账号一键填入。
                </p>
              </div>
              <ul className="demo-list">
                {demo.users.map((account) => (
                  <li key={account.email}>
                    <button type="button" className="demo-account" onClick={() => fill(account)}>
                      <Avatar name={account.name} size={34} />
                      <span className="demo-account-body">
                        <strong>{account.name}</strong>
                        <span>{account.email}</span>
                      </span>
                      <RoleBadge role={account.role} />
                      <span className="demo-fill">填入</span>
                    </button>
                  </li>
                ))}
              </ul>
              <p className="demo-note">
                演示账号与 KPI 数据仅用于本地展示；<code>DEMO_MODE=0</code> 会停用演示账号登录。
              </p>
            </div>
          ) : null}
        </div>

        <p className="login-security">
          <Icon name="shield" size={15} />
          Session Cookie 为 HttpOnly · SameSite=Lax · 登录限流 10 次 / 15 分钟
        </p>
      </section>
    </div>
  );
}
