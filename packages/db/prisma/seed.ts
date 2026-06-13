import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

const MAY_PAYROLL_SCHEDULE = {
  sun: null,
  mon: { start: '09:00', end: '18:00' },
  tue: { start: '09:00', end: '18:00' },
  wed: { start: '09:00', end: '18:00' },
  thu: { start: '09:00', end: '18:00' },
  fri: { start: '09:00', end: '18:00' },
  sat: null,
};

const atIst = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`);
const plusMin = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);

async function main() {
  const passwordHash = await argon2.hash('grindgrind', { type: argon2.argon2id });

  const ws = await prisma.workspace.upsert({
    where: { id: 'ws_dogfood' },
    update: {},
    create: { id: 'ws_dogfood', name: 'EmiAC Dogfood' },
  });

  const admin = await prisma.user.upsert({
    where: { email: 'abhishek@emiactech.com' },
    update: { passwordHash, role: 'ADMIN', workspaceId: ws.id, provisioningStatus: 'ACTIVE' },
    create: {
      workspaceId: ws.id,
      email: 'abhishek@emiactech.com',
      name: 'Anish Suman',
      role: 'ADMIN',
      passwordHash,
      provisioningStatus: 'ACTIVE',
    },
  });

  const manager = await prisma.user.upsert({
    where: { email: 'seed-manager@grind.local' },
    update: { passwordHash, role: 'MANAGER', workspaceId: ws.id, name: 'Seed Manager', provisioningStatus: 'ACTIVE' },
    create: {
      workspaceId: ws.id,
      email: 'seed-manager@grind.local',
      name: 'Seed Manager',
      role: 'MANAGER',
      passwordHash,
      provisioningStatus: 'ACTIVE',
    },
  });

  const payrollTeam = await prisma.team.upsert({
    where: { id: 'team_payroll_may_cases' },
    update: { workspaceId: ws.id, name: 'Payroll May Cases', managerId: manager.id },
    create: {
      id: 'team_payroll_may_cases',
      workspaceId: ws.id,
      name: 'Payroll May Cases',
      managerId: manager.id,
    },
  });

  await prisma.user.update({
    where: { id: manager.id },
    data: { teamId: payrollTeam.id, managerId: manager.id },
  });

  const mayShift = await prisma.shift.upsert({
    where: { id: 'shift_payroll_may_general' },
    update: {
      workspaceId: ws.id,
      name: 'May Payroll General',
      schedule: MAY_PAYROLL_SCHEDULE,
      bufferMin: 30,
    },
    create: {
      id: 'shift_payroll_may_general',
      workspaceId: ws.id,
      name: 'May Payroll General',
      schedule: MAY_PAYROLL_SCHEDULE,
      bufferMin: 30,
    },
  });

  await prisma.payrollPolicy.upsert({
    where: { workspaceId: ws.id },
    update: {},
    create: {
      workspaceId: ws.id,
      halfDayLowerMin: 240,
      halfDayUpperMin: 480,
      fullDayLowerMin: 480,
      fullDayUpperMin: 600,
      monthlyLowerMin: 9_600,
      timezone: 'Asia/Calcutta',
      approvalReminderDays: [3, 4],
      approvalReminderTime: '00:00',
      payrollSheetSendDay: 5,
      payrollSheetSendTime: '00:00',
      sendPayrollSheetTo: 'ALL_ADMINS',
    },
  });

  const payrollUser = await prisma.user.upsert({
    where: { email: 'payroll-may-cases@grind.local' },
    update: {
      workspaceId: ws.id,
      name: 'Payroll May Cases',
      role: 'MEMBER',
      passwordHash,
      provisioningStatus: 'ACTIVE',
      teamId: payrollTeam.id,
      managerId: manager.id,
      shiftId: null,
      shiftAssignedAt: null,
      deactivatedAt: null,
    },
    create: {
      workspaceId: ws.id,
      email: 'payroll-may-cases@grind.local',
      name: 'Payroll May Cases',
      role: 'MEMBER',
      passwordHash,
      provisioningStatus: 'ACTIVE',
      teamId: payrollTeam.id,
      managerId: manager.id,
      shiftId: null,
      shiftAssignedAt: null,
    },
  });

  // Keep this fixture deterministic. Rerunning the seed resets only the demo
  // member's May payroll evidence, leaving the rest of the workspace intact.
  await prisma.manualTimeRequest.deleteMany({ where: { userId: payrollUser.id } });
  await prisma.timeEntry.deleteMany({ where: { userId: payrollUser.id } });
  await prisma.shiftAssignment.deleteMany({ where: { userId: payrollUser.id } });

  await prisma.shiftAssignment.create({
    data: {
      userId: payrollUser.id,
      shiftId: mayShift.id,
      effectiveFrom: atIst('2026-05-04', '00:00'),
      effectiveTo: atIst('2026-05-18', '00:00'),
      shiftNameSnapshot: mayShift.name,
      scheduleSnapshot: MAY_PAYROLL_SCHEDULE,
      bufferMinSnapshot: mayShift.bufferMin,
    },
  });

  async function createEntry(args: {
    key: string;
    date: string;
    start: string;
    minutes: number;
    source?: 'AUTO' | 'MANUAL';
    kind?: 'WORK' | 'MEETING' | 'IDLE_TRIMMED';
    shiftIdAtStart?: string | null;
    notes?: string;
  }) {
    const startedAt = atIst(args.date, args.start);
    const endedAt = plusMin(startedAt, args.minutes);
    return prisma.timeEntry.create({
      data: {
        id: `seed_${args.key}`,
        clientUuid: `seed_${args.key}_client`,
        userId: payrollUser.id,
        source: args.source ?? 'AUTO',
        startedAt,
        endedAt,
        notes: args.notes,
        shiftIdAtStart: args.shiftIdAtStart ?? mayShift.id,
        agentVersion: 'seed',
        platform: 'seed',
        segments: {
          create: [
            {
              id: `seed_${args.key}_seg`,
              kind: args.kind ?? 'WORK',
              startedAt,
              endedAt,
            },
          ],
        },
      },
    });
  }

  await createEntry({ key: 'payroll_may_04_direct_full_surplus', date: '2026-05-04', start: '09:00', minutes: 540, notes: 'Direct full day with 1h carry credit' });
  await createEntry({ key: 'payroll_may_05_below_half_credit', date: '2026-05-05', start: '09:00', minutes: 180, notes: 'Below half-day; hours become carry credit' });
  await createEntry({ key: 'payroll_may_06_overflow', date: '2026-05-06', start: '09:00', minutes: 720, notes: '12h raw; 10h capped; 2h overflow ignored' });
  await createEntry({ key: 'payroll_may_07_half_upgraded', date: '2026-05-07', start: '09:00', minutes: 240, notes: 'Half day upgraded to full by carry' });
  await createEntry({ key: 'payroll_may_08_meeting_half_upgraded', date: '2026-05-08', start: '09:00', minutes: 240, kind: 'MEETING', notes: 'Meeting time counts toward payroll and is carry-upgraded' });

  const idleStart = atIst('2026-05-11', '09:00');
  await prisma.timeEntry.create({
    data: {
      id: 'seed_payroll_may_11_idle_trimmed',
      clientUuid: 'seed_payroll_may_11_idle_trimmed_client',
      userId: payrollUser.id,
      source: 'AUTO',
      startedAt: idleStart,
      endedAt: plusMin(idleStart, 360),
      notes: 'Only the first 2h count; idle-trimmed time is excluded',
      shiftIdAtStart: mayShift.id,
      agentVersion: 'seed',
      platform: 'seed',
      segments: {
        create: [
          { id: 'seed_payroll_may_11_work_seg', kind: 'WORK', startedAt: idleStart, endedAt: plusMin(idleStart, 120) },
          { id: 'seed_payroll_may_11_idle_seg', kind: 'IDLE_TRIMMED', startedAt: plusMin(idleStart, 120), endedAt: plusMin(idleStart, 360) },
        ],
      },
    },
  });

  const manualApproved = await createEntry({
    key: 'payroll_may_12_approved_manual',
    date: '2026-05-12',
    start: '09:00',
    minutes: 240,
    source: 'MANUAL',
    notes: 'Approved manual request counts toward payroll',
  });
  await prisma.manualTimeRequest.create({
    data: {
      clientUuid: 'seed_payroll_may_12_mtr_approved',
      userId: payrollUser.id,
      approverId: manager.id,
      taskSummary: 'Approved payroll fixture',
      requestedStart: atIst('2026-05-12', '09:00'),
      requestedEnd: atIst('2026-05-12', '13:00'),
      reason: 'Approved May payroll fixture',
      status: 'APPROVED',
      decidedAt: atIst('2026-05-12', '13:15'),
      timeEntryId: manualApproved.id,
    },
  });

  await createEntry({ key: 'payroll_may_13_direct_half', date: '2026-05-13', start: '09:00', minutes: 240, notes: 'Direct half day remains half' });
  await prisma.manualTimeRequest.createMany({
    data: [
      {
        clientUuid: 'seed_payroll_may_14_mtr_pending',
        userId: payrollUser.id,
        approverId: manager.id,
        taskSummary: 'Pending payroll fixture',
        requestedStart: atIst('2026-05-14', '09:00'),
        requestedEnd: atIst('2026-05-14', '17:00'),
        reason: 'Pending request should not count in payroll',
        status: 'PENDING',
      },
      {
        clientUuid: 'seed_payroll_may_15_mtr_rejected',
        userId: payrollUser.id,
        approverId: manager.id,
        taskSummary: 'Rejected payroll fixture',
        requestedStart: atIst('2026-05-15', '09:00'),
        requestedEnd: atIst('2026-05-15', '17:00'),
        reason: 'Rejected request should not count in payroll',
        status: 'REJECTED',
        decidedAt: atIst('2026-05-15', '17:15'),
        decidedReason: 'Seeded rejection',
      },
    ],
  });

  await createEntry({
    key: 'payroll_may_16_scheduled_off_raw',
    date: '2026-05-16',
    start: '09:00',
    minutes: 300,
    notes: 'Scheduled-off day with raw time; shown but not payable',
  });
  await createEntry({
    key: 'payroll_may_20_no_shift_raw',
    date: '2026-05-20',
    start: '09:00',
    minutes: 360,
    shiftIdAtStart: null,
    notes: 'No-shift day with raw time; shown but not payable',
  });

  console.log(`Seeded: workspace=${ws.id} admin=${admin.email}`);
  console.log('Seeded payroll May demo: payroll-may-cases@grind.local / grindgrind');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
