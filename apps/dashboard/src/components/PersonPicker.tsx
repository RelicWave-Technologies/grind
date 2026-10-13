import { Combobox } from '../ui';
import { roleLabel } from '../lib/auth';

/** Who a picker can list. `teamName` is searchable when the list carries it. */
export interface PickablePerson {
  id: string;
  name: string;
  email: string;
  role: string;
  teamName?: string | null;
}

interface PersonPickerProps<U extends PickablePerson> {
  /** The people to choose from — already scoped by the API that returned them. */
  users: ReadonlyArray<U>;
  value: string;
  onChange: (userId: string) => void;
  placeholder: string;
  'aria-label'?: string;
  /** A '' choice pinned first (e.g. "No manager yet"). */
  emptyLabel?: string;
  /** The option's text; defaults to "Name · Role". */
  label?: (user: U) => string;
  /** Appended after the label, e.g. their current team. */
  detail?: (user: U) => string;
  /** The list is still on its way: say so instead of "No people available". */
  loading?: boolean;
  block?: boolean;
  className?: string;
}

/**
 * Pick one person: the kit Combobox over a people list, searchable by name,
 * email and team. Every "choose a person" control (team and shift members,
 * managers, Edit Time's viewer, the resync target) is this one, so a 90-person
 * workspace is never a scroll through a native list.
 */
export function PersonPicker<U extends PickablePerson>({
  users,
  value,
  onChange,
  placeholder,
  'aria-label': ariaLabel = 'Person',
  emptyLabel,
  label = (user) => `${user.name} · ${roleLabel(user.role)}`,
  detail,
  loading,
  block = true,
  className,
}: PersonPickerProps<U>) {
  const options = users.map((user) => ({
    value: user.id,
    label: detail ? `${label(user)} · ${detail(user)}` : label(user),
    keywords: [user.email, user.teamName],
  }));
  return (
    <Combobox
      aria-label={ariaLabel}
      block={block}
      className={className}
      searchable
      searchPlaceholder="Search name, email or team"
      placeholder={loading ? 'Loading…' : users.length === 0 ? 'No people available' : placeholder}
      disabled={loading || users.length === 0}
      emptyLabel={emptyLabel}
      value={value}
      options={options}
      onChange={onChange}
    />
  );
}
