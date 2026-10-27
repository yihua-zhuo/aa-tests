import { api } from './api.ts';

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

let installPrompt: InstallPromptEvent | null = null;

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event as InstallPromptEvent;
    window.dispatchEvent(new Event('pwa:installable'));
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    window.dispatchEvent(new Event('pwa:installed'));
  });
}

export function registerPwa(): void {
  if (!import.meta.env.PROD || typeof navigator === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

export function canInstall(): boolean {
  return installPrompt !== null;
}

export async function promptInstall(): Promise<boolean> {
  if (!installPrompt) return false;
  const event = installPrompt;
  await event.prompt();
  const choice = await event.userChoice;
  installPrompt = null;
  return choice.outcome === 'accepted';
}

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  );
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  return pushSupported() ? Notification.permission : 'unsupported';
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

export async function pushSubscriptionActive(): Promise<boolean> {
  if (!pushSupported()) return false;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return false;
  return (await registration.pushManager.getSubscription()) !== null;
}

export async function enablePush(): Promise<void> {
  if (!pushSupported()) throw new Error('当前浏览器不支持 Web Push');
  const permission =
    Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission().catch(() => 'denied');
  if (permission !== 'granted') throw new Error('浏览器未授予通知权限');
  const status = await api.pushStatus();
  if (!status.enabled || !status.publicKey) throw new Error('服务器未启用浏览器推送');
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeBase64Url(status.publicKey),
    });
  }
  const json = subscription.toJSON();
  const endpoint = subscription.endpoint;
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!p256dh || !auth) throw new Error('浏览器返回的订阅密钥不完整');
  await api.subscribePush({ endpoint, p256dh, auth });
}

export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  await api.unsubscribePush(subscription.endpoint).catch(() => undefined);
  await subscription.unsubscribe();
}
