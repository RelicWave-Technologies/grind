import { describe, expect, it, vi, beforeEach } from 'vitest';

const setApplicationMenu = vi.fn();
vi.mock('electron', () => ({ Menu: { setApplicationMenu } }));

const { installApplicationMenu, shouldRemoveApplicationMenu } = await import('./applicationMenu');

beforeEach(() => setApplicationMenu.mockClear());

describe('shouldRemoveApplicationMenu', () => {
  it('keeps the menu on macOS', () => {
    // The macOS menu bar is where Cmd+C / Cmd+V / Cmd+Q come from; removing it
    // breaks editing inside our own inputs.
    expect(shouldRemoveApplicationMenu('darwin')).toBe(false);
  });

  it('removes it on Windows and Linux', () => {
    // There the same menu is drawn inside the window, above our toolbar.
    expect(shouldRemoveApplicationMenu('win32')).toBe(true);
    expect(shouldRemoveApplicationMenu('linux')).toBe(true);
  });
});

describe('installApplicationMenu', () => {
  it('clears the default menu on Windows', () => {
    installApplicationMenu('win32');
    expect(setApplicationMenu).toHaveBeenCalledWith(null);
  });

  it('leaves macOS untouched', () => {
    installApplicationMenu('darwin');
    expect(setApplicationMenu).not.toHaveBeenCalled();
  });
});
