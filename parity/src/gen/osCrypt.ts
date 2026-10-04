import { createCipheriv, pbkdf2Sync } from 'node:crypto';
import type { FnSpec } from '../fixture';
import type { Rng } from '../prng';

/**
 * Chromium `os_crypt` "v10" blobs (what Electron's `safeStorage.encryptString`
 * writes), produced by Node's OpenSSL-backed `crypto`: an implementation that
 * shares no code with the Rust crates (RustCrypto). The Rust test decrypts every
 * `output` back to `input.plaintext`, and its own encryption must reproduce the
 * same bytes. The recipe is read from Chromium 130.0.6723.118 (Electron 33.2.0),
 * `components/os_crypt/sync/os_crypt_{mac.mm,win.cc}`, see crates/timo-sync/OSCRYPT.md.
 *
 * Blobs are recorded base64; a macOS password and every plaintext are the UTF-8
 * bytes of the recorded string. (A real Keychain password is 24 ASCII base64
 * characters; the unicode and long ones prove the "verbatim bytes" claim.)
 */
const crate = 'timo-sync';
const module = 'osCrypt';

interface MacInput { password: string; plaintext: string }
interface WindowsInput { keyHex: string; nonceHex: string; plaintext: string }
interface KeyInput { password: string }

/** `OSCryptImpl::GetEncryptionKey`: PBKDF2-HMAC-SHA1, salt "saltysalt", 1003 iterations, 16 bytes. */
function macKey(password: string): Buffer {
  return pbkdf2Sync(Buffer.from(password, 'utf8'), Buffer.from('saltysalt', 'utf8'), 1003, 16, 'sha1');
}

/** `OSCryptImpl::EncryptString` (mac): "v10" + AES-128-CBC/PKCS#7, IV = 16 spaces; "" encrypts to "". */
function macEncrypt({ password, plaintext }: MacInput): string {
  if (plaintext.length === 0) return '';
  const cipher = createCipheriv('aes-128-cbc', macKey(password), Buffer.alloc(16, 0x20));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from('v10', 'ascii'), body]).toString('base64');
}

/** `OSCryptImpl::EncryptString` (win): "v10" + nonce(12) + AES-256-GCM ciphertext + tag(16), no AAD. */
function windowsEncrypt({ keyHex, nonceHex, plaintext }: WindowsInput): string {
  const nonce = Buffer.from(nonceHex, 'hex');
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), nonce);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([Buffer.from('v10', 'ascii'), nonce, body]).toString('base64');
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function chars(rng: Rng, alphabet: string, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[rng.int(0, alphabet.length - 1)];
  return out;
}

/** A Chromium-style Keychain password: base64 of 16 random bytes (24 characters). */
function keychainPassword(rng: Rng): string {
  return `${chars(rng, B64, 22)}==`;
}

/** Code points from a mixed bag, never a lone surrogate. */
function unicode(rng: Rng, length: number): string {
  const ranges: ReadonlyArray<readonly [number, number]> = [[0x20, 0x7e], [0xa0, 0x24f], [0x400, 0x4ff], [0x3040, 0x30ff], [0x4e00, 0x4fff], [0x1f300, 0x1f64f], [0x01, 0x1f]];
  let out = '';
  for (let i = 0; i < length; i++) {
    const [lo, hi] = rng.pick(ranges);
    out += String.fromCodePoint(rng.int(lo, hi));
  }
  return out;
}

function jwtLike(rng: Rng): string {
  const part = (n: number): string => chars(rng, B64URL, n);
  return `eyJ${part(rng.int(30, 60))}.eyJ${part(rng.int(120, 260))}.${part(43)}`;
}

/** `JSON.stringify` of a real `StoredTokens`, key order as `tokenStore.ts` writes it. */
function tokensJson(rng: Rng): string {
  return JSON.stringify({
    accessToken: jwtLike(rng),
    refreshToken: chars(rng, B64URL, rng.int(40, 90)),
    userId: `usr_${chars(rng, B64URL, 12)}`,
    workspaceId: `ws_${chars(rng, B64URL, 12)}`,
  });
}

function pendingJson(rng: Rng): string {
  return JSON.stringify({
    verifier: chars(rng, B64URL, rng.int(43, 128)),
    loginUrl: `https://open.larksuite.com/open-apis/authen/v1/authorize?state=${chars(rng, B64URL, 22)}&redirect_uri=timo%3A%2F%2Fauth`,
    createdAt: 1791133383891 + rng.int(0, 99999999),
  });
}

function plaintext(rng: Rng): string {
  return rng.weighted<() => string>([
    [() => tokensJson(rng), 30],
    [() => pendingJson(rng), 8],
    [() => unicode(rng, rng.int(0, 120)), 25],
    [() => chars(rng, B64, rng.int(0, 70)), 25],
    // every length around the first four AES blocks
    [() => 'x'.repeat(rng.int(0, 65)), 12],
  ])();
}

const PASSWORDS = [
  'aBcDeFgHiJkLmNoPqRsTuV==', // the shape Chromium stores
  'p',
  'pässwörd-日本語-🙂',
  'a b\u0000c\u0001d',
  'x'.repeat(63),
  'x'.repeat(64), // exactly HMAC-SHA1's block size
  'x'.repeat(65), // one over: HMAC hashes the key first
  'k'.repeat(300),
  '0123456789abcdefghij/+==',
];

const SAMPLE_TOKENS = JSON.stringify({
  accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c3JfOGZLM3Eyd1BtWnYiLCJ3cyI6IndzX3Q1UjlaYUJjRGVGIiwiaWF0IjoxNzkxMTMzMzgzLCJleHAiOjE3OTExMzQyODN9.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  refreshToken: 'Zm9vYmFyYmF6cXV4cXV1eHF1dXV4Zm9vYmFyYmF6cXV4cXV1eHF1dXV4Zm9vYmFy',
  userId: 'usr_8fK3q2wPmZv',
  workspaceId: 'ws_t5R9ZaBcDeF',
});

const PLAINTEXTS = [
  '',
  'a',
  'x'.repeat(15),
  'x'.repeat(16), // exactly one AES block: CBC adds a whole padding block
  'x'.repeat(17),
  'x'.repeat(31),
  'x'.repeat(32), // exactly two blocks
  'x'.repeat(33),
  'x'.repeat(48),
  'héllo wörld – 日本語 – 🙂 – \u0000\u0001\u001f\u007f',
  'line1\nline2\r\n\ttabbed "quoted" \\backslashed\\',
  SAMPLE_TOKENS,
  JSON.stringify({ verifier: 'v'.repeat(64), loginUrl: 'https://open.larksuite.com/open-apis/authen/v1/authorize?x=1', createdAt: 1791133383891 }),
  'Z'.repeat(5000), // many blocks
];

export const macEncryptSpec: FnSpec<MacInput> = {
  crate,
  module,
  fn: 'macEncrypt',
  edge: () => [
    ...PASSWORDS.map((password) => ({ password, plaintext: SAMPLE_TOKENS })),
    ...PLAINTEXTS.map((p) => ({ password: PASSWORDS[0]!, plaintext: p })),
  ],
  random: (rng) => ({ password: rng.chance(0.85) ? keychainPassword(rng) : unicode(rng, rng.int(1, 100)), plaintext: plaintext(rng) }),
  call: macEncrypt,
};

export const macDeriveKeySpec: FnSpec<KeyInput> = {
  crate,
  module,
  fn: 'macDeriveKey',
  edge: () => PASSWORDS.map((password) => ({ password })),
  random: (rng) => ({ password: rng.chance(0.85) ? keychainPassword(rng) : unicode(rng, rng.int(1, 150)) }),
  call: ({ password }) => macKey(password).toString('hex'),
};

const HEX = '0123456789abcdef';
const hex = (rng: Rng, bytes: number): string => chars(rng, HEX, bytes * 2);

export const windowsEncryptSpec: FnSpec<WindowsInput> = {
  crate,
  module,
  fn: 'windowsEncrypt',
  edge: () => {
    const keys = ['00'.repeat(32), 'ff'.repeat(32), Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0')).join('')];
    const nonces = ['00'.repeat(12), 'ff'.repeat(12), '000102030405060708090a0b'];
    return [
      ...PLAINTEXTS.map((p, i) => ({ keyHex: keys[i % keys.length]!, nonceHex: nonces[i % nonces.length]!, plaintext: p })),
      ...keys.map((keyHex, i) => ({ keyHex, nonceHex: nonces[i]!, plaintext: SAMPLE_TOKENS })),
    ];
  },
  random: (rng) => ({ keyHex: hex(rng, 32), nonceHex: hex(rng, 12), plaintext: plaintext(rng) }),
  call: windowsEncrypt,
};

export const specs: FnSpec<any>[] = [macEncryptSpec, macDeriveKeySpec, windowsEncryptSpec];
