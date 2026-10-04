import type { ReactNode } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { cx } from './util';
import { Button } from './Button';

/* §5.13 EmptyState — the one empty/zero-data treatment for every empty
   list/table/page. `tone='danger'` doubles as the page-level error treatment. */
export interface EmptyStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  tone?: 'default' | 'danger';
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  tone = 'default',
  className,
  ...rest
}: EmptyStateProps) {
  return (
    <div className={cx('ui-empty', tone === 'danger' && 'ui-empty--danger', className)} {...rest}>
      {icon != null && <div className="ui-empty__icon">{icon}</div>}
      <h3 className="ui-empty__title ui-t-h3">{title}</h3>
      {description != null && <p className="ui-empty__desc ui-t-small">{description}</p>}
      {action != null && <div className="ui-empty__action">{action}</div>}
    </div>
  );
}

/* App states — Error (DESIGN.md §9): a screen or section that cannot load
   shows its error state where the data would be — the empty state's shape,
   one sentence and Retry. Never a banner. */
export interface LoadErrorProps {
  /** What could not load, as it reads after "Couldn't load": "approvals". */
  what: ReactNode;
  error?: unknown;
  onRetry?: () => void;
  icon?: ReactNode;
  className?: string;
}

export function LoadError({ what, error, onRetry, icon, className }: LoadErrorProps) {
  const reason = errorMessage(error);
  return (
    <EmptyState
      tone="danger"
      className={cx('ui-empty--compact', className)}
      icon={icon ?? <AlertTriangle size={20} strokeWidth={1.7} />}
      title={<>Couldn&rsquo;t load {what}</>}
      description={reason || undefined}
      action={
        onRetry ? (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Retry
          </Button>
        ) : undefined
      }
      role="alert"
    />
  );
}

/* A quiet note about the page's current state or how something works:
   muted caption text with an optional icon, beside the control it concerns.
   Content, not a notice — no coloured box. */
export interface NoteProps extends React.HTMLAttributes<HTMLParagraphElement> {
  icon?: 'info' | 'warn' | null;
  children: ReactNode;
}

export function Note({ icon = null, className, children, ...rest }: NoteProps) {
  return (
    <p className={cx('ui-note', icon === 'warn' && 'ui-note--warn', className)} {...rest}>
      {icon === 'warn' && <AlertTriangle className="ui-note__icon" size={14} strokeWidth={1.9} aria-hidden />}
      {icon === 'info' && <Info className="ui-note__icon" size={14} strokeWidth={1.9} aria-hidden />}
      <span>{children}</span>
    </p>
  );
}

/** The human reason inside an unknown thrown value. */
export function errorMessage(error: unknown): string {
  if (error == null) return '';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && 'message' in error && typeof (error as { message: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return String(error);
}

