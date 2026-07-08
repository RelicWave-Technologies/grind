import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TimoClient } from './client';

export const TIMO_TOOLS = [
  'timo_version_adoption',
  'timo_device_health',
  'timo_running_users',
  'timo_people_list',
  'timo_time_summary',
  'timo_manual_time_requests',
] as const;

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

const LimitSchema = z.number().int().min(1).max(200).optional();

const PeopleInput = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  role: z.enum(['ADMIN', 'MANAGER', 'MEMBER']).optional(),
  limit: LimitSchema,
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

const TimeSummaryInput = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tz: z.string().trim().min(1).max(80).default('UTC'),
  userId: z.string().trim().min(1).max(120).optional(),
});

const ManualTimeInput = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  tz: z.string().trim().min(1).max(80).default('UTC'),
  limit: LimitSchema,
});

export function registerTimoTools(server: McpServer, client: TimoClient): void {
  server.registerTool(
    'timo_version_adoption',
    {
      title: 'Timo Version Adoption',
      description: 'Summarize Timo desktop app version adoption by platform and runtime state.',
      inputSchema: VersionAdoptionInput.shape,
    },
    async (input) => run(() => client.get('/v1/mcp/version-adoption', input)),
  );

  server.registerTool(
    'timo_device_health',
    {
      title: 'Timo Device Health',
      description: 'List last-known desktop version, platform, status, and permission health.',
      inputSchema: DeviceHealthInput.shape,
    },
    async (input) => run(() => client.get('/v1/mcp/device-health', input)),
  );

  server.registerTool(
    'timo_running_users',
    {
      title: 'Timo Running Users',
      description: 'List users whose Timo desktop agent is currently reporting RUNNING.',
      inputSchema: {},
    },
    async () => run(() => client.get('/v1/mcp/running-users')),
  );

  server.registerTool(
    'timo_people_list',
    {
      title: 'Timo People List',
      description: 'List active people in the workspace, optionally filtered by text or role.',
      inputSchema: PeopleInput.shape,
    },
    async (input) => run(() => client.get('/v1/mcp/people', input)),
  );

  server.registerTool(
    'timo_time_summary',
    {
      title: 'Timo Time Summary',
      description: 'Summarize tracked, meeting, manual, invalidated, and total time for up to 31 days.',
      inputSchema: TimeSummaryInput.shape,
    },
    async (input) => run(() => client.get('/v1/mcp/time-summary', input)),
  );

  server.registerTool(
    'timo_manual_time_requests',
    {
      title: 'Timo Manual Time Requests',
      description: 'List manual-time requests and their decision state, without screenshots or raw activity samples.',
      inputSchema: ManualTimeInput.shape,
    },
    async (input) => run(() => client.get('/v1/mcp/manual-time-requests', input)),
  );
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return textResult(await fn());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: 'text', text: `Timo MCP error: ${message}` }],
    };
  }
}

export function textResult(value: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  };
}
