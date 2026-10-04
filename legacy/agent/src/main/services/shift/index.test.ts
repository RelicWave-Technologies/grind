import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShiftDto } from '@grind/types';

/**
 * ShiftMonitor wiring.
 *
 * The two reducers underneath this class (decide.ts, untracked.ts) are tested
 * directly and were both correct. The bug they could not catch lived here, in
 * how the class routes one reducer's verdict into the other — so these tests
 * drive the real class and assert on what reaches the toast.
 */

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  idleSeconds: vi.fn(() => 2),
  timerState: vi.fn(() => 'STOPPED'),
  attentionKind: vi.fn(() => 'NONE'),
  show: vi.fn(),
  hide: vi.fn(),
  visible: vi.fn(() => false),
  reason: vi.fn(() => 'SHIFT_START'),
  openMainWindow: vi.fn(),
}));

vi.mock('electron', () => ({
  powerMonitor: { on: vi.fn(), getSystemIdleTime: mocks.idleSeconds },
}));
vi.mock('../apiClient', () => ({ api: mocks.api }));
vi.mock('../../logger', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));
vi.mock('../../readyToWork', () => ({
  showReadyToWork: mocks.show,
  hideReadyToWork: mocks.hide,
  isReadyToWorkVisible: mocks.visible,
  readyToWorkReason: mocks.reason,
}));
vi.mock('../timer', () => ({
  getTimerService: () => ({ status: () => ({ state: mocks.timerState() }) }),
}));
vi.mock('../trackingAttention', () => ({
  getTrackingAttentionCoordinator: () => ({ get: () => ({ kind: mocks.attentionKind() }) }),
}));
vi.mock('../workspaceTime', () => ({ getWorkspaceTimeZone: () => 'UTC' }));

const { ShiftMonitor } = await import('./index');

const NINE_TO_SIX = { start: '09:00', end: '18:00' };
const SHIFT: ShiftDto = {
  id: 's1',
  workspaceId: 'w1',
  name: 'General Shift',
  schedule: {
    mon: NINE_TO_SIX, tue: NINE_TO_SIX, wed: NINE_TO_SIX,
    thu: NINE_TO_SIX, fri: NINE_TO_SIX, sat: null, sun: null,
  },
  bufferMin: 30,
  memberCount: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

// Wednesday. 14:00 is deep inside the shift and hours past the 09:00–09:30
// buffer window — the state the reducer describes as `schedule`, and the exact
// state in which someone works with the timer off.
const MID_SHIFT = Date.UTC(2026, 7, 12, 14, 0, 0);
const POLL_MS = 30_000;

let monitor: InstanceType<typeof ShiftMonitor>;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.api.mockResolvedValue({ shift: SHIFT });
  mocks.idleSeconds.mockReturnValue(2);
  mocks.timerState.mockReturnValue('STOPPED');
  mocks.attentionKind.mockReturnValue('NONE');
  mocks.visible.mockReturnValue(false);
  mocks.reason.mockReturnValue('SHIFT_START');
  vi.useFakeTimers();
  vi.setSystemTime(MID_SHIFT);
  monitor = new ShiftMonitor(mocks.openMainWindow);
  await monitor.start();
});

afterEach(() => {
  monitor.stop();
  vi.useRealTimers();
});

/** Run the 30 s poll forward, keeping the fake clock in step with it. */
async function poll(minutes: number) {
  const ticks = Math.round((minutes * 60_000) / POLL_MS);
  for (let i = 0; i < ticks; i += 1) await vi.advanceTimersByTimeAsync(POLL_MS);
}

function untrackedShown() {
  return mocks.show.mock.calls.some(([reason]) => reason === 'UNTRACKED');
}

describe('mid-shift untracked nudge', () => {
  it('stays quiet before the streak matures', async () => {
    await poll(9);
    expect(untrackedShown()).toBe(false);
  });

  it('asks after ten minutes of working with the timer off', async () => {
    // Regression: the shift reducer returns `schedule` for everything outside
    // the clock-in buffer, and that branch used to return without consulting
    // the untracked reducer — so this nudge could never fire during a shift.
    await poll(11);
    expect(untrackedShown()).toBe(true);
  });

  it('never asks while the timer is running', async () => {
    mocks.timerState.mockReturnValue('RUNNING');
    await poll(20);
    expect(untrackedShown()).toBe(false);
  });

  it('never asks once the shift has ended', async () => {
    vi.setSystemTime(Date.UTC(2026, 7, 12, 19, 0, 0));
    await poll(20);
    expect(untrackedShown()).toBe(false);
  });

  it('does not let a lunch break mature into a nudge', async () => {
    mocks.idleSeconds.mockReturnValue(15 * 60);
    await poll(20);
    expect(untrackedShown()).toBe(false);
  });

  it('leaves the nudge alone once it is up', async () => {
    // Regression: `prompting` was read from window visibility alone, so a
    // visible untracked nudge made the shift reducer believe it was the one
    // prompting. Outside the buffer window that resolves to `hide`, and the
    // nudge was closed within one poll of appearing.
    await poll(11);
    expect(untrackedShown()).toBe(true);

    mocks.visible.mockReturnValue(true);
    mocks.reason.mockReturnValue('UNTRACKED');
    mocks.hide.mockClear();
    await poll(2);

    expect(mocks.hide).not.toHaveBeenCalled();
  });
});
