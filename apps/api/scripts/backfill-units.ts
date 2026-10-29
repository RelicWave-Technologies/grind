import { parseArgs } from 'node:util';
import { prisma } from '@grind/db';
import { backfillUnitsByEmail } from '../src/admin/unitBackfill';

/**
 * Give people without a unit the one their email domain names
 * (@emiactech.com → EMIAC, @macobstech.com → MACOBS). See
 * src/admin/unitBackfill.ts. Dry run by default; `--apply` writes.
 *
 *   pnpm --filter @grind/api backfill:units --workspace <id> [--apply]
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      workspace: { type: 'string' },
    },
    strict: true,
  });
  if (!values.workspace) throw new Error('missing --workspace');
  const report = await backfillUnitsByEmail({ workspaceId: values.workspace, apply: values.apply ?? false });
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
