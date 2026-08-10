import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetServerClock,
  hasDeferredServerClockCorrection,
  hasServerClockSample,
  noteServerTime,
  serverAlignedNow,
  serverClockOffsetMs,
  setServerClockTrackingActive,
} from './serverClock';

const MINUTE = 60_000;

/**
 * A device whose wall clock is `skewMs` away from the server, with a monotonic
 * source that keeps running correctly regardless — exactly the split the real
 * platform gives us.
 */
function device(skewMs: number, trueStartMs = Date.UTC(2026, 7, 8, 12, 0, 0)) {
  let trueNowMs = trueStartMs;
  let monoMs = 5_000; // performance.now() starts at process launch, not 0
  const d = {
    /** Advance real time; both the wall clock and the monotonic source move. */
    advance(ms: number) {
      trueNowMs += ms;
      monoMs += ms;
    },
    /** The user (or a buggy NTP client) drags the wall clock somewhere else. */
    jumpWallClock(ms: number) {
      skewMs += ms;
    },
    /**
     * The machine sleeps: real time marches on, the monotonic source may not.
     * This is the drift an anchored clock actually accumulates, and the reason
     * it must keep re-syncing rather than trusting its anchor forever.
     */
    suspend(ms: number) {
      trueNowMs += ms;
    },
    mono: () => monoMs,
    serverIso: () => new Date(trueNowMs).toISOString(),
    trueNow: () => trueNowMs,
    deviceNow: () => trueNowMs + skewMs,
  };
  return d;
}

let dev: ReturnType<typeof device>;

/** Route Date.now() through the simulated device clock. */
function installDeviceClock(d: ReturnType<typeof device>) {
  dev = d;
  vi.spyOn(Date, 'now').mockImplementation(() => dev.deviceNow());
  __resetServerClock(d.mono);
}

/** One heartbeat round trip taking `rttMs`. */
function heartbeat(d: ReturnType<typeof device>, rttMs = 0): number | null {
  const startedAt = d.deviceNow();
  d.advance(rttMs / 2);
  const stamped = d.serverIso(); // the server stamps mid-flight
  d.advance(rttMs / 2);
  return noteServerTime(stamped, startedAt, d.deviceNow());
}

afterEach(() => vi.restoreAllMocks());

describe('serverAlignedNow', () => {
  it('falls back to the device clock before any server sample', () => {
    const d = device(10 * MINUTE);
    installDeviceClock(d);

    expect(hasServerClockSample()).toBe(false);
    expect(serverAlignedNow()).toBe(d.deviceNow());
  });

  it('pulls a fast device clock onto server time', () => {
    const d = device(10 * MINUTE);
    installDeviceClock(d);

    heartbeat(d);

    expect(serverAlignedNow()).toBeCloseTo(d.trueNow(), -1);
    expect(hasServerClockSample()).toBe(true);
    expect(serverClockOffsetMs()).toBeCloseTo(-10 * MINUTE, -2);
  });

  it('pushes a slow device clock forward onto server time', () => {
    const d = device(-7 * MINUTE);
    installDeviceClock(d);

    heartbeat(d);

    expect(serverAlignedNow()).toBeCloseTo(d.trueNow(), -1);
    expect(serverClockOffsetMs()).toBeCloseTo(7 * MINUTE, -2);
  });

  it('splits round-trip latency instead of charging it all to the offset', () => {
    const d = device(0);
    installDeviceClock(d);

    // The round trip has to be long enough that mishandling it lands ABOVE the
    // significance threshold — otherwise the resulting error is written off as
    // jitter and the test passes no matter what the code does.
    heartbeat(d, 6_000);

    // Symmetric latency: the stamp was taken mid-flight, so half the RTT is
    // added back. Charging the whole trip would show up as a 3s offset.
    expect(Math.abs(serverClockOffsetMs())).toBeLessThan(500);
  });
});

describe('the freeze regression', () => {
  // A clamped `Date.now() + offset` clock stops dead for the length of the
  // skew after the first correction, and a running timer accrues nothing.
  // Measured before the fix: 10 minutes fast => 9 minutes frozen, 10 of every
  // 20 real minutes lost. These two tests exist so that can never come back.
  it('keeps advancing at real rate through a large backwards correction', () => {
    const d = device(10 * MINUTE);
    installDeviceClock(d);

    serverAlignedNow(); // the 1s tray tick reads the clock before the first sample
    heartbeat(d);

    let previous = serverAlignedNow();
    for (let minute = 0; minute < 20; minute += 1) {
      d.advance(MINUTE);
      const current = serverAlignedNow();
      expect(current - previous).toBeCloseTo(MINUTE, -2);
      previous = current;
    }
  });

  it('loses no worked time across the correction', () => {
    const d = device(10 * MINUTE);
    installDeviceClock(d);

    setServerClockTrackingActive(true);
    const startedAt = serverAlignedNow();
    heartbeat(d);
    d.advance(20 * MINUTE);

    const workedMs = serverAlignedNow() - startedAt;
    expect(workedMs).toBeCloseTo(20 * MINUTE, -3);
  });

  it('never returns a smaller value than it last returned while tracking', () => {
    const d = device(10 * MINUTE);
    installDeviceClock(d);
    setServerClockTrackingActive(true);

    const readings: number[] = [serverAlignedNow()];
    for (let i = 0; i < 30; i += 1) {
      if (i === 3) heartbeat(d);
      if (i === 17) heartbeat(d, 250);
      if (i === 22) d.suspend(4 * MINUTE);
      d.advance(30_000);
      readings.push(serverAlignedNow());
    }

    for (let i = 1; i < readings.length; i += 1) {
      expect(readings[i]!).toBeGreaterThanOrEqual(readings[i - 1]!);
    }
  });
});

describe('corrections while a timer is running', () => {
  it('holds a correction until tracking stops', () => {
    const d = device(0);
    installDeviceClock(d);
    heartbeat(d);

    setServerClockTrackingActive(true);
    d.suspend(9 * MINUTE); // the laptop slept; the anchor is now behind
    d.advance(MINUTE);
    heartbeat(d);

    expect(hasDeferredServerClockCorrection()).toBe(true);

    setServerClockTrackingActive(false);
    expect(hasDeferredServerClockCorrection()).toBe(false);
    expect(serverAlignedNow()).toBeCloseTo(d.trueNow(), -2);
  });

  it('costs no worked time while the correction is held', () => {
    const d = device(0);
    installDeviceClock(d);
    heartbeat(d);

    setServerClockTrackingActive(true);
    const startedAt = serverAlignedNow();
    d.suspend(8 * MINUTE);
    for (let i = 0; i < 6; i += 1) {
      d.advance(5 * MINUTE);
      heartbeat(d);
    }

    expect(serverAlignedNow() - startedAt).toBeCloseTo(30 * MINUTE, -3);
  });

  it('does not go stale: a held correction accounts for the wait', () => {
    const d = device(0);
    installDeviceClock(d);
    heartbeat(d);

    setServerClockTrackingActive(true);
    d.suspend(5 * MINUTE);
    heartbeat(d);
    d.advance(45 * MINUTE); // long session before the timer stops
    setServerClockTrackingActive(false);

    expect(serverAlignedNow()).toBeCloseTo(d.trueNow(), -2);
  });

  it('holds even the very first sample when a timer is already open', () => {
    // An entry that began before the first sample lives in the device's frame.
    // Correcting mid-entry would rewrite what it has already accrued, so the
    // entry keeps its frame and the correction lands the moment it stops.
    const d = device(12 * MINUTE);
    installDeviceClock(d);

    setServerClockTrackingActive(true);
    const startedAt = serverAlignedNow();
    heartbeat(d);
    d.advance(6 * MINUTE);

    expect(hasDeferredServerClockCorrection()).toBe(true);
    expect(serverAlignedNow() - startedAt).toBeCloseTo(6 * MINUTE, -3);

    setServerClockTrackingActive(false);
    expect(serverAlignedNow()).toBeCloseTo(d.trueNow(), -2);
  });
});

describe('robustness', () => {
  it('ignores the device clock being edited underneath it', () => {
    // The Kronos property: once anchored, `now` comes from the monotonic
    // source, so tampering with the system clock moves nothing.
    const d = device(0);
    installDeviceClock(d);
    heartbeat(d);

    const before = serverAlignedNow();
    d.jumpWallClock(3 * 60 * MINUTE); // user sets the clock three hours ahead
    const after = serverAlignedNow();

    expect(after).toBe(before);
  });

  it('ignores jitter below the significance threshold', () => {
    const d = device(0);
    installDeviceClock(d);
    heartbeat(d);
    const anchored = serverAlignedNow();

    d.suspend(200);
    setServerClockTrackingActive(true);
    heartbeat(d);

    expect(hasDeferredServerClockCorrection()).toBe(false);
    expect(serverAlignedNow()).toBe(anchored);
  });

  it('is driven by a monotonic source in production, not the device clock', () => {
    // Every other test injects its own monotonic source, so none of them can
    // catch the real default being wrong. This one exercises the shipped one.
    __resetServerClock();
    const base = Date.UTC(2026, 7, 8, 12, 0, 0);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(base);

    const first = serverAlignedNow(); // seeds the anchor from the device clock
    clock.mockReturnValue(base + 60 * MINUTE); // user yanks the clock forward an hour
    const second = serverAlignedNow();

    expect(second - first).toBeLessThan(1_000);
  });

  it('ignores an unparseable server timestamp', () => {
    const d = device(4 * MINUTE);
    installDeviceClock(d);

    expect(noteServerTime('not-a-date', d.deviceNow(), d.deviceNow())).toBeNull();
    expect(hasServerClockSample()).toBe(false);
    expect(serverAlignedNow()).toBe(d.deviceNow());
  });

  it('ignores non-finite local timings', () => {
    const d = device(0);
    installDeviceClock(d);

    expect(noteServerTime(d.serverIso(), Number.NaN, d.deviceNow())).toBeNull();
    expect(hasServerClockSample()).toBe(false);
  });

  it('survives repeated tracking toggles with nothing pending', () => {
    const d = device(0);
    installDeviceClock(d);
    heartbeat(d);
    const anchored = serverAlignedNow();

    for (let i = 0; i < 5; i += 1) {
      setServerClockTrackingActive(true);
      setServerClockTrackingActive(false);
    }

    expect(serverAlignedNow()).toBe(anchored);
  });
});
