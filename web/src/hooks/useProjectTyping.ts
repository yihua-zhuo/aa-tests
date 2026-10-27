import { useCallback, useEffect, useRef, useState } from 'react';

type TypingPayload = {
  type?: string;
  clientId?: string;
  name?: string;
  projectId?: string;
  active?: boolean;
};

const TYPING_TTL_MS = 4_000;
const SEND_THROTTLE_MS = 1_500;
const RECONNECT_MS = 3_000;
const OPEN = 1;

export function useProjectTyping(projectId: string | undefined) {
  const [typers, setTypers] = useState<Record<string, string>>({});
  const socketRef = useRef<WebSocket | null>(null);
  const lastSentRef = useRef(0);
  const timersRef = useRef(new Map<string, number>());

  useEffect(() => {
    setTypers({});
    lastSentRef.current = 0;
    if (!projectId || typeof WebSocket === 'undefined') return;

    let disposed = false;
    let retry: number | undefined;
    let socket: WebSocket | null = null;

    const forget = (clientId: string) => {
      const timer = timersRef.current.get(clientId);
      if (timer !== undefined) window.clearTimeout(timer);
      timersRef.current.delete(clientId);
      setTypers((current) => {
        if (!(clientId in current)) return current;
        const next = { ...current };
        delete next[clientId];
        return next;
      });
    };

    const connect = () => {
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${scheme}//${window.location.host}/ws`);
      socketRef.current = socket;

      socket.addEventListener('message', (event) => {
        let payload: TypingPayload;
        try {
          payload = JSON.parse(String(event.data)) as TypingPayload;
        } catch {
          return;
        }
        if (payload.type !== 'typing' || payload.projectId !== projectId) return;
        const { clientId, name } = payload;
        if (!clientId || !name) return;
        if (payload.active !== true) {
          forget(clientId);
          return;
        }
        setTypers((current) =>
          current[clientId] === name ? current : { ...current, [clientId]: name },
        );
        const previous = timersRef.current.get(clientId);
        if (previous !== undefined) window.clearTimeout(previous);
        timersRef.current.set(
          clientId,
          window.setTimeout(() => forget(clientId), TYPING_TTL_MS),
        );
      });

      socket.addEventListener('close', () => {
        if (socketRef.current === socket) socketRef.current = null;
        setTypers({});
        if (!disposed) retry = window.setTimeout(connect, RECONNECT_MS);
      });
    };

    connect();

    return () => {
      disposed = true;
      if (retry !== undefined) window.clearTimeout(retry);
      for (const timer of timersRef.current.values()) window.clearTimeout(timer);
      timersRef.current.clear();
      const current = socket;
      socketRef.current = null;
      current?.close();
    };
  }, [projectId]);

  const notifyTyping = useCallback(
    (active: boolean) => {
      const socket = socketRef.current;
      if (!projectId || !socket || socket.readyState !== OPEN) return;
      const now = Date.now();
      if (active) {
        if (now - lastSentRef.current < SEND_THROTTLE_MS) return;
        lastSentRef.current = now;
      } else {
        lastSentRef.current = 0;
      }
      socket.send(JSON.stringify({ type: 'typing', projectId, active }));
    },
    [projectId],
  );

  return { typingNames: [...new Set(Object.values(typers))], notifyTyping };
}
