import { Users } from 'lucide-react';
import type { WorkspaceUser } from './AttendeePicker';

/**
 * Read-only attendee summary — used on rows where the picker isn't
 * rendered (e.g. someone else's day, or a MANUAL row where attendees
 * came along for the ride). Shows up to N names + a "+K more" pill;
 * gracefully degrades to just a count when no directory is loaded.
 */
export interface Props {
  users: WorkspaceUser[];
  attendeeIds: string[];
  /** Hide the leading users icon — useful when the row already has a leading badge. */
  noIcon?: boolean;
  /** Max names to render in full before collapsing to a count. */
  max?: number;
}

export default function AttendeeChips({ users, attendeeIds, noIcon, max = 3 }: Props) {
  if (!attendeeIds || attendeeIds.length === 0) return null;
  const byId = new Map(users.map((u) => [u.id, u]));
  const resolved = attendeeIds.map((id) => byId.get(id)).filter((u): u is WorkspaceUser => !!u);
  const total = attendeeIds.length;
  const showCount = resolved.length === 0; // directory not loaded (yet) — show count
  const visible = resolved.slice(0, max);
  const more = total - visible.length;
  const title = resolved.length > 0
    ? resolved.map((u) => u.name).join(', ')
    : `${total} attendee${total === 1 ? '' : 's'}`;
  return (
    <span className="attendee-chips" title={title} aria-label={`${total} attendee${total === 1 ? '' : 's'}`}>
      {!noIcon && <Users size={11} strokeWidth={2.2} aria-hidden />}
      {showCount ? (
        <span className="attendee-chip">{total} attendee{total === 1 ? '' : 's'}</span>
      ) : (
        <>
          {visible.map((u) => (
            <span key={u.id} className="attendee-chip">
              {firstName(u.name)}
            </span>
          ))}
          {more > 0 && <span className="attendee-chip attendee-chip-more">+{more}</span>}
        </>
      )}
    </span>
  );
}

function firstName(name: string): string {
  const t = name.trim();
  if (t.length === 0) return '?';
  const space = t.indexOf(' ');
  return space === -1 ? t : t.slice(0, space);
}
