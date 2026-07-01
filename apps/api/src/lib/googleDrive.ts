import crypto from 'node:crypto';
import { env } from '../env';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const DRIVE_FILE_URL = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

let cachedAccessToken: { token: string; expiresAtMs: number } | null = null;

export function isGoogleDriveConfigured(): boolean {
  return Boolean(
    env.GOOGLE_DRIVE_CLIENT_EMAIL &&
      (env.GOOGLE_DRIVE_PRIVATE_KEY || env.GOOGLE_DRIVE_PRIVATE_KEY_BASE64) &&
      env.GOOGLE_DRIVE_FOLDER_ID,
  );
}

export async function uploadScreenshotToDrive(input: {
  data: Buffer;
  filename: string;
}): Promise<{ fileId: string }> {
  const token = await getAccessToken();
  const boundary = `grind_${crypto.randomBytes(12).toString('hex')}`;
  const metadata: Record<string, unknown> = {
    name: input.filename,
    mimeType: 'image/webp',
    parents: env.GOOGLE_DRIVE_FOLDER_ID ? [env.GOOGLE_DRIVE_FOLDER_ID] : undefined,
  };
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
    Buffer.from(JSON.stringify(metadata)),
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: image/webp\r\n\r\n`),
    input.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const url = new URL(DRIVE_UPLOAD_URL);
  url.searchParams.set('uploadType', 'multipart');
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('fields', 'id');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': String(body.byteLength),
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`google_drive_upload_failed:${res.status}:${await safeText(res)}`);
  }
  const json = (await res.json()) as { id?: string };
  if (!json.id) throw new Error('google_drive_upload_missing_id');
  return { fileId: json.id };
}

export async function downloadScreenshotFromDrive(fileId: string): Promise<Buffer> {
  const token = await getAccessToken();
  const url = new URL(`${DRIVE_FILE_URL}/${encodeURIComponent(fileId)}`);
  url.searchParams.set('alt', 'media');
  url.searchParams.set('supportsAllDrives', 'true');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`google_drive_download_failed:${res.status}:${await safeText(res)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAtMs - Date.now() > 60_000) {
    return cachedAccessToken.token;
  }
  const assertion = createJwtAssertion();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`google_oauth_failed:${res.status}:${await safeText(res)}`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error('google_oauth_missing_access_token');
  cachedAccessToken = {
    token: json.access_token,
    expiresAtMs: Date.now() + Math.max(60, json.expires_in ?? 3600) * 1000,
  };
  return cachedAccessToken.token;
}

function createJwtAssertion(): string {
  const email = env.GOOGLE_DRIVE_CLIENT_EMAIL;
  const privateKey = normalizedPrivateKey();
  if (!email || !privateKey) throw new Error('google_drive_not_configured');

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: email,
    scope: DRIVE_SCOPE,
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now,
  };
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(privateKey).toString('base64url');
  return `${unsigned}.${signature}`;
}

function normalizedPrivateKey(): string | null {
  if (env.GOOGLE_DRIVE_PRIVATE_KEY_BASE64) {
    return Buffer.from(env.GOOGLE_DRIVE_PRIVATE_KEY_BASE64, 'base64').toString('utf8').replace(/\\n/gu, '\n');
  }
  return env.GOOGLE_DRIVE_PRIVATE_KEY?.replace(/\\n/gu, '\n') ?? null;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

async function safeText(res: Response): Promise<string> {
  return (await res.text().catch(() => '')).slice(0, 500);
}
