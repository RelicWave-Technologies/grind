import { describe, expect, it, vi } from 'vitest';
import { attachWindowsSessionEnd, WM_QUERYENDSESSION } from './sessionEnd';

function fakeWindow() {
  const hooks = new Map<number, () => void>();
  const events = new Map<string, () => void>();
  return {
    hooks,
    events,
    hookWindowMessage: vi.fn((message: number, cb: () => void) => hooks.set(message, cb)),
    on: vi.fn((event: string, cb: () => void) => events.set(event, cb)),
  };
}

describe('attachWindowsSessionEnd', () => {
  it('only proves liveness when Windows asks, and runs cleanup when the session ends', () => {
    const win = fakeWindow();
    const onQueryEnd = vi.fn();
    const onEnd = vi.fn();

    expect(attachWindowsSessionEnd(win, { onQueryEnd, onEnd }, 'win32')).toBe(true);

    win.hooks.get(WM_QUERYENDSESSION)!();
    expect(onQueryEnd).toHaveBeenCalledOnce();
    expect(onEnd).not.toHaveBeenCalled();

    win.events.get('session-end')!();
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it('never lets a failing query handler throw into the window procedure', () => {
    const win = fakeWindow();
    attachWindowsSessionEnd(win, { onQueryEnd: () => { throw new Error('db locked'); }, onEnd: vi.fn() }, 'win32');

    expect(() => win.hooks.get(WM_QUERYENDSESSION)!()).not.toThrow();
  });

  it('attaches nothing outside Windows, where powerMonitor shutdown covers it', () => {
    const win = fakeWindow();

    expect(attachWindowsSessionEnd(win, { onQueryEnd: vi.fn(), onEnd: vi.fn() }, 'darwin')).toBe(false);
    expect(win.hookWindowMessage).not.toHaveBeenCalled();
  });
});
