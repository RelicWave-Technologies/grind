import { describe, expect, it } from 'vitest';
import {
  decidePromptGate,
  PROMPT_UNREACHABLE_WINDOW_MS,
  type PromptGateInput,
} from './promptReachability';

const base: PromptGateInput = {
  hasPrompt: true,
  sinceLastRestoreMs: null,
  windowMs: PROMPT_UNREACHABLE_WINDOW_MS,
};

describe('decidePromptGate', () => {
  it('opens the window when no prompt is in the way', () => {
    expect(decidePromptGate({ ...base, hasPrompt: false })).toBe('show-window');
  });

  it('opens the window even if a restore happened moments ago, when nothing is active', () => {
    expect(decidePromptGate({ ...base, hasPrompt: false, sinceLastRestoreMs: 10 })).toBe('show-window');
  });

  it('restores the prompt on the first ask', () => {
    expect(decidePromptGate(base)).toBe('restore-prompt');
  });

  it('releases when the person asks again straight away', () => {
    expect(decidePromptGate({ ...base, sinceLastRestoreMs: 800 })).toBe('release-and-show');
  });

  it('still releases just inside the window', () => {
    expect(decidePromptGate({ ...base, sinceLastRestoreMs: PROMPT_UNREACHABLE_WINDOW_MS - 1 })).toBe(
      'release-and-show',
    );
  });

  it('treats an ask exactly on the boundary as a fresh one', () => {
    expect(decidePromptGate({ ...base, sinceLastRestoreMs: PROMPT_UNREACHABLE_WINDOW_MS })).toBe(
      'restore-prompt',
    );
  });

  it('does not release for two deliberate clicks minutes apart', () => {
    expect(decidePromptGate({ ...base, sinceLastRestoreMs: 5 * 60_000 })).toBe('restore-prompt');
  });

  it('treats a backwards clock as a fresh ask rather than a repeat', () => {
    // A device clock correction must never silently dismiss somebody's prompt.
    expect(decidePromptGate({ ...base, sinceLastRestoreMs: -4_000 })).toBe('restore-prompt');
  });

  it('honours a custom window', () => {
    expect(decidePromptGate({ ...base, sinceLastRestoreMs: 3_000, windowMs: 1_000 })).toBe(
      'restore-prompt',
    );
    expect(decidePromptGate({ ...base, sinceLastRestoreMs: 500, windowMs: 1_000 })).toBe(
      'release-and-show',
    );
  });
});
