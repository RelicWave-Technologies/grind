import { identityTint } from '../lib/identityTint';
import type { LarkTaskItem } from '../lib/taskFormat';

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1]![0] : '';
  return (first + (last ?? '')).toUpperCase();
}

/**
 * Who a task came from: the creator's initials on their own tint, so a person
 * reads the same in every list. A task with no known creator shows its own
 * first letter on neutral grey.
 */
export default function TaskOwner({ task, size = 32 }: { task: Pick<LarkTaskItem, 'summary' | 'creatorId' | 'creatorName'>; size?: number }) {
  const who = task.creatorName?.trim();
  const label = who ? initialsOf(who) : (task.summary.trim()[0] ?? '·').toUpperCase();
  const background = who ? identityTint(task.creatorId ?? who) : 'var(--color-sheet)';
  return (
    <span
      className="task-owner"
      style={{ width: size, height: size, background, fontSize: Math.round(size * (label.length > 1 ? 0.36 : 0.42)) }}
      title={who ? `From ${who}` : undefined}
      aria-hidden="true"
    >
      {label}
    </span>
  );
}
