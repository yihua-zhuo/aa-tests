import { useEffect, useRef, useState } from 'react';
import type { PresenceClient, SnapshotPayload } from '../../../shared/types.ts';

export function useLiveData(enabled: boolean) {
  const [clients, setClients] = useState<PresenceClient[]>([]);
  const [connected, setConnected] = useState(false);
  const [lastEventAt, setLastEventAt] = useState<Date | null>(null);
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    refreshRef.current = () => {
      window.dispatchEvent(new Event('live:refresh'));
    };
  }, []);

  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;

    const source = new EventSource('/api/events');

    const onSnapshot = (event: Event) => {
      const message = event as MessageEvent<string>;
      try {
        const snapshot = JSON.parse(message.data) as SnapshotPayload;
        setClients(snapshot.clients ?? []);
      } catch {
        // ignore malformed frames
      }
      setConnected(true);
    };

    const onPresence = (event: Event) => {
      const message = event as MessageEvent<string>;
      try {
        const payload = JSON.parse(message.data) as {
          clients?: PresenceClient[];
          joined?: PresenceClient[];
          left?: string[];
        };
        if (payload.clients) {
          setClients(payload.clients);
          return;
        }
        setClients((current) => {
          const next = new Map(current.map((item) => [item.id, item]));
          for (const id of payload.left ?? []) next.delete(id);
          for (const client of payload.joined ?? []) next.set(client.id, client);
          return [...next.values()];
        });
      } catch {
        // ignore malformed frames
      }
    };

    const onResume = (event: Event) => {
      const message = event as MessageEvent<string>;
      try {
        const payload = JSON.parse(message.data) as { clients?: PresenceClient[] };
        setClients(payload.clients ?? []);
      } catch {
        // ignore malformed frames
      }
      setConnected(true);
    };

    const onResync = (event: Event) => {
      const message = event as MessageEvent<string>;
      try {
        const snapshot = JSON.parse(message.data) as SnapshotPayload;
        setClients(snapshot.clients ?? []);
      } catch {
        // ignore malformed frames
      }
      setConnected(true);
      setLastEventAt(new Date());
      refreshRef.current();
    };

    const onActivity = () => {
      setLastEventAt(new Date());
      refreshRef.current();
    };

    const onOpen = () => setConnected(true);
    let lastProbe = 0;
    const probeAuth = async (attempt: number): Promise<void> => {
      try {
        const res = await fetch('/api/auth/me', {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (res.status !== 401) return;
        // Password rotation revokes the old session and sets a replacement
        // cookie on the in-flight response; re-check before signing the user out.
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 400));
          await probeAuth(1);
          return;
        }
        source.close();
        window.dispatchEvent(new Event('auth:expired'));
      } catch {
        // network failures are handled by EventSource reconnection
      }
    };
    const onError = () => {
      setConnected(false);
      // EventSource reports CONNECTING while it retries, so readyState cannot
      // distinguish an expired session from a transient network error. Probe
      // /me (throttled) and only sign out on an explicit 401.
      const now = Date.now();
      if (now - lastProbe < 5_000) return;
      lastProbe = now;
      void probeAuth(0);
    };

    source.addEventListener('snapshot', onSnapshot);
    source.addEventListener('resume', onResume);
    source.addEventListener('resync', onResync);
    source.addEventListener('presence', onPresence);
    source.addEventListener('activity', onActivity);
    source.addEventListener('visibility.changed', onActivity);
    source.addEventListener('open', onOpen);
    source.addEventListener('error', onError);

    return () => {
      source.removeEventListener('snapshot', onSnapshot);
      source.removeEventListener('resume', onResume);
      source.removeEventListener('resync', onResync);
      source.removeEventListener('presence', onPresence);
      source.removeEventListener('activity', onActivity);
      source.removeEventListener('visibility.changed', onActivity);
      source.removeEventListener('open', onOpen);
      source.removeEventListener('error', onError);
      source.close();
    };
  }, [enabled]);

  return { clients, connected, lastEventAt };
}
