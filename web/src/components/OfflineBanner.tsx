import { useEffect, useState } from 'react';
import { snapshotFallbackActive } from '../offline.ts';
import { Icon } from './Icon.tsx';

export function OfflineBanner() {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  const [snapshot, setSnapshot] = useState(snapshotFallbackActive);

  useEffect(() => {
    const handleOnline = () => {
      setOnline(true);
      setSnapshot(false);
    };
    const handleOffline = () => setOnline(false);
    const handleSnapshot = () => setSnapshot(true);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('pulse:offline-snapshot', handleSnapshot);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('pulse:offline-snapshot', handleSnapshot);
    };
  }, []);

  if (online) return null;
  return (
    <div className="offline-banner" role="status">
      <Icon name="globe" size={16} />
      <span>{snapshot ? '离线只读模式' : '当前离线'} · 展示最近同步的数据，写操作已暂停</span>
    </div>
  );
}
