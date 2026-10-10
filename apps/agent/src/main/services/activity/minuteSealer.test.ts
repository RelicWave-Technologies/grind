import { describe, it, expect } from 'vitest';
import { MinuteSealer, type SealOwner } from './minuteSealer';
import type { ActivitySample } from './aggregator';

function harness(startMs: number) {
  let nowMs = startMs;
  const persisted: { sample: ActivitySample; entryId: string | null; owner: SealOwner | null }[] = [];
  const sealer = new MinuteSealer({
    now: () => nowMs,
    persist: (sample, entryId, owner) => persisted.push({ sample, entryId, owner }),
  });
  return {
    sealer,
    persisted,
    setNow: (ms: number) => {
      nowMs = ms;
    },
    advance: (ms: number) => {
      nowMs += ms;
    },
    nowMs: () => nowMs,
  };
}

describe('MinuteSealer', () => {
  it('seals a normal minute and attributes it to the recording entry', () => {
    const h = harness(60_000);
    h.sealer.setRecording(true, 'e1');
    for (let i = 0; i < 10; i++) h.sealer.onKey(60_000 + i * 100);
    h.sealer.onClick();
    h.advance(60_000);
    expect(h.sealer.tick()).toBe(60_000);
    expect(h.persisted).toHaveLength(1);
    expect(h.persisted[0]!.sample.keystrokes).toBe(10);
    expect(h.persisted[0]!.sample.clicks).toBe(1);
    expect(h.persisted[0]!.sample.bucketStart).toBe(60_000);
    expect(h.persisted[0]!.entryId).toBe('e1');
  });

  // --- Bug #1 regression: pausing/stopping at tick time must NOT drop the
  //     minute you already typed. Every event was captured while recording, so
  //     it is legitimate work and must persist regardless of live timer state.
  it('persists a minute typed BEFORE a pause (no silent loss)', () => {
    const h = harness(60_000);
    h.sealer.setRecording(true, 'e1');
    for (let i = 0; i < 8; i++) h.sealer.onKey(60_000 + i * 50);
    h.sealer.setRecording(false, null); // user pauses 30s in
    h.advance(60_000); // 60s tick fires while PAUSED
    expect(h.sealer.tick()).toBe(60_000);
    expect(h.persisted).toHaveLength(1);
    expect(h.persisted[0]!.sample.keystrokes).toBe(8);
    // Attribution survives the pause (entry was active during capture).
    expect(h.persisted[0]!.entryId).toBe('e1');
  });

  it('attributes a minute to the entry even after the timer stops (entryId now null)', () => {
    const h = harness(0);
    h.sealer.setRecording(true, 'entry-A');
    h.sealer.onKey(100);
    h.sealer.onKey(400);
    h.sealer.setRecording(false, null); // stop closes the entry → null
    h.advance(60_000);
    h.sealer.tick();
    expect(h.persisted[0]!.entryId).toBe('entry-A');
  });

  it('ignores input while not recording', () => {
    const h = harness(0);
    h.sealer.onKey(10); // never started recording
    h.sealer.onClick();
    h.sealer.onMove(20, 5, 5);
    h.advance(60_000);
    expect(h.sealer.tick()).toBeNull();
    expect(h.persisted).toHaveLength(0);
  });

  // --- Every tracked minute is a sample: a quiet one is stored as zeros, so
  //     activity % is averaged over tracked minutes, not just the busy ones.
  it('stores a tracked minute with no input as a zero sample', () => {
    const h = harness(0);
    h.sealer.setRecording(true, 'e1');
    h.advance(60_000);
    expect(h.sealer.tick()).toBe(0);
    expect(h.persisted).toHaveLength(1);
    expect(h.persisted[0]!.sample).toMatchObject({ bucketStart: 0, keystrokes: 0, clicks: 0, mouseDistancePx: 0 });
    expect(h.persisted[0]!.entryId).toBe('e1');
  });

  it('stores nothing for a minute that was never tracked', () => {
    const h = harness(0);
    h.advance(60_000);
    expect(h.sealer.tick()).toBeNull();
    h.sealer.setRecording(false, null);
    h.advance(60_000);
    expect(h.sealer.tick()).toBeNull();
    expect(h.persisted).toHaveLength(0);
  });

  it('stores no zero minute while input could not be observed (hook not running)', () => {
    let capturing = false;
    const persisted: ActivitySample[] = [];
    let now = 0;
    const sealer = new MinuteSealer({ now: () => now, persist: (s) => persisted.push(s), isCapturing: () => capturing });
    sealer.setRecording(true, 'e1');
    now = 60_000;
    expect(sealer.tick()).toBeNull();
    capturing = true;
    sealer.setRecording(true, 'e1');
    now = 120_000;
    expect(sealer.tick()).toBe(60_000);
    expect(persisted.map((s) => s.bucketStart)).toEqual([60_000]);
  });

  it('a ten-minute stretch with one busy minute stores ten minutes', () => {
    const h = harness(0);
    h.sealer.setRecording(true, 'e1');
    for (let m = 0; m < 10; m++) {
      if (m === 3) for (let i = 0; i < 50; i++) h.sealer.onKey(h.nowMs() + i);
      h.advance(60_000);
      h.sealer.tick();
    }
    expect(h.persisted).toHaveLength(10);
    expect(h.persisted.filter((p) => p.sample.keystrokes > 0)).toHaveLength(1);
  });

  it('puts an event in the minute it happened in, even before the tick fires', () => {
    const h = harness(0);
    h.sealer.setRecording(true, 'e1');
    h.sealer.onKey(10);
    h.setNow(60_500); // boundary passed; the tick has not run yet
    h.sealer.onKey(60_500);
    expect(h.persisted.map((p) => [p.sample.bucketStart, p.sample.keystrokes])).toEqual([[0, 1]]);
    h.setNow(120_100);
    h.sealer.tick();
    expect(h.persisted.map((p) => [p.sample.bucketStart, p.sample.keystrokes])).toEqual([[0, 1], [60_000, 1]]);
  });

  it('emits distinct buckets across consecutive minutes', () => {
    const h = harness(0);
    h.sealer.setRecording(true, 'e1');
    h.sealer.onClick();
    h.advance(60_000);
    h.sealer.tick(); // seals bucket 0
    h.sealer.onClick();
    h.advance(60_000);
    h.sealer.tick(); // seals bucket 60_000
    expect(h.persisted.map((p) => p.sample.bucketStart)).toEqual([0, 60_000]);
  });

  // --- Bug #2: seal the in-flight partial minute on quit. ---
  it('seals the in-flight partial minute on quit (sealPartial)', () => {
    const h = harness(0);
    h.sealer.setRecording(true, 'e1');
    h.sealer.onKey(1000);
    h.sealer.onKey(1200);
    h.advance(30_000); // 30s into the minute, app quits
    expect(h.sealer.sealPartial()).toBe(0);
    expect(h.persisted).toHaveLength(1);
    expect(h.persisted[0]!.sample.keystrokes).toBe(2);
  });

  // --- A minute sealed twice (quit path, then more input in the same minute —
  //     or a restart within the minute) is persisted twice, each time with only
  //     what is new; the store adds the two up. Nothing is overwritten and
  //     nothing is dropped.
  it('persists the tail of a minute sealed early, on top of the head', () => {
    const h = harness(60_000);
    h.sealer.setRecording(true, 'e1');
    h.sealer.onKey(60_100);
    h.sealer.onKey(60_200);
    h.sealer.onKey(60_300);
    expect(h.sealer.sealPartial()).toBe(60_000); // e.g. quit path persists 3 keys
    expect(h.persisted).toHaveLength(1);
    expect(h.persisted[0]!.sample.keystrokes).toBe(3);

    h.sealer.setRecording(true, 'e1');
    h.sealer.onKey(60_500);
    h.sealer.onKey(60_600);
    h.advance(60_000); // now 120_000
    expect(h.sealer.tick()).toBe(60_000);
    expect(h.persisted.map((p) => [p.sample.bucketStart, p.sample.keystrokes])).toEqual([[60_000, 3], [60_000, 2]]);
  });

  it('a restarted process within the same minute persists only its own share', () => {
    const first = harness(60_000);
    first.sealer.setRecording(true, 'e1');
    first.sealer.onKey(60_100);
    first.sealer.sealPartial();

    const second = harness(60_000 + 20_000); // relaunched 20s later, same minute
    second.sealer.setRecording(true, 'e1');
    second.sealer.onKey(80_100);
    second.sealer.onKey(80_200);
    second.advance(60_000);
    second.sealer.tick();

    expect(first.persisted[0]!.sample).toMatchObject({ bucketStart: 60_000, keystrokes: 1 });
    expect(second.persisted[0]!.sample).toMatchObject({ bucketStart: 60_000, keystrokes: 2 });
  });

  it('does not leak a sealed minute\'s events into the next one', () => {
    const h = harness(60_000);
    h.sealer.setRecording(true, 'e1');
    h.sealer.onKey(60_100);
    h.sealer.sealPartial(); // emits bucket 60_000 (1 key)
    h.sealer.onKey(60_500); // more input in the same minute
    h.advance(60_000);
    h.sealer.tick(); // bucket 60_000's tail
    h.sealer.onKey(120_100); // a fresh key in the next minute
    h.advance(60_000);
    h.sealer.tick(); // seals bucket 120_000
    const last = h.persisted.at(-1)!;
    expect(last.sample.bucketStart).toBe(120_000);
    expect(last.sample.keystrokes).toBe(1); // only the fresh key
  });
});

describe('MinuteSealer owner attribution', () => {
  const ALICE = { userId: 'alice', workspaceId: 'w' };
  const BOB = { userId: 'bob', workspaceId: 'w' };

  it('stamps a minute with the account signed in while it was recorded, not at seal time', () => {
    const h = harness(60_000);
    h.sealer.setRecording(true, 'e1', ALICE);
    h.sealer.onKey(60_100);
    h.sealer.setRecording(false, null, null); // stop + sign-out before the minute seals
    h.advance(60_000);
    h.sealer.tick();
    expect(h.persisted).toHaveLength(1);
    expect(h.persisted[0]!.owner).toEqual(ALICE);
  });

  it('seals what the previous account recorded before a mid-minute switch', () => {
    const h = harness(60_000);
    h.sealer.setRecording(true, 'e1', ALICE);
    h.sealer.onKey(60_100);
    h.sealer.onKey(60_200);
    h.advance(10_000);
    h.sealer.setRecording(true, 'e2', BOB);
    h.sealer.onKey(70_100);
    h.advance(60_000);
    h.sealer.tick();

    expect(h.persisted.map((p) => [p.owner?.userId, p.entryId, p.sample.keystrokes])).toEqual([
      ['alice', 'e1', 2],
      ['bob', 'e2', 1],
    ]);
    expect(h.persisted.every((p) => p.sample.bucketStart === 60_000)).toBe(true);
  });
});
