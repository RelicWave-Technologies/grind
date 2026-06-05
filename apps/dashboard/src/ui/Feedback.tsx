import type { ReactNode } from 'react';
import { AlertTriangle, Info, CheckCircle2, XCircle } from 'lucide-react';
import { cx } from './util';

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

/* §5.15 Banner — an inline error/warn/info/success notice within a page.
   Distinct from the floating Toast. */
export type BannerStatus = 'danger' | 'warn' | 'info' | 'success';

const BANNER_ICON: Record<BannerStatus, ReactNode> = {
  danger: <XCircle size={16} strokeWidth={1.9} />,
  warn: <AlertTriangle size={16} strokeWidth={1.9} />,
  info: <Info size={16} strokeWidth={1.9} />,
  success: <CheckCircle2 size={16} strokeWidth={1.9} />,
};

export interface BannerProps extends React.HTMLAttributes<HTMLDivElement> {
  status: BannerStatus;
  action?: ReactNode;
  children: ReactNode;
}

export function Banner({ status, action, className, children, ...rest }: BannerProps) {
  return (
    <div
      className={cx('ui-banner', `ui-banner--${status}`, className)}
      role={status === 'danger' ? 'alert' : 'status'}
      {...rest}
    >
      <span className="ui-banner__icon" aria-hidden>{BANNER_ICON[status]}</span>
      <div className="ui-banner__body">{children}</div>
      {action != null && <div className="ui-banner__action">{action}</div>}
    </div>
  );
}
