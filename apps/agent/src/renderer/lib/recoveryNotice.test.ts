import { describe, expect, it } from 'vitest';
import { timerRecoveryNoticeText } from './recoveryNotice';

const fmt = () => '09:30';

describe('timerRecoveryNoticeText', () => {
  it('renders sleep-stop copy', () => {
    expect(timerRecoveryNoticeText({ entryId: 'e', recoveredAt: 1, reason: 'sleep_stop', observedAt: 2 }, fmt)).toBe(
      'Timo stopped tracking when your computer went to sleep at 09:30.',
    );
  });

  it('renders lock-stop copy', () => {
    expect(timerRecoveryNoticeText({ entryId: 'e', recoveredAt: 1, reason: 'lock_stop', observedAt: 2 }, fmt)).toBe(
      'Timo stopped tracking when your screen locked at 09:30.',
    );
  });

  it('renders unexpected shutdown copy', () => {
    expect(timerRecoveryNoticeText({ entryId: 'e', recoveredAt: 1, reason: 'unexpected_shutdown', observedAt: 2 }, fmt)).toBe(
      'Timo recovered a timer from an unexpected shutdown and stopped it at 09:30.',
    );
  });

  it('renders authoritative server-finalization copy', () => {
    expect(timerRecoveryNoticeText({ entryId: 'e', recoveredAt: 1, reason: 'server_finalized', observedAt: 2 }, fmt)).toBe(
      'Timo stopped this timer at 09:30 because the server had already finalized it.',
    );
  });

  it('renders an acknowledged server clock correction', () => {
    expect(timerRecoveryNoticeText({ entryId: 'e', recoveredAt: 1, reason: 'server_clock_corrected', observedAt: 2 }, fmt)).toBe(
      'Timo corrected this timer at 09:30 because the device clock was ahead of server time.',
    );
  });
});
