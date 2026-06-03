/**
 * Pure flag explanation (M17).
 *
 * Anti-cheat flags surface as a type + a JSON evidence bag of signal
 * numbers. The dashboard's reviewer needs to know "what does
 * METRONOMIC with ikiCv=0.04 actually mean?" without reading the
 * scoring docs. This helper turns the raw shape into:
 *
 *   { headline:  one-line human summary
 *     detail:    1–2 sentence explanation referencing the numbers }
 *
 * Deterministic. No LLM. The text is templated per flag type with
 * fill-in numbers from the evidence bag.
 */

export type FlagType =
  | 'IMPOSSIBLE_RATE'
  | 'METRONOMIC'
  | 'LINEAR_MOUSE'
  | 'SINGLE_CHANNEL'
  | 'JIGGLER';

export interface FlagExplanationInput {
  type: FlagType | string;
  evidence: Record<string, number>;
  riskScore: number;
}

export interface FlagExplanation {
  headline: string;
  detail: string;
}

const TEMPLATES: Record<FlagType, (e: Record<string, number>) => FlagExplanation> = {
  IMPOSSIBLE_RATE: (e) => ({
    headline: 'Keys per minute exceeded what a human can physically type',
    detail: `Peak rate ${fmt(e.keysPerMin)} keys/min vs. the 1,100/min ceiling. Hardware macros, paste-bombs, or a key-spam script are the usual causes.`,
  }),
  METRONOMIC: (e) => ({
    headline: 'Keystroke intervals are unnaturally even — likely an auto-typer',
    detail: `Coefficient of variation ${fmt(e.ikiCv, 2)} (humans usually 0.3–0.8). Near-zero CV means each key lands at the same beat — a script or hardware macro.`,
  }),
  LINEAR_MOUSE: (e) => ({
    headline: 'Mouse moves in straight lines at constant speed — likely scripted',
    detail: `Path straightness ${fmt(e.pathStraightness, 2)} (1 = perfect line) with speed CV ${fmt(e.moveSpeedCv, 2)}. Humans curve + accelerate; this is a bot signature.`,
  }),
  SINGLE_CHANNEL: (e) => ({
    headline: 'Only keys OR only mouse — never both — over the window',
    detail: `Keystrokes ${fmt(e.keysPerMin)}, clicks ${fmt(e.clicksPerMin)}, scrolls ${fmt(e.scrollsPerMin)}. Real work usually blends input types; one-channel activity over a long window is a red flag.`,
  }),
  JIGGLER: (e) => ({
    headline: 'Periodic mouse-only nudges with no clicks or keys — mouse jiggler',
    detail: `Move events at ${fmt(e.movesPerMin)}/min with ${fmt(e.clicksPerMin)} clicks + ${fmt(e.keysPerMin)} keys. Classic "look busy" hardware/software jiggler pattern.`,
  }),
};

/**
 * Build a human explanation for an ActivityFlag row. Unknown types
 * degrade gracefully to a generic message — flag definitions can drift
 * faster than this helper, and we'd rather show *something* than 500.
 */
export function explainFlag(input: FlagExplanationInput): FlagExplanation {
  const tpl = (TEMPLATES as Record<string, (e: Record<string, number>) => FlagExplanation>)[input.type];
  const base = tpl
    ? tpl(input.evidence ?? {})
    : {
        headline: `${input.type} flag raised`,
        detail: 'No detailed explanation available for this flag type.',
      };
  const risk = clampRisk(input.riskScore);
  const intensifier = risk >= 70 ? ' — high risk' : risk >= 40 ? ' — moderate risk' : ' — low risk';
  return { headline: base.headline + intensifier, detail: base.detail };
}

function fmt(n: number | undefined, decimals = 0): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  return decimals === 0 ? String(Math.round(n)) : n.toFixed(decimals);
}

function clampRisk(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}
