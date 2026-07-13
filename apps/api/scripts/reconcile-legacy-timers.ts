import { parseArgs } from 'node:util';
import { prisma } from '@grind/db';
import {
  applyLegacyReconciliationPlan,
  buildLegacyReconciliationPlan,
  DEFAULT_LEGACY_STALE_MINUTES,
} from '../src/timeLifecycle/legacyReconciliation';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      'plan-hash': { type: 'string' },
      'stale-minutes': { type: 'string', default: String(DEFAULT_LEGACY_STALE_MINUTES) },
    },
    strict: true,
  });
  const staleMinutes = Number(values['stale-minutes']);

  if (!values.apply) {
    const plan = await buildLegacyReconciliationPlan({ staleMinutes });
    process.stdout.write(`${JSON.stringify({ mode: 'dry-run', ...plan }, null, 2)}\n`);
    return;
  }
  if (!values['plan-hash']) throw new Error('apply_requires_plan_hash_from_dry_run');

  const result = await applyLegacyReconciliationPlan({
    planHash: values['plan-hash'],
    staleMinutes,
  });
  process.stdout.write(`${JSON.stringify({ mode: 'applied', ...result }, null, 2)}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
