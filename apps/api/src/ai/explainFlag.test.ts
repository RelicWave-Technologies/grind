import { describe, it, expect } from 'vitest';
import { explainFlag } from './explainFlag';

describe('explainFlag', () => {
  it('METRONOMIC uses ikiCv number + intensifier from risk score', () => {
    const r = explainFlag({ type: 'METRONOMIC', evidence: { ikiCv: 0.04 }, riskScore: 85 });
    expect(r.headline).toContain('unnaturally even');
    expect(r.headline).toContain('high risk');
    expect(r.detail).toContain('0.04');
  });

  it('IMPOSSIBLE_RATE surfaces the keys/min', () => {
    const r = explainFlag({ type: 'IMPOSSIBLE_RATE', evidence: { keysPerMin: 1500 }, riskScore: 100 });
    expect(r.headline).toContain('Keys per minute');
    expect(r.detail).toContain('1500');
    expect(r.detail).toContain('1,100');
  });

  it('LINEAR_MOUSE renders pathStraightness + moveSpeedCv', () => {
    const r = explainFlag({
      type: 'LINEAR_MOUSE',
      evidence: { pathStraightness: 0.99, moveSpeedCv: 0.02 },
      riskScore: 65,
    });
    expect(r.detail).toContain('0.99');
    expect(r.detail).toContain('0.02');
    expect(r.headline).toContain('moderate risk');
  });

  it('SINGLE_CHANNEL surfaces all three channels', () => {
    const r = explainFlag({
      type: 'SINGLE_CHANNEL',
      evidence: { keysPerMin: 120, clicksPerMin: 0, scrollsPerMin: 0 },
      riskScore: 50,
    });
    expect(r.detail).toContain('120');
  });

  it('JIGGLER surfaces moves + zero clicks/keys', () => {
    const r = explainFlag({
      type: 'JIGGLER',
      evidence: { movesPerMin: 45, clicksPerMin: 0, keysPerMin: 0 },
      riskScore: 90,
    });
    expect(r.headline).toContain('jiggler');
    expect(r.detail).toContain('45');
  });

  it('unknown type degrades gracefully', () => {
    const r = explainFlag({ type: 'UFO_INVASION', evidence: {}, riskScore: 30 });
    expect(r.headline).toContain('UFO_INVASION');
    expect(r.headline).toContain('low risk');
  });

  it('handles missing evidence numbers with em-dashes', () => {
    const r = explainFlag({ type: 'METRONOMIC', evidence: {}, riskScore: 10 });
    expect(r.detail).toContain('—');
  });

  it('clamps insane risk scores into the 0–100 range', () => {
    expect(explainFlag({ type: 'METRONOMIC', evidence: {}, riskScore: 999 }).headline).toContain('high risk');
    expect(explainFlag({ type: 'METRONOMIC', evidence: {}, riskScore: -5 }).headline).toContain('low risk');
  });

  it('rounds whole-number signals (no decimals on keysPerMin)', () => {
    const r = explainFlag({ type: 'IMPOSSIBLE_RATE', evidence: { keysPerMin: 1200.7 }, riskScore: 80 });
    expect(r.detail).toContain('1201');
  });
});
