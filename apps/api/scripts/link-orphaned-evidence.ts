import { parseArgs } from 'node:util';
import { prisma } from '@grind/db';
import { backfillEvidenceLinks } from '../src/timeEntries/evidenceBackfill';

/**
 * Link screenshots and activity minutes stored without their time entry (see
 * src/timeEntries/evidenceBackfill.ts). Dry run by default; `--apply` writes.
 *
 *   pnpm --filter @grind/api link:orphaned-evidence [--user <id>] [--since 2026-10-09] [--apply]
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      user: { type: 'string' },
      since: { type: 'string' },
    },
    strict: true,
  });
  const since = values.since ? new Date(values.since) : undefined;
  if (since && Number.isNaN(since.getTime())) throw new Error('invalid_since');

  const report = await backfillEvidenceLinks({ apply: values.apply ?? false, userId: values.user, since });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
