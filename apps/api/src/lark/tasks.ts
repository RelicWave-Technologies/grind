import { getLarkConfig } from './config';

/**
 * Lark Task v2 — fetch the signed-in user's tasks for the agent's task picker.
 *
 * `GET /task/v2/tasks?type=my_tasks` requires a USER access token (there is no
 * tenant-wide shortcut), so this always runs through the per-user TokenManager.
 * Time-spent aggregation stays in OUR DB (TimeEntry.larkTaskGuid); we only read
 * task metadata here.
 */

export interface LarkTaskDto {
  guid: string;
  summary: string;
  completed: boolean;
  url?: string;
  /** Due time in epoch ms, or null. */
  due: number | null;
  /** When the task was created (epoch ms), or null. */
  createdAt: number | null;
  /** Creator's Lark open_id (for name resolution); null if unknown. */
  creatorId: string | null;
  /** Creator's display name; filled by the route after a contact lookup. */
  creatorName: string | null;
  /** Time already tracked against this task via Grind (epoch ms duration). Filled by the route. */
  loggedMs: number;
}

export interface CreateLarkTaskInput {
  summary: string;
  /** Optional due time in epoch ms. */
  due?: number | null;
  description?: string | null;
  /** open_id to add as assignee so the task shows up in their my_tasks. */
  assigneeOpenId?: string | null;
}

export interface UserTaskClient {
  /** List the user's tasks given their Lark user access token. */
  listMyTasks(accessToken: string): Promise<LarkTaskDto[]>;
  /** Create a Lark task; returns the new task's guid. */
  createTask(accessToken: string, input: CreateLarkTaskInput): Promise<LarkTaskDto>;
  /** Post a comment on a task (non-destructive). */
  addComment(accessToken: string, guid: string, content: string): Promise<void>;
  /** The open_id of the token owner (so we can assign created tasks to them). */
  getOpenId(accessToken: string): Promise<string | null>;
}

// Raw shape of a Lark Task v2 item (only the fields we use).
export type RawLarkTask = {
  guid?: string;
  summary?: string;
  completed_at?: string; // ms timestamp string; "0" / absent when not completed
  url?: string;
  due?: { timestamp?: string; is_all_day?: boolean } | null;
  created_at?: string;
  creator?: { id?: string; type?: string } | null;
};

/** Normalize a Lark timestamp string (seconds OR ms) to epoch ms; null if absent/zero. */
export function toEpochMs(ts: string | undefined | null): number | null {
  if (!ts || ts === '0') return null;
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  // < 1e12 ⇒ seconds (Lark task due uses seconds); otherwise already ms.
  return n < 1e12 ? n * 1000 : n;
}

export type RawTasksPage = {
  code?: number;
  msg?: string;
  data?: { items?: RawLarkTask[]; page_token?: string; has_more?: boolean };
};

/**
 * Pure mapper: raw Lark task items → our DTOs. Drops items without a guid and
 * derives `completed` from a non-zero `completed_at`. Exported for unit tests.
 */
export function mapTasks(items: RawLarkTask[] | undefined): LarkTaskDto[] {
  if (!items) return [];
  const out: LarkTaskDto[] = [];
  for (const t of items) {
    if (!t.guid) continue;
    out.push({
      guid: t.guid,
      summary: t.summary ?? '(untitled task)',
      completed: Boolean(t.completed_at && t.completed_at !== '0'),
      url: t.url,
      due: toEpochMs(t.due?.timestamp),
      createdAt: toEpochMs(t.created_at),
      creatorId: t.creator?.id ?? null,
      creatorName: null,
      loggedMs: 0,
    });
  }
  return out;
}

/** Worked duration (WORK/MEETING segments) per larkTaskGuid, summed across entries. */
export function loggedMsByGuid(
  entries: Array<{ larkTaskGuid: string | null; segments: Array<{ kind: string; startedAt: Date; endedAt: Date | null }> }>,
  now: number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries) {
    if (!e.larkTaskGuid) continue;
    let ms = 0;
    for (const s of e.segments) {
      if (s.kind === 'WORK' || s.kind === 'MEETING') {
        ms += (s.endedAt ? s.endedAt.getTime() : now) - s.startedAt.getTime();
      }
    }
    out.set(e.larkTaskGuid, (out.get(e.larkTaskGuid) ?? 0) + Math.max(0, ms));
  }
  return out;
}

/** Real client: paginates `my_tasks` with the user token. */
export class HttpUserTaskClient implements UserTaskClient {
  async listMyTasks(accessToken: string): Promise<LarkTaskDto[]> {
    const { oauthHost } = getLarkConfig();
    const all: LarkTaskDto[] = [];
    let pageToken: string | undefined;
    // Bounded pagination so a runaway has_more can't loop forever.
    for (let i = 0; i < 20; i += 1) {
      const url = new URL('/open-apis/task/v2/tasks', oauthHost);
      url.searchParams.set('type', 'my_tasks');
      url.searchParams.set('page_size', '100');
      if (pageToken) url.searchParams.set('page_token', pageToken);
      const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      const body = (await res.json().catch(() => ({}))) as RawTasksPage;
      if (body.code !== 0) throw new Error(`lark my_tasks error: ${body.msg ?? body.code}`);
      all.push(...mapTasks(body.data?.items));
      if (!body.data?.has_more || !body.data.page_token) break;
      pageToken = body.data.page_token;
    }
    return all;
  }

  async createTask(accessToken: string, input: CreateLarkTaskInput): Promise<LarkTaskDto> {
    const { oauthHost } = getLarkConfig();
    const payload: Record<string, unknown> = { summary: input.summary };
    if (input.description) payload.description = input.description;
    if (input.due != null) {
      // Lark task due expects a seconds timestamp string.
      payload.due = { timestamp: String(Math.floor(input.due / 1000)), is_all_day: false };
    }
    // Assign the creator so the task appears in their my_tasks list.
    if (input.assigneeOpenId) {
      payload.members = [{ id: input.assigneeOpenId, type: 'user', role: 'assignee' }];
    }
    const res = await fetch(`${oauthHost}/open-apis/task/v2/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => ({}))) as { code?: number; msg?: string; data?: { task?: RawLarkTask } };
    if (body.code !== 0 || !body.data?.task) throw new Error(`lark create task error: ${body.msg ?? body.code}`);
    return mapTasks([body.data.task])[0]!;
  }

  async getOpenId(accessToken: string): Promise<string | null> {
    const { oauthHost } = getLarkConfig();
    const res = await fetch(`${oauthHost}/open-apis/authen/v1/user_info`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = (await res.json().catch(() => ({}))) as { code?: number; data?: { open_id?: string } };
    return body.code === 0 ? body.data?.open_id ?? null : null;
  }

  async addComment(accessToken: string, guid: string, content: string): Promise<void> {
    const { oauthHost } = getLarkConfig();
    const res = await fetch(`${oauthHost}/open-apis/task/v2/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ resource_type: 'task', resource_id: guid, content }),
    });
    const body = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
    if (body.code !== 0) throw new Error(`lark add comment error: ${body.msg ?? body.code}`);
  }
}
