import crypto from 'node:crypto';

/**
 * Authenticated encryption for Lark OAuth refresh tokens at rest.
 *
 * Format (all base64url, dot-delimited): `iv.tag.ciphertext`
 * - AES-256-GCM, 96-bit random IV per encryption, 128-bit auth tag.
 * - Decryption verifies the tag, so any tampering (or wrong key) throws
 *   rather than returning garbage plaintext.
 *
 * The key is supplied as `LARK_TOKEN_KEY` and must decode to exactly 32 bytes.
 * Accepts base64, base64url, or 64-char hex for operator convenience.
 */

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

export function deriveKey(raw: string): Buffer {
  // hex (64 chars)
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  // base64 / base64url
  const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
  const buf = Buffer.from(normalized, 'base64');
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `LARK_TOKEN_KEY must decode to ${KEY_BYTES} bytes (got ${buf.length}); ` +
        'generate one with: openssl rand -base64 32',
    );
  }
  return buf;
}

export function encryptToken(plaintext: string, rawKey: string): string {
  const key = deriveKey(rawKey);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString('base64url'),
    tag.toString('base64url'),
    enc.toString('base64url'),
  ].join('.');
}

export function decryptToken(payload: string, rawKey: string): string {
  const key = deriveKey(rawKey);
  const parts = payload.split('.');
  if (parts.length !== 3) {
    throw new Error('malformed ciphertext: expected iv.tag.ciphertext');
  }
  const [ivB64, tagB64, dataB64] = parts as [string, string, string];
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  const data = Buffer.from(dataB64, 'base64url');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  // .final() throws if the auth tag fails (tampering / wrong key).
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
