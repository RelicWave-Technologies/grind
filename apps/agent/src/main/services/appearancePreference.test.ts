import { describe, it, expect, vi, beforeEach } from 'vitest';

const files = new Map<string, string>();

vi.mock('electron', () => ({
  app: { getPath: () => '/userData' },
}));

vi.mock('node:fs', () => ({
  readFileSync: (p: string) => {
    const hit = files.get(String(p));
    if (hit === undefined) {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    return hit;
  },
  promises: {
    writeFile: async (p: string, data: string) => void files.set(String(p), data),
    rename: async (from: string, to: string) => {
      files.set(String(to), files.get(String(from)) ?? '');
      files.delete(String(from));
    },
    unlink: async (p: string) => void files.delete(String(p)),
  },
}));

vi.mock('../logger', () => ({ log: { warn: vi.fn(), info: vi.fn() } }));


/** Settings → Appearance: the app theme and the pill's own theme survive a restart. */
describe('appearance preference', () => {
  beforeEach(() => {
    files.clear();
    vi.resetModules();
  });

  it('defaults to following the system, with a light pill', async () => {
    const prefs = await import('./preferences');
    expect(prefs.getPreferences().appearance).toEqual({ app: 'system', pill: 'light' });
  });

  it('saves the app and pill themes separately and keeps them after a restart', async () => {
    const first = await import('./preferences');
    first.patchAppearance({ app: 'dark' });
    first.patchAppearance({ pill: 'dark' });
    await first.flushPreferences();

    vi.resetModules();
    const afterRestart = await import('./preferences');
    expect(afterRestart.getPreferences().appearance).toEqual({ app: 'dark', pill: 'dark' });
  });

  it('ignores values it does not know instead of storing them', async () => {
    files.set('/userData/preferences.json', JSON.stringify({ appearance: { app: 'neon', pill: 'system' } }));
    const prefs = await import('./preferences');
    expect(prefs.getPreferences().appearance).toEqual({ app: 'system', pill: 'light' });
    prefs.patchAppearance({ app: 'sepia' as never });
    expect(prefs.getPreferences().appearance.app).toBe('system');
  });

  it('keeps the remembered task and floating bar when the theme changes', async () => {
    const prefs = await import('./preferences');
    prefs.rememberLastLarkTask('task-xyz');
    prefs.patchAppearance({ app: 'light' });
    expect(prefs.getPreferences()).toMatchObject({
      lastLarkTaskGuid: 'task-xyz',
      floatingBar: { visible: true },
      appearance: { app: 'light', pill: 'light' },
    });
  });
});
