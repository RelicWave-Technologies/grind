import { z } from 'zod';

/**
 * Support tickets: anyone files one from the dashboard or by messaging the
 * Timo bot on Lark, an admin may file one on someone's behalf, and both sides
 * hear about every change on Lark.
 */

export const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING_ON_USER', 'RESOLVED', 'CLOSED'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_CATEGORIES = ['TIMO_APP', 'TIME_ATTENDANCE', 'LEAVE_PAYROLL', 'ACCESS', 'OTHER'] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export const TICKET_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_CLOSE_REASONS = ['USER_CONFIRMED', 'AUTO_CONFIRMED', 'WITHDRAWN', 'DUPLICATE', 'NO_RESPONSE', 'ADMIN'] as const;
export type TicketCloseReason = (typeof TICKET_CLOSE_REASONS)[number];

export const TICKET_CATEGORY_LABEL: Record<TicketCategory, string> = {
  TIMO_APP: 'Timo app',
  TIME_ATTENDANCE: 'Time & attendance',
  LEAVE_PAYROLL: 'Leave & payroll',
  ACCESS: 'Access',
  OTHER: 'Other',
};

export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  OPEN: 'Open',
  IN_PROGRESS: 'In progress',
  WAITING_ON_USER: 'Waiting on requester',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};

export const TICKET_PRIORITY_LABEL: Record<TicketPriority, string> = {
  LOW: 'Low',
  NORMAL: 'Normal',
  HIGH: 'High',
  URGENT: 'Urgent',
};

export const TICKET_CLOSE_REASON_LABEL: Record<TicketCloseReason, string> = {
  USER_CONFIRMED: 'Confirmed fixed',
  AUTO_CONFIRMED: 'Closed after no answer to "fixed?"',
  WITHDRAWN: 'Withdrawn by requester',
  DUPLICATE: 'Duplicate',
  NO_RESPONSE: 'Closed: requester did not reply',
  ADMIN: 'Closed by admin',
};

/** Statuses an admin still owes, or is waiting on. */
export const TICKET_ACTIVE_STATUSES: readonly TicketStatus[] = ['OPEN', 'IN_PROGRESS', 'WAITING_ON_USER'];

export const TICKET_SUBJECT_MAX = 120;
export const TICKET_BODY_MAX = 5000;
export const TICKET_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const TICKET_ATTACHMENTS_PER_POST = 5;
export const TICKET_ATTACHMENT_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
  'text/plain',
] as const;
/** A closed ticket can be reopened by its requester for this long. */
export const TICKET_REOPEN_WINDOW_DAYS = 7;

const idList = z.array(z.string().min(1)).max(TICKET_ATTACHMENTS_PER_POST).default([]);

export const CreateTicketRequestSchema = z.object({
  subject: z.string().trim().min(3).max(TICKET_SUBJECT_MAX),
  description: z.string().trim().min(1).max(TICKET_BODY_MAX),
  category: z.enum(TICKET_CATEGORIES).default('OTHER'),
  /** Admin only. */
  priority: z.enum(TICKET_PRIORITIES).optional(),
  /** Admin only: file the ticket for this person. */
  requesterId: z.string().min(1).optional(),
  attachmentIds: idList,
  idempotencyKey: z.string().min(8).max(80).optional(),
});
export type CreateTicketRequest = z.infer<typeof CreateTicketRequestSchema>;

export const TicketCommentRequestSchema = z.object({
  body: z.string().trim().min(1).max(TICKET_BODY_MAX),
  /** Admin only: a note the requester never sees. */
  internal: z.boolean().default(false),
  /** Admin only: the reply is a question; the ticket waits on the requester. */
  askUser: z.boolean().default(false),
  attachmentIds: idList,
});
export type TicketCommentRequest = z.infer<typeof TicketCommentRequestSchema>;

/**
 * Everything that moves a ticket. Who may send which action is enforced by the
 * API: resolve / close / duplicate / start are an admin's; withdraw, confirm
 * and reopen are the requester's (an admin may reopen too).
 */
export const TicketActionRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start') }),
  z.object({ action: z.literal('resolve'), note: z.string().trim().max(TICKET_BODY_MAX).optional() }),
  z.object({ action: z.literal('close'), note: z.string().trim().max(TICKET_BODY_MAX).optional() }),
  z.object({ action: z.literal('duplicate'), ofNumber: z.number().int().positive() }),
  z.object({ action: z.literal('withdraw'), note: z.string().trim().max(TICKET_BODY_MAX).optional() }),
  z.object({ action: z.literal('confirm') }),
  z.object({ action: z.literal('reopen'), note: z.string().trim().max(TICKET_BODY_MAX).optional() }),
  z.object({ action: z.literal('assign'), assigneeId: z.string().min(1).nullable() }),
  z.object({ action: z.literal('priority'), priority: z.enum(TICKET_PRIORITIES) }),
  z.object({ action: z.literal('category'), category: z.enum(TICKET_CATEGORIES) }),
]);
export type TicketActionRequest = z.infer<typeof TicketActionRequestSchema>;

export type TicketPersonDto = { id: string; name: string; email: string; avatarUrl: string | null };

export type TicketAttachmentDto = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  createdAt: string;
};

export type TicketSummaryDto = {
  id: string;
  number: number;
  subject: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  closeReason: TicketCloseReason | null;
  source: 'DASHBOARD' | 'LARK' | 'ADMIN';
  requester: TicketPersonDto;
  assignee: TicketPersonDto | null;
  createdAt: string;
  updatedAt: string;
  statusChangedAt: string;
  lastUserActivityAt: string;
  lastAdminActivityAt: string | null;
  requesterUnreachable: boolean;
};

export type TicketEventDto = {
  id: string;
  kind: 'CREATED' | 'COMMENT' | 'INTERNAL_NOTE' | 'STATUS' | 'ASSIGNED' | 'PRIORITY';
  actor: TicketPersonDto | null;
  body: string | null;
  fromStatus: TicketStatus | null;
  toStatus: TicketStatus | null;
  via: 'DASHBOARD' | 'LARK' | 'SYSTEM';
  meta: Record<string, unknown> | null;
  attachments: TicketAttachmentDto[];
  createdAt: string;
};

export type TicketDetailDto = TicketSummaryDto & {
  description: string;
  createdBy: TicketPersonDto;
  duplicateOf: { id: string; number: number } | null;
  resolvedAt: string | null;
  closedAt: string | null;
  attachments: TicketAttachmentDto[];
  events: TicketEventDto[];
  /** What the viewer may do, worked out on the server. */
  can: {
    manage: boolean;
    comment: boolean;
    withdraw: boolean;
    confirm: boolean;
    reopen: boolean;
  };
};

export type TicketListResponse = {
  tickets: TicketSummaryDto[];
  counts: Record<TicketStatus, number>;
};
