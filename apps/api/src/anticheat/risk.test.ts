import { describe, it, expect } from 'vitest';
import {
  assessWindow,
  RISK_WEIGHTS,
  IMPOSSIBLE_KEYS_PER_MIN,
  MIN_WINDOW_FOR_PATTERN,
  type RiskSample,
} from './risk';

const base: RiskSample = {
  keystrokes: 0,
  clicks: 0,
  scrollEvents: 0,
  mouseDistancePx: 0,
  ikiCv: null,
  moveSpeedCv: null,
  pathStraightness: null,
};
const s = (over: Partial<RiskSample>): RiskSample => ({ ...base, ...over });
const repeat = (n: number, sample: RiskSample) => Array.from({ length: n }, () => ({ ...sample }));

/** A believable human minute: mixed channels, natural variance. */
const human = (): RiskSample =>
  s({ keystrokes: 120, clicks: 25, scrollEvents: 12, mouseDistancePx: 3500, ikiCv: 0.6, moveSpeedCv: 0.5, pathStraightness: 0.4 });

describe('assessWindow — clean cases', () => {
  it('an empty window is clean', () => {
    expect(assessWindow([])).toEqual({ hardReject: false, riskScore: 0, flags: [] });
  });

  it('a normal mixed-activity window raises no flags', () => {
    const r = assessWindow(repeat(10, human()));
    expect(r.flags).toHaveLength(0);
    expect(r.riskScore).toBe(0);
    expect(r.hardReject).toBe(false);
  });

  it('short windows never raise pattern flags (insufficient evidence)', () => {
    // metronomic-looking but only a few minutes
    const few = repeat(MIN_WINDOW_FOR_PATTERN - 1, s({ keystrokes: 100, ikiCv: 0.02 }));
    expect(assessWindow(few).flags).toHaveLength(0);
  });
});

describe('IMPOSSIBLE_RATE', () => {
  it('hard-rejects a window with a superhuman keystroke minute', () => {
    const w = [...repeat(5, human()), s({ keystrokes: IMPOSSIBLE_KEYS_PER_MIN + 1 })];
    const r = assessWindow(w);
    expect(r.hardReject).toBe(true);
    const f = r.flags.find((x) => x.type === 'IMPOSSIBLE_RATE');
    expect(f?.evidence.peakKeysPerMin).toBe(IMPOSSIBLE_KEYS_PER_MIN + 1);
  });

  it('does not fire at exactly the limit (boundary)', () => {
    const w = repeat(6, s({ keystrokes: IMPOSSIBLE_KEYS_PER_MIN }));
    const r = assessWindow(w);
    expect(r.flags.some((f) => f.type === 'IMPOSSIBLE_RATE')).toBe(false);
  });
});

describe('METRONOMIC', () => {
  it('flags robotic inter-keystroke cadence across the window', () => {
    const w = repeat(8, s({ keystrokes: 100, ikiCv: 0.03 }));
    const r = assessWindow(w);
    const f = r.flags.find((x) => x.type === 'METRONOMIC');
    expect(f).toBeTruthy();
    expect(f!.evidence.roboticMinutes).toBe(8);
  });

  it('ignores minutes with too few keystrokes for a meaningful CV', () => {
    const w = repeat(8, s({ keystrokes: 5, ikiCv: 0.0 })); // below MIN_KEYS_FOR_IKI
    expect(assessWindow(w).flags.some((f) => f.type === 'METRONOMIC')).toBe(false);
  });

  it('does not flag natural typing variance', () => {
    const w = repeat(8, s({ keystrokes: 100, ikiCv: 0.7 }));
    expect(assessWindow(w).flags.some((f) => f.type === 'METRONOMIC')).toBe(false);
  });
});

describe('LINEAR_MOUSE', () => {
  it('flags dead-straight, constant-speed mouse paths', () => {
    const w = repeat(8, s({ mouseDistancePx: 4000, pathStraightness: 0.99, moveSpeedCv: 0.02 }));
    const f = assessWindow(w).flags.find((x) => x.type === 'LINEAR_MOUSE');
    expect(f).toBeTruthy();
    expect(f!.evidence.scriptedMinutes).toBe(8);
  });

  it('does not flag curved, variable-speed human movement', () => {
    const w = repeat(8, s({ mouseDistancePx: 4000, pathStraightness: 0.5, moveSpeedCv: 0.6 }));
    expect(assessWindow(w).flags.some((f) => f.type === 'LINEAR_MOUSE')).toBe(false);
  });
});

describe('SINGLE_CHANNEL', () => {
  it('flags keyboard-only windows (no pointer activity at all)', () => {
    const w = repeat(6, s({ keystrokes: 100, ikiCv: 0.6 }));
    const f = assessWindow(w).flags.find((x) => x.type === 'SINGLE_CHANNEL');
    expect(f).toBeTruthy();
    expect(f!.evidence.channel).toBe(0); // keyboard
  });

  it('flags pointer-only windows (no keystrokes at all)', () => {
    const w = repeat(6, s({ clicks: 30, mouseDistancePx: 3000, moveSpeedCv: 0.5, pathStraightness: 0.4 }));
    const f = assessWindow(w).flags.find((x) => x.type === 'SINGLE_CHANNEL');
    expect(f).toBeTruthy();
    expect(f!.evidence.channel).toBe(1); // pointer
  });

  it('does not flag mixed keyboard+pointer use', () => {
    const w = repeat(6, human());
    expect(assessWindow(w).flags.some((f) => f.type === 'SINGLE_CHANNEL')).toBe(false);
  });
});

describe('JIGGLER', () => {
  it('flags movement-only, fixed-cadence windows', () => {
    const w = repeat(8, s({ mouseDistancePx: 300, moveSpeedCv: 0.03 }));
    const f = assessWindow(w).flags.find((x) => x.type === 'JIGGLER');
    expect(f).toBeTruthy();
    expect(f!.evidence.moveOnlyMinutes).toBe(8);
  });

  it('does not flag movement accompanied by clicks/keys', () => {
    const w = repeat(8, s({ mouseDistancePx: 300, clicks: 5, moveSpeedCv: 0.03 }));
    expect(assessWindow(w).flags.some((f) => f.type === 'JIGGLER')).toBe(false);
  });

  it('does not flag jittery (high-CV) human micro-movements', () => {
    const w = repeat(8, s({ mouseDistancePx: 300, moveSpeedCv: 0.9 }));
    expect(assessWindow(w).flags.some((f) => f.type === 'JIGGLER')).toBe(false);
  });
});

describe('cumulative risk', () => {
  it('sums multiple flags and caps at 100', () => {
    // A jiggler that also draws straight lines: JIGGLER(45)+LINEAR_MOUSE(35)=80
    const w = repeat(8, s({ mouseDistancePx: 4000, moveSpeedCv: 0.02, pathStraightness: 0.99 }));
    const r = assessWindow(w);
    const types = r.flags.map((f) => f.type).sort();
    expect(types).toContain('JIGGLER');
    expect(types).toContain('LINEAR_MOUSE');
    expect(r.riskScore).toBe(Math.min(100, RISK_WEIGHTS.JIGGLER + RISK_WEIGHTS.LINEAR_MOUSE + (types.includes('SINGLE_CHANNEL') ? RISK_WEIGHTS.SINGLE_CHANNEL : 0)));
    expect(r.riskScore).toBeLessThanOrEqual(100);
  });

  it('a key-spam bot trips IMPOSSIBLE_RATE + METRONOMIC + SINGLE_CHANNEL and hard-rejects', () => {
    const w = repeat(8, s({ keystrokes: IMPOSSIBLE_KEYS_PER_MIN + 200, ikiCv: 0.01 }));
    const r = assessWindow(w);
    const types = r.flags.map((f) => f.type);
    expect(types).toContain('IMPOSSIBLE_RATE');
    expect(types).toContain('METRONOMIC');
    expect(types).toContain('SINGLE_CHANNEL');
    expect(r.hardReject).toBe(true);
    expect(r.riskScore).toBe(100); // capped
  });
});
