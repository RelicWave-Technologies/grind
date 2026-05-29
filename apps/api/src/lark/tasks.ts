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
}

export interface UserTaskClient {
  /** List the user's tasks given their Lark user access token. */
  listMyTasks(accessToken: string): Promise<LarkTaskDto[]>;
}

// Raw shape of a Lark Task v2 item (only the fields we use).
export type RawLarkTask = {
  guid?: string;
  summary?: string;
  completed_at?: string; // ms timestamp string; "0" / absent when not completed
  url?: string;
};

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
    });
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
}
