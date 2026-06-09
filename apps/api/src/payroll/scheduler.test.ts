import { describe, expect, it } from 'vitest';
import { prisma } from '@grind/db';
import { runPayrollMonthCloseOnce } from './scheduler';
import type { LarkMessenger, SendCardResult } from '../lark';

let counter = 0;

class FakeMessenger implements LarkMessenger {
  texts: Array<{ openId: string; text: string }> = [];
  cards: Array<{ openId: string; card: Record<string, unknown> }> = [];
  async sendText(openId: string, text: string): Promise<SendCardResult> {
    this.texts.push({ openId, text });
    return { messageId: `msg-${this.texts.length}` };
  }
  async sendCard(openId: string, card: Record<string, unknown>): Promise<SendCardResult> {
    this.cards.push({ openId, card });
    return { messageId: `card-${this.cards.length}` };
  }
  async updateCard(): Promise<void> {}
}

async function seedPendingApprovalMonthClose() {
  counter += 1;
  const stamp = `${Date.now()}-${counter}-payroll-close`;
  const workspace = await prisma.workspace.create({ data: { name: `Payroll close ${stamp}` } });
  const admin = await prisma.user.create({
    data: {
      workspaceId: workspace.id,
      email: `admin-${stamp}@test.local`,
      name: 'Admin',
      role: 'ADMIN',
      passwordHash: 'x'.repeat(60),
      larkIdentity: { create: { openId: `admin-open-${stamp}` } },
    },
    include: { larkIdentity: true },
  });
  const member = await prisma.user.create({
    data: {
      workspaceId: workspace.id,
      email: `member-${stamp}@test.local`,
      name: 'Member',
      role: 'MEMBER',
      passwordHash: 'x'.repeat(60),
      larkIdentity: { create: { openId: `member-open-${stamp}` } },
    },
    include: { larkIdentity: true },
  });
  await prisma.manualTimeRequest.create({
    data: {
      clientUuid: `request-${stamp}`,
      userId: member.id,
      approverId: admin.id,
      requestedStart: new Date('2026-05-14T09:00:00.000Z'),
      requestedEnd: new Date('2026-05-14T11:00:00.000Z'),
      reason: 'Payroll pending approval',
      status: 'PENDING',
    },
  });
  return { workspace, admin, member };
}

describe('payroll month-close scheduler', () => {
  it('sends approval reminders once per scheduled workspace/month run', async () => {
    const { workspace, admin, member } = await seedPendingApprovalMonthClose();
    const messenger = new FakeMessenger();
    const now = new Date('2026-06-03T00:01:00.000Z');

    const first = await runPayrollMonthCloseOnce(now, messenger);
    const second = await runPayrollMonthCloseOnce(now, messenger);

    const runs = await prisma.payrollRunLog.findMany({
      where: { workspaceId: workspace.id, month: '2026-05', runType: 'APPROVAL_REMINDER' },
    });
    expect(first.runsCreated).toBeGreaterThanOrEqual(1);
    expect(second.runsSkippedDuplicate).toBeGreaterThanOrEqual(1);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('SENT');
    const scopedMessages = messenger.cards.filter((m) =>
      [admin.larkIdentity?.openId, member.larkIdentity?.openId].includes(m.openId),
    );
    expect(scopedMessages).toHaveLength(2);
    expect(JSON.stringify(scopedMessages[0]?.card)).toContain('Payroll approvals');
  });
});
