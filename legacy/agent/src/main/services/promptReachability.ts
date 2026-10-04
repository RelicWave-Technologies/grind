/**
 * Deciding what a request for the main window means while a Prompt is active.
 *
 * A prompt outranks the main window — that part is not in question. The
 * question is what to do when the prompt cannot be seen, and the honest answer
 * is that **we cannot detect that condition**. macOS can hold an overlay on a
 * Space we were never told about; Electron reports `isVisible()` and
 * `isAlwaysOnTop()` as true throughout, so there is no state to inspect and no
 * event to subscribe to. Every attempt to fix this by re-raising harder has
 * failed for that reason.
 *
 * So the evidence is behavioural rather than structural. Somebody who can see a
 * prompt answers it. Somebody who cannot keeps asking for the app. A second
 * request arriving moments after we re-presented the prompt is the strongest
 * signal available that the re-present did nothing, and it costs one unanswered
 * question to act on it.
 *
 * The rule lives here, as a pure decision over durations, so it can be tested
 * without an app, a window server, or a display.
 */

export type PromptGateDecision =
  /** No prompt is in the way; open the window. */
  | 'show-window'
  /** A prompt is up and this is the first ask; put it back in front. */
  | 'restore-prompt'
  /** They asked again straight away; the prompt is unreachable. Let them in. */
  | 'release-and-show';

export interface PromptGateInput {
  /** Is a prompt currently active? */
  hasPrompt: boolean;
  /**
   * Time since we last re-presented a prompt in response to a request.
   * `null` when we never have — the first ask of this run.
   */
  sinceLastRestoreMs: number | null;
  /** How recent a previous restore has to be for this ask to count as a repeat. */
  windowMs: number;
}

/**
 * Elapsed time, never instants: the caller owns the clock, and this rule holds
 * on any of them.
 */
export function decidePromptGate(input: PromptGateInput): PromptGateDecision {
  if (!input.hasPrompt) return 'show-window';
  if (input.sinceLastRestoreMs === null) return 'restore-prompt';
  // A negative reading means the clock moved backwards under us; treat it as a
  // fresh ask rather than trusting it to be "recent".
  if (input.sinceLastRestoreMs < 0) return 'restore-prompt';
  return input.sinceLastRestoreMs < input.windowMs ? 'release-and-show' : 'restore-prompt';
}

/**
 * Long enough to cover a slow present and a person moving their hand, short
 * enough that two deliberate, unrelated clicks minutes apart are never mistaken
 * for "that did nothing".
 */
export const PROMPT_UNREACHABLE_WINDOW_MS = 12_000;
