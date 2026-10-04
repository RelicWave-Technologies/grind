import { describe, it, expect } from 'vitest';
import { MinuteSealer } from './minuteSealer';
import type { ActivitySample } from './aggregator';

function harness(startMs: number) {
  let nowMs = startMs;
  const persisted: { sample: ActivitySample; entryId: string | null }[] = [];
  const sealer = new MinuteSealer({
    now: () => nowMs,
    persist: (sample, entryId) => persisted.push({ sample, entryId }),
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

  it('skips empty minutes (nothing to persist)', () => {
    const h = harness(0);
    h.sealer.setRecording(true, 'e1');
    h.advance(60_000);
    expect(h.sealer.tick()).toBeNull();
    expect(h.persisted).toHaveLength(0);
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

  // --- Invariant #2: at-most-once per bucket. The server overwrites by
  //     (userId, bucketStart), so a second emit of the same minute would clobber
  //     the first. Re-sealing the same bucket must be a conservative no-op
  //     (never overwrite, never overcount — undercount the rare tail instead).
  it('never emits the same bucket twice (overwrite-safe)', () => {
    const h = harness(60_000);
    h.sealer.setRecording(true, 'e1');
    h.sealer.onKey(60_100);
    h.sealer.onKey(60_200);
    h.sealer.onKey(60_300);
    expect(h.sealer.sealPartial()).toBe(60_000); // e.g. quit path persists 3 keys
    expect(h.persisted).toHaveLength(1);
    expect(h.persisted[0]!.sample.keystrokes).toBe(3);

    // stop→restart within the SAME wall-clock minute: more keys arrive, then a
    // tick tries to seal bucket 60_000 again. It must NOT persist again.
    h.sealer.setRecording(true, 'e1');
    h.sealer.onKey(60_500);
    h.sealer.onKey(60_600);
    h.advance(60_000); // now 120_000
    expect(h.sealer.tick()).toBeNull(); // 60_000 already emitted → dropped
    expect(h.persisted).toHaveLength(1); // unchanged — no clobber
  });

  it('resets the aggregator on a dropped (already-emitted) bucket so events do not leak forward', () => {
    const h = harness(60_000);
    h.sealer.setRecording(true, 'e1');
    h.sealer.onKey(60_100);
    h.sealer.sealPartial(); // emits bucket 60_000 (1 key)
    h.sealer.onKey(60_500); // arrives for the already-sealed minute
    h.advance(60_000);
    h.sealer.tick(); // bucket 60_000 dropped + reset
    h.sealer.onKey(120_100); // a fresh key in the next minute
    h.advance(60_000);
    h.sealer.tick(); // seals bucket 120_000
    const last = h.persisted.at(-1)!;
    expect(last.sample.bucketStart).toBe(120_000);
    expect(last.sample.keystrokes).toBe(1); // only the fresh key, not the leaked one
  });
});
