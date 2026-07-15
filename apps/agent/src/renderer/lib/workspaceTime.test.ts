import { describe, expect, it } from 'vitest';
import { formatWorkspaceRecoveryTime } from './workspaceTime';

describe('formatWorkspaceRecoveryTime', () => {
  const timeZone = 'Asia/Kolkata';

  it('always includes the workspace date', () => {
    expect(formatWorkspaceRecoveryTime(Date.parse('2026-07-15T13:51:00.000Z'), timeZone)).toContain('Jul 15, 2026');
    expect(formatWorkspaceRecoveryTime(Date.parse('2026-07-15T13:51:00.000Z'), timeZone)).toContain('7:21 PM');
  });

  it('does not make an earlier-day notice look current', () => {
    expect(formatWorkspaceRecoveryTime(Date.parse('2026-07-12T13:51:00.000Z'), timeZone)).toContain('Jul 12, 2026');
  });
});
