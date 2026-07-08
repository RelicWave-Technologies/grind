import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TimoClient } from './client';

export const TIMO_TOOLS = [
  'timo_mcp_capabilities',
  'timo_workspace_overview',
  'timo_people_list',
  'timo_user_detail',
  'timo_device_health',
  'timo_version_adoption',
  'timo_running_users',
  'timo_team_summary',
  'timo_time_summary',
  'timo_manual_time_requests',
  'timo_activity_flags_summary',
] as const;

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

const LimitSchema = z.number().int().min(1).max(200).optional();
const TzSchema = z.string().trim().min(1).max(80).default('UTC');
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const CapabilitiesInput = z.object({});

const WorkspaceOverviewInput = z.object({
  tz: TzSchema,
});

const PeopleInput = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  role: z.enum(['ADMIN', 'MANAGER', 'MEMBER']).optional(),
  limit: LimitSchema,
});

const UserDetailInput = z.object({
  userId: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().min(3).max(254).optional(),
  q: z.string().trim().min(1).max(120).optional(),
  from: DateSchema.optional(),
  to: DateSchema.optional(),
  tz: TzSchema,
});

const DeviceHealthInput = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  platform: z.string().trim().min(1).max(32).optional(),
  version: z.string().trim().min(1).max(80).optional(),
  limit: LimitSchema,
});

const VersionAdoptionInput = z.object({
  version: z.string().trim().min(1).max(80).optional(),
});

const TeamSummaryInput = z.object({
  teamId: z.string().trim().min(1).max(120).optional(),
  q: z.string().trim().min(1).max(120).optional(),
  from: DateSchema.optional(),
  to: DateSchema.optional(),
  tz: TzSchema,
  limit: LimitSchema,
});

const TimeSummaryInput = z.object({
  from: DateSchema,
  to: DateSchema,
  tz: TzSchema,
  userId: z.string().trim().min(1).max(120).optional(),
});

const ManualTimeInput = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
  from: DateSchema.optional(),
  to: DateSchema.optional(),
  tz: TzSchema,
  limit: LimitSchema,
});

const ActivityFlagsInput = z.object({
  status: z.enum(['OPEN', 'RESOLVED']).optional(),
  from: DateSchema.optional(),
  to: DateSchema.optional(),
  tz: TzSchema,
  limit: LimitSchema,
});

const CAPABILITIES = {
  name: 'Timo MCP',
  mode: 'read-only',
  transport: 'stdio',
  api: 'Timo API only; this server never connects to Postgres, the VM, Lark write APIs, or dashboard cookies.',
  limits: {
    maxRows: 200,
    maxSummaryDays: 31,
    dates: 'YYYY-MM-DD',
    timezone: 'IANA timezone string, default UTC',
  },
  scopes: {
    'read:people': 'People, roles, teams, shifts, and basic roster context.',
    'read:device-health': 'Desktop platform, app version, runtime state, heartbeat freshness, and permission health.',
    'read:time-summary': 'Aggregated tracked/meeting/manual/invalidated time summaries and privacy-safe flag summaries.',
    'read:manual-time': 'Manual-time request status and approval audit metadata.',
  },
  tools: TIMO_TOOLS,
  privacyNeverExposed: [
    'screenshots or screenshot URLs',
    'S3 keys',
    'raw ActivitySample rows',
    'raw keystroke/click/mouse minute timelines',
    'foreground window titles',
    'browser URLs',
    'dashboard cookies',
    'token hashes or secrets',
  ],
  writeActions: 'None. This MCP cannot approve requests, edit time, create users, change settings, or call Lark write APIs.',
};

export function registerTimoTools(server: McpServer, client: TimoClient): void {
  server.registerTool(
    'timo_mcp_capabilities',
    {
      title: 'Timo MCP Capabilities',
      description:
        'Explain this MCP server: tools, required scopes, row/date limits, date formats, privacy boundaries, and read-only restrictions. Use this first when a user asks what Timo data the AI can safely read.',
      inputSchema: CapabilitiesInput.shape,
    },
    async () => textResult(CAPABILITIES, 'Timo MCP Capabilities'),
  );

  server.registerTool(
    'timo_workspace_overview',
    {
      title: 'Timo Workspace Overview',
      description:
        'Read a workspace command-center summary: active people, role counts, teams, running/stale/no-heartbeat devices, version buckets, permission issue counts, today time totals, pending manual-time count, and open privacy-safe activity flag count. Requires people, device-health, time-summary, and manual-time scopes.',
      inputSchema: WorkspaceOverviewInput.shape,
    },
    async (input) => run('Timo Workspace Overview', () => client.get('/v1/mcp/workspace-overview', input)),
  );

  server.registerTool(
    'timo_people_list',
    {
      title: 'Timo People List',
      description:
        'List active workspace people with role, team, managed team, shift, created date, and last-known desktop device summary. Filter by name/email text or role. Requires people and device-health scopes.',
      inputSchema: PeopleInput.shape,
    },
    async (input) => run('Timo People List', () => client.get('/v1/mcp/people', input)),
  );

  server.registerTool(
    'timo_user_detail',
    {
      title: 'Timo User Detail',
      description:
        'Read one user by userId, email, or search text. Returns identity, role/team/shift, device/version/permission health, default-today or requested date-range time totals, and recent manual-time requests. Requires people, device-health, time-summary, and manual-time scopes.',
      inputSchema: UserDetailInput.shape,
    },
    async (input) => run('Timo User Detail', () => client.get('/v1/mcp/user-detail', input)),
  );

  server.registerTool(
    'timo_device_health',
    {
      title: 'Timo Device Health',
      description:
        'List last-known desktop health per user: macOS/Windows platform, app version, runtime state, heartbeat freshness, stale/no-heartbeat status, screen recording status, and accessibility/input hook health. Does not expose screenshots or raw activity.',
      inputSchema: DeviceHealthInput.shape,
    },
    async (input) => run('Timo Device Health', () => client.get('/v1/mcp/device-health', input)),
  );

  server.registerTool(
    'timo_version_adoption',
    {
      title: 'Timo Version Adoption',
      description:
        'Summarize desktop app adoption by platform, version, and runtime state. Also lists users on unknown/stale/running versions so admins can see who has or has not updated.',
      inputSchema: VersionAdoptionInput.shape,
    },
    async (input) => run('Timo Version Adoption', () => client.get('/v1/mcp/version-adoption', input)),
  );

  server.registerTool(
    'timo_running_users',
    {
      title: 'Timo Running Users',
      description:
        'List users whose desktop agent is currently RUNNING with a fresh heartbeat. Stale RUNNING heartbeats are intentionally excluded so the answer reflects live tracking, not old state.',
      inputSchema: {},
    },
    async () => run('Timo Running Users', () => client.get('/v1/mcp/running-users')),
  );

  server.registerTool(
    'timo_team_summary',
    {
      title: 'Timo Team Summary',
      description:
        'Summarize teams with managers, roster, running/stale/no-heartbeat device counts, permission issue counts, and default-today or requested date-range time totals. Filter by teamId or team name text.',
      inputSchema: TeamSummaryInput.shape,
    },
    async (input) => run('Timo Team Summary', () => client.get('/v1/mcp/team-summary', input)),
  );

  server.registerTool(
    'timo_time_summary',
    {
      title: 'Timo Time Summary',
      description:
        'Summarize aggregated tracked, meeting, manual, invalidated, and total time for up to 31 days. Returns per-user totals and per-day first/last activity timestamps, but never raw activity samples.',
      inputSchema: TimeSummaryInput.shape,
    },
    async (input) => run('Timo Time Summary', () => client.get('/v1/mcp/time-summary', input)),
  );

  server.registerTool(
    'timo_manual_time_requests',
    {
      title: 'Timo Manual Time Requests',
      description:
        'List manual-time requests with requester, task summary, requested range, duration, reason, status, approver, decision metadata, and timestamps. This is audit metadata only and performs no approvals or edits.',
      inputSchema: ManualTimeInput.shape,
    },
    async (input) => run('Timo Manual Time Requests', () => client.get('/v1/mcp/manual-time-requests', input)),
  );

  server.registerTool(
    'timo_activity_flags_summary',
    {
      title: 'Timo Activity Flags Summary',
      description:
        'Read privacy-safe anti-cheat/activity flag summaries: counts by status/type and recent flag id, user, type, risk score, status, resolution, and time window. It never exposes evidence JSON, screenshots, raw samples, app titles, or URLs.',
      inputSchema: ActivityFlagsInput.shape,
    },
    async (input) => run('Timo Activity Flags Summary', () => client.get('/v1/mcp/activity-flags-summary', input)),
  );
}

async function run(title: string, fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return textResult(await fn(), title);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: 'text', text: `Timo MCP error: ${message}` }],
    };
  }
}

export function textResult(value: unknown, title = 'Timo MCP Result'): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: `# ${title}\n\n${summarize(value)}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``,
      },
    ],
  };
}

function summarize(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'Read-only Timo result.';
  }

  const record = value as Record<string, unknown>;
  const lines: string[] = [];

  if (typeof record.generatedAt === 'string') lines.push(`Generated at: ${record.generatedAt}`);
  if (typeof record.mode === 'string') lines.push(`Mode: ${record.mode}`);
  if (typeof record.totalUsers === 'number') lines.push(`Total users: ${record.totalUsers}`);

  for (const key of ['users', 'teams', 'requests', 'flags', 'buckets'] as const) {
    const item = record[key];
    if (Array.isArray(item)) lines.push(`${capitalize(key)} returned: ${item.length}`);
  }

  if (record.counts && typeof record.counts === 'object') {
    lines.push('Counts are included in the JSON payload.');
  }
  if (record.limits && typeof record.limits === 'object') {
    lines.push('Limits are included in the JSON payload.');
  }
  if (record.privacyNeverExposed) {
    lines.push('Privacy boundary: no screenshots, raw activity samples, window titles, browser URLs, or secrets.');
  }

  return lines.length > 0 ? lines.join('\n') : 'Read-only Timo result. Full structured payload is below.';
}

function capitalize(input: string): string {
  return input.slice(0, 1).toUpperCase() + input.slice(1);
}
