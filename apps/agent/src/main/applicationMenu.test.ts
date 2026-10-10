import { describe, expect, it, vi, beforeEach } from 'vitest';

const setApplicationMenu = vi.fn();
const buildFromTemplate = vi.fn((template: unknown) => ({ template }));
vi.mock('electron', () => ({ Menu: { setApplicationMenu, buildFromTemplate } }));

const { installApplicationMenu, macApplicationMenuTemplate, quitFromMenu, shouldRemoveApplicationMenu } = await import('./applicationMenu');

beforeEach(() => {
  setApplicationMenu.mockClear();
  buildFromTemplate.mockClear();
});

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

  it('leaves macOS untouched without a quit handler', () => {
    installApplicationMenu('darwin');
    expect(setApplicationMenu).not.toHaveBeenCalled();
  });

  it('keeps the standard macOS menus but routes Cmd+Q through our quit', () => {
    const onQuit = vi.fn();
    installApplicationMenu('darwin', { appName: 'Timo', onQuit });
    expect(setApplicationMenu).toHaveBeenCalledOnce();

    const template = macApplicationMenuTemplate('Timo', onQuit);
    const roles = template.map((item) => item.role ?? item.label);
    expect(roles).toEqual(['Timo', 'fileMenu', 'editMenu', 'viewMenu', 'windowMenu']);
    const appItems = template[0]!.submenu as Array<{ role?: string; label?: string; accelerator?: string; click?: () => void }>;
    // No stock quit role left to bypass the confirmation.
    expect(appItems.some((item) => item.role === 'quit')).toBe(false);
    const quit = appItems.find((item) => item.label === 'Quit Timo')!;
    expect(quit.accelerator).toBe('Command+Q');
    quit.click!();
    expect(onQuit).toHaveBeenCalledOnce();
  });
});

describe('quitFromMenu', () => {
  it('quits straight away when nothing is being tracked', async () => {
    const confirm = vi.fn();
    const quit = vi.fn();
    await expect(quitFromMenu({ isTimerRunning: () => false, confirm, quit })).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(quit).toHaveBeenCalledOnce();
  });

  it('asks first while a timer is running, and keeps running on No', async () => {
    const quit = vi.fn();
    await expect(quitFromMenu({ isTimerRunning: () => true, confirm: async () => false, quit })).resolves.toBe(false);
    expect(quit).not.toHaveBeenCalled();

    await expect(quitFromMenu({ isTimerRunning: () => true, confirm: async () => true, quit })).resolves.toBe(true);
    expect(quit).toHaveBeenCalledOnce();
  });

  it('still quits when the timer cannot be read', async () => {
    const quit = vi.fn();
    await quitFromMenu({ isTimerRunning: () => { throw new Error('not ready'); }, confirm: vi.fn(), quit });
    expect(quit).toHaveBeenCalledOnce();
  });
});
