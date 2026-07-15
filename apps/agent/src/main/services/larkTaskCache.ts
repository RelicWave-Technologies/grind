import type Database from 'better-sqlite3';

export type CachedLarkTask = {
  guid: string;
  summary: string;
  completed: boolean;
  url?: string;
  due: number | null;
  createdAt: number | null;
  creatorId: string | null;
  creatorName: string | null;
  loggedMs: number;
  loggedTodayMs: number;
  loggedTotalMs: number;
};

export type LarkTaskCacheOwner = { userId: string; workspaceId: string };

function isCachedTask(value: unknown): value is CachedLarkTask {
  if (!value || typeof value !== 'object') return false;
  const task = value as Partial<CachedLarkTask>;
  return typeof task.guid === 'string'
    && task.guid.length > 0
    && typeof task.summary === 'string'
    && typeof task.completed === 'boolean'
    && (typeof task.due === 'number' || task.due === null)
    && (typeof task.createdAt === 'number' || task.createdAt === null)
    && (typeof task.creatorId === 'string' || task.creatorId === null)
    && (typeof task.creatorName === 'string' || task.creatorName === null)
    && typeof task.loggedMs === 'number'
    && typeof task.loggedTodayMs === 'number'
    && typeof task.loggedTotalMs === 'number';
}

/**
 * Durable, owner-scoped mirror of the most recently fetched Lark task list.
 * It exists solely so known tasks remain selectable while the network is down;
 * task creation and task changes still require the server/Lark.
 */
export class LarkTaskCache {
  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS lark_task_cache (
        owner_user_id TEXT NOT NULL,
        owner_workspace_id TEXT NOT NULL,
        guid TEXT NOT NULL,
        json TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (owner_user_id, owner_workspace_id, guid)
      );
      CREATE INDEX IF NOT EXISTS idx_lark_task_cache_owner
        ON lark_task_cache(owner_user_id, owner_workspace_id, fetched_at DESC);
    `);
  }

  replace(owner: LarkTaskCacheOwner, tasks: CachedLarkTask[], fetchedAt = Date.now()): void {
    const write = this.db.transaction(() => {
      this.db.prepare(
        `DELETE FROM lark_task_cache WHERE owner_user_id = ? AND owner_workspace_id = ?`,
      ).run(owner.userId, owner.workspaceId);
      const insert = this.db.prepare(
        `INSERT INTO lark_task_cache (owner_user_id, owner_workspace_id, guid, json, fetched_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const task of tasks) {
        insert.run(owner.userId, owner.workspaceId, task.guid, JSON.stringify(task), fetchedAt);
      }
    });
    write();
  }

  list(owner: LarkTaskCacheOwner): CachedLarkTask[] {
    const rows = this.db.prepare(
      `SELECT json FROM lark_task_cache
       WHERE owner_user_id = ? AND owner_workspace_id = ?
       ORDER BY fetched_at DESC, guid ASC`,
    ).all(owner.userId, owner.workspaceId) as Array<{ json: string }>;
    const tasks: CachedLarkTask[] = [];
    for (const row of rows) {
      try {
        const task: unknown = JSON.parse(row.json);
        if (isCachedTask(task)) tasks.push(task);
      } catch {
        // A damaged cache row must never block local tracking.
      }
    }
    return tasks;
  }

  has(owner: LarkTaskCacheOwner): boolean {
    return this.db.prepare(
      `SELECT 1 FROM lark_task_cache WHERE owner_user_id = ? AND owner_workspace_id = ? LIMIT 1`,
    ).get(owner.userId, owner.workspaceId) !== undefined;
  }
}
