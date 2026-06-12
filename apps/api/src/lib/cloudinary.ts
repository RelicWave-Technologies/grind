import crypto from 'node:crypto';
import { env } from '../env';

/**
 * Cloudinary signed direct-upload helper.
 *
 * The agent never holds the Cloudinary api_secret. Instead it asks the API to
 * sign a specific upload (POST /v1/screenshots/sign); the agent then POSTs the
 * screenshot bytes straight to Cloudinary with the returned params. This keeps
 * the secret server-side while avoiding proxying image bytes through the API.
 *
 * Signature algorithm (Cloudinary spec): take every param that will be sent
 * EXCEPT `file`, `cloud_name`, `resource_type`, and `api_key`; sort by key;
 * join as `k=v` pairs with `&`; append the api_secret; SHA-1 hex digest.
 */

/** The on-the-fly transformation used to derive a gallery thumbnail URL. */
export const THUMB_TRANSFORM = 'c_fill,w_400,h_250,q_auto,f_auto';

export function isCloudinaryConfigured(): boolean {
  return Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);
}

export interface SignedUpload {
  cloudName: string;
  apiKey: string;
  uploadUrl: string;
  timestamp: number;
  signature: string;
  publicId: string;
  folder: string;
  thumbTransform: string;
}

/**
 * Mint signed upload params for one screenshot. `publicId` should be the
 * screenshot's stable id (ULID) so re-uploads overwrite rather than duplicate.
 * Throws if Cloudinary isn't configured — callers should guard with
 * isCloudinaryConfigured() and 503 first.
 */
export function signScreenshotUpload(publicId: string): SignedUpload {
  const cloudName = env.CLOUDINARY_CLOUD_NAME;
  const apiKey = env.CLOUDINARY_API_KEY;
  const apiSecret = env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error('cloudinary_not_configured');
  }

  const folder = env.CLOUDINARY_FOLDER;
  const timestamp = Math.floor(Date.now() / 1000);

  // Params to sign, sorted by key. Keep this list in sync with the fields the
  // agent actually sends to Cloudinary (besides file/api_key/cloud_name).
  const toSign: Record<string, string | number> = {
    folder,
    public_id: publicId,
    timestamp,
  };
  const signature = signParams(toSign, apiSecret);

  return {
    cloudName,
    apiKey,
    uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    timestamp,
    signature,
    publicId,
    folder,
    thumbTransform: THUMB_TRANSFORM,
  };
}

function signParams(params: Record<string, string | number>, apiSecret: string): string {
  const toSign = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
  return crypto.createHash('sha1').update(`${toSign}${apiSecret}`).digest('hex');
}
