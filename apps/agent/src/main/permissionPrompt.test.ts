import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  appFocus: vi.fn(),
  window: {
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    on: vi.fn(),
    setPosition: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    moveTop: vi.fn(),
    focus: vi.fn(),
  },
}));

vi.mock('electron', () => ({ app: { focus: mocks.appFocus } }));

vi.mock('./windows/overlay', () => ({
  createOverlayWindow: mocks.create,
  assertOverlayFloat: vi.fn(),
  activeWorkArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
  centerUpperThird: () => ({ x: 480, y: 170 }),
}));
vi.mock('./awayPrompt', () => ({ hideAwayPrompt: vi.fn() }));
vi.mock('./idlePrompt', () => ({ hideIdlePrompt: vi.fn() }));
vi.mock('./popover', () => ({ hidePopover: vi.fn() }));

import { focusPermissionPromptIfVisible, showPermissionPrompt } from './permissionPrompt';

describe('permission prompt window', () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.create.mockReturnValue(mocks.window);
    mocks.window.isDestroyed.mockReturnValue(false);
    mocks.window.on.mockReset();
    mocks.window.show.mockReset();
    mocks.appFocus.mockReset();
  });

  it('deduplicates repeated blocked clicks into one native window', () => {
    showPermissionPrompt();
    showPermissionPrompt();

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ activation: 'interactive' }));
    expect(mocks.window.show).toHaveBeenCalledTimes(2);
  });

  it('re-focuses the visible permission window instead of raising the main window', () => {
    showPermissionPrompt();

    expect(focusPermissionPromptIfVisible()).toBe(true);
    expect(mocks.window.moveTop).toHaveBeenCalled();
    expect(mocks.window.focus).toHaveBeenCalled();
  });
});
