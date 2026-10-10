import { env } from '../env';

/**
 * Legacy Cloudinary screenshot storage.
 *
 * New screenshots go to Google Drive. Rows uploaded before that switch still
 * point at this deployment's Cloudinary account, and an agent may still be
 * completing one of those uploads, so the screenshot routes keep recognising
 * the account while its credentials are configured.
 */
export function isCloudinaryConfigured(): boolean {
  return Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);
}
