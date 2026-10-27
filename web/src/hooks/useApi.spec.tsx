import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Toaster } from '../components/ui.tsx';
import { useApi, useToast } from './useApi.ts';

function resetToasts(show: ReturnType<typeof useToast>): void {
  act(() => {
    for (const item of show.toasts) show.dismiss(item.id);
  });
}

describe('useToast', () => {
  it('queues messages instead of replacing the previous one', () => {
    const { result } = renderHook(() => useToast());
    resetToasts(result.current);
    act(() => {
      result.current.show('第一条');
      result.current.show('第二条');
      result.current.show('第三条');
    });
    expect(result.current.toasts.map((item) => item.message)).toEqual([
      '第一条',
      '第二条',
      '第三条',
    ]);
    const firstId = result.current.toasts[0].id;
    act(() => result.current.dismiss(firstId));
    expect(result.current.toasts.map((item) => item.message)).toEqual(['第二条', '第三条']);
  });

  it('keeps at most four toasts and gives undo actions a longer duration', () => {
    const { result } = renderHook(() => useToast());
    resetToasts(result.current);
    act(() => {
      for (let index = 0; index < 6; index += 1) result.current.show(`消息 ${index}`);
    });
    expect(result.current.toasts).toHaveLength(4);
    expect(result.current.toasts[0].message).toBe('消息 2');

    act(() => {
      result.current.show('可撤销', 'success', { action: { label: '撤销', onClick: () => {} } });
    });
    expect(result.current.toasts.at(-1)?.duration).toBe(8000);
  });

  it('renders only the newest toast as a live status', () => {
    render(
      <Toaster
        toasts={[
          { id: 1, message: '旧的', tone: 'success', duration: 8000 },
          { id: 2, message: '新的', tone: 'success', duration: 8000 },
        ]}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('新的');
  });

  it('runs and dismisses an undo action', () => {
    const onUndo = vi.fn();
    const onDismiss = vi.fn();
    render(
      <Toaster
        toasts={[
          {
            id: 7,
            message: '已删除「示例」',
            tone: 'success',
            duration: 8000,
            action: { label: '撤销', onClick: onUndo },
          },
        ]}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    expect(onUndo).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledWith(7);
  });
});

describe('useApi', () => {
  it('applies optimistic mutations without a refetch', async () => {
    const { result } = renderHook(() => useApi(async () => ({ count: 1 }), []));
    await waitFor(() => expect(result.current.data).toEqual({ count: 1 }));

    act(() => {
      result.current.mutate((current) => ({ count: current.count + 1 }));
    });
    expect(result.current.data).toEqual({ count: 2 });
  });
});
