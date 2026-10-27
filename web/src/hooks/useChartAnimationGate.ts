import { useCallback, useEffect, useRef } from 'react';

type Waiter = { resolve: () => void; timeout: number };

// Recharts animates chart geometry through attribute updates, which Web
// Animations cannot observe. Exports therefore wait for Recharts' own
// onAnimationEnd callback instead of guessing a delay.
export function useChartAnimationGate(enabled: boolean) {
  const done = useRef(!enabled);
  const waiters = useRef<Waiter[]>([]);

  const release = useCallback(() => {
    const pending = waiters.current;
    waiters.current = [];
    for (const waiter of pending) {
      window.clearTimeout(waiter.timeout);
      waiter.resolve();
    }
  }, []);

  const onAnimationStart = useCallback(() => {
    done.current = false;
  }, []);

  const onAnimationEnd = useCallback(() => {
    done.current = true;
    // Let React commit the final geometry before the SVG is serialized.
    requestAnimationFrame(() => requestAnimationFrame(release));
  }, [release]);

  useEffect(() => {
    if (enabled) return;
    done.current = true;
    const frame = requestAnimationFrame(release);
    return () => cancelAnimationFrame(frame);
  }, [enabled, release]);

  useEffect(() => () => release(), [release]);

  const waitForAnimation = useCallback(
    () =>
      done.current
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            const timeout = window.setTimeout(() => {
              const index = waiters.current.findIndex((waiter) => waiter.resolve === resolve);
              if (index >= 0) waiters.current.splice(index, 1);
              resolve();
            }, 2_000);
            waiters.current.push({ resolve, timeout });
          }),
    [],
  );

  return { onAnimationStart, onAnimationEnd, waitForAnimation };
}
