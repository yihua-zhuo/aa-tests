export type AuditCategory =
  | 'auth'
  | 'project'
  | 'user'
  | 'preferences'
  | 'audit'
  | 'token'
  | 'webhook'
  | 'other';

export const AUDIT_CATEGORY_LABELS: Record<AuditCategory, string> = {
  auth: '认证',
  project: '项目',
  user: '成员',
  preferences: '偏好',
  audit: '审计',
  token: '令牌',
  webhook: 'Webhook',
  other: '其他',
};

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  'auth.login_failed': '登录失败',
  'auth.mfa_challenge': '触发双因素验证',
  'auth.mfa_failed': '双因素验证失败',
  'auth.mfa_success': '双因素验证通过',
  'auth.password_reset_requested': '申请密码重置',
  'auth.password_reset_completed': '完成密码重置',
  'user.created': '创建成员',
  'user.updated': '更新成员',
  'user.role_changed': '调整成员角色',
  'user.disabled': '停用成员',
  'user.enabled': '恢复成员',
  'user.password_changed': '修改密码',
  'user.email_changed': '修改登录邮箱',
  'user.account_deleted': '注销账号',
  'user.password_reset': '重置成员密码',
  'user.mfa_setup': '生成双因素密钥',
  'user.mfa_enabled': '启用双因素认证',
  'user.mfa_disabled': '关闭双因素认证',
  'user.session_revoked': '吊销会话',
  'user.sessions_revoked': '吊销其他会话',
  'project.created': '创建项目',
  'project.updated': '更新项目',
  'project.deleted': '删除项目',
  'project.restored': '恢复项目',
  'project.purged': '永久删除项目',
  'project.imported': '导入项目',
  'project.exported': '导出项目',
  'project.template_applied': '从模板创建项目',
  'project.duplicated': '复制项目',
  'preferences.updated': '更新偏好',
  'audit.cleanup': '清理审计日志',
  'token.created': '创建访问令牌',
  'token.revoked': '吊销访问令牌',
  'webhook.created': '创建 Webhook',
  'webhook.updated': '更新 Webhook',
  'webhook.deleted': '删除 Webhook',
};

export function auditCategory(action: string): AuditCategory {
  const prefix = action.split('.', 1)[0] as AuditCategory;
  return prefix in AUDIT_CATEGORY_LABELS && prefix !== 'other' ? prefix : 'other';
}

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}
