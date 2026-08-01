import { describe, it, expect, beforeEach } from 'vitest';
import {
  __resetServerClock,
  hasServerClockSample,
  noteServerTime,
  serverAlignedNow,
  serverClockOffsetMs,
} from './serverClock';

const iso = (ms: number) => new Date(ms).toISOString();

describe('server-aligned clock', () => {
  beforeEach(() => __resetServerClock());

  it('starts as a pass-through before any server sample', () => {
    expect(hasServerClockSample()).toBe(false);
    expect(serverClockOffsetMs()).toBe(0);
    expect(serverAlignedNow(1_000_000)).toBe(1_000_000);
  });

  it('pulls a fast device clock back onto server time', () => {
    // The reported case: device runs 5 minutes ahead of the server, well past
    // the server's 2-minute clamp tolerance.
    const deviceNow = 1_000_000_000;
    const serverNow = deviceNow - 5 * 60_000;

    noteServerTime(iso(serverNow), deviceNow, deviceNow);

    expect(serverClockOffsetMs()).toBe(-5 * 60_000);
    expect(serverAlignedNow(deviceNow)).toBe(serverNow);
  });

  it('splits round-trip latency instead of charging it all to the offset', () => {
    const sentAt = 1_000_000_000;
    const receivedAt = sentAt + 400; // 400ms round trip
    // Server stamped its response mid-flight, with clocks actually in sync.
    noteServerTime(iso(sentAt + 200), sentAt, receivedAt);

    // Midpoint assumption cancels out exactly: no phantom offset.
    expect(serverClockOffsetMs()).toBe(0);
  });

  it('never moves backwards, even when a correction arrives mid-timer', () => {
    const deviceNow = 1_000_000_000;
    const before = serverAlignedNow(deviceNow);

    // A correction that would otherwise rewind the clock by five minutes.
    noteServerTime(iso(deviceNow - 5 * 60_000), deviceNow, deviceNow);
    const after = serverAlignedNow(deviceNow);

    // Rewinding here would make now() land before a running entry's startedAt
    // and produce negative worked time — worse than the drift being corrected.
    expect(after).toBeGreaterThanOrEqual(before);
    expect(after).toBe(before);
  });

  it('lets time advance again once the device catches up past the freeze', () => {
    const deviceNow = 1_000_000_000;
    serverAlignedNow(deviceNow);
    noteServerTime(iso(deviceNow - 60_000), deviceNow, deviceNow);

    expect(serverAlignedNow(deviceNow)).toBe(deviceNow); // held
    expect(serverAlignedNow(deviceNow + 90_000)).toBe(deviceNow + 30_000); // resumed
  });

  it('ignores jitter below the significance threshold', () => {
    const deviceNow = 1_000_000_000;
    noteServerTime(iso(deviceNow - 300), deviceNow, deviceNow);

    expect(serverClockOffsetMs()).toBe(0);
    expect(hasServerClockSample()).toBe(true);
  });

  it('ignores an unparseable server timestamp', () => {
    expect(noteServerTime('not-a-date', 1_000, 1_000)).toBeNull();
    expect(serverClockOffsetMs()).toBe(0);
  });
});
