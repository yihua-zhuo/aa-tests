import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectTyping } from './useProjectTyping.ts';

type FakeEvent = { data?: string };

class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly OPEN = 1;
  readyState = FakeSocket.OPEN;
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Array<(event: FakeEvent) => void>>();

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', {});
  }

  emit(type: string, event: FakeEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  receive(payload: unknown): void {
    this.emit('message', { data: JSON.stringify(payload) });
  }
}

describe('useProjectTyping', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('throttles outbound typing frames and shows other editors with a TTL', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useProjectTyping('project-1'));
    const socket = FakeSocket.instances[0];
    expect(socket.url).toMatch(/\/ws$/);

    act(() => result.current.notifyTyping(true));
    act(() => result.current.notifyTyping(true));
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0])).toEqual({
      type: 'typing',
      projectId: 'project-1',
      active: true,
    });

    act(() =>
      socket.receive({
        type: 'typing',
        clientId: 'client-2',
        name: '陈墨',
        projectId: 'project-1',
        active: true,
      }),
    );
    expect(result.current.typingNames).toEqual(['陈墨']);

    act(() => vi.advanceTimersByTime(4_100));
    expect(result.current.typingNames).toEqual([]);

    act(() => result.current.notifyTyping(false));
    expect(JSON.parse(socket.sent[1])).toEqual({
      type: 'typing',
      projectId: 'project-1',
      active: false,
    });
  });

  it('ignores other projects, clears on disconnect and reconnects', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useProjectTyping('project-1'));
    const first = FakeSocket.instances[0];

    act(() =>
      first.receive({
        type: 'typing',
        clientId: 'client-2',
        name: '陈墨',
        projectId: 'project-2',
        active: true,
      }),
    );
    expect(result.current.typingNames).toEqual([]);

    act(() => first.close());
    expect(result.current.typingNames).toEqual([]);
    act(() => vi.advanceTimersByTime(3_000));
    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.instances[1].url).toMatch(/\/ws$/);
  });

  it('does not connect without a project id', () => {
    renderHook(() => useProjectTyping(undefined));
    expect(FakeSocket.instances).toHaveLength(0);
  });
});
