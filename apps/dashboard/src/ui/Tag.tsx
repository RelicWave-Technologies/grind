import type { ReactNode } from 'react';
import { cx } from './util';
import type { Status } from './util';

/* §5.10 Tag — status & labels; the visual face of the §2 taxonomy.
   `dot` = low-emphasis variant (6px solid dot + plain text) for dense tables /
   legends. `mono` for counts/IDs. Squared-soft, never a pill. */
export interface TagProps extends React.HTMLAttributes<HTMLSpanElement> {
  status?: Status;
  dot?: boolean;
  mono?: boolean;
  children: ReactNode;
}

export function Tag({ status = 'neutral', dot, mono, className, children, ...rest }: TagProps) {
  return (
    <span
      className={cx(
        'ui-tag',
        `ui-tag--${status}`,
        dot && 'ui-tag--dot',
        mono && 'ui-tag--mono',
        className,
      )}
      {...rest}
    >
      {dot && <span className="ui-tag__dot" aria-hidden />}
      {children}
    </span>
  );
}

/** Alias — the spec names this pattern "Tag/Badge". */
export const Badge = Tag;
