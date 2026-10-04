/** Day insight, manual-time requests (self side) and time-entry edits. */
import { hasPermission } from '@grind/types';
import { isValidDateKey, MIN, todayKey } from '../clock';
import { persist, type DbRequest } from '../db';
import { approverFor, dayInsight, requestDto, taskSummaryOf } from '../derive';
import { bodyObject, del, fail, get, patch, post, str, withStatus, type Ctx } from '../http';
import { newId } from '../rng';
import { parseIsoMs, range, requireUser, targetUser } from './common';

function attendeeList(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return fail(400, 'invalid_attendees');
  return v.filter((x): x is string => typeof x === 'string').slice(0, 50);
}

function findRequest(ctx: Ctx, id: string | undefined): DbRequest {
  const r = ctx.db.requests.find((x) => x.id === id);
  if (!r) return fail(404, 'not_found');
  return r;
}

/** Can the caller edit this person's time? Self always; others with team scope. */
function canEditFor(ctx: Ctx, userId: string): boolean {
  if (userId === ctx.me.id) return true;
  return hasPermission(ctx.me.role, 'time.team.edit');
}

export function registerTime(): void {
  get('/v1/insights/day', (req, ctx) => {
    const date = req.query.get('date') ?? todayKey();
    if (!isValidDateKey(date)) fail(400, 'invalid_date_or_tz');
    const scope = req.query.get('gapScope');
    if (scope !== null && scope !== 'shift' && scope !== 'calendar-day') fail(400, 'invalid_gap_scope');
    const user = targetUser(ctx, req.query.get('userId'));
    return dayInsight(ctx, user, date, scope === 'calendar-day' ? 'calendar-day' : 'shift');
  });

  get('/v1/time-requests', (req, ctx) => {
    const role = req.query.get('role') ?? 'mine';
    const status = req.query.get('status');
    const hasRange = req.query.has('from') || req.query.has('to') || req.query.has('tz');
    const r = hasRange ? range(req, 62) : null;
    const rows = ctx.empty
      ? []
      : ctx.db.requests
          .filter((x) => (role === 'approvals' ? x.approverId === ctx.me.id : x.userId === ctx.me.id))
          .filter((x) => !status || x.status === status)
          .filter((x) => !r || (x.start < r.end && x.end > r.start))
          .sort((a, b) => (r ? b.start - a.start : b.createdAt - a.createdAt))
          .slice(0, 200);
    return { requests: rows.map((x) => requestDto(ctx, x)), ...(r ? { from: r.from, to: r.to, tz: r.tz } : {}) };
  });

  post('/v1/time-requests', (req, ctx) => {
    const b = bodyObject(req);
    const start = parseIsoMs(b.requestedStart, 'range');
    const end = parseIsoMs(b.requestedEnd, 'range');
    if (!(start < end)) fail(400, 'invalid_range');
    if (end > ctx.now + MIN) fail(400, 'future_time');
    const reason = str(b.reason)?.trim();
    if (!reason) fail(400, 'reason_required');
    const target = targetUser(ctx, str(b.userId));
    if (!canEditFor(ctx, target.id)) fail(403, 'forbidden');
    const guid = str(b.larkTaskGuid) ?? null;
    const isSelf = target.id === ctx.me.id;
    const autoApprove = !isSelf || ctx.me.role !== 'MEMBER';
    const approver = autoApprove ? ctx.me : approverFor(ctx, target);
    if (!approver) fail(400, 'no_approver');
    const id = newId('mtr');
    const row: DbRequest = {
      id,
      clientUuid: str(b.clientUuid) ?? id,
      userId: target.id,
      approverId: approver?.id ?? null,
      larkTaskGuid: guid,
      taskSummary: str(b.taskSummary) ?? taskSummaryOf(guid),
      start,
      end,
      reason: reason!,
      status: autoApprove ? 'APPROVED' : 'PENDING',
      autoApproved: autoApprove,
      decidedAt: autoApprove ? ctx.now : null,
      decidedReason: autoApprove ? `Added by ${ctx.me.name}` : null,
      createdAt: ctx.now,
      attendeeIds: attendeeList(b.attendeeIds) ?? [],
      timeEntryId: null,
      triage: autoApprove
        ? null
        : {
            verdict: 'review',
            confidence: 0.6,
            signals: [{ id: 'fresh', text: 'Submitted a moment ago from the dashboard', weight: 0.1 }],
            headline: 'New request — no history to compare against yet.',
          },
    };
    if (autoApprove) {
      const entryId = newId('te_manual');
      row.timeEntryId = entryId;
      ctx.db.manualEntries.push({ id: entryId, userId: target.id, requestId: id, start, end, larkTaskGuid: guid, notes: null, attendeeIds: row.attendeeIds });
    }
    ctx.db.requests.push(row);
    persist();
    return withStatus(201, requestDto(ctx, row));
  });

  patch('/v1/time-requests/:id', (req, ctx) => {
    const r = findRequest(ctx, req.params.id);
    if (!canEditFor(ctx, r.userId)) fail(403, 'forbidden');
    if (r.status !== 'PENDING') fail(409, 'immutable_after_decision', { status: r.status });
    const b = bodyObject(req);
    const start = b.requestedStart !== undefined ? parseIsoMs(b.requestedStart, 'range') : r.start;
    const end = b.requestedEnd !== undefined ? parseIsoMs(b.requestedEnd, 'range') : r.end;
    if (!(start < end)) fail(400, 'invalid_range');
    r.start = start;
    r.end = end;
    if (b.larkTaskGuid !== undefined) {
      r.larkTaskGuid = str(b.larkTaskGuid) ?? null;
      r.taskSummary = str(b.taskSummary) ?? taskSummaryOf(r.larkTaskGuid);
    }
    if (typeof b.reason === 'string' && b.reason.trim()) r.reason = b.reason.trim();
    const attendees = attendeeList(b.attendeeIds);
    if (attendees) r.attendeeIds = attendees;
    persist();
    return requestDto(ctx, r);
  });

  post('/v1/time-requests/:id/cancel', (req, ctx) => {
    const r = findRequest(ctx, req.params.id);
    if (!canEditFor(ctx, r.userId)) fail(403, 'forbidden');
    if (r.status !== 'PENDING') fail(409, 'immutable_after_decision', { status: r.status });
    r.status = 'CANCELLED';
    r.decidedAt = ctx.now;
    persist();
    return requestDto(ctx, r);
  });

  patch('/v1/time-entries/:id', (req, ctx) => {
    const id = req.params.id!;
    const b = bodyObject(req);
    const manual = ctx.db.manualEntries.find((m) => m.id === id);
    const ownerId = manual?.userId ?? ctx.db.users.find((u) => id.startsWith(`te_${u.id.slice(4)}_`))?.id;
    if (!ownerId) fail(404, 'not_found');
    requireUser(ctx, ownerId);
    if (!canEditFor(ctx, ownerId!)) fail(403, 'forbidden');
    const guid = b.larkTaskGuid === undefined ? undefined : str(b.larkTaskGuid) ?? null;
    const notes = b.notes === undefined ? undefined : str(b.notes) ?? null;
    const attendees = attendeeList(b.attendeeIds);
    if (manual) {
      if (guid !== undefined) manual.larkTaskGuid = guid;
      if (notes !== undefined) manual.notes = notes;
      if (attendees) manual.attendeeIds = attendees;
    } else {
      const cur = ctx.db.entryPatches[id] ?? {};
      ctx.db.entryPatches[id] = {
        ...cur,
        ...(guid !== undefined ? { larkTaskGuid: guid } : {}),
        ...(notes !== undefined ? { notes } : {}),
        ...(attendees ? { attendeeIds: attendees } : {}),
      };
    }
    persist();
    return { id, larkTaskGuid: guid ?? null, notes: notes ?? null, attendeeIds: attendees ?? [] };
  });

  del('/v1/time-entries/:id', (req, ctx) => {
    const id = req.params.id!;
    const manual = ctx.db.manualEntries.find((m) => m.id === id);
    if (!manual) {
      const owner = ctx.db.users.find((u) => id.startsWith(`te_${u.id.slice(4)}_`));
      if (!owner) fail(404, 'not_found');
      // Tracked time is the agent's record; the dashboard only removes manual rows.
      fail(409, 'only_manual_entries_can_be_deleted');
    }
    if (!canEditFor(ctx, manual!.userId)) fail(403, 'forbidden');
    ctx.db.manualEntries = ctx.db.manualEntries.filter((m) => m.id !== id);
    persist();
    return { ok: true };
  });
}
