import { z } from 'zod';

/**
 * Workspace-wide capture policy (M14). One row per workspace; created
 * lazily on first read. Defaults are privacy-conscious — capture is OFF
 * across the board, and ADMINs explicitly flip flags on.
 *
 * Three flags exist along a strictness gradient:
 *   - captureApps    = which application is in focus (e.g. "Chrome")
 *   - captureTitles  = the foreground window title (leaks doc names)
 *   - captureUrls    = the browser URL (true content)
 *
 * captureTitles + captureUrls imply captureApps must be on for the data
 * to actually flow — there's no point in titles without an app context.
 * The server validates this at PATCH time (see refine below).
 *
 * retentionDaysScreenshots drives the nightly screenshot purge. Default
 * 60 per the privacy contract; setting it to 0 keeps shots forever.
 */
export const WorkspacePolicyDto = z.object({
  workspaceId: z.string().min(1),
  captureApps: z.boolean(),
  captureTitles: z.boolean(),
  captureUrls: z.boolean(),
  retentionDaysScreenshots: z.number().int().min(0).max(3650),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type WorkspacePolicyDto = z.infer<typeof WorkspacePolicyDto>;

/** PATCH body — every field optional; server merges into the existing row. */
export const PatchWorkspacePolicyRequest = z
  .object({
    captureApps: z.boolean().optional(),
    captureTitles: z.boolean().optional(),
    captureUrls: z.boolean().optional(),
    retentionDaysScreenshots: z.number().int().min(0).max(3650).optional(),
  })
  .refine(
    (v) => Object.keys(v).length > 0,
    { message: 'at_least_one_field_required' },
  );
export type PatchWorkspacePolicyRequest = z.infer<typeof PatchWorkspacePolicyRequest>;

/**
 * Defaults applied when no row exists for a workspace yet — kept here so
 * the API + tests + agent all share one source of truth.
 */
export const WORKSPACE_POLICY_DEFAULTS = {
  captureApps: false,
  captureTitles: false,
  captureUrls: false,
  retentionDaysScreenshots: 60,
} as const;

/**
 * Pure helper: scrub fields the workspace policy disallows. The server
 * runs this on every incoming ActivitySample BEFORE persisting so a
 * misbehaving agent can't smuggle in disabled fields.
 *
 * Rules:
 *   - !captureApps   → drop app + bundle + title + url (nothing flows)
 *   - !captureTitles → drop title
 *   - !captureUrls   → drop url
 */
export interface PolicyFlags {
  captureApps: boolean;
  captureTitles: boolean;
  captureUrls: boolean;
}

export interface CapturedActiveFields {
  activeApp?: string | null | undefined;
  activeAppBundle?: string | null | undefined;
  activeTitle?: string | null | undefined;
  activeUrl?: string | null | undefined;
}

export function applyPolicyToActive<T extends CapturedActiveFields>(
  sample: T,
  policy: PolicyFlags,
): T {
  if (!policy.captureApps) {
    return { ...sample, activeApp: null, activeAppBundle: null, activeTitle: null, activeUrl: null };
  }
  const out: T = { ...sample };
  if (!policy.captureTitles) out.activeTitle = null;
  if (!policy.captureUrls) out.activeUrl = null;
  return out;
}
