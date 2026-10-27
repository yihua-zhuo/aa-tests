const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password12',
  'password123',
  'password1234',
  'passw0rd',
  'p@ssw0rd',
  '123456',
  '1234567',
  '12345678',
  '123456789',
  '1234567890',
  '111111',
  '000000',
  'abc123',
  'abcd1234',
  'qwerty',
  'qwerty123',
  'qwertyuiop',
  '1q2w3e4r',
  '1qaz2wsx',
  'zaq12wsx',
  'letmein',
  'welcome',
  'welcome1',
  'admin',
  'admin123',
  'administrator',
  'root',
  'iloveyou',
  'monkey',
  'dragon',
  'football',
  'baseball',
  'sunshine',
  'princess',
  'superman',
  'trustno1',
  'changeme',
  'secret',
  'master',
  'shadow',
  'michael',
  'jennifer',
  'starwars',
  'whatever',
  'freedom',
  'hello123',
  'clay1234',
  'pulse1234',
]);

/** Returns a user-facing message when the password is known-weak, else null. */
export function passwordIssue(password: string): string | null {
  const lower = password.toLowerCase();
  const compact = lower.replace(/[^a-z0-9]/g, '');
  if (COMMON_PASSWORDS.has(lower) || COMMON_PASSWORDS.has(compact)) {
    return '该密码过于常见，请换一个更安全的密码';
  }
  if (/^(.)\1+$/.test(password)) {
    return '密码不能由重复字符组成';
  }
  if (/^(0123456789|1234567890|abcdefghij|qwertyuiop)/.test(compact)) {
    return '密码不能使用连续的数字或键盘序列';
  }
  if (/^(password|admin|welcome|letmein|qwerty)/.test(compact)) {
    return '密码不能以常见弱口令开头';
  }
  return null;
}
