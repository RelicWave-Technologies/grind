import type { Rng } from '../prng';

/**
 * Strings for the wire-format generators: ASCII, accents, CJK, emoji (two UTF-16
 * units), ZWJ sequences, RTL, control characters, quotes and backslashes, the
 * JSON-hostile U+2028/U+2029 and DEL. Never a lone surrogate (the harness
 * refuses them: a Rust `String` cannot hold one).
 */
const PIECES: readonly string[] = [
  'a', 'b', 'Z', '0', ' ', '-', '_', '/', ':', '.', '?', '&', '=', '#', '%', '+', '~', '*', "'", '(', ')', '!',
  'é', 'ñ', 'ü', 'ß', 'Ω', '日本語', '中文', '한국어', 'עברית', 'مرحبا', '😀', '🚀', '👨‍👩‍👧', '🇮🇳', '𝔘', '\u{10FFFF}',
  '"', '\\', '\n', '\t', '\r', '\u0001', '\u001f', '\u007f', ' ', ' ', ' ', '﻿', '<', '>', '{', '}', '[', ']',
];

const WORDS: readonly string[] = [
  'Slack', 'Chrome', 'Visual Studio Code', 'Figma', 'Terminal', 'Inbox (3)', 'Pull request #42', 'https://example.com/path?q=1&r=2',
  'com.apple.Safari', 'com.microsoft.VSCode', 'notes.txt — Edited', 'Dashboard | Timo',
];

/** A mixed string of about `length` pieces. */
export function mixed(rng: Rng, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += rng.chance(0.25) ? rng.pick(WORDS) : rng.pick(PIECES);
  return out;
}

/** ASCII-only string of exactly `n` UTF-16 units. */
export function filler(n: number, ch = 'a'): string {
  return ch.repeat(n);
}

/** Units in a JS string (`String.length`). */
export const units = (s: string): number => s.length;

/**
 * A string whose UTF-16 length straddles `limit`, with a surrogate pair landing
 * across the cut at the boundary more often than not.
 */
export function aroundLimit(rng: Rng, limit: number): string {
  const emoji = rng.pick(['😀', '🚀', '𝔘', '👨‍👩‍👧', '🇮🇳']);
  const lead = Math.max(0, limit + rng.int(-3, 2) - rng.int(0, 1));
  const body = filler(Math.min(lead, limit + 5));
  return rng.chance(0.7) ? body + emoji + filler(rng.int(0, 6), 'z') : body + filler(rng.int(0, 6), 'z');
}

/** A random identifier-ish ASCII token. */
export function token(rng: Rng, length: number, alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'): string {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[rng.int(0, alphabet.length - 1)];
  return out;
}

export const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
