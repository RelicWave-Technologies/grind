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
});
