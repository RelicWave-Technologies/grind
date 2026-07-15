import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { LarkTaskCache, type CachedLarkTask } from './larkTaskCache';

const owner = { userId: 'user-a', workspaceId: 'workspace-a' };
const task: CachedLarkTask = {
  guid: 'task-a', summary: 'Offline-safe task', completed: false, due: null,
  createdAt: null, creatorId: null, creatorName: null, loggedMs: 0, loggedTodayMs: 0, loggedTotalMs: 0,
};

describe('LarkTaskCache', () => {
  it('returns only the current owner task snapshot', () => {
    const cache = new LarkTaskCache(new Database(':memory:'));
    cache.replace(owner, [task]);
    cache.replace({ userId: 'user-b', workspaceId: owner.workspaceId }, [{ ...task, guid: 'task-b' }]);

    expect(cache.list(owner)).toEqual([task]);
    expect(cache.list({ userId: 'user-b', workspaceId: owner.workspaceId })).toEqual([{ ...task, guid: 'task-b' }]);
  });

  it('atomically replaces a stale snapshot', () => {
    const cache = new LarkTaskCache(new Database(':memory:'));
    cache.replace(owner, [task]);
    cache.replace(owner, [{ ...task, guid: 'task-next', summary: 'New task' }]);

    expect(cache.list(owner)).toEqual([{ ...task, guid: 'task-next', summary: 'New task' }]);
  });
});
