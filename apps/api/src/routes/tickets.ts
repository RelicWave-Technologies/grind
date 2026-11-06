import { Router, type Request, type Response, type NextFunction } from 'express';
import { prisma, type Prisma } from '@grind/db';
import {
  CreateTicketRequestSchema,
  TICKET_ATTACHMENT_MAX_BYTES,
  TICKET_ATTACHMENT_MIME_TYPES,
  TICKET_REOPEN_WINDOW_DAYS,
  TICKET_STATUSES,
  TicketActionRequestSchema,
  TicketCommentRequestSchema,
  type TicketAttachmentDto,
  type TicketDetailDto,
  type TicketEventDto,
  type TicketListResponse,
  type TicketPersonDto,
  type TicketStatus,
  type TicketSummaryDto,
  ticketTurn,
} from '@grind/types';
import { PutAccessRequestRecipientsRequest, type AccessRequestRecipientsResponse } from '@grind/types';
import { requireAccessToken } from '../middleware/auth';
import { attachScope, requireAdmin, requireCapability } from '../middleware/scope';
import {
  addTicketComment,
  applyTicketAction,
  createTicket,
  loadTicketActor,
  TicketError,
  type TicketActor,
} from '../tickets/service';

/**
 * /v1/tickets — support tickets from the dashboard.
 *
 * Everyone signed in files and follows their own tickets (`tickets.self`);
 * admins (`tickets.manage`) see and work every ticket in the workspace and may
 * file one on someone's behalf. A ticket someone may not see answers 404, so
 * ticket ids cannot be probed.
 */

export const ticketsRouter = Router();
ticketsRouter.use(requireAccessToken, attachScope, requireCapability('tickets.self'));

const PERSON = { select: { id: true, name: true, email: true, avatarUrl: true } } as const;

function person(p: { id: string; name: string; email: string; avatarUrl: string | null } | null): TicketPersonDto | null {
  return p ? { id: p.id, name: p.name, email: p.email, avatarUrl: p.avatarUrl } : null;
}

function attachmentDto(a: { id: string; fileName: string; mimeType: string; sizeBytes: number; createdAt: Date }): TicketAttachmentDto {
  return {
    id: a.id,
    fileName: a.fileName,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    url: `/v1/tickets/attachments/${a.id}`,
    createdAt: a.createdAt.toISOString(),
  };
}

const ATTACHMENT_META = { select: { id: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true, eventId: true } } as const;

type SummaryRow = Prisma.TicketGetPayload<{ include: { requester: typeof PERSON; assignee: typeof PERSON } }>;

type LastReply = TicketSummaryDto['lastReply'];

/** The latest public reply on each ticket, in one query. */
async function lastReplies(tickets: Array<{ id: string; requesterId: string }>): Promise<Map<string, LastReply>> {
  if (tickets.length === 0) return new Map();
  const rows = await prisma.ticketEvent.findMany({
    where: { ticketId: { in: tickets.map((t) => t.id) }, kind: 'COMMENT' },
    orderBy: [{ ticketId: 'asc' }, { createdAt: 'desc' }],
    distinct: ['ticketId'],
    select: { ticketId: true, body: true, createdAt: true, actorId: true, actor: { select: { name: true } } },
  });
  const requesterOf = new Map(tickets.map((t) => [t.id, t.requesterId]));
  return new Map(rows.map((r) => [r.ticketId, {
    by: r.actor?.name ?? 'Someone',
    fromRequester: r.actorId === requesterOf.get(r.ticketId),
    snippet: (r.body ?? '').replace(/\s+/gu, ' ').slice(0, 140),
    at: r.createdAt.toISOString(),
  }]));
}

function summaryDto(t: SummaryRow, lastReply: LastReply = null): TicketSummaryDto {
  return {
    id: t.id,
    number: t.number,
    subject: t.subject,
    category: t.category,
    priority: t.priority,
    status: t.status,
    closeReason: t.closeReason,
    source: t.source,
    requester: person(t.requester)!,
    assignee: person(t.assignee),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    statusChangedAt: t.statusChangedAt.toISOString(),
    lastUserActivityAt: t.lastUserActivityAt.toISOString(),
    lastAdminActivityAt: t.lastAdminActivityAt?.toISOString() ?? null,
    requesterUnreachable: t.requesterUnreachable,
    turn: ticketTurn(t),
    lastReply,
  };
}

async function actorOf(req: Request): Promise<TicketActor> {
  const actor = req.user ? await loadTicketActor(req.user.sub) : null;
  if (!actor || actor.workspaceId !== req.scope?.workspaceId) throw new TicketError('forbidden', 403);
  return actor;
}

function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof TicketError) return res.status(err.status).json({ error: err.code });
      next(err);
    }
  };
}

ticketsRouter.get('/', handle(async (req, res) => {
  const actor = await actorOf(req);
  const scope = req.query.scope === 'all' ? 'all' : 'mine';
  if (scope === 'all' && !actor.isAdmin) return res.status(403).json({ error: 'forbidden' });
  const status = typeof req.query.status === 'string' && (TICKET_STATUSES as readonly string[]).includes(req.query.status)
    ? (req.query.status as TicketStatus)
    : null;
  const base: Prisma.TicketWhereInput = scope === 'all'
    ? { workspaceId: actor.workspaceId }
    : { workspaceId: actor.workspaceId, requesterId: actor.id };
  const [tickets, grouped] = await Promise.all([
    prisma.ticket.findMany({
      where: { ...base, ...(status ? { status } : {}) },
      include: { requester: PERSON, assignee: PERSON },
      orderBy: [{ updatedAt: 'desc' }],
      take: 500,
    }),
    prisma.ticket.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
  ]);
  const counts = Object.fromEntries(TICKET_STATUSES.map((s) => [s, 0])) as Record<TicketStatus, number>;
  for (const g of grouped) counts[g.status] = g._count._all;
  const replies = await lastReplies(tickets);
  const body: TicketListResponse = { tickets: tickets.map((t) => summaryDto(t, replies.get(t.id) ?? null)), counts };
  res.json(body);
}));

/** People an admin can assign a ticket to. */
ticketsRouter.get('/assignees', requireCapability('tickets.manage'), handle(async (req, res) => {
  const actor = await actorOf(req);
  const admins = await prisma.user.findMany({
    where: { workspaceId: actor.workspaceId, role: 'ADMIN', provisioningStatus: 'ACTIVE', deactivatedAt: null },
    ...PERSON,
    orderBy: { name: 'asc' },
  });
  res.json({ assignees: admins.map(person) });
}));

/**
 * Which admins get the pinned Lark card for every ticket. Picking none means
 * every admin.
 */
async function loadRecipients(workspaceId: string): Promise<AccessRequestRecipientsResponse> {
  const [policy, admins] = await Promise.all([
    prisma.workspacePolicy.findUnique({ where: { workspaceId }, select: { ticketAdminIds: true } }),
    prisma.user.findMany({
      where: { workspaceId, role: 'ADMIN', provisioningStatus: 'ACTIVE', deactivatedAt: null },
      select: { id: true, name: true, email: true, larkIdentity: { select: { id: true } } },
      orderBy: { name: 'asc' },
    }),
  ]);
  const chosen = new Set(policy?.ticketAdminIds ?? []);
  const rows = admins.map((a) => ({ id: a.id, name: a.name, email: a.email, hasLark: Boolean(a.larkIdentity), chosen: chosen.has(a.id) }));
  return { allAdmins: !rows.some((r) => r.chosen), admins: rows };
}

ticketsRouter.get('/recipients', requireAdmin, handle(async (req, res) => {
  res.json(await loadRecipients(req.scope!.workspaceId));
}));

ticketsRouter.put('/recipients', requireAdmin, handle(async (req, res) => {
  const parsed = PutAccessRequestRecipientsRequest.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  const workspaceId = req.scope!.workspaceId;
  const ids = [...new Set(parsed.data.userIds)];
  const valid = await prisma.user.count({
    where: { id: { in: ids }, workspaceId, role: 'ADMIN', provisioningStatus: 'ACTIVE', deactivatedAt: null },
  });
  if (valid !== ids.length) return res.status(400).json({ error: 'not_an_admin' });
  await prisma.workspacePolicy.upsert({
    where: { workspaceId },
    create: { workspaceId, ticketAdminIds: ids },
    update: { ticketAdminIds: ids },
  });
  res.json(await loadRecipients(workspaceId));
}));

ticketsRouter.post('/', handle(async (req, res) => {
  const actor = await actorOf(req);
  const parsed = CreateTicketRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', detail: parsed.error.issues[0]?.message });
  const ticket = await createTicket({
    actor,
    requesterId: parsed.data.requesterId,
    subject: parsed.data.subject,
    description: parsed.data.description,
    category: parsed.data.category,
    priority: parsed.data.priority,
    via: 'DASHBOARD',
    attachmentIds: parsed.data.attachmentIds,
    idempotencyKey: parsed.data.idempotencyKey,
  });
  res.status(201).json({ id: ticket.id, number: ticket.number });
}));

async function loadVisible(id: string, actor: TicketActor) {
  const ticket = await prisma.ticket.findUnique({ where: { id }, select: { id: true, workspaceId: true, requesterId: true } });
  if (!ticket || ticket.workspaceId !== actor.workspaceId || (!actor.isAdmin && ticket.requesterId !== actor.id)) {
    throw new TicketError('not_found', 404);
  }
  return ticket;
}

async function detailDto(id: string, actor: TicketActor): Promise<TicketDetailDto> {
  await loadVisible(id, actor);
  const t = await prisma.ticket.findUniqueOrThrow({
    where: { id },
    include: {
      requester: PERSON,
      assignee: PERSON,
      createdBy: PERSON,
      duplicateOf: { select: { id: true, number: true } },
      attachments: { ...ATTACHMENT_META, orderBy: { createdAt: 'asc' } },
      events: {
        // The requester never sees internal notes.
        where: actor.isAdmin ? {} : { kind: { not: 'INTERNAL_NOTE' } },
        orderBy: { createdAt: 'asc' },
        include: { actor: PERSON },
      },
    },
  });
  const byEvent = new Map<string, TicketAttachmentDto[]>();
  for (const a of t.attachments) {
    if (!a.eventId) continue;
    byEvent.set(a.eventId, [...(byEvent.get(a.eventId) ?? []), attachmentDto(a)]);
  }
  const events: TicketEventDto[] = t.events.map((e) => ({
    id: e.id,
    kind: e.kind,
    actor: person(e.actor),
    body: e.body,
    fromStatus: e.fromStatus,
    toStatus: e.toStatus,
    via: e.via,
    meta: (e.meta as Record<string, unknown> | null) ?? null,
    attachments: byEvent.get(e.id) ?? [],
    createdAt: e.createdAt.toISOString(),
  }));
  const isRequester = t.requesterId === actor.id;
  const closedRecently = t.status === 'CLOSED' && t.closedAt
    && Date.now() - t.closedAt.getTime() <= TICKET_REOPEN_WINDOW_DAYS * 86_400_000 && t.closeReason !== 'DUPLICATE';
  const replies = await lastReplies([t]);
  return {
    ...summaryDto(t, replies.get(t.id) ?? null),
    description: t.description,
    createdBy: person(t.createdBy)!,
    duplicateOf: t.duplicateOf,
    resolvedAt: t.resolvedAt?.toISOString() ?? null,
    closedAt: t.closedAt?.toISOString() ?? null,
    attachments: t.attachments.map(attachmentDto),
    events,
    can: {
      manage: actor.isAdmin,
      comment: actor.isAdmin || (isRequester && t.status !== 'CLOSED'),
      withdraw: isRequester && t.status !== 'CLOSED',
      confirm: isRequester && t.status === 'RESOLVED',
      reopen: actor.isAdmin ? t.status === 'RESOLVED' || t.status === 'CLOSED' : isRequester && (t.status === 'RESOLVED' || Boolean(closedRecently)),
    },
  };
}

ticketsRouter.get('/attachments/:id', handle(async (req, res) => {
  const actor = await actorOf(req);
  const a = await prisma.ticketAttachment.findUnique({
    where: { id: req.params.id! },
    select: { data: true, mimeType: true, fileName: true, uploaderId: true, ticket: { select: { workspaceId: true, requesterId: true } } },
  });
  const allowed = a && (a.ticket
    ? a.ticket.workspaceId === actor.workspaceId && (actor.isAdmin || a.ticket.requesterId === actor.id)
    : a.uploaderId === actor.id);
  if (!a || !allowed) return res.status(404).json({ error: 'not_found' });
  const image = a.mimeType.startsWith('image/');
  res.setHeader('Content-Type', a.mimeType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  res.setHeader(
    'Content-Disposition',
    `${image ? 'inline' : 'attachment'}; filename="${a.fileName.replace(/["\\\r\n]/gu, '_')}"`,
  );
  res.send(Buffer.from(a.data));
}));

ticketsRouter.get('/:id', handle(async (req, res) => {
  const actor = await actorOf(req);
  res.json(await detailDto(req.params.id!, actor));
}));

ticketsRouter.post('/:id/comments', handle(async (req, res) => {
  const actor = await actorOf(req);
  await loadVisible(req.params.id!, actor);
  const parsed = TicketCommentRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', detail: parsed.error.issues[0]?.message });
  await addTicketComment({
    ticketId: req.params.id!,
    actor,
    body: parsed.data.body,
    internal: parsed.data.internal,
    askUser: parsed.data.askUser,
    attachmentIds: parsed.data.attachmentIds,
    via: 'DASHBOARD',
  });
  res.json(await detailDto(req.params.id!, actor));
}));

ticketsRouter.post('/:id/actions', handle(async (req, res) => {
  const actor = await actorOf(req);
  await loadVisible(req.params.id!, actor);
  const parsed = TicketActionRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', detail: parsed.error.issues[0]?.message });
  await applyTicketAction({ ticketId: req.params.id!, actor, action: parsed.data, via: 'DASHBOARD' });
  res.json(await detailDto(req.params.id!, actor));
}));

/**
 * Upload one file (multipart, field `file`) before it is attached. The bytes
 * are checked against what they claim to be, so an HTML page cannot be
 * uploaded as an "image".
 */
ticketsRouter.post('/attachments', handle(async (req, res) => {
  const actor = await actorOf(req);
  const recent = await prisma.ticketAttachment.count({
    where: { uploaderId: actor.id, createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } },
  });
  if (recent >= 60) return res.status(429).json({ error: 'rate_limited' });
  let raw: Buffer;
  try {
    raw = await readBody(req, TICKET_ATTACHMENT_MAX_BYTES + 64 * 1024);
  } catch {
    return res.status(413).json({ error: 'attachment_too_large' });
  }
  const file = parseMultipartFile(raw, String(req.headers['content-type'] ?? ''));
  if (!file || file.data.byteLength === 0) return res.status(400).json({ error: 'missing_file' });
  if (file.data.byteLength > TICKET_ATTACHMENT_MAX_BYTES) return res.status(413).json({ error: 'attachment_too_large' });
  const mimeType = sniffMime(file.data, file.contentType);
  if (!mimeType) return res.status(415).json({ error: 'attachment_type_not_allowed' });
  const row = await prisma.ticketAttachment.create({
    data: {
      uploaderId: actor.id,
      fileName: (file.fileName || 'attachment').slice(0, 200),
      mimeType,
      sizeBytes: file.data.byteLength,
      data: file.data,
    },
    select: { id: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true },
  });
  res.status(201).json(attachmentDto(row));
}));

function readBody(req: Request, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maxBytes) {
        reject(new Error('too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function parseMultipartFile(body: Buffer, contentType: string): { data: Buffer; fileName: string | null; contentType: string | null } | null {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/iu.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) return null;
  const marker = Buffer.from(`--${boundary}`);
  let pos = body.indexOf(marker);
  while (pos !== -1) {
    pos += marker.byteLength;
    if (body.subarray(pos, pos + 2).toString() === '--') return null;
    if (body.subarray(pos, pos + 2).toString() === '\r\n') pos += 2;
    const headersEnd = body.indexOf(Buffer.from('\r\n\r\n'), pos);
    if (headersEnd === -1) return null;
    const headers = body.subarray(pos, headersEnd).toString('utf8');
    const contentStart = headersEnd + 4;
    const next = body.indexOf(Buffer.from(`\r\n--${boundary}`), contentStart);
    if (next === -1) return null;
    if (/content-disposition:[^\r\n]*\bname="file"/iu.test(headers)) {
      const fileName = /filename="([^"]*)"/iu.exec(headers)?.[1] ?? null;
      const type = /content-type:\s*([^\r\n;]+)/iu.exec(headers)?.[1]?.trim().toLowerCase() ?? null;
      return { data: body.subarray(contentStart, next), fileName, contentType: type };
    }
    pos = body.indexOf(marker, next + 2);
  }
  return null;
}

/** The real type of the bytes, if it is one we accept. Text must be valid UTF-8 without NULs. */
export function sniffMime(data: Buffer, claimed: string | null): string | null {
  const head = data.subarray(0, 12);
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (head.subarray(0, 6).toString('latin1') === 'GIF87a' || head.subarray(0, 6).toString('latin1') === 'GIF89a') return 'image/gif';
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (claimed === 'text/plain' || claimed === null || claimed === 'application/octet-stream') {
    if (data.includes(0)) return null;
    const text = data.toString('utf8');
    if (text.includes('�')) return null;
    return (TICKET_ATTACHMENT_MIME_TYPES as readonly string[]).includes('text/plain') ? 'text/plain' : null;
  }
  return null;
}
