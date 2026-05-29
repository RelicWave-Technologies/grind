import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { encryptToken, decryptToken, deriveKey } from './crypto';

const KEY_B64 = crypto.randomBytes(32).toString('base64');
const KEY_B64URL = crypto.randomBytes(32).toString('base64url');
const KEY_HEX = crypto.randomBytes(32).toString('hex');

describe('lark crypto: deriveKey', () => {
  it('accepts base64, base64url, and hex 32-byte keys', () => {
    expect(deriveKey(KEY_B64)).toHaveLength(32);
    expect(deriveKey(KEY_B64URL)).toHaveLength(32);
    expect(deriveKey(KEY_HEX)).toHaveLength(32);
  });

  it('rejects keys that do not decode to 32 bytes', () => {
    expect(() => deriveKey('too-short')).toThrow(/32 bytes/);
    expect(() => deriveKey(crypto.randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('lark crypto: encrypt/decrypt round-trip', () => {
  it('round-trips a refresh-token-shaped string', () => {
    const secret = 'rt_' + crypto.randomBytes(40).toString('base64url');
    const enc = encryptToken(secret, KEY_B64);
    expect(enc).not.toContain(secret);
    expect(decryptToken(enc, KEY_B64)).toBe(secret);
  });

  it('produces a fresh IV each call (ciphertext differs for same input)', () => {
    const a = encryptToken('same-value', KEY_B64);
    const b = encryptToken('same-value', KEY_B64);
    expect(a).not.toBe(b);
    expect(decryptToken(a, KEY_B64)).toBe('same-value');
    expect(decryptToken(b, KEY_B64)).toBe('same-value');
  });

  it('handles unicode and empty strings', () => {
    expect(decryptToken(encryptToken('', KEY_B64), KEY_B64)).toBe('');
    const u = '🔐 токен café';
    expect(decryptToken(encryptToken(u, KEY_B64), KEY_B64)).toBe(u);
  });
});

describe('lark crypto: tamper + wrong-key detection', () => {
  it('throws when decrypting with the wrong key', () => {
    const enc = encryptToken('secret', KEY_B64);
    const otherKey = crypto.randomBytes(32).toString('base64');
    expect(() => decryptToken(enc, otherKey)).toThrow();
  });

  it('throws when the ciphertext is tampered', () => {
    const enc = encryptToken('secret', KEY_B64);
    const [iv, tag, data] = enc.split('.');
    // flip a character in the ciphertext body
    const flipped = data!.slice(0, -1) + (data!.endsWith('A') ? 'B' : 'A');
    expect(() => decryptToken([iv, tag, flipped].join('.'), KEY_B64)).toThrow();
  });

  it('throws when the auth tag is tampered', () => {
    const enc = encryptToken('secret', KEY_B64);
    const [iv, tag, data] = enc.split('.');
    // Flip the FIRST char: the last base64url char of a 16-byte tag has unused
    // trailing bits, so a trailing flip can decode to the same bytes (no-op).
    const flipped = (tag!.startsWith('A') ? 'B' : 'A') + tag!.slice(1);
    expect(() => decryptToken([iv, flipped, data].join('.'), KEY_B64)).toThrow();
  });

  it('throws on malformed payloads', () => {
    expect(() => decryptToken('not-a-valid-payload', KEY_B64)).toThrow(/malformed/);
    expect(() => decryptToken('only.two', KEY_B64)).toThrow(/malformed/);
  });
});
