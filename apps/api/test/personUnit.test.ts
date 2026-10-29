import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';
import { backfillUnitsByEmail, unitNameForEmail } from '../src/admin/unitBackfill';

/**
 * A person's unit (employer): admins set it on People, and the month reports
 * narrow to one unit for a per-company download — inside the caller's scope,
 * never beyond it.
 */

const app = buildApp();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

let counter = 0;
async function seed() {
  counter += 1;
  const stamp = `${Date.now()}-${counter}-unit`;
  const ws = await prisma.workspace.create({ data: { name: `WS ${stamp}`, timezone: 'Asia/Kolkata' } });
  // Workspaces made after the migration get no units from it; tests make their own.
  const emiac = await prisma.unit.create({ data: { workspaceId: ws.id, name: 'EMIAC' } });
  const macobs = await prisma.unit.create({ data: { workspaceId: ws.id, name: 'MACOBS' } });
  const team = await prisma.team.create({ data: { workspaceId: ws.id, name: 'Media Buying' } });
  const other = await prisma.team.create({ data: { workspaceId: ws.id, name: 'Technical' } });

  const mk = (
    label: string,
    role: 'ADMIN' | 'MANAGER' | 'MEMBER',
    opts: { teamId?: string | null; unitId?: string | null; domain?: string } = {},
  ) =>
    prisma.user.create({
      data: {
        workspaceId: ws.id,
        email: `${label}-${stamp}@${opts.domain ?? 'test.local'}`,
        name: label,
        role,
        teamId: opts.teamId ?? null,
        unitId: opts.unitId ?? null,
        provisioningStatus: 'ACTIVE',
      },
    });

  const admin = await mk('admin', 'ADMIN');
  const manager = await mk('manager', 'MANAGER', { teamId: team.id, unitId: emiac.id });
  const emiacMember = await mk('emiac-member', 'MEMBER', { teamId: team.id, unitId: emiac.id });
  const macobsMember = await mk('macobs-member', 'MEMBER', { teamId: team.id, unitId: macobs.id });
  const macobsElsewhere = await mk('macobs-elsewhere', 'MEMBER', { teamId: other.id, unitId: macobs.id });
  const noUnit = await mk('no-unit', 'MEMBER', { teamId: team.id });
  await prisma.teamManager.create({ data: { workspaceId: ws.id, teamId: team.id, userId: manager.id } });

  const token = (u: { id: string; role: 'ADMIN' | 'MANAGER' | 'MEMBER' }) =>
    signAccessToken({ sub: u.id, ws: ws.id, role: u.role });
  return {
    ws, emiac, macobs, admin, manager, emiacMember, macobsMember, macobsElsewhere, noUnit,
    adminToken: token(admin),
    managerToken: token(manager),
    memberToken: token(emiacMember),
    mk,
  };
}

async function sheetEmails(token: string, query: string): Promise<string[]> {
  const res = await request(app).get(`/v1/reports/month-sheet?month=2026-08${query}`).set(bearer(token));
  expect(res.status).toBe(200);
  return (res.body.rows as Array<{ email: string }>).map((r) => r.email).sort();
}

describe('person unit', () => {
  it('lists the workspace units', async () => {
    const s = await seed();
    const res = await request(app).get('/v1/admin/units').set(bearer(s.memberToken));
    expect(res.status).toBe(200);
    expect(res.body.units.map((u: { name: string }) => u.name)).toEqual(['EMIAC', 'MACOBS']);
  });

  it('lets an admin set and clear a unit, and shows it on People', async () => {
    const s = await seed();
    const set = await request(app)
      .patch(`/v1/admin/users/${s.noUnit.id}`)
      .set(bearer(s.adminToken))
      .send({ unitId: s.macobs.id });
    expect(set.status).toBe(200);
    expect(set.body.unitId).toBe(s.macobs.id);

    const list = await request(app).get('/v1/admin/users').set(bearer(s.adminToken));
    const row = list.body.users.find((u: { id: string }) => u.id === s.noUnit.id);
    expect(row).toMatchObject({ unitId: s.macobs.id, unitName: 'MACOBS' });

    const clear = await request(app)
      .patch(`/v1/admin/users/${s.noUnit.id}`)
      .set(bearer(s.adminToken))
      .send({ unitId: null });
    expect(clear.status).toBe(200);
    expect(clear.body.unitId).toBeNull();
  });

  it('refuses a unit from another workspace, and a non-admin', async () => {
    const s = await seed();
    const t = await seed();
    const foreign = await request(app)
      .patch(`/v1/admin/users/${s.noUnit.id}`)
      .set(bearer(s.adminToken))
      .send({ unitId: t.emiac.id });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error).toBe('unit_out_of_workspace');

    const asManager = await request(app)
      .patch(`/v1/admin/users/${s.noUnit.id}`)
      .set(bearer(s.managerToken))
      .send({ unitId: s.emiac.id });
    expect(asManager.status).toBe(403);
  });

  it('narrows the month sheet to one unit, or to people with none', async () => {
    const s = await seed();
    expect(await sheetEmails(s.adminToken, '&unit=macobs')).toEqual(
      [s.macobsElsewhere.email, s.macobsMember.email].sort(),
    );
    expect(await sheetEmails(s.adminToken, '&unit=EMIAC')).toEqual([s.emiacMember.email, s.manager.email].sort());
    expect(await sheetEmails(s.adminToken, '&unit=none')).toEqual([s.admin.email, s.noUnit.email].sort());

    const res = await request(app).get('/v1/reports/month-sheet?month=2026-08&unit=EMIAC').set(bearer(s.adminToken));
    expect(res.body.companyName).toBe('EMIAC');
    expect(res.body.rows[0].unitName).toBe('EMIAC');
  });

  it('never widens a manager past their team', async () => {
    const s = await seed();
    // MACOBS has someone on another team; the manager must not get them.
    expect(await sheetEmails(s.managerToken, '&unit=MACOBS')).toEqual([s.macobsMember.email]);
  });

  it('rejects an unknown unit', async () => {
    const s = await seed();
    const res = await request(app).get('/v1/reports/month-sheet?month=2026-08&unit=ACME').set(bearer(s.adminToken));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_unit');
  });

  it('downloads one unit as its own file, with the unit as CompName', async () => {
    const s = await seed();
    const res = await request(app)
      .get('/v1/reports/month-performance.csv?month=2026-08&unit=MACOBS')
      .set(bearer(s.adminToken));
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('month-performance-MACOBS-2026-08.csv');
    expect(res.text).toContain(s.macobsMember.email);
    expect(res.text).not.toContain(s.emiacMember.email);
    expect(res.text).toContain('CompName,MACOBS');

    const xlsx = await request(app)
      .get('/v1/reports/month-performance.xlsx?month=2026-08&unit=EMIAC')
      .set(bearer(s.adminToken));
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-disposition']).toContain('month-performance-EMIAC-2026-08.xlsx');
  });

  it('carries the unit on person facets (team summary)', async () => {
    const s = await seed();
    const res = await request(app)
      .get('/v1/reports/team/summary?from=2026-08-01&to=2026-08-07')
      .set(bearer(s.adminToken));
    expect(res.status).toBe(200);
    const users = (res.body.users ?? res.body.members ?? []) as Array<{ id: string; unitName?: string | null; user?: { id: string; unitName: string | null } }>;
    const flat = users.map((u) => u.user ?? u);
    expect(flat.find((u) => u.id === s.macobsMember.id)?.unitName).toBe('MACOBS');
  });
});

describe('unit backfill by email domain', () => {
  it('maps the two company domains', () => {
    expect(unitNameForEmail('a@emiactech.com')).toBe('EMIAC');
    expect(unitNameForEmail('B@MacobsTech.com')).toBe('MACOBS');
    expect(unitNameForEmail('c@gmail.com')).toBeNull();
  });

  it('fills blanks only, and writes nothing on a dry run', async () => {
    const s = await seed();
    const e = await s.mk('fresh-e', 'MEMBER', { domain: 'emiactech.com' });
    const m = await s.mk('fresh-m', 'MEMBER', { domain: 'macobstech.com' });
    // Set by hand to MACOBS despite an EMIAC address: must stay MACOBS.
    const kept = await s.mk('kept', 'MEMBER', { domain: 'emiactech.com', unitId: s.macobs.id });

    const dry = await backfillUnitsByEmail({ workspaceId: s.ws.id, apply: false });
    expect(dry.assigned.EMIAC?.map((p) => p.id)).toEqual([e.id]);
    expect(dry.assigned.MACOBS?.map((p) => p.id)).toEqual([m.id]);
    expect(dry.unmatched.map((p) => p.id).sort()).toEqual([s.admin.id, s.noUnit.id].sort());
    expect((await prisma.user.findUniqueOrThrow({ where: { id: e.id } })).unitId).toBeNull();

    await backfillUnitsByEmail({ workspaceId: s.ws.id, apply: true });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: e.id } })).unitId).toBe(s.emiac.id);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: m.id } })).unitId).toBe(s.macobs.id);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: kept.id } })).unitId).toBe(s.macobs.id);
  });
});
