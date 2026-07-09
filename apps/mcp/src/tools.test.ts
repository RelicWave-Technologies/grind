import { describe, expect, it } from 'vitest';
import { TIMO_TOOLS, textResult } from './tools';

describe('Timo MCP tools', () => {
  it('exports the v1 read-only tool list', () => {
    expect(TIMO_TOOLS).toEqual([
      'timo_mcp_capabilities',
      'timo_workspace_overview',
      'timo_people_list',
      'timo_user_detail',
      'timo_device_health',
      'timo_version_adoption',
      'timo_running_users',
      'timo_team_summary',
      'timo_break_summary',
      'timo_time_summary',
      'timo_manual_time_requests',
      'timo_activity_flags_summary',
    ]);
  });

  it('formats API output as human-readable MCP text plus JSON', () => {
    const result = textResult({ generatedAt: '2026-07-09T00:00:00.000Z', users: [{ ok: true }] }, 'Example');
    expect(result.content[0]?.text).toContain('# Example');
    expect(result.content[0]?.text).toContain('Generated at: 2026-07-09T00:00:00.000Z');
    expect(result.content[0]?.text).toContain('Users returned: 1');
    expect(result.content[0]?.text).toContain('```json');
    expect(result.content[0]?.text).toContain('"ok": true');
  });
});
