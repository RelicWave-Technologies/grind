/**
 * Dev-panel switches, persisted in localStorage so HMR and reloads keep them.
 */
import type { Role } from '@grind/types';

export interface MockSettings {
  role: Role;
  signedOut: boolean;
  latencyMs: 0 | 800 | 3000;
  empty: boolean;
  errors: boolean;
  collapsed: boolean;
}

const KEY = 'timo.mock.settings';

export const DEFAULT_SETTINGS: MockSettings = {
  role: 'ADMIN',
  signedOut: false,
  latencyMs: 0,
  empty: false,
  errors: false,
  collapsed: false,
};

let state: MockSettings = read();
const listeners = new Set<(s: MockSettings) => void>();

function read(): MockSettings {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_SETTINGS };
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<MockSettings>;
    return {
      role: parsed.role === 'MANAGER' || parsed.role === 'MEMBER' ? parsed.role : 'ADMIN',
      signedOut: parsed.signedOut === true,
      latencyMs: parsed.latencyMs === 800 || parsed.latencyMs === 3000 ? parsed.latencyMs : 0,
      empty: parsed.empty === true,
      errors: parsed.errors === true,
      collapsed: parsed.collapsed === true,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function getSettings(): MockSettings {
  return state;
}

export function updateSettings(patch: Partial<MockSettings>): MockSettings {
  state = { ...state, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
  for (const fn of listeners) fn(state);
  return state;
}

export function subscribeSettings(fn: (s: MockSettings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
