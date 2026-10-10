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

/**
 * The "reopening Timo forgets what I was working on" report.
 *
 * initTimerOnBoot always closes a dangling entry, so the running timer can
 * never carry the task across a restart — this file is the only thing that can.
 */
describe('last tracked task memory', () => {
  beforeEach(() => {
    files.clear();
    vi.resetModules();
  });

  it('defaults to no remembered task on a fresh install', async () => {
    const prefs = await import('./preferences');
    expect(prefs.getPreferences().lastLarkTaskGuid).toBeNull();
  });

  it('remembers the task and survives a restart', async () => {
    const first = await import('./preferences');
    first.rememberLastLarkTask('task-abc');
    await first.flushPreferences();

    // Fresh module instances = a new app launch reading the same file.
    vi.resetModules();
    const afterRestart = await import('./preferences');
    expect(afterRestart.getPreferences().lastLarkTaskGuid).toBe('task-abc');
  });

  it('keeps the floating-bar prefs intact when remembering a task', async () => {
    const prefs = await import('./preferences');
    prefs.patchFloatingBar({ visible: false, x: 12, y: 34 });
    prefs.rememberLastLarkTask('task-abc');
    await prefs.flushPreferences();

    vi.resetModules();
    const afterRestart = await import('./preferences');
    expect(afterRestart.getPreferences()).toMatchObject({
      floatingBar: { visible: false, x: 12, y: 34 },
      lastLarkTaskGuid: 'task-abc',
    });
  });

  it('does not rewrite or notify when the task has not changed', async () => {
    const prefs = await import('./preferences');
    prefs.rememberLastLarkTask('task-abc');
    const seen: Array<string | null> = [];
    prefs.onPreferencesChange((p) => seen.push(p.lastLarkTaskGuid));

    prefs.rememberLastLarkTask('task-abc');

    // Start is called on every tracking start; a no-op must not churn the disk.
    expect(seen).toEqual([]);
  });

  it('ignores a corrupt guid rather than losing the whole preferences file', async () => {
    files.set('/userData/preferences.json', JSON.stringify({
      floatingBar: { visible: false, x: 5, y: 6 },
      lastLarkTaskGuid: 42,
    }));
    const prefs = await import('./preferences');
    expect(prefs.getPreferences()).toMatchObject({
      floatingBar: { visible: false, x: 5, y: 6 },
      lastLarkTaskGuid: null,
    });
  });

  it("never offers one account's last task to another on the same machine", async () => {
    const prefs = await import('./preferences');
    prefs.setPreferencesOwner({ userId: 'alice', workspaceId: 'w1' });
    prefs.rememberLastLarkTask('alice-task');
    prefs.setPreferencesOwner({ userId: 'bob', workspaceId: 'w1' });

    expect(prefs.getPreferences().lastLarkTaskGuid).toBeNull();
    prefs.rememberLastLarkTask('bob-task');
    await prefs.flushPreferences();

    vi.resetModules();
    const afterRestart = await import('./preferences');
    afterRestart.setPreferencesOwner({ userId: 'alice', workspaceId: 'w1' });
    expect(afterRestart.getPreferences().lastLarkTaskGuid).toBe('alice-task');
    afterRestart.setPreferencesOwner({ userId: 'bob', workspaceId: 'w1' });
    expect(afterRestart.getPreferences().lastLarkTaskGuid).toBe('bob-task');
  });

  it('hands a task remembered before scoping to the owner bound at boot, once', async () => {
    files.set('/userData/preferences.json', JSON.stringify({ lastLarkTaskGuid: 'old-task' }));
    const prefs = await import('./preferences');

    prefs.setPreferencesOwner({ userId: 'alice', workspaceId: 'w1' }, { claimLegacy: true });
    expect(prefs.getPreferences().lastLarkTaskGuid).toBe('old-task');
    prefs.setPreferencesOwner({ userId: 'bob', workspaceId: 'w1' }, { claimLegacy: true });
    expect(prefs.getPreferences().lastLarkTaskGuid).toBeNull();
  });

  it('serializes overlapping writes so the newest state is what lands on disk', async () => {
    const prefs = await import('./preferences');
    prefs.patchFloatingBar({ x: 1 });
    const first = prefs.flushPreferences();
    prefs.patchFloatingBar({ x: 2 });
    const second = prefs.flushPreferences();
    await Promise.all([first, second]);

    expect(JSON.parse(files.get('/userData/preferences.json')!).floatingBar.x).toBe(2);
    // No temp file left behind by either write.
    expect([...files.keys()].filter((key) => key.endsWith('.tmp'))).toEqual([]);
  });
});
