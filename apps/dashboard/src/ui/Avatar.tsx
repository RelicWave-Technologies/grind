import { Children, isValidElement } from 'react';
import type { ReactNode } from 'react';
import { cx, initials } from './util';

/* §5.11 Avatar + AvatarGroup + Identity — people. The lone --r-full surface. */
export type AvatarSize = 24 | 32 | 40;

export interface AvatarProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  name: string;
  /** Photo URL. When present, initials are replaced by the image. */
  src?: string;
  size?: AvatarSize;
}

export function Avatar({ name, src, size = 32, className, ...rest }: AvatarProps) {
  return (
    <span
      className={cx('ui-avatar', `ui-avatar--${size}`, src && 'ui-avatar--has-photo', className)}
      title={name}
      role="img"
      aria-label={name}
      {...rest}
    >
      {src ? <img src={src} alt="" /> : initials(name)}
    </span>
  );
}

export interface AvatarGroupProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Show at most N avatars; the rest collapse into a `+N` chip. */
  max?: number;
  size?: AvatarSize;
  children: ReactNode;
}

export function AvatarGroup({ max, size = 32, className, children, ...rest }: AvatarGroupProps) {
  const all = Children.toArray(children).filter(isValidElement);
  const shown = max != null && all.length > max ? all.slice(0, max) : all;
  const overflow = all.length - shown.length;
  return (
    <span className={cx('ui-avatar-group', className)} {...rest}>
      {shown}
      {overflow > 0 && (
        <span
          className="ui-avatar-group__more"
          style={{ width: size, height: size }}
          aria-label={`${overflow} more`}
        >
          +{overflow}
        </span>
      )}
    </span>
  );
}

/* Identity — avatar + name + optional subtitle, for table first-cells and rows. */
export interface IdentityProps extends React.HTMLAttributes<HTMLDivElement> {
  name: ReactNode;
  subtitle?: ReactNode;
  avatar?: ReactNode;
}

export function Identity({ name, subtitle, avatar, className, ...rest }: IdentityProps) {
  return (
    <div className={cx('ui-identity', className)} {...rest}>
      {avatar}
      <div className="ui-identity__meta">
        <span className="ui-identity__name ui-t-strong">{name}</span>
        {subtitle != null && <span className="ui-identity__sub ui-t-small">{subtitle}</span>}
      </div>
    </div>
  );
}
