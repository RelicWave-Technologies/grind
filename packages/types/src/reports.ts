import { z } from 'zod';
import { ManualTimeRequestDto } from './manualTimeRequests';
import { SelfProfileResponseSchema } from './profile';

export const ShiftStatusSchema = z.enum(['early', 'on_time', 'late', 'no_shift', 'no_activity']);
export type ShiftStatus = z.infer<typeof ShiftStatusSchema>;

export const MemberReportTopAppSchema = z.object({
  app: z.string(),
  appBundle: z.string().nullable(),
  // Either a remote URL (brand-map fallback) or an inlined `data:image/png` URL
  // (the agent-extracted real icon), so this is a plain string, not `.url()`.
  iconUrl: z.string().nullable(),
  minutes: z.number().int().min(0),
  share: z.number().min(0).max(1),
});
export type MemberReportTopApp = z.infer<typeof MemberReportTopAppSchema>;

export const MemberReportDaySchema = z.object({
  date: z.string(),
  workedMs: z.number().int().min(0),
  meetingMs: z.number().int().min(0),
  manualMs: z.number().int().min(0),
  invalidatedMs: z.number().int().min(0),
  firstActivityMs: z.number().int().nullable(),
  lastActivityMs: z.number().int().nullable(),
  shiftStatus: ShiftStatusSchema,
  gaps: z.object({
    count: z.number().int().min(0),
    totalMs: z.number().int().min(0),
  }),
  approvals: z.object({
    approved: z.number().int().min(0),
    pending: z.number().int().min(0),
    rejected: z.number().int().min(0),
  }),
  activityPercent: z.number().int().min(0).max(100).nullable(),
  screenshots: z.object({
    count: z.number().int().min(0),
  }),
  topApps: z.array(MemberReportTopAppSchema),
});
export type MemberReportDay = z.infer<typeof MemberReportDaySchema>;

export const MemberReportsMeResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  tz: z.string(),
  days: z.array(MemberReportDaySchema),
});
export type MemberReportsMeResponse = z.infer<typeof MemberReportsMeResponseSchema>;

export const TeamReportUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  avatarUrl: z.string().nullable().default(null),
  teamId: z.string().nullable(),
  teamName: z.string().nullable(),
});
export type TeamReportUser = z.infer<typeof TeamReportUserSchema>;

export const TeamReportApprovalCountsSchema = z.object({
  approved: z.number().int().min(0),
  pending: z.number().int().min(0),
  rejected: z.number().int().min(0),
});
export type TeamReportApprovalCounts = z.infer<typeof TeamReportApprovalCountsSchema>;

export const TeamReportMemberSchema = z.object({
  user: TeamReportUserSchema,
  workedMs: z.number().int().min(0),
  manualMs: z.number().int().min(0),
  invalidatedMs: z.number().int().min(0),
  activeDays: z.number().int().min(0),
  lateDays: z.number().int().min(0),
  onTimeDays: z.number().int().min(0),
  offDays: z.number().int().min(0),
  noActivityDays: z.number().int().min(0),
  gapCount: z.number().int().min(0),
  gapMs: z.number().int().min(0),
  approvals: TeamReportApprovalCountsSchema,
  activityPercent: z.number().int().min(0).max(100).nullable(),
  screenshots: z.number().int().min(0),
  topApps: z.array(MemberReportTopAppSchema),
  days: z.array(MemberReportDaySchema),
});
export type TeamReportMember = z.infer<typeof TeamReportMemberSchema>;

export const TeamReportAttentionKindSchema = z.enum([
  'pending_approval',
  'late',
  'no_activity',
  'gap',
  'missing_activity',
  'low_activity',
]);
export type TeamReportAttentionKind = z.infer<typeof TeamReportAttentionKindSchema>;

export const TeamReportAttentionItemSchema = z.object({
  id: z.string(),
  userId: z.string(),
  userName: z.string(),
  date: z.string(),
  kind: TeamReportAttentionKindSchema,
  severity: z.enum(['danger', 'warn', 'neutral']),
  title: z.string(),
  detail: z.string(),
});
export type TeamReportAttentionItem = z.infer<typeof TeamReportAttentionItemSchema>;

export const TeamReportsResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  tz: z.string(),
  days: z.array(z.string()),
  summary: z.object({
    memberCount: z.number().int().min(0),
    workedMs: z.number().int().min(0),
    manualMs: z.number().int().min(0),
    invalidatedMs: z.number().int().min(0),
    activeDays: z.number().int().min(0),
    memberDays: z.number().int().min(0),
    lateDays: z.number().int().min(0),
    noActivityDays: z.number().int().min(0),
    gapCount: z.number().int().min(0),
    gapMs: z.number().int().min(0),
    pendingApprovals: z.number().int().min(0),
    activityPercent: z.number().int().min(0).max(100).nullable(),
    screenshots: z.number().int().min(0),
  }),
  attention: z.array(TeamReportAttentionItemSchema),
  members: z.array(TeamReportMemberSchema),
});
export type TeamReportsResponse = z.infer<typeof TeamReportsResponseSchema>;

export const TeamMemberReportsResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  tz: z.string(),
  days: z.array(z.string()),
  member: TeamReportMemberSchema,
  approvals: z.array(ManualTimeRequestDto),
  profile: SelfProfileResponseSchema,
});
export type TeamMemberReportsResponse = z.infer<typeof TeamMemberReportsResponseSchema>;

export const MemberReportAppSchema = MemberReportTopAppSchema.extend({
  keystrokes: z.number().int().min(0),
  clicks: z.number().int().min(0),
  scrolls: z.number().int().min(0),
});
export type MemberReportApp = z.infer<typeof MemberReportAppSchema>;

export const MemberReportDayAppsResponseSchema = z.object({
  date: z.string(),
  tz: z.string(),
  totalMinutes: z.number().int().min(0),
  apps: z.array(MemberReportAppSchema),
});
export type MemberReportDayAppsResponse = z.infer<typeof MemberReportDayAppsResponseSchema>;

export const ReportActivityHeatmapSchema = z.object({
  bucketMs: z.number().int().min(1),
  buckets: z.array(z.number().int().min(0).max(100).nullable()),
  sampleCounts: z.array(z.number().int().min(0)),
});
export type ReportActivityHeatmap = z.infer<typeof ReportActivityHeatmapSchema>;

export const MemberReportScreenshotSchema = z.object({
  id: z.string(),
  capturedAt: z.string(),
  thumbUrl: z.string().nullable(),
  fullUrl: z.string().nullable(),
  width: z.number().int().min(0).nullable(),
  height: z.number().int().min(0).nullable(),
  bytes: z.number().int().min(0).nullable(),
  blurred: z.boolean(),
  invalidated: z.boolean(),
  activityPercent: z.number().int().min(0).max(100).nullable(),
  dominantApp: z.string().nullable(),
  dominantAppBundle: z.string().nullable(),
  timeEntryId: z.string().nullable(),
});
export type MemberReportScreenshot = z.infer<typeof MemberReportScreenshotSchema>;

export const MemberReportDayScreenshotsResponseSchema = z.object({
  date: z.string(),
  tz: z.string(),
  activityPercent: z.number().int().min(0).max(100).nullable(),
  heatmap: ReportActivityHeatmapSchema,
  screenshots: z.array(MemberReportScreenshotSchema),
});
export type MemberReportDayScreenshotsResponse = z.infer<typeof MemberReportDayScreenshotsResponseSchema>;

export const ScreenshotUploadStateSchema = z.enum(['PENDING', 'UPLOADED', 'FAILED']);
export type ScreenshotUploadState = z.infer<typeof ScreenshotUploadStateSchema>;

export const PendingScreenshotUploadRequest = z.object({
  id: z.string().min(1),
  timeEntryId: z.string().min(1).nullable().optional(),
  displayId: z.string().max(120).nullable().optional(),
  capturedAt: z.string().datetime({ offset: true }),
  bytes: z.number().int().min(0).nullable().optional(),
  width: z.number().int().min(0).nullable().optional(),
  height: z.number().int().min(0).nullable().optional(),
  blurred: z.boolean().optional(),
});
export type PendingScreenshotUploadRequest = z.infer<typeof PendingScreenshotUploadRequest>;

export const PendingScreenshotUploadResponse = z.object({
  id: z.string(),
  uploadState: z.literal('PENDING'),
  uploadUrl: z.string().nullable(),
  uploadHeaders: z.record(z.string()),
});
export type PendingScreenshotUploadResponse = z.infer<typeof PendingScreenshotUploadResponse>;

export const CompleteScreenshotUploadRequest = z.object({
  id: z.string().min(1),
  timeEntryId: z.string().min(1).nullable().optional(),
  displayId: z.string().max(120).nullable().optional(),
  capturedAt: z.string().datetime({ offset: true }),
  s3Key: z.string().max(1024).nullable().optional(),
  thumbS3Key: z.string().max(1024).nullable().optional(),
  fullUrl: z.string().url().nullable().optional(),
  thumbUrl: z.string().url().nullable().optional(),
  bytes: z.number().int().min(0).nullable().optional(),
  width: z.number().int().min(0).nullable().optional(),
  height: z.number().int().min(0).nullable().optional(),
  phash: z.string().regex(/^-?\d+$/u).nullable().optional(),
  blurred: z.boolean().optional(),
  uploadState: ScreenshotUploadStateSchema.default('UPLOADED'),
});
export type CompleteScreenshotUploadRequest = z.infer<typeof CompleteScreenshotUploadRequest>;

export const CompleteScreenshotUploadResponse = z.object({
  id: z.string(),
  uploadState: ScreenshotUploadStateSchema,
});
export type CompleteScreenshotUploadResponse = z.infer<typeof CompleteScreenshotUploadResponse>;

/**
 * Ask the API to mint a short-lived Cloudinary signature so the agent can
 * upload a screenshot directly to Cloudinary without ever holding the
 * api_secret. The agent supplies the screenshot id; the server derives the
 * public_id + folder and signs the upload params.
 */
export const SignScreenshotUploadRequest = z.object({
  id: z.string().min(1),
});
export type SignScreenshotUploadRequest = z.infer<typeof SignScreenshotUploadRequest>;

export const SignScreenshotUploadResponse = z.object({
  // Cloudinary unsigned-upload coordinates the agent POSTs the file to.
  cloudName: z.string(),
  apiKey: z.string(),
  uploadUrl: z.string().url(),
  // Signed params — the agent must send exactly these, unchanged.
  timestamp: z.number().int(),
  signature: z.string(),
  publicId: z.string(),
  folder: z.string(),
  // Convenience: the eager thumbnail transformation the server expects back,
  // so the agent doesn't have to know the transform string.
  thumbTransform: z.string(),
});
export type SignScreenshotUploadResponse = z.infer<typeof SignScreenshotUploadResponse>;
