import { describe, expect, it } from 'vitest';
import { TIMO_TOOLS, textResult } from './tools';

describe('Timo MCP tools', () => {
  it('exports the v1 read-only tool list', () => {
    expect(TIMO_TOOLS).toEqual([
      'timo_version_adoption',
      'timo_device_health',
      'timo_running_users',
      'timo_people_list',
      'timo_time_summary',
      'timo_manual_time_requests',
    ]);
  });

  it('formats API output as MCP text content', () => {
    expect(textResult({ ok: true })).toEqual({
      content: [{ type: 'text', text: '{\n  "ok": true\n}' }],
    });
  });
});
