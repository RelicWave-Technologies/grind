import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let userData = '';
const mocks = vi.hoisted(() => ({
  loadTokens: vi.fn(),
}));

vi.mock('electron', () => ({ app: { getPath: () => userData } }));
vi.mock('../logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./tokenStore', () => ({ loadTokens: mocks.loadTokens }));

beforeEach(async () => {
  vi.resetModules();
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'timo-workspace-time-'));
  mocks.loadTokens.mockResolvedValue({
    accessToken: 'at',
    refreshToken: 'rt',
    userId: 'user_1',
    workspaceId: 'workspace_1',
  });
});

afterEach(async () => {
  await fs.rm(userData, { recursive: true, force: true });
});

describe('workspaceTime', () => {
  it('uses the server timezone for a DST-safe business-day window and persists it', async () => {
    const service = await import('./workspaceTime');
    await service.applyServerWorkspaceTimeZone('Asia/Kolkata', 'workspace_1');

    expect(service.getWorkspaceTimeContext(Date.parse('2026-07-14T20:00:00.000Z'))).toEqual({
      ready: true,
      timeZone: 'Asia/Kolkata',
      source: 'server',
      date: '2026-07-15',
      dayStart: Date.parse('2026-07-14T18:30:00.000Z'),
      dayEnd: Date.parse('2026-07-15T18:30:00.000Z'),
    });
    await expect(fs.readFile(path.join(userData, 'workspace-time.json'), 'utf8')).resolves.toBe(
      JSON.stringify({ workspaceId: 'workspace_1', timeZone: 'Asia/Kolkata' }),
    );
  });

  it('loads the last validated timezone offline and rejects an invalid cache', async () => {
    await fs.writeFile(
      path.join(userData, 'workspace-time.json'),
      JSON.stringify({ workspaceId: 'workspace_1', timeZone: 'Asia/Kolkata' }),
    );
    let service = await import('./workspaceTime');
    await service.initializeWorkspaceTime();
    expect(service.getWorkspaceTimeContext(Date.parse('2026-07-15T00:00:00.000Z')).source).toBe('cache');

    vi.resetModules();
    await fs.writeFile(
      path.join(userData, 'workspace-time.json'),
      JSON.stringify({ workspaceId: 'workspace_1', timeZone: 'not/a-zone' }),
    );
    service = await import('./workspaceTime');
    await service.initializeWorkspaceTime();
    expect(service.getWorkspaceTimeContext().ready).toBe(false);
  });

  it('never restores another workspace cache on a shared machine', async () => {
    await fs.writeFile(
      path.join(userData, 'workspace-time.json'),
      JSON.stringify({ workspaceId: 'workspace_previous', timeZone: 'America/New_York' }),
    );
    const service = await import('./workspaceTime');

    await service.initializeWorkspaceTime();

    expect(service.getWorkspaceTimeContext()).toEqual({
      ready: false,
      timeZone: null,
      source: 'unavailable',
      date: null,
      dayStart: null,
      dayEnd: null,
    });
  });

  it('clears in-memory time immediately at an auth boundary', async () => {
    const service = await import('./workspaceTime');
    await service.applyServerWorkspaceTimeZone('Asia/Kolkata', 'workspace_1');

    service.clearWorkspaceTimeSession();

    expect(service.getWorkspaceTimeContext().ready).toBe(false);
  });
});
