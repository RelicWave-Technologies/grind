import crypto from 'node:crypto';
import { env } from '../env';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const DRIVE_FILE_URL = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * Every Drive round trip is bounded. An unbounded fetch held an agent's upload
 * request (and the image endpoint) open for as long as Google took to answer —
 * sometimes never — while the agent's own timeout fired and retried, piling
 * duplicate uploads onto a request that was still running.
 */
const DRIVE_METADATA_TIMEOUT_MS = 15_000;
const DRIVE_UPLOAD_TIMEOUT_MS = 90_000;
const DRIVE_DOWNLOAD_TIMEOUT_MS = 30_000;

let cachedAccessToken: { token: string; expiresAtMs: number } | null = null;

/**
 * Month folder ids, by folder name, for the life of the process.
 *
 * Without this every screenshot would cost a `files.list` before its upload —
 * roughly 7,500 extra round trips a day. The cache is never invalidated: a
 * folder id does not change, and a restart simply re-finds it.
 */
/**
 * Month name -> the in-flight or settled lookup for its folder id.
 *
 * The promise is cached, not the id. Two uploads arriving together on the
 * first of a month would otherwise both find nothing and both create, leaving
 * two folders with the same name and a month split across them. Caching the
 * promise makes the second caller await the first one's answer.
 */
const monthFolderIds = new Map<string, Promise<string>>();

/**
 * 'September 2026' for an instant, read in the business timezone.
 *
 * The timezone matters at the edges: a screenshot captured at 00:30 IST on the
 * 1st is September's, and filing it under August because UTC still said the
 * 31st would put a person's month in two places.
 */
export function driveMonthFolderName(capturedAt: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: tz })
    .format(capturedAt);
}

/**
 * The id of the month folder, creating it the first time it is needed.
 *
 * Screenshots used to land in one flat folder, which is how a shared drive
 * reaches its 400,000-item ceiling with nothing anybody can reasonably delete.
 * A folder per month gives retention something to remove in one call and gives
 * a human somewhere to look.
 *
 * The `drive.file` scope only sees what this app created, so the lookup finds
 * folders we made and not ones created by hand in the Drive UI — a manually
 * created 'September 2026' would be shadowed by one of ours. That is the
 * trade for not asking for full-drive access.
 */
async function ensureMonthFolder(name: string): Promise<string | undefined> {
  const parent = env.GOOGLE_DRIVE_FOLDER_ID;
  if (!parent) return undefined;

  const cached = monthFolderIds.get(name);
  if (cached) return cached;

  const pending = (async () => {
    const token = await getAccessToken();
    const found = await findFolder(token, name, parent);
    return found ?? (await createFolder(token, name, parent));
  })();
  // Drop a failed lookup so the next upload retries rather than caching the
  // error for the life of the process.
  monthFolderIds.set(name, pending);
  pending.catch(() => monthFolderIds.delete(name));
  return pending;
}

async function findFolder(token: string, name: string, parent: string): Promise<string | undefined> {
  const url = new URL(DRIVE_FILE_URL);
  // The name is ours, not user input, but a quote in it would still break the
  // query — escape rather than trust.
  const safe = name.replace(/'/gu, "\\'");
  url.searchParams.set('q', `name='${safe}' and mimeType='${FOLDER_MIME}' and '${parent}' in parents and trashed=false`);
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('includeItemsFromAllDrives', 'true');
  url.searchParams.set('fields', 'files(id)');
  url.searchParams.set('pageSize', '1');
  if (env.GOOGLE_DRIVE_SHARED_DRIVE_ID) {
    url.searchParams.set('corpora', 'drive');
    url.searchParams.set('driveId', env.GOOGLE_DRIVE_SHARED_DRIVE_ID);
  }
  const res = await driveFetch(url, { headers: { Authorization: `Bearer ${token}` } }, DRIVE_METADATA_TIMEOUT_MS, 'folder_lookup');
  if (!res.ok) throw new Error(`google_drive_folder_lookup_failed:${res.status}:${await safeText(res)}`);
  const json = (await res.json()) as { files?: Array<{ id: string }> };
  return json.files?.[0]?.id;
}

async function createFolder(token: string, name: string, parent: string): Promise<string> {
  const url = new URL(DRIVE_FILE_URL);
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('fields', 'id');
  const res = await driveFetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }),
  }, DRIVE_METADATA_TIMEOUT_MS, 'folder_create');
  if (!res.ok) throw new Error(`google_drive_folder_create_failed:${res.status}:${await safeText(res)}`);
  const json = (await res.json()) as { id?: string };
  if (!json.id) throw new Error('google_drive_folder_create_missing_id');
  return json.id;
}

/**
 * fetch with a deadline. A timeout or a dropped connection is reported as a
 * `google_drive_*` error like any other Drive failure, so callers that map
 * storage failures to "try again later" treat a hung Drive the same way.
 */
async function driveFetch(url: URL | string, init: RequestInit, timeoutMs: number, label: string): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const reason = err instanceof Error ? `${err.name}:${err.message}` : String(err);
    throw new Error(`google_drive_${label}_unreachable:${reason}`.slice(0, 500));
  }
}

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
  /** When the shot was taken. Decides which month folder it is filed under. */
  capturedAt?: Date;
  /** Business timezone the month is read in. */
  tz?: string;
}): Promise<{ fileId: string }> {
  const token = await getAccessToken();
  const parent = input.capturedAt
    ? await ensureMonthFolder(driveMonthFolderName(input.capturedAt, input.tz ?? 'UTC'))
    : env.GOOGLE_DRIVE_FOLDER_ID;
  const boundary = `grind_${crypto.randomBytes(12).toString('hex')}`;
  const metadata: Record<string, unknown> = {
    name: input.filename,
    mimeType: 'image/webp',
    parents: parent ? [parent] : undefined,
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
  const res = await driveFetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': String(body.byteLength),
    },
    body,
  }, DRIVE_UPLOAD_TIMEOUT_MS, 'upload');
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
  const res = await driveFetch(url, { headers: { Authorization: `Bearer ${token}` } }, DRIVE_DOWNLOAD_TIMEOUT_MS, 'download');
  if (!res.ok) {
    throw new Error(`google_drive_download_failed:${res.status}:${await safeText(res)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * The name Drive holds for a file, or null when the file is gone.
 *
 * Only the upload endpoint names screenshot files, as `<userId>-<shotId>.webp`,
 * from a server-signed token. Reading the name back is therefore proof of whose
 * shot a file id really is — which a file id supplied by a client is not.
 */
export async function getDriveFileName(fileId: string): Promise<string | null> {
  const token = await getAccessToken();
  const url = new URL(`${DRIVE_FILE_URL}/${encodeURIComponent(fileId)}`);
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('fields', 'name,trashed');
  const res = await driveFetch(url, { headers: { Authorization: `Bearer ${token}` } }, DRIVE_METADATA_TIMEOUT_MS, 'metadata');
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`google_drive_metadata_failed:${res.status}:${await safeText(res)}`);
  }
  const json = (await res.json()) as { name?: string; trashed?: boolean };
  if (json.trashed) return null;
  return typeof json.name === 'string' ? json.name : null;
}

/** The file name the upload endpoint gives a user's screenshot. */
export function screenshotDriveFileName(userId: string, screenshotId: string): string {
  return `${userId}-${screenshotId}.webp`;
}

export async function trashScreenshotInDrive(fileId: string): Promise<'trashed' | 'missing'> {
  const token = await getAccessToken();
  const url = new URL(`${DRIVE_FILE_URL}/${encodeURIComponent(fileId)}`);
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('fields', 'id,trashed');
  const res = await driveFetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ trashed: true }),
  }, DRIVE_METADATA_TIMEOUT_MS, 'trash');
  if (res.status === 404) return 'missing';
  if (!res.ok) {
    throw new Error(`google_drive_trash_failed:${res.status}:${await safeText(res)}`);
  }
  return 'trashed';
}

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAtMs - Date.now() > 60_000) {
    return cachedAccessToken.token;
  }
  const assertion = createJwtAssertion();
  const res = await driveFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  }, DRIVE_METADATA_TIMEOUT_MS, 'oauth');
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
